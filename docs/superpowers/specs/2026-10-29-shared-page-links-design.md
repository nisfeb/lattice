# Shared page links: move a page shared with you into your own tree

## Intent

Pages other ships share with you sit in "shared with me › ~ship" in the Files tree. sneagan wants to move one into a folder of their own (reins request "user should be able to move a shared document out of its default location"), and see it there with a shared icon, the way clearweb pages carry theirs. The moved page must also appear at that spot in lattice-fs (the desktop mount) and to agents, not only in the editor.

This is also the first half of reins request 9 ("the equivalent of a symlink, use grubbery"). The link entry designed here is shaped so a local symlink can reuse it later.

## Goals

- Move a shared-with-me page into any folder of your page tree, and back out again.
- At its new spot it opens, reads and saves exactly like the shared page does today, with the owner's grant deciding what you may do.
- It shows in the editor tree, in lattice-fs and to agents at that path, marked as a link to another ship.
- One home: once moved, it leaves "shared with me".

## Non-goals

- No copying. The text stays on the owner's ship.
- No local symlinks yet (request 9's local half). The data shape allows it later.
- No change to how ships share pages or to the sharing notice protocol.

## Anti-goals

- A link must never widen access. An agent key scoped to `notes/` must not reach another ship through a link in `notes/`, and nobody gets more than the owner's grant.
- A slow or offline owner must never hang the editor tree or the lattice-fs mount.
- Moving or deleting a folder must never silently destroy a link inside it.

## Decisions (sneagan)

- The documents in question are pages other ships shared with you.
- Moved links appear in lattice-fs, and so to agents.

## Design

### Storage, my call

A link is a page-tree directory holding a `link` grub (new mark `[/lattice %link]`) instead of a `code` grub: `/page/<path>/link` = `[host=@p pax=path mode=@t]`. `pax` is the host's absolute code-grub path, exactly as the shared-with-me entry carries it. `mode` is the last-known grant (read or edit), a claim, not a capability.

It is not stored as `%code`, because the evaluator spawns on any `code` grub under `/page`. It is not grubbery's `%symlink`, because a symlink can only name a local path and the kernel never follows it anyway. The `%link` value is a tagged union so request 9 can add a local variant later: `$%([%ship host=@p pax=path mode=@t] [%local pax=path])`. Phase 1 only builds `%ship`.

### Listing

`+tree-walk`, `+dump-walk`, `+collect-tree`, `+index-walk` and `+collect-visible` gain a third branch for a dir holding `link`. Tree and dump emit it as `{path, page:true, kind, link:{host, path, mode}}` with no body, and with `readonly:true` when mode is read. `kind` is the remote page's kind, stored on the link at create time and frozen after that (see below).

### Reading and writing through a link (server-side proxy)

`page-source` and `page-save`, on both the HTTP routes and the lattice-fs lick ops (`fs-source-result`, `fs-save`), detect a `link` grub and proxy. Reads use the `/browse-file` path: `peek-remote-wait-in` with a short deadline (5s, my call) and `browse-file-respond`'s unwrap. Writes use `handle-remote-save`'s logic: peek, make, peek again, and require the revision to rise. The client and lattice-fs never learn the remote address for I/O. lattice-fs needs only the small `readonly` change described below.

On timeout or denial: reads return a clear error (504 "~host is unreachable or no longer shares this page"). lattice-fs surfaces that as an I/O error on that file only. Writes fail without touching anything local.

Proxied page text returned to an agent key is marked as quoted, foreign content, the way `web_read` marks fetched pages.

### Security

The proxy branch requires BOTH the local scope for the link's own path and `may-path:ky [%ship host] pax` for the remote side, with the same taint rule `remote-save` applies to remote writes. The owner's grant is enforced on their ship regardless: an ungranted peek returns nothing, and an ungranted write fails the revision check. Links are owner-created only: the create route is not keyable.

### The move action

- **Into the tree:** drag a shared-with-me row onto a folder, or use "Move" from its page menu (it opens the existing move dialog). A new owner-only route, `POST /link-make?host&path&to`, writes `/page/<to>/link` from the matching shared-with-me entry, then deletes that entry (`shared-with-me-del`). It refuses if anything (page, folder or link) already exists at `to`. It does not queue offline.
- **Back out:** "Move back to shared with me" on a link removes the `link` dir and re-adds the shared-with-me entry. This never touches the owner's grant.
- **Moving and renaming a link** goes through the normal `page-move`. `move-pages` copies `link` grubs along with page grubs, records the move in `moves.json`, and its wikilink rewriting leaves link targets alone. `fs-move`'s collision check also sees a `link` at the destination.
- **Deleting a folder** that holds links deletes the links (they are yours). It never contacts the host.

### In the editor

A link row shows the page's name, a link-out icon (flat SVG, theme colored) and, on hover, `~host`. It opens through `openIn` as the same remote grub tab shared pages use today (`openGrub(pax, host)`), titled with the link's path. The right pane's Page tab shows "Linked from ~host/<their path>" and the grant mode. Comments, history and sharing controls stay the owner's, as they are for a shared page today.

When the owner revokes access, the link stays, with a "no longer shared" badge after the next failed read, until you remove it.

## Resolved after the builder check (my calls)

- **Cached copy on the link.** The `%ship` link also stores `kind`, last-known `body`, `rev` (the owner's revision), `size`, and `seen` (the last-read result: ok, or unreachable-or-revoked, with a time). The editor and agents always read live through the proxy, and every successful read refreshes the cache. lattice-fs reads serve the cached copy at once and start a background refresh. The lick server handles one request at a time, so a live remote peek there would stall the whole mount for an offline host. Tree and dump report the cached `size` and the owner's `rev`, so the mount's rev-keyed cache sees remote changes.
- **lattice-fs does change, slightly.** `page_node` honours a `readonly` field from the dump, so a read-grant link is read-only in the mount, not writable until EIO on flush. That is a small Rust change in `lattice-fs-rs/src/lattice.rs`.
- **Links are never served to others.** Publishing, clearweb, folder sharing, the reader's browse of your ship, `/pub` and search results for anyone but you skip link entries entirely. A third ship never reaches the owner's page through you. Sharing or publishing a folder that holds links shares only its real pages.
- **Kind is frozen at create.** `/link-make` peeks the host once to learn the page's kind and body. If the host is offline it refuses with "~host is unreachable, try again when it's online", because a link with an unknown kind would get the wrong file extension in the mount. Kind never changes after that, so a mounted file is never renamed under an open editor.
- **Re-share updates the link.** When a share notice arrives for a host and path that you have already linked, the receiving handler updates that link's `mode` and does not add it back to "shared with me". The sharing protocol itself is unchanged.
- **The status persists.** The badge comes from the stored `seen`, so it survives a reload. The owner's ship can't tell a denial from being offline, so the badge says "~host unreachable or no longer sharing" and shows when it last worked.
- **Writes are conflict-checked.** A proxied save carries the base revision the writer read (`wiki_write`'s `base`, the editor's current rev). It is refused with a conflict if the owner's revision has moved past it, the same promise `wiki_write` makes for local pages. `page-source` marks link responses with `link:{host,path}` so the MCP server quotes them as foreign content.

## What's left to the builder

- Exact JSON field names beyond those above, CSS, and the icon drawing.
- Whether `/link-make` reuses `eval-action` or is its own route.
- Test layout: a two-ship test (the established fleet-pier setup from the cross-ship forum work) is required for read, write, revoke and offline-host paths. A lattice-fs projection test covers list, read and write through a link.
