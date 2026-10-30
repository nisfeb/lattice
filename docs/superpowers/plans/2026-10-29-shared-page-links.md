# Shared Page Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user move a page another ship shared with them into their own page tree as a link that reads and writes through to the owner's page in the editor, lattice-fs and agent tools, without ever widening access.

**Architecture:** A new `%link` grub at `/page/<path>/link` holds the remote address plus a cached copy. The tree walks list it as a page. `page-source` and `page-save` (HTTP and lick) proxy through it with a two-part scope check. Everything served to other ships skips links. The client renders link rows and adds the move-in and move-out actions.

**Tech Stack:** Hoon (`code/nex/lattice/app.hoon`, `code/lib/`, `code/mar/lattice/`), vanilla JS (`ui-src/lattice/`), Rust (`lattice-fs-rs/`), Node MCP server (`plugins/claude/server.mjs`), puppeteer browser suites, curl two-ship script.

**Spec:** `docs/superpowers/specs/2026-10-29-shared-page-links-design.md` (wiki `specs/2026-10-29-shared-page-links-design`).

## Global Constraints

- Branch `feat-shared-links` (worktree `/home/sneagan/software/personal/lattice-editor-shell`). Commit as nisfeb, Doom lint, no AI trailers, stage files by name, never commit `.superpowers/`. Rebuilt `app.js` committed with any ui-src change.
- Deploy only to fake ships: ~mec (`http://localhost:8120`, raw cookie `/tmp/mec-cookie.txt`) and a second fleet ship added with `scripts/dev-deploy.py --add` then weir-approved. Never ricsul.
- A link never widens access: proxied reads and writes need BOTH the local path scope and `may-path:ky [%ship host] pax` (read or write), plus `remote-save`'s taint gate on writes. `/link-make` and link removal are owner-only and not keyable.
- Links are never served to others: publish, clearweb, folder share, foreign browse of our ship, `/pub`, and any non-owner listing or search skip link entries.
- Remote reads on HTTP use a 5s deadline (`peek-remote-wait-in ... ~s5`). Lick reads never wait on the remote: they serve the cache and refresh in the background.
- Kind is frozen at create. Error copy, verbatim: read failure `~host is unreachable or no longer shares this page`; create while host offline `~host is unreachable, try again when it's online`; badge `~host unreachable or no longer sharing`. No em-dashes.
- Icons are flat SVG through `ico()`, theme colored.

## Review Focus

1. Owner offline while a link is listed: the tree, page-dump and the lattice-fs mount stay responsive, the link shows its cached text, and the badge appears after a failed live read.
2. Moving or deleting a folder that holds a link: the link moves with it, or is deleted with it, never silently lost.
3. An agent key scoped to `notes/` reads `notes/<link>`: refused unless the key also has web scope for `~host` at that path.
4. Sharing or publishing a folder that contains a link: the link never appears to the other ship or on the clearweb.
5. Two writers through one link (editor and agent) with a stale base: the second gets a conflict, and nothing overwrites the owner's newer text.

---

### Task 1: The `%link` type, mark and pure helpers

**Files:**
- Create: `code/lib/lattice-link.hoon`, `code/mar/lattice/link.hoon`, `tests/lib/lattice-link.hoon`
- Modify: `hoon-test.conf` (register the suite if suites are listed there)

**Interfaces:**
- Produces in `lattice-link.hoon` (imported as `lk`):
  - `+$ link $%([%ship host=@p pax=path mode=@t kind=@ta body=@t rev=@ud size=@ud seen=seen] [%local pax=path])`
  - `+$ seen [ok=? at=@da]`
  - `++ en-link |=(=link json)` gives `{"host","path","mode","kind","seen":{"ok","at"}}` for `%ship` (never the body), and `{"local": path}` for `%local`.
  - `++ refresh |=([l=link kind=@ta body=@t rev=@ud now=@da] link)` updates body, rev, size and `seen=[& now]`, and keeps `kind` (frozen).
  - `++ fail |=([l=link now=@da] link)` sets `seen=[| now]` and keeps everything else.
  - `++ link-name |=(pax=path @t)` gives the display name: the last segment of the host page name (strip a trailing `/code`).
