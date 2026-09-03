/**
 * Connection, authorization, library discovery and schema introspection.
 *
 * These are the tools an agent reaches for first: to confirm Zotero is
 * reachable, to obtain write access, and to learn which fields a given item
 * type actually accepts before attempting a write.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ZoteroLocalClient } from '../client.js';
import { ok } from '../format.js';
import { defineTool, zoteroObject } from './shared.js';

interface LibraryBlock {
  type: string;
  id: number;
  name: string;
  links?: unknown;
}

/**
 * The local API has no "describe my library" endpoint, so the personal
 * library's identity is read off the envelope of any one object.
 */
async function resolvePersonalLibrary(client: ZoteroLocalClient): Promise<LibraryBlock | null> {
  for (const path of ['/users/0/collections', '/users/0/items', '/users/0/searches']) {
    const response = await client.request<{ library?: LibraryBlock }[]>({
      path,
      query: { limit: 1 },
    });
    const block = Array.isArray(response.data) ? response.data[0]?.library : undefined;
    // The envelope's library block carries self/alternate links that say nothing
    // a caller can act on locally.
    if (block) return { type: block.type, id: block.id, name: block.name };
  }
  return null;
}

export function registerSystemTools(server: McpServer, client: ZoteroLocalClient): void {
  defineTool(server, {
    name: 'zotero_status',
    title: 'Zotero connection status',
    description:
      'Check that the local Zotero instance is running and reachable, and report its version, ' +
      'schema version, instance ID, and whether write access has been granted yet. Call this ' +
      'first when any other tool reports a connection or authorization problem.',
    inputSchema: {},
    outputSchema: {
      connected: z.boolean(),
      baseUrl: z.string(),
      zoteroVersion: z.string().nullable(),
      apiVersion: z.string().nullable(),
      schemaVersion: z.string().nullable(),
      serverId: z.string(),
      writeAccess: z.boolean(),
      appName: z.string(),
      personalLibrary: zoteroObject.nullable(),
      groupLibraries: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async () => {
      const root = await client.request<string>({ path: '/api/', expectText: true });
      const serverId = await client.getServerId();
      const groups = await client.request<unknown[]>({ path: '/users/0/groups' });
      const personalLibrary = await resolvePersonalLibrary(client);

      return ok({
        connected: true,
        baseUrl: client.baseUrl,
        zoteroVersion: root.headers.get('X-Zotero-Version'),
        apiVersion: root.headers.get('Zotero-API-Version'),
        schemaVersion: root.headers.get('Zotero-Schema-Version'),
        serverId,
        writeAccess: await client.hasApiKey(),
        appName: client.appName,
        personalLibrary: personalLibrary as Record<string, unknown> | null,
        groupLibraries: Array.isArray(groups.data) ? groups.data.length : 0,
      });
    },
  });

  defineTool(server, {
    name: 'zotero_authorize',
    title: 'Request Zotero write access',
    description:
      'Request a local API key so write tools (creating collections, items, and attachments) can ' +
      'run. This raises a modal dialog inside Zotero on the user\'s screen with three choices: ' +
      '"Allow" issues a single-use key, "Always Allow" issues a persistent one, and "Deny" ' +
      'refuses. Tell the user to expect the dialog, and to pick "Always Allow" for a session that ' +
      'will perform several writes. The key is stored locally and reused; write tools also ' +
      're-authorize on their own when a single-use key is spent, so calling this manually is only ' +
      'needed to grant access up front. Calling it when a key is already stored reuses that key ' +
      'and shows no dialog.',
    inputSchema: {
      force: z
        .boolean()
        .default(false)
        .describe(
          'Request a new key even though one is already stored. Rarely needed: a stored key is ' +
            'reused, and replacing a persistent key with a single-use one makes things worse.',
        ),
    },
    outputSchema: {
      authorized: z.boolean(),
      persistent: z
        .boolean()
        .describe('True when the key persists; false keys are consumed by the next write.'),
      alreadyHeld: z.boolean().describe('True when an existing stored key was reused and no dialog appeared.'),
      message: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ force }) => {
      const held = await client.hasApiKey();
      const result = await client.authorize({ force });
      const alreadyHeld = held && !force;
      return ok({
        authorized: true,
        persistent: result.remember,
        alreadyHeld,
        message: alreadyHeld
          ? 'A key was already stored and has been reused; no dialog was shown.'
          : result.remember
            ? 'Write access granted persistently. The key is stored and will be reused.'
            : 'Write access granted for a single write only. The next write consumes this key and ' +
              'Zotero will prompt again, ask the user for "Always Allow" to stop that.',
      });
    },
  });

  defineTool(server, {
    name: 'zotero_list_libraries',
    title: 'List libraries',
    description:
      'List the personal library and every group library available locally. Use this to get the ' +
      'groupId that other tools take when the target is a group library rather than "My Library".',
    inputSchema: {},
    outputSchema: {
      personalLibrary: zoteroObject.nullable(),
      groups: z.array(zoteroObject),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async () => {
      const groups = await client.request<
        { id: number; version: number; meta?: Record<string, unknown>; data?: Record<string, unknown> }[]
      >({ path: '/users/0/groups' });
      const personalLibrary = await resolvePersonalLibrary(client);

      return ok({
        personalLibrary: personalLibrary as Record<string, unknown> | null,
        // The local API deliberately exposes only minimal group metadata:
        // permissions and ownership live on zotero.org and are not mirrored here.
        groups: (groups.data ?? []).map((group) => ({
          groupId: group.id,
          name: group.data?.name ?? null,
          description: group.data?.description ?? null,
          numItems: group.meta?.numItems ?? null,
        })),
      });
    },
  });

  defineTool(server, {
    name: 'zotero_get_item_type_fields',
    title: 'Describe an item type',
    description:
      'List the valid field names and creator types for a Zotero item type, or list every item ' +
      'type when itemType is omitted. Call this before zotero_create_items with an unfamiliar ' +
      'item type: Zotero rejects a write outright if it carries a field the type does not define.',
    inputSchema: {
      itemType: z
        .string()
        .optional()
        .describe('Item type to describe, e.g. "journalArticle", "book", "thesis", "preprint". Omit to list all types.'),
    },
    outputSchema: {
      itemTypes: z.array(zoteroObject).optional(),
      itemType: z.string().optional(),
      fields: z.array(z.string()).optional(),
      creatorTypes: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemType }) => {
      if (!itemType) {
        const types = await client.request<{ itemType: string; localized: string }[]>({ path: '/itemTypes' });
        return ok({ itemTypes: types.data as unknown as Record<string, unknown>[] });
      }

      const [fields, creatorTypes] = await Promise.all([
        client.request<{ field: string }[]>({ path: '/itemTypeFields', query: { itemType } }),
        client.request<{ creatorType: string }[]>({ path: '/itemTypeCreatorTypes', query: { itemType } }),
      ]);

      return ok({
        itemType,
        fields: (fields.data ?? []).map((entry) => entry.field),
        creatorTypes: (creatorTypes.data ?? []).map((entry) => entry.creatorType),
      });
    },
  });
}
