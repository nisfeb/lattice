# Published pages: grow under the mark that matches their format

## Intent and why

Every published lattice page is grown into the scry namespace under the `%gmi` mark, whatever its real format (`+grow-pub-page`, `app.hoon:11816`). The body is the page's own-format source, not rendered gemtext, so an HTML page is `%gmi` carrying `<!doctype html>` and a Markdown page is `%gmi` carrying Markdown. This was confirmed on `~ricsul-bilwyt` on 2026-10-27 both by a libmesa keen client and by reading the arms directly (see GitHub issue #321).

Two things break:

- Our own reader cannot trust the mark, so it guesses the format from the body. The address-bar handler renders anything whose first non-blank character is `<` as HTML and everything else as gemtext (`+looks-html`, `app.hoon:1432`). A published Markdown, text, or CSS page renders as gemtext. A gemtext or text page that happens to start with `<` renders as HTML.
- External clients (a libmesa reader, a `urb://`-aware browser, another lattice ship reading a peer) get `%gmi` for every page and have to copy the same guess. They have no better signal than we do.

The fix is to grow each page under the mark that matches its view mode, and to make the reader render by that mark. The mark becomes the authoritative format signal on the wire.

The comment above `+grow-pub-page` (`app.hoon:11814`, "The page rides the %gmi mark. The vault body IS rendered gemtext.") is stale and wrong. Correct it in the same change.

## Goals

