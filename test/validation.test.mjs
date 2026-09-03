/**
 * Argument validation exercised through a real MCP client over stdio.
 *
 * These paths all reject before the server contacts Zotero, so the suite runs
 * anywhere — no Zotero, no network. Testing them through the transport rather
 * than by reaching into the SDK's internals keeps the test honest: it fails if
 * the tool stops being reachable, not just if the function changes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client;

before(async () => {
  client = new Client({ name: 'validation-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['build/index.js'] }));
});

after(async () => { await client?.close(); });

const expectError = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(result.isError, `${name} should have rejected ${JSON.stringify(args)}`);
  return result.content[0].text;
};

test('a linked attachment in a group library is refused, pointing at imported', async () => {
  const text = await expectError('zotero_attach_file', {
    filePath: '/definitely/not/a/real/file.pdf',
    groupId: 55667788,
    mode: 'linked',
  });
  assert.match(text, /does not allow linked files in group libraries/);
  assert.match(text, /mode: "imported"/);
  // Reported before the file is even stat'd, so a bad path cannot mask the real problem.
  assert.doesNotMatch(text, /No such file/);
});

test('a relative file path is refused, with the absolute form suggested', async () => {
  const text = await expectError('zotero_attach_file', { filePath: 'relative/path.pdf' });
  assert.match(text, /must be absolute/);
});

test('a missing file is reported as such', async () => {
  const text = await expectError('zotero_attach_file', { filePath: '/definitely/not/a/real/file.pdf' });
  assert.match(text, /No such file/);
});

test('an attachment cannot be both a child and filed into collections', async () => {
  const text = await expectError('zotero_attach_file', {
    filePath: '/definitely/not/a/real/file.pdf',
    parentItemKey: 'ABCD1234',
    collections: ['XYZW5678'],
  });
  assert.match(text, /cannot belong to collections/);
});

test('a malformed object key is rejected by the schema', async () => {
  await expectError('zotero_get_item', { itemKey: 'too-short' });
  await expectError('zotero_get_collection', { collectionKey: 'lowercase' });
});

test('scope="children" without a parent key is refused', async () => {
  const text = await expectError('zotero_list_collections', { scope: 'children' });
  assert.match(text, /requires parentKey/);
});

test('an update with nothing to change is refused', async () => {
  const text = await expectError('zotero_update_collection', { collectionKey: 'ABCD1234' });
  assert.match(text, /Nothing to update/);
  const itemText = await expectError('zotero_update_item', { itemKey: 'ABCD1234', fields: {} });
  assert.match(itemText, /nothing to update/i);
});

test('batch limits are enforced by the schema', async () => {
  const keys = Array.from({ length: 51 }, (_, i) => `KEY${String(i).padStart(5, '0')}`.slice(0, 8));
  await expectError('zotero_delete_items', { itemKeys: keys });
});
