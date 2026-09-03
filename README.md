# zotero-native-mcp

**An MCP server that reads *and writes* your Zotero library, entirely offline.**

[![npm](https://img.shields.io/npm/v/zotero-native-mcp)](https://www.npmjs.com/package/zotero-native-mcp)
[![CI](https://github.com/dvdsosa/zotero-native-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dvdsosa/zotero-native-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect Zotero to Claude, Claude Code, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io)
client. Your assistant can search your library, read PDF full text, create
collections, add references, and attach PDFs from your disk.

Every operation runs against the Zotero application on `127.0.0.1`. **No
zotero.org account. No web API key. No Zotero plugin. No cloud round trip.**

```
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

| | Web API servers | Plugin-based servers | **zotero-native-mcp** |
|---|:---:|:---:|:---:|
| Works offline | ❌ | ✅ | **✅** |
| Needs a zotero.org API key | ✅ required | ❌ | **❌** |
| Needs a Zotero plugin (`.xpi`) | ❌ | ✅ required | **❌** |
| Create collections | ✅ | ✅ | **✅** |
| Attach local PDFs | ⚠️ via cloud | ✅ | **✅** |
| Typical read latency | 500–1500 ms | <50 ms | **8–60 ms** |

## Requirements

- **Zotero 10 or newer**, running. Earlier versions have a read-only local API;
  write tools will not work.
- Zotero → **Settings → Advanced** → enable
  **"Allow other applications on this computer to communicate with Zotero"**.
- Node.js 20+.

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

| | |
|---|---|
| 📚 **[Tutorial](docs/tutorial.md)** | New here? Ten minutes from install to filing a paper with its PDF. |
| 🔧 **[How-to guides](docs/how-to/)** | [Attach PDFs](docs/how-to/attach-pdfs.md) · [Group libraries](docs/how-to/group-libraries.md) · [Migrate from another Zotero MCP](docs/how-to/migrating.md) · [Troubleshooting](docs/how-to/troubleshooting.md) |
| 📖 **[Reference](docs/reference.md)** | All 24 tools, parameters, outputs, limits, environment variables. |
| 💡 **[Explanation](docs/explanation/)** | [Architecture](docs/explanation/architecture.md) · [Linked vs imported attachments](docs/explanation/attachments.md) · [How authorization works](docs/explanation/authorization.md) |

## Tools at a glance

**Collections** — `list_collections` `get_collection` `create_collection`
`update_collection` `delete_collection`

**Items** — `search_items` `get_item` `get_item_children` `create_items`
`update_item` `delete_items` `add_items_to_collection`
`remove_items_from_collection` `get_item_fulltext` `export_items`

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

Issues and pull requests are welcome. CI runs `npm run typecheck`,
`npm run build` and `npm test`; all three must pass.

### Development

```bash
npm install
npm run build       # compile to build/
npm run watch       # compile on change
npm run typecheck   # tsc --noEmit
npm test            # the full suite
npm run inspect     # build, then open the MCP Inspector
```

### Tests

`npm test` runs 56 tests on `node:test`, with no test framework to install.

| Suite | Covers |
|---|---|
| `test/format.test.mjs` | Response shaping and pagination arithmetic |
| `test/config.test.mjs` | Environment parsing and defaults |
| `test/keystore.test.mjs` | Key persistence, `0600` permissions, corrupt stores |
| `test/client.test.mjs` | The wire protocol, against a mock Zotero |
| `test/integration.test.mjs` | The real server over stdio, against a live Zotero |

`test/helpers/mock-zotero.mjs` reproduces the `Zotero-Server-ID` handshake and
local API keys, so the protocol is exercised in CI with no Zotero installed.
The integration suite skips itself when Zotero is unreachable, which is why CI
stays green on a runner.

Two checks need a real Zotero and so are not part of `npm test`:

```bash
node scripts/smoke.mjs read    # read tools end to end
node scripts/smoke.mjs write   # write path; needs a consent dialog, cleans up after itself
```

### Evaluating tool descriptions

[`evaluation/evaluation.xml`](evaluation/evaluation.xml) holds 12 question and
answer pairs for checking whether a model can actually drive these tools to a
correct answer — a test of the tool *descriptions* rather than the code. Run it
with the harness from Anthropic's `mcp-builder` skill, pointed at any
Anthropic-compatible endpoint. See [`.env.example`](.env.example) for the
variables it reads.

## License

MIT © David Sosa

---

<sub>Keywords: Zotero MCP server · Model Context Protocol · Zotero Claude
integration · Zotero local API · offline reference manager automation ·
Zotero AI assistant · BibTeX export · academic research tooling · Claude Code
Zotero · Cursor Zotero</sub>
