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
import { ZoteroHttpError, ZoteroInputError } from '../errors.js';
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

/**
 * Sets or clears the trash flag on collections.
 *
 * Zotero keeps trashed collections in its own `deletedCollections` table: the
 * collection disappears from the sidebar but survives intact and restorable.
 * Note that the local API cannot *enumerate* them, so a caller must hold the key.
 */
async function setCollectionsTrashed(
  client: ZoteroLocalClient,
  prefix: string,
  collectionKeys: string[],
  deleted: boolean,
): Promise<{ changed: string[]; missing: string[] }> {
  const changed: string[] = [];
  const missing: string[] = [];

  for (const key of collectionKeys) {
    let current: { version?: number };
    try {
      const response = await client.request<{ version?: number }>({ path: `${prefix}/collections/${key}` });
      current = response.data;
    } catch (error) {
      if (error instanceof ZoteroHttpError && error.status === 404) { missing.push(key); continue; }
      throw error;
    }
    await client.request<unknown>({
      method: 'PATCH',
      path: `${prefix}/collections/${key}`,
      body: { version: current.version ?? 0, deleted },
    });
    changed.push(key);
  }
  return { changed, missing };
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
      'Move collections to Zotero\'s trash, which is reversible and the default. The items inside ' +
      'are never deleted either way: they stay in the library and in any other collection they ' +
      'belong to. Subcollections follow their parent. Pass permanent: true only on an explicit ' +
      'request from the user, to erase the collections outright with no way back. Note that a ' +
      'trashed collection cannot be listed through the local API, so record the key returned here ' +
      'if it may need restoring.',
    inputSchema: {
      collectionKeys: z
        .array(objectKey)
        .min(1)
        .max(50)
        .describe('Keys of the collections to remove, at most 50 per call.'),
      permanent: z
        .boolean()
        .default(false)
        .describe(
          'false (default) moves the collections to the trash, which is reversible. true erases ' +
            'them irreversibly. Only pass true on an explicit request from the user.',
        ),
      groupId: groupIdParam,
    },
    outputSchema: {
      permanent: z.boolean(),
      trashed: z.array(z.string()).describe('Collections moved to the trash. Empty when permanent is true.'),
      erased: z.array(z.string()).describe('Collections erased irreversibly. Empty when permanent is false.'),
      notFound: z.array(z.string()),
      libraryVersion: z.number().nullable(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async ({ collectionKeys, permanent, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));

      if (!permanent) {
        const result = await setCollectionsTrashed(client, prefix, collectionKeys, true);
        if (result.missing.length && !result.changed.length) {
          throw new ZoteroInputError(
            `Collection(s) not found in this library: ${result.missing.join(', ')}.`,
            'Verify the keys with zotero_list_collections, and check the groupId if they belong ' +
              'to a group library.',
          );
        }
        return ok({
          permanent: false,
          trashed: result.changed,
          erased: [],
          notFound: result.missing,
          libraryVersion: null,
        });
      }

      const version = await libraryVersion(client, prefix);
      const response = await client.request<unknown>({
        method: 'DELETE',
        path: `${prefix}/collections`,
        query: { collectionKey: collectionKeys.join(',') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return ok({
        permanent: true,
        trashed: [],
        erased: collectionKeys,
        notFound: [],
        libraryVersion: response.version,
      });
    },
  });

  defineTool(server, {
    name: 'zotero_restore_collection',
    title: 'Restore collections from the trash',
    description:
      'Bring collections back out of Zotero\'s trash, undoing a non-permanent ' +
      'zotero_delete_collection. You must know the key: Zotero\'s local API cannot list trashed ' +
      'collections, so there is no way to discover them from here — the user can see them in the ' +
      'Zotero window\'s trash. A collection erased permanently cannot be restored at all.',
    inputSchema: {
      collectionKeys: z
        .array(objectKey)
        .min(1)
        .max(50)
        .describe('Keys of the collections to restore, at most 50 per call.'),
      groupId: groupIdParam,
    },
    outputSchema: { restored: z.array(z.string()), notFound: z.array(z.string()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ collectionKeys, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const result = await setCollectionsTrashed(client, prefix, collectionKeys, false);
      if (result.missing.length && !result.changed.length) {
        throw new ZoteroInputError(
          `Collection(s) not found in this library: ${result.missing.join(', ')}.`,
          'A collection erased permanently is gone for good. Trashed ones are still addressable ' +
            'by key even though they cannot be listed.',
        );
      }
      return ok({ restored: result.changed, notFound: result.missing });
    },
  });
}