- A published page is grown under a mark matching its view mode (`view-mode:pg` = `?(%text %html %gmi %md %js %css %noun)`, `lattice-pg.hoon:16`).
- The reader renders a published page by its format, correctly, for every format, whether the page is our own or a peer's.
- Pages already published under `%gmi` are corrected on this release, not left until their owner next edits them (owner's decision, 2026-10-27: re-grow them).
- Everything ships in **one release**. Lattice auto-syncs to every subscriber within minutes of a `code/version.json` bump, so there is no staged two-release rollout. Each ship updates atomically: the mark-aware reader and the per-format publisher arrive together.

## Non-goals

- Re-growing historical revisions. Only the latest revision of each page is re-grown. Old revisions stay `%gmi` (the owner's explicit scope decision, 2026-10-27). Nobody reads old revisions through the reader; they are reachable only by a client that already has an old id.
- Changing the discovery / id scheme. Ids stay `shax(salt, name, rev)` (release 35, salted ids). Re-growing a page under a new mark reuses the same spur `/pub/page/<rel>/<id>`, so `/pub/index` and `/pub/revs` stay valid and need no change.
- Changing how the vault body is stored. The vault file at `/pub/vault/<rel>/gmi` keeps its `%gmi` clay road; this change is about the scry binding's mark and the reader's render decision, not clay storage.
- External client code (libmesa, browsers). They benefit from correct marks; nothing in their code is ours to change here.

## Anti-goals

- Do not touch `+grow-pub-index` or the `/pub/meta` seq counter. That path has a documented, unrecoverable failure mode (counter vs farm drift wedges every later publish, repairable only by hand). The migration re-grows page bindings only, at their existing spurs, and never rebuilds the index. The index already names the pages correctly; re-growing a body under a new mark changes neither names nor ids.
- Do not re-grow on every boot. The migration runs once, guarded by a stored flag. Re-growing is a fresh gall case each time, so an unguarded pass would churn cases and the vere scry cache on every release.
- Do not regress legacy and un-upgraded peers. A page still grown as plain `%gmi` (an old revision, or a peer who has not yet synced) must render exactly as it does today.

## Constraints (copied into the plan's Global Constraints)

- Hoon, `code/nex/lattice/app.hoon` and `code/lib/lattice-pg.hoon`. Desk release: bump `code/version.json`.
- No new mark files are required on the reading ship. `%keen-response` carries `[mark=@tas body=noun]` opaquely and `+keen-page-raw` (`app.hoon:12290`) already narrows the body to `@t` in a mule. Content bodies are all `@t`, so widening the accepted mark set is a gate change, not a new mark definition.
- Prose/comment style: no em-dashes, see the repo convention.
- Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, pass the Doom commit-msg lint.
- Verify on a fake ship before shipping. Cross-ship reads need two ships (one publishes, one keens), per the lattice test harness.

## The shape of the change (decisions made)

Three parts, all in one release.

### 1. Reader: render by mark, accept every content mark

The remote read path keens `[mark body]` but throws the mark away and accepts only `%gmi`:

- `+read-page-body-rev` (`app.hoon:8400`) keens via `+keen-page-raw` and at `:8429` does `?: ?=([~ %gmi *] kp) ...`, else abandons the keen result and falls through to the slow peek. It returns `(unit [rev body])`: the mark is dropped.
- `+read-page-body` (`:8353`) and `+read-page-or-index` (`:8365`) pass only the body up to the handler at `:1405`.

Change the remote path to accept any content mark at `:8429` (not only `%gmi`) and to carry the page's **view mode** up through `+read-page-body-rev` -> `+read-page-body` -> `+read-page-or-index` to the address-bar handler. For a peer's page the mode is the keen binding's mark. For our OWN page the vault is always keyed `%gmi` (`road = (rf up (weld /pub/vault rel) %gmi)`, `:8418`), so the mode comes from the shared mode resolver below.

**One shared mode resolver (decided during the builder-check, my call).** Reader, publisher, and migration must all agree on a page's mode, or an own page, a peer's keen mark, and the migrated spur could disagree. Use one arm (call it `+published-mode`): it reads `+read-show-mode` on `/page/<rel>` (`:5697`), but an absent or malformed show grub resolves to **`%gmi`**, not `+read-show-mode`'s own `%text` default. `%gmi` is the right absent-mode fallback: it preserves today's behavior (the reader sniffs a `%gmi` body with `+looks-html`), and it keeps own and peer views identical for a modeless legacy or imported page. Do NOT let the reader inherit `read-show-mode`'s `%text` default directly, which would render a modeless own page as escaped `<pre>` to the owner while peers saw gemtext.

**The slow-peek fallback has no mark (decided, my call).** When the keen path misses and `+read-page-body-rev` falls through to `+peek-peer-page` (`:8434`), it peeks the peer's vault keyed `%gmi` and remote scry gives it no other mark. That path resolves to `%gmi`, i.e. today's `+looks-html` sniff. A peer page read by slow peek keeps today's behavior and may mis-render relative to its true format until the keen path succeeds. This is forced by the data model; design the plumbing's return type so every path, keen or peek, yields a mode with `%gmi` as the floor.

At the handler (`:1432`), render by the view mode using the existing per-mark dispatch (`+preview-inner` at `:8847` already maps `%md %gmi %html %text %js %css`, and the `/x` view dispatches similarly at `:9422`/`:9523`). Keep `+looks-html` as the fallback for exactly one case: a body whose mark is `%gmi` (a legacy page, an old revision, or an un-upgraded peer). So a plain `%gmi` body still renders as today, and the HTML-framing / sandbox logic for untrusted peer markup (`:1435`-`:1449`) is preserved and keyed off the resolved mode rather than a sniff.

This half alone fixes rendering of our own already-published pages immediately, with no migration, because own pages resolve their mode from `+published-mode` (which reads the local show grub).

### 2. Publisher: grow under the view mode's mark

`+grow-pub-page` (`:11816`) takes `(salt key body rev)` and grows `[%gmi body]`. Give it the page's view mode and grow `[<mark> body]`, where the mark is the view-mode tag. Its callers (`:11628`, `:11949`) resolve the mode with `+published-mode` (the shared resolver in part 1, so publisher and reader never disagree) and pass it. The spur (`+page-spur`) is unchanged, so ids and discovery are unchanged. `%noun` pages: grow under `%noun` (body stays `@t`); the reader renders an unknown/`%noun` mark through the text path. Builder confirms the exact view-mode-to-mark mapping; it is expected to be the identity on the `view-mode:pg` tags.

### 3. Migration: re-grow existing pages once, under their correct mark

On nexus load, after a guard check, re-grow the latest revision of every own published page under its correct mark:

- Enumerate own published pages from `/pub/index` (`+read-pub-index`, names) / the revision list; for each take the **latest** revision and its id.
- Resolve the page's view mode with `+published-mode` (the shared resolver, so a modeless published-only page falls back to `%gmi`, unchanged) and read its vault body, then call `+grow-pub-page` at the same spur under the correct mark. Same spur, so no index or counter write.
- Run it once: guard with a new nexus flag file (declared `%fall` in `on-load` alongside `/pub/meta`, `app.hoon:188`), e.g. a version stamp under `/pub`. The pass runs when the stamp is behind the current migration version and writes the stamp last, so a crash re-runs it rather than skipping. It must tolerate a large page count through the serialized writer without wedging.

## Risks and how they are handled (for the plan's Review Focus)

- **Sync window.** Re-growing changes the mark at a page's existing spur. During the minutes between a publisher upgrading and a given reader upgrading, an un-upgraded reader keening that page sees a non-`%gmi` mark and misses ("not published here"). This is bounded (auto-sync is minutes), self-healing, and narrow: the web reader for a public page runs on the publisher itself and reads locally, so browser readers are unaffected. Only cross-ship federated keen reads by another lattice ship or an external client are exposed, and only until they sync. Accepted by the owner, 2026-10-27.
- **Fragile index path.** Avoided entirely: the migration re-grows page bindings only and never calls `+grow-pub-index` or writes `/pub/meta`.
- **Idempotency.** The once-guard flag prevents per-boot churn. A re-grow of an already-correct spur is a harmless fresh case, but the guard avoids doing it at all after the first pass.
- **Legacy and un-upgraded peers.** The `%gmi`-body `+looks-html` fallback is kept, so a page still published as plain `%gmi` renders as today.

## What is left to the builder

- Exact Hoon signatures for the mark/mode plumbing through `+read-page-or-index` / `+read-page-body` / `+read-page-body-rev`, and the handler render-by-mode wiring at `:1432` reusing the existing per-mark dispatch.
- The view-mode-to-mark mapping (expected identity on `view-mode:pg`) and the `%noun` render path.
- The migration arm: enumeration source for own published pages and latest rev, the guard flag's exact shape and `on-load` `%fall` declaration, and batching through the writer.
- Whether `+keen-page` (the body-only wrapper at `:12318`) has any remaining caller or is vestigial; the live caller is `+keen-page-raw`.
- Tests on fake ships: a cross-ship keen read of a page in each format returns the right mark and renders correctly; an own-page read renders by mode; the migration corrects a pre-seeded `%gmi` page and is idempotent on a second boot; a legacy plain-`%gmi` page still renders.
