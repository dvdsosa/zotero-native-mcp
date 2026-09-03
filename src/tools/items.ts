/**
 * Item reading, searching and writing.
 *
 * Search runs through Zotero's own search engine over the local database, so
 * quicksearch modes ("everything" reaches into attachment full text) behave
 * exactly as they do in the Zotero UI, with no network round trip and no
 * rate limit.
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

interface WriteResults {
  successful?: Record<string, ZoteroEnvelope>;
  failed?: Record<string, { key?: string; code: number; message: string }>;
}

/** Zotero JSON for a new or updated item. Fields vary by itemType. */
const itemInput = z
  .object({
    itemType: z
      .string()
      .describe(
        'Zotero item type, e.g. "journalArticle", "book", "bookSection", "thesis", "preprint", ' +
          '"conferencePaper", "report", "note", "attachment". Use zotero_get_item_type_fields to ' +
          'check which fields a type accepts.',
      ),
    title: z.string().optional(),
    creators: z
      .array(
        z
          .object({
            creatorType: z.string().describe('e.g. "author", "editor", "translator".'),
            firstName: z.string().optional().describe('Given name; pair with lastName for a two-field name.'),
            lastName: z.string().optional().describe('Family name; pair with firstName.'),
            name: z.string().optional().describe('Single-field name, for institutions. Use instead of firstName/lastName.'),
          })
          .passthrough(),
      )
      .optional(),
    tags: z
      .array(z.object({ tag: z.string(), type: z.number().int().optional() }).passthrough())
      .optional()
      .describe('Tags to attach. type 1 marks an automatic tag; omit type for a manual one.'),
    collections: z
      .array(objectKey)
      .optional()
      .describe('Collection keys the new item should be filed into. This is how an item lands in a collection at creation time.'),
    parentItem: objectKey.optional().describe('Parent item key, for notes and attachments.'),
  })
  .passthrough()
  .describe('Zotero item JSON. Any field valid for the itemType may be included alongside the documented ones.');

function summarizeFailures(results: WriteResults): string[] {
  return Object.entries(results.failed ?? {}).map(
    ([index, failure]) => `index ${index}${failure.key ? ` (${failure.key})` : ''}: ${failure.code} ${failure.message}`,
  );
}

/** Runs `worker` over `values` with bounded concurrency to avoid flooding Zotero. */
async function mapLimited<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Shared implementation of add/remove-from-collection: reads each item's
 * current collection membership, then PATCHes only the ones that change.
 */
