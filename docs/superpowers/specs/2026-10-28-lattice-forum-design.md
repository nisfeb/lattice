# Host a forum: fold furum into lattice as a feature

## Intent and why

A forum is a multi-author, threaded website. Lattice already hosts and manages websites (pages, folders, publishing, per-path grants, reader comments, follows, clearweb, themes, peer-to-peer reads). So hosting a forum should be a lattice capability, not a separate app. This folds furum's forum functionality into the lattice nexus and retires furum as its own app.

The recon settles the architecture. Furum is already a complete, tested grubbery nexus: boards, threaded posts, votes with HN-style ranking, roles, moderation, cross-ship posting, a server-rendered (no-JS) Sail UI, and a public clearweb view. Lattice's reader comments, by contrast, are deliberately thin: flat, no titles or parents, no per-thread structure, no roles, a 200-per-page cap, no pagination. Building a forum up from lattice's comment primitive would reinvent furum badly. So the work is not "build a forum from scratch on lattice primitives." It is "bring furum's existing, transport-agnostic forum logic into lattice, and unify the plumbing with what lattice already does well."

Owner decisions (2026-10-28): replace furum with no data migration (furum is barely used); v1 is the core forum plus private boards; port furum's server UI rather than build a new JS client; defer paid boards, the cross-ship registry/directory, push notifications, and feed syndication.

## Goals

- Lattice gains a forum capability: create boards, post threads (link and/or text), reply in threaded comments, vote, with HN-style ranking and pagination.
- Cross-ship posting: a member on another ship posts to a board hosted here, with authorship taken cryptographically from the Ames transport, never self-reported.
- Moderation: board roles (`%mod` / `%poster` / `%reader`), delete post/comment, pin, board sidebar, edit board info, auto-prune, plus lattice's existing banlist.
- Public boards: world-readable over peer-to-peer scry and the open web (clearweb), read-only to anonymous visitors, themed like the rest of a lattice site.
- Private boards: readable and postable only by invited member ships. The owner invites; non-members cannot read or post.
- The forum is served by furum's ported Sail renderer, inside lattice's web serving.
- Furum the app is retired (moon agent suspended, desk no longer published), with nothing migrated.

## Non-goals

