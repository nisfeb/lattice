# Share notifications and edit access requests

Date: 2026-11-08. Branch: share-notify-requests.

## Goal

A ship that is shared a page or a folder hears about it in its inbox, and, on the desktop or in a browser that opted in, as an OS notification. A ship holding a page or folder read-only can ask its host for edit access, with a short note. The host sees the request in its inbox and in the Access tab, and approves or denies it. Approval grants edit by hand to that one ship and the page becomes editable on the requester's side without a reload.

## What is already there

- A share sends a `%share-notice` poke to the recipient's `/shares.sig`. Since release 123 every grant and revoke diffs holders (`+holds-now`, `+tell-holds`) and sends `%add`, `%dir` or `%del`. A folder share is one `%dir` notice.
- Shared with me is live through `/beacon/shares`, which bumps `/rev`.
- The inbox (`/notify/items`, `/notify/seen`, `/beacon/notify`, lib/lattice-notify) has an unread badge and an Activity tab.
- Bans live in `/banned`, checked with `+is-banned:ls`.

## Recipient notifications

`+apply-share-notice` files an inbox item as it takes a notice:

| notice | item kind | badged | text |
| --- | --- | --- | --- |
| `%add` or `%dir`, a page or folder not listed before | `%share` | yes | ~host shared NAME with you (read or edit) |
| `%add` or `%dir` at a new mode for one listed | `%reshare` | no | ~host changed NAME to MODE |
| `%del` from the host | `%unshare` | no | ~host stopped sharing NAME |

A notice that changes nothing (a re-share at the same mode, a folder `touch`) files no item. "Quiet" kinds count as read in `+is-read:ln`, so they show in Activity but never move the badge. A mode change that answers our own pending request files the approval item instead (below).

The share beacon's `op` says what happened: `add` for a new entry, `mode` for a mode change, `touch` for one already listed at the same mode. Clients toast and notify only on `add`, so a folder share is one notification.

### OS notifications

- Desktop (Tauri): a new command `notify_share(title, body)` shows a native notification through tauri-plugin-notification (added without `cargo update`). The command clips both strings and takes nothing else, so a hostile page can at worst show a short notification.
- Web: only when the user ticked "Notify me in this browser when a ship shares something with me" in Settings, Editor. Ticking it asks the browser for permission. The page never prompts on load.
- Both fire from the `add` event of `/beacon/shares`. A localStorage set of recent `host path` keys keeps two open tabs from notifying twice, and the browser notification carries the same `tag`.

## Edit access requests

### Wire

A new inbox grub, `/access.sig`, with its own mark `/lattice %access-ask`. `/public` gets a poke road for it, as for `/shares.sig`. The sender is always taken from the transport.

```
+$  ask
  $%  [%ask pax=path note=@t]            ::  requester to host
      [%nay pax=path]                    ::  host to requester: denied
      [%sent host=@p pax=path note=@t]   ::  own: a request went out
      [%took host=@p pax=path]           ::  own: the host granted edit
      [%answer who=@p pax=path ok=?]     ::  own: the host's UI decided
  ==
```

`pax` is the path the share notice named: `<base>/page/<rel>/code` for a page, `<base>/page/<rel>/dir-index` for a folder. Foreign ships may send only `%ask` and `%nay`. Own pokes may send only the other three.

A host advertises that it takes requests with `/pub/access`, a `@ud` grub under the world-readable `/pub`.

### Host side

State: `/access-reqs`, `[%1 pend=(list req) nays=(list nay)]`, written only by the `/access.sig` fiber.

An `%ask` is dropped silently when:

- the sender is banned (`+is-banned:ls`, so a moon goes with its planet);
- the path is not one of ours, or the sender does not hold it read-only now (`+holds-now`, then `+hold-mode:ls`, which also finds a page under a held folder). A ship that already edits it, or reads nothing, asks nothing;
- the sender was denied this path less than a day ago (`+ask-cool:ls`);
- the sender's family already has 10 pending (`+ask-ship-cap:ls`), or 500 are pending in all.

A second request for the same (ship, path) replaces the first: one pending entry, the newer note, and no second inbox item. A new request files a badged `%ask` inbox item and stamps `/beacon/notify`.

The HTTP route `POST /access-answer?ship=&path=&do=approve|deny`:

- approve: grants edit by hand through the same code as `/share-file` (a page) or the folder share (a folder), so group grants keep their modes and the usual share notice goes out. Then it pokes `/access.sig` `[%answer who pax &]`, which drops the request.
- deny: pokes `[%answer who pax |]`, which drops the request, records the deny for the cooldown and sends `[%nay pax]` to the requester, fire-and-forget.

`GET /access-requests` lists the pending requests with the requester, page name, note and time, and this ship's own outgoing requests.

### Requester side

`POST /access-request?host=&path=` with the note as the body:

1. pokes the host's `/access.sig` with `[%ask pax note]` and waits up to 5 s for the ack. No ack: "the host did not answer".
2. peeks the host's `/pub/access`. Absent: 409 `too-old`, and the UI says "this host's lattice is too old to take requests".
3. records the request with an own `[%sent host pax note]` in `/access-sent`.

The outcome:

- approved: the host's share notice arrives at edit. `/shares.sig` sees a pending request for that path, files no `%reshare` item and pokes `[%took host pax]`, which drops the request and files a badged `%asked` item, "~host gave you edit access to NAME".
- denied: `[%nay pax]` from that host, for a request we have pending, drops it and files a badged `%asked` item, "~host declined your request for edit access to NAME". A `%nay` for nothing we asked is dropped.

A linked page takes the new mode through the existing link path, and the tree's next load repaints the editor lock, so it becomes editable without a reload. A page open from shared with me was never locked in the client: its save now lands.

### UI

- Requester: "Request edit access" in the page menu (a page open from a read share, or a read link), and in a read-only shared-with-me row's menu. A small dialog takes the optional note (280 bytes).
- Host: approve and deny buttons on each pending `%ask` card in the inbox, and a "Requests" section at the top of the Access tab with the same buttons.
- Settings, Editor: the browser notification opt-in.

## Compatibility

- An old host has no `/access.sig` road, mark or `/pub/access`. The request poke is acked and dropped, the marker peek finds nothing, and the requester is told the host is too old. Nothing is recorded.
- An old recipient never sends requests and never hears `%nay`. The share beacon's new `op` values reach only new clients; an old client treats `mode` and `touch` as a plain refetch and skips its toast.
- The new item kinds are local to each ship. Stored items keep their mold.

## Durability

On-load rows: `/access.sig` (`%fall` sig), `/access-reqs` and `/access-sent` (`%fall` noun with an empty default), `/pub/access` (`%fall` ud). scripts/onload-check.py covers them. Pending requests and denies survive a reload.

## Tests

- tests/lib/lattice-share.hoon: `+ask-file` (new, duplicate, cooldown, caps), `+ask-deny`, `+hold-mode`, `+ask-rel`, sent list helpers. tests/lib/lattice-notify.hoon: quiet kinds read.
- scripts/two-ship-access-request.sh: share read, B sees a `%share` item; B requests, A sees it; approve, B saves; deny and cooldown; a duplicate collapses; a banned requester is dropped.
- scripts/ui-access.mjs: the inbox entries and the Requests section render in a vm with a stub DOM.
