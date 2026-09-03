/**
 * Runtime configuration, resolved once at startup from the environment.
 *
 * Everything has a working default: on a stock Zotero 7.1+/10 install the
 * server needs no configuration at all.
 */

export interface Config {
  /** Base URL of Zotero's local HTTP server, without a trailing slash. */
  baseUrl: string;
  /** Name shown to the user in Zotero's authorization dialog. */
  appName: string;
  /**
   * Whether a 401 on a write should transparently trigger
   * POST /api/local/authorize (which raises a consent dialog in Zotero).
   */
  autoAuthorize: boolean;
  /** Pre-provisioned local API key, bypassing the key store. */
  apiKey: string | null;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Override for the key store location. */
  keyStorePath: string | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): Config {
  const port = envInt('ZOTERO_LOCAL_PORT', 23119);
  const baseUrl = (process.env.ZOTERO_LOCAL_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  return {
    baseUrl,
    appName: process.env.ZOTERO_LOCAL_APP_NAME ?? 'zotero-native-mcp',
    autoAuthorize: process.env.ZOTERO_LOCAL_AUTO_AUTHORIZE !== 'false',
    apiKey: process.env.ZOTERO_LOCAL_API_KEY ?? null,
    timeoutMs: envInt('ZOTERO_LOCAL_TIMEOUT_MS', 60_000),
    keyStorePath: process.env.ZOTERO_LOCAL_KEY_STORE ?? null,
  };
}
