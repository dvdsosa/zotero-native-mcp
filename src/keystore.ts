/**
 * Persistence for Zotero local API keys.
 *
 * Keys are partitioned by Zotero-Server-ID: a key issued by one Zotero
 * instance/data directory is meaningless to another, and reusing it across
 * instances would produce confusing 401s. The store is written with 0600
 * permissions since a key grants write access to the user's library.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

interface KeyStoreFile {
  version: 1;
  /** serverId -> local API key */
  keys: Record<string, string>;
}

const EMPTY: KeyStoreFile = { version: 1, keys: {} };

export class KeyStore {
  private cache: KeyStoreFile | null = null;

  constructor(private readonly path: string = defaultKeyStorePath()) {}

  private async load(): Promise<KeyStoreFile> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<KeyStoreFile>;
      this.cache =
        parsed && typeof parsed.keys === 'object' && parsed.keys !== null
          ? { version: 1, keys: parsed.keys as Record<string, string> }
          : { ...EMPTY, keys: {} };
    } catch {
      // Missing or corrupt store: start clean rather than failing the server.
      this.cache = { ...EMPTY, keys: {} };
    }
    return this.cache;
  }

  async get(serverId: string): Promise<string | null> {
    return (await this.load()).keys[serverId] ?? null;
  }

  async set(serverId: string, key: string): Promise<void> {
    const store = await this.load();
    store.keys[serverId] = key;
    await this.persist(store);
  }

  async remove(serverId: string): Promise<void> {
    const store = await this.load();
    if (!(serverId in store.keys)) return;
    delete store.keys[serverId];
    await this.persist(store);
  }

  private async persist(store: KeyStoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    // writeFile's mode only applies on create; enforce it on existing files too.
    await chmod(this.path, 0o600).catch(() => {});
  }
}

export function defaultKeyStorePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'zotero-native-mcp', 'keys.json');
}
