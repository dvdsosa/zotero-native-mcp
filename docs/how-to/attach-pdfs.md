# How to attach PDFs to references

## Attach one PDF to an existing reference

Give your assistant the absolute path and the item it belongs to:

> Attach /Users/me/Downloads/vaswani-2017.pdf to the "Attention Is All You Need"
> item in Zotero.

The path **must be absolute**. Zotero resolves it itself and has no notion of
the working directory your assistant runs in.

## Choose linked or imported

By default the file is **linked**: Zotero stores the path, copies nothing, and
the operation is instant regardless of file size. Ask explicitly for the other
mode when you need it:

> Attach it as an imported file so Zotero keeps its own copy.

| Aspect | linked (default) | imported |
|---|---|---|
| Speed | Instant, any size | Proportional to file size |
| Original file | Must stay put | Can be moved or deleted |
| Syncs to zotero.org | No | Yes |
| Disk usage | None | A second copy |

See [Linked vs imported attachments](../explanation/attachments.md) for the
reasoning behind the choice.

## Attach a whole folder of downloads

Ask for the batch and let the assistant match files to references:

> I have a folder of PDFs at /Users/me/Downloads/papers. For each one, find the
> matching reference in my Zotero library by title and attach the PDF to it.
> Tell me which ones you could not match.

The assistant will search for each title with `zotero_search_items` and call
`zotero_attach_file` per match. Ask it to report unmatched files rather than
guessing, a wrong attachment is more annoying to undo than a missing one.

## Create a reference and attach its PDF in one go

When the paper is not yet in your library:

> Add "Deep Residual Learning for Image Recognition" by He, Zhang, Ren and Sun
> (CVPR 2016) to my "Vision" collection, then attach
> /Users/me/Downloads/resnet.pdf to it.

This runs `zotero_create_items` (with the collection set at creation time) and
then `zotero_attach_file` against the returned key.

## Attach a standalone file, with no parent reference

Omit the parent and the attachment becomes a top-level item, which means it can
be filed into collections directly:

> Add /Users/me/Documents/lab-protocol.pdf to my Zotero "Protocols" collection
> as a standalone attachment.

Child attachments cannot belong to collections, only top-level items can, so
the server will reject a request that asks for both a parent item and
collections.

## Read a PDF your assistant cannot otherwise see

Two routes, in order of preference:

> Get me the full text of that paper's PDF.

This uses `zotero_get_item_fulltext`, returning the text **Zotero has already
indexed**. It is fast and costs no extra file access.

When Zotero has no index for the file, a scanned PDF without OCR, or one added
seconds ago, fall back to the path:

> Get the file path of that attachment and read it directly.

`zotero_get_attachment_path` returns the absolute path on disk, which your
assistant can then open with its own file tools.

## Troubleshooting

**"filePath must be absolute"**: you passed a relative path. The error message
includes the resolved absolute path it guessed; check it is what you meant.

**"No such file"**: the path is wrong, or the file lives in a cloud-synced
folder (iCloud Drive, Dropbox) and has not been downloaded locally. Open it once
in Finder to materialise it.

**"Attachment filename can only be set for stored files"**: you should not see
this; it indicates a bug. Please
[open an issue](https://github.com/dvdsosa/zotero-native-mcp/issues).

**Imported attachment fails above 4 GB**: Zotero does not support stored files
that large. Use linked mode, which has no size limit.

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
