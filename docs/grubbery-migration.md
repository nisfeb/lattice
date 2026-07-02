# Migrating lattice state & access control to grubbery

> ⛔ **SUPERSEDED — historical design record, not the operative plan.** This doc
> describes the **vault-first adapter** migration (keep the `%lattice` gall agent
> as a façade; move state into grubbery behind `know-where`/`know-cutover`/
> `know-rollback` flags with dual-write). That approach was **retired** in favor of
> a from-scratch **native-nexus rewrite** — lattice is now a grubbery nexus
> (`grubbery-overlay/nex/lattice/`), and the `*-where`/`*-cutover`/`*-rollback`
> flag scaffolding described below **does not exist** in it. **To actually perform
> the migration, use [`cutover-runbook.md`](./cutover-runbook.md).** Keep this file
> for the design reasoning and the verified grubbery-mechanics research only.

Status: **proposed plan, unblocked** — researched 2026-06-11 against grubbery @
`~/software/groundwire/grubbery` and lattice 0.6.1. Every load-bearing claim about grubbery below
was checked against its source; the four that came back "true, with corrections" are folded in,
and the two still unverified are flagged inline.

> **Update 2026-06-11 (grubbery `04f3781`)** — the two security blockers this review found are
> **fixed upstream** by the grubbery dev and re-verified against source:
> 1. Cross-ship `%peek`/`%want`/`%keep` now run through `allowed:hc` — the *same* weir chain that
>    gates writes — so remote reads are gated identically to writes (no more bypass). Content
>    negotiation split into a `grubbery-transfer` mark, with **containment** (a `%want` only
>    serves lobes reachable from the claimed dest) and **unsolicited-`%snap` rejection`.
> 2. The `%data` merge now **hash-verifies** every incoming noun/ject (`sham` re-check, mismatch
>    dropped), closing the cache-poisoning gap.
>
> Net effect: phase 1's private-vault privacy model is now sound (weirs gate reads), and phase 2's
> public-sync trust model is sound (hashes verified). Stage 0a's "cross-ship read gate" is no
> longer downstream surgery — it's upstream and done; our job shrinks to *configuring* weirs and
> *probing* that the gate holds. Sections below are annotated `RESOLVED` where this applies.

> **Update 2026-06-26 (grubbery `a8d7738`)** — large refactor since `04f3781`. Re-verified
> against source; **the no-data-loss-critical mechanics are unchanged** and the plan stands, with
> these adjustments. **Floor: pin grubbery ≥ `a8d7738`.**
> - **`%over` dart removed** (`be75667`) — updates now use `%make` with `force=%.y` (overwrites
>   content, history preserved exactly as before). Every "`%over`" in this doc means
>   "`%make force=%.y`" now: the vault-manager's save path and the adapter's autosave path.
> - **History view renamed `born/hist` → `wave`** (`b8962f6`): a `wave` is `(axal [fold=cass
>   file=(map @ta cass)])`. The *persistence* underneath is unchanged — `pace` is still
>   `[%firm | %temp | %tomb]`, gain=%.y still writes `%firm` (kept forever), `%cull` still tombs
>   without dropping prior `%firm` revisions, and `%peek` with `case` still reads historical
>   versions. Where this doc says `born`, read "the persistent hist/silo behind `wave`."
> - **make-after-delete fixed** (`3124505`) — re-creating a culled path used to be buggy; now
>   sound. This is **load-bearing for restore and for trash import** (make→cull), and a reason the
>   `≥ a8d7738` floor is a hard gate, not advisory.
> - **`replace:io` takes a noun, not a vase** (`d9f7053`); state-validation failures now **rise
>   (restart the process), not crash the event** — safer for the vault-manager. `on-manu` is
>   replaced by a **`/man/` directory** convention (`feb3454`) — the nexus ships docs as files,
>   no `on-manu` arm.
> - **Subscriptions: `%bond`/`%wave` merged into `%news`, `%miss` added for expired snaps**
>   (`20a0604`); **`afar` removed**, snap-pinning + silo refcounting added (`61f0a04`). Affects
>   only phase-2 watcher fibers (`pub.sig`), not phase 1.
> - **Cross-ship read gate hardened further** (`80b5aed`: veto/tomb responses, weir propagation) —
>   invariant 5 still holds; re-run the foreign-read probe against `a8d7738`.

## Decision

Migrate **vault-first**: move exactly one subsystem — the private knowledge store
(`know`/`trash`/`tags`) — into a grubbery-governed tree at `/lattice/know`, behind the existing
`%lattice` gall agent acting as a façade. Publication (`%grow`/`%cull`, manifest, home), follows,
subscriptions, fetch walks, and the catalog crawler **do not move** in stage 1; stages 2–3 are
pre-defined mechanical seams with their own decision gates.

Why this subsystem first:

- It is where grubbery genuinely replaces hand-rolled machinery: grubbery's append-only version
  history (`born`/`silo`) makes our trash/restore maps redundant and gives every note a full,
  per-save revision history for free — plus point-in-time reads (`%peek` with `case=[%ud rev]` or
  `[%da date]`) and range pruning (`%lose`).
- It has **zero coupling to either external contract**. The Kotlin app only sees `/apps/lattice`
  HTTP endpoints (which stay in the agent), and the ship-to-ship remote-scry/follow/manifest
  protocol never touches the knowledge store (`know` is never grown — `sur/lattice.hoon:88-93`).
- The agent's `+do-know` action vocabulary is already a single funnel, so the adapter seam exists
  today.

Two alternative designs were considered and judged (an everything-at-once adapter, and a full
native rewrite of lattice as a grubbery nexus subtree). Vault-first won unanimously on
feasibility, compat, and data safety; the best ideas from the losers are grafted in below
(batched import, dual-write shadow window, parity verification, weir audit, stage-2 publication
blueprint).

## Grubbery in one page (verified semantics)

- **Tree**: the visible filesystem (`ball`, an `(axal lump)`) is *derived*. Persistent truth is
  `born` (per-node version history: a mop of `cass → pace`) plus `silo` (refcounted
  content-addressed noun store). Both live in grubbery's gall agent state and survive
  save/load/upgrade (`app/grubbery.hoon` state-0; on-load restores, recompiles code, re-runs
  nexus on-loads, respawns fibers).
- **Versioning**: each write appends a `pace` — `%firm` (kept forever), `%temp` (tombed on next
  write, silo refs dropped), `%tomb`. The **`gain` flag decides firm vs temp and it defaults to
  `%.n` (temp) for new files** (`lookup-gain`, app:1160-1176). Delete (`%cull`) appends
  `[%temp ~]`; born records are never removed, so a deleted file's `%firm` history persists and
  re-creating the file resumes it.
- **Processes**: each file has a fiber (monadic process) defined by its directory's **nexus**
  (compiled from `gub/nex/` via the nearest governing `/code` namespace). Fibers yield **darts**
  (`%make`/`%cull`/`%poke`/`%peek`/timers/…; `%make force=%.y` updates) and receive **intakes**; they restart on
  failure and are respawned on agent reload.
- **Access control**: **weirs** filter darts moving *upward* through the tree (downward from the
  governor is always free). A present weir with empty road sets denies everything. Foreign ships
  enter via `/sys/ames/ships/<ship>/ship.sig` and *always* get a weir (union of their usergroup
  grants; default `*weir:nexus` = deny-all). **Our own ship's dir gets no weir at all → full
  access.** So the per-ship weir chain is the *sole* gate for foreign **dart** access, and owner
  access is an *absence-of-weir* guarantee, not a src-check bypass (see invariants).
- **Remote reads are weir-gated** (since `04f3781`; this was the original blocker) — cross-ship
  `%peek`/`%want`/`%keep` arrive on the `grubbery-transfer` / `grubbery-load` marks and each runs
  `allowed:hc %peek ship-rail dest`, which simulates a dart traversal from the foreign ship's
  `/sys/ames/ships/<ship>/ship.sig` up to the destination's nearest governor and applies every
  weir on the path (`app/grubbery.hoon:181-188, 263-336, 3410-3431`). Deny → vetoed, no response.
  A `%want` additionally serves *only* lobes reachable from the claimed dest (containment), and
  inbound `%data` is `sham`-verified. So remote reads now follow the same allow-list model as
  writes: **default deny-all for foreign ships, opened only by an explicit usergroup weir grant.**
- **HTTP**: grubbery binds `/grubbery/api` (ball-api). **`dispatch:ball-api` checks only
  `=(src our)` and never `authenticated.inbound-request`** (lib/ball-api.hoon:14-21) — Eyre
  forwards unauthenticated requests, so today *anyone who can reach the ship's HTTP port* can
  read the tree and even rewrite weirs (`PUT/DELETE /grubbery/api/weir`). Hardening this is a
  hard prerequisite (stage 0a).

## Target architecture (stage 1)

```
/lattice                  nexus [/lattice %app]   (gub/nex/lattice/app.hoon in grubbery's /code ns)
  ver.ud                  loader schema version (per-nexus versioning replaces monolithic state-N)
  main.sig                vault-manager fiber: the ONLY writer. Dispatches %know-action pokes
                          (save/del/restore/move/tag/untag/import/export), maintains the index
                          grubs, enforces gain=%.y on every entry
  know/
    index.json            derived: live key → {updated, bytes, tags}  (serves know-list/tags/explore)
    trash.json            derived: trashed key → {updated, bytes, tags, restore-cass}
    export.json           on-demand full export incl. trashed bodies (gain=%.n — no history)
    vault/<key-path>      one grub per knowledge entry, marc [/lattice %know-entry] =
                          [body=@t updated=@da tags=(set @t) vector=(unit know-vector)]
                          ALL entries gain=%.y; trash = %cull (entry lives on in born history)
```

The `%lattice` gall agent keeps every external contract and becomes an adapter behind a
`know-where=?(%state %grubbery)` flag:

- **reads** → gall scries of grubbery's `/x/peek/file` (entry, index.json, trash.json) and
  `/x/peek/kids|tree`;
- **writes** → `%grubbery-load` `%poke` of a `%know-action` bask at `/lattice/main.sig`,
  answered 200 only after poke-ack **plus a post-write verification scry** (a fiber can
  mule-fail after a positive gall ack — and `%over` failures positively ack too);
- **historical reads** (restore, export) are done *by the fiber* via `%peek` with `case` — the
  agent's scry surface cannot reach historical jects.

URL shapes, JSON shapes, error envelopes, the 403 auth gate, the `src=our` poke gate, obelisk
mirroring, and the SSE channel are all unchanged. Remote peers cannot tell the difference at any
stage: the same gall agent owns the remote-scry namespace throughout.

## Access-control mapping

| Surface | Today | After |
|---|---|---|
| Kotlin app HTTP | Eyre + agent's `authenticated` 403 | unchanged (agent façade) |
| Owner pokes | `src=our` check in agent | unchanged; agent → grubbery rides owner's no-weir path |
| Foreign ships, knowledge (writes) | unreachable (never grown) | deny-all weir chain (default empty usergroup roads) |
| Foreign ships, knowledge (reads) | unreachable | deny-all weir chain — remote `%peek`/`%want` gated by `allowed:hc` since `04f3781` (RESOLVED) |
| Foreign ships, published pages | public remote scry (`sec=~`) | unchanged (stage 2 keeps the agent emitting `%grow`) |
| grubbery's own HTTP (`/grubbery/api`) | n/a | **must be auth-patched or unbound** (stage 0a gate) |

### Standing security invariants (enforced, not assumed)

1. **No usergroup weir road may cover `/lattice`.** Weirs are allow-lists and filtering is
   upward-only, so one fat-fingered `%public` grant of `[%| /]` exposes the entire vault and no
   destination-side weir can defend. Ship a periodic lattice-side audit: scry every
   `/sys/ames/usergroups/*/how.weir` and alarm if any road prefixes `/lattice`.
2. **Never place a weir on `/sys/ames/ships/<our-ship>` or its ancestors** (e.g. via a stray
   `%sand` dart). Owner full-access is absence-of-weir; a weir there would filter owner darts
   with no bypass. (Verified correction to the naive "src=our is exempt" reading.)
3. **Re-run the foreign read+write probe after every grubbery upgrade**: from a comet/moon —
   `%poke`/`%make` against `/lattice` must nack (dart/weir path), **and a remote `%peek`/`%want`
   for `/lattice/know/...` must return nothing** (this exercises the bypass path that weirs do
   *not* cover — see invariant 5); a usergroup grant *not* covering `/lattice` must still allow
   its own paths.
4. **The `%lattice` gall agent must never be nuked or renamed** (this is true today, but easier
   to forget once it looks like "just an adapter"): gall `%grow` revision counters reset and
   permanently strand non-migrated followers waiting on rev N+1.
5. **The private vault must never be remotely readable.** ✅ RESOLVED upstream (`04f3781`),
   re-verified on grubbery `a8d7738` (see verification note below): cross-ship
   `%peek`/`%want`/`%keep` arrive as a `%grubbery-load` poke and are gated by
   `allowed:hc %peek` *before any bytes are read* (app/grubbery.hoon:194 → `%peek-vetoed` →
   `%veto` response). A foreign ship with no usergroup grant gets `compute-peer-weir` =
   `*weir:nexus` (empty road sets) → `allowed` returns `[~ %|]` → veto. Our standing obligation is
   therefore the *same* as invariant 1 (no usergroup weir road may cover `/lattice/know`) plus the
   probe in invariant 3. Do not regress this: if a future grubbery upgrade reintroduces an ungated
   read path, the vault is exposed — the invariant-3 probe is the tripwire.

> **Verification note 2026-06-29 (`~tyr`, grubbery `a8d7738`).** Cross-ship read gate verified by
> code trace + live state, *not* by transport: tyr is a `-F` fakeship (Ames disabled), so a real
> comet cannot reach it (it would route to the real galaxy ~tyr) and there is no cross-ship surface
> to hit. What *was* confirmed empirically: scrying tyr's usergroups shows exactly one group,
> `%public` (which `compute-peer-weir-from` unions into **every** foreign ship's weir), and its
> `how.weir` contains a single road — `poke /apps/wallet.wallet_app/main.sig` — with **zero `peek`
> roads**. So the live config denies all foreign reads, and the code path proves an ungranted ship
> gets an empty peek set. *Side note:* that one public `poke` road lets any foreign ship poke the
> wallet feature — harmless for the vault, but the invariant-1 audit should whitelist it explicitly
> so it isn't mistaken for drift. **Still owed before production: a true two-ship transport probe
> on a real-networked staging pair** (a `-F` ship can't run it); track under invariant 3.

## Data-safety guarantee for existing users (non-negotiable: zero loss)

Existing knowledge lives in the **`%lattice` agent's state-10 `know`/`trash` maps** on the user's
production ship. The migration treats that state as immutable until a verified copy exists and is
proven equal. The guarantee rests on five properties, each enforced by a stage below:

1. **Copy, never move.** `know-migrate` (stage 1b) *reads* the state-10 maps and *writes* vault
   grubs. It never mutates or deletes the source maps. The maps stay live and authoritative
   (`know-where=%state`) throughout the import.
2. **Verify before trusting.** The flag flips to `%grubbery` only after a parity pass confirms,
   per entry, that the vault's key-set and body hashes equal the source maps' (and trash matches
   trash). Mismatch ⇒ no flip. A standing `POST /know-verify` re-runs this on demand, not just once.
3. **Frozen backup retained.** After cutover the state-10 maps are *kept frozen in state-11* as a
   pre-cutover backup, dropped only in stage 1d **after a full release soak** — and even then a
   jammed snapshot is written first. Tier-1 rollback is a single flag flip back to `%state`.
4. **Append-only history ⇒ rollback loses nothing.** Vault entries are `gain=%.y`, so every save
   is a kept `%firm` revision and `%cull` only tombs (`pace` = `%firm|%temp|%tomb`, unchanged in
   `a8d7738`). Tier-2 rollback (`POST /know-export-back`) reconstructs the maps *including
   post-cutover writes* via `%peek`-by-`case`; re-migrating later resumes the same histories.
   Restore-from-trash and trash-import (`make`→`cull`) rely on make-after-delete, **fixed in
   `3124505`** — hence the `≥ a8d7738` floor.
5. **Off-ship backup before every destructive gate.** `GET /grubbery/api/tar` of `/lattice` is
   taken before cutover and before the stage-1d map drop, independent of the in-pier snapshot.

If any property cannot be satisfied on the target ship (e.g. grubbery older than `a8d7738`, or the
parity pass fails), **do not proceed past stage 1a** — the adapter sits dormant at `know-where=%state`
and nothing is at risk.

## Migration stages

### Stage 0a — harden grubbery (hard gate, do first)

> **Update 2026-06-29 — local-HTTP hole VERIFIED CLOSED on `~tyr` (grubbery `a8d7738`).**
> Installed grubbery on tyr and probed. The gate is already present upstream and is *stronger*
> than this stage originally specified: `dispatch:ball-api` (lib/ball-api.hoon:19-22) opens with
> a blanket `;< our bind get-our:io / ?. =(src our) (send-error eyre-id 403 'Forbidden')` —
> **owner-only**, not merely `authenticated.inbound-request`. It sits at the top of dispatch, so
> *every* endpoint (file/kids/tree/tar, poke/over, the weir mutators, upload, delete) is behind
> one check. Live probe: unauthenticated `GET /grubbery/api/file/lattice` and `PUT
> /grubbery/api/weir` → `403 Forbidden`; owner (cookie) → passes (`404` for the not-yet-existing
> path, through the full fiber pipeline). **No patch and no unbind needed** — keep `/grubbery/api`
> bound (owner-only) so the off-ship `tar` backup still works. The standing regression probe below
> stays: re-run the two unauth curls after every grubbery sync.
> Two side findings (non-blocking, reported to dev): (1) `~&  >` lines still fire per request
> (ball-api.hoon:23 `%ball-api-dispatch`, app/grubbery.hoon `%eyre-dispatch`/`%eyre-no-binding`)
> — silence before high-volume writes. (2) `GET /kids/` and `/tree/` of the *root* path hang
> (curl `[000]`); `/file/<path>` is fine. Empty-root enumeration bug, not the gate.

- **Two distinct holes to close — both are hard gates:**
  - *Local HTTP:* ✅ **RESOLVED upstream** (gate present at ≥ `a8d7738`, verified live on tyr — see
    update above). `dispatch:ball-api` rejects every request where `src != our` with `403`. Was:
    *patch `dispatch:ball-api` to require `authenticated.inbound-request` on every endpoint, or
    unbind `/grubbery/api`.* Neither is needed now. Keep the standing regression probe
    (unauthenticated `curl` of `/grubbery/api/file/lattice/...` and `PUT /grubbery/api/weir` must
    403) after every grubbery sync, since the gate lives in grubbery's source.
  - *Cross-ship reads:* ✅ **RESOLVED upstream** (`04f3781`) — `%peek`/`%want`/`%keep` now run
    `allowed:hc` (the write-path weir chain), with `%want` containment and `%data` hash
    verification. Our remaining work is *configuration + verification, not surgery*: confirm no
    usergroup weir grant covers `/lattice/know`, and make the foreign read probe (next bullet) a
    standing post-upgrade check. Pin the grubbery commit (≥ `04f3781`) the migration is certified
    against, so a downgrade can't silently reopen the hole.
- Gate or silence grubbery's per-poke `~&` logging (app/grubbery.hoon:181 and ball-api dispatch)
  — knowledge-write volume will flood the dojo.
- Run the foreign read+write probe (invariant 3) once empirically before any data lands —
  including the remote `%peek` attempt, which is the one the naive threat model misses.

### Stage 0b — ship the lattice nexus (invisible)

> **Update 2026-06-29 (2) — COMPLETE & integration-verified on `~zod`.** `%restore` and
> `%reindex` now built and proven live; full lifecycle (save/del/tag/untag/move/restore/reindex)
> round-trips, and the index survives a forced agent-recompile reload with zero data loss. 8 hoon
> unit tests GREEN. `%restore` reads the firm cass stashed at delete time and `peek-at`s the
> tombstoned revision out of born history. `%reindex` deep-peeks the vault ball and rebuilds the
> live index from scratch via `collect-entries` (recursive walk, boom-skip) → `derive-index` →
> full `over` of the index grub (phantom rows dropped by construction). Verified: a 3-deep key
> `/deep/nested/key` reconstructs with correct path + bytes. Still deferred: key-segment escape
> rule; periodic gain-sweep; empty key-dir pruning (cosmetic).
>
> **Update 2026-06-29 — BUILT & integration-verified on `~tyr` (grubbery `a8d7738`).**
> The nexus + 3 marcs compile, instantiate, and the writer round-trips end-to-end. Source lives in
> the lattice repo at `grubbery-overlay/{lib,nex,mar,tests}` (synced into the grubbery desk via
> `scripts/sync-overlay.sh`). What's done and proven live:
> - **Pure core** (`lib/lattice-know.hoon`): types (byte-identical to `/sur/lattice` know-*),
>   `key-to-rail`/`rail-to-key` (fixed `entry` leaf lets `/a` and `/a/b` coexist), `derive-index`,
>   `merge-save`, `add-tag`/`del-tag` — 7 hoon unit tests GREEN via `run-tests`.
> - **Nexus** (`nex/lattice/app.hoon`): `on-load` row set covers every persistent path; `main.sig`
>   is the sole writer, dispatching `%save`/`%del`/`%tag`/`%untag`/`%move`. Each entry gets
>   `gain=%.y`; `%move` makes-target-then-culls-source; `%del` culls (tombs) and shifts the index
>   row into trash; deep keys auto-`ensure-dirs`.
> - **Marcs**: `know-entry`, `know-index`, `know-action` — `grow:json` (HTTP/agent reads) and
>   `know-action` `grab:json`/`mime` (lets the MCP server / owner HTTP drive a write as JSON).
> - **Verified live**: POST a `%save` → `know/vault/hello/entry` created + index row `{bytes:5}`;
>   tag→del→deep-save→move sequence ends with the correct live index, trash, and vault tree; and a
>   forced reload (full on-load `spin`) **preserves every entry, the index, and trash** — the
>   no-data-loss reload crux, confirmed empirically.
> - **Bootstrap**: registered like every grubbery app — one `%fall` row in grubbery's `root.hoon`
>   (`/apps/'lattice.lattice_app'`, neck `[/lattice %app]`). Idempotent; self-heals on reload. (So
>   the "%make crashes if exists" caveat below is sidestepped — `%fall` never re-makes.)
> - **Deferred (next 0b increment, each marked in-code):** `%restore` (needs historical
>   `peek-at`-by-`case` of the tombstoned entry — data is NOT lost meanwhile: cull tombs and
>   `gain=%.y` keeps every firm revision); an index-rebuild/repair action (`know-reindex` analog) +
>   periodic gain-sweep; a deterministic escape rule for key segments that aren't valid grubbery
>   knots + reserved names; empty key-dirs are left behind on delete (cosmetic).

- Add to grubbery's `gub/`: `nex/lattice/app.hoon`, `mar/lattice/know-entry.hoon`,
  `know-action.hoon`, `know-index.hoon`.
- Bootstrap is **two distinct operations** (verified: `%make` *crashes* if the path exists — it
  is not idempotent): `%make /lattice` once with the bole carrying `neck=[/lattice %app]`
  (treat a crash as "already installed"), then the `%load` dart for idempotent on-load re-runs.
- **The nexus on-load row list must include covering rows for every persistent path**
  (`know/`, `vault/`, the index grubs, `ver.ud`) — verified: the loader's `spin` *deletes
  anything not covered by a row*. A missing row = data loss on reload. This is the single
  sharpest edge found in verification.
- Marc discipline: verified, `++record` is **not** an unconditional schema gate — if the
  governing `/code` namespace lacks a compiled marc for the blot, raw nouns land unvalidated.
  Enforcement therefore requires (a) the marc compiling cleanly at write time and (b) writes
  arriving via the pre-validated `%poke`/`%make` dart path. Add a deploy-time check that the
  marc built (scry the bins / write-read-compare smoke test).
- Vault-manager behaviors to build in from day one:
  - `[%gain %.y]` after every `%make`, and an **import-time assertion** plus a **periodic
    gain-sweep** (peep born for every vault entry; re-issue `%gain` on any `%.n`) — if gain ever
    slips, deletes silently become destructive.
  - `know-move` ordering: make target first, cull source only after ack — duplicate on crash,
    never lose.
  - A deterministic escape rule for know keys whose segments aren't valid grubbery names
    (and reserved names: `index.json`, `trash.json`, `export.json`, `main.sig`), checked by the
    parity pass.
  - An index-rebuild action (the index analog of know-reindex): index.json/trash.json are
    derived; a fiber crash between vault write and index write must have a detector
    (parity endpoint) and a repair path. `restore-cass` must be documented as re-derivable from
    born (last `%firm` cass) so a corrupt trash.json is recoverable.

### Stage 1a — agent adapter release (state-11, flag off)

> **Update 2026-06-29 — state-11 foundation BUILT & verified on `~zod`.** The `know-where` flag
> (`?(%state %grubbery)`, default `%state`) is added as `state-11`; `migrate-10-11` carries every
> state-10 field forward verbatim and defaults the flag to `%state` (bit-identical to 0.6.x). The
> door, every full-state helper arm (`do-know`, `mirror-urql`, `know-mutate`, `kick-obelisk-query`,
> `begin-sweep`, `handle-http`), and the on-load chain (%6–%10 all lift through `migrate-10-11`;
> %10→%11 is flag-only, no re-arm; %11 reload is a no-op) are bumped. Verified: the whole desk
> compiles + the agent builds on a base-forked `%lattice` desk, and all 44 lib tests pass —
> including a new `test-migrate-10-11` no-data-loss guard (populate every field, assert each
> survives + flag defaults `%state`). **Still to build (next 1a increment):** the grubbery adapter
> (scry helpers, `%grubbery-load` poke + verification scry), the mule-wrapped presence probe
> (→ `503 grubbery not installed`), and the owner endpoints `POST /know-migrate` /
> `/know-export-back` / `/know-verify`. All dead code until the flag flips at cutover (1b).
>
> **Update 2026-06-29 (2) — adapter core + presence probe BUILT & verified on `~zod`.** New
> `lib/lattice-grubbery.hoon` (imported into the agent as `grb`): `installed` (mule-wrapped `%gu`
> presence probe), `read-entry`/`entry-exists` (mule-wrapped `%gx` peek of the nexus vault, molded
> straight to `know-entry` — the stored grub shares the shape), and `poke-cage` (a `%grubbery-load`
> poke carrying a `%poke` dart at the nexus `main.sig`, blot `/lattice/know-action`). The write
> payload mirrors ONLY grubbery's `%poke` `load:remo:nexus` variant (`+gload`) so the desk needn't
> vendor grubbery's libs — a single-variant subset of the union with an identical head tuple, so it
> nests under grubbery's `!<` by construction (marked in-code as coupled to `lib/nexus.hoon`). All
> scries are mule-wrapped → a missing/younger grubbery degrades to `~`/`%.n` (the 503 gate). Three
> pure-builder unit tests GREEN (`vault-path`, `scry-base`, `poke-cage` — the last extracts the
> emitted vase and asserts the full dart shape). Read-scry path correctness is confirmed
> statically: `vault-path` ≡ the hoon path literal, the SPUR matches on-peek's `[%x %peek %file *]`
> arm, and the HTTP ball-api already read that exact vault path live. **Still to build (next 1a
> increment):** wire `know-where` into the CRUD/poke handlers (dual-path read/write) behind the
> flag, the poke-ack verification scry, and the owner endpoints `/know-migrate` /
> `/know-export-back` / `/know-verify`.
>
> **Update 2026-06-29 (3) — write-wiring + `/know-verify` BUILT & verified live on `~zod`.**
> The dual-write hook (`+grubbery-write-cards` in `know-mutate`) emits a nexus poke on every
> mutation when `know-where=%grubbery`, else `~` (dead at `%state`). `POST /know-verify` reads the
> vault index once (`read-index:grb` — always present, never faults) then byte-compares each live
> map entry's body/tags/vector to the vault (`read-entry:grb` only for index-confirmed keys), and
> returns `{ok, checked, missing, mismatch}`. Owner-gated; 503 when grubbery is absent.
> **Fresh-install fix:** the `know-where` bunt is `%grubbery` (last fork member), so `on-init` now
> sets `%state` explicitly — a fresh install is bit-identical to 0.6.x (upgrades already get
> `%state` via `migrate-10-11`).
>
> **Live-verified the whole pipeline on `~zod`** (lattice desk forked from base, agent installed
> alongside grubbery): fresh-install→`%state` (an agent save did NOT reach the vault); dual-write at
> `%grubbery` (an agent save appeared in the vault with the agent's body); `read-entry`/`read-index`
> scries resolve; `/know-verify` correctly reports **match**, **mismatch**, and **missing** (after
> deleting a vault entry the map still had) — no faults. 3 adapter + 44 lib unit tests GREEN.
>
> **Scry mechanics discovered — load-bearing for cutover, and they CORRECT update (2)'s assumptions:**
> - **`+mule` does NOT catch `.^` faults** (grubbery's own `lib/nexus.hoon` notes a "scry-free mule"
>   for exactly this). A `.^` of a *missing* grub crashes the event, so every maybe-missing read
>   MUST be gated by the always-present index — never read a grub blind. (Update (2)'s "all scries
>   mule-wrapped → degrades to ~" was wrong; the `sweep-contacts` precedent only looks safe because
>   `%contacts` is always installed. `entry-exists` was dropped in favor of index-gated reads.)
> - **`%gx` strips the trailing path element as the requested mark** before `on-peek` matches. Read
>   paths must end in a mark; we request the grub's OWN mark (`know-entry`/`know-index`) so gall
>   returns it with no desk-`/mar` conversion (the marc lives in grubbery's `gub`, not `/mar`). The
>   probe is now a `%gx` read of the index, not `%gu`... see next.
> - **`%gu` (agent-running probe) needs a `/$` spur** (`.../grubbery/[now]/$`) — without it the scry
>   faults instead of answering %.y/%.n. WITH it, it's the safe, fault-free 503 gate, so `installed`
>   uses `%gu` (not a mule-wrapped `%gx`, which can't degrade on absence).
>
> **Still to build (next 1a increment):** `%import`/`%import-trashed` on the nexus (write an entry
> VERBATIM so `updated`/tags/vector survive — `%save` resets `updated`), then `POST /know-migrate`
> (backfill live+trash via import pokes) and `POST /know-export-back` (rebuild maps from the vault
> index + bodies, for rollback).
>
> **Update 2026-06-29 (4) — `%import` + `/know-migrate` + `/know-export-back` BUILT & verified live;
> Stage 1a functionally COMPLETE.** Added `%import`/`%import-trashed` to the nexus (grubbery
> `lattice-know` know-action + `nex/lattice/app`): both write the entry VERBATIM (no `merge-save`
> now-stamp), so `updated`/tags/vector survive. `%import-trashed` follows the safe destructive order
> — make → gain %.y → **read-back to confirm the firm revision** → cull — and records the trash row
> with the firm restore cass. The adapter gained `import-cage` (+`gimport`) sharing a private
> `action-cage`. Agent: `POST /know-migrate` emits one import poke per live entry + one
> import-trashed per trashed entry (all-at-once; batch ceiling noted in-code for 1b); `POST
> /know-export-back` snapshots every LIVE vault entry (index + per-key scry) via `know-all-json`.
>
> **Live-verified the full migration on `~zod`:** seeded the agent (flag `%state`, no dual-write)
> with 3 live (one tagged) + 1 trashed entry, ran `/know-migrate` → vault live index gained all 3,
> vault TRASH gained the deleted one (with `restore` cass), the tag survived, and crucially
> **`updated` matched byte-for-byte** between vault and agent maps for every migrated key (the whole
> point of `%import`). `/know-verify` → `{checked:3, ok:true, missing:[], mismatch:[]}`.
> `/know-export-back` returned the live vault as a `know-all`-shaped JSON backup. Nexus survived the
> grubbery cold-start reload with zero data loss. All tests GREEN: grubbery lattice-know 8/8,
> lattice adapter 3/3, lattice lib 44/44.
>
> **Deferred (small, non-blocking):** `/know-export-back` omits TRASHED bodies — their live grub is
> culled so a scry can't reach the firm revision; a grubbery-side export fiber (peek-by-case of the
> restore cass) is the clean fix, but during the soak the frozen agent trash map still holds them,
> so live-only export covers tier-2 rollback. Also still open for 1b: routing knowledge READS
> through the vault when the flag is `%grubbery` (the dual-write shadow window keeps serving from the
> maps, so this isn't needed until the maps freeze), and the cutover flag-flip + off-ship backup.

- `state-10 → state-11`: add `know-where` defaulting `%state`; keep know/trash maps intact.
- Add the adapter (scry helpers, `%grubbery-load` poke emission, poke-ack + verification-scry
  write path), a mule-wrapped **grubbery presence probe** so every grubbery-backed path degrades
  to `503 {"error":"grubbery not installed"}` instead of crashing the event, and owner endpoints
  `POST /know-migrate`, `POST /know-export-back`, `POST /know-verify` (standing parity check:
  byte-compare every vault entry against the source map / index.json on demand).
- Behavior with the flag at `%state` is bit-identical to 0.6.x; the adapter is dead code until
  cutover. Ship it.

### Stage 1b — import and cutover

> **Update 2026-06-29 (5) — cutover machinery BUILT & verified live on `~zod`; phase-1 is
> functionally complete end-to-end.** Read-routing now keys on `know-where`: at `%grubbery` the
> read endpoints serve from the vault (`know-list`/`know-all`/`know-tags`/`know-explore` via
> `vault-snapshot`, `know-read` via `read-entry`, `know-trash` via the trash index → `index-list-json`);
> at `%state` from the maps. Writes always run `do-know` (maps stay synced as the rollback net
> through the soak) and additionally poke the vault at `%grubbery`. New owner endpoints: `GET
> /know-where` (inspect), `POST /know-cutover` (flip to `%grubbery` — **REFUSES 409 unless the vault
> is at full parity**: every live body present+matching AND every trashed key present), `POST
> /know-rollback` (flip to `%state`, always safe).
>
> **Live-verified the whole cutover on `~zod`:** `know-where` state→cutover→grubbery→rollback→state;
> at `%grubbery`, `know-list` returned vault keys the agent map never had and `know-read /a` returned
> a vault-only entry (definitive proof reads serve from the vault); `know-trash` rendered from the
> vault trash index. The guard **refused (409)** when a map-only key was missing from the vault, and
> the flag stayed `%state`. All tests GREEN (lattice lib 44, adapter 3, grubbery lattice-know 8).
>
> **Isolated test on a distributed ship (test the upgrade WITHOUT publishing it):**
> Ships that installed your `%lattice` desk hold a Clay sync subscription; every `|commit %lattice`
> they pull on the next read. To upgrade your own agent and run the migration against your real data
> without that commit reaching subscribers, revoke the desk's read perm for the duration:
> 1. `|private %lattice` — sets the desk's Clay read rule to self-only. Foreign syncs are now denied;
>    subscribers stop at the last public revision. (Your own commits ignore read perms.)
> 2. `|commit %lattice` — upgrades YOUR agent (state-10→11) and runs the migration on-load. Still
>    `%state`, so behavior is unchanged; `GET /know-where` → `state`.
> 3. Test the owner endpoints locally. Phase-1-at-`%state` needs **only** the `%lattice` desk — the
>    `%state` path never touches grubbery. To walk the full cutover you also need the grubbery changes:
>    sync the overlay (`scripts/sync-overlay.sh`) and `|commit %grubbery`. If your `%grubbery` desk is
>    *also* distributed, `|private %grubbery` it the same way first; if it's a local-only copy, commit
>    it freely.
> 4. `|public %lattice` (and `%grubbery` if you privated it) when you're done and confident —
>    subscribers resume pulling from the next commit. Nothing about phase 1 changes their behavior
>    (additive, default-off), so going public is safe whether or not you cut over locally.
>
> **Production cutover runbook (operator steps on `~ricsul` — code is ready):**
> 1. Install grubbery + the `%lattice` nexus (the `root.hoon` `%fall` app row); confirm with `GET
>    /know-where` → `state` and `POST /know-verify` → all missing (vault empty, expected).
> 2. `POST /know-migrate` (backfill maps → vault). For a large store, run it more than once / add
>    the batched cursor below before this step.
> 3. `POST /know-verify` → `{ok:true}`; spot-check `updated` via `/know-export-back`.
> 4. **Off-ship backup**: `GET /grubbery/api/tar` of `/lattice`.
> 5. `POST /know-cutover` (auto-refuses if parity is off). Reads now serve from the vault; writes
>    dual-write. Soak (1c). Roll back anytime with `POST /know-rollback`.
>
> **Still genuinely open (not codeable in one pass):** the batched/resumable migrate below (only
> needed if the store is large — current all-at-once is fine and marked); the soak window (1c, time);
> dropping the maps at state-12 (1d, gated on grubbery surviving its own desk upgrade); trashed-body
> export + the history endpoint (niceties). The frozen maps remain the rollback truth until 1d.

- `POST /know-migrate`, **batched and cursor-resumable** (≈50 entries per behn-timer fire, not
  one giant gall event; interrupted imports resume from the cursor). Per entry: `%import`
  (live: make + gain) or `%import-trashed` — strictly ordered `%make` → `%gain %.y` → *verify
  the `%firm` pace exists via peek* → `%cull`, because culling a still-`%.n` file tomb-temps the
  body and drops its silo refs (verified — this is the one destructive-if-buggy step).
- After the backfill, hold a short **dual-write shadow window**: mirror every agent-side
  mutation into the vault while still serving from the maps, then run the parity pass against a
  live-converging replica rather than a snapshot.
- Verify (key sets, per-entry body hashes, trash metadata), take an **off-ship backup**
  (`GET /grubbery/api/tar` of `/lattice`), then flip `know-where=%grubbery` — a single atomic
  state write; maps freeze.
- `updated` timestamps ride inside the marc, so the Kotlin app sees identical values; born cass
  *dates* for imported entries are import-time and must be documented as non-user-facing.

### Stage 1c — soak, with defined abort criteria

- At least one full release cycle with the frozen maps still in state-11.
- Rollback tiers: (1) instant — flip the flag back (pre-cutover data); (2) complete —
  `POST /know-export-back`: fiber assembles live + trashed bodies (peek-by-case) into
  export.json, agent rebuilds the maps including post-cutover writes, flips flag. Born is
  append-only, so rollback destroys nothing; re-migration resumes the same histories.
- Define thresholds *now*, not during the incident: acceptable ms per save (each save is marc
  validation + sham + record-trees to root + notify, vs a map put today), MB of silo growth per
  week (gain=%.y keeps every autosave forever until pruning), max event time per import batch.
  Breaching a threshold triggers the rollback runbook.
- Ship one user-visible win with cutover, not after: the **entry-history endpoint** (list
  revisions; read a note at `%ud`/`%da`) — the migration must not be "just relocated bytes".
- Run `know-reindex` once post-cutover to prove obelisk rows rebuild from the new source of
  truth.

### Stage 1d — cleanup (state-12, gated on grubbery maturity)

> **Outstanding-changes checklist (audited against the shipped 1a/1b code 2026-06-29).** Dropping
> the maps removes the source that several arms still read from, so state-12 is NOT just a state
> trim — every item below must land together or knowledge breaks. The first three are the
> load-bearing ones the audit surfaced; the rest follow from "maps are gone."

- **Gate:** do **not** drop the frozen maps until grubbery has survived at least one of its own desk
  upgrades with the vault in place (grubbery is pre-1.0, single `state-0`, no upgrade history).
- **`%11 → %12`:** write a final jammed snapshot of `know`+`trash` to a backup grub, then drop both
  fields from the state. `know-where` becomes vestigial (reads are unconditionally vault) — pin it
  `%grubbery` or remove it.
- **Re-source the obelisk mirror (`+mirror-urql`).** It currently reads `know.st` (lib/lattice) to
  build the upsert urQL. With the map gone it must derive from the entry being written — read the
  just-written grub back from the vault (index-gated `read-entry`), or thread the computed entry out
  of the dual-write path. NB: the vault's `updated` is the nexus's processing time, so the obelisk
  row's `updated` shifts from the map era — document as non-user-facing, or read it back.
- **Re-source `/know-reindex`** (the obelisk rebuild). It currently runs `(obelisk-populate-urql
  know.st)`; switch its source to a `vault-snapshot`. (Distinct from the nexus `%reindex` action,
  which rebuilds the vault's own `know/index` grub — keep both.)
- **Restructure `+know-mutate` for vault-only writes.** Today it runs `do-know` (maps) + obelisk
  mirror + the vault poke. With maps dropped, `do-know` can't run; the write becomes: vault poke is
  the mutation, obelisk mirror derives from the written entry. The dual-write "maps stay synced"
  safety net is gone, so this is the point of no cheap rollback — keep the jammed backup grub.
- **Single-entry / list reads already vault-safe** (index-gated `read-entry`, `know-src`,
  `index-list-json` shipped in 1b) — no change needed, but they become the only path.
- **Complete `/know-export-back` for trashed bodies.** Live export ships in 1a; trashed bodies need
  a grubbery-side export fiber (`peek`-by-`case` of the `restore` cass) since the live grub is
  culled and unreachable by scry. Required for full tier-2 rollback once the frozen trash map (which
  holds them today) is gone.
- **Decide the grubbery-absent failure mode.** At state-12 grubbery is mandatory; if it's somehow
  absent, the agent has no knowledge source. Define the behavior (refuse/503 vs. degrade) rather
  than fault — this is part of why the maturity gate above exists.
- Ship the `%lose`-based history-pruning endpoint (by `%date`/`%numb` range) — specced in 1a,
  delivered here — with the pier-growth numbers from the soak.
- **Carry-in from the 1a/1b audit (known, not yet addressed):** the `+installed` `%gu` probe's
  grubbery-absent branch is unexercised in test (worst case: an owner endpoint 500s instead of 503
  when grubbery is absent — harmless, owner-only); and reads at `%grubbery` are eventually
  consistent (the vault poke is async, so a read in the *same* event as its write won't see it —
  sequential HTTP requests are fine). Neither blocks shipping; note them in the runbook.

---

# Phase 2 — published content on grubbery, with cache-aware peer sync

Status: **proposed, gated on phase 1 shipping and the stage-0a cross-ship-read gate landing.**
This is a separate decision with its own review; nothing in phase 1 forecloses it, but it must
not start until the private vault is proven safe (invariant 5).

## The opportunity (why this is more than "move another map")

Lattice's catalog crawler today re-fetches and re-analyzes peer pages on every sweep. It already
does *some* skip-work via a hand-rolled per-page `hash` ("for sweep diffing without re-fetch",
`desk/lib/catalog.hoon:66`) and a per-publisher manifest hash — but the hash is lattice's own,
the fetch still rides the agent's `%keen` walks, and analysis is keyed on lattice's bookkeeping.

Grubbery makes content-addressing a **framework primitive**. The cross-ship read protocol is
`peek → snap → want → data` (`lib/nexus.hoon:1020-1032`):

1. We `%peek` a remote publisher's directory.
2. They reply `%snap` = the resolved `pace` plus the **reachable content-hash set** (`refs`) —
   the `sham` lobes of every noun under that subtree (`reachable`/`reachable-shallow`,
   `nexus.hoon:696-758`). **Hashes, not bodies.**
3. We diff `refs` against our own `silo` and `%want` **only the lobes we don't already hold**
   (`app/grubbery.hoon:660-705`).
4. They send `%data` = just that subset; we merge it into `silo`.

So a page whose content is byte-identical to what we already cached has an identical lobe hash,
appears in `refs`, is found already-present, and is **never transferred and never re-analyzed**.
That is precisely your insight — *cached data remains unscanned* — and it falls out of the
framework for free, at sub-document granularity (a publisher who edits one page of fifty re-sends
one lobe). This is the real prize of phase 2; the storage move is secondary.

## What changes

- **Publication storage**: the agent's `content` map moves to `/lattice/pub/<path>` grubs, one
  grub per page, marc `[/lattice %page]`. A `pub.sig` watcher fiber diffs `/lattice/pub` and
  drives publication.
- **Peer read path, additive**: expose `/lattice/pub` as a **publicly peekable prefix** (the
  allow-list the stage-0a gate introduces — a weir/usergroup grant scoped to exactly
  `/lattice/pub`, never broader). Migrated lattice ships can then sync each other's published
  trees over grubbery's content-addressed `peek/snap/want/data` instead of page-by-page `%keen`
  fetches. The catalog crawler becomes: peek a peer's `/lattice/pub`, want only the missing
  lobes, analyze only what arrived.
- **Analysis cache keyed by lobe**: store catalog analysis (word count, title, category — the
  `catalog-analyzer` output) keyed by **content lobe hash**, not by url+fetch-time. A lobe we've
  analyzed before is skipped even if it reappears under a different path or from a different
  publisher (dedup across the whole network, not just per-page).

## The two-protocol problem (the load-bearing constraint)

Phase 2 must keep working for **non-migrated peers**, who only speak lattice's existing gall
remote-scry / `%grow` / manifest protocol. So through the entire deprecation window lattice runs
**two peer protocols at once**:

- **Serving**: the agent keeps emitting `%grow`/`%cull` at the same spurs with the same `%gmi`
  mark and cord bodies, sourcing bodies from `/lattice/pub` by scry — preserving the one
  unforgiving invariant: **dense, monotonically increasing revisions at unchanged spurs from the
  same agent** (so a follower walking rev N+1 and a crawler reading `/manifest` never notice).
  This is *unchanged from phase-1 stage-2's blueprint*.
- **Fetching**: the crawler tries the grubbery content-addressed path first **only for peers
  known to be migrated** (discovered via a capability bit in the published manifest), and falls
  back to today's `%keen` page fetch for everyone else. A peer's migration status is not
  load-bearing for correctness — both paths yield the same gemtext — only for whether we get the
  cache-skip benefit.

Net: phase 2's win is *opt-in and peer-symmetric* — you get cache-aware sync between any two
migrated ships, and graceful full-fetch with everyone else, with zero flag day.

## Staging

> **Update 2026-06-30 (2a) — BUILT, additive & default-off (branch `feat/grubbery-pub-storage`,
> off the phase-1 PR branch).** state-12 adds `pub-where`; `migrate-11-12` carries every field
> forward and defaults `%state`. The content map dual-writes into a `/lattice/pub` vault at
> `%grubbery`; owner endpoints `/pub-where /pub-verify /pub-migrate /pub-cutover /pub-rollback`
> mirror the know-* set. **Safety refinement vs the plan:** the content map is never abandoned —
> at `%grubbery` it is still dual-written, so `%grow`/manifest/home serving stays *map-sourced*
> (the dense-monotonic-revision invariant is untouched) and only the HTTP page reads route to the
> vault. Rollback is instant & lossless.
>
> **Verification (on `~tyr`):** the full lib unit suite is GREEN — `lattice-pub` (4),
> `lattice-grubbery` incl. the new pub-cage tests (5), `lattice` incl. `test-migrate-11-12` and all
> `do-know`/`mirror-urql` (state-12), and all `catalog`. Two real compile bugs were caught and fixed
> in the process (both surfaced only via `-build-file`, since `commit-desk` writes to clay without
> type-checking and `run-tests` reports only pass/fail): (1) `strip-pub` used `?=([%pub *] key)` —
> can't pattern-match a term against a path's `@ta` head; (2) `key-to-rail` ran `+scag` on a `?~`-
> narrowed `rest`, and scag's `^+ b` cast then rejected its possibly-empty result. Still owed: a
> compile check of the agent (`app`) and the nexus on a ship that can build them, then the live
> cutover/rollback + `%grow`-continuity probe.

- **2a** — `/lattice/pub` storage move behind a `pub-where=?(%state %grubbery)` flag, same
  import/export/verify/soak discipline as phase 1's vault. Serving stays on the unchanged gall
  `%grow` path throughout. No peer-visible change.
- **2b** — grant a **usergroup weir scoped to exactly `/lattice/pub`** (the gate mechanism is
  upstream and done as of `04f3781`; this is now pure configuration). Re-run the foreign probe:
  `%peek` of `/lattice/pub` succeeds, `%peek` of `/lattice/know` still returns nothing. Confirm
  containment: a `%want` for a lobe that lives only under `/lattice/know` is refused even to a
  ship allowed on `/lattice/pub`. This is the security gate for the whole phase.
- **2c** — publish the migration capability bit in the manifest; teach the crawler the
  grubbery-first / keen-fallback fetch path and lobe-keyed analysis cache. Measure: bytes and
  analysis-calls saved per sweep vs the `%keen` baseline.
- **2d** — (optional, later) move catalog sweep/scan itself to a timer-driven grubbery fiber and
  obelisk mirroring to a watcher fiber (phase-1 stage-3), so non-agent write paths stay indexed.

## New risks specific to phase 2

- **The public-read gate** ✅ provided upstream (`04f3781`): `allowed:hc` gates remote peeks by
  weir and `%want` containment serves only lobes reachable from the granted dest, so a weir scoped
  to `/lattice/pub` cannot leak `/lattice/know`. Residual risk is *configuration*: a too-broad
  weir grant (invariant 1). Keep the 2b probe (peek `/lattice/pub` ok, peek `/lattice/know`
  denied, cross-prefix `%want` refused) as a standing post-upgrade test.
- **Trust of peer-supplied lobes** ✅ closed upstream (`04f3781`): the `%data` merge now re-`sham`s
  every incoming noun and ject and drops any whose hash ≠ its claimed lobe
  (`process-transfer`, `app/grubbery.hoon` `%data` branch). Cache poisoning via forged hashes is
  prevented at the framework level; our lobe-keyed analysis cache inherits that guarantee.
- **Analysis-cache collision**: keying analysis by lobe assumes `sham` is collision-safe (it is,
  256-bit) — now safe to rely on, since the upstream re-hash check above means a lobe key always
  maps to content that actually shams to it.
- **Revision-counter coupling deepens**: with serving still on the agent's `%grow` path, the
  "never nuke the agent" invariant (invariant 4) becomes even more load-bearing — now both the
  storage and the wire protocol have to stay continuous across the move.

## Still permanent

Follows/subs stay in the agent (keen-lifecycle state, not documents). Grubbery has **no ames
`%keen` service**, so the `%lattice` gall agent owns the served remote-scry namespace forever —
phase 2 adds a *second*, content-addressed read path for migrated peers; it never retires the
first.

## Verification ledger

Checked against grubbery source by independent adversarial review (re-verified against
`04f3781`):

- **Security blockers — RESOLVED upstream (`04f3781`)**: cross-ship `%peek`/`%want`/`%keep` now
  weir-gated via `allowed:hc` (reads follow the write-path allow-list; default deny-all for
  foreign ships); `%want` containment (serves only lobes reachable from the granted dest);
  `%data` hash-verified (`sham` re-check, mismatch dropped); unsolicited `%snap` rejected; content
  negotiation split onto the `grubbery-transfer` mark. Standing obligation downgrades to
  configuration + the invariant-3 probe, pinned to grubbery ≥ `04f3781`.
- **Fully supported (10)**: owner poke path via `%grubbery-load`; foreign ships always weired,
  defaulting deny-all; empty weir = deny-everything; upward-only filtering; `%cull` preserves
  `%firm` history; gain defaults `%.n`; local scry surface (`/x/peek/file|kids|subs|tree|born`);
  state persistence across save/load; unchanged-content writes are no-ops; ball-api lacks an
  authenticated check (the stage-0a gate is real).
- **Supported with corrections (4)** — all folded into the plan: owner access is
  absence-of-weir, not a src bypass (invariant 2); historical reads require the target pace to
  be `%firm` *before* `%cull` and the case verified to exist (import ordering); `++record` is
  not an unconditional schema gate (marc-built deploy check); `%make` crashes on existing paths
  and loader `spin` deletes uncovered rows (two-step bootstrap; covering rows = data-loss
  guard).
- **Unverified (2)** — verification agents died mid-run; **must be hand-verified before stage
  1a ships**:
  - *c11*: dart processing (including destination-fiber evaluation) completes within the same
    gall event as the `%grubbery-load` poke — this underpins the poke-ack + verification-scry
    read-your-writes story. Regardless of the answer, add fiber-crash injection tests proving
    the adapter never answers 200 for a write that did not land, and pick the ack-correlation
    mechanism explicitly (subscribe to grubbery-ack facts vs verification scry only).
  - *c16*: fibers can poke arbitrary local gall agents and set behn timers via `/sys` services —
    stage 2/3 (obelisk watcher, cron sweep) depend on this; stage 1 does not.

## Open decisions (resolve before stage 1b)

1. **ball-api**: patch upstream (rebase obligation + regression probe) or unbind on this ship?
2. **Vectors in the marc**: `vector=(unit know-vector)` means every re-embedding sweep versions
   large nouns into silo forever under gain=%.y. Keep with a `%lose` pruning policy, or strip
   vectors to obelisk / a gain=%.n sidecar before import?
3. **`%restore` onto a live key**: born history resumes on the same rail when a key is reused,
   so a recorded `restore-cass` can point into a live file's past. Define semantics (409 vs
   restore-to-new-key) and encode in the contract tests.
4. **Soak thresholds**: concrete numbers for save latency, silo growth, import batch event time.

## Cross-repo discipline

- The `%know-entry` shape lives in two desks and breaks at *runtime* (`!<` on scry), not compile
  time. Pin one canonical definition, document it in both repos, and wire a smoke test into the
  deploy ritual: save via HTTP → read via scry → byte-compare.
- Every destructive gate (cutover flip, state-12 map drop, future `%lose` pruning) is preceded
  by an off-ship `GET /grubbery/api/tar` backup of `/lattice`.
