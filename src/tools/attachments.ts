/**
 * Attaching local files to Zotero items.
 *
 * Two link modes, with genuinely different semantics:
 *
 *   linked    Zotero stores a path. Nothing is copied, the operation is
 *             instant regardless of file size, and the file must stay where it
 *             is. Linked files do not sync to zotero.org.
 *   imported  Zotero takes its own copy into the storage directory, so the
 *             original can move or be deleted, and the attachment syncs.
 *
 * "imported" goes through the Zotero API's three-phase upload protocol:
 * create the attachment item, authorize the upload (md5/filename/filesize/
 * mtime), post the bytes, then register the upload. All three phases stay on
 * loopback, the web API's S3 step is served by Zotero itself here.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ZoteroLocalClient, libraryPrefix } from '../client.js';
import { ZoteroInputError } from '../errors.js';
import { ZoteroEnvelope, ok } from '../format.js';
import { defineTool, groupIdParam, libraryOf, objectKey, zoteroObject } from './shared.js';

/** Content types Zotero cares about; anything else falls back to octet-stream. */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

function guessContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

interface WriteResults {
  successful?: Record<string, ZoteroEnvelope>;
  failed?: Record<string, { key?: string; code: number; message: string }>;
}

interface UploadAuthorization {
  exists?: number;
  url?: string;
  uploadKey?: string;
}

async function describeFile(filePath: string) {
  if (!isAbsolute(filePath)) {
    throw new ZoteroInputError(
      `filePath must be absolute, got "${filePath}".`,
      'Zotero resolves the path itself and has no notion of this process\'s working directory. ' +
        `Try "${resolve(filePath)}" if that is what was meant.`,
    );
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new ZoteroInputError(
      `No such file: ${filePath}`,
      'Check the path exists and is readable. For a file inside a cloud-synced folder, make sure it ' +
        'has been downloaded locally rather than left as a placeholder.',
    );
  }
  if (!info.isFile()) {
    throw new ZoteroInputError(`${filePath} is a directory, not a file.`);
  }
  return info;
}

