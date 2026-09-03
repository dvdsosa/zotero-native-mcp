# Linked vs imported attachments

Understanding-oriented. Zotero offers two ways to associate a file with a
reference, and the choice has consequences that are easier to get right up front
than to undo later.

## The two modes

A **linked file** stores a path. Zotero records where the file is and nothing
else — the bytes stay exactly where you put them.

An **imported file** stores a copy. Zotero takes the file into its own storage
directory, under a folder named for the attachment key, and from then on that
copy is the attachment.

## What follows from that

**Speed.** A linked attachment is a database row, so it completes in
milliseconds whether the file is 20 KB or 2 GB. An imported attachment must
move the bytes, and this server does so through Zotero's own three-phase upload
protocol — authorize, transfer, register — which is proportional to file size.

**Where the file must stay.** A linked attachment breaks if you move or rename
the file. Zotero keeps a path, not a handle. An imported attachment does not
care what happens to the original; you can delete it immediately.

**Syncing.** Linked files do **not** sync to zotero.org. The path is meaningful
only on the machine that created it, so a linked attachment on your laptop is a
broken reference on your desktop. Imported files sync like any other attachment,
subject to your storage quota.

**Disk usage.** Imported means a second copy. A library of a thousand imported
PDFs is a few gigabytes that also exist in your downloads folder.

**Group libraries.** Zotero does not merely discourage linked files in a shared
library, it refuses them: your collaborators do not have your filesystem, so the
path would resolve to nothing for them. Since `linked` is the default, an
attachment into a group must say `mode: "imported"` explicitly.

## Choosing

Import when the file should follow the reference: it is going into a group
library, you sync across machines, you want the download folder cleared, or the
file is genuinely part of your archive.

Link when the file should stay where it is: a large dataset or video, a document
in a folder you already back up and organise deliberately, a file that lives in
a shared drive with its own structure, or anything you are only attaching
temporarily.

This server defaults to **linked**, on the grounds that it is instant, uses no
extra disk, and is trivially reversible — you can always import the file
afterwards and delete the link. The reverse is more work.

## What the server does for an imported file

Worth knowing, because it explains the error messages.

Zotero's upload protocol mirrors the web API's, where a client hands bytes to
S3. Locally there is no S3, so Zotero receives them itself, but the shape is the
same:

1. **Create the attachment item** with `linkMode: imported_file`, a filename and
   a content type.
2. **Authorize the upload** by posting the file's MD5, size and modification
   time. Zotero replies with an upload key and a URL — or with `{exists: 1}` if
   a file with that exact MD5 is already in place, in which case there is
   nothing to transfer.
3. **Transfer the bytes** to that URL. Zotero stages them in a temporary
   directory and verifies the MD5 matches what was claimed.
4. **Register the upload**, at which point Zotero moves the staged file into the
   attachment's storage directory and updates the item.

The staging step is why a failed upload cannot corrupt an existing attachment:
nothing touches the storage directory until the checksum has been verified and
the preconditions still hold.

Modification time must be supplied in **milliseconds**; Zotero explicitly
rejects second-precision values, since a client passing seconds would silently
mark every file as ancient.

## Related

- [How to attach PDFs](../how-to/attach-pdfs.md)
- [`zotero_attach_file` reference](../reference.md#zotero_attach_file--write)

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
