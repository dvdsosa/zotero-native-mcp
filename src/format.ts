/**
 * Response shaping.
 *
 * The local API is happy to return many megabytes at once, but an agent's
 * context is not. Zotero's API envelope repeats a `library` block and a set of
 * self/alternate `links` on every single object; both are pure overhead for a
 * caller that already knows which library it asked about. These helpers flatten
 * the envelope down to the fields that carry meaning.
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Envelope Zotero wraps around every data object. */
export interface ZoteroEnvelope {
  key?: string;
  version?: number;
  library?: unknown;
  links?: unknown;
  meta?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** Meta fields worth the tokens; the rest of `meta` is dropped. */
const KEPT_META = ['numChildren', 'numItems', 'numCollections', 'creatorSummary', 'parsedDate'];

/**
 * Flattens one envelope into a single object: `data` fields at the top level,
 * plus the useful parts of `meta`. `verbose` keeps the raw envelope instead.
 */
export function compactObject(entry: ZoteroEnvelope, verbose = false): Record<string, unknown> {
  if (verbose) return entry as Record<string, unknown>;

  const data = (entry.data ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...data };
  if (entry.key && result.key === undefined) result.key = entry.key;
  if (entry.version !== undefined && result.version === undefined) result.version = entry.version;

  for (const field of KEPT_META) {
    const value = entry.meta?.[field];
    if (value !== undefined && value !== 0) result[field] = value;
  }

  // `relations` is almost always an empty object; drop the noise.
  if (isEmptyObject(result.relations)) delete result.relations;
  if (Array.isArray(result.tags) && result.tags.length === 0) delete result.tags;
  if (Array.isArray(result.collections) && result.collections.length === 0) delete result.collections;
  return result;
}

export function compactList(entries: ZoteroEnvelope[], verbose = false): Record<string, unknown>[] {
  return entries.map((entry) => compactObject(entry, verbose));
}

/**
 * Builds the paging summary attached to every list result, so the agent can
 * tell "that is everything" from "there is more behind a cursor".
 */
export function pageInfo(
  returned: number,
  start: number,
  totalResults: number | null,
): { totalResults: number | null; returned: number; start: number; nextStart: number | null } {
  const total = totalResults ?? null;
  const consumed = start + returned;
  return {
    totalResults: total,
    returned,
    start,
    nextStart: total !== null && consumed < total ? consumed : null,
  };
}

/**
 * Standard success result: pretty JSON for the model to read plus the same
 * payload as structuredContent for clients that consume the output schema.
 */
export function ok<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Error result; `text` should already carry the remediation hint. */
export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
