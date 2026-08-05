# Offline edits: design

Status: **built.** Phases 1–3 shipped (queue/detection/replay; CAS +
conflict pages; tree snapshot in IndexedDB). The page snapshot stays in
localStorage deliberately. Its synchronous read is what paints resume at 0ms.

Reviewed 2026-08-02 against the shipped code. Four gaps were found and folded
in below (marked **[review]**). The architecture stood. The gaps were all in
what the first draft left unsaid.

Four facts from this codebase shape this more than any general sync theory.

## What already exists

- **Offline reads mostly work.** `page-dump` carries every page body and
  `snapTree` persists it to `localStorage.appTree`, so a loaded tree is
  readable with the ship gone. Offline *editing* is the gap.
- **Conflicts are recoverable by construction.** Every save is a kept `%firm`
  revision and `rev` is exposed on read. A bad replay is therefore never
  destructive. It is a revision you can restore. That property is what lets
  this design be optimistic instead of blocking.
- **`page-save-batch` is the replay primitive**: N edits, one request, one
  writer transaction.

## Three constraints that rule out the obvious approach

1. **No Background Sync.** The service worker deliberately does not intercept
   API calls. That is the fix for webkitgtk dropping cookies on SW-mediated
   fetch ("tree failed 403"). The queue therefore lives in the page, not the
   SW, and the honest consequence is that **closing the app does not sync**.
   Replay happens on next open. Say so in the UI rather than implying
   otherwise.
2. **`navigator.onLine` is useless on desktop.** The webview talks to
   127.0.0.1, which always answers. The bridge returns **502** when the ship is
   unreachable. Detect offline from RESPONSES (502 / timeout / network error),
   never a browser flag. That also works on mobile, where `onLine` lies about
   captive portals.
3. **localStorage is the wrong store**: synchronous, ~5MB, already holding a
   55KB+ tree snapshot. The queue goes in IndexedDB (currently unused).

## Design

**Queue.** One IndexedDB record per page: `{name, kind, body, baseRev,
queuedAt}`, coalesced. Re-editing a queued page replaces its record, the same
way autosave already coalesces `savePending`. Bounded by pages touched, not
edits made.

**[review] The queue is also the TOP READ TIER.** The first draft only queued
writes. But `openPage` serves cache-first, and the cache holds the last
SERVER render. So editing A offline, visiting B, and returning to A painted
the pre-edit body over a queue holding the new one. The edit looks lost, and
an autosave from that state queues the OLD body back. On enqueue the queued
body must also update `pageCache` and the page's `nodes` entry. On open the
queue is consulted before anything else.

**Detection.** A save failing with 502/timeout/network flips a `degraded` flag
and enqueues instead of erroring. Any later success clears it. No polling.

**[review] Nothing implements the timeout today.** The bridge's ureq agent
sets no timeout and no client fetch uses an AbortController, so against a dead
remote ship "degraded" is the OS TCP timeout, a 1–2 minute hang before the
first enqueue. Phase 1 adds an AbortController (~10s) on the save path and a
timeout on the bridge agent. **[review]** Ten seconds turned out to be too
tight to be safe. See "The live-save deadline" below for why it is thirty now.

**Replay.** On reconnect or on open with a non-empty queue, drain through
`page-save-batch` in chunks, then `loadTree()` to reconcile.

**[review] The batch is all-or-nothing, which is right for uploads and wrong
for replay.** One poisoned queued item would block the whole queue forever.
Phase 1 falls back to per-item `page-save` when a batch rejects, isolating the
bad item. Queued CREATES also lose the `new=1` 409 protection inside a batch.
It is carried per-item in Phase 2's route change, which must be a MODE on the
route (the upload path keeps all-or-nothing).

**[review] Replay must win the reconnect race.** `refreshAll` fires on
focus/visibilitychange and repaints from the server dump. On reconnect that
runs BEFORE the queue drains and repaints queued pages with stale server
bodies. Either replay runs first, or dump reconciliation skips any page with a
queue entry.

**Conflict policy.** Each queued edit carries the `rev` it was based on.

- `serverRev == baseRev` → apply. The overwhelming majority.
- `serverRev != baseRev` → **apply anyway and flag it**. The edit lands as the
  newest revision AND a conflict entry surfaces both revs with one-click
  restore of the server copy (`page-history` / `page-source-at` already
  support this).

