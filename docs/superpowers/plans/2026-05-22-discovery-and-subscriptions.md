# Discovery + Subscriptions — Plan (post-investigation)

> Adds a **"follow"** layer to lattice: find other publishers (via contacts) and
> get **pushed** when a followed file changes (via remote scry). Chosen
> directions: **contacts probing** for discovery, **remote-scry
> revision-following** for notifications.

## Investigation findings (verified 2026-05-22 against live ~zod/~tyr)

1. **Pending keens resolve on publish → true push works.** A `%keen` for an
   *unpublished* path does **not** return "absent" — it **pends**, and resolves
   when the publisher binds the path. Verified: `~zod` fetched
   `urb://~tyr/pushtest` (absent) → request hung; `~tyr` then published it →
   `~zod`'s request resolved with the new content (HTTP 200). So a follower can
   "subscribe" by keening and waiting — **no polling required**.
2. **Latency ≈ 30s.** The pending keen resolved ~26–31s after publish — Ames's
   retry cadence, not instant. Fine for file-change notifications (not chat).
3. **Re-keening an already-published path is immediate** (0.06s, cached latest).
   ⇒ to be notified of a *change* (not just first publish), the follower must
   keen the **next revision**, not the same path. The current `keen-path`
   hardcodes `//1`, which returns "latest"; following changes needs the per-file
   **aeon** in the scry path. **Exact revision encoding is the one open detail**
   (resolve by reading gall's publication scry interface during impl).
4. **%contacts is installed** (on the `groups` desk). Rolodex scry:
   `[%x %v1 %all ~]` (JSON at `/x/v1/all` → `/v1/all/json`). Empty `{}` on a
   fresh fakezod; populated map of `ship → contact` on a real ship.

## Design

### Discovery — contacts probing (+ manual follow-list fallback)
- **Desk**: `GET /apps/lattice/contacts` → agent scries its own `%contacts`
  (`.^(... %gx .../contacts/.../x/v1/all ...)`), extracts patps → `{"ships":[…]}`.
  Returns `{"ships":[]}` (not an error) when contacts is empty/absent.
- **App**: fetch the contact ships, then probe each by `fetch urb://~ship/`
  (reuses the existing endpoint); show responders as "publishes with lattice"
  with one-tap **Follow**. Probes run in parallel with a short timeout.
- **Fallback / always-available**: a manual **follow-list** (add a ship by patp),
  stored in `%settings` (syncs across installs, like themes/bookmarks). Doubles
  as the webring substrate for later.

### Subscriptions — remote-scry push via the local agent + SSE
- **Local agent state**: `subs: (map [=ship spur=path] last=@ud)` (last seen
  revision), mirrored to `%settings` for cross-install sync.
- **Follow a path**: keen the path; on resolve, record content + revision, then
  **keen the next revision** (pends until the publisher next `%grow`s it).
- **On resolve** (a change): the agent emits a `%fact` to app subscribers and
  immediately re-arms the next-revision keen. (Cancel/`%yawn` on unfollow.)
- **Publisher side**: no per-subscriber state needed — followers just keen;
  content is content-addressed so many followers share Ames caching.
- **App delivery**: the app opens an Eyre **channel** and subscribes to its
  *local* `%lattice` on `/updates`; on a fact it marks the tab/bookmark
  "updated", shows an in-app badge, and fires an OS notification
  (desktop tray / Android notification).

## App work: the SSE channel client
Push requires the piece left out of the `%settings` work: lift talon's
`UrbitChannel` (poke + subscribe + SSE via okhttp-sse) into the app. Used only
for the `/updates` subscription; fetch/save/settings stay plain HTTP.

## Storage
Follow-list + per-path subscriptions live in `%settings`
(`desk lattice / bucket follows|subs`), so they sync across the user's installs
exactly like saved themes — reuse `SettingsClient`.

## Revision encoding — RESOLVED (verified 2026-05-22)
- The segment after `//` in `/g/x/1/lattice//<rev>/<spur>` **is the revision**:
  keening `rev=1` of `~tyr/pushtest` returned immediately; `rev=2`/`rev=3`
  (unpublished) **pended**. `keen-path`/`keen-card` now take a `rev` arg
  (lib/lattice.hoon); an optional `&rev=N` on `/fetch` was added to probe this.
- **Follow loop** (confirmed mechanism): track `last` rev per sub; keen
  `rev=last+1`. Existing revs resolve immediately (catch-up); the first
  unpublished rev pends and resolves when the publisher `%grow`s it → push,
  then `last+1` and re-arm.
- **Caveat**: the publisher must run a lattice that re-`%grow`s on content
  change (our `sync-cards` does; `~tyr`'s older build did not — its `rev=2`
  never appeared). Following only works against change-republishing publishers.
- Default `/fetch` still requests `rev=1`, which is the *first* publication —
  a latent "cross-ship shows the original, not the latest" issue to address
  (the browser should fetch the latest rev; needs a "current rev" query).

## Phasing
1. **Discovery**: `/apps/lattice/contacts` endpoint + manual follow-list (in
   `%settings`) + a "Follow / Discover" view in the app. (No SSE needed yet.)
2. **SSE channel client**: lift `UrbitChannel`; subscribe to local `/updates`;
   in-app "updated" badges.
3. **Subscriptions in the desk**: `sub`/`unsub` pokes; the next-revision
   keen-follow loop (resolve encoding); emit `%fact` on change.
4. **OS notifications** (desktop tray / Android) + an updates/feed view.

## Risks
- **Revision encoding** (above) — the only real unknown; poll fallback de-risks.
- **~30s push latency** — acceptable here; document it.
- **Keen lifecycle** — must `%yawn`/cancel keens on unfollow and re-arm after
  each resolve to avoid leaks; bound the number of concurrent follows.
- **Empty/absent %contacts** — handled by returning `[]` + the manual list.
