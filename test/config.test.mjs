import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../build/config.js';

const KEYS = [
  'ZOTERO_LOCAL_PORT', 'ZOTERO_LOCAL_BASE_URL', 'ZOTERO_LOCAL_APP_NAME',
  'ZOTERO_LOCAL_AUTO_AUTHORIZE', 'ZOTERO_LOCAL_API_KEY', 'ZOTERO_LOCAL_TIMEOUT_MS',
  'ZOTERO_LOCAL_KEY_STORE',
];
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

test('a stock install needs no configuration', () => {
  const config = loadConfig();
  assert.equal(config.baseUrl, 'http://127.0.0.1:23119');
  assert.equal(config.appName, 'zotero-native-mcp');
  assert.equal(config.autoAuthorize, true);
  assert.equal(config.apiKey, null);
  assert.equal(config.timeoutMs, 60000);
});

test('port override rebuilds the base URL', () => {
  process.env.ZOTERO_LOCAL_PORT = '24000';
  assert.equal(loadConfig().baseUrl, 'http://127.0.0.1:24000');
});

test('an explicit base URL wins over the port', () => {
  process.env.ZOTERO_LOCAL_PORT = '24000';
  process.env.ZOTERO_LOCAL_BASE_URL = 'http://localhost:9999';
  assert.equal(loadConfig().baseUrl, 'http://localhost:9999');
});

test('a trailing slash on the base URL is trimmed', () => {
  process.env.ZOTERO_LOCAL_BASE_URL = 'http://localhost:9999///';
  assert.equal(loadConfig().baseUrl, 'http://localhost:9999');
});

test('auto-authorize is disabled only by the exact string "false"', () => {
  process.env.ZOTERO_LOCAL_AUTO_AUTHORIZE = 'false';
  assert.equal(loadConfig().autoAuthorize, false);
  process.env.ZOTERO_LOCAL_AUTO_AUTHORIZE = '0';
  assert.equal(loadConfig().autoAuthorize, true, '"0" is not "false" and must not disable it');
});

test('a nonsensical numeric env falls back to the default', () => {
  process.env.ZOTERO_LOCAL_PORT = 'not-a-number';
  assert.equal(loadConfig().baseUrl, 'http://127.0.0.1:23119');
  process.env.ZOTERO_LOCAL_TIMEOUT_MS = '-5';
  assert.equal(loadConfig().timeoutMs, 60000);
});
