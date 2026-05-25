# %lattice editor — Implementation Plan (file explorer + vim editor)

> Extends the browser app (`app/`) into a file manager + modal text editor for
> the user's **own** ship's `%lattice` `/lib` gmi files. Companion to the
> browser plan `2026-05-22-lattice-browser.md`. Editing writes to Clay via new
> `%lattice` endpoints; the existing Clay watcher then auto-republishes.

**Decisions (locked):** vim scope = **practical core** (modes NORMAL/INSERT/
VISUAL; motions `h j k l w b e 0 $ gg G`; edits `i a o O x dd yy p u`;
operator+motion `d/c/y`; ex `:w :q :wq`; optional counts). Build incrementally
behind this plan.

**Targets:** desktop first for the editor (hardware keyboard / vim keys are
natural there). Android gets the explorer + a usable insert-mode editor; full
vim-key capture on a soft keyboard is out of scope for v1.

---

## Part A — Desk: list / save / delete endpoints (`desk/app/lattice.hoon`)

Route `handle-http` by HTTP **method + path** (today it only does
`GET …/fetch`). All authenticated by the same session cookie.

- [ ] **A1. Method/path routing.** From `inbound-request`: `method.request`
  (`%'GET'`/`%'POST'`) and the parsed path. Dispatch:
  - `GET  /apps/lattice/fetch?url=…` — existing.
  - `GET  /apps/lattice/list` — JSON `{"files":["notes/2026/intro","hello",…]}`
    (the `/lib` gmi paths, from `list-gmi`, stripped of `/lib` + `/gmi`).
  - `POST /apps/lattice/save?path=<rel>` body = gmi text → write
    `/lib/<rel>/gmi` to Clay.
  - `POST /apps/lattice/delete?path=<rel>` → remove `/lib/<rel>/gmi`.
- [ ] **A2. Read the POST body.** `body.request.inbound-request` is
  `(unit octs)`; the text is `q.u.body` (cord). url-decode not needed (raw body).
- [ ] **A3. Clay write card.** Commit to the agent's own desk:
  `[%pass /clay-save %arvo %c %info q.byk.bowl =nori]` where `nori = [%& soba]`,
  `soba = (list [=path miso])`, `miso` = `[%ins =cage]` (new) / `[%mut =cage]`
  (overwrite) / `[%del ~]`. The cage is `gmi+!>(content)`; path is
  `/lib/<rel>/gmi`. **VERIFY the exact `nori`/`miso` shape against
  `sys/lull.hoon` (clay) on the ship** — the `%ins` vs `%mut` distinction and
  whether a single `%dit`-style mutation is preferred. After commit, the
  existing `[%clay %lib ~]` subscription fires → `sync-cards` republishes.
- [ ] **A4. Responses.** `save`/`delete` → `200 {"ok":true}` (or 4xx on bad
  path); `list` → the JSON above. Reuse `respond-json-cards`.
- [ ] **A5. Verify (curl, with cookie):**
  - `curl -b … "…/list"` → the current files.
  - `curl -b … -X POST --data-binary @file "…/save?path=scratch/test"` →
    `{"ok":true}`; then `GET fetch?url=urb://~zod/scratch/test` returns the
    content; dojo shows a commit + `%grow`.
  - `POST …/delete?path=scratch/test` → gone (`%cull`).

> **Risk:** does Eyre deliver non-GET methods + body to the bound agent? It
> should (the `%handle-http-request` poke carries the full `inbound-request`
> incl. method/body). Confirm in A5; if POST is blocked, fall back to encoding
> the write as a `GET …/save?path=…&body=<url-encoded>` (size-limited) or a
> channel poke to a new `lattice-action` mark.

## Part B — App: file explorer

- [ ] **B1. `LatticeClient`**: add `list(): Result<List<String>>` (GET list),
  `save(path, content): Result<Unit>` (POST save), `delete(path): Result<Unit>`.
- [ ] **B2. `FilesScreen`**: list the `/lib` paths (grouped/sorted; show nesting),
  each row opens the editor; a "New file" affordance (name → empty buffer);
  per-row delete (confirm).
- [ ] **B3. Navigation**: add a Files entry point to the browser bar (icon),
  and a way back to browsing. The app now has three top-level modes: Browse,
  Files, Settings.

## Part C — App: gmi editor with vim (practical core)

- [ ] **C1. `VimEngine`** (commonMain, **pure + unit-tested**): immutable
  editor state `{ lines: List<String>, cursor: (row,col), mode, pending,
  count, register, history }` and `fun onKey(key): VimEngine` /
  `fun onChar(c): VimEngine`. Implement the locked command set as pure
  transitions. This is the core; test it hard in `commonTest` (motions,
  dd/yy/p, d/c/y+motion, undo, mode transitions, counts).
- [ ] **C2. `VimEditor` composable**: render lines in a monospace column with a
  block/》cursor and a status line (mode • path • `:`-command). Capture keys via
  `Modifier.onPreviewKeyEvent` (desktop hardware keyboard). In INSERT mode,
  printable keys insert; `Esc` → NORMAL. In NORMAL mode, keys drive `VimEngine`.
  `:` opens the ex line (`:w` save, `:q` close, `:wq`).
- [ ] **C3. Save wiring**: `:w` → `LatticeClient.save(path, lines.join("\n"))`;
  show saved/error in the status line; dirty indicator. `:q` warns if dirty.
- [ ] **C4. Android**: editor opens in INSERT mode with the soft keyboard for
  basic editing + a Save button; the modal vim keys are desktop-only for v1
  (documented). The `VimEngine` itself is platform-agnostic.

## Part D — End-to-end verify
- [ ] Desktop: Files → open `hello`, edit with vim keys (`o`, type, `Esc`,
  `dd`, `:w`), confirm the ship's file changed (`fetch` shows new content;
  dojo shows commit + republish). New file → `:w` → appears + published.
  Delete from explorer → gone (culled). Cross-check from `~tyr` if useful.
- [ ] Screenshot the editor.

## Risks / unknowns
1. **Clay `%info` card shape** (A3) — the trickiest desk piece; verify against
   the kernel before relying on it (mirrors how the `%grow`/`%keen` shapes were
   nailed earlier).
2. **Eyre POST+body to agent** (A5 risk note).
3. **Compose key capture** — `onPreviewKeyEvent` on desktop is reliable;
   keep `VimEngine` pure so the editor logic is testable without the UI.
4. **Editor scope** — practical core only; no search/registers/dot-repeat
   (those were explicitly deferred).
