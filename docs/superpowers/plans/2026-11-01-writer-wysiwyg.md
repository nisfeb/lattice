# Writer WYSIWYG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** A new page kind, `fodt`, that stores a LibreOffice Writer document as flat ODT, is edited in lattice with a WYSIWYG editor, and opens and saves in desktop LibreOffice through lattice-fs, with nothing lost in either direction.

**Architecture.** The fodt text stays the page body, wrapped by `+wrap-content` like every content kind, so save, revisions, conflicts, the offline queue, publishing and lattice-fs need only their kind tables taught. On the ship a new `/lib/lattice-fodt` extracts text for search and renders a safe HTML subset for the reader, the preview and the published views. In the client `#src` stays the canonical buffer. A lazily loaded `writer.js` (ProseMirror plus lattice's fodt tokenizer, model mapping, style resolver and minimal-diff serializer) projects it as an editable page and writes back through `edited()`.

**Tech Stack.** Hoon (`code/nex/lattice/app.hoon`, `code/lib/`), vanilla JS in `ui-src/lattice/` for the shell hooks, ES modules in a new `ui-src/writer/` built by esbuild into `code/nex/lattice/ui-app/writer.js`, vendored ProseMirror (MIT), Rust (`lattice-fs-rs/src/`, `desktop/src/`), puppeteer-core browser suites and pure node suites in `scripts/`, LibreOffice headless for the round-trip corpus.

**Spec.** `docs/superpowers/specs/2026-11-01-writer-wysiwyg-design.md`. Line numbers cited are from `origin/main` 5cc0e7a (release 92).

## Global Constraints

- Branch `feat-writer` off `origin/main` (5cc0e7a or later). Rebase onto `fix-folder-move` once that lands, because Task 5 tests against its refusals. Commit as `nisfeb <business@nisfeb.com>`; check `git config user.email` before the first commit.
- Commits pass the Doom lint: type from `feat fix refactor test docs tweak nit perf`, no scope, subject ≤72, body wrapped ≤72, no AI trailers, never `--no-verify`.
- Every commit that touches `ui-src/lattice/` also commits the rebuilt `code/nex/lattice/ui-app/app.js` (`node scripts/build-ui.mjs`). Every commit that touches `ui-src/writer/` also commits the rebuilt `code/nex/lattice/ui-app/writer.js` (`node scripts/build-writer.mjs`). CI diffs both.
- `app.js` stays dependency-free. ProseMirror lives only in `writer.js`. Nothing in `app.js` may import, reference or wait on `writer.js` at boot.
- The owner approved ProseMirror as the first client runtime dependency on 2026-11-01 (spec, Decisions 1).
- No GPL, AGPL or LGPL code in any client asset. `scripts/writer-licences.mjs` enforces it.
- A lattice open-and-save with no edit is byte-identical to the input, for every corpus file. This is the release gate.
- User-visible copy has no em-dashes.
- Deploy only to fake ships (`scripts/dev-deploy.py`). Never ricsul. Browser suites run with `LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt`.
- The kind tables change together in one commit (Task 4) and `node scripts/kind-parity.mjs` passes after it.

## Review Focus

1. Open each corpus file in lattice, change nothing, let autosave run. The page body is byte-identical (check `page-source`).
2. Open `corpus/10-unknown.fodt` in lattice, edit one paragraph, then open it from the mount in LibreOffice. Footnotes, the table of contents, comments, tracked changes, bookmarks, fields, sections and the page style are all still there.
3. Save a document from LibreOffice on the mount, then open it in the browser editor. It opens without errors and shows the LibreOffice edit.
4. Open a markdown page on a cold load. No request for `writer.js` appears in the network log (`ui-perf.mjs` asserts it).
5. Open `corpus/hostile/*.fodt` as a peer's shared page in the reader and in the editor. Nothing executes, nothing is fetched, nothing crashes.

## Corpus

The round-trip corpus lives in `tests/writer/corpus/`. Every file is saved by LibreOffice. `scripts/writer-corpus/make-corpus.py` builds most of them. It writes a hand-built flat ODT source for each file and has LibreOffice open and save it with `soffice --headless --convert-to "fodt:OpenDocument Text Flat XML"` and, beside it, `odt:writer8` for the import tests, using a throwaway profile. It does not use UNO: pyuno is an optional package and is often missing (it was when Task 2 ran), and `--convert-to` gives a real LibreOffice save without it. If UNO-only control is ever needed, a Basic macro run through `macro:///` works without pyuno. LibreOffice's output keeps changing over the first few saves of a new document (it added `style:writing-mode` on save 2 and `draw:fill-color` on save 3 in 26.8), so `make-corpus.py` re-saves until two saves canonicalize equal. The corpus is reproducible up to `canon.py`, not byte for byte, because tracked-change ids and list `xml:id`s change on every save. The LibreOffice version is written to `tests/writer/corpus/VERSION`. A few files are made by hand in the LibreOffice GUI and marked `-gui` in their names, because a GUI save sets things a headless save does not (view settings, rsids, autocorrect side effects). Until one exists, `features.json` marks it `pending` and the harness skips it with that reason.

| File | Covers |
| --- | --- |
| `01-paragraphs.fodt` | plain paragraphs, empty paragraphs, Text Body and Default Paragraph Style |
| `02-headings.fodt` | Heading 1 to 6, Title, Subtitle, headings with outline numbering |
| `03-inline.fodt` | bold, italic, underline (single, double, wave), strikethrough, combinations, a span with colour and highlight, a named character style (Emphasis, Strong Emphasis, a custom one) |
| `04-lists.fodt` | bullet and numbered lists, nested to 4 levels, a list interrupted by a paragraph and continued (`text:continue-list`), restart numbering, a list header |
| `05-links.fodt` | http, mailto, relative, `#bookmark`, a `javascript:` link, a `vnd.sun.star.script:` macro link |
| `06-quote-break.fodt` | Quotations style, a page break before, a page break inside a list |
| `07-styles.fodt` | custom paragraph styles inheriting through three levels, custom fonts with and without a font-face declaration, line spacing, indents, alignment, spacing above and below |
| `08-tables.fodt` | a table with a header row, column widths, cell borders, an empty cell, a cell with two paragraphs, and a second table with merged cells (must open as opaque) |
| `09-layout.fodt` | A4 portrait, US Letter, a landscape page style, wide margins, a header and footer with a page number field |
| `10-unknown.fodt` | footnotes, endnotes, a table of contents, bookmarks spanning two paragraphs, reference marks, fields (date, page count, user field, cross-reference), a section, a linked section, comments with ranges, tracked changes with recording on, a text frame, `dc:title` and custom metadata, RDF metadata as far as flat ODT allows (a `text:meta` with `xml:id`; LibreOffice 26.8 cannot load a fodt whose `text:meta` carries RDFa attributes), a Basic macro library |
| `11-i18n.fodt` | right-to-left Arabic and Hebrew paragraphs, CJK with Asian fonts, emoji, combining marks, a soft hyphen |
| `12-whitespace.fodt` | runs of spaces, a leading space, tabs, line breaks, a non-breaking space |
| `13-large.fodt` | about 300 pages generated from the other fixtures, for performance |
| `14-lo-gui.fodt` | a document saved from the LibreOffice window over three editing sessions, with rsid churn and view settings (`scripts/writer-corpus/lo-gui.xba`) |
| `hostile/*.fodt` | a DOCTYPE with an internal entity, billion laughs, an external entity, nesting depth 10,000, a 50 MB attribute, a style value carrying `url(` and `</style>`, `script` and `iframe` elements in the body, links to `javascript:` and `file:`, a draw:image with an external `xlink:href`. Hand-written, not LibreOffice saves, except that `scripts/writer-corpus/hostile-big.py` generates the 10,000-deep file (committed) and the 50 MB one (not committed; suites that need it generate it with `--huge`). |

`tests/writer/corpus/edits.json` names a scripted edit per file (for example: insert text in the third paragraph, bold a word, add a list item, add a table row, apply the Quotations style) and the text change it should produce.

`scripts/writer-roundtrip.mjs` (pure node, no ship) runs, for each corpus file:

1. **No-op.** Parse with the writer core, serialize, assert byte-identical.
2. **Edit.** Apply the scripted edit to the ProseMirror state, serialize. Assert every opaque element's raw XML and the whole head except `office:automatic-styles` additions appear verbatim in the output.
3. **LibreOffice reads it.** `soffice --headless --convert-to fodt --outdir <tmp>` on the original and on the edited output (LibreOffice opens and re-saves each), and `--convert-to txt` on both.
4. **No loss.** Canonicalize both LibreOffice re-saves with `scripts/writer-corpus/canon.py` (drop `office:settings`, meta dates, generator and editing duration, `officeooo:rsid` attributes, renumber `xml:id` and `text:id` with every reference to them, rename automatic styles by content hash within their family and rewrite references, sort `office:automatic-styles`, trim the whitespace LibreOffice appends to macro source on every save; it refuses any DOCTYPE). Assert per-element-name counts are equal except for the elements the edit adds, and that the txt diff is exactly the edit's expected text change.
5. **Lattice reads LibreOffice's save.** Parse the LibreOffice re-save of the edited file in the writer core, assert it opens, that the edit is present, and that its own no-op round trip is byte-identical.
6. **PDF sanity.** `--convert-to pdf` of the original and of the no-op output have the same page count.

CI runs this in a new job that installs `libreoffice-writer-nogui` (it is too heavy for the existing jobs). Ubuntu 24.04 ships an older LibreOffice (24.2) than the one that saved the corpus, so the check that the corpus is at LibreOffice's fixed point runs only when the releases match. The checks that pass both sides through the same LibreOffice run everywhere.

LibreOffice rewrites relative links (`text:a` hrefs, linked-section sources) relative to where it saves. The harness keeps its scratch directories beside the corpus at the same depth (`tests/writer/.rt-*`, gitignored), and any test that compares saves from different directories, including a lattice-fs mount (Task 5), must expect it.

---

## Phase 1

### Task 1: writer.js build, budget and licence gate

**Files:**
- Create: `ui-src/writer/index.js` (entry, exports `window.LatWriter = { mount, render, extract }` stubs)
- Create: `ui-src/writer/vendor/README.md`, `ui-src/writer/vendor/LICENSES` (pinned ProseMirror versions and MIT notices)
- Create: `scripts/build-writer.mjs` (esbuild, minify, one IIFE, a licence banner)
- Create: `scripts/writer-licences.mjs` (pure suite)
- Modify: `scripts/package.json` (devDependencies `esbuild` and the `prosemirror-*` packages, pinned exact)
- Create: `code/nex/lattice/ui-app/writer.js` (built)
- Modify: `.github/workflows/ci.yml` (rebuild-and-diff `writer.js` beside `app.js` at ~144-146; run `writer-licences.mjs`; size budget)

**Interfaces:**
- Produces `window.LatWriter` once `writer.js` has run. Nothing else is global.
- Packages: `prosemirror-model`, `-state`, `-view`, `-transform`, `-commands`, `-keymap`, `-history`, `-inputrules`, `-schema-list`, `-tables`, `-dropcursor`, `-gapcursor`.

- [ ] **Step 1:** Write `scripts/writer-licences.mjs`. It reads the `package.json` `license` of each package in the dependency closure of the `prosemirror-*` roots (installed from the lockfile into `scripts/node_modules`; `ui-src/writer/vendor/` holds only the README and the generated `LICENSES`) and fails on anything not in `MIT ISC BSD-2-Clause BSD-3-Clause`, on a version not pinned exact, and on a bundled package `LICENSES` names that is outside that closure. It also fails if `code/nex/lattice/ui-app/app.js` contains `prosemirror`.
- [ ] **Step 2:** Write `build-writer.mjs`. Run it. Record raw and gzip size of `writer.js` with only ProseMirror in it.
- [ ] **Step 3:** Add the CI steps. The size budget is 400 KB raw and 130 KB gzipped for the whole phase; CI fails above it.
- [ ] **Step 4:** Commit: `feat: build gate and licence check for writer.js`.

**Acceptance.** `writer.js` builds reproducibly (two builds are byte-identical), CI diffs it, the licence check passes, and the measured ProseMirror size is written into the spec's estimate.

### Task 2: Round-trip corpus and harness skeleton

**Files:**
- Create: `scripts/writer-corpus/make-corpus.py`, `scripts/writer-corpus/canon.py`
- Create: `tests/writer/corpus/*.fodt`, `*.odt`, `VERSION`, `edits.json`, `hostile/*.fodt`
- Create: `scripts/writer-roundtrip.mjs` (steps 1 to 6 above; steps 1, 2 and 5 skip with a clear message until Task 8 provides the core)
- Modify: `.github/workflows/ci.yml` (new `writer-roundtrip` job)

- [ ] **Step 1:** Write `make-corpus.py` for files 01 to 13. Run it. Make `14-lo-gui.fodt` by hand.
- [ ] **Step 2:** Write the hostile files by hand.
- [ ] **Step 3:** Write `canon.py`. Self-test. Canonicalizing two LibreOffice re-saves of the same file gives identical output.
- [ ] **Step 4:** Write the harness with steps 3, 4 and 6 live (LibreOffice re-save of an original against itself must show no loss).
- [ ] **Step 5:** Commit: `test: writer round-trip corpus and harness`.

**Acceptance.** Every corpus feature in the table is present in its file (a script asserts each expected element name exists), and the harness runs green in CI with the core-dependent steps skipped.

### Task 3: The fodt kind on the ship

**Files:**
- Modify: `code/lib/lattice-pg.hoon` (`+view-mode` at 16 gains `%fodt`; constructor `++ fodt` beside 28-37)
- Modify: `code/lib/lattice-pub.hoon` (`+builder-mode` at 132-137 maps `%fodt`)
- Modify: `code/nex/lattice/app.hoon` (`+content-builders` 13665; `+edit-lock-msg` 13607; `+render-shown` 12696 and `+preview-inner` 11605 gain a `%fodt` arm that, for now, shows escaped extracted text; `+mime-of` 13699 maps `%fodt` to `application/vnd.oasis.opendocument.text-flat-xml`)
- Create: `tests/lib/lattice-pg.hoon` additions, `tests/lib/lattice-pub.hoon` additions

**Interfaces:**
- `POST /page-save?type=fodt` stores the body wrapped as `(fodt '...')`. `page-source`, `page-tree` and `page-dump` report `kind: "fodt"`.
- The `/raw` and download routes serve the body with the flat ODT MIME type.

- [ ] **Step 1:** Failing hoon tests: `builder-mode` of `%fodt` is `%fodt`; `+plain-body` of a wrapped fodt body round-trips (the escaping of `'`, `\` and control bytes in real XML); `+render-shown` with `%fodt` escapes `<script>`.
- [ ] **Step 2:** Implement. The `?-` in `+render-shown` will name every other switch that needs a `%fodt` arm; handle each.
- [ ] **Step 3:** `scripts/api-matrix.sh` case: save a corpus file with `type=fodt`, read it back byte-identical through `page-source`.
- [ ] **Step 4:** Commit: `feat: fodt page kind on the ship`.

**Acceptance.** A fodt page saves, reads back byte-identical, survives a conflicting save (its `conflicts/` copy has kind `fodt`), and `fodt` appears nowhere in `+page-type-ok`.

**Review decision (2026-11-02), accepted.** `+mode-mark` maps `%fodt` to `%text`, so until Task 7 a published fodt page goes out as its escaped source under `%text`. This keeps a `%fodt` mark off the wire (Decisions 4) without pulling the renderer forward. Task 7 Step 3 removes the arm and maps `%fodt` to `%html`. The branch must not merge before Task 7 lands. Review also added the key refusal checks: `test-page-type-ok` asserts `fodt` is refused, and api-matrix asserts a scoped key gets 403 for `type=fodt` on `page-save` and `page-save-batch` (Decisions 6).

### Task 4: Kind tables everywhere

**Files:**
- Modify: `ui-src/lattice/30-tree.js` (`KIND_EXT` and `EXT_KIND` at 18-22: `fodt: 'fodt'`, plus the inbound-only alias `odt: 'fodt'` that Task 12 routes through the importer)
- Modify: `code/nex/lattice/ui-app/vault.js` (`KMAP` at 120)
- Modify: `lattice-fs-rs/src/projection.rs` (`ext_for_kind` and `kind_for_ext` at 109-139)
- Modify: `lattice-fs-rs/src/lattice.rs` (save-type list at 218-222)
- Modify: `ui-src/lattice/23-tabhead.js` (`KINDS` at 19)
- Modify: `scripts/kind-parity.mjs` (add `odt` to `ACCEPTED_EXCEPTIONS` as browser-only, since a mounted `.odt` is binary and must not become a text page)

- [ ] **Step 1:** Failing tests: `kind-parity.mjs` (fails until all three tables agree); in `lattice.rs` tests, `write_maps_kind_to_page_type...` gains `type=fodt`; in `core.rs` tests, `is_scratch("report.fodt")` is false and `is_scratch(".~lock.report.fodt#")` and `is_scratch("lu12345abcd.tmp")` are true, and `is_editor_temp` accepts both temps.
- [ ] **Step 2:** Implement in one commit.
- [ ] **Step 3:** `cargo test --release` in `lattice-fs-rs`, `node scripts/kind-parity.mjs`, `node scripts/build-ui.mjs`.
- [ ] **Step 4:** Commit: `feat: fodt in every kind table`.

**Acceptance.** A fodt page shows as `name.fodt` in the tree, the mount and a vault export, and a vault restore brings it back as `fodt`.

**Review decision (2026-11-02), accepted.** The inbound `odt: 'fodt'` alias and its `ACCEPTED_EXCEPTIONS` entry move to Task 12. kind-parity also holds KMAP (`vault.js`) and desktop `PAGE_EXTS` (`commands.rs`) to EXT_KIND, and the uploader, the vault restore and the desktop picker all read a matched file as text, so the alias today would turn a binary `.odt` into a garbage fodt page. Task 4 also added `fodt` to `PAGE_EXTS`, which the file list above missed.

### Task 5: lattice-fs and LibreOffice's save pattern

**Files:**
- Create: `scripts/fs-libreoffice.sh` (needs a mount and `soffice`)
- Modify: `scripts/fs-matrix.sh` (fodt cases beside the stale-writer case from `fix-folder-move`)
- Modify: `lattice-fs-rs/src/core.rs` only if the trace shows a pattern the core mishandles

- [ ] **Step 1:** Trace LibreOffice opening and saving `report.fodt` on a mount, `strace -f -e trace=file,desc -o trace.txt soffice report.fodt`, once from the GUI and once with `soffice --headless --convert-to fodt --outdir "$LMNT/dir" in.fodt`. Write down the exact sequence (lock file, temp names, rename or copy-over, writability probes) in the script's header.
- [ ] **Step 2:** `fs-libreoffice.sh` converts a corpus file onto the mount with `--convert-to fodt --outdir`, asserts the page exists with kind `fodt` and that `page-source` equals the file, then re-runs onto the same name (overwrite) and asserts one new revision, no `conflicts/` copy, no stray `lu*.tmp` or `.~lock` page on the ship.
- [ ] **Step 3:** fs-matrix, folder move, listing stale. Open a handle on `mv/a.fodt`, move the folder on the ship, write back through the LibreOffice temp-and-rename pattern. Expect ENOENT and no old folder.
- [ ] **Step 4:** fs-matrix, folder move, listing refreshed. Do the same, but force a re-list before the rename. Record what happens (the spec predicts the save lands as a create and makes the old folder again). The test asserts the save is refused and the old folder does not come back (spec, Decisions 7).
- [ ] **Step 5:** Commit: `test: LibreOffice saves through lattice-fs`.

**Acceptance.** A GUI LibreOffice save and a headless one both land as one revision of the fodt page, temps and locks never reach the ship, and the folder-move cases behave as the owner decided.

### Task 6: `/lib/lattice-fodt` on the ship

**Files:**
- Create: `code/lib/lattice-fodt.hoon`
- Create: `tests/lib/lattice-fodt.hoon`
- Modify: `code/lib/lattice-fuzz.hoon` (a fodt generator, if the existing fuzz pattern fits)

**Interfaces:**
- `++ scan |=(f=@t ...)` a bounded tokenizer: rejects `<!DOCTYPE` with a subset and `<!ENTITY`, decodes the five entities and numeric references only, caps size at 2 MB and depth at 256, returns `(each (list token) @t)`.
- `++ fodt-text |=(f=@t ^-(@t ...))` body text for search and titles.
- `++ fodt-title |=(f=@t ^-((unit @t) ...))` `dc:title`, else the first `text:h`.
- `++ fodt-html |=(f=@t ^-(tape ...))` the phase 1 subset as safe HTML, wrapped in the page-shaped `div` with generated style classes.

- [ ] **Step 1:** Failing tests, one per row of the spec's mapping table that renders, plus: text is escaped; a style value with `url(` produces no style; `javascript:` and `vnd.sun.star.script:` links render as text; `office:scripts` content never appears; DOCTYPE input yields the "not previewable" note; depth 10,000 yields the note, not a crash; `fodt-text` of `12-whitespace` keeps the spaces and tabs.
- [ ] **Step 2:** Implement the scanner as a linear loop (no recursion on depth), then text extraction, then the style resolver (parent chains, default style, font-face lookup, the property and value whitelist from the spec), then the renderer.
- [ ] **Step 3:** Measure `fodt-html` on `13-large.fodt` with the hoon test harness. Write the number into the plan. Over 300 ms means Task 7 adds the per-revision render cache.
- [ ] **Step 4:** Commit: `feat: render and index flat ODT on the ship`.

**Acceptance.** All tests pass, every hostile file produces the note or safe output, and the measured cost is recorded.

**Measured (2026-11-02), on ~mun.** Wall clock between thread events around one call, the library built from a test desk, a 20 ms empty baseline taken off. `fodt-html` of `13-large.fodt` (1,469,845 bytes) takes 4.7 to 6.1 s over five runs; `fodt-text` of it 5.3 s and `fodt-title` 3.3 s, since each parses the whole file and `scan` alone is 2.8 s. `fodt-html` of `10-unknown.fodt` (48 KB, most of it LibreOffice's style head) takes 100 to 170 ms. That is far over 300 ms, so Task 7 adds the per-revision render cache, and it should cache the extracted text and the title beside the HTML: `+page-title-of` and `+index-walk` would otherwise parse a large document on every call.

**Deviation (2026-11-02).** The renderer writes its CSS into `style` attributes, not generated classes in a `<style>` block. The output stays inside the element whitelist (which has no `style` element), and two fodt fragments on one page (the reader, a split) cannot restyle each other through clashing class names. Every value is still rebuilt from the parsed grammar.

### Task 7: Wire the renderer into the ship's views and search

**Files:**
- Modify: `code/nex/lattice/app.hoon` (`+preview-inner` 11605 and `+render-shown` 12696 and `+pub-flush-one` 7213 call `fodt-html`; `+page-title-of` 6754 calls `fodt-title` for fodt; `+index-walk` 8593 returns `fodt-text` for fodt; a separate raw walk kept for `+mirror-pages` 17176; `/<` import of `/lib/lattice-fodt`)
- Modify: `code/nex/lattice/app.hoon` (optional render cache grub, only if Task 6 measured over 300 ms)
- Modify: `scripts/route-smoke.sh` (fodt page through `/x`, `/c`, the urb:// reader and `page-dump?render=1`)

- [ ] **Step 1:** Failing route checks: the reader, `/x`, `/c` and `page-dump?render=1` show a corpus page's heading text and no raw `office:` tags; `page-search?q=` finds a word from the body and does not find `style-name`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Make `+pub-flush-one` publish a fodt page as its `fodt-html` fragment under `%html` (decision 4: publish the rendered HTML, not raw fodt). Publish a fodt page `%shared` on one fake ship and read it from another fake ship on this build and from one on release 92. Both must render it through the `%html` branch, and neither may receive a `%fodt` mark.
- [ ] **Step 4:** Commit: `feat: fodt pages in the reader, published views and search`.

**Acceptance.** A fodt page reads correctly everywhere a markdown page does, search matches its words only, and the mirror still hashes the raw body.

**Done (2026-11-02), with these deviations.**

- **Publishing renders in `+pub-save-page`, not `+pub-flush-one`.** Every publish passes through it (a background flush, a share click through `+apply-share`, a regrow), so one place covers them all. It reads the mode before the vault write, and for a fodt page it publishes the cached HTML with mode `%html`. The vault then holds the HTML, so the body it compares, the namespace binding and the slow peek all carry the same view. `+mode-mark` maps `%fodt` to `%html` for the regrow, which reads the mode from the show grub. A publish that comes before the page's first run (no show grub yet) asks the builder (`+publish-mode`), so raw flat ODT never goes out. The reader maps our own `%fodt` page to `%html` (`+read-page-body-rev`) and asks the page for its title (`+own-fodt-title`).
- **The cache.** It is a `fodt.cache` grub beside the page, holding the HTML, the text and the title from one parse (`+fodt-all` in the lib). The key is the shax of the body plus a renderer version, so a new revision can never get an old render. There is one entry per page, overwritten in place, written only for a page with a code grub and a body of at most 2 MB. A peer's body (a link, a peer's page in `/x`, a stray `%fodt` mark in the reader) is rendered and dropped, never stored. On ~wep, `13-large.fodt` opens in 6.7 s the first time and 0.7 s from the cache.
- **Search.** `+search-walk` gives search the cached text and stores what it had to render. `+raw-walk` keeps the raw body for `+mirror-pages`, and `page-scopes` uses it too, so it never renders. Search still ranks every page's words on each query. A page as big as `13-large` costs about 7 s for that whatever its kind (a markdown page of the same text costs the same). That cost predates this work.
- **The route checks are `scripts/fodt-views.sh`, not `route-smoke.sh`.** route-smoke records status codes only, as a before-and-after fingerprint. `page-dump` has no `render=1`, so `page-source?render=1` is checked instead. `B_URL` and `B_COOKIE` add the two-ship read.
- **Two-ship check (review, 2026-11-02).** `fodt-views.sh` with ~wep (this build) publishing and ~mun (fleet set `grubbery`, 96-dev) reading passed with 0 failed. ~mun read the page by keen (its `peer-revs.json` kept the entry, so the mark was in its view-mode set) and framed it through the `%html` branch, with no `office:` in the response. No second ship on this build was free, so a peer on this build was not run. Its `%html` branch is the one the own-ship reader check covers.

### Task 8: Writer core (pure, node-testable)

**Files:**
- Create: `ui-src/writer/xml.js` (tokenizer with byte spans, same rules as the hoon scanner)
- Create: `ui-src/writer/schema.js` (ProseMirror schema from the spec's mapping table, including `opaque_block`, `opaque_inline`, `section`, tables)
- Create: `ui-src/writer/parse.js` (tokens to ProseMirror doc, head and tail kept raw)
- Create: `ui-src/writer/styles.js` (style table, resolver, CSS generation with the whitelist, automatic-style registry with canonical keys and `L`-prefixed hash names)
- Create: `ui-src/writer/serialize.js` (minimal-diff serializer, pair checks, whitespace rules)
- Create: `scripts/writer-unit.mjs` (pure suite, imports the modules directly)

**Interfaces:**
- `parseFodt(text) -> { doc, head, tail, styles, layout, tracking } | { error }`
- `serializeFodt(state, original) -> { text } | { error }` (refuses unbalanced pairs)
- `fodtText(text) -> string`, `fodtOutline(text) -> [{level, text, pos}]`, `fodtLinks(text) -> [href]`

**What Task 2 found about LibreOffice's output:**
- Style names are unique only within a family. 13-large has a text style `T1` and a table style `T1` (LibreOffice names table styles after tables). The style table, the resolver and the canonical keys are keyed by family and name, never by name alone.
- Recording changes is on when `text:tracked-changes` has no `text:track-changes` attribute, because the ODF default is true. LibreOffice writes `text:track-changes="false"` only when recording is off. `tracking` is true when a `text:tracked-changes` element exists and the attribute is not `"false"` (spec, Decisions 5).
- Tracked-change ids (`ct94...`, memory addresses) and list `xml:id`s change on every LibreOffice save. The core treats every id as an opaque string and never assumes it survives a save.
- LibreOffice normalizes on save: it rewrites `text:continue-list` to `text:continue-numbering` when the continued list is the previous one of that style, drops an absolute column width when a relative one exists, converts units to inches, collapses double spaces and splits nested spans. Step 5 must expect these on LibreOffice's side, not treat them as lattice loss.
- Imports: core modules that import `prosemirror-*` do not resolve in plain node, because the packages live in `scripts/node_modules`. `writer-unit.mjs` and `writer-roundtrip.mjs` run with `NODE_PATH=scripts/node_modules` or a small resolve loader, and the CI `writer-roundtrip` job gains `npm ci --prefix scripts --ignore-scripts`.

- [ ] **Step 1:** Failing unit tests: no-op round trip is byte-identical for every corpus file; changing one word changes exactly one line; bolding the same word in two sessions produces the same automatic style name; bolding text already covered by a LibreOffice `T1` with exactly `fo:font-weight="bold"` reuses `T1`; deleting one half of a bookmark pair is refused; a merged-cell table is one `opaque_block`; whitespace fixture round-trips after an edit elsewhere; hostile files return `{ error }` without throwing; 13-large parses and serializes in under 300 ms in node.
- [ ] **Step 2:** Implement until green. Turn on steps 1, 2 and 5 of `writer-roundtrip.mjs`.
- [ ] **Step 3:** Commit: `feat: flat ODT parser, styles and minimal-diff serializer`.

**Acceptance.** `writer-unit.mjs` and the full `writer-roundtrip.mjs` pass for every corpus file and every scripted edit.

**Task 7 follow-ups (review, 2026-11-02).**

- **Publishing and the cache.** Checked on ~wep with a counting build: publishing already reads the per-revision cache. A publish of an unchanged revision, and one of a revision already rendered for a view (share after an open, unshare and share again), made no render. Each new revision is rendered once, by its publish or its first view, whichever comes first. What costs is that every autosave of a shared fodt page is a new revision, so its publish renders it (about 7 s for 13-large on ~wep), and a save that lands while a render runs waits for it: four saves 2.5 s apart made four renders, and two of the saves took 16.7 s and 14.6 s. Reducing that needs a decision (a longer publish gap for fodt pages, or the render off the save's path), not a cache change.
- **The publish off the save path (owner decision, 2026-11-02).** A fodt page's pending publish row carries a hold (`+pub-hold:lp`). It is due once the page has had no save for `+pub-slow-quiet:lp` (6 s), or at the hold (`+pub-slow-cap`, a minute after the first unpublished save), and never within a gap of its last publish. So a burst of autosaves renders once, its newest revision. The publish still reads the page in the writer, so a stale render can never land after a newer revision. The per-revision cache is unchanged. On a clone of ~dep, four shared saves of 13-large 2.5 s apart took 2.8, 18.5, 19.9 and 28.6 s before and 2.4, 4.5, 3.4 and 4.8 s after (an unshared page: 1.9, 4.5, 6.3 and 6.5 s). The reader showed the last revision 16.6 s after the last save. Markdown's throttle is unchanged.
- **The reader's extra read.** The reader asks a page for its fodt title only when the published body starts as a fodt render does (`+html-pres:lf`, `+fodt-rendered`). Ten reader views of an own html page made ten `page-head` reads before and none after, as on origin/main. A fodt page still gets its title (one read, a cache hit).

**Done (2026-11-02).** `ui-src/writer/` holds `xml.js`, `schema.js`, `parse.js`, `styles.js`, `serialize.js` and `edits.js` (the scripted edits of `edits.json`, which the harness and the unit suite apply). `scripts/writer-unit.mjs` passes 136 checks, and `writer-roundtrip.mjs` runs steps 1, 2 and 5 and passes every corpus file and every scripted edit (`14-lo-gui.fodt` is still pending: it needs the GUI). Notes:

- **Unchanged is decided by content.** A node is copied from its source span when it is the node the parse made, or equal to it (so a document that went through JSON still saves byte-identical). The suite also checks that writing every node again, copying nothing, reproduces each corpus file byte for byte, so the writer alone matches LibreOffice's layout and white space.
- **Imports in node.** `scripts/lib/writer-node.mjs` adds a resolve hook (`module.registerHooks`, else `module.register`) that resolves the core's bare `prosemirror-*` imports from `scripts/node_modules`. The CI `writer-roundtrip` job now runs `npm ci --prefix scripts`, and the static job runs `writer-unit.mjs` after the writer.js build.
- **White space after an inline element.** A zero-width marker (bookmark, reference mark, change mark, index mark, comment end, soft page break) does not end a run of spaces; any other inline element does, as LibreOffice reads it.
- **edits.json.** 03-inline's scripted bold reuses LibreOffice's `T1`, so it adds a span and no style: its `adds` is now `text:span` only. Step 5 now looks for the words the edit put in, not LibreOffice's txt line, which carries list labels, outline numbers and tab-joined cells.
- **Timing.** 13-large parses in about 150 ms in node; parse, edit and serialize together stay under 300 ms.
- `writer.js` is 296.2 KB raw and 93.5 KB gzipped with the core in it.
- **Review (2026-11-02).** Two losses fixed. The parser now reads white space as LibreOffice 26.8 does: a literal space after `text:s`, `text:tab`, `text:line-break` or an inline soft page break is kept, and LibreOffice writes one after a line break. A new automatic style derived from one with child elements (tab stops, drop caps, `style:map`) now writes them back. writer-unit checks both against LibreOffice's txt export. For Task 9: a split or paste copies `src` and `xattrs`, `xml:id` included, so the editor should drop both from the copy.

### Task 9: The editor view

**Files:**
- Create: `ui-src/writer/view.js` (`<lat-writer>` element: sheet with page width and margins, generated style CSS scoped to the element, node views for opaque nodes, page-break rule)
- Create: `ui-src/writer/toolbar.js` (paragraph style picker by display name, character style picker, B I U S, bullet and numbered list, indent and outdent, link, quote, page break, insert table, add and remove row and column, header row toggle)
- Create: `ui-src/writer/keys.js` (keymap: Ctrl+B/I/U, Ctrl+1..6 for headings, Ctrl+0 for body text, Enter and Backspace list behaviour, Tab in tables)
- Create: `ui-src/writer/paste.js` (paste from LibreOffice, a browser page and plain text into the schema)
- Create: `scripts/ui-writer.mjs` (browser suite)

- [ ] **Step 1:** Failing browser tests: each toolbar action produces the expected body change in the serialized fodt; Ctrl+Z undoes it; pasting HTML with `<script>` and `onclick` inserts only text; a `javascript:` link is not clickable and the link dialog warns; a phone-width viewport (390 px) scales the sheet and keeps the toolbar usable; IME composition (a puppeteer `Input.imeSetComposition` sequence) commits the composed text.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit: `feat: WYSIWYG view for Writer documents`.

**Acceptance.** Every phase 1 feature can be applied, removed and undone, and the result passes the round-trip harness when saved.

**Done (2026-11-02).** `ui-src/writer/` gains `view.js`, `toolbar.js`, `keys.js`, `paste.js` and `blank.fodt`; `writer.js` is 361.8 KB raw and 107.9 KB gzipped, which leaves 38 KB raw of the budget for Task 12. Notes:

- **The sheet** takes the first master page's width and margins and scales both down to fit a narrow pane (no CSS zoom, so ProseMirror's coordinates stay true). The document's paragraph and named character styles become CSS through the strict grammar, matched on `data-ps` and `data-cs` attributes whose values are quoted for CSS by escaping everything but letters, digits, `-` and `_`. A span's other properties go through the same whitelist. List styles map to `list-style-type` for four levels (bullets to disc, circle and square). Table column widths and cell borders from styles are not drawn yet.
- **Toolbar.** Paragraph style, body text and Heading 1 to 6, character style, B I U S, bullet and numbered list, outdent, indent, quote, link, page break before, undo, redo. Insert table, rows, columns and the header toggle are not in it; Tab moves between cells. Ctrl+1 to 6 are also bound as Ctrl+Alt+1 to 6, because Chromium keeps Ctrl+1 to 8 for its tabs. Enter at the end of a block starts one in the style's `style:next-style-name`.
- **Lists** take the document's list style of that kind (List 1 or Numbering 123 when defined, else the first of the kind). With none the button says so: LibreOffice does not apply its built-in list styles by name (checked with 26.8), and lattice adds no named style.
- **Headings and quotes.** LibreOffice 26.8 applies `Quotations` by name when the document does not define it, but drops an undefined `Heading_20_N` on load, so `blank.fodt` defines Text body, Quotations, Heading 1 to 6, List 1 and Numbering 123. It is LibreOffice's default document re-saved by LibreOffice until it settled (42 KB raw, 5 KB gzipped).
- **Paste** keeps no span or file attributes, takes the document's body, heading and list styles, and leaves bookmarks, reference marks and change and comment anchors behind, since a copy would be a duplicate name or half a pair.
- **Splits** (the Task 8 note): after a step that adds structure, the second node with a given span or `xml:id` loses both, and its page break.
- **Macros.** LibreOffice writes an empty Basic `ooo:libraries` in every document, so `macros` now means a library, a module or an event listener.

### Task 10: Shell integration and lazy loading

**Files:**
- Create: `ui-src/lattice/26-writer.js` (loader `writerReady(): Promise`, mount and unmount on kind change, write-back to `src.value` through `edited()` on a 300 ms idle and before save, tab park, split park and unload)
- Modify: `ui-src/lattice/25-editor.js` (hide `#src` and `#hl` while a fodt page is open; skip `render()` for fodt)
- Modify: `ui-src/lattice/27-vim.js`, `22-listedit.js`, `55-autocomplete.js` (inactive for fodt)
- Modify: `ui-src/lattice/35-pages.js` (on open, start the loader and show the server render read-only until it lands; a document whose `parseFodt` reports `tracking` opens read-only with a banner, spec Decisions 5; on create, a fodt page starts from a blank template taken from LibreOffice's own default document, stored in `ui-src/writer/blank.fodt` and inlined at build)
- Modify: `ui-src/lattice/23-tabhead.js` (page menu: Source view, Export .odt, Print or PDF; kind picker refuses switching away from fodt with a note)
- Modify: `ui-src/lattice/28-splits.js` (a parked fodt tab's ghost shows the server render)
- Modify: `ui-src/lattice/60-preview.js` (`fodt` in the local-paint kinds once `LatWriter` exists, else wait for the ship)
- Modify: `code/nex/lattice/app.hoon` (`/<  wjs  ui-app/writer.js` beside 55-59; lay it at `/app/writer.js` beside 145-156; `+serve-ui` whitelist at 9365-9369 with the `?h=` immutable rule; `+sw-js` at 13370 gains a cache-on-first-use list holding `/apps/lattice/app/writer.js`)
- Modify: `scripts/ui-perf.mjs` (no `writer.js` request on a non-fodt cold open; exactly one on the first fodt open, none on the second)
- Modify: `scripts/ui-tabsafe.mjs`, `scripts/ui-offline.mjs` (fodt cases)

- [ ] **Step 1:** Failing tests: the `ui-perf` assertions; type in a fodt tab, switch tabs within the autosave debounce, reload, and the edit is on the ship (`ui-tabsafe`); go offline, edit a fodt page, come back, and the queued save lands with the right base rev (`ui-offline`); open a fodt page offline after one online open (served from the worker cache).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run every `scripts/ui-*.mjs` suite. Nothing outside fodt may change behaviour.
- [ ] **Step 4:** Commit: `feat: open and edit Writer pages in the editor`.

**Acceptance.** Fodt pages create, open, edit, autosave, park, split, go offline and come back like any other page, and the boot request count is unchanged.

**Done (2026-11-02).** `ui-src/lattice/26-writer.js` is the shell side; `app.js` grows by 7.5 KB against release 97, so Task 11 has about 0.5 KB of the spec's 8 KB left and should trim before it adds. Notes:

- **Loading.** `build-ui.mjs` writes `WRITER_H`, the ship's `+js-tag` of the built `writer.js` (first 16 bytes of its SHA-256 as a little-endian atom, printed `@uv`), into `app.js`, and the loader asks for `writer.js?h=H`, which `+serve-ui` answers immutable. A `writer.js` change therefore rebuilds `app.js` too: run `build-writer.mjs` first. The worker caches it on first use (`LAZY` in `+sw-js`), and `+shell-ver` covers it.
- **Write-back.** `render()` (25-editor.js) is the hook: every new text or kind brings the editor up to date in a microtask, so `readOnly` and the revision view are settled. A change marks the page dirty at once; the text goes into `src.value` through `edited()` 300 ms later and at `writerSync`, called by `save`, `autosave`, `snapNow` (tab and split parks), Duplicate, Download and the preview.
- **Refused bodies** show the XML in the textarea with the reason above it, editable for repair (the plan said read-only past a cap; repair needed it editable). Source in the page menu does the same on purpose. Export .odt and Print or PDF are left for Task 12.
- **Kind picker.** A saved page cannot switch to or from fodt; a new page can become fodt only while empty. A new fodt page from the dialog starts from `blank.fodt`.
- **Tests.** The fodt cases planned for `ui-tabsafe.mjs` and `ui-offline.mjs` are sections G and H of `ui-writer.mjs`, next to the rest; `ui-perf.mjs` asserts that boot and markdown opens never ask for `writer.js`. On a clone of ~dep, `ui-writer.mjs` passes 87 checks, and every other ship suite passes except `ui-deskmenu.mjs`, whose `gnext`/`gprev` home check fails the same way on 2e5c644.

### Task 11: Outline, outgoing links and omnibar search

**Files:**
- Modify: `ui-src/lattice/76-outline.js` (fodt headings and links from `fodtOutline` and `fodtLinks` when loaded, else from a small regex extractor in `app.js`)
- Modify: `ui-src/lattice/79-search.js` (`searchText(kind, body)` memoized by path and rev, used by `qHit`)
- Modify: `scripts/ui-links.mjs` or a new `scripts/ui-writer-search.mjs`

- [ ] **Step 1:** Failing tests: the outline lists a corpus file's headings; the omnibar finds a body word and does not find `style-name`; the snippet shows text, not XML.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit: `feat: outline and search for Writer pages`.

**Acceptance.** Search and the right pane treat a fodt page as text.

**Done (2026-11-02).** Notes:

- **Outline and Outgoing** come from `LatWriter.extract` (`outline`, and a new `out`: the `text:a` targets that `safeHref` allows, not in-page, deduped). Before writer.js is here the tab asks for it and repaints when it lands (`wrX`, 26-writer.js); there is no regex extractor in app.js for these. A click on a heading puts the caret in it through the controller's new `heading(i)`.
- **Omnibar.** `searchText(kind, body, path)` in 79-search.js, memoized per path on the body. It uses `LatWriter.extract.text` once loaded, else a three-regex extractor over `office:body` that decodes only `&amp;`.
- **Budget.** app.js is 663,002 bytes, 51 under the 8 KB allowance. Room came from: `mount()` returning the whole refusal sentence, `LatWriter.show()` replacing 60-preview's `fodtHtml` fallback, and the `<lat-writer>` overlay and loading-frame styles moving to index.html. Any further shell work for Writer has to move something first; the next candidates are the loading frame in `wrBox` and `kindSwitchOk`'s messages.

### Task 12: Import and export

**Files:**
- Create: `ui-src/writer/odt.js` (unzip with central-directory parse and `DecompressionStream('deflate-raw')`, a vendored MIT inflate fallback, fodt assembly from `content.xml`, `styles.xml`, `meta.xml`, `settings.xml` with automatic-style clash renaming; odt export with STORED entries, `mimetype` first, `META-INF/manifest.xml`)
- Create: `ui-src/writer/print.js` (print stylesheet with `@page` size and margins from the page layout)
- Modify: `ui-src/lattice/70-upload.js` (`.odt` read as `ArrayBuffer`, loads the writer, converts, uploads as kind `fodt`; a note lists dropped pictures)
- Modify: `ui-src/lattice/23-tabhead.js` (Export .odt, Print or PDF)
- Create: `scripts/ui-writer-import.mjs`

- [ ] **Step 1:** Failing tests: each corpus `.odt` imports to a fodt whose LibreOffice canonical form equals the canonical form of the corpus `.fodt` saved from the same document; an exported `.odt` opens in `soffice --headless --convert-to fodt` and canonicalizes equal to the source; a zip bomb (a 10 KB entry that inflates past 50 MB) is refused; an `.odt` with pictures imports with the note.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit: `feat: import and export .odt, print Writer pages`.

- Also (moved here from Task 4 in review): add the inbound alias `odt: 'fodt'` to EXT_KIND only together with the importer, so an `.odt` reaches `odt.js` and never the text read. kind-parity then needs named exceptions for projection.rs, KMAP and desktop `PAGE_EXTS` (or a desktop picker that hands `.odt` over as bytes), and a test that a vault restore and a mount never take a `.odt` as text.

**Acceptance.** `.odt` in and out works in the browser with no desktop, and printing gives paginated output with the document's page size and margins.

**Done (2026-11-02).** `ui-src/writer/odt.js` and `print.js`; tests in `scripts/writer-odt.mjs` (pure node plus LibreOffice, added to the CI round-trip job) and `scripts/ui-writer-import.mjs` (browser). writer.js is 378.3 KB raw and 113.7 KB gzipped. Notes:

- **Inflate fallback** is `tiny-inflate` 1.0.3 (MIT), pinned in scripts/package.json and added to writer-licences.mjs's roots, so its notice is in vendor/LICENSES. An entry may inflate to 16 MB and to no more than its stated size; the parts together are held to the 8 MB document cap.
- **Basic macros** are not dropped: `Basic/` libraries become the embedded `office:script` a flat file carries (10-unknown needs this to compare equal). Pictures, embedded objects and linked libraries are left out, named in the upload panel.
- **Relative links.** LibreOffice resolves a relative `xlink:href` in a package from inside it and in a flat file from beside it (26.8), so import drops one leading `../` and export adds one. Without that, 05-links and 10-unknown move their link targets.
- **Export split.** styles.xml gets the page layouts and the automatic styles the master pages use, transitively; content.xml gets the rest. LibreOffice 24.2 (CI) reads its own `.odt` of 06-quote-break and 09-layout differently from its `.fodt` (a paragraph style gains a list style or a master page name), so writer-odt.mjs accepts an export that matches LibreOffice's own `.odt` of the document there. Checked in an Ubuntu 24.04 container.
- **Clash renaming** renames styles.xml's automatic style (`P1` to `MP1_1`) and rewrites `*style-name` and `style:page-layout-name` in styles.xml's automatic and master styles only.
- **Export .odt and Print are toolbar buttons** in the editor (`.odt` and `⎙`), not page-menu items in 23-tabhead.js: app.js had no room, and the toolbar has the editor's current text. They work on read-only documents too. A refused body (shown as XML) has neither.
- **Print** prints `render(text, true)`, which adds `@page` size and margins from the first master page (lengths through the strict grammar; Letter and 2 cm otherwise) and page breaks as `break-before:page`, from a `sandbox="allow-same-origin allow-modals"` frame, so nothing in it runs.
- **`.odt` alias.** `EXT_KIND` has `odt: 'fodt'`. kind-parity.mjs names it as bytes-only and checks it is absent from vault.js's KMAP, projection.rs (where a `.odt` is scratch) and desktop PAGE_EXTS, so the desktop picker does not offer it yet.
- **Checks.** Each corpus `.odt` imports to a fodt whose LibreOffice canonical form equals the corpus `.fodt`'s; each `.fodt` exports to an `.odt` that canonicalizes equal to it; each imported file takes its scripted edit and LibreOffice reads the edit; zip bombs (honest and lying sizes, both inflaters) are refused. In the browser, an uploaded `.odt` opens in the editor, an edit exported from the toolbar is read by LibreOffice, and Print's frame has the page size.

### Task 13: Security pass

**Files:**
- Create: `scripts/ui-writer-hostile.mjs`
- Modify: `scripts/fuzz-api.mjs` (fodt bodies from the hostile set and from a mutator over the corpus)
- Modify: `tests/lib/lattice-fodt.hoon` (any case the fuzz finds)

- [ ] **Step 1:** Open every hostile file as an owner page and as a peer's shared page, in the editor, the preview, the reader, `/c` and `page-dump?render=1`. Assert no script runs (a `window.__PWNED` probe, as `60-preview.js` describes), no request leaves the origin (puppeteer request interception), no fiber crash appears in `/rise.json`, and each surface shows the note or safe output.
- [ ] **Step 2:** Run `fuzz-api.mjs` with fodt bodies for a fixed budget. Fix and add tests for anything found.
- [ ] **Step 2b (from the Task 3 review):** A key cannot save `type=fodt`, but the local `page-save` path does not check the existing page's kind, so a key with write scope can replace a fodt page with an md or text body (the link path already checks `kind.l`). Decide with the owner whether Decisions 6 covers overwriting, and if so refuse a keyed save onto an existing fodt page, with an api-matrix case.
- [ ] **Step 2c:** An agent key may not change an existing fodt page's kind (a page-save or batch save with type other than fodt onto a fodt page is refused 403), owner decision 2026-11-02. Add the refusal to the keyed save paths and an api-matrix case for `page-save` and `page-save-batch`.
- [ ] **Step 3:** Commit: `test: hostile Writer documents`.

**Acceptance.** The hostile suite and the fuzz budget pass.

**Done (2026-11-02).** Notes:

- **Step 2c.** `+fodt-at` (app.hoon) reads the page's code grub and asks `+content-builder` for its kind. The keyed page-save checks it after the scope check, and page-save-batch checks every item before anything is written; either answers 403. api-matrix: a scoped key's md and text saves and a batch onto a fodt page are refused, the page keeps its kind and body, and an md save beside it still lands. Step 2b is covered by the same rule (a key cannot save fodt, so any keyed save onto a fodt page would change its kind).
- **ui-writer-hostile.mjs** shows the eight hostile files and a crafted one (data:, macro:, .uno:, script, hex-encoded, tabbed and spaced javascript:, protocol-relative and file: links, style and display names carrying CSS and markup, an event listener inside a link, a linked section, an SVG in binary data, an external image, a comment carrying markup, a dc:title carrying a closing title tag) in the editor, the preview frame, the urb:// reader, /c, /x and page-source?render=1. Nothing runs, nothing leaves the origin, no element carries a handler, unsafe link or url() style, the published copy is inert HTML, the macros item is in the page menu and disabled, and /rise.json does not change. 246 checks pass on a clone of ~dep.
- **Peers.** A real hostile peer was not run: clones are network-isolated and the gate's peer set is ~wep. A peer's %fodt mark is rendered by `+fodt-make`, which is `+fodt-all`, the function the hoon tests and this suite cover; a peer's %html is framed sandboxed, on this build and on release 92.
- **fuzz-api.mjs --only fodt**: the hostile corpus plus 60 mutants (seed 1) and 150 (seed 7) of the small corpus files, saved, rendered, previewed and searched. No findings, so tests/lib/lattice-fodt.hoon gained nothing.
- **JS tokenizer**, probed directly: a DOCTYPE with a subset, a lowercase one, a mid-body ENTITY and an external entity are refused; a bare DOCTYPE, unknown entities, CDATA and out-of-range numeric references open and round-trip byte-identical; depth 300, 200,001 elements and 8 MB plus one byte are refused.
- **Protocol-relative links** (`//host/x`) pass `+safe-url` as relative and are live in the reader and /c. That is an ordinary off-site link (followed only on a click, like an https one), not a scheme bypass. The editor does not make them live.

### Task 14: Phase 1 acceptance

- [ ] **Step 1:** Run the full round-trip harness, every `scripts/ui-*.mjs` suite, `cargo test` in both Rust crates, the hoon tests, `fs-matrix.sh` and `fs-libreoffice.sh` on a fake ship.
- [ ] **Step 2:** Manual pass of the Review Focus list on desktop (Tauri), Chromium, Firefox and a phone.
- [ ] **Step 3:** Record final `writer.js` and `app.js` sizes in the spec.

**Phase 1 acceptance criteria:**
- Byte-identical no-op round trip for every corpus file.
- Every scripted edit passes the LibreOffice no-loss check.
- Every LibreOffice re-save opens in lattice.
- A LibreOffice save on the mount lands as one revision; temps and locks never reach the ship.
- Reader, preview, `/c`, search and the omnibar show text, never raw XML, and never run or fetch anything from a document.
- No `writer.js` request on a non-Writer cold open; `writer.js` within budget.

**Run (2026-11-02), on clones of ~dep at 372363c and later.**

- writer-roundtrip (LibreOffice 26.8): 528 checks, every corpus file no-op byte-identical, every scripted edit passes the no-loss check, every LibreOffice re-save opens and round-trips. 14-lo-gui is still pending (needs a GUI save).
- Through a lattice-fs mount: each corpus file with its scripted edit, saved as a page, is served byte for byte and LibreOffice reads it with canonical element counts equal but the edit's adds (10-unknown keeps its notes, TOC, comments, tracked changes, bookmarks, reference marks, fields, sections, master pages, frame and Basic library). A paragraph typed in the browser editor reads back in LibreOffice the same way. A LibreOffice save onto the mount lands as a fodt page, a second save is one more revision, no lock, temp or conflict reaches the ship, and the saved document opens in the browser editor with the edit and no error.
- Ship suites pass: ui-writer, ui-writer-import, ui-writer-hostile, ui-perf, ui-preview-open, ui-matrix, ui-tabs, ui-shell-tabs, ui-splits, ui-tabsafe, ui-offline, ui-queue, ui-loading, ui-treeorder, ui-treedelete, ui-createdialog and ui-modeswitch; api-matrix, fs-libreoffice.sh, 485 hoon tests on the ship, cargo test in both crates.
- fs-matrix.sh fails 7 checks, none in the fodt cases: the mv-clobber case (coreutils 9.11 `mv` gets EEXIST) and the generic projection, which still uses the instance path from before the desks move. lattice-fs-rs differs from main only in the kind tables, so neither is from this branch.
- Step 2 (Tauri, Firefox, a phone) is the owner's manual pass. Chromium at 390 px is covered by ui-writer, and WebKitGTK was smoke-tested in the Task 12 review.
- Sizes: writer.js 387,772 bytes raw and 116,616 gzipped; app.js 682,763 bytes, 7,680 over release 104.

**Finish (2026-11-02), on release 107.**

- **14-lo-gui.fodt.** `scripts/writer-corpus/lo-gui.xba` drives LibreOffice 26.8 under Xvfb (a window, not --headless): three editing sessions type and format through the dispatcher and save with `.uno:SaveAs` and `.uno:Save`. The file has three rsids, `officeooo:paragraph-rsid` and the view settings. writer-roundtrip passes it: the no-op output is byte-identical and LibreOffice's re-saves are canonically identical.
- **Step 2, scripted.** One pass per engine against a clone: open a fodt page, type with real key events, select a word and click Bold, wait for the autosave on the ship, reload, check the word is still there and bold, open Read and check the preview frame, share it and check the urb:// reader. WebKitGTK 2.50.4 (WebKitWebDriver and MiniBrowser), Firefox 155 (puppeteer over WebDriver BiDi; geckodriver is not installed) and Chromium at 390x844 with touch: 18 checks each, all pass.
- **Found and fixed.** In WebKitGTK the toolbar's buttons did not take a click: once the bar overflowed, its horizontal scrollbar was hit-tested over the lower half of every button, so a click on a button's middle landed on the bar. Above phone width the bar now wraps. At phone width it stays one scrolling row (ui-writer E).
- **Two ships.** `gate.mjs --two-ship lattice-gate-peer` deployed this build to ~dep and ~wep. fodt-views.sh with B_URL: ~wep reads four shared hostile files over urb:// (script and iframe, bad links, style injection, external image), each a sandboxed frame without same-origin around an inert render, with no element that runs or loads, no handler, no unsafe href and no url(). In Chromium on ~wep no frame sets `window.__PWNED`, no dialog opens and no request leaves the origin.
- **Gate (b496a40).** 76 of 77 suites pass. ui-links fails one check, "phone: the badge shows in the drawer", and fails it the same way on origin/main (release 107) deployed to the same two ships, so it is not from this branch.
- **Merge.** The branch now carries release 107. Its page menu keeps Source and the macros note beside Copy link, the fodt preview paints through `prevDoc`, and the parked fodt preview in a group goes through `navDoc` (ui-prevnav).
- **Not Writer's.** In WebKitGTK, a reader navigation that the service worker answers with its 303 to `&u=sw<time>` can come back with a guest session that replaces the login cookie. Seen only under WebDriver, where the cookie is set from script, so it may be the harness; worth a look on the desktop app.

---

## Phase 2 (outline)

### Task 15: Images

- Files: `ui-src/writer/schema.js`, `parse.js`, `serialize.js`, `view.js`, `toolbar.js` (`draw:frame` with `draw:image` and `office:binary-data` as an `image` node, anchored as-char or to-paragraph; other anchors stay opaque), `ui-src/writer/odt.js` (import `Pictures/` into binary data, export back to `Pictures/` with manifest entries), `code/lib/lattice-fodt.hoon` (render as `data:` URIs for `image/png`, `image/jpeg`, `image/gif`, `image/webp` only, never SVG, capped per image and per page), `lattice-fs-rs/src/core.rs` (review `MAX_FILE` and warm-up cost with MB bodies), `code/nex/lattice/app.hoon` (`page-dump` inline cap behaviour for large fodt bodies, `+body-cap` for search).
- Tests: corpus `15-images.fodt` (inline, anchored, wrapped, a linked external image), round trip, size caps, hostile SVG.
- Acceptance. Images insert, resize and survive both directions, and a page with images does not slow boot (`ui-perf.mjs`).

### Task 16: Comments display

- Files: `ui-src/writer/view.js` (margin rail for `office:annotation` with author and date), `code/lib/lattice-fodt.hoon` (rendered as footnote-style notes in the reader).
- Acceptance. LibreOffice comments show in lattice and stay intact. Adding comments from lattice is a separate decision.

### Task 17: Tracked changes display

- Files: `ui-src/writer/view.js` (insertions underlined, deletions struck, from `text:tracked-changes` and the change markers), a read-only banner when recording is on (spec, Decisions 5).
- Stretch goal. Accept and reject, which rewrite the body and remove the change region.
- Acceptance. A document with tracked changes looks as it does in LibreOffice with "show changes" on, and is never silently altered.

### Task 18: Desktop conversion bridge

- Files: `desktop/src/office.rs` (modeled on `desktop/src/pandoc.rs`: locate, probe per call, concurrency cap, deadline, a throwaway LibreOffice profile; commands `office_probe`, `docx_to_fodt`, `fodt_to_pdf`), `desktop/src/main.rs` (register beside 383-384), `desktop/capabilities/workspace-remote.json` (grants with justification), `ui-src/lattice/70-upload.js` (`.docx` on desktop), `ui-src/lattice/23-tabhead.js` ("PDF via LibreOffice").
- Tests: Rust unit tests that skip when the tools are absent, as `pandoc.rs` does; `scripts/desktop-commands.mjs` lists the new commands.
- Acceptance. `.docx` imports on a machine with LibreOffice or pandoc, and says plainly what to install on one without.

## Phase 3 (mentioned only)

Calc (`.fods`) and Impress (`.fodp`) as further flat-ODF kinds, reusing the tokenizer, the opaque-node model, the minimal-diff serializer, the kind tables and the corpus approach. No tasks until phase 2 ships.

## Size estimate (phase 1)

- `writer.js` about 330 to 380 KB raw, 100 to 120 KB gzipped, loaded only for Writer pages. `app.js` grows by under 8 KB raw.
- Code is about 3,000 lines of JS in `ui-src/writer/`, about 200 lines in `ui-src/lattice/`, 800 to 1,200 lines of hoon (`lattice-fodt.hoon` plus wiring), under 100 lines of Rust plus tests, and about 1,500 lines of tests and corpus tooling.
- Effort is 14 tasks, roughly 5 to 7 weeks for one engineer, with Task 8 (the serializer) and Task 9 (the view) the largest.
