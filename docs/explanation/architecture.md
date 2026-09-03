# Why this server needs no plugin and no API key

Understanding-oriented. This explains the design decision at the centre of the
project and why it only became possible recently.

## The problem every Zotero integration faced

Zotero has long shipped a small HTTP server on `127.0.0.1:23119`, used by the
browser connector. Since Zotero 7 it also serves a local implementation of the
Zotero Web API v3 under `/api/`: the same routes as `api.zotero.org`, answered
from your own database.

That local API was **read-only**. `POST`, `PUT`, `PATCH` and `DELETE` were
refused. Anything that wanted to *change* a library had two options, and every
Zotero MCP server before this one picked one of them.

**Option A: route writes through the cloud.** Read locally for speed, write to
`api.zotero.org`. It works, but it drags in a zotero.org account, an API key to
create and store, a library that must actually be synced, a network round trip
of roughly half a second to a second and a half per write, and rate limits. It
also fails on a plane.

**Option B: ship a Zotero plugin.** Install an `.xpi` that registers extra
endpoints, `/zotero-write/*` or similar, on Zotero's existing server. Writes
then happen in-process through Zotero's own `item.saveTx()`, which is fast and
correct. The cost is a second piece of software the user must install, that must
track Zotero's plugin API across releases, and that can break on a Zotero
update.

Both are workarounds for the same missing capability.

## What changed in Zotero 10

Zotero 10 made the local API writable. `POST`, `PUT`, `PATCH` and `DELETE` are
now supported for items, collections and saved searches, along with tag
deletion, full-text writes and file uploads.

Two mechanisms make that safe on a port any local process can reach.

**A consent dialog instead of a pre-shared key.** Local API keys cannot be
created in advance. A client asks for one at runtime by posting its name to
`/api/local/authorize`, and Zotero shows the user a dialog naming that
application. The user chooses Allow, Always Allow, or Deny. The human is in the
loop at the moment access is granted, and the key that results is unrelated to
any zotero.org credential. See
[How authorization works](authorization.md).

**An instance identity check.** Every response carries a `Zotero-Server-ID`
header identifying the running instance. Clients cache it and send it back on
writes. A write without it is refused with `428`; one carrying a stale value is
refused with `412`. This stops a client from writing into the wrong library
after the user switches data directories, a real hazard when the address is
always `127.0.0.1`.

## What this server is, therefore

A thin, careful client of a capability Zotero already has.

There is no plugin because Zotero itself serves the endpoints. There is no API
key to configure because the key is issued at runtime and stored locally. There
is no cloud round trip because nothing ever leaves the loopback interface, which is why reads land in 8–60 ms rather than half a second.

The server's own work is confined to three things the protocol demands and no
tool should have to repeat: caching and refreshing the instance ID, obtaining
and re-obtaining the local key (single-use keys mean a `401` mid-session is
normal, not an error), and shaping responses so an agent's context is not filled
with Zotero's repeated `library` and `links` envelope blocks.

## The trade-off

This design is strictly better only if you meet its one requirement: **Zotero 10
or newer, running on this machine**.

Give that up and the older approaches win. A web API server reaches libraries
you have never synced locally and works with Zotero closed. A plugin-based
server supports Zotero 7 through 9. Servers built around embeddings offer
semantic search this one does not attempt.

The bet here is that for the common case, a researcher with Zotero open on
their own laptop, removing the account, the key, the plugin and the network is
worth more than the flexibility given up.

## Further reading

- [Zotero's local API documentation](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [How authorization works](authorization.md)
- [Linked vs imported attachments](attachments.md)

---

<p align="center"><a href="../../README.md">⬅ <b>Back to the main README</b></a></p>