- Paid boards (furum's Cashu + Lightning ecash gating and the payment/wallet/mint fibers). Deferred; the private-board access mechanism is the non-paid subset of the same gating.
- The cross-ship registry / directory (board discovery across ships). Deferred. v1 boards are reached by their `urb://` address or an invite, not browsed in a directory.
- Push notifications (kernel `/sys/push`). Deferred. In-app notes may still be stored; browser push is out.
- Feed syndication (HN top posts, S2 Underground RSS into a board). This does NOT exist in furum (it is the owner's external cron today), so it is net-new and out of v1. The external cron keeps working.
- Furum data migration. A clean break, consistent with furum's own dropped Phase 6.
- A native lattice JS-SPA board UI. v1 uses the ported Sail renderer.

## Anti-goals

- Do not grow the forum out of the reader-comment model. Comments stay what they are (flat page comments); the forum is its own model.
- Do not lose furum's scale fix. Posts are stored in buckets of 100 by id. One grub per post gave a 68s board reload at 2,500 posts; bucketing gave 8s. The port keeps the bucketing.
- Do not add a second writer, inbox, banlist, or clearweb. The forum unifies onto lattice's single-writer fiber, its `/public` poke-road inbox pattern, its `/banned` list, and its clearweb serving. One app, one set of plumbing.
- Do not trust any author field in a poke payload. Authorship is always `get-poke-src:io`.
- Do not expose private-board content in `/public`. Private content is reachable only through a named group's peek road.

## Constraints

- Grubbery nexus, in the lattice desk (`code/nex/lattice/app.hoon` + `code/lib/*.hoon`). Desk release: bump `code/version.json`.
- Single-writer rule: every mutation is a poke to lattice's writer fiber at `/main.sig`, serialised. Forum actions join the existing `eval-action` dispatch, not a new writer.
- Every road a fiber uses must appear in lattice's `weir.json`. The writer itself must send `/public` and group grants through the registry (`send-public-how`), because the kernel drops a `%how` from any other fiber.
- Persisted forum grubs are noun passthroughs tagged `[%1 shape]`, read back with `;;` under `mule`, matching both furum's and lattice's conventions.
- Posts bucketed 100 per bucket by id (furum's `furum-board` bucketing), reused verbatim.
- Authorship from `get-poke-src:io`. Refusals return a note to the poster (furum's behavior), not a silent drop.
- Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, Doom commit-msg lint (valid type, no scope except `ci`, subject <=72, body wrapped <=72). Prose and comments: no em-dashes; never hard-wrap markdown.
- Verify on fake ships; cross-ship posting needs two ships (one hosts, one posts).

## The design (decisions made)

### One nexus, forum logic mostly in libraries

Boards live in the lattice nexus state, and the forum is part of the lattice app, not a sibling nexus. That is what "a lattice feature" means and it is what unifies the inbox, banlist, groups, clearweb, and theme.

To keep lattice's `app.hoon` from ballooning, the bulk of furum's logic moves in as LIBRARIES and lattice's `app.hoon` adds thin wiring:

- Port `furum-types`, `furum-board` (bucketing, clamming, board assembly), `furum-rules` (roles, caps, rate limits, `get-role`, `can-post`, `can-delete`, `sane-post`), and the Sail renderer (`furum.hoon`'s `render-*`) into `code/lib/` as `lattice-forum-*.hoon`, transport-agnostic and framework-independent, as they already are.
- `app.hoon` adds: the forum web routes, the forum inbox apply, and the forum `eval-action` cases, each a thin call into the libs. The pure transition `+act` and the state assembly `+load` come across as lib functions.
- Drop on the way in: the payment libs (`cashu.hoon`, pay/wallet/mint grubs and fibers), the registry lib and `dir.sig`, the follows/cache mirror grubs, and the push/outbox notification fibers. Those are the deferred non-goals.

### State layout

Forum state sits under a `/forum` root in the lattice nexus, adapted from furum's layout (migration doc lines 85-125), minus the deferred pieces:

```
/forum/boards/<name>/card          board-info (name, title, description, created, default-role, public)
/forum/boards/<name>/roles         (map @p role)
/forum/boards/<name>/conf          next-post-id, prune policy
/forum/boards/<name>/content/posts/b<k>     bucket of 100 posts by id
/forum/boards/<name>/content/threads/b<k>   bucket of 100 comment-trees by post-id
/forum/boards/<name>/content/votes/b<k>     bucket of vote sets
/forum/boards/<name>/content/pins, /sidebar
/forum/members/<name>              (set @p) the member roster a private board's inbox checks
/forum/seen                        per-board read high-water (unread)
/forum/limits                      per [ship board] rate-limit state
```

All `[/ %noun]` grubs holding `[%1 shape]`. `+load` assembles the in-memory board from the grubs; the writer deep-peeks, applies a pure `+act`, and rewrites only the changed grubs (furum's proven shape).

### Cross-ship posting, unified onto lattice's inbox pattern

Furum's `inbox.sig` poke and lattice's `/comments.sig` poke are the same shape: a public poke road, a fiber looping `take-poke-from:io`, an apply arm that reads the author from the transport and checks a banlist and host state, per-author and per-container caps, and a cull-on-ban. The forum reuses this exactly.

- Add a forum action poke to lattice's `/public` poke set via `send-public-how`, on a new `/forum.sig` road (resolution 6). The action union is furum's `action` (create/delete-board local-only, new-post, edit-post, delete-post, new-comment, delete-comment, vote actions, pin, set-sidebar, set-public), minus the payment and follow actions.
- The apply arm stamps `author = get-poke-src:io`, checks lattice's `/banned` (reuse `is-banned`, `family`), then furum's role and caps checks (`furum-rules`), then applies the pure `+act` and writes the changed grubs. Board-level actions (create/delete board, set-role, set-public) require `src == our` as in furum.
- Refusals return a note to the poster (furum's behavior), carrying why. This is better than lattice's silent comment drop and is kept for the forum.
- Outbound: the posting ship uses an owner-gated route on its own ship (the shape of lattice's `/comment-remote`: resolve the host's lattice base with `peer-base-cached`, `remote-load-poke-wait` to the host's forum inbox road, a bounded wait). Reuse that client pattern.

### Private vs public boards

`board-info.public` already exists. It drives where content lives and who may read, and the role model drives who may post.

- **Public board:** `public: true`. Content grubs are added to `/public`'s peek set (like a published page's `data` road), so anyone may read over peer scry and clearweb. Posting is open to `default-role` (typically `%poster`) with the usual caps and rate limit.
- **Private board:** `public: false`. Content grubs are NOT in `/public`. Reading is gated by a named lattice group (grubbery usergroup) whose peek roads cover `/forum/boards/<name>/content/`. Only ships in that group can read; everyone else gets a weir 403, enforced by grubbery, not by app code. This is exactly furum's member-gated `content/` split used for paid boards, with membership granted by invite instead of payment.
- **Posting to a private board:** the inbox poke road is public (any ship can send a poke), so the apply arm refuses a poke from a ship not in `/forum/members/<name>` (or without a posting role) with a note. Reading restriction is the weir; posting restriction is the role/member check in apply.
- **Invites:** the owner adds a ship to the board's member group (reuse `/share-file` / `share-group-save` to lay the peek road) and to `/forum/members/<name>`, and the invitee receives a shares-inbox notice ("invited to board X") via the existing `/shares.sig` path. Joining a public board needs no invite.

### Reading and serving (ported Sail UI)

- The forum UI is furum's server-rendered Sail (`render-*` in the ported `lattice-forum-render` lib): board list, a board's ranked post list with pagination (`per-page 30`, `?page=`), a thread view (post plus its comment tree), and the submit and mod views. Served by lattice's authed web fiber under a forum route (for example `/apps/lattice/b/<host>/<name>[/<post-id>]`, mirroring furum's scheme), owner-and-member gated.
- **Public clearweb read:** an unauthenticated GET of a public board (and its threads) is served read-only, the way lattice's `/c/` clearweb serves a `%clearweb` page, with the nearest board theme linked in the head. Anonymous visitors read but cannot post (same as furum's `serve-public` and lattice's clearweb).
- **Live refresh:** a `/beacon/forum` stamp (json `now`), bumped by the writer on any forum change, is polled or streamed over SSE the way lattice's `/beacon/*` stamps already drive live updates. This replaces furum's subscription/update-kind machinery with lattice's existing idiom.

### Moderation and scale

- Roles, delete post/comment (author or mod), pin, sidebar, edit board info, `set-public`, and auto-prune (min-score plus age, on a timer `sweep` fiber) come across from furum. Lattice's banlist extends: `cull-comments-of` grows a sibling that also culls a banned ship's forum posts and comments, and `strip-ship-from-groups` already removes them from member groups.
- Bucketing (100 posts) and the exact-integer HN hot score come across verbatim from `furum-board` and `furum-rules`. No search (furum has none; out of scope).

### Retiring furum

After the lattice forum ships and is verified, furum is decommissioned: the `%furum` moon Gall agent is suspended and the furum desk is no longer published. No data moves. This mirrors furum's own planned Phase 7 cutover, now redirected into lattice.

## Builder-check resolutions (my calls, flagged for the owner to check while reading)

1. **Public peek scaling.** One directory road per public board (`/forum/boards/<name>/content`) joins `/public`. `send-public-how` re-sends its `%how` only on board create, delete, or `set-public`, never per post. No per-bucket or per-thread roads.
2. **Private-board groups.** One grubbery usergroup per private board (name e.g. `forum-<name>`), its peek road the board's `content` dir. Revoke a member or close the board by rewriting that group's road set (empty to close), as furum does. A ban strips the ship from its member groups AND from `/forum/members/<name>`.
3. **Tree, weir, backup.** `/forum` grubs are owner-only by default (the `/page` rule); only a public board's `content` is exposed, via the `/public` peek road. `/forum` joins lattice's carry/backup list so forum data is backed up. The forum reuses lattice's EXISTING usergroup machinery (lattice already creates groups for shares), so no new group-creation weir road is introduced; the `/forum.sig` poke road joins `/public` through `send-public-how`, not `ask.json`. So no new consent prompt is expected. The builder confirms whether any genuinely new weir road appears and, if so, treats the resulting prompt as a deliberate release decision.
4. **Concurrency.** Forum applies run on lattice's single `/main.sig` writer and may briefly block page saves (worst case the ~8s deep-peek of a 2,500-post board). Acceptable for v1 because the forum is low-traffic. The upgrade path, if throughput ever matters, is a forum-apply fiber that hands finished writes to the writer. Known ceiling, not built now.
5. **Lib strip on lift.** Drop `cashu.hoon`, the push service worker, and `furum-icon`. Trim the board card to `[%1 board-info]` (drop `payment`, the `%set-payment` case, the `can-post` payment gate, and the follow/submit-payment/melt members of the `action`, state, and restore types). Drop `furum-theme.hoon`; lattice's nearest-ancestor `theme` css head wins for board rendering.
6. **Inbox and failure model.** A NEW `/forum.sig` public poke road (not an overload of the comments road), added to `send-public-how`'s poke set. A refusal returns to the poster as a note (furum's pattern), riding `/forum.sig` back to the poster's ship, which has the same road because it runs the same code. The owner-gated client route on the posting ship surfaces accepted-vs-refused within the bounded wait.
7. **Routing.** Forum under `/apps/lattice/b/<host>/<name>[/<post-id>]`. The anonymous public-board read reuses `serve-clearweb`'s renderer path and the nearest board `theme` head.
8. **Live refresh.** A single global `/beacon/forum` stamp (json `now`) added to `/streams`. No per-board stamps in v1.
9. **Retiring furum.** A documented cutover checklist (suspend the `%furum` moon Gall agent, stop publishing the furum desk). The owner runs it out of band after the lattice forum is verified, like a gated deploy. No code or data migration.

## What is left to the builder

- Exact lib boundaries and names for the ported `lattice-forum-*` files, and the thin `app.hoon` wiring (routes, inbox apply, `eval-action` cases) that calls them.
- The exact `send-public-how` poke-set change that adds the `/forum.sig` road (resolution 6), and the note-back wiring for refusals.
- The precise forum route paths under `/apps/lattice` and how the clearweb public-board read reuses `serve-clearweb` / the theme head.
- The member-group naming and the invite flow wiring onto `/share-file` + `/shares.sig`, and the apply-arm member/role check for private-board posts.
- The `/beacon/forum` stamp wiring and which SSE stream in `/streams` carries it.
- The prune/sweep timer fiber shape in the lattice nexus.
- Tests on two fake ships: create a public and a private board; a member on ship B posts a thread and a reply to each board hosted on ship A (authorship stamped from transport); a non-member is refused on the private board (read 403 by weir, post refused by the apply check) and allowed on the public one; votes and ranking order; pagination past 100 posts (bucket boundary); clearweb read of a public board by an anonymous visitor; a ban culls the banned ship's posts; furum's role, caps, and rate-limit checks hold.
