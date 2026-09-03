# How authorization works

Understanding-oriented. Why writing to your library requires a dialog, why that
dialog sometimes reappears, and what is stored where.

## The problem being solved

Zotero's local API answers on `127.0.0.1:23119`. Any process running as you can
reach it. Reading is one thing; letting any local process silently rewrite your
research library is another.

A pre-shared secret does not help much here. Anything you could put in a config
file, a malicious local process could read from that same file.

Zotero's answer is to move the decision to the moment of access, and to a place
no other process can forge: **its own window**.

## The flow

A client that wants to write posts its name to `/api/local/authorize`:

```json
{ "appName": "zotero-native-mcp" }
```

Zotero raises a modal dialog naming that application and offering three choices:

- **Allow** — issues a key that works for exactly one write.
- **Always Allow** — issues a key that persists.
- **Deny** — refuses, and the endpoint returns `403`.

On approval the response carries a 32-character key, which the client then sends
as `Zotero-API-Key` on every write. Zotero records issued keys in
`localAPIKeys.json` inside its own profile directory.

These keys have nothing to do with zotero.org API keys. They cannot be created
in advance, cannot be created from a web page, and grant access only from this
machine.

## Why single-use keys exist

**Allow** is the deliberately awkward option, and that is the point. It answers
"let this one thing happen" rather than "trust this application". The key is
consumed by the first write that successfully validates it — Zotero deletes it
immediately, before performing the write, so a race cannot spend it twice.

The consequence is that the *next* write gets a `401`. That is expected
behaviour, not a failure, and Zotero's own documentation tells clients to be
ready for it.

This server handles it by re-authorizing once and replaying the request
automatically. Which produces the effect users notice: **choosing "Allow"
instead of "Always Allow" means a dialog on every single write.** If dialogs
keep appearing, that is why. Approve once with **Always Allow**.

You can disable the automatic retry with `ZOTERO_LOCAL_AUTO_AUTHORIZE=false`, in
which case a `401` surfaces as an error telling the agent to call
`zotero_authorize` explicitly.

## The instance check

Authorization answers *who* may write. A second mechanism answers *where*.

Every local API response carries a `Zotero-Server-ID` header identifying the
running Zotero instance and its data directory. Clients cache it and send it
back on writes. Zotero refuses a write with no server ID (`428`) and one with a
mismatched server ID (`412`).

This matters because `127.0.0.1:23119` is a stable address pointing at whatever
Zotero happens to be running. Without the check, a client that cached data from
one library could write it into a different one after the user switched data
directories. The server re-resolves the ID and retries once when it sees a
`412`, which covers the ordinary case of Zotero having been restarted.

## What is stored, and where

**Zotero's side** — `localAPIKeys.json` in the Zotero profile directory, listing
each issued key with the application name that requested it, whether it
persists, and when it was created. Revoke access by deleting an entry.

**This server's side** — `~/.config/zotero-native-mcp/keys.json`, written with
`0600` permissions, mapping server ID to key:

```json
{
  "version": 1,
  "keys": { "lJWVSvZtf8Pc": "<32-character key>" }
}
```

Keys are partitioned by server ID deliberately. A key issued by one Zotero
instance is meaningless to another, so storing them per-instance means switching
data directories produces a clean re-authorization rather than a confusing
sequence of `401`s.

Override the location with `ZOTERO_LOCAL_KEY_STORE`, or bypass the store
entirely with `ZOTERO_LOCAL_API_KEY`.

## Revoking access

Any of these work:

- Delete the entry from Zotero's `localAPIKeys.json`.
- Delete `~/.config/zotero-native-mcp/keys.json` — the next write raises a fresh
  dialog.
- Turn off **Settings → Advanced → "Allow other applications on this computer to
  communicate with Zotero"**, which disables the local API entirely, reads
  included.

## Rate limiting

Zotero permits five authorization prompts per minute, then returns `429` with a
`Retry-After` header. In practice, hitting that limit means a loop of single-use
keys. **Always Allow** ends it.

## Related

- [Troubleshooting authorization](../how-to/troubleshooting.md#writes-fail-with-401)
- [`zotero_authorize` reference](../reference.md#zotero_authorize--write)
- [Architecture](architecture.md)

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
