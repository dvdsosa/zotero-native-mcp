/**
 * End-to-end tests against a real Zotero, driving the server as an MCP client
 * would. Skipped automatically when Zotero is not reachable, so CI stays green
 * without one.
 *
 * These are read-only: they never modify the library. The write path is covered
 * by `node scripts/smoke.mjs write`, which needs a consent dialog and so cannot
 * run unattended.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.ZOTERO_LOCAL_BASE_URL ?? 'http://127.0.0.1:23119';

async function zoteroIsRunning() {
  try {
    const response = await fetch(`${BASE}/api/`, { signal: AbortSignal.timeout(2000) });
    return response.headers.has('Zotero-Server-ID');
  } catch {
    return false;
  }
}

const available = await zoteroIsRunning();

describe('integration (live Zotero)', { skip: available ? false : 'Zotero is not running' }, () => {
  let client;

  before(async () => {
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['build/index.js'] }));
  });

  after(async () => { await client?.close(); });

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content[0].text);
  };

  test('every tool is registered with a description and schema', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 28);
    for (const tool of tools) {
      assert.ok(tool.description?.length > 40, `${tool.name} needs a real description`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
      assert.ok(tool.annotations, `${tool.name} needs annotations`);
    }
  });

  test('read tools are annotated read-only and writes are not', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.zotero_search_items.readOnlyHint, true);
    assert.equal(byName.zotero_create_items.readOnlyHint, false);
    assert.equal(byName.zotero_delete_items.destructiveHint, true);
    assert.equal(byName.zotero_delete_collection.destructiveHint, true);
    // Restoring can only put things back, never take them away.
    assert.equal(byName.zotero_restore_items.destructiveHint, false);
    assert.equal(byName.zotero_restore_collection.destructiveHint, false);
    assert.equal(byName.zotero_list_trash.readOnlyHint, true);
    assert.equal(byName.zotero_empty_trash.destructiveHint, true);
    // Nothing here reaches beyond the local Zotero instance.
    for (const annotations of Object.values(byName)) {
      assert.equal(annotations.openWorldHint, false);
    }
  });

  test('status reports a live connection', async () => {
    const status = await call('zotero_status');
    assert.equal(status.connected, true);
    assert.match(status.zoteroVersion, /^\d+\./);
    assert.ok(status.serverId?.length > 0);
  });

  test('collections come back flattened, with the tree reconstructible', async () => {
    const result = await call('zotero_list_collections', { scope: 'all', limit: 200 });
    assert.ok(Array.isArray(result.collections));
    for (const collection of result.collections) {
      assert.match(collection.key, /^[A-Z0-9]{8}$/);
      assert.ok('name' in collection);
      assert.ok('parentCollection' in collection, 'needed to rebuild the tree');
      assert.ok(!('links' in collection), 'envelope noise must be stripped');
      assert.ok(!('library' in collection), 'envelope noise must be stripped');
    }
  });

  test('top-level collections are a subset of all collections', async () => {
    const all = await call('zotero_list_collections', { scope: 'all', limit: 500 });
    const top = await call('zotero_list_collections', { scope: 'top', limit: 500 });
    const allKeys = new Set(all.collections.map((c) => c.key));
    for (const collection of top.collections) {
      assert.ok(allKeys.has(collection.key));
      assert.equal(collection.parentCollection, false, 'a top-level collection has no parent');
    }
  });

  test('paging reports a coherent cursor', async () => {
    const page = await call('zotero_search_items', { limit: 3 });
    assert.ok(page.returned <= 3);
    if (page.totalResults > 3) assert.equal(page.nextStart, 3);
    else assert.equal(page.nextStart, null);
  });

  test('paging actually advances', async () => {
    const first = await call('zotero_search_items', { limit: 2, sort: 'dateAdded', direction: 'asc' });
    if (first.nextStart === null) return; // library too small to page
    const second = await call('zotero_search_items', {
      limit: 2, start: first.nextStart, sort: 'dateAdded', direction: 'asc',
    });
    const firstKeys = first.items.map((i) => i.key);
    for (const item of second.items) assert.ok(!firstKeys.includes(item.key), 'pages must not overlap');
  });

  test('verbose returns the envelope that compact mode strips', async () => {
    const compact = await call('zotero_search_items', { limit: 1 });
    if (compact.returned === 0) return;
    const verbose = await call('zotero_search_items', { limit: 1, verbose: true });
    assert.ok('links' in verbose.items[0], 'verbose keeps the links block');
    assert.ok(!('links' in compact.items[0]), 'compact drops it');
  });

  test('item type introspection describes a known type', async () => {
    const result = await call('zotero_get_item_type_fields', { itemType: 'journalArticle' });
    assert.ok(result.fields.includes('title'));
    assert.ok(result.fields.includes('publicationTitle'));
    assert.ok(result.creatorTypes.includes('author'));
  });

  test('a bad key produces an actionable error, not a crash', async () => {
    const result = await client.callTool({ name: 'zotero_get_item', arguments: { itemKey: 'ZZZZZZZZ' } });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /groupId|does not exist/);
  });

  test('a malformed key is rejected by the schema before any request', async () => {
    const result = await client.callTool({ name: 'zotero_get_item', arguments: { itemKey: 'too-short' } });
    assert.ok(result.isError);
  });

  test('emptying the trash refuses a count the caller did not verify', async () => {
    // Needs a live Zotero: the interlock can only compare against a real count.
    const result = await client.callTool({
      name: 'zotero_empty_trash',
      arguments: { expectedCount: 987654 },
    });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /Refusing to empty the trash/);
    assert.match(result.content[0].text, /zotero_list_trash/);
  });

  test('the trash lists without touching it', async () => {
    const result = await call('zotero_list_trash', { limit: 5 });
    assert.ok(Array.isArray(result.items));
    assert.equal(typeof result.hasMore, 'boolean');
  });

  test('libraries list includes the personal library', async () => {
    const result = await call('zotero_list_libraries');
    assert.ok(result.personalLibrary === null || typeof result.personalLibrary.id === 'number');
    assert.ok(Array.isArray(result.groups));
  });
});
