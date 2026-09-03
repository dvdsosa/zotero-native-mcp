/**
 * Optimistic-concurrency helpers.
 *
 * Zotero refuses an update or delete that carries no version precondition (428),
 * which would force every caller into a read-then-write dance. These helpers
 * fetch the current version on the caller's behalf when no expected version was
 * supplied, so the common "just rename it" case stays a single tool call while
 * an explicit expectedVersion still gets true conflict detection.
 */

import { ZoteroLocalClient } from '../client.js';

/** Current version of a single object. */
export async function objectVersion(
  client: ZoteroLocalClient,
  path: string,
  expected?: number,
): Promise<number> {
  if (expected !== undefined) return expected;
  const response = await client.request<{ version?: number }>({ path });
  return response.data?.version ?? response.version ?? 0;
}

/** Current version of a whole library, used as the precondition for batch deletes. */
export async function libraryVersion(client: ZoteroLocalClient, prefix: string): Promise<number> {
  const response = await client.request<unknown>({ path: `${prefix}/items`, query: { limit: 1, format: 'keys' } });
  return response.version ?? 0;
}
