/**
 * End-to-end smoke test: drives the built server over stdio as a real MCP client.
 * Usage: node scripts/smoke.mjs read     (read-only tools)
 *        node scripts/smoke.mjs write    (creates and then deletes test data)
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

await client.close();