- Mark `[/lattice %link]`, noun only, same shape as `code/mar/lattice/shared.hoon`.

- [ ] **Step 1: Write the failing tests** in `tests/lib/lattice-link.hoon`:
  - `test-refresh-keeps-kind`: refresh a `%ship` link of kind `%md` with kind `%gmi`. The result's kind is `%md`, its body is new, its size is `(met 3 body)`, and `ok.seen` is `&`.
  - `test-fail-keeps-cache`: `fail` leaves body and rev and sets `ok.seen` to `|`.
  - `test-en-link-no-body`: `en-link` JSON has no `body` key.
  - `test-link-name`: `/apps/.../page/notes/plan/code` gives `'plan'`.
- [ ] **Step 2:** Run `scripts/hoon-test-kit/hoon-test.sh <mec pier>`. The new suite fails to build.
- [ ] **Step 3:** Implement the lib and the mark.
- [ ] **Step 4:** The suite passes, and every other suite still passes.
- [ ] **Step 5:** Commit: `feat: link type and helpers for shared page links`

### Task 2: Make, list, move, unmake and re-share links

**Files:**
- Modify: `code/nex/lattice/app.hoon`: new routes `POST /link-make` and `POST /link-unmake`; `+tree-walk` (~7161), `+dump-walk` (~7264), `+collect-tree` (~11650), `+index-walk` (~7011), `+collect-visible`, `+move-pages` (~6275), `+fs-move` (~7474), `+apply-share-notice` (~8374)
- Create: `scripts/two-ship-links.sh` (bash, curl and jq, env `A_URL A_COOKIE B_URL B_COOKIE`, prints `ok`/`FAIL` lines, exits non-zero on any FAIL, one section per task)

