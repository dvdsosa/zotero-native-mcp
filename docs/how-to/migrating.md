# How to migrate from another Zotero MCP server

If you already use a Zotero MCP server that talks to `api.zotero.org` or relies
on a Zotero plugin, this guide covers the switch.

## Before you start

Confirm you are on **Zotero 10 or newer** (**Zotero → About Zotero**). This
server cannot work on earlier versions, whereas the server you are leaving
probably can — so check before removing anything.

## Step 1: Add this server alongside the old one

Do not remove anything yet. Run both for a session:

```bash
claude mcp add --scope user zotero-native-mcp -- npx -y zotero-native-mcp
```

Both servers expose tools named `zotero_*`, so your assistant will see two
similar sets. That ambiguity is exactly why this overlap should be brief — treat
it as a verification step, not a steady state.

## Step 2: Verify against your real library

Ask for a few things you know the answers to:

> Using zotero-native-mcp, how many top-level collections do I have, and what
> are they called?

Check the answer against Zotero's sidebar. Then confirm write access works:

> Create a test collection called "migration-check", then delete it.

Approve the Zotero dialog with **Always Allow** when it appears.

## Step 3: Remove the old server

```bash
claude mcp remove <old-server-name>
```

Then clean up what it needed and this server does not:

- **A zotero.org API key** — if it was created solely for that server, revoke it
  at [zotero.org/settings/keys](https://www.zotero.org/settings/keys).
- **Environment variables** — `ZOTERO_API_KEY`, `ZOTERO_LIBRARY_ID`,
  `ZOTERO_LOCAL` and similar are no longer read by anything.
- **A companion Zotero plugin** — if the old server required an `.xpi` write
  endpoint, uninstall it from **Tools → Add-ons**. Leaving it installed keeps an
  unnecessary HTTP endpoint open inside Zotero.

## What changes in practice

| Aspect | Web API server | This server |
|---|---|---|
| Credentials | API key + library ID | None |
| Requires cloud sync | Yes, to see your data | No, reads your local database |
| Works on a plane | No | Yes |
| Read latency | 500–1500 ms | 8–60 ms |
| Write consent | Implicit, via the key | A Zotero dialog, once |
| Batch limits | 50 objects | 50 objects |

## What you may lose

Be aware of features this server does not have. Depending on which server you
are leaving:

- **Semantic or vector search.** Servers such as `54yyyu/zotero-mcp` and
  `cookjohn/zotero-mcp` offer embedding-based search. This server exposes
  Zotero's own keyword search, including full-text mode, but no embeddings.
- **Access to libraries you have not synced locally.** A web API server can
  reach anything your account can see. This one reads what Zotero has on this
  machine.
- **Working while Zotero is closed.** A web API server does not care. This one
  needs the application running.

If any of those matter, keeping both servers registered is legitimate — just
name them distinctly so your assistant can tell them apart.

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
