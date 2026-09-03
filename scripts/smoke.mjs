/**
 * End-to-end smoke test: drives the built server over stdio as a real MCP client.
 * Usage: node scripts/smoke.mjs read     (read-only tools)
 *        node scripts/smoke.mjs write    (creates and then deletes test data)
 *        node scripts/smoke.mjs group    (same write cycle in a group library)
 *
 * The write and group modes mutate a real library, but every object they create
 * is deleted before they exit.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mode = process.argv[2] ?? 'read';
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['build/index.js'] }));

const call = async (name, args = {}) => {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const text = result.content?.[0]?.text ?? '';
  console.log(`\n### ${name} (${ms}ms)${result.isError ? ' [ERROR]' : ''}\n${text.slice(0, 900)}`);
  if (result.isError) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

if (mode === 'read') {
  await call('zotero_status');
  await call('zotero_list_libraries');
  const cols = await call('zotero_list_collections', { scope: 'top', limit: 5 });
  await call('zotero_search_items', { q: 'learning', limit: 3 });
  await call('zotero_get_item_type_fields', { itemType: 'journalArticle' });
  await call('zotero_list_tags', { limit: 5 });
  await call('zotero_list_saved_searches', { limit: 3 });
  if (cols?.collections?.[0]?.key) {
    await call('zotero_search_items', { collectionKey: cols.collections[0].key, limit: 3 });
  }
}

if (mode === 'write') {
  const created = await call('zotero_create_collection', {
    collections: [{ name: '__mcp-smoke-test' }],
  });
  const colKey = created?.created?.[0]?.key;
  if (!colKey) { await client.close(); process.exit(1); }

  const sub = await call('zotero_create_collection', {
    collections: [{ name: '__mcp-smoke-sub', parentCollectionKey: colKey }],
  });
  await call('zotero_update_collection', { collectionKey: colKey, name: '__mcp-smoke-test-renamed' });

  const items = await call('zotero_create_items', {
    items: [{
      itemType: 'journalArticle',
      title: 'MCP Smoke Test Article',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      date: '2024',
      publicationTitle: 'Journal of Smoke Testing',
      collections: [colKey],
      tags: [{ tag: '__mcp-smoke' }],
    }],
  });
  const itemKey = items?.created?.[0]?.key;

  // Attachments: one linked, one imported.
  const tmp = `${process.env.TMPDIR ?? '/tmp'}mcp-smoke-${Date.now()}.txt`;
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(tmp, 'Smoke test attachment payload.\n'.repeat(20));

  await call('zotero_attach_file', { filePath: tmp, parentItemKey: itemKey, mode: 'linked', title: 'Linked smoke file' });
  await call('zotero_attach_file', { filePath: tmp, parentItemKey: itemKey, mode: 'imported', title: 'Imported smoke file' });
  await call('zotero_get_attachment_path', { itemKey });
  await call('zotero_get_item', { itemKey, includeChildren: true });
  await call('zotero_export_items', { itemKeys: [itemKey], format: 'bibtex' });

  // Collection membership round trip.
  await call('zotero_remove_items_from_collection', { itemKeys: [itemKey], collectionKey: colKey });
  await call('zotero_add_items_to_collection', { itemKeys: [itemKey], collectionKey: colKey });
  await call('zotero_add_items_to_collection', { itemKeys: [itemKey], collectionKey: colKey });

  // Error-path checks.
  await call('zotero_get_item', { itemKey: 'ZZZZZZZZ' });
  await call('zotero_attach_file', { filePath: 'relative/path.pdf' });

  // Cleanup.
  await call('zotero_delete_items', { itemKeys: [itemKey] });
  const subKey = sub?.created?.[0]?.key;
  await call('zotero_delete_collection', { collectionKeys: [colKey, subKey].filter(Boolean) });
  await unlink(tmp).catch(() => {});
}

if (mode === 'group') {
  const libs = await call('zotero_list_libraries');
  const groupId = libs?.groups?.[0]?.groupId;
  if (!groupId) {
    console.log('\nNo group library available locally; nothing to test.');
    await client.close();
    process.exit(0);
  }
  console.log(`\n>>> Targeting group "${libs.groups[0].name}" (id ${groupId})`);

  // Reads first: a 403 on the write below is only meaningful if reads worked.
  await call('zotero_list_collections', { groupId, scope: 'top', limit: 5 });
  await call('zotero_search_items', { groupId, limit: 3 });
  await call('zotero_list_tags', { groupId, limit: 5 });

  const created = await call('zotero_create_collection', {
    groupId, collections: [{ name: '__mcp-group-smoke' }],
  });
  const colKey = created?.created?.[0]?.key;
  if (!colKey) {
    console.log('\nGroup is read-only for this account, or the write was refused.');
    await client.close();
    process.exit(0);
  }

  const items = await call('zotero_create_items', {
    groupId,
    items: [{
      itemType: 'journalArticle',
      title: 'MCP Group Smoke Test',
      creators: [{ creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' }],
      date: '2024',
      collections: [colKey],
    }],
  });
  const itemKey = items?.created?.[0]?.key;

  const tmp = `${process.env.TMPDIR ?? '/tmp'}mcp-group-smoke-${Date.now()}.txt`;
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(tmp, 'Group smoke payload.\n'.repeat(10));

  if (itemKey) {
    // Expected to fail: Zotero refuses linked files in shared libraries.
    await call('zotero_attach_file', { groupId, filePath: tmp, parentItemKey: itemKey, mode: 'linked' });
    await call('zotero_attach_file', { groupId, filePath: tmp, parentItemKey: itemKey, mode: 'imported' });
    await call('zotero_get_attachment_path', { groupId, itemKey });
    await call('zotero_export_items', { groupId, itemKeys: [itemKey], format: 'bibtex' });
    await call('zotero_remove_items_from_collection', { groupId, itemKeys: [itemKey], collectionKey: colKey });
    await call('zotero_add_items_to_collection', { groupId, itemKeys: [itemKey], collectionKey: colKey });
    // Cross-library guard: the group key must not resolve in the personal library.
    await call('zotero_get_item', { itemKey });
    await call('zotero_delete_items', { groupId, itemKeys: [itemKey] });
  }
  await call('zotero_delete_collection', { groupId, collectionKeys: [colKey] });
  await unlink(tmp).catch(() => {});
}

await client.close();
