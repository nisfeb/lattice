# Lattice agent access control (sub-project A)

Status: APPROVED 2026-10-15 (brainstorming). Canonical copy on the owner's lattice wiki at `specs/2026-10-15-agent-access-control`; this is the in-repo mirror the plan cites.

## Goal

Let the owner mint an agent key that can read and/or write SOME of the lattice tree and not others, with read-scope and write-scope independent, and a second lock for sensitive files. Default-deny: a scoped key sees only what it is granted. Cover local pages and, symmetrically, foreign pages the owner's ship can already reach.

Sub-project A of a larger effort. Out of scope, each its own spec: B (linked notes), C (knowledge provenance + embeddings). A leaves two hooks for C: a per-key `origin` field and a reusable `paths` type that `memory` scope can later adopt.

## Agreed requirements

- Granularity: subtrees AND individual files (one segment-prefix representation covers both).
- Read-set and write-set independent.
- Write scope MAY include shared/published pages, only within the grant (relaxes today's private-only rule).
- Common case is a default-deny allowlist; a broad `%all` key stays supported.
- Sensitive is a per-page/folder flag. A key without sensitive clearance cannot read or write a sensitive page even if its path is in scope. Reading a sensitive page TAINTS the key (chosen), mirroring sensitive memories.
- Foreign: scope reads and edits of other ships' shared pages by (ship, path) via remote-read and remote-save.

## Current model (baseline to change)

- Scope mold `[memory=level pages=level web=? sensitive=?]` (code/lib/lattice-keys.hoon:18); `pages` all-or-nothing; `+may` (line ~163) gates single-segment route NAMES only.
- Keyed page writes refused unless %private (code/nex/lattice/app.hoon:~1892); type-restricted to md/gmi/text/tex/css/index (lattice-keys.hoon +page-type-ok).
- Sensitive is memory-only: `scope.sensitive` + 12h taint (lattice-keys.hoon:~58-62, `tainted`/`taint-for`). No per-page sensitive.
- Foreign edit exists: POST /remote-save (app.hoon:~903) as a %grubbery-load %make via a make grant. Not key-scoped beyond the coarse `web` bit.
- Keys are persisted rows read by noun through `upgrade:ky`.

## Design (see the wiki spec for full prose)

Scope mold:

```
+$  level   ?(%none %read %write)
+$  paths   [read=(set path) write=(set path)]        :: segment-prefix allowlists
+$  pages-scope  $%([%all lvl=level] [%some =paths])
+$  web-scope    $%([%off ~] [%all ~] [%some ships=(map @p paths)])
+$  scope  $:(memory=level pages=pages-scope web=web-scope sensitive=? origin=(unit @p))
```

Segment-prefix match (reuse the weir `under` predicate): granting `/a/b` covers `/a/b` and under it, not `/a/bc`. A single file is its own path.

`+may-path k realm target lvl`: local -> pages-scope, [%ship p] -> web-scope entry; `%all` = level check, `%some` = target `under` a prefix in the read/write set. Wired into page-source, page-tree, page-save, page-save-batch, remote-save, foreign reads. A write grant lifts the private-only refusal within scope (still subject to type allowlist + sensitive gate).

Read-filtering: page-tree and page-search filtered to the key's read scope.

Sensitive pages: a `sensitive` marker grub beside `/share`, folder-inherited. Non-cleared key: filtered from reads, refused on write. Cleared key reading a sensitive page is TAINTED (reuse `tainted`/`taint-for ~h12`), blocking non-sensitive writes (page OR memory) for the window. Clearance set at mint.

Migration: `upgrade:ky` maps old `pages=level` -> `[%all level]`, `web=&` -> `[%all ~]`, `web=|` -> `[%off ~]`, carries `sensitive`, sets `origin=~`.

UI: Agent-keys scope builder (All vs read/write path grants, optional ship for foreign), sensitive-clearance toggle, origin field; a mark-sensitive control on the page controls/share panel.

## Constraints

Lattice DESK change -> deploys to ~ricsul-bilwyt only on an explicit release go (merge to main = deploy). Verify on ~mec (lattice-dev) first. Identity nisfeb. Edit ui-src, rebuild app.js via scripts/build-ui.mjs. No AI attribution in commits. Obey the commit-msg lint hook.

## Out of scope

B (linked notes); C (knowledge provenance via `origin` + session/model, and embeddings: vector on save, vector/hybrid recall, client-side generation). A only plants the `origin` and `paths` hooks.
