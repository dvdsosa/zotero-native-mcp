# Reference

Technical description of every tool, parameter and setting. For task-oriented
instructions see the [how-to guides](how-to/); to learn the basics start with
the [tutorial](tutorial.md).

## Conventions

**Object keys** are exactly 8 uppercase letters and digits, e.g. `ABCD1234`.
They are scoped to a single library: the same key may exist in your personal
library and in a group, referring to different objects.

**`groupId`** appears on every tool. Omit it to act on the personal library
("My Library"); pass a numeric group ID from `zotero_list_libraries` to act on a
group.

**`verbose`** appears on read tools. `false` (the default) flattens Zotero's
envelope to the fields that carry meaning. `true` returns the raw API envelope
including the `library` block and self/alternate `links`, which costs
substantially more tokens.

**Paging.** List tools accept `limit` (1–500, default 50) and `start`, and
return `totalResults`, `returned`, `start`, `hasMore` and `nextStart`. When `hasMore` is
`false` there is nothing more to fetch, and `nextStart` is `null`.

**Versions.** Tools that modify an object accept `expectedVersion`. Omit it and
the current version is read automatically, making the change a single call. Pass
it to get true optimistic concurrency: the write fails with a conflict if the
object changed since you read it.

**Batch limits.** Zotero caps writes and deletes at **50 objects per call**.

