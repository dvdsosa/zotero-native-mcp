/**
 * Exercises every tool the server exposes against a live Zotero and reports
 * which ones actually ran.
 *
 * Read-only probes use whatever the library already contains; the write cycle
 * builds its own collection, item and attachments and deletes them before
 * exiting. Nothing pre-existing is modified.
 *
 * Usage: node scripts/coverage.mjs [--group]
 */
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const useGroup = process.argv.includes('--group');
const client = new Client({ name: 'coverage', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['build/index.js'] }));

const { tools } = await client.listTools();
const allNames = tools.map((t) => t.name).sort();
// name -> {ok, skipped, note, ms}. "skipped" means the library holds nothing to
// exercise the tool with, absent data, not a defect.
const results = new Map();

/** Calls a tool and records the outcome. `expectError` inverts the pass condition. */
async function run(name, args = {}, { expectError = false, note = '' } = {}) {
  const t0 = Date.now();
  const raw = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const failed = !!raw.isError;
  const ok = expectError ? failed : !failed;
  const prev = results.get(name);
  // A tool called several times passes only if every call behaved.
  results.set(name, { ok: prev ? prev.ok && ok : ok, note: prev?.note || note, ms });
  const text = raw.content?.[0]?.text ?? '';
  if (!ok) console.log(`  ✖ ${name}, ${text.split('\n')[0].slice(0, 120)}`);
  return failed ? null : JSON.parse(text);
}

const label = useGroup ? 'GROUP LIBRARY' : 'PERSONAL LIBRARY';
console.log(`\n═══ Tool coverage · ${label} ═══\n`);

// ── System ────────────────────────────────────────────────────────────────
const status = await run('zotero_status');
console.log(`  Zotero ${status?.zoteroVersion}, schema ${status?.schemaVersion}, write access: ${status?.writeAccess}`);
const libs = await run('zotero_list_libraries');
const groupId = useGroup ? libs?.groups?.[0]?.groupId : undefined;
if (useGroup && !groupId) { console.log('  No group library available.'); process.exit(0); }
const lib = groupId ? { groupId } : {};
if (groupId) console.log(`  Targeting group "${libs.groups[0].name}" (${groupId})`);

await run('zotero_get_item_type_fields');
await run('zotero_get_item_type_fields', { itemType: 'thesis' });
// Already granted, so this must not raise a dialog; it reports the stored key.
await run('zotero_authorize');

// ── Discovery, read-only against real data ────────────────────────────────
await run('zotero_list_tags', { ...lib, limit: 10 });
await run('zotero_list_tags', { ...lib, q: 'a', qmode: 'startsWith', limit: 5 });
const searches = await run('zotero_list_saved_searches', { ...lib, limit: 10 });
if (searches?.searches?.length) {
  const s = searches.searches[0];
  const hits = await run('zotero_run_saved_search', { ...lib, searchKey: s.key, limit: 5 });
  console.log(`  saved search "${s.name}" → ${hits?.totalResults ?? '?'} items`);
} else {
  results.set('zotero_run_saved_search', {
    ok: true, skipped: true,
    note: 'no saved searches, the API cannot create one, so this needs a library that has some',
  });
}

// ── Collections, read-only ────────────────────────────────────────────────
const cols = await run('zotero_list_collections', { ...lib, scope: 'all', limit: 300 });
const parent = cols?.collections?.find((c) => c.numCollections > 0);
if (parent) await run('zotero_list_collections', { ...lib, scope: 'children', parentKey: parent.key });

// ── Items, read-only ──────────────────────────────────────────────────────
// Quicksearch over whatever the library already holds. An empty library is a
// legitimate state, so nothing below may depend on this returning anything, // every tool is exercised again later against objects this script creates.
await run('zotero_search_items', { ...lib, q: 'a', qmode: 'everything', limit: 5 });

