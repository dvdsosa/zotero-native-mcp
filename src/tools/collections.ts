/**
 * Collection management: the structural half of a Zotero library.
 *
 * Creating collections and nesting subcollections is what the Zotero Web API
 * calls a write, and it is exactly what the local API now supports natively —
 * no plugin, no cloud round trip.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ZoteroLocalClient, libraryPrefix } from '../client.js';
import { ZoteroInputError } from '../errors.js';
import { ZoteroEnvelope, compactList, compactObject, ok, pageInfo } from '../format.js';
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
import { libraryVersion, objectVersion } from './versions.js';

/** Shape of Zotero's multi-object write response. */
interface WriteResults {
  successful?: Record<string, ZoteroEnvelope>;
  failed?: Record<string, { key?: string; code: number; message: string }>;
}

function summarizeFailures(results: WriteResults): string[] {
  return Object.entries(results.failed ?? {}).map(
    ([index, failure]) => `index ${index}${failure.key ? ` (${failure.key})` : ''}: ${failure.code} ${failure.message}`,
  );
}

export function registerCollectionTools(server: McpServer, client: ZoteroLocalClient): void {
  defineTool(server, {
    name: 'zotero_list_collections',
    title: 'List collections',
    description:
      'List collections in a library. scope="all" returns every collection flat (each carrying its ' +
      'parentCollection key, so the full tree can be reconstructed in one call), "top" returns only ' +
      'root-level collections, and "children" returns the direct subcollections of parentKey. ' +
      'Collection keys returned here are what zotero_create_items, zotero_add_items_to_collection ' +
      'and zotero_search_items take.',
    inputSchema: {
      scope: z
        .enum(['all', 'top', 'children'])
        .default('all')
        .describe('Which collections to return. "children" requires parentKey.'),
      parentKey: objectKey.optional().describe('Parent collection key; required when scope is "children".'),
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, collections: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ scope, parentKey, groupId, limit, start, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      if (scope === 'children' && !parentKey) {
        throw new ZoteroInputError(
          'scope="children" requires parentKey.',
          'Pass the key of the parent collection, or use scope="top" for root-level collections.',
        );
      }

      const path =
        scope === 'top'
          ? `${prefix}/collections/top`
          : scope === 'children'
            ? `${prefix}/collections/${parentKey}/collections`
            : `${prefix}/collections`;

      const response = await client.request<ZoteroEnvelope[]>({ path, query: { limit, start } });
      const collections = compactList(response.data ?? [], verbose);
      return ok({ ...pageInfo(collections.length, start, response.totalResults), collections });
    },
  });

  defineTool(server, {
    name: 'zotero_get_collection',
    title: 'Get a collection',
    description:
      'Fetch one collection by key, including its name, parent collection, item count and current ' +
      'version. The version is what zotero_update_collection and zotero_delete_collection use for ' +
      'conflict detection.',
    inputSchema: {
      collectionKey: objectKey.describe('Collection key, e.g. "WXYZ5678".'),
      groupId: groupIdParam,
      verbose: verboseParam,
    },
    outputSchema: { collection: zoteroObject },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ collectionKey, groupId, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope>({ path: `${prefix}/collections/${collectionKey}` });
      return ok({ collection: compactObject(response.data, verbose) });
    },
  });

  defineTool(server, {
    name: 'zotero_create_collection',
    title: 'Create collections',
    description:
      'Create one or more collections, optionally nested under an existing collection. Up to 50 per ' +
      'call. Creating a nested tree takes one call per level, since a child needs its parent\'s key. ' +
      'Requires write access; zotero_authorize runs automatically if none has been granted.',
    inputSchema: {
      collections: z
        .array(
          z.object({
            name: z.string().min(1).describe('Collection name as shown in Zotero\'s sidebar.'),
            parentCollectionKey: objectKey
              .optional()
              .describe('Key of the parent collection. Omit to create at the root of the library.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('Collections to create, at most 50 per call.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      created: z.array(zoteroObject),
      failures: z.array(z.string()),
      libraryVersion: z.number().nullable(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ collections, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const payload = collections.map((collection) => ({
        name: collection.name,
        // Zotero expects `false`, not null or an absent key, for a root collection.
        parentCollection: collection.parentCollectionKey ?? false,
      }));

      const response = await client.request<WriteResults>({
        method: 'POST',
        path: `${prefix}/collections`,
        body: payload,
      });

      const created = Object.values(response.data.successful ?? {}).map((entry) => ({
        key: entry.key,
        name: (entry.data as { name?: string } | undefined)?.name,
        parentCollection: (entry.data as { parentCollection?: string | false } | undefined)?.parentCollection ?? false,
        version: entry.version,
      }));

      return ok({ created, failures: summarizeFailures(response.data), libraryVersion: response.version });
    },
  });

  defineTool(server, {
    name: 'zotero_update_collection',
    title: 'Rename or move a collection',
    description:
      'Rename a collection and/or move it under a different parent. Pass parentCollectionKey=null to ' +
      'move a collection to the root of the library. The current version is fetched automatically ' +
      'unless expectedVersion is given, in which case the write fails with a conflict if the ' +
      'collection changed in the meantime.',
    inputSchema: {
      collectionKey: objectKey.describe('Key of the collection to modify.'),
      name: z.string().min(1).optional().describe('New name. Omit to leave the name unchanged.'),
      parentCollectionKey: objectKey
        .nullable()
        .optional()
        .describe('New parent collection key, or null to move to the library root. Omit to leave the parent unchanged.'),
      expectedVersion: z
        .number()
        .int()
        .optional()
        .describe('Version the collection is expected to be at, for conflict detection. Omit to use the current version.'),
      groupId: groupIdParam,
    },
    outputSchema: { updated: z.boolean(), collectionKey: z.string(), libraryVersion: z.number().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ collectionKey, name, parentCollectionKey, expectedVersion, groupId }) => {
      if (name === undefined && parentCollectionKey === undefined) {
        throw new ZoteroInputError(
          'Nothing to update: pass name, parentCollectionKey, or both.',
          'To move a collection to the library root, pass parentCollectionKey: null.',
        );
      }
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const path = `${prefix}/collections/${collectionKey}`;
      const version = await objectVersion(client, path, expectedVersion);

      const patch: Record<string, unknown> = { version };
      if (name !== undefined) patch.name = name;
      if (parentCollectionKey !== undefined) patch.parentCollection = parentCollectionKey ?? false;

      const response = await client.request<unknown>({ method: 'PATCH', path, body: patch });
      return ok({ updated: true, collectionKey, libraryVersion: response.version });
    },
  });

  defineTool(server, {
    name: 'zotero_delete_collection',
    title: 'Delete collections',
    description:
      'Delete one or more collections. The items inside are NOT deleted: they stay in the library ' +
      'and remain in any other collection they belong to. Subcollections of a deleted collection are ' +
      'deleted with it. This is not reversible through the API, so confirm with the user first.',
    inputSchema: {
      collectionKeys: z
        .array(objectKey)
        .min(1)
        .max(50)
        .describe('Keys of the collections to delete, at most 50 per call.'),
      groupId: groupIdParam,
    },
    outputSchema: { deleted: z.array(z.string()), libraryVersion: z.number().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async ({ collectionKeys, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const version = await libraryVersion(client, prefix);
      const response = await client.request<unknown>({
        method: 'DELETE',
        path: `${prefix}/collections`,
        query: { collectionKey: collectionKeys.join(',') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return ok({ deleted: collectionKeys, libraryVersion: response.version });
    },
  });
}
