# Lattice forum feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold furum's forum capability into the lattice nexus as a feature: boards, threaded posts, votes with HN ranking, moderation, cross-ship posting, public clearweb read, and private (invite-only) boards, reusing furum's transport-agnostic logic as ported libraries.

**Architecture:** Port furum's pure logic (types, bucketing, rules, state transition, Sail renderer) into `code/lib/lattice-forum-*.hoon`, stripped of the deferred pieces (payment, registry, push, follows, furum theming). Add thin wiring in `code/nex/lattice/app.hoon`: `/forum` nexus state, writer `eval-action` cases, a `/forum.sig` cross-ship inbox, public-board publish via `send-public-how`, private-board group gating, the Sail web routes, a `/beacon/forum` live stamp, ban-cull and prune. One nexus, one writer, one inbox pattern. Furum the app is retired with no data migration.

**Tech Stack:** Hoon, grubbery nexus. Ported furum libraries from `/home/sneagan/software/personal/furum` (`desk/sur/furum.hoon`, `code/lib/furum-{types,board,rules}.hoon`, the Sail renderer in `code/lib/furum.hoon`). Tests: hoon-test-kit (`docs/hoon-testing.md`) for pure libs; fake-ship integration for wiring; two fake ships for cross-ship.

**Spec:** `docs/superpowers/specs/2026-10-28-lattice-forum-design.md` (mirror: lattice wiki `specs/2026-10-28-lattice-forum`). Read it with this plan; it argues the architecture and records 9 builder-check resolutions this plan treats as binding.

## Global Constraints