async function editCollectionMembership(
  client: ZoteroLocalClient,
  prefix: string,
  itemKeys: string[],
  collectionKey: string,
  mode: 'add' | 'remove',
): Promise<{ changed: string[]; unchanged: string[] }> {
  // Read each item directly. A list query filtered by itemKey also returns the
  // items' children, which would both pollute the lookup and be cut off by limit.
  const byKey = new Map<string, ZoteroEnvelope>();
  const missing: string[] = [];
  await mapLimited(itemKeys, 5, async (key) => {
    try {
      const response = await client.request<ZoteroEnvelope>({ path: `${prefix}/items/${key}` });
      byKey.set(key, response.data);
    } catch (error) {
      if (error instanceof ZoteroHttpError && error.status === 404) missing.push(key);
      else throw error;
    }
  });

  if (missing.length) {
    throw new ZoteroInputError(
      `Item(s) not found in this library: ${missing.join(', ')}.`,
      'Verify the keys with zotero_search_items, and check whether they belong to a group library ' +
        '(pass groupId) rather than the personal library.',
    );
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  const updates: { key: string; version: number; collections: string[] }[] = [];

  for (const key of itemKeys) {
    const entry = byKey.get(key) as ZoteroEnvelope;
    const data = (entry.data ?? {}) as { collections?: string[] };
    const existing = new Set(data.collections ?? []);
    const present = existing.has(collectionKey);
    if ((mode === 'add' && present) || (mode === 'remove' && !present)) {
      unchanged.push(key);
      continue;
    }
    if (mode === 'add') existing.add(collectionKey);
    else existing.delete(collectionKey);
    updates.push({ key, version: entry.version ?? 0, collections: [...existing] });
    changed.push(key);
  }

  await mapLimited(updates, 5, async (update) => {
    await client.request<unknown>({
      method: 'PATCH',
      path: `${prefix}/items/${update.key}`,
      body: { version: update.version, collections: update.collections },
    });
  });

  return { changed, unchanged };
}

/**
 * Sets or clears the trash flag on a set of items.
 *
 * Zotero's trash is an ordinary field: `deleted: true` hides the object from
 * normal views but keeps it, its children and its files intact and restorable.
 * Each item is patched individually so a single bad key cannot take the batch
 * down with it.
 */
async function setTrashed(
  client: ZoteroLocalClient,
  prefix: string,
  itemKeys: string[],
  deleted: boolean,
): Promise<{ changed: string[]; alreadyThere: string[]; missing: string[] }> {
  const changed: string[] = [];
  const alreadyThere: string[] = [];
  const missing: string[] = [];

  await mapLimited(itemKeys, 5, async (key) => {
    let current: ZoteroEnvelope;
    try {
      const response = await client.request<ZoteroEnvelope>({ path: `${prefix}/items/${key}` });
      current = response.data;
    } catch (error) {
      if (error instanceof ZoteroHttpError && error.status === 404) { missing.push(key); return; }
      throw error;
    }
    const data = (current.data ?? {}) as { deleted?: boolean };
    if (Boolean(data.deleted) === deleted) { alreadyThere.push(key); return; }
    await client.request<unknown>({
      method: 'PATCH',
      path: `${prefix}/items/${key}`,
      body: { version: current.version ?? 0, deleted },
    });
    changed.push(key);
  });

  return { changed, alreadyThere, missing };
}

export function registerItemTools(server: McpServer, client: ZoteroLocalClient): void {
  defineTool(server, {
    name: 'zotero_search_items',
    title: 'Search items',
    description:
      'Search the local Zotero library. `q` runs Zotero\'s quicksearch: qmode "titleCreatorYear" ' +
      '(default) matches titles, creators and years, while "everything" also matches attachment ' +
      'full text and notes. Filters combine: pass collectionKey to search inside one collection, ' +
      'itemType to restrict by type ("-attachment" excludes a type), tag to filter by tag. Omit `q` ' +
      'to browse. Returns flattened item metadata; use zotero_get_item for one item in full.',
    inputSchema: {
      q: z.string().optional().describe('Search text. Omit to list items without filtering by text.'),
      qmode: z
        .enum(['titleCreatorYear', 'everything'])
        .default('titleCreatorYear')
        .describe('"titleCreatorYear" searches metadata only; "everything" also searches full text and notes (slower).'),
      itemType: z
        .string()
        .optional()
        .describe('Item type filter. Supports Zotero syntax: "book", "book || journalArticle", "-attachment".'),
      tag: z
        .string()
        .optional()
        .describe('Tag filter. Supports "tag1 || tag2" for OR and a leading "-" to exclude.'),
      collectionKey: objectKey.optional().describe('Restrict the search to one collection.'),
      topLevelOnly: z
        .boolean()
        .default(true)
        .describe('Return only top-level items, hiding child notes and attachments. Set false to include children.'),
      includeTrashed: z.boolean().default(false).describe('Include items currently in the trash.'),
      since: z
        .number()
        .int()
        .optional()
        .describe('Return only objects modified after this library version, for incremental syncing.'),
      sort: z
        .enum(['dateAdded', 'dateModified', 'title', 'creator', 'itemType', 'date', 'publisher', 'publicationTitle'])
        .default('dateModified')
        .describe('Sort field.'),
      direction: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, items: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args) => {
      const prefix = libraryPrefix(libraryOf(args));
      const base = args.collectionKey ? `${prefix}/collections/${args.collectionKey}/items` : `${prefix}/items`;
      const path = args.topLevelOnly ? `${base}/top` : base;

      const response = await client.request<ZoteroEnvelope[]>({
        path,
        query: {
          q: args.q,
          qmode: args.q ? args.qmode : undefined,
          itemType: args.itemType,
          tag: args.tag,
          since: args.since,
          sort: args.sort,
          direction: args.direction,
          includeTrashed: args.includeTrashed ? 1 : undefined,
          limit: args.limit,
          start: args.start,
        },
      });

      const items = compactList(response.data ?? [], args.verbose);
      return ok({ ...pageInfo(items.length, args.start, response.totalResults), items });
    },
  });

  defineTool(server, {
    name: 'zotero_get_item',
    title: 'Get an item',
    description:
      'Fetch one item by key with all of its metadata. Set includeChildren to also return its notes ' +
      'and attachments, which is the quickest way to find the attachment key needed to read a PDF ' +
      'or its full text.',
    inputSchema: {
      itemKey: objectKey.describe('Item key, e.g. "ABCD1234".'),
      includeChildren: z.boolean().default(false).describe('Also return child notes and attachments.'),
      groupId: groupIdParam,
      verbose: verboseParam,
    },
    outputSchema: { item: zoteroObject, children: z.array(zoteroObject).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKey, includeChildren, groupId, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope>({ path: `${prefix}/items/${itemKey}` });
      const payload: Record<string, unknown> = { item: compactObject(response.data, verbose) };

      if (includeChildren) {
        const children = await client.request<ZoteroEnvelope[]>({ path: `${prefix}/items/${itemKey}/children` });
        payload.children = compactList(children.data ?? [], verbose);
      }
      return ok(payload);
    },
  });

  defineTool(server, {
    name: 'zotero_get_item_children',
    title: 'Get item children',
    description:
      'List the child notes, attachments and annotations of an item. Attachment children carry the ' +
      'linkMode and filename needed by zotero_get_attachment_path and zotero_get_item_fulltext.',
    inputSchema: {
      itemKey: objectKey.describe('Parent item key.'),
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, children: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKey, groupId, limit, start, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope[]>({
        path: `${prefix}/items/${itemKey}/children`,
        query: { limit, start },
      });
      const children = compactList(response.data ?? [], verbose);
      return ok({ ...pageInfo(children.length, start, response.totalResults), children });
    },
  });

  defineTool(server, {
    name: 'zotero_create_items',
    title: 'Create items',
    description:
      'Create up to 50 items in one call. Set `collections` on an item to file it into collections ' +
      'as it is created, which is cheaper than creating it and moving it afterwards. Notes and ' +
      'attachments are created by setting parentItem. To attach a file from disk use ' +
      'zotero_attach_file instead, which handles the whole attachment protocol. Check the returned ' +
      '`failures` array: Zotero validates each item independently, so some can succeed while others fail.',
    inputSchema: {
      items: z.array(itemInput).min(1).max(50).describe('Items to create, at most 50 per call.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      created: z.array(zoteroObject),
      failures: z.array(z.string()),
      libraryVersion: z.number().nullable(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ items, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<WriteResults>({
        method: 'POST',
        path: `${prefix}/items`,
        body: items,
      });

      const created = Object.values(response.data.successful ?? {}).map((entry) => {
        const data = (entry.data ?? {}) as Record<string, unknown>;
        return {
          key: entry.key,
          version: entry.version,
          itemType: data.itemType,
          title: data.title ?? null,
          collections: data.collections ?? [],
        };
      });

      return ok({ created, failures: summarizeFailures(response.data), libraryVersion: response.version });
    },
  });

  defineTool(server, {
    name: 'zotero_update_item',
    title: 'Update an item',
    description:
      'Patch fields on an existing item. Only the fields passed in `fields` change; everything else ' +
      'is left alone. Array fields are replaced wholesale, so to change collection membership prefer ' +
      'zotero_add_items_to_collection / zotero_remove_items_from_collection, which merge instead of ' +
      'overwriting. The current version is read automatically unless expectedVersion is supplied.',
    inputSchema: {
      itemKey: objectKey.describe('Key of the item to update.'),
      fields: z
        .record(z.string(), z.unknown())
        .describe(
          'Fields to set, as Zotero item JSON, e.g. {"title": "New title", "date": "2024", ' +
            '"tags": [{"tag": "to-read"}]}. Field names must be valid for the item\'s type.',
        ),
      expectedVersion: z
        .number()
        .int()
        .optional()
        .describe('Version the item is expected to be at, for conflict detection. Omit to use the current version.'),
      groupId: groupIdParam,
    },
    outputSchema: { updated: z.boolean(), itemKey: z.string(), libraryVersion: z.number().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKey, fields, expectedVersion, groupId }) => {
      if (Object.keys(fields).length === 0) {
        throw new ZoteroInputError('`fields` is empty: nothing to update.');
      }
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const path = `${prefix}/items/${itemKey}`;
      const version = await objectVersion(client, path, expectedVersion);

      const response = await client.request<unknown>({
        method: 'PATCH',
        path,
        body: { ...fields, version },
      });
      return ok({ updated: true, itemKey, libraryVersion: response.version });
    },
  });

  defineTool(server, {
    name: 'zotero_delete_items',
    title: 'Delete items',
    description:
      'Move up to 50 items to Zotero\'s trash, where the user can restore them from the Zotero ' +
      'window or with zotero_restore_items. This is the default and it is reversible. Trashed ' +
      'items keep their attachments and files; Zotero empties the trash automatically after 30 ' +
      'days by default. Pass permanent: true only when the user has explicitly asked for an ' +
      'irreversible delete: that erases the items outright, takes their child notes and ' +
      'attachments with them, removes attachment files from disk, and cannot be undone by anything.',
    inputSchema: {
      itemKeys: z.array(objectKey).min(1).max(50).describe('Keys of the items to remove, at most 50 per call.'),
      permanent: z
        .boolean()
        .default(false)
        .describe(
          'false (default) moves the items to the trash, which is reversible. true erases them ' +
            'immediately and irreversibly, deleting attachment files from disk. Only pass true on ' +
            'an explicit request from the user.',
        ),
      groupId: groupIdParam,
    },
    outputSchema: {
      permanent: z.boolean(),
      trashed: z.array(z.string()).describe('Items moved to the trash. Empty when permanent is true.'),
      erased: z.array(z.string()).describe('Items erased irreversibly. Empty when permanent is false.'),
      alreadyInTrash: z.array(z.string()),
      notFound: z.array(z.string()),
      libraryVersion: z.number().nullable(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async ({ itemKeys, permanent, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));

      if (!permanent) {
        const result = await setTrashed(client, prefix, itemKeys, true);
        if (result.missing.length && !result.changed.length && !result.alreadyThere.length) {
          throw new ZoteroInputError(
            `Item(s) not found in this library: ${result.missing.join(', ')}.`,
            'Verify the keys with zotero_search_items, and check whether they live in a group ' +
              'library (pass groupId) rather than the personal library.',
          );
        }
        return ok({
          permanent: false,
          trashed: result.changed,
          erased: [],
          alreadyInTrash: result.alreadyThere,
          notFound: result.missing,
          libraryVersion: null,
        });
      }

      const version = await libraryVersion(client, prefix);
      const response = await client.request<unknown>({
        method: 'DELETE',
        path: `${prefix}/items`,
        query: { itemKey: itemKeys.join(',') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return ok({
        permanent: true,
        trashed: [],
        erased: itemKeys,
        alreadyInTrash: [],
        notFound: [],
        libraryVersion: response.version,
      });
    },
  });

  defineTool(server, {
    name: 'zotero_restore_items',
    title: 'Restore items from the trash',
    description:
      'Bring items back out of Zotero\'s trash, undoing a non-permanent zotero_delete_items. The ' +
      'items return to the collections they were in. Only works while they are still in the trash: ' +
      'nothing can recover an item that was erased permanently or that Zotero has already purged ' +
      'after its 30-day retention.',
    inputSchema: {
      itemKeys: z.array(objectKey).min(1).max(50).describe('Keys of the items to restore, at most 50 per call.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      restored: z.array(z.string()),
      wereNotInTrash: z.array(z.string()),
      notFound: z.array(z.string()),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKeys, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const result = await setTrashed(client, prefix, itemKeys, false);
      if (result.missing.length && !result.changed.length && !result.alreadyThere.length) {
        throw new ZoteroInputError(
          `Item(s) not found in this library: ${result.missing.join(', ')}.`,
          'An item erased permanently is gone for good and cannot be restored. Use ' +
            'zotero_list_trash to see what is still recoverable.',
        );
      }
      return ok({ restored: result.changed, wereNotInTrash: result.alreadyThere, notFound: result.missing });
    },
  });

  defineTool(server, {
    name: 'zotero_list_trash',
    title: 'List the trash',
    description:
      'List the items currently in Zotero\'s trash, which are the ones zotero_restore_items can ' +
      'bring back. Note that trashed *collections* do not appear here: Zotero\'s local API offers ' +
      'no way to enumerate them, so a trashed collection can only be restored by key or from the ' +
      'Zotero window.',
    inputSchema: {
      groupId: groupIdParam,
      limit: limitParam,
      start: startParam,
      verbose: verboseParam,
    },
    outputSchema: { ...listOutputShape, items: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ groupId, limit, start, verbose }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const response = await client.request<ZoteroEnvelope[]>({
        path: `${prefix}/items/trash`,
        query: { limit, start },
      });
      const items = compactList(response.data ?? [], verbose);
      return ok({ ...pageInfo(items.length, start, response.totalResults), items });
    },
  });

  defineTool(server, {
    name: 'zotero_empty_trash',
    title: 'Empty the trash',
    description:
      'Permanently erase every item in the trash. This is irreversible and removes attachment ' +
      'files from disk. As an interlock against emptying a trash the caller has not looked at, ' +
      'expectedCount must equal the number of items actually in it: call zotero_list_trash first ' +
      'and pass its totalResults. If the two disagree the call is refused and nothing is deleted. ' +
      'Only use this when the user has explicitly asked to empty the trash.',
    inputSchema: {
      expectedCount: z
        .number()
        .int()
        .min(0)
        .describe('How many items you expect to erase, from zotero_list_trash. A mismatch aborts the call.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      erased: z.number(),
      libraryVersion: z.number().nullable(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async ({ expectedCount, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const trash = await client.request<ZoteroEnvelope[]>({
        path: `${prefix}/items/trash`,
        query: { limit: 1, format: 'json' },
      });
      const actual = trash.totalResults ?? 0;
      if (actual !== expectedCount) {
        throw new ZoteroInputError(
          `Refusing to empty the trash: expected ${expectedCount} items, found ${actual}.`,
          'The interlock exists so this can never run on a trash the caller has not inspected. ' +
            'Call zotero_list_trash, show the user what is in there, and pass its totalResults.',
        );
      }
      if (actual === 0) return ok({ erased: 0, libraryVersion: null });

      // Erase in batches, since the API caps a delete at 50 keys.
      let erased = 0;
      let lastVersion: number | null = null;
      for (;;) {
        const page = await client.request<ZoteroEnvelope[]>({
          path: `${prefix}/items/trash`,
          query: { limit: 50 },
        });
        const keys = (page.data ?? []).map((entry) => entry.key).filter((k): k is string => !!k);
        if (!keys.length) break;
        const version = await libraryVersion(client, prefix);
        const response = await client.request<unknown>({
          method: 'DELETE',
          path: `${prefix}/items`,
          query: { itemKey: keys.join(',') },
          headers: { 'If-Unmodified-Since-Version': String(version) },
        });
        lastVersion = response.version;
        erased += keys.length;
      }
      return ok({ erased, libraryVersion: lastVersion });
    },
  });

  defineTool(server, {
    name: 'zotero_add_items_to_collection',
    title: 'Add items to a collection',
    description:
      'File existing items into a collection, keeping every collection they already belong to. An ' +
      'item in Zotero can sit in any number of collections, so this adds rather than moves. Items ' +
      'already in the collection are reported as unchanged and cost no write.',
    inputSchema: {
      itemKeys: z.array(objectKey).min(1).max(50).describe('Keys of the items to file.'),
      collectionKey: objectKey.describe('Target collection key.'),
      groupId: groupIdParam,
    },
    outputSchema: { collectionKey: z.string(), added: z.array(z.string()), alreadyPresent: z.array(z.string()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKeys, collectionKey, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const { changed, unchanged } = await editCollectionMembership(client, prefix, itemKeys, collectionKey, 'add');
      return ok({ collectionKey, added: changed, alreadyPresent: unchanged });
    },
  });

  defineTool(server, {
    name: 'zotero_remove_items_from_collection',
    title: 'Remove items from a collection',
    description:
      'Remove items from one collection. The items stay in the library and in any other collection ' +
      'they belong to; nothing is deleted. Items that were not in the collection are reported as ' +
      'unchanged.',
    inputSchema: {
      itemKeys: z.array(objectKey).min(1).max(50).describe('Keys of the items to remove.'),
      collectionKey: objectKey.describe('Collection to remove them from.'),
      groupId: groupIdParam,
    },
    outputSchema: { collectionKey: z.string(), removed: z.array(z.string()), notPresent: z.array(z.string()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKeys, collectionKey, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const { changed, unchanged } = await editCollectionMembership(client, prefix, itemKeys, collectionKey, 'remove');
      return ok({ collectionKey, removed: changed, notPresent: unchanged });
    },
  });

  defineTool(server, {
    name: 'zotero_get_item_fulltext',
    title: 'Get attachment full text',
    description:
      'Return the indexed full text of an attachment. Passing a regular item key works too: its ' +
      'attachments are searched and the first one with indexed text is used. Text comes from ' +
      'Zotero\'s own index, so it is available only for attachments Zotero has indexed. Long ' +
      'documents can be truncated with maxCharacters.',
    inputSchema: {
      itemKey: objectKey.describe('Attachment key, or a parent item key to search its attachments.'),
      maxCharacters: z
        .number()
        .int()
        .min(100)
        .max(500_000)
        .default(50_000)
        .describe('Truncate the returned text at this many characters.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      attachmentKey: z.string(),
      content: z.string(),
      truncated: z.boolean(),
      totalCharacters: z.number(),
      indexedPages: z.number().nullable(),
      totalPages: z.number().nullable(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKey, maxCharacters, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));

      interface FullText {
        content?: string;
        indexedPages?: number;
        totalPages?: number;
      }

      const fetchText = async (key: string): Promise<FullText | null> => {
        try {
          const response = await client.request<FullText>({ path: `${prefix}/items/${key}/fulltext` });
          return typeof response.data?.content === 'string' ? response.data : null;
        } catch (error) {
          // A missing index reads as 404; that is a "no text here", not a failure.
          if (error instanceof ZoteroHttpError && error.status === 404) return null;
          throw error;
        }
      };

      let key = itemKey;
      let text = await fetchText(key);

      if (!text) {
        const children = await client.request<ZoteroEnvelope[]>({ path: `${prefix}/items/${itemKey}/children` });
        for (const child of children.data ?? []) {
          const data = (child.data ?? {}) as { itemType?: string };
          if (data.itemType !== 'attachment' || !child.key) continue;
          const candidate = await fetchText(child.key);
          if (candidate) {
            key = child.key;
            text = candidate;
            break;
          }
        }
      }

      if (!text) {
        throw new ZoteroInputError(
          `No indexed full text found for ${itemKey} or its attachments.`,
          'Zotero indexes attachments in the background and cannot index every file (scanned PDFs ' +
            'without OCR, for instance). Use zotero_get_attachment_path to get the file on disk and ' +
            'read it directly instead.',
        );
      }

      const content = text.content ?? '';
      const truncated = content.length > maxCharacters;
      return ok({
        attachmentKey: key,
        content: truncated ? content.slice(0, maxCharacters) : content,
        truncated,
        totalCharacters: content.length,
        indexedPages: text.indexedPages ?? null,
        totalPages: text.totalPages ?? null,
      });
    },
  });

  defineTool(server, {
    name: 'zotero_export_items',
    title: 'Export citations',
    description:
      'Export items in a citation format. Use format "bibtex", "biblatex", "ris", "csljson", "csv" ' +
      'or "tei" for a machine-readable export, or "bib" to render a formatted bibliography in a ' +
      'citation style (set `style`, e.g. "apa", "chicago-note-bibliography", "ieee"). Returns the ' +
      'export as text.',
    inputSchema: {
      itemKeys: z.array(objectKey).min(1).max(100).describe('Keys of the items to export.'),
      format: z
        .enum(['bibtex', 'biblatex', 'ris', 'csljson', 'csv', 'tei', 'mods', 'refer', 'coins', 'bib'])
        .default('bibtex')
        .describe('Export format. "bib" renders a formatted bibliography using `style`.'),
      style: z
        .string()
        .default('apa')
        .describe('Citation style for format "bib", e.g. "apa", "ieee", "chicago-note-bibliography". Ignored otherwise.'),
      locale: z.string().default('en-US').describe('Locale for format "bib", e.g. "en-US", "es-ES".'),
      groupId: groupIdParam,
    },
    outputSchema: {
      format: z.string(),
      itemCount: z.number(),
      skippedKeys: z.array(z.string()).describe('Requested keys that are not top-level items and were left out.'),
      output: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKeys, format, style, locale, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));
      // /items/top keeps child notes and attachments out of the export; a plain
      // /items query filtered by itemKey would drag them in. Resolve first so
      // keys that are not top-level items are reported rather than silently dropped.
      const resolved = await client.request<string>({
        path: `${prefix}/items/top`,
        query: { itemKey: itemKeys.join(','), includeTrashed: 1, format: 'keys' },
        expectText: true,
      });
      const exportedKeys = resolved.data.split('\n').map((line) => line.trim()).filter(Boolean);
      const skippedKeys = itemKeys.filter((key) => !exportedKeys.includes(key));

      if (exportedKeys.length === 0) {
        throw new ZoteroInputError(
          'None of the keys resolve to a top-level item, so there is nothing to export.',
          'Attachments and notes have no citation form. Pass the key of the parent reference ' +
            '(see parentItem on the child, or zotero_search_items).',
        );
      }

      const response = await client.request<string>({
        path: `${prefix}/items/top`,
        query: {
          itemKey: exportedKeys.join(','),
          format,
          includeTrashed: 1,
          style: format === 'bib' ? style : undefined,
          locale: format === 'bib' ? locale : undefined,
        },
        expectText: true,
      });
      return ok({ format, itemCount: exportedKeys.length, skippedKeys, output: response.data.trim() });
    },
  });
}