Optimistic-plus-flag beats refuse-and-block because the dominant conflict is
one person on two devices, and blocking your own offline work behind a
resolution dialog is the worse trade. Nothing is lost either way. The
difference is who waits.

**Explicitly not merged.** No CRDT, no three-way merge of prose. A silently
mis-merged document is worse than a flagged conflict you can see.

## The one server change

`page-save` returns `send-ok` today, no rev. Two additions:

- return the new `rev`, so the client can update `baseRev` without a re-read
- accept optional `base=<rev>` on `page-save` and per item in
  `page-save-batch`, reporting per-item `applied | conflicted` rather than
  failing the whole batch

Compare-and-swap on the SERVER, not check-then-write on the client, or replay
races anything landing in between.

## Mobile vs desktop

Same queue, same code. The differences are real but small:

- **Mobile PWA**: can be killed at any moment, so durability matters most.
  Replay happens on next open.
- **Desktop**: the bridge gives a clean 502. There is an optional later
  upgrade. The Rust side could hold the queue and retry with the window
  closed, which the web app structurally cannot do. Not worth building until
  the shared path is proven.

## Phasing

1. Queue, detection, replay, honest status ("3 edits waiting"). **Saves
   only**: creates and edits, **pages and know memories**. [review]:
   know-mode was out of Phase 1 for key-collision reasons. It has since
   joined, with the same queue under a `know:` prefix so the namespaces
   cannot collide, per-item last-write-wins replay, no conflict pages,
   matching know-save itself. Deletes, moves and uploads
   refuse while degraded with a clear message. Their ordering dependencies are
   where offline systems get genuinely hard, and they are rare offline.
   [review] Deletes, moves and renames have since joined too, in Phase 4
   below. Uploads and the sharing routes still refuse.
   [review] Multi-tab: two tabs share the IndexedDB queue. Double replay is
   near-idempotent (same bodies, duplicate revisions at worst). That is
   acceptable for Phase 1, noted so it is a decision rather than a surprise.
2. The CAS server change plus the conflict surface.
3. Move the tree snapshot to IndexedDB so offline reads scale past
   localStorage. **Done:** `kv` store beside the queue (db v2), structured
   clone instead of a whole-tree stringify per save, one-time migration from
   `localStorage.appTree` at boot. The async read lands single-digit ms after
   the synchronous page paint, imperceptible next to the ~0.5s network floor.
4. Structural changes: delete, move, rename. **Done:** an `ops` store beside
   the queue (db v3). Saves are a map keyed by name, because only the last
   body matters and autosave writes constantly. Ops are an ordered log,
   because "rename A to B" then "delete B" is not the reverse and nobody does
   either of them often enough to be worth coalescing.

   The ordering problem is solved at enqueue time rather than at replay time.
   Queueing a delete drops the pending saves under that path. Queueing a move
   carries them to the new name. Once that is done every op can run before
   every save and still be right, so the drain is two plain passes instead of
   an interleaved merge.

   An op the ship rejects is dropped, never retried. A rejection means the
   intent was already met some other way, usually deleting a page that only
   ever existed in this queue. Retrying would wedge the queue behind it, and
   there is nothing to lose because no content lives in an op. Sharing and
   the ACL routes are deliberately still refused. A grant that appears to
   work offline and is denied an hour later is a security surprise.

## The live-save deadline

Detection is by response, with a timeout as the backstop. That timeout applies
to the user's own saves, and it was the tightest one in the app: ten seconds
for a live save, against twenty per item and a hundred and twenty per batch on
replay. Backwards, and not harmlessly so.

The pier serialises. Opening the app spends four or five round-trips before
anyone touches anything, so on a loaded ship the first save is still queued
behind boot when its own clock runs out. That reads as an outage. The edit is
queued, replayed later, and lands on top of whatever happened in between as a
conflicts/ page. A false offline does not just delay a save. It manufactures a
conflict and splits one page into two.

So the default is thirty seconds now. Noticing a genuinely dead ship later
costs seconds. Guessing wrong costs a duplicate page and the belief that an
edit was lost. The reconnect probe stays at five, because that one is cheap
and wrong-in-the-other-direction is harmless.

## Testing

`ui-boot` already intercepts and delays requests. Aborting them, editing,
restoring and asserting replay uses the same machinery, so this is
deterministically testable rather than timing-dependent.
