/**
 * Tags and saved searches: the two ways a Zotero library is organized that are
 * neither collections nor raw metadata.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ZoteroLocalClient, libraryPrefix } from '../client.js';
import { ZoteroEnvelope, compactList, ok, pageInfo } from '../format.js';
import {
  defineTool,
  groupIdParam,
  libraryOf,
  limitParam,
  listOutputShape,
  objectKey,
  startParam,
  verboseParam,
  zoteroObject,
} from './shared.js';

/** Tag entries use a flatter envelope than items and collections. */
interface TagEntry {
  tag: string;
  meta?: { type?: number; numItems?: number };
}

export function registerDiscoveryTools(server: McpServer, client: ZoteroLocalClient): void {
  defineTool(server, {
    name: 'zotero_list_tags',
    title: 'List tags',
    description:
      'List tags in the library, optionally only those used within one collection or matching a ' +
      'search. Useful for discovering how a library is organized before filtering ' +
      'zotero_search_items by tag.',
    inputSchema: {
      q: z.string().optional().describe('Filter tags by text.'),
      qmode: z
        .enum(['contains', 'startsWith'])
        .default('contains')
        .describe('How `q` matches. Ignored when `q` is omitted.'),
      collectionKey: objectKey.optional().describe('Only tags used by items in this collection.'),
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
    },
    outputSchema: { ...listOutputShape, tags: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ q, qmode, collectionKey, groupId, limit, start }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const path = collectionKey ? `${prefix}/collections/${collectionKey}/items/tags` : `${prefix}/tags`;
      const response = await client.request<TagEntry[]>({
        path,
        query: { q, qmode: q ? qmode : undefined, limit, start },
      });

      const tags = (response.data ?? []).map((entry) => ({
        tag: entry.tag,
        // type 1 is an automatically extracted tag; absent means user-added.
        automatic: entry.meta?.type === 1,
        numItems: entry.meta?.numItems ?? null,
      }));
      return ok({ ...pageInfo(tags.length, start, response.totalResults), tags });
    },
  });

  defineTool(server, {
    name: 'zotero_list_saved_searches',
    title: 'List saved searches',
    description:
      'List the saved searches defined in the library, with their conditions. Run one with ' +
      'zotero_run_saved_search. Note that the local API can actually execute saved searches, which ' +
      'the zotero.org web API cannot.',
    inputSchema: {
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, searches: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ groupId, limit, start, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope[]>({ path: `${prefix}/searches`, query: { limit, start } });
      const searches = compactList(response.data ?? [], verbose);
      return ok({ ...pageInfo(searches.length, start, response.totalResults), searches });
    },
  });

  defineTool(server, {
    name: 'zotero_run_saved_search',
    title: 'Run a saved search',
    description:
      'Execute a saved search and return the matching items. The search runs against the local ' +
      'database using Zotero\'s own engine, so the results match what the saved search shows in the ' +
      'Zotero UI.',
    inputSchema: {
      searchKey: objectKey.describe('Saved search key, from zotero_list_saved_searches.'),
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, items: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ searchKey, groupId, limit, start, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope[]>({
        path: `${prefix}/searches/${searchKey}/items`,
        query: { limit, start },
      });
      const items = compactList(response.data ?? [], verbose);
      return ok({ ...pageInfo(items.length, start, response.totalResults), items });
    },
  });
}