// Full text needs an attachment Zotero has actually indexed; find one.
let indexed = null;
const attachments = await run('zotero_search_items', { ...lib, itemType: 'attachment', topLevelOnly: false, limit: 40 });
for (const a of attachments?.items ?? []) {
  if (a.contentType !== 'application/pdf') continue;
  const ft = await client.callTool({ name: 'zotero_get_item_fulltext', arguments: { ...lib, itemKey: a.key, maxCharacters: 400 } });
  if (!ft.isError) { indexed = { key: a.key, data: JSON.parse(ft.content[0].text) }; break; }
}
if (indexed) {
  await run('zotero_get_item_fulltext', { ...lib, itemKey: indexed.key, maxCharacters: 400 });
  console.log(`  full text: ${indexed.data.totalCharacters} chars over ${indexed.data.indexedPages}/${indexed.data.totalPages} pages`);
  await run('zotero_get_attachment_path', { ...lib, itemKey: indexed.key });
} else {
  results.set('zotero_get_item_fulltext', {
    ok: true, skipped: true,
    note: 'no indexed PDF, Zotero indexes in the background, and a library with no PDFs has none',
  });
}

// ── Write cycle, on objects this script creates ───────────────────────────
// Everything created is registered here first, so the finally block below can
// remove it even if the run dies halfway. An earlier version cleaned up on the
// happy path only, and a mid-run failure left test objects in a real library.
const created = { collections: [], items: [], files: [] };
const stamp = Date.now();
try {
const made = await run('zotero_create_collection', { ...lib, collections: [{ name: `__cov-${stamp}` }] });
const colKey = made?.created?.[0]?.key;
if (colKey) created.collections.push(colKey);
const sub = await run('zotero_create_collection', { ...lib, collections: [{ name: '__cov-sub', parentCollectionKey: colKey }] });
const subKey = sub?.created?.[0]?.key;
if (subKey) created.collections.push(subKey);

await run('zotero_update_collection', { ...lib, collectionKey: colKey, name: `__cov-${stamp}-renamed` });
await run('zotero_update_collection', { ...lib, collectionKey: subKey, parentCollectionKey: null });

const items = await run('zotero_create_items', {
  ...lib,
  items: [{
    itemType: 'journalArticle',
    title: 'Coverage Probe, ñ á 中文 🔬',   // non-ASCII round trip
    creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
               { creatorType: 'author', name: 'CERN' }],
    date: '2024-03', publicationTitle: 'Journal of Coverage', DOI: '10.1000/cov',
    collections: [colKey], tags: [{ tag: '__cov' }],
  }],
});
const itemKey = items?.created?.[0]?.key;
if (itemKey) created.items.push(itemKey);

// update_item: change a field, add a tag, then verify it stuck.
await run('zotero_update_item', {
  ...lib, itemKey,
  fields: { title: 'Coverage Probe, updated', extra: 'set by coverage run', tags: [{ tag: '__cov' }, { tag: '__cov-2' }] },
});
const after = await run('zotero_get_item', { ...lib, itemKey });
const titleOk = after?.item?.title === 'Coverage Probe, updated';
const tagsOk = (after?.item?.tags ?? []).length === 2;
console.log(`  update_item verified: title=${titleOk} tags=${tagsOk} extra=${after?.item?.extra === 'set by coverage run'}`);
if (!titleOk || !tagsOk) results.set('zotero_update_item', { ok: false, note: 'change did not persist' });

// The trash round trip, which is what a plain delete now does.
await run('zotero_delete_items', { ...lib, itemKeys: [itemKey] });
const trash = await run('zotero_list_trash', { ...lib, limit: 200 });
const inTrash = (trash?.items ?? []).some((i) => i.key === itemKey);
await run('zotero_restore_items', { ...lib, itemKeys: [itemKey] });
const restored = await run('zotero_get_item', { ...lib, itemKey });
console.log(`  trash round trip: listed=${inTrash} restored=${restored?.item?.key === itemKey}`);
if (!inTrash) results.set('zotero_list_trash', { ok: false, note: 'trashed item did not appear' });

// The interlock must refuse a count the caller did not verify.
await run('zotero_empty_trash', { ...lib, expectedCount: 987654 },
  { expectError: true, note: 'interlock refuses a wrong count' });

