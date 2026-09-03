# zotero-native-mcp

An MCP server for Zotero that runs entirely on `127.0.0.1`.

Every operation — reads *and* writes — is served by the Zotero application
itself over its local HTTP API. There is no zotero.org account, no web API key,
no network round trip, no rate limit, and no Zotero plugin to install.

## Why this exists

Zotero 7.1 shipped a complete local implementation of the Zotero Web API v3 at
`http://127.0.0.1:23119/api`, and unlike the read-only local endpoint that
preceded it, **it accepts writes**. That makes the older architectures for
local Zotero tooling unnecessary:

| Approach | Local | Writes | Extra moving parts |
| :--- | :---: | :---: | :--- |
| MCP over `api.zotero.org` | ❌ | ✅ | API key, cloud latency (~0.5–1.5 s) |
| Zotero `.xpi` plugin exposing its own endpoint | ✅ | ✅ | A plugin to build, install and keep current with Zotero |
| Hybrid daemon + write connector | ✅ | ✅ | A second process outside Zotero |
| **This server, over the built-in local API** | ✅ | ✅ | **None** |

Measured against a ~2000-item library: reads 8–60 ms, search 100–300 ms.

## Requirements

- **Zotero 7.1 or newer**, running. (Developed against Zotero 10.)
- Zotero → Settings → Advanced → **"Allow other applications on this computer to
  communicate with Zotero"** enabled.
- Node.js 20+.

## Install

```bash
npm install
npm run build
```

Register it with an MCP client. For Claude Code:

```bash
claude mcp add zotero-native-mcp -- node /absolute/path/to/build/index.js
```

Or by hand, in an MCP client config:

```json
{
  "mcpServers": {
    "zotero-native-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/build/index.js"]
    }
  }
}
```

No environment variables are needed on a stock install.

## Authorization

Reads need no authorization. The first **write** raises a modal dialog inside
Zotero offering *Allow* (a single-use key), *Always Allow* (a persistent key),
and *Deny*. Choosing *Always Allow* stores a key under
`~/.config/zotero-native-mcp/keys.json` (mode `0600`), keyed by Zotero instance,
and it is reused from then on.

A single-use key is consumed by the write that validates it, so the server
re-authorizes transparently when it sees a `401` — which is why a session that
picked *Allow* will keep raising dialogs. Call `zotero_authorize` up front to
grant access deliberately rather than being interrupted mid-task.

## Tools

**Connection and schema**
| Tool | Purpose |
| :--- | :--- |
| `zotero_status` | Connection, Zotero version, instance ID, write-access state |
| `zotero_authorize` | Request write access (raises the consent dialog) |
| `zotero_list_libraries` | Personal library plus group libraries and their IDs |
| `zotero_get_item_type_fields` | Valid fields and creator types for an item type |

**Collections**
| Tool | Purpose |
| :--- | :--- |
| `zotero_list_collections` | Flat tree, top level, or children of one collection |
| `zotero_get_collection` | One collection with its version |
| `zotero_create_collection` | Create collections and subcollections (≤50/call) |
| `zotero_update_collection` | Rename, or re-parent (`parentCollectionKey: null` → root) |
| `zotero_delete_collection` | Delete collections; contained items survive |

**Items**
| Tool | Purpose |
| :--- | :--- |
| `zotero_search_items` | Quicksearch with `everything` mode, plus type/tag/collection filters |
| `zotero_get_item` | One item, optionally with its children |
| `zotero_get_item_children` | Child notes, attachments and annotations |
| `zotero_create_items` | Create items (≤50/call), filed into collections at creation |
| `zotero_update_item` | Patch fields with optimistic concurrency |
| `zotero_delete_items` | Permanent delete (bypasses the trash) |
| `zotero_add_items_to_collection` | File items, **merging** with existing membership |
| `zotero_remove_items_from_collection` | Unfile items without deleting them |
| `zotero_get_item_fulltext` | Zotero's indexed attachment text |
| `zotero_export_items` | BibTeX, BibLaTeX, RIS, CSL-JSON, CSV, TEI, or a rendered bibliography |

**Attachments**
| Tool | Purpose |
| :--- | :--- |
| `zotero_attach_file` | Attach a local file, linked or imported |
| `zotero_get_attachment_path` | Resolve an attachment to its absolute path on disk |

**Tags and saved searches**
| Tool | Purpose |
| :--- | :--- |
| `zotero_list_tags` | Tags, optionally scoped to a collection |
| `zotero_list_saved_searches` | Saved searches and their conditions |
| `zotero_run_saved_search` | Execute one — something the web API cannot do |

## Attachment modes

`zotero_attach_file` takes `mode`:

- **`linked`** (default) — Zotero records the path. Instant for any file size,
  nothing is copied, and the file must stay where it is. Linked files do not
  sync to zotero.org.
- **`imported`** — Zotero takes its own copy into its storage directory, so the
  original can move or be deleted and the attachment syncs. This runs the Zotero
  API's three-phase upload protocol (authorize → transfer → register), all of it
  over loopback; where the web API would hand the bytes to S3, Zotero receives
  them itself.

## Configuration

All optional.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ZOTERO_LOCAL_PORT` | `23119` | Zotero's local server port |
| `ZOTERO_LOCAL_BASE_URL` | `http://127.0.0.1:<port>` | Full base URL override |
| `ZOTERO_LOCAL_APP_NAME` | `zotero-native-mcp` | Name shown in the consent dialog |
| `ZOTERO_LOCAL_AUTO_AUTHORIZE` | `true` | Set `false` to require explicit `zotero_authorize` |
| `ZOTERO_LOCAL_API_KEY` | — | Pre-provisioned local key, bypassing the key store |
| `ZOTERO_LOCAL_KEY_STORE` | `~/.config/zotero-native-mcp/keys.json` | Key store path |
| `ZOTERO_LOCAL_TIMEOUT_MS` | `60000` | Per-request timeout |

## Development

```bash
npm run typecheck            # tsc --noEmit
npm run build                # compile to build/
npm run inspect              # build, then open the MCP Inspector
node scripts/smoke.mjs read  # read-only end-to-end check against a live Zotero
node scripts/smoke.mjs write # write path; creates and then deletes test data
```

`evaluation/evaluation.xml` holds question/answer pairs for exercising the
server against a real library.

## Known limits

These are properties of Zotero's local API, not of this server:

- Batch writes and deletes cap at **50 objects** per call.
- Group metadata is minimal: names and item counts only, no permissions or
  ownership (those live on zotero.org).
- Full text is whatever **Zotero has indexed**; a scanned PDF without OCR has
  none. Fall back to `zotero_get_attachment_path` and read the file directly.
- Atom output is not supported, and quicksearch ranking can differ slightly from
  the web API's.
