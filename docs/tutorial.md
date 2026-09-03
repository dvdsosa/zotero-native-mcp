# Tutorial: your first ten minutes

By the end of this lesson you will have connected Zotero to your AI assistant,
granted it permission to write, and used it to file a real paper, metadata and
PDF, into a collection you create along the way.

You need a working Zotero installation and about ten minutes. No prior MCP
knowledge is assumed.

> [!WARNING]
> This lesson creates, modifies and deletes real items in your library. Back up
> your Zotero data directory before starting, see
> [Back up your library first](../README.md#back-up-your-library-first).
> Deleting goes to Zotero's trash and is reversible, but the tools also offer a
> permanent mode that is not.

## Step 1: Check your Zotero version

Open Zotero and go to **Zotero → About Zotero** (macOS) or
**Help → About Zotero** (Windows/Linux).

You need **version 10 or newer**. Earlier versions cannot accept writes from
this server, the tools that read your library would work, but every attempt to
create or change anything would fail.

If you are on an older version, update Zotero before continuing.

## Step 2: Open Zotero's local connection

Zotero only listens for local applications when you ask it to.

1. Go to **Settings → Advanced**.
2. Tick **"Allow other applications on this computer to communicate with
   Zotero"**.

Leave Zotero running. The server talks to the live application, not to your
database files, so Zotero must be open whenever you use these tools.

## Step 3: Connect the server to your assistant

In a terminal, run:

```bash
claude mcp add --scope user zotero-native-mcp -- npx -y zotero-native-mcp
```

`--scope user` matters: without it the server is registered only for the
directory you happened to be in, and it will look like it vanished the moment
you open another folder.

Then start a new session so your assistant picks up the new tools. In an
already-running session, `/mcp` connects it without restarting.

> Using Claude Desktop, Cursor, or another client? Add this to its MCP
> configuration file instead:
>
> ```json
> {
>   "mcpServers": {
>     "zotero-native-mcp": {
>       "command": "npx",
>       "args": ["-y", "zotero-native-mcp"]
>     }
>   }
> }
> ```

## Step 4: Confirm the connection

Ask your assistant:

> Check my Zotero connection status.

It will call `zotero_status` and report something like:

```json
{
  "connected": true,
  "zoteroVersion": "10.0.1",
  "writeAccess": false,
  "personalLibrary": { "type": "user", "id": 11223344, "name": "My Library" },
  "groupLibraries": 1
}
```

Two things to notice. `connected: true` means Zotero answered. `writeAccess:
false` is expected: you have not granted permission yet, and reading never
needs it.

If instead you get a connection error, work through
[Troubleshooting](how-to/troubleshooting.md) before continuing.

## Step 5: Read something

Reading is unrestricted, so try it now:

> Search my Zotero library for papers about neural networks, and show me the
> five most recently modified.

Your assistant calls `zotero_search_items` and answers from your real library.
This is the same search engine Zotero's own search box uses, running against
your local database. Nothing left your machine.

## Step 6: Grant write access

Now ask for something that changes the library:

> Create a Zotero collection called "MCP Tutorial".

**A dialog appears in Zotero**, naming `zotero-native-mcp` and asking whether to
allow the change. It offers three buttons:

- **Allow**: grants a *single* write. The next one asks again.
- **Always Allow**: grants a key that persists.
- **Deny**: refuses.

Choose **Always Allow**. Otherwise you will be interrupted by a dialog on every
write for the rest of this tutorial.

The collection is created. Ask your assistant to list your top-level
collections and you will see it.

> **What just happened?** Zotero issued a local API key and this server stored
> it under `~/.config/zotero-native-mcp/keys.json`. It is unrelated to any
> zotero.org API key and grants access only from this machine. See
> [How authorization works](explanation/authorization.md).

## Step 7: Add a paper

Ask for a reference with real metadata:

> Add a journal article to the "MCP Tutorial" collection: "Attention Is All You
> Need" by Vaswani, Shazeer, Parmar and others, published 2017 in Advances in
> Neural Information Processing Systems.

Your assistant calls `zotero_create_items`. Note that it files the item into the
collection *as it creates it*. There is no separate "move" step.

Open Zotero and look at the "MCP Tutorial" collection. The item is there, with
its creators split into proper author fields.

## Step 8: Attach a PDF

Find any PDF on your disk and note its full path. Then:

> Attach /Users/me/Downloads/attention.pdf to that article.

Substitute your own absolute path, a relative path will be rejected, because
Zotero resolves the path itself and has no idea what directory your assistant
is working in.

The file is attached in **linked** mode by default: Zotero stores the path and
copies nothing, so this is instant no matter how large the PDF is. The
trade-off is that the file must stay where it is.

If you would rather Zotero keep its own copy, so the original can be moved or
deleted, and the attachment syncs to zotero.org, ask for an imported
attachment instead:

> Attach it again, but imported this time.

[Linked vs imported attachments](explanation/attachments.md) explains when each
is the right choice.

## Step 9: Get a citation

Everything is in place, so put it to work:

> Give me the BibTeX for that article.

`zotero_export_items` renders it through Zotero's own translators, so the output
matches what you would get from Zotero's right-click **Export Item** menu, same citation keys, same field mapping.

Ask for `apa` in the `bib` format instead and you get a formatted bibliography
entry rather than a BibTeX record.

## Step 10: Clean up

> Delete the "MCP Tutorial" collection.

Deleting a collection does **not** delete the items inside it. They stay in your
library, and in any other collection they belong to.

The collection goes to Zotero's trash rather than disappearing, so you can undo
this. Try it:

> Restore that collection.

If you also want the article gone, ask for it explicitly. It too goes to the
trash, and "Show me what is in my Zotero trash" lists what can still be brought
back. Only `permanent: true` erases for good, an assistant should not use it
unless you ask.

## What you learned

You connected a local MCP server to Zotero, understood that reads are free while
writes require one-time consent, and completed the core research workflow:
create a collection, add a reference, attach a PDF, export a citation.

## Where to go next

- **[Attach PDFs](how-to/attach-pdfs.md)**: batch-attach a folder of downloads.
- **[Reference](reference.md)**: the full catalogue of all 28 tools.
- **[Architecture](explanation/architecture.md)**: why this server needs no
  plugin and no API key, and what changed in Zotero 10.

---

<p align="center"><a href="../README.md">⬅ <b>Back to the main README</b></a></p>