export function registerAttachmentTools(server: McpServer, client: ZoteroLocalClient): void {
  defineTool(server, {
    name: 'zotero_attach_file',
    title: 'Attach a local file',
    description:
      'Attach a file from disk to a Zotero item, or add it as a standalone attachment. mode="linked" ' +
      '(default) records the path only: instant for any file size, but the file must stay put and ' +
      'the attachment does not sync to zotero.org. mode="imported" copies the file into Zotero\'s ' +
      'storage, so it syncs and survives the original being moved. Group libraries accept only ' +
      '"imported", since a local path means nothing to other members. filePath must be absolute. ' +
      'Pass parentItemKey to hang the file off an existing reference; omit it for a standalone ' +
      'attachment, optionally filed into collections.',
    inputSchema: {
      filePath: z
        .string()
        .min(1)
        .describe('Absolute path to the file on this machine, e.g. "/Users/me/papers/smith-2024.pdf".'),
      parentItemKey: objectKey
        .optional()
        .describe('Item this file belongs to. Omit to create a standalone attachment item.'),
      mode: z
        .enum(['linked', 'imported'])
        .default('linked')
        .describe('"linked" stores the path only (instant, no copy, no sync); "imported" copies the file into Zotero (syncs).'),
      title: z.string().optional().describe('Attachment title shown in Zotero. Defaults to the file name.'),
      collections: z
        .array(objectKey)
        .optional()
        .describe('Collections to file the attachment into. Only valid for standalone attachments (no parentItemKey).'),
      tags: z.array(z.string()).optional().describe('Tags to attach.'),
      groupId: groupIdParam,
    },
    outputSchema: {
      attachmentKey: z.string(),
      mode: z.string(),
      filePath: z.string(),
      contentType: z.string(),
      bytes: z.number(),
      uploaded: z.boolean().describe('True when file bytes were transferred; false for linked files and deduplicated uploads.'),
      attachment: zoteroObject,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ filePath, parentItemKey, mode, title, collections, tags, groupId }) => {
      // A linked file records a path that exists only on this machine, so Zotero
      // refuses one in a shared library. Catch it here rather than after a round
      // trip, since `linked` is the default and would otherwise fail by surprise.
      if (mode === 'linked' && groupId) {
        throw new ZoteroInputError(
          'Zotero does not allow linked files in group libraries.',
          'A linked attachment stores a path that only exists on your machine, so it would be a ' +
            'broken reference for everyone else in the group. Pass mode: "imported" to copy the ' +
            'file into the group instead.',
        );
      }
      if (parentItemKey && collections?.length) {
        throw new ZoteroInputError(
          'A child attachment cannot belong to collections directly.',
          'In Zotero only top-level items are filed into collections. Either drop `collections`, or ' +
            'drop `parentItemKey` to create a standalone attachment.',
        );
      }
      const info = await describeFile(filePath);
      const prefix = libraryPrefix(libraryOf({ groupId }));
      const filename = basename(filePath);
      const contentType = guessContentType(filePath);

      // Zotero caps stored files at 4 GB; fail before reading a huge file into memory.
      if (mode === 'imported' && info.size > 4 * 1024 * 1024 * 1024) {
        throw new ZoteroInputError(
          `File is ${info.size} bytes; Zotero does not support imported files above 4 GB.`,
          'Use mode="linked" instead, which stores only the path and has no size limit.',
        );
      }

      const attachment: Record<string, unknown> = {
        itemType: 'attachment',
        linkMode: mode === 'linked' ? 'linked_file' : 'imported_file',
        title: title ?? filename,
        contentType,
      };
      // Zotero derives a linked file's name from its path and rejects an
      // explicit `filename` for anything but stored files.
      if (mode === 'linked') attachment.path = filePath;
      else attachment.filename = filename;
      if (parentItemKey) attachment.parentItem = parentItemKey;
      if (collections?.length) attachment.collections = collections;
      if (tags?.length) attachment.tags = tags.map((tag) => ({ tag }));

      const creation = await client.request<WriteResults>({
        method: 'POST',
        path: `${prefix}/items`,
        body: [attachment],
      });

      const created = Object.values(creation.data.successful ?? {})[0];
      if (!created?.key) {
        const failure = Object.values(creation.data.failed ?? {})[0];
        throw new ZoteroInputError(
          `Zotero rejected the attachment item: ${failure ? `${failure.code} ${failure.message}` : 'unknown error'}`,
          'Zotero\'s message above is the authoritative reason. Common causes: parentItemKey does not ' +
            'name an existing top-level item in this library (attachments cannot nest under attachments ' +
            'or notes), or a collection key is wrong.',
        );
      }
      const attachmentKey = created.key;

      // Linked files are done: Zotero already has the path, nothing to transfer.
      if (mode === 'linked') {
        return ok({
          attachmentKey,
          mode,
          filePath,
          contentType,
          bytes: info.size,
          uploaded: false,
          attachment: { key: attachmentKey, version: created.version, ...(created.data ?? {}) },
        });
      }

      const bytes = await readFile(filePath);
      const md5 = createHash('md5').update(bytes).digest('hex');
      const filePath_ = `${prefix}/items/${attachmentKey}/file`;

      // Phase 1: authorize. If-None-Match: * asserts no file is registered yet,
      // which is always true for an attachment created moments ago.
      const authorization = await client.request<UploadAuthorization>({
        method: 'POST',
        path: filePath_,
        form: {
          md5,
          filename,
          filesize: info.size,
          // Zotero requires milliseconds and rejects second-precision values.
          mtime: Math.round(info.mtimeMs),
          contentType,
        },
        headers: { 'If-None-Match': '*' },
      });

      if (authorization.data.exists === 1) {
        return ok({
          attachmentKey,
          mode,
          filePath,
          contentType,
          bytes: info.size,
          uploaded: false,
          attachment: { key: attachmentKey, version: created.version, ...(created.data ?? {}) },
        });
      }

      const { url, uploadKey } = authorization.data;
      if (!url || !uploadKey) {
        throw new ZoteroInputError(
          'Zotero authorized the upload but returned no upload URL.',
          'Retry the call; if it keeps happening, use mode="linked" as a fallback, though only ' +
            'in your personal library, since group libraries reject linked files.',
        );
      }

      // Phase 2: transfer the bytes to Zotero's local upload receiver.
      const uploadPath = new URL(url).pathname;
      await client.request<string>({
        method: 'POST',
        path: uploadPath,
        raw: bytes,
        headers: { 'Content-Type': contentType },
        expectText: true,
      });

      // Phase 3: register, which moves the staged file into place.
      await client.request<string>({
        method: 'POST',
        path: filePath_,
        form: { upload: uploadKey },
        headers: { 'If-None-Match': '*' },
        expectText: true,
      });

      const final = await client.request<ZoteroEnvelope>({ path: `${prefix}/items/${attachmentKey}` });
      return ok({
        attachmentKey,
        mode,
        filePath,
        contentType,
        bytes: info.size,
        uploaded: true,
        attachment: { key: attachmentKey, version: final.data.version, ...(final.data.data ?? {}) },
      });
    },
  });

  defineTool(server, {
    name: 'zotero_get_attachment_path',
    title: 'Get an attachment file path',
    description:
      'Resolve an attachment to its absolute path on this machine, so the file can be opened and ' +
      'read directly. Works for both linked and imported attachments. Passing a regular item key ' +
      'returns the paths of all of its file attachments. Use this to read a PDF whose text Zotero ' +
      'has not indexed.',
    inputSchema: {
      itemKey: objectKey.describe('Attachment key, or a parent item key to resolve all of its attachments.'),
      groupId: groupIdParam,
    },
    outputSchema: { attachments: z.array(zoteroObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async ({ itemKey, groupId }) => {
      const prefix = libraryPrefix(libraryOf({ groupId }));

      const resolvePath = async (key: string): Promise<string | null> => {
        // /file/view/url reports the file:// URL Zotero would open, which is
        // the only way to learn where a stored attachment actually lives.
        const response = await client.request<string>({
          path: `${prefix}/items/${key}/file/view/url`,
          expectText: true,
        });
        const raw = response.data.trim();
        if (!raw) return null;
        try {
          // fileURLToPath, not URL.pathname: on Windows the latter yields
          // "/C:/Users/..." with a spurious leading slash, and it does not undo
          // percent-encoding the way a path needs.
          return raw.startsWith('file://') ? fileURLToPath(raw) : raw;
        } catch {
          return raw;
        }
      };

      const describe = async (entry: ZoteroEnvelope) => {
        const data = (entry.data ?? {}) as { itemType?: string; title?: string; linkMode?: string; contentType?: string };
        if (data.itemType !== 'attachment') return null;
        const linked = data.linkMode === 'linked_url';
        return {
          attachmentKey: entry.key,
          title: data.title ?? null,
          linkMode: data.linkMode ?? null,
          contentType: data.contentType ?? null,
          // A linked_url attachment is a bookmark, not a file; it has no path.
          path: linked || !entry.key ? null : await resolvePath(entry.key),
        };
      };

      const item = await client.request<ZoteroEnvelope>({ path: `${prefix}/items/${itemKey}` });
      const itemType = ((item.data.data ?? {}) as { itemType?: string }).itemType;

      if (itemType === 'attachment') {
        const described = await describe(item.data);
        return ok({ attachments: described ? [described] : [] });
      }

      const children = await client.request<ZoteroEnvelope[]>({ path: `${prefix}/items/${itemKey}/children` });
      const attachments = (await Promise.all((children.data ?? []).map(describe))).filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      );

      if (attachments.length === 0) {
        throw new ZoteroInputError(
          `Item ${itemKey} has no file attachments.`,
          'Use zotero_get_item_children to see what it does have, or zotero_attach_file to add a file.',
        );
      }
      return ok({ attachments });
    },
  });
}