**Annotations.** Each tool below is marked *read-only*, *write*, or
*destructive*, matching the MCP annotations the server advertises. The
*destructive* ones can erase data irreversibly, back up your library before
using them, as described in
[Back up your library first](../README.md#back-up-your-library-first).

**The trash.** Deleting is reversible unless you ask otherwise.
`zotero_delete_items` and `zotero_delete_collection` move objects to Zotero's
trash by default, and `zotero_restore_items` / `zotero_restore_collection` bring
them back. Passing `permanent: true` erases instead, which nothing can undo.
Zotero purges its own trash after 30 days by default, so "reversible" means
reversible for about a month.

---

## System

### `zotero_status` · read-only

Connection and capability check. Call this first when anything else misbehaves.

No parameters.

Returns `connected`, `baseUrl`, `zoteroVersion`, `apiVersion`,
`schemaVersion`, `serverId`, `writeAccess`, `appName`, `personalLibrary`,
`groupLibraries`.

`writeAccess: false` simply means no key has been granted yet; reads work
regardless.

### `zotero_authorize` · write

Requests a local API key, raising a consent dialog inside Zotero.

No parameters.

Returns `authorized`, `persistent`, `message`.

`persistent: true` means the user chose **Always Allow** and the key is stored.
`false` means **Allow**: the key is consumed by the next write, and a new
dialog will follow. Write tools re-authorize on their own when they meet a
`401`, so calling this directly is only needed to grant access deliberately up
front. See [How authorization works](explanation/authorization.md).

### `zotero_list_libraries` · read-only

Lists the personal library and every group library available locally.

No parameters.

Returns `personalLibrary` and `groups`. Each group carries `groupId`, `name`,
`description` and `numItems`: Zotero's local API exposes no permission or
ownership data.

### `zotero_get_item_type_fields` · read-only

Describes an item type, or lists all types.

| Parameter | Type | Notes |
|---|---|---|
| `itemType` | string | e.g. `journalArticle`. Omit to list every type. |

Returns `itemTypes` when `itemType` is omitted; otherwise `itemType`, `fields`
and `creatorTypes`.

Call this before creating an unfamiliar item type. Zotero rejects a write
outright if it carries a field the type does not define.

---

## Collections

### `zotero_list_collections` · read-only

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `scope` | `all` \| `top` \| `children` | `all` | `all` returns every collection flat, each with its `parentCollection`, so the whole tree is reconstructible in one call. |
| `parentKey` | key |, | Required when `scope` is `children`. |
| `groupId`, `limit`, `start`, `verbose` | | | |

Returns paging fields plus `collections`.

### `zotero_get_collection` · read-only

| Parameter | Type | Notes |
|---|---|---|
| `collectionKey` | key | **Required.** |
| `groupId`, `verbose` | | |

Returns `collection`.

### `zotero_create_collection` · write

| Parameter | Type | Notes |
|---|---|---|
| `collections` | array | **Required.** 1–50 entries of `{ name, parentCollectionKey? }`. Omit `parentCollectionKey` to create at the library root. |
| `groupId` | integer | |

Returns `created`, `failures`, `libraryVersion`.

Building a nested tree takes one call per level, because a child needs its
parent's key. Always check `failures`: Zotero validates each entry
independently, so some may succeed while others fail.

### `zotero_update_collection` · write, idempotent

| Parameter | Type | Notes |
|---|---|---|
| `collectionKey` | key | **Required.** |
| `name` | string | Omit to leave unchanged. |
| `parentCollectionKey` | key \| `null` | `null` moves it to the library root. Omit to leave unchanged. |
| `expectedVersion` | integer | |
| `groupId` | integer | |

Returns `updated`, `collectionKey`, `libraryVersion`. At least one of `name` or
`parentCollectionKey` is required.

### `zotero_delete_collection` · write, **destructive**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `collectionKeys` | array | | **Required.** Up to 50 keys. |
| `permanent` | boolean | `false` | `false` moves them to the trash; `true` erases them. |
| `groupId` | integer | | |

Returns `permanent`, `trashed`, `erased`, `notFound`, `libraryVersion`.

Items inside are **never** deleted either way. They stay in the library and in
any other collection they belong to. Subcollections follow their parent.

Record the keys when trashing: the local API cannot list trashed collections, so
a key is the only way to find one again from here.

### `zotero_restore_collection` · write, idempotent

| Parameter | Type | Notes |
|---|---|---|
| `collectionKeys` | array | **Required.** Up to 50 keys. |
| `groupId` | integer | |

Returns `restored`, `notFound`.

Undoes a non-permanent `zotero_delete_collection`. You must already know the
key, trashed collections cannot be discovered through the local API, though the
user can see them in Zotero's own trash.

---

## Items

### `zotero_search_items` · read-only

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `q` | string |, | Quicksearch text. Omit to browse. |
| `qmode` | `titleCreatorYear` \| `everything` | `titleCreatorYear` | `everything` also searches attachment full text and notes; slower. |
| `itemType` | string |, | Zotero syntax: `book`, `book \|\| journalArticle`, `-attachment`. |
| `tag` | string |, | Same syntax: `tag1 \|\| tag2`, leading `-` excludes. |
| `collectionKey` | key |, | Restrict to one collection. |
| `topLevelOnly` | boolean | `true` | `false` includes child notes and attachments. |
| `includeTrashed` | boolean | `false` | |
| `since` | integer |, | Only objects modified after this library version. |
| `sort` | enum | `dateModified` | `dateAdded`, `dateModified`, `title`, `creator`, `itemType`, `date`, `publisher`, `publicationTitle`. |
| `direction` | `asc` \| `desc` | `desc` | |
| `groupId`, `limit`, `start`, `verbose` | | | |

Returns paging fields plus `items`.

### `zotero_get_item` · read-only

| Parameter | Type | Default |
|---|---|---|
| `itemKey` | key | **Required.** |
| `includeChildren` | boolean | `false` |
| `groupId`, `verbose` | | |

Returns `item`, and `children` when requested. Setting `includeChildren` is the
quickest way to find the attachment key needed to read a PDF.

### `zotero_get_item_children` · read-only

| Parameter | Type | Notes |
|---|---|---|
| `itemKey` | key | **Required.** |
| `groupId`, `limit`, `start`, `verbose` | | |

Returns paging fields plus `children`: notes, attachments and annotations.

### `zotero_create_items` · write

| Parameter | Type | Notes |
|---|---|---|
| `items` | array | **Required.** 1–50 Zotero item objects. |
| `groupId` | integer | |

Each item takes `itemType` (required) plus any field valid for that type.
Documented fields: `title`, `creators`, `tags`, `collections`, `parentItem`.

- `creators`: `{ creatorType, firstName, lastName }` or `{ creatorType, name }`
  for institutions.
- `tags`: `{ tag, type? }`; `type: 1` marks an automatic tag.
- `collections`: array of collection keys, files the item at creation time,
  which is cheaper than creating then moving.
- `parentItem`: for notes and attachments.

Returns `created`, `failures`, `libraryVersion`.

To attach a file from disk use `zotero_attach_file`, which handles the whole
attachment protocol.

### `zotero_update_item` · write, idempotent

| Parameter | Type | Notes |
|---|---|---|
| `itemKey` | key | **Required.** |
| `fields` | object | **Required.** Zotero item JSON; only these fields change. |
| `expectedVersion` | integer | |
| `groupId` | integer | |

Returns `updated`, `itemKey`, `libraryVersion`.

Array fields are **replaced wholesale**. To change collection membership prefer
`zotero_add_items_to_collection` / `zotero_remove_items_from_collection`, which
merge rather than overwrite.

`zotero_delete_items` is the better way to trash an item; this works too, via
`{"deleted": true}`.

### `zotero_delete_items` · write, **destructive**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `itemKeys` | array | | **Required.** Up to 50 keys. |
| `permanent` | boolean | `false` | `false` moves the items to the trash; `true` erases them. |
| `groupId` | integer | | |

Returns `permanent`, `trashed`, `erased`, `alreadyInTrash`, `notFound`,
`libraryVersion`.

With the default, items go to Zotero's trash: they vanish from normal views but
keep their children and files, and `zotero_restore_items` brings them back.
Zotero purges the trash after 30 days by default.

With `permanent: true` the items are erased outright. Child notes and
attachments go with them, stored attachment files are deleted from disk, and
nothing can undo it. Only pass it when the user has asked for exactly that.

### `zotero_restore_items` · write, idempotent

| Parameter | Type | Notes |
|---|---|---|
| `itemKeys` | array | **Required.** Up to 50 keys. |
| `groupId` | integer | |

Returns `restored`, `wereNotInTrash`, `notFound`.

Takes items back out of the trash, returning them to their collections. Works
only while they are still there: an item erased permanently, or purged by
Zotero's 30-day retention, is unrecoverable.

### `zotero_list_trash` · read-only

| Parameter | Type | Notes |
|---|---|---|
| `groupId`, `limit`, `start`, `verbose` | | |

Returns paging fields plus `items`.

Lists what `zotero_restore_items` can bring back. Trashed **collections** do not
appear: Zotero's local API has no endpoint to enumerate them, so a trashed
collection can only be restored by key or from the Zotero window.

### `zotero_empty_trash` · write, **destructive**

| Parameter | Type | Notes |
|---|---|---|
| `expectedCount` | integer | **Required.** How many items you expect to erase. |
| `groupId` | integer | |

Returns `erased`, `libraryVersion`.

Permanently erases everything in the trash. `expectedCount` is an interlock: it
must equal the trash's actual size, so call `zotero_list_trash` first and pass
its `totalResults`. A mismatch aborts the call and deletes nothing, which is what
stops this from ever running on a trash nobody has looked at.

### `zotero_add_items_to_collection` · write, idempotent

| Parameter | Type | Notes |
|---|---|---|
| `itemKeys` | array | **Required.** Up to 50 keys. |
| `collectionKey` | key | **Required.** |
| `groupId` | integer | |

Returns `collectionKey`, `added`, `alreadyPresent`.

Adds rather than moves: an item can belong to any number of collections, and
existing membership is preserved. Items already present cost no write.

### `zotero_remove_items_from_collection` · write, idempotent

Same parameters. Returns `collectionKey`, `removed`, `notPresent`.

Items stay in the library and in every other collection. Nothing is deleted.

### `zotero_get_item_fulltext` · read-only

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `itemKey` | key | | **Required.** An attachment key, or a parent key to search its attachments. |
| `maxCharacters` | integer | `50000` | 100–500 000. |
| `groupId` | integer | | |

Returns `attachmentKey`, `content`, `truncated`, `totalCharacters`,
`indexedPages`, `totalPages`.

Text comes from Zotero's index, so it exists only for attachments Zotero has
indexed, a scanned PDF without OCR has none. Fall back to
`zotero_get_attachment_path`.

### `zotero_export_items` · read-only

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `itemKeys` | array | | **Required.** Up to 100 keys. |
| `format` | enum | `bibtex` | `bibtex`, `biblatex`, `ris`, `csljson`, `csv`, `tei`, `mods`, `refer`, `coins`, `bib`. |
| `style` | string | `apa` | For `bib` only, e.g. `ieee`, `chicago-note-bibliography`. |
| `locale` | string | `en-US` | For `bib` only. |
| `groupId` | integer | | |

Returns `format`, `itemCount`, `skippedKeys`, `output`.

`bib` renders a formatted bibliography; every other format is a machine-readable
export. Keys that are not top-level items (attachments, notes) have no citation
form and are reported in `skippedKeys` rather than silently dropped.

---

## Attachments

### `zotero_attach_file` · write

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `filePath` | string | | **Required. Must be absolute.** |
| `parentItemKey` | key |, | Omit for a standalone attachment. |
| `mode` | `linked` \| `imported` | `linked` | See below. |
| `title` | string | file name | |
| `collections` | array |, | Standalone attachments only. |
| `tags` | array of strings |, | |
| `groupId` | integer | | |

Returns `attachmentKey`, `mode`, `filePath`, `contentType`, `bytes`, `uploaded`,
`attachment`.

- **`linked`**: Zotero records the path. Instant at any size, nothing copied,
  the file must stay put, and it does not sync to zotero.org. **Personal library
  only**: Zotero rejects linked files in group libraries, because the path would
  be a broken reference for every other member. Passing `groupId` with
  `mode: "linked"` is refused before the request is sent.
- **`imported`**: Zotero copies the file into its storage directory, so the
  original can move and the attachment syncs. Capped at 4 GB. This is the only
  mode a group library accepts.

`uploaded` is `false` for linked files and for imported files Zotero recognised
as already present. Child attachments cannot belong to collections, so passing
both `parentItemKey` and `collections` is an error. See
[Linked vs imported attachments](explanation/attachments.md).

### `zotero_get_attachment_path` · read-only

| Parameter | Type | Notes |
|---|---|---|
| `itemKey` | key | **Required.** An attachment key, or a parent key for all its attachments. |
| `groupId` | integer | |

Returns `attachments`, each with `attachmentKey`, `title`, `linkMode`,
`contentType` and `path`.

Works for both linked and imported attachments. `path` is `null` for
`linked_url` attachments, which are bookmarks rather than files.

---

## Discovery

### `zotero_list_tags` · read-only

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `q` | string |, | Filter by text. |
| `qmode` | `contains` \| `startsWith` | `contains` | Ignored without `q`. |
| `collectionKey` | key |, | Only tags used within this collection. |
| `groupId`, `limit`, `start` | | | |

Returns paging fields plus `tags`, each with `tag`, `automatic` and `numItems`.

### `zotero_list_saved_searches` · read-only

Parameters: `groupId`, `limit`, `start`, `verbose`.

Returns paging fields plus `searches`, including their conditions.

### `zotero_run_saved_search` · read-only

| Parameter | Type | Notes |
|---|---|---|
| `searchKey` | key | **Required.** From `zotero_list_saved_searches`. |
| `groupId`, `limit`, `start`, `verbose` | | |

Returns paging fields plus `items`.

Executing a saved search is something the zotero.org web API cannot do; the
local API runs it through Zotero's own engine, so results match the UI.

---

## Environment variables

All optional. A stock Zotero install needs none.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_LOCAL_PORT` | `23119` | Zotero's local server port. |
| `ZOTERO_LOCAL_BASE_URL` | `http://127.0.0.1:<port>` | Full base URL override. |
| `ZOTERO_LOCAL_APP_NAME` | `zotero-native-mcp` | Name shown in the consent dialog. |
| `ZOTERO_LOCAL_AUTO_AUTHORIZE` | `true` | `false` requires explicit `zotero_authorize`. |
| `ZOTERO_LOCAL_API_KEY` |, | Pre-provisioned key, bypassing the key store. |
| `ZOTERO_LOCAL_KEY_STORE` | `~/.config/zotero-native-mcp/keys.json` | Key store path. |
| `ZOTERO_LOCAL_TIMEOUT_MS` | `60000` | Per-request timeout. |

## Error codes

Errors carry a remediation hint alongside the message.

| Status | Meaning | Action |
|---|---|---|
| `400` | Zotero rejected the body or parameters | Check field names against `zotero_get_item_type_fields`. |
| `401` | No valid local API key | `zotero_authorize`; choose **Always Allow**. |
| `403` | Local API disabled, or read-only library | Enable the setting, or check group permissions. |
| `404` | Key not found **in this library** | Verify `groupId`: keys are library-scoped. |
| `409` | Zotero busy (sync or transaction) | Retry in a few seconds. |
| `412` | Version conflict, or instance mismatch | Re-read the object and resend with the current version. |
| `413` | Batch too large | Split into chunks of 50. |
| `428` | Missing precondition | Call `zotero_status` to re-sync client state. |
| `429` | Too many authorization prompts | Wait for `Retry-After`; approve with **Always Allow**. |
| `500` | Zotero internal error | See **Help → Debug Output Logging**. |

## Limits

Properties of Zotero's local API, not of this server:

- Batch writes and deletes: **50 objects** per call.
- `zotero_export_items`: 100 keys per call.
- Imported attachments: **4 GB** maximum.
- Authorization prompts: 5 per minute.
- Group metadata is minimal, no permissions or ownership.
- Full text covers only what Zotero has indexed.
- Atom output is unsupported; quicksearch ranking may differ slightly from the
  web API's.

---

<p align="center"><a href="../README.md">⬅ <b>Back to the main README</b></a></p>
