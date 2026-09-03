# Troubleshooting

Start with `zotero_status`. It answers most questions at once: whether Zotero is
reachable, which version it is, and whether write access has been granted.

> Check my Zotero connection status.

## "Cannot reach Zotero's local API"

The server could not open a connection at all.

1. **Is Zotero running?** It must be open. This server talks to the live
   application, not to your database files.
2. **Is the local API enabled?** **Settings → Advanced** →
   **"Allow other applications on this computer to communicate with Zotero"**.
3. **Non-standard port?** Zotero normally listens on `23119`. If yours differs,
   set `ZOTERO_LOCAL_PORT`.

Verify independently from a terminal:

```bash
curl -i http://127.0.0.1:23119/api/
```

A healthy Zotero replies `200` with `Zotero-Server-ID` and `X-Zotero-Version`
headers. Connection refused means Zotero is closed or the setting is off.

## Writes fail with 401

Write access needs a local API key.

- **Never approved a dialog?** Ask your assistant to run `zotero_authorize`, and
  watch for the dialog in Zotero.
- **Approved with "Allow" instead of "Always Allow"?** That key was single-use
  and has been consumed. The server re-authorizes automatically, which is why a
  new dialog keeps appearing. Choose **Always Allow** to stop it.
- **Dialog never appears?** Zotero may be on another desktop or behind other
  windows. Bring it to the front and retry.

## Writes fail with 403

Either the local API is switched off (see above), or you are writing to a group
library where you only have read access. Check your role at
[zotero.org/groups](https://www.zotero.org/groups).

## Everything fails with 412 after restarting Zotero

`412 Precondition Failed` means the cached instance identity no longer matches —
normally because Zotero restarted with a different data directory. The server
detects this and retries once on its own, so a persistent 412 suggests something
stranger. Restart your MCP client to clear all cached state.

## A key that worked yesterday is rejected

Local API keys are tied to a specific Zotero instance and data directory. If you
switched data directories or moved to a different machine, the stored key is no
longer valid. Delete the key store and re-authorize:

```bash
rm ~/.config/zotero-native-mcp/keys.json
```

## "The object key does not exist in this library"

Almost always a library mismatch rather than a bad key. Item and collection keys
are scoped to one library, so a key found in a group will 404 against your
personal library and vice versa. Confirm which library the object lives in and
pass `groupId` accordingly — see
[Group libraries](group-libraries.md).

## "No indexed full text found"

`zotero_get_item_fulltext` returns only what Zotero has already indexed. There
is no text when the PDF is a scan without OCR, when indexing has not finished,
or when the file is not a text format at all.

Use `zotero_get_attachment_path` instead and have your assistant read the file
from disk directly.

## Rate-limited: "Too many authorization requests"

Zotero allows five authorization prompts per minute. Hitting the limit almost
always means a loop of single-use keys — approve with **Always Allow** and it
stops. Wait for the interval named in the error before retrying.

## A batch operation rejects more than 50 items

Zotero's local API caps writes and deletes at 50 objects per call. Ask your
assistant to work in chunks:

> Do that in batches of 50.

## Zotero freezes during a large import

Imported attachments are copied through Zotero's own transaction machinery, so a
very large file briefly occupies it. Prefer **linked** mode for large files —
it stores only a path and returns immediately. See
[Linked vs imported attachments](../explanation/attachments.md).

## Still stuck

Turn on Zotero's own logging — **Help → Debug Output Logging → View Output** —
and reproduce the problem. It shows the requests Zotero received and why it
rejected them. Include that output when
[opening an issue](https://github.com/dvdsosa/zotero-native-mcp/issues).
