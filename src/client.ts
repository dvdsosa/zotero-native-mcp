/**
 * HTTP client for Zotero's local API (a complete local implementation of the
 * Zotero Web API v3, served from 127.0.0.1:23119/api by Zotero 7.1+).
 *
 * Everything runs over loopback: no request ever reaches api.zotero.org, there
 * are no rate limits, and no zotero.org API key or account is involved.
 *
 * Three protocol details are handled here so tools never have to think about
 * them:
 *
 *   Zotero-Server-ID  Identifies the running Zotero instance. Optional on
 *                     reads, mandatory on writes (428 without it, 412 on
 *                     mismatch). Cached and refreshed automatically.
 *   Zotero-API-Key    Local API key required on every write. Obtained via
 *                     POST /api/local/authorize, which raises a consent dialog
 *                     in Zotero. "Allow" issues a single-use key, "Always
 *                     Allow" a persistent one, so a 401 mid-session is normal
 *                     and triggers one transparent re-authorization.
 *   Library prefix    /api/users/0 for the personal library (user ID 0 is an
 *                     alias for the logged-in user), /api/groups/<id> for groups.
 */

import { Config } from './config.js';
import { KeyStore, defaultKeyStorePath } from './keystore.js';
import {
  ZoteroAuthorizationDeniedError,
  ZoteroHttpError,
  ZoteroUnreachableError,
} from './errors.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Which library a request targets. Personal library when groupId is absent. */
export interface LibraryRef {
  groupId?: number | undefined;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path below /api, e.g. "/users/0/collections" or an absolute "/api/..." path. */
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Serialized as JSON unless `form` or `raw` is set. */
  body?: unknown;
  /** Serialized as application/x-www-form-urlencoded. */
  form?: Record<string, string | number>;
  /** Sent verbatim as application/octet-stream. */
  raw?: Uint8Array;
  headers?: Record<string, string>;
  /** Skip JSON parsing and return the response body as text. */
  expectText?: boolean;
}

/** Remaining one-shot recovery attempts for a single logical request. */
interface RetryBudget {
  /** Whether a 401 may still trigger re-authorization. */
  reauthorize: boolean;
  /** Whether a 412/428 may still trigger a server-ID refresh. */
  refreshServerId: boolean;
}

export interface ZoteroResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  /** Total-Results header, when the endpoint reports one. */
  totalResults: number | null;
  /** Last-Modified-Version header, when present. */
  version: number | null;
}

export interface AuthorizationResult {
  key: string;
  /** True when the user chose "Always Allow" and the key persists. */
  remember: boolean;
}

export class ZoteroLocalClient {
  private serverId: string | null = null;
  private apiKey: string | null = null;
  private readonly keyStore: KeyStore;
  /** Serializes concurrent authorize attempts so tools never stack dialogs. */
  private pendingAuthorization: Promise<AuthorizationResult> | null = null;

  constructor(private readonly config: Config) {
    this.keyStore = new KeyStore(config.keyStorePath ?? defaultKeyStorePath());
    this.apiKey = config.apiKey;
  }

  // ---------------------------------------------------------------- requests

  async request<T = unknown>(options: RequestOptions): Promise<ZoteroResponse<T>> {
    return this.dispatch<T>(options, { reauthorize: true, refreshServerId: true });
  }