- Hoon only, in the lattice desk: new `code/lib/lattice-forum-*.hoon` libs and wiring in `code/nex/lattice/app.hoon`. Desk release: bump `code/version.json` as the final step.
- Single writer: every mutation is a poke to lattice's `/main.sig` writer, serialised, via the existing `eval-action` dispatch. No second writer.
- Every fiber road appears in lattice's `weir.json`. `/public` and group grants are sent only by the writer, through the registry (`send-public-how`); the kernel drops a `%how` from any other fiber.
- Persisted forum grubs are `[/ %noun]` holding `[%1 shape]`, read back with `;;` under `mule`. The board card is `[%1 board-info]` (payment stripped; never `[%2 ...]`).
- Posts stored in buckets of 100 by id (furum's `furum-board` bucketing), reused verbatim. Do not regress this (68s -> 8s reload at 2,500 posts).
- Authorship is always `get-poke-src:io`, never a payload field. Refusals return a note to the poster, never a silent drop. The writer NEVER crashes: a bad poke is refused, not a fault.
- Strip on port (resolution 5): drop `cashu.hoon`, the push service worker, `furum-icon`, `furum-theme.hoon`, the registry lib, `dir.sig`, follows/cache grubs, and the payment/follow members of the action, state, and restore types. Board rendering uses lattice's nearest-ancestor `theme` css head.
- Private-board content is never in `/public`; it is reachable only via a per-board usergroup peek road (resolution 2).
- Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, Doom commit-msg lint (valid type, no scope except `ci`, subject <=72, body wrapped <=72). No em-dashes; never hard-wrap markdown.
- Verify on fake ships; cross-ship tasks need two lattice ships (one hosts, one posts).

## Review Focus

- **Authorship spoofing:** a forum poke whose payload carries a fake `author` must be stamped with the Ames transport source, not the payload. Pinned in Task 7.
- **Private-board leak:** an anonymous or non-member read of a private board must 403/404 (weir), and a non-member post must be refused; neither may expose content. Pinned in Task 9.
- **Banned ship:** a ban culls that ship's existing posts and comments across all boards AND future posts are refused. Pinned in Task 11.
- **Bucket boundary:** post 101 lands in a new bucket and pagination reads correctly across the boundary. Pinned in Task 2 (unit) and Task 10 (integration).
- **Writer survives bad input:** a malformed poke (unknown board, bad id, oversize body, non-existent parent comment) is refused with a note and never faults the writer. Pinned in Task 7.

---

### Task 1: Port and strip the forum types

**Files:**
- Create: `code/lib/lattice-forum-types.hoon`
- Reference: furum `desk/sur/furum.hoon` (board-info :13-20, board :78-92, post :25-35, comment :39-47, role :9, action :120-167, registry/notification), `code/lib/furum-types.hoon`.

**Interfaces:**
- Produces: `board-info`, `board` (card `[%1 board-info]`), `post`, `comment`, `role=?(%mod %poster %reader)`, `vote-target`, and an `action` union. The `action` union EXCLUDES payment (submit-payment, melt, set-payment) and follow/unfollow members. Keep: create-board, delete-board, set-role, new-post, edit-post, delete-post, new-comment, delete-comment, upvote, downvote, remove-vote, pin-post, set-sidebar, set-public, set-prune.

- [ ] Step 1: Write the types, trimming the board card to `[%1 board-info]` (no `payment`) and the `action`/state/restore molds to drop payment and follow members.
- [ ] Step 2: Compile-check the lib on a fake ship (deploy + `?info=1` bang null), or via hoon-test-kit loading the lib in a test core.
- [ ] Step 3: Commit (`feat: add lattice forum types`).

### Task 2: Port the bucketing and board assembly lib

**Files:**
- Create: `code/lib/lattice-forum-board.hoon`
- Reference: furum `code/lib/furum-board.hoon` (bucketing 100, clamming, `+load` assembly, the `[%2 info payment]` card read — change to `[%1 info]`), migration doc lines 383-401.
- Test: `tests/lib/forum-board-test.hoon` (hoon-test-kit).

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `+bucket-of` (post-id -> bucket key), bucket read/write helpers, `+load` (grubs -> in-memory `board`), and the changed-grub list a write produces. Card read is `[%1 info]`.

- [ ] Step 1: Write the failing unit test: posts 1-100 live in bucket 0, post 101 in bucket 1; `+load` reassembles a board with posts spanning two buckets in id order.
- [ ] Step 2: Run it, expect failure (lib absent).
- [ ] Step 3: Port the lib, dropping the `%2`/payment card path.
- [ ] Step 4: Run the test, expect pass. Compile-check on a fake ship.
- [ ] Step 5: Commit (`feat: port forum board bucketing`).

### Task 3: Port the rules lib (roles, caps, rate limit, ranking)

**Files:**
- Create: `code/lib/lattice-forum-rules.hoon`
- Reference: furum `code/lib/furum-rules.hoon` (`get-role` :7, `can-post`, `can-delete`, `sane-post` caps title 300 / url 2048 / body 40000 / comment 10000, rate limit :131-158, HN hot score), migration doc 707-715.
- Test: `tests/lib/forum-rules-test.hoon`.

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `+get-role`, `+can-post`, `+can-delete`, `+sane-post`, `+rate-ok` (and its cooldown update), `+hot-score`. The `can-post` payment gate (`?~ payment.brd`) is REMOVED; posting is role + caps + rate only.

- [ ] Step 1: Failing unit tests: a `%reader` cannot post and a `%poster` can; `default-role` governs a stranger; `sane-post` rejects an oversize body; the rate limit blocks a second post inside the cooldown and allows after decay; `hot-score` orders two posts by votes-over-age as an exact integer pair.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Port the lib, removing the payment gate.
- [ ] Step 4: Run, expect pass. Compile-check.
- [ ] Step 5: Commit (`feat: port forum rules and ranking`).

### Task 4: Port the pure state transition (+act)

**Files:**
- Create: `code/lib/lattice-forum-act.hoon` (or an arm set in `lattice-forum-board.hoon` if cleaner; builder picks).
- Reference: furum `code/nex/furum/app.hoon` `+act` (the pure transition) and `+apply` structure (`:293`), minus payment/follow cases.
- Test: `tests/lib/forum-act-test.hoon`.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `+act |=([board author=@p action])` -> `[board (list changed-grub)]` or a refusal reason. Pure; no io. Covers new-post (assigns next-post-id), new-comment (parent tree), votes (one per ship, toggle), edit/delete (author-or-mod), pin, set-sidebar, set-public, set-role, set-prune. Board-level actions assume the caller already checked `src == our`.

- [ ] Step 1: Failing unit tests: new-post increments `next-post-id` and lands in the right bucket; new-comment with a parent nests; a second upvote from the same ship is idempotent; delete by a non-author non-mod refuses; set-public flips the flag.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Port `+act`, dropping payment/follow cases.
- [ ] Step 4: Run, expect pass. Compile-check.
- [ ] Step 5: Commit (`feat: port forum state transition`).

### Task 5: Port the Sail renderer

**Files:**
- Create: `code/lib/lattice-forum-render.hoon`
- Reference: furum `code/lib/furum.hoon` `render-*` (board list, post list `per-page 30` `?page=` :665-677, thread view, submit, mod), minus theme/icon/push/registry views.
- Test: `tests/lib/forum-render-test.hoon`.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `+render-board`, `+render-thread`, `+render-list` (paginated), `+render-submit`, `+render-mod`, each `board (and args) -> manx`/`tape`. Takes a theme-css href argument supplied by the caller (lattice's nearest-ancestor theme), instead of furum's own theme lib. Bodies HTML-escaped at render.

- [ ] Step 1: Failing unit test: `+render-list` of a 101-post board shows page 1 of the ranked order and a next-page link; `+render-thread` nests a comment under its parent; a post body with `<script>` is escaped.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Port the renderer, dropping furum-theme (accept a theme href arg) and the registry/payment views.
- [ ] Step 4: Run, expect pass. Compile-check.
- [ ] Step 5: Commit (`feat: port forum Sail renderer`).

### Task 6: Nexus state + writer eval-action cases

**Files:**
- Modify: `code/nex/lattice/app.hoon` — `on-load` `%fall` block (declare `/forum` defaults near `/pub/meta`), `eval-action` mold (`code/lib/lattice-eval.hoon`), `apply-action` (`:4745`).
- Reference: design "State layout"; furum `+load`/`+apply` for the deep-peek-then-write shape.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `/forum/boards/<name>/{card,roles,conf,content/...}`, `/forum/members/<name>`, `/forum/seen`, `/forum/limits` as covering `%fall` grubs. New `eval-action` cases (`%forum-board`, `%forum-post`, `%forum-vote`, `%forum-mod`, ...) that deep-peek the board via `+load`, call `+act`, and write only the changed grubs. Board-level actions gate `src == our`.

- [ ] Step 1: Failing fake-ship test: a local owner poke creates a board; a second poke posts a thread; reading `/forum/boards/<n>` back via `+load` shows the post in bucket 0.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Declare the `/forum` `%fall` grubs and add the `eval-action` cases calling `+act` + changed-grub writes.
- [ ] Step 4: Run, expect pass. `?info=1` bang null.
- [ ] Step 5: Commit (`feat: forum nexus state and writer actions`).

### Task 7: Cross-ship inbox (/forum.sig)

**Files:**
- Modify: `code/nex/lattice/app.hoon` — add the `/forum.sig` poke road to `send-public-how`'s poke set (`:11364` area); add the inbox fiber (mirror `/comments.sig` at `:378`); the apply arm (mirror `apply-comment-notice` `:7697`).
- Reference: design "Cross-ship posting"; lattice `/comments.sig` + `/comment-remote` (`:2726`), `is-banned`/`family`.

**Interfaces:**
- Consumes: Tasks 1-4, 6.
- Produces: the `/forum.sig` inbox loop (`take-poke-from:io`); the apply arm stamps `author = get-poke-src:io`, drops banned ships, runs `+can-post`/`+sane-post`/`+rate-ok`, calls `+act`, writes grubs, and returns a refusal NOTE on any refusal; the owner-gated outbound client route (`POST /forum-post-remote?host&board&...`) mirroring `/comment-remote` (`peer-base-cached` + `remote-load-poke-wait`, bounded wait).

- [ ] Step 1: Failing cross-ship test (two ships): ship B posts a thread to a public board on ship A; A stores it with `author = ~B` even when B's payload names a different author; a poke from a banned ship is dropped; an oversize body and a bad board name are each refused with a note and the writer stays healthy.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Add the road to `send-public-how`, the inbox fiber, the apply arm (author from transport, banlist, rules, refusal note), and the outbound route.
- [ ] Step 4: Run, expect pass. `?info=1` bang null on both ships.
- [ ] Step 5: Commit (`feat: forum cross-ship inbox`).

### Task 8: Public board publish and clearweb read

**Files:**
- Modify: `code/nex/lattice/app.hoon` — extend `send-public-how` to add a public board's `content` dir road on create/`set-public` (remove on delete/unset); the clearweb reader (`serve-clearweb` `:9357`) to serve a public board and its threads through `lattice-forum-render` with the nearest `theme` head.
- Reference: design "Reading and serving"; `apply-share`/`apply-pub`, `serve-clearweb`.

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces: a public board's `content` peek road in `/public`; an unauthenticated `GET` of a public board (and a thread) rendered read-only; a private board is NOT in `/public` and its clearweb read 404s.

- [ ] Step 1: Failing test: an anonymous fetch of a public board renders its ranked list; an anonymous fetch of a private board 404s; the public board's content road is present in `/public` after `set-public` and gone after unset.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Wire the `send-public-how` road change and the clearweb render path.
- [ ] Step 4: Run, expect pass.
- [ ] Step 5: Commit (`feat: public forum boards over clearweb`).

### Task 9: Private boards (membership, invite, gating)

**Files:**
- Modify: `code/nex/lattice/app.hoon` — per-board usergroup create/revoke (reuse `share-group-save`/`ug-put`), `/forum/members/<name>` maintenance, the invite notice (reuse `/share-file` + `/shares.sig`), and the apply-arm non-member refusal for private boards.
- Reference: design "Private vs public boards" + resolution 2; lattice groups, `/shares.sig` (`apply-share-notice` `:7648`).

**Interfaces:**
- Consumes: Tasks 6, 7.
- Produces: `POST /forum-invite?board&ship` (owner) adds the ship to the board group (peek road = the board `content` dir) and `/forum/members/<name>`, and pokes the invitee's `/shares.sig` with a board-invite notice; the inbox apply refuses a post to a private board from a ship not in `/forum/members`; reading is enforced by the group weir.

- [ ] Step 1: Failing cross-ship test: on a private board hosted by A, a non-member B is refused a read (weir 403) and a post (apply refusal note); after A invites B, B can read and post; B appears in A's shared-with-me style invite inbox.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Wire the group create/membership, the invite route + notice, and the private-board apply check.
- [ ] Step 4: Run, expect pass.
- [ ] Step 5: Commit (`feat: private invite-only forum boards`).

### Task 10: Web routes and authed Sail serving

**Files:**
- Modify: `code/nex/lattice/app.hoon` — the authed web fiber: routes `/apps/lattice/b/<host>/<name>[/<post-id>]`, `/submit`, `/mod`, `/create`, owner-and-member gated, wired to `lattice-forum-render`; the owner UI entry (a link from lattice's existing nav; builder picks the minimal touch).
- Reference: design "Reading and serving"; furum route table; lattice web fiber + owner gate (`:1273`).

**Interfaces:**
- Consumes: Tasks 5, 6, 9.
- Produces: the authed forum views for the owner and members, paginated; a submit action that pokes the writer; a mod view for role/pin/delete.

- [ ] Step 1: Failing test: the owner GETs a board view and sees the ranked list and a thread; pagination past 100 posts shows page 2 in order; a member sees a private board, a non-member is gated out.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Add the routes + render wiring + submit poke.
- [ ] Step 4: Run, expect pass.
- [ ] Step 5: Commit (`feat: forum web routes`).

### Task 11: Live refresh, ban-cull, prune

**Files:**
- Modify: `code/nex/lattice/app.hoon` — `/beacon/forum` stamp (bump on any forum write) + a `/streams` entry; extend the ban path (`cull-comments-of` `:9191` sibling) to cull a banned ship's forum posts/comments; a prune/sweep timer fiber (min-score + age, 6-hour grid).
- Reference: design "Moderation and scale"; lattice `/beacon/*` + `/streams` (`:2156`), `POST /ban` (`:1999`), furum prune.

**Interfaces:**
- Consumes: Tasks 6, 7.
- Produces: a global `/beacon/forum` json-`now` stamp in `/streams`; `cull-forum-of` run from the ban path; a `forum-sweep` timer that prunes low-score aged posts.

- [ ] Step 1: Failing test: a new post bumps `/beacon/forum`; banning a ship removes its posts and comments from every board and future posts are refused; a post below min-score and past the age is pruned on a forced sweep.
- [ ] Step 2: Run, expect failure.
- [ ] Step 3: Wire the beacon, the ban-cull extension, and the sweep timer.
- [ ] Step 4: Run, expect pass.
- [ ] Step 5: Commit (`feat: forum live refresh, ban-cull, prune`).

### Task 12: Cutover docs, version bump, end-to-end

**Files:**
- Create: `docs/forum.md` (the cutover checklist: suspend the `%furum` moon Gall agent, stop publishing the furum desk; no data migration).
- Modify: `code/version.json` (bump to the next number above current `origin/main`).

- [ ] Step 1: Write `docs/forum.md` with the owner-run cutover checklist and the feature overview.
- [ ] Step 2: Full two-ship end-to-end: create public + private boards on A; B posts threads and replies to both (authorship from transport); non-member refused on the private board, allowed on the public; votes order by ranking; pagination crosses the bucket boundary; anonymous clearweb reads the public board; a ban culls; role/caps/rate-limit hold. `?info=1` bang null on both ships; no regression in lattice's existing page/comment/clearweb suites.
- [ ] Step 3: Bump `code/version.json`.
- [ ] Step 4: Commit (`release: N, host forums in lattice`). Stop. Do NOT push, merge, or deploy to ~ricsul-bilwyt or retire furum without an explicit go.

## Self-Review

- **Spec coverage:** boards/posts/comments/votes/ranking -> Tasks 1-6; cross-ship posting -> Task 7; public clearweb -> Task 8; private boards -> Task 9; Sail UI + routes -> Tasks 5, 10; moderation/ban/prune/live -> Task 11; retire furum + release -> Task 12. The strip list (resolution 5) is applied in Tasks 1-5. The deferred non-goals (payment, registry, push, feed) appear in no task. Covered.
- **Type consistency:** the ported types (Task 1) thread through board (2), rules (3), act (4), render (5), and the wiring (6-11). The card is `[%1 board-info]` everywhere; the `action` union excludes payment/follow throughout.
- **Review Focus:** authorship-from-transport + writer-survives-bad-input (Task 7), private-board leak (Task 9), banned ship (Task 11), bucket boundary (Tasks 2 and 10). Each has an owning task and a test.
- **Proportion:** the plan names libs, arms, wiring points, and tests, and points each port at its furum source; it does not transcribe furum's Hoon. The pure-lib tasks carry hoon-test-kit tests; the wiring tasks carry fake-ship integration tests.
- **Ordering:** pure libs (1-5) before wiring (6-11); types (1) first; inbox (7) after state (6); private boards (9) after inbox (7) and public (8); routes (10) after render (5) and private (9); release (12) last. Cross-ship tasks (7, 9, 12) need two lattice ships at execution time.
