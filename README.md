# zotero-native-mcp

**An MCP server that reads *and writes* your Zotero 10+ library, entirely offline.**

[![Zotero 10+](https://img.shields.io/badge/Zotero-10%2B-CC2936)](https://www.zotero.org/)
[![npm](https://img.shields.io/npm/v/zotero-native-mcp)](https://www.npmjs.com/package/zotero-native-mcp)
[![CI](https://github.com/dvdsosa/zotero-native-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dvdsosa/zotero-native-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect Zotero to Claude, Claude Code, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io)
client. Your assistant can search your library, read PDF full text, create
collections, add references, and attach PDFs from your disk.

Every operation runs against the Zotero application on `127.0.0.1`. **No
zotero.org account. No web API key. No Zotero plugin. No cloud round trip.**

```text
You:     "File that arXiv paper under Thesis > Methods and attach the PDF
          I just downloaded."

Claude:  ✓ created collection "Methods" under "Thesis"
         ✓ added "Attention Is All You Need" (Vaswani et al., 2017)
         ✓ attached transformer.pdf                          … in 180 ms
```

## Why this exists

Zotero 10 added **write support to its built-in local API**. Before that, every
Zotero MCP server had to work around a read-only local endpoint — either by
routing writes through `api.zotero.org` (slow, needs an API key, needs your
library synced to the cloud) or by shipping a separate Zotero plugin you had to
install and keep up to date.

This server uses the native capability directly. Nothing to install inside
Zotero, no credentials to manage, and reads land in **8–60 ms** because nothing
touches the network.

| Criterion | Web API servers | Plugin-based servers | **zotero-native-mcp** |
|---|:---:|:---:|:---:|
| Works offline | ❌ | ✅ | **✅** |
| Needs a zotero.org API key | ✅ required | ❌ | **❌** |
| Needs a Zotero plugin (`.xpi`) | ❌ | ✅ required | **❌** |
| Create collections | ✅ | ✅ | **✅** |
| Attach local PDFs | ⚠️ via cloud | ✅ | **✅** |
| Typical read latency | 500–1500 ms | <50 ms | **8–60 ms** |

## Requirements

- **Zotero 10 or newer**, running. This is a hard floor, not a preference:
  writing through the local API did not exist before Zotero 10. On Zotero 7–9
  the read tools work and every write fails.
- Zotero → **Settings → Advanced** → enable
  **"Allow other applications on this computer to communicate with Zotero"**.
- Node.js 22 or newer. Node 20 reached end of life in April 2026.

## Tested on

Everything below is a statement of *evidence*, not of intent. Other platforms
and clients are expected to work — the server is portable TypeScript talking to
`127.0.0.1`, with nothing platform-specific by design — but they have not been
verified, and this table is the honest extent of it.

| Component | Verified against |
|---|---|
| Operating system | macOS 26.6, Apple Silicon |
| Zotero | 10.0.1 |
| Node.js | 26.8 locally; 22, 24 and 26 in CI |
| MCP client | Claude Code 2.1 |
| Libraries | Personal **and** group — all 28 tools exercised in both |

CI runs the unit and mock-protocol suites across a matrix of **Linux, macOS and
Windows × Node 22, 24 and 26**, so portability of the code itself is covered on
all three platforms. What no runner can cover is the conversation with a real
Zotero, since none is installed there.

**Not yet verified.** A real Zotero on Windows or Linux; Intel Macs; Claude
Desktop, Cursor and other MCP clients.

If you run it somewhere not on this list, a report either way is welcome — those
are the most useful issues this project can receive right now.

## Back up your library first

> [!WARNING]
> **This server can modify and delete items in your Zotero library.** Back it up
> before you start, and keep backing it up.
>
> Deleting is reversible by default: `zotero_delete_items` and
> `zotero_delete_collection` move things to **Zotero's trash**, where you can
> restore them from the Zotero window or with `zotero_restore_items`. But Zotero
> empties that trash automatically after 30 days, and both tools take a
> `permanent: true` that erases outright — no undo, attachment files removed from
> disk, nothing in the API able to bring them back. `zotero_empty_trash` does the
> same to everything already in the trash.
>
> These tools are driven by an assistant interpreting instructions in natural
> language, which can misread which item you meant.
>
> **To back up:** quit Zotero, then copy your whole data directory — `~/Zotero`
> on macOS and Linux, `%USERPROFILE%\Zotero` on Windows, or whatever
> **Settings → Advanced → Files and Folders** reports. It holds `zotero.sqlite`
> and the `storage` folder with every attachment. Zotero's own guidance is at
> [zotero.org/support/zotero_data](https://www.zotero.org/support/zotero_data).
>
> Syncing to zotero.org is **not** a backup: a deletion syncs too.
>
> This software is provided as is, without warranty of any kind, and its authors
> accept no liability for data loss. See [LICENSE](LICENSE).

## Quick start

```bash
claude mcp add zotero-native-mcp -- npx -y zotero-native-mcp
```

<details>
<summary>Other clients (Claude Desktop, Cursor, …)</summary>

```json
{
  "mcpServers": {
    "zotero-native-mcp": {
      "command": "npx",
      "args": ["-y", "zotero-native-mcp"]
    }
  }
}
```
</details>

No environment variables are needed. Ask your assistant to run `zotero_status`
to confirm the connection.

The first time a tool **writes**, Zotero shows a dialog asking whether to allow
it. Choose **"Always Allow"** so you are not asked again.

## Documentation

| Document | What it covers |
|---|---|
| 📚 **[Tutorial](docs/tutorial.md)** | New here? Ten minutes from install to filing a paper with its PDF. |
| 🔧 **[How-to guides](docs/how-to/)** | [Attach PDFs](docs/how-to/attach-pdfs.md) · [Group libraries](docs/how-to/group-libraries.md) · [Migrate from another Zotero MCP](docs/how-to/migrating.md) · [Recover a deletion](docs/how-to/recover-deleted-items.md) · [Troubleshooting](docs/how-to/troubleshooting.md) |
| 📖 **[Reference](docs/reference.md)** | All 28 tools, parameters, outputs, limits, environment variables. |
| 💡 **[Explanation](docs/explanation/)** | [Architecture](docs/explanation/architecture.md) · [Linked vs imported attachments](docs/explanation/attachments.md) · [How authorization works](docs/explanation/authorization.md) |
| 🛠 **[Contributing](docs/CONTRIBUTING.md)** | Development setup, the 72-test suite, and exercising every tool against a live Zotero. |

## Tools at a glance

**Collections** — `list_collections` `get_collection` `create_collection`
`update_collection` `delete_collection` `restore_collection`

**Items** — `search_items` `get_item` `get_item_children` `create_items`
`update_item` `delete_items` `restore_items` `add_items_to_collection`
`remove_items_from_collection` `get_item_fulltext` `export_items`

**Trash** — `list_trash` `empty_trash` (and the `restore_*` tools above)

**Attachments** — `attach_file` `get_attachment_path`

**Discovery** — `list_tags` `list_saved_searches` `run_saved_search`

**System** — `status` `authorize` `list_libraries` `get_item_type_fields`

All names are prefixed `zotero_`. See the **[reference](docs/reference.md)** for
full signatures.

## Prior art

This project is not a fork. It was written from scratch once Zotero 10 made
native local writes possible, but it stands on the shoulders of earlier work
that solved the same problem under tighter constraints:

- **[54yyyu/zotero-mcp](https://github.com/54yyyu/zotero-mcp)** — the most
  widely used Zotero MCP server. Rich feature set including semantic search;
  writes go through `api.zotero.org`.
- **[cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp)** — a Zotero 7
  plugin exposing an MCP endpoint from inside Zotero, with vector search.
- **[Ayanya-0628/zotero-mcp](https://github.com/Ayanya-0628/zotero-mcp)** and
  **[dzackgarza/zotero-local-write-api](https://github.com/dzackgarza/zotero-local-write-api)**
  — local-first writes via a companion `.xpi` write endpoint.
- **[kujenga/zotero-mcp](https://github.com/kujenga/zotero-mcp)** — a lightweight
  Python server for the Zotero API.

If you need Zotero 7/8/9 support, semantic or vector search, or writes to a
library you only have cloud access to, those projects remain the right choice.

## Contributing

Issues and pull requests are welcome. CI must pass on Linux, macOS and Windows
across Node 22, 24 and 26.

See **[CONTRIBUTING](docs/CONTRIBUTING.md)** for the development setup, the test
suite, and the scripts that exercise every tool against a live Zotero.

## License

MIT © David Sosa

---

<sub>Keywords: Zotero MCP server · Model Context Protocol · Zotero Claude
integration · Zotero local API · offline reference manager automation ·
Zotero AI assistant · BibTeX export · academic research tooling · Claude Code
Zotero · Cursor Zotero</sub>