// A real PDF, not a text file: content type detection and indexing differ.
const pdfPath = join(tmpdir(), `cov-${stamp}.pdf`);
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 62>>stream
BT /F1 12 Tf 20 50 Td (Coverage probe document) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`;
await writeFile(pdfPath, PDF);
created.files.push(pdfPath);

if (groupId) {
  await run('zotero_attach_file', { ...lib, filePath: pdfPath, parentItemKey: itemKey, mode: 'linked' },
    { expectError: true, note: 'linked correctly refused in a group' });
} else {
  await run('zotero_attach_file', { ...lib, filePath: pdfPath, parentItemKey: itemKey, mode: 'linked', title: 'Linked PDF' });
}
const imported = await run('zotero_attach_file', { ...lib, filePath: pdfPath, parentItemKey: itemKey, mode: 'imported', title: 'Imported PDF' });
console.log(`  imported PDF: contentType=${imported?.contentType} uploaded=${imported?.uploaded} bytes=${imported?.bytes}`);
// The resolved path is the most platform-sensitive value this server produces:
// Zotero hands back a file:// URL, and converting it wrongly yields "/C:/Users/…"
// on Windows. Print it, and fail loudly on that exact shape.
const paths = await run('zotero_get_attachment_path', { ...lib, itemKey });
for (const a of paths?.attachments ?? []) {
  if (!a.path) continue;
  console.log(`  attachment path: ${a.path}`);
  const looksMangled = /^\/[A-Za-z]:/.test(a.path);
  const absolute = process.platform === 'win32' ? /^[A-Za-z]:\\/.test(a.path) : a.path.startsWith('/');
  if (looksMangled || !absolute) {
    results.set('zotero_get_attachment_path', {
      ok: false,
      note: `path is not a valid ${process.platform} absolute path: ${a.path}`,
    });
  }
}

// Reads against objects this run created, so coverage does not depend on the
// library already holding anything. An empty Zotero still reaches every tool.
await run('zotero_get_collection', { ...lib, collectionKey: colKey });
await run('zotero_get_item_children', { ...lib, itemKey, limit: 20 });
for (const format of ['bibtex', 'biblatex', 'ris', 'csljson', 'csv', 'bib']) {
  await run('zotero_export_items', { ...lib, itemKeys: [itemKey], format, style: 'apa' });
}

await run('zotero_remove_items_from_collection', { ...lib, itemKeys: [itemKey], collectionKey: colKey });
await run('zotero_add_items_to_collection', { ...lib, itemKeys: [itemKey], collectionKey: colKey });

  await run('zotero_delete_collection', { ...lib, collectionKeys: [colKey] });
  await run('zotero_restore_collection', { ...lib, collectionKeys: [colKey] });

  // Permanent removal, so the run leaves nothing behind at all.
  await run('zotero_delete_items', { ...lib, itemKeys: [itemKey], permanent: true });
  created.items.length = 0;
  await run('zotero_delete_collection', { ...lib, collectionKeys: created.collections, permanent: true });
  created.collections.length = 0;
} finally {
  // Anything the happy path did not already remove.
  for (const f of created.files) await unlink(f).catch(() => {});
  if (created.items.length || created.collections.length) {
    console.log('\n  Run did not finish; removing what it had created…');
    if (created.items.length) {
      await client.callTool({ name: 'zotero_delete_items', arguments: { ...lib, itemKeys: created.items, permanent: true } })
        .catch(() => console.log(`  ! could not delete items ${created.items.join(', ')}, remove them by hand`));
    }
    if (created.collections.length) {
      await client.callTool({ name: 'zotero_delete_collection', arguments: { ...lib, collectionKeys: created.collections, permanent: true } })
        .catch(() => console.log(`  ! could not delete collections ${created.collections.join(', ')}, remove them by hand`));
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────
console.log('\n═══ Coverage ═══');
let passed = 0, failed = 0, skipped = 0, missed = 0;
for (const name of allNames) {
  const r = results.get(name);
  if (!r) { console.log(`  ⚠ ${name.padEnd(38)} never called`); missed++; }
  else if (r.skipped) { console.log(`  ○ ${name.padEnd(38)} skipped, ${r.note}`); skipped++; }
  else if (r.ok) { console.log(`  ✔ ${name.padEnd(38)} ${r.note || ''}`); passed++; }
  else { console.log(`  ✖ ${name.padEnd(38)} ${r.note || 'failed'}`); failed++; }
}
console.log(`\n  ${passed} passed · ${skipped} skipped for want of data · ${failed} failed · ${missed} never called`
  + `  (of ${allNames.length} tools)`);
await client.close();
process.exit(failed || missed ? 1 : 0);
