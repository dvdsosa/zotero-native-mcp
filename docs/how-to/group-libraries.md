# How to work with group libraries

Every tool acts on your personal library ("My Library") unless you say
otherwise. Group libraries are addressed by numeric ID.

## Find your group IDs

> List my Zotero libraries.

`zotero_list_libraries` returns your personal library plus every group library
Zotero has locally:

```json
{
  "personalLibrary": { "type": "user", "id": 11223344, "name": "My Library" },
  "groups": [
    { "groupId": 55667788, "name": "Marine Biology", "numItems": 199 }
  ]
}
```

## Target a group

Mention the group by name and your assistant will pass the matching `groupId`:

> Search the Marine Biology group library for papers about gliders.

Every tool accepts `groupId`, so the same applies to writes:

> Create a "Field Campaigns" collection in the Marine Biology group.

## Keys are scoped to a library

An item key is only meaningful within one library. The same 8-character key can
exist in both your personal library and a group, pointing at different items.

This is the most common cause of a puzzling `404`: you found a key by searching
one library, then used it against another. If a tool reports "the object key
does not exist in this library", check the `groupId` before assuming the key is
wrong.

## Copy a reference from a group into your own library

There is no server-side copy operation. Read the item, then create it again in
the target library:

> Read item ABCD1234 from the Marine Biology group and create the same reference
> in my personal library under "To Read".

Note that this creates a *new, independent* item. It does not link the two, and
attachments are not carried over — attach files separately if you need them.

## What the local API does not expose for groups

Zotero's local API deliberately reports minimal group metadata: name,
description, and item count. Permissions, ownership, and membership live on
zotero.org and are not mirrored locally, so this server cannot tell you whether
you have write access to a group before you try.

If a write to a group fails with `403`, you have read-only access to that
library. Check your role at
[zotero.org/groups](https://www.zotero.org/groups).