**Interfaces:**
- Consumes: `link`, `en-link` (Task 1).
- Produces:
  - `POST /link-make?host=&path=&to=` (owner only, not in `+wants`): finds the shared-with-me entry `[host path]` (404 if none), and answers 409 if `to` holds a page, folder or link. It peeks the host once with a `~s5` deadline (`peek-remote-wait-in` plus `browse-file-respond`'s unwrap). On failure it gives 504 with the create-offline copy and writes nothing. Otherwise it writes `/page/<to>/link` with kind, body and rev from the peek, mode from the entry, `seen=[& now]`, then deletes the shared-with-me entry. Returns the new tree node JSON.
  - `POST /link-unmake?name=` (owner only): re-adds the link's shared-with-me entry (`put-entry`, mode from the link), then deletes the link dir.
  - Tree and dump nodes for a link dir: `{"path","page":true,"kind":<frozen kind>,"link":<en-link>,"readonly":<mode=='read'>,"size":<cached size>,"rev":<owner rev>}`, with no `body` in the dump.
  - `collect-tree` returns link dirs, so `move-pages` copies the `link` grub and `%del` of a folder deletes it. `fs-move` answers 409 when `to` holds `code`, a dir, or `link`. `move-pages`' wikilink rewriting skips link entries.
  - `index-walk` and `collect-visible` never index or expose link bodies.
  - `+apply-share-notice`: if a link under `/page` has the same `host` and `pax`, update its `mode` and do NOT add a shared-with-me entry. A `%del` notice for it sets `seen=[| now]`.

- [ ] **Step 1: Write the failing checks** in section `make` of `scripts/two-ship-links.sh`. Set up B with `dev-deploy.py --add` on a fleet pier plus approve-weir (never an empty `granted`). See `docs/superpowers/plans/2026-10-28-cross-ship-forum-over-urb.md` for the two-ship setup. B shares page `x/doc` with A in edit mode. Checks:
  - `/link-make` to `notes/doc`: the node appears in `/page-dump` and `/page-tree` with `link.host`, `page:true`, `readonly:false` and no body, and the entry is gone from `/shared-with-me`.
  - make onto an existing page answers 409.
  - make with B stopped answers 504 with the exact copy, and nothing is written.
  - `/page-move` of `notes` to `notes2` keeps the link at `notes2/doc`, with none left at the old path.
  - `/page-move` onto an existing link answers 409.
  - `/link-unmake` restores the entry and removes the link.
  - Re-make, then B re-shares in read mode: the link's mode becomes read (`readonly:true`), and `/shared-with-me` stays without it.
  - Deleting the folder removes the link.
- [ ] **Step 2:** Run against ~mec (A) and B. It fails.
- [ ] **Step 3:** Implement. Deploy to both ships, and check `?info=1` shows no bang.
- [ ] **Step 4:** Section `make` passes, and `ui-tabs.mjs` and `ui-shell.mjs` still pass on ~mec.
- [ ] **Step 5:** Commit: `feat: move a shared page into your tree as a link`

### Task 3: Read and write through a link (HTTP and lick), with scope and conflicts

**Files:**
- Modify: `code/nex/lattice/app.hoon`: `GET /page-source` (~1752), `POST /page-save` (~2303) and `handle-page-save`, `+fs-source-result` (~7384), `+fs-save` (~7439), `needs-our` list (~1391)
- Test: `scripts/two-ship-links.sh` (section `proxy`)

**Interfaces:**
- Consumes: `refresh`, `fail` (Task 1), the link nodes and `/link-make` (Task 2), the existing `peek-remote-wait-in`, `browse-file-respond`, `handle-remote-save`.
- Produces:
  - `++ link-read |=([lpath=path =link:lk] (fiber (each [body=@t rev=@ud kind=@ta] @t)))`: a live read with a `~s5` deadline. On success it writes `refresh` to the link grub; on failure it writes `fail` and gives the error copy.
  - `++ link-write |=([lpath=path =link:lk body=@t base=(unit @ud)] (fiber (each @ud [code=@ud msg=@t])))`: proxies through `handle-remote-save`'s logic. It answers 409 `conflict` when `base` is set and the owner's current rev is not `base`, and 403 when mode is read. On success it refreshes the cache.
  - HTTP `page-source` on a link: a live read, the JSON as for a page plus `"link":{"host","path"}`. On failure, 504 with the read-failure copy.
  - HTTP `page-save` on a link: `link-write` with `base` from the request's existing `base` param.
  - Lick `fs-source-result` on a link: returns the CACHED body at once and starts `link-read` in a separate fiber (no wait). Lick `fs-save` on a link: `link-write`.
  - Scope: for key callers, both `may-path %local lpath` and `may-path [%ship host] pax` with %read or %write, plus `remote-save`'s taint gate for writes.

- [ ] **Step 1: Write the failing two-ship checks.** Reuse the two ships from Task 2. B shares page `x/doc` with A in edit mode. A makes the link at `notes/doc` with `/link-make`. Checks:
  - `GET /page-source?name=notes/doc` on A returns B's body and `link.host`.
  - `POST /page-save` with the right `base` changes the body on B.
  - A save with a stale `base` gets 409, and B is unchanged.
  - B revokes the grant: A's read returns 504 with the exact copy, and `/page-dump` shows `seen.ok=false`.
  - B stopped (offline): `GET /page-dump` on A still answers within 2s. The lick read (use `scripts/fs-matrix.sh` or the lattice-fs lick test harness in `lattice-fs-rs/tests/lick_live.rs`) returns the cached body within 2s.
  - An agent key with pages scope `notes/` and web scope off: 403 on read. The same key with web scope for `~B` at that path: 200.
- [ ] **Step 2:** Run. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** All checks pass. Re-run section `make` and `scripts/route-smoke.sh` against ~mec.
- [ ] **Step 5:** Commit: `feat: read and write shared pages through their links`

### Task 4: Never serve links to others; MCP quoting; lattice-fs readonly

**Files:**
- Modify: `code/nex/lattice/app.hoon`: publish (`apply-share`, ~5999), clearweb render and listing, folder share (`share-file`, `move-grants`), the reader's browse of our ship and `/pub` serving, and non-owner page search and listing
- Modify: `plugins/claude/server.mjs` (`wiki_read`: when `page-source` JSON has `link`, wrap the text as quoted foreign content, the same way `web_read` does)
- Modify: `lattice-fs-rs/src/lattice.rs` `page_node`: honour a `readonly` field from page-tree and page-dump nodes, OR'd with the existing `kind == "index"` rule
- Test: `scripts/two-ship-links.sh` (section `exposure`), a `lattice-fs-rs` unit test in the existing test module of `lattice.rs`, and `node --test` or the MCP server's existing test if one exists

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Write the failing checks:**
  - A shares folder `notes/` (which holds the link) with a third ship C, or publishes it shared and clearweb. Reading `notes/` from C over urb:// lists only real pages. The clearweb URL for `notes/doc` answers 404. `/pub` has no entry for it.
  - Rust `page_node_readonly_from_dump`: a dump node with `"readonly":true` and kind `md` gives `readonly == true`.
  - MCP: `wiki_read` of a link path returns text wrapped as quoted foreign content.
- [ ] **Step 2:** Run. It fails. **Step 3:** Implement. **Step 4:** Passes. Also run `cargo test` in `lattice-fs-rs` and the full `scripts/two-ship-links.sh`.
- [ ] **Step 5:** Commit: `fix: links stay private to their owner, read-only in the mount`

### Task 5: The editor: link rows, move in and out, badge, Page tab

**Files:**
- Modify: `ui-src/lattice/30-tree.js` (render link nodes), `69-shared.js` (drag a shared-with-me row onto a folder, and "Move into my pages" in its menu), `23-tabhead.js` (page menu: "Move back to shared with me" for link tabs), `21-tabs.js` (link tabs open as the remote grub tab, titled with the link path), `65-ctl.js` (Page tab: "Linked from ~host/<their path>", the mode, and the badge), `10-shell.js` (`ico('link')`)
- Test: `scripts/ui-links.mjs` (new browser suite; ~mec plus the second ship from Task 3)

**Interfaces:**
- Consumes: the node `link` field (Task 2), `/link-make` and `/link-unmake` (Task 2), `openIn`, `openGrub(pax, host)`, `action()` registry.
- Produces: link rows with class `pg lnk`, `data-host`, the `ico('link')` icon, and a `.lbad` badge when `link.seen.ok === false`. Clicking opens via `openIn('grub', pax, {ship: host, ev})`, and the tab title is the link's local path. Register actions "Move into my pages" (home "Files › shared with me") and "Move back to shared with me" (home "Page menu").
- [ ] **Step 1: Write the failing browser checks** in `scripts/ui-links.mjs`:
  - Dragging the shared row onto folder `notes` gives a link row at `notes/doc` with the icon, and the shared-with-me row is gone.
  - Opening it shows B's text, and the tab title is `notes/doc`.
  - Typing and Ctrl+S changes the text on B.
  - The Page tab shows "Linked from ~B/".
  - With B offline, opening it shows the badge text verbatim.
  - "Move back to shared with me" restores the shared row and removes the link.
  - At 390px all of the above are reachable from the drawers.
- [ ] **Step 2:** Run. It fails. **Step 3:** Implement. **Step 4:** Passes, plus ui-tabs, ui-shell, ui-tabsafe and ui-mobar on ~mec.
- [ ] **Step 5:** Commit: `feat: shared page links in the editor tree`