  private async dispatch<T>(options: RequestOptions, retries: RetryBudget): Promise<ZoteroResponse<T>> {
    const method = options.method ?? 'GET';
    const isWrite = WRITE_METHODS.has(method);
    const headers: Record<string, string> = { ...options.headers };

    // Writes are rejected outright without a server ID, so resolve it first.
    if (isWrite && !headers['Zotero-Server-ID']) {
      headers['Zotero-Server-ID'] = await this.getServerId();
    }
    if (isWrite) {
      const key = await this.getApiKey();
      if (key) headers['Zotero-API-Key'] = key;
    }

    let body: RequestInit['body'];
    if (options.raw) {
      body = options.raw as unknown as RequestInit['body'];
      headers['Content-Type'] ??= 'application/octet-stream';
    } else if (options.form) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(options.form)) form.set(k, String(v));
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const url = this.buildUrl(options.path, options.query);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new ZoteroUnreachableError(this.config.baseUrl, describeFetchFailure(error));
    }

    // Every response carries the current server ID; keep the cache warm.
    const advertisedServerId = response.headers.get('Zotero-Server-ID');
    if (advertisedServerId) this.serverId = advertisedServerId;

    if (response.ok) {
      const text = await response.text();
      const data = (options.expectText || text === ''
        ? text
        : safeParseJson(text)) as T;
      return {
        status: response.status,
        data,
        headers: response.headers,
        totalResults: intHeader(response.headers, 'Total-Results'),
        version: intHeader(response.headers, 'Last-Modified-Version'),
      };
    }

    const errorBody = (await response.text()).trim();

    // Each remedy gets its own budget. A single shared one would let a server-ID
    // refresh exhaust the retry that re-authorization still needs — exactly the
    // case when Zotero switches data directories, which invalidates the cached
    // server ID and the stored key at the same time.

    // 401: the key is missing, or a single-use key was consumed by an earlier
    // write. Re-authorize once and replay the request.
    if (response.status === 401 && retries.reauthorize && this.config.autoAuthorize) {
      await this.forgetApiKey();
      await this.authorize();
      return this.dispatch<T>(options, { ...retries, reauthorize: false });
    }

    // 412/428: Zotero restarted or switched data directories, so the cached
    // server ID is stale. Re-resolve and replay once.
    if ((response.status === 412 || response.status === 428) && retries.refreshServerId) {
      this.serverId = null;
      const fresh = await this.getServerId();
      return this.dispatch<T>(
        { ...options, headers: { ...options.headers, 'Zotero-Server-ID': fresh } },
        { ...retries, refreshServerId: false },
      );
    }

    throw this.toHttpError(response, errorBody, method, options.path);
  }

  private toHttpError(response: Response, body: string, method: string, path: string): ZoteroHttpError {
    const status = response.status;
    const detail = body || response.statusText;
    let hint: string | undefined;

    switch (status) {
      case 400:
        hint =
          'The request body or parameters were rejected by Zotero. For item writes, verify the ' +
          'itemType and every field name against zotero_get_item_type_fields before retrying.';
        break;
      case 401:
        hint =
          'Write access needs a local API key. Call zotero_authorize and ask the user to press ' +
          '"Always Allow" in the Zotero dialog so the key persists across writes.';
        break;
      case 403:
        hint = body.includes('not enabled')
          ? 'Enable Zotero Settings -> Advanced -> "Allow other applications on this computer to communicate with Zotero".'
          : 'The library is read-only, or the user denied the authorization request.';
        break;
      case 404:
        hint =
          'The object key does not exist in this library. Keys are 8 uppercase alphanumeric ' +
          'characters and are library-scoped: confirm the groupId argument matches the library ' +
          'the object lives in. Use zotero_search_items or zotero_list_collections to find valid keys.';
        break;
      case 409:
        hint = 'Zotero is busy (a sync or another transaction is in progress). Retry in a few seconds.';
        break;
      case 412:
        hint =
          'Version conflict: the object changed since it was read. Re-read it with zotero_get_item ' +
          'or zotero_get_collection and resend the write with the current version number.';
        break;
      case 428:
        hint = 'The request needs a precondition header that could not be resolved. Call zotero_status to re-sync client state.';
        break;
      case 429: {
        const retryAfter = response.headers.get('Retry-After');
        hint = `Too many authorization prompts. Wait ${retryAfter ?? 'about 60'} seconds before calling zotero_authorize again.`;
        break;
      }
      case 500:
        hint = 'Zotero raised an internal error. The Zotero debug output window (Help -> Debug Output Logging) will have the details.';
        break;
    }

    return new ZoteroHttpError(
      status,
      body,
      `Zotero local API returned ${status} for ${method} ${path}: ${detail}`,
      hint,
    );
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const absolute = path.startsWith('/api/') || path.startsWith('/connector/');
    const url = new URL(`${this.config.baseUrl}${absolute ? path : `/api${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  // ------------------------------------------------------------------- state

  /** Fetches and caches the ID of the running Zotero instance. */
  async getServerId(): Promise<string> {
    if (this.serverId) return this.serverId;
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/`, {
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new ZoteroUnreachableError(this.config.baseUrl, describeFetchFailure(error));
    }
    const serverId = response.headers.get('Zotero-Server-ID');
    if (!serverId) {
      throw new ZoteroHttpError(
        response.status,
        '',
        `Zotero answered at ${this.config.baseUrl} but did not send a Zotero-Server-ID header.`,
        'The local API is probably disabled, or this Zotero predates 7.1. Enable Settings -> ' +
          'Advanced -> "Allow other applications on this computer to communicate with Zotero".',
      );
    }
    this.serverId = serverId;
    return serverId;
  }

  private async getApiKey(): Promise<string | null> {
    if (this.apiKey) return this.apiKey;
    this.apiKey = await this.keyStore.get(await this.getServerId());
    return this.apiKey;
  }

  private async forgetApiKey(): Promise<void> {
    this.apiKey = null;
    if (!this.config.apiKey) await this.keyStore.remove(await this.getServerId());
  }

  /**
   * Requests write access. Raises a modal in Zotero with Allow / Always Allow /
   * Deny; the returned key is persisted so "Always Allow" survives restarts.
   */
  async authorize(): Promise<AuthorizationResult> {
    // Collapse concurrent callers onto one dialog.
    if (this.pendingAuthorization) return this.pendingAuthorization;
    this.pendingAuthorization = this.performAuthorization().finally(() => {
      this.pendingAuthorization = null;
    });
    return this.pendingAuthorization;
  }

  private async performAuthorization(): Promise<AuthorizationResult> {
    const serverId = await this.getServerId();
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/local/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
        body: JSON.stringify({ appName: this.config.appName }),
        // The dialog blocks until the user answers, so allow generous time.
        signal: AbortSignal.timeout(Math.max(this.config.timeoutMs, 300_000)),
      });
    } catch (error) {
      throw new ZoteroUnreachableError(this.config.baseUrl, describeFetchFailure(error));
    }

    if (response.status === 403) throw new ZoteroAuthorizationDeniedError();
    if (!response.ok) {
      throw this.toHttpError(response, (await response.text()).trim(), 'POST', '/api/local/authorize');
    }

    const result = (await response.json()) as AuthorizationResult;
    this.apiKey = result.key;
    await this.keyStore.set(serverId, result.key);
    return result;
  }

  /** True when a key is on hand; it may still be a spent single-use key. */
  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  get appName(): string {
    return this.config.appName;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }
}

/** Builds the /users/0 or /groups/<id> path prefix for a library. */
export function libraryPrefix(library?: LibraryRef): string {
  return library?.groupId ? `/groups/${library.groupId}` : '/users/0';
}

function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'request timed out';
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code) return cause.code;
    return error.message;
  }
  return String(error);
}
