import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeyStore, defaultKeyStorePath } from '../build/keystore.js';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-keystore-test-'));
  const path = join(dir, 'nested', 'keys.json');
  try {
    await fn(new KeyStore(path), path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an absent store reads as empty rather than failing', async () => {
  await withStore(async (store) => {
    assert.equal(await store.get('ANYSERVER'), null);
  });
});

test('a key round-trips through the store', async () => {
  await withStore(async (store) => {
    await store.set('SERVER01', 'secret-key');
    assert.equal(await store.get('SERVER01'), 'secret-key');
  });
});

test('the store creates missing parent directories', async () => {
  await withStore(async (store, path) => {
    await store.set('SERVER01', 'k');
    assert.ok((await stat(path)).isFile(), 'nested path should have been created');
  });
});

test('keys are partitioned by Zotero instance', async () => {
  await withStore(async (store) => {
    await store.set('SERVER01', 'key-one');
    await store.set('SERVER02', 'key-two');
    assert.equal(await store.get('SERVER01'), 'key-one');
    assert.equal(await store.get('SERVER02'), 'key-two');
  });
});

test('removing one instance leaves the others intact', async () => {
  await withStore(async (store) => {
    await store.set('SERVER01', 'key-one');
    await store.set('SERVER02', 'key-two');
    await store.remove('SERVER01');
    assert.equal(await store.get('SERVER01'), null);
    assert.equal(await store.get('SERVER02'), 'key-two');
  });
});

test('removing an unknown instance is a no-op, not an error', async () => {
  await withStore(async (store) => {
    await store.remove('NEVER-SEEN');
    assert.equal(await store.get('NEVER-SEEN'), null);
  });
});

// Windows has no POSIX permission bits, so the mode check is meaningless there.
test('the store is written 0600, since a key grants write access',
  { skip: process.platform === 'win32' ? 'POSIX permissions only' : false }, async () => {
    await withStore(async (store, path) => {
      await store.set('SERVER01', 'secret-key');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  });

test('a corrupt store degrades to empty instead of crashing the server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-keystore-test-'));
  const path = join(dir, 'keys.json');
  try {
    await writeFile(path, 'this is not json{{{');
    const store = new KeyStore(path);
    assert.equal(await store.get('SERVER01'), null);
    // And it must recover: a later write should produce a valid store.
    await store.set('SERVER01', 'fresh');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).keys.SERVER01, 'fresh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a store whose shape is wrong is treated as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-keystore-test-'));
  const path = join(dir, 'keys.json');
  try {
    await writeFile(path, JSON.stringify({ version: 1, keys: 'not-an-object' }));
    assert.equal(await new KeyStore(path).get('SERVER01'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default path lives under the XDG config directory', () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    const base = join(tmpdir(), 'xdg-test');
    process.env.XDG_CONFIG_HOME = base;
    // Built with join() so the separator matches the host platform.
    assert.equal(defaultKeyStorePath(), join(base, 'zotero-native-mcp', 'keys.json'));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});
