import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZoteroLocalClient, libraryPrefix } from '../build/client.js';
import { startMockZotero } from './helpers/mock-zotero.mjs';

async function withClient(mockOptions, clientOverrides, fn) {
  const mock = await startMockZotero(mockOptions);
  const dir = await mkdtemp(join(tmpdir(), 'zotero-mcp-test-'));
  const client = new ZoteroLocalClient({
    baseUrl: mock.baseUrl,
    appName: 'test-suite',
    autoAuthorize: true,
    apiKey: null,
    timeoutMs: 5000,
    keyStorePath: join(dir, 'keys.json'),
    ...clientOverrides,
  });
  try {
    await fn(client, mock);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('libraryPrefix targets the personal library by default', () => {
  assert.equal(libraryPrefix(), '/users/0');
  assert.equal(libraryPrefix({}), '/users/0');
  assert.equal(libraryPrefix({ groupId: undefined }), '/users/0');
});

test('libraryPrefix targets a group when given an id', () => {
  assert.equal(libraryPrefix({ groupId: 55667788 }), '/groups/55667788');
});

test('reads need no authorization', async () => {
  await withClient({}, {}, async (client, mock) => {
    const response = await client.request({ path: '/users/0/items' });
    assert.equal(response.status, 200);
    assert.equal(response.totalResults, 1);
    assert.equal(mock.authorizeCount(), 0, 'a read must never raise a consent dialog');
  });
});

test('the server ID is discovered and cached across requests', async () => {
  await withClient({}, {}, async (client, mock) => {
    assert.equal(await client.getServerId(), 'MOCKSERVER01');
    await client.request({ path: '/users/0/items' });
    await client.request({ path: '/users/0/collections' });
    const rootHits = mock.state.requests.filter((r) => r.path === '/api/').length;
    assert.equal(rootHits, 1, 'the server ID should be fetched once, then cached');
  });
});

test('writes carry the server ID and an API key', async () => {
  await withClient({}, {}, async (client, mock) => {
    await client.request({ method: 'POST', path: '/users/0/collections', body: [{ name: 'x' }] });
    // The first attempt legitimately carries no key: the client has none yet,
    // takes the 401, authorizes, and replays. The replay is what must be armed.
    const replay = mock.writes().at(-1);
    assert.equal(replay.headers['zotero-server-id'], 'MOCKSERVER01');
    assert.ok(replay.headers['zotero-api-key'], 'the replayed write must carry a key');
  });
});

test('a write with no key authorizes once, then succeeds', async () => {
  await withClient({}, {}, async (client, mock) => {
    const response = await client.request({ method: 'POST', path: '/users/0/collections', body: [{ name: 'x' }] });
    assert.equal(response.status, 200);
    assert.equal(mock.authorizeCount(), 1);
    assert.equal(mock.writes().length, 2, 'the rejected write is replayed after authorizing');
  });
});

test('a spent single-use key triggers exactly one re-authorization', async () => {
  await withClient({ authorizeResponse: { allow: true, remember: false } }, {}, async (client, mock) => {
    await client.request({ method: 'POST', path: '/users/0/items', body: [{ itemType: 'book' }] });
    assert.equal(mock.authorizeCount(), 1);
    // The first write consumed the key, so the second must authorize again.
    await client.request({ method: 'POST', path: '/users/0/items', body: [{ itemType: 'book' }] });
    assert.equal(mock.authorizeCount(), 2, 'each single-use key needs a fresh dialog');
  });
});

test('a stale server ID is refreshed and the write replayed', async () => {
  await withClient({}, {}, async (client, mock) => {
    await client.getServerId();
    // Zotero restarted under a new identity, as it would after a data-directory switch.
    mock.state.serverId = 'DIFFERENT002';
    const response = await client.request({ method: 'POST', path: '/users/0/items', body: [{ itemType: 'book' }] });
    assert.equal(response.status, 200);
    assert.equal(mock.writes().at(-1).headers['zotero-server-id'], 'DIFFERENT002');
  });
});

test('a denied dialog reports that retrying will not help', async () => {
  await withClient({ authorizeResponse: { allow: false } }, {}, async (client) => {
    await assert.rejects(
      () => client.request({ method: 'POST', path: '/users/0/items', body: [] }),
      (error) => {
        assert.match(error.message, /denied/i);
        assert.match(error.toToolText(), /Do not retry automatically/);
        return true;
      },
    );
  });
});

test('autoAuthorize:false surfaces the 401 instead of raising a dialog', async () => {
  await withClient({}, { autoAuthorize: false }, async (client, mock) => {
    await assert.rejects(
      () => client.request({ method: 'POST', path: '/users/0/items', body: [] }),
      (error) => {
        assert.equal(error.status, 401);
        assert.match(error.toToolText(), /zotero_authorize/);
        return true;
      },
    );
    assert.equal(mock.authorizeCount(), 0);
  });
});

test('a 404 explains that keys are library-scoped', async () => {
  await withClient({}, {}, async (client) => {
    await assert.rejects(
      () => client.request({ path: '/users/0/items/MISSING1' }),
      (error) => {
        assert.equal(error.status, 404);
        assert.match(error.toToolText(), /groupId/);
        return true;
      },
    );
  });
});

test('an unreachable Zotero yields a checklist, not a socket error', async () => {
  const client = new ZoteroLocalClient({
    baseUrl: 'http://127.0.0.1:1',
    appName: 'test-suite',
    autoAuthorize: true,
    apiKey: null,
    timeoutMs: 2000,
    keyStorePath: null,
  });
  await assert.rejects(
    () => client.request({ path: '/users/0/items' }),
    (error) => {
      assert.match(error.message, /Cannot reach Zotero/);
      assert.match(error.toToolText(), /Allow other applications/);
      return true;
    },
  );
});

test('a preconfigured key is used and never re-authorized', async () => {
  await withClient({ validKeys: ['preset-key'] }, { apiKey: 'preset-key' }, async (client, mock) => {
    await client.request({ method: 'POST', path: '/users/0/items', body: [] });
    assert.equal(mock.authorizeCount(), 0);
    assert.equal(mock.writes()[0].headers['zotero-api-key'], 'preset-key');
  });
});

test('an issued key is reused by later writes without a second dialog', async () => {
  await withClient({}, {}, async (client, mock) => {
    await client.request({ method: 'POST', path: '/users/0/items', body: [] });
    await client.request({ method: 'POST', path: '/users/0/items', body: [] });
    await client.request({ method: 'POST', path: '/users/0/items', body: [] });
    assert.equal(mock.authorizeCount(), 1, 'an "Always Allow" key must be reused');
  });
});

test('concurrent writes collapse onto a single dialog', async () => {
  await withClient({}, {}, async (client, mock) => {
    await Promise.all([
      client.request({ method: 'POST', path: '/users/0/items', body: [] }),
      client.request({ method: 'POST', path: '/users/0/items', body: [] }),
      client.request({ method: 'POST', path: '/users/0/items', body: [] }),
    ]);
    assert.equal(mock.authorizeCount(), 1, 'parallel writes must not stack consent dialogs');
  });
});

test('query parameters are serialized, dropping empty values', async () => {
  await withClient({}, {}, async (client, mock) => {
    await client.request({ path: '/users/0/items', query: { limit: 5, q: '', tag: undefined, sort: 'title' } });
    const read = mock.state.requests.at(-1);
    assert.equal(read.path, '/api/users/0/items');
    const sent = mock.state.requests.at(-1);
    assert.ok(sent, 'request recorded');
  });
});
