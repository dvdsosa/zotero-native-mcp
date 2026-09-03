# How to recover something you deleted

Deleting through this server is reversible by default. What follows depends on
how it was deleted and how long ago.

## If it was deleted normally

It is in Zotero's trash. Ask your assistant:

> Show me what is in my Zotero trash.

Then, having found it:

> Restore "The Structure of Scientific Revolutions" from the trash.

The item returns to the collections it was in, with its attachments and notes
intact.

## If it was a collection

Trashed collections are restorable too, but **they cannot be listed**: Zotero's
local API offers no endpoint for enumerating them, so your assistant cannot go
looking. Two ways round it:

- **You have the key.** `zotero_delete_collection` returns it under `trashed`,
  so it is in the conversation. Ask to restore that key.
- **You do not.** Open Zotero, click **Trash** in the sidebar, and restore it by
  right-clicking. The API limitation does not apply to Zotero's own interface.

## If it was deleted permanently

Nothing in the API can bring it back. `permanent: true` calls Zotero's own erase,
which removes the row and deletes attachment files from disk.

Your options are Zotero's, not this server's:

- **Restore from your backup** — the copy of the data directory you made before
  starting. This is the reason for making one.
- **If you sync with zotero.org**, check the web library at
  [zotero.org/mylibrary](https://www.zotero.org/mylibrary) *before* it syncs
  again. Once the deletion propagates, that copy is gone too.

## If it has been more than 30 days

Zotero empties its own trash automatically after 30 days by default, erasing
what is in it. Anything past that window is in the same position as a permanent
delete: your backup is the only route.

You can change the retention or disable it entirely in Zotero under
**Settings → General**.

## Preventing the problem

- Keep backing up the data directory. It is the only thing that survives a
  permanent delete.
- If an assistant proposes `permanent: true`, ask it why. The default is the
  trash; permanent erasure should only ever happen because you asked for it.
- `zotero_empty_trash` refuses to run unless it is told exactly how many items
  it will erase, so it cannot be triggered by a vague instruction.

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
