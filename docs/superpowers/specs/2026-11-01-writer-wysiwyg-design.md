# Writer documents: WYSIWYG editing of LibreOffice files in lattice

## Intent

sneagan wants to write real word-processor documents in lattice and open the same document in desktop LibreOffice Writer, in either order, as often as he likes, with nothing lost in either direction. Lattice gets a WYSIWYG editor for a new page kind that holds a Writer document. LibreOffice reaches the same page as a file through a lattice-fs mount. Everything lattice already does for a page (revisions, conflicts, sharing, publishing, search, the offline queue, lattice-fs) has to keep working for it.

**Anti-goal.** A lattice edit that silently strips something LibreOffice put in the file. A document that looks fine in lattice and has lost its footnotes, its tracked changes or its page layout when it next opens in LibreOffice has failed, even if the editor is pleasant.

Grounded against `origin/main` at 5cc0e7a (release 92). Line numbers below are from that tree. The folder-move work on `fix-folder-move` (a379aba plus the uncommitted `+move-guard` in that worktree) is covered in its own section.

## Decisions made with sneagan

1. **Storage is flat ODT.** A Writer document is stored as a `.fodt` file, LibreOffice's single-file XML form (`<office:document>`). It is a new text page kind, `fodt`. Because it is plain text, lattice revisions, `conflicts/` copies, sharing and publishing, search and lattice-fs all keep working on it unchanged. LibreOffice opens `.fodt` natively from a lattice-fs mount. Binary `.odt` is an import and export format, never the stored form.
2. **Round trip both ways.** The same document is editable in lattice's WYSIWYG editor and in desktop LibreOffice through lattice-fs, interchangeably. Lattice preserves everything it does not understand: unknown elements, unknown attributes, styles, page layout, metadata, tracked changes, fields and bookmarks. A lattice edit never strips a LibreOffice feature, and a LibreOffice save always opens in lattice.
3. **Phase 1 scope.** Text and structure (paragraphs, headings 1 to 6, bold, italic, underline, strikethrough, bullet and numbered lists including nested ones, links, block quotes, page breaks), the document's named paragraph and character styles (applied, and rendered with their fonts, sizes and spacing), and simple tables (rows, columns, cell text, a header row, no merged cells). Images are phase 2.

## Decisions this spec makes (for review)

- **Kind name `fodt`.** The kind is named after the extension, so the kind-parity rule (kinds derive from the extension, `app.hoon:17139-17141`) holds without an alias. `odt` would invite a binary upload being taken as text.
- **Editor engine is ProseMirror, used directly** (not Tiptap), shipped as a separate lazily loaded asset `ui-app/writer.js`. The comparison is below.
- **One canonical buffer.** The fodt text in `#src` stays the single source of truth for save, autosave, tabs, splits and the offline queue. The WYSIWYG view is a projection of it that writes back through `edited()` (`25-editor.js:81`).
- **Serializer changes only what was edited.** Untouched XML is copied byte for byte from the source. This is the core of the round-trip guarantee and of readable revisions.
- **Server-side render of a safe subset** for the reader, the clearweb view, the editor preview and the tree's rendered preview, in a new `code/lib/lattice-fodt.hoon`. Unknown parts are skipped, never echoed.
- **Pagination is out of phase 1.** The editor shows one continuous page column of the right width and margins, with page breaks drawn as rules. Print and PDF export do paginate, because the browser's print engine does that for free.

## How a page kind works today

A page is a `%code` grub whose source is hoon. A content page wraps its body in a fixed shell, so the evaluator runs it like any other page.

- **Save.** `POST /page-save?name=..&type=<kind>` (`app.hoon:2985`, handler `+handle-page-save` at `app.hoon:1089`). `+save-src` (`app.hoon:1075-1083`) wraps the body with `+wrap-content` when the type is in `+content-builders`, otherwise stores it as raw hoon. The conflict rule (`?base=`, a losing body kept under `conflicts/` by `+conflict-name` at `app.hoon:8371`) sits in the same handler (`app.hoon:1124-1145`). The lick port's `%page-save`, which lattice-fs can use, shares `+save-src` (`app.hoon:1064-1067`).
- **The shell.** `+wrap-content` (`app.hoon:13537`) writes `... (BUILDER 'body')` with the body escaped into a hoon cord. `+unwrap-content` (`app.hoon:13617`) and `+plain-body` (`app.hoon:13569`) recover the builder and the body. `+content-builders` (`app.hoon:13665`) is the set `md gmi html text js css tex`. The builder is a constructor in `/lib/lattice-pg` (`lattice-pg.hoon:28-37`), each naming a `+view-mode` (`lattice-pg.hoon:16`).
- **Kind on the wire.** The kind is the builder, reported by `page-tree`, `page-dump` and `page-source` (`app.hoon:8776`, `8889`, `9007`). Page paths carry no extension. Clients add one from a kind table that exists three times: `KIND_EXT`/`EXT_KIND` in `30-tree.js:18-22`, `KMAP` in `ui-app/vault.js:120`, and `ext_for_kind`/`kind_for_ext` in `lattice-fs-rs/src/projection.rs:109-139`. `scripts/kind-parity.mjs` fails CI when they drift (`ci.yml:96`). lattice-fs also has its own allow-list of save types (`lattice.rs:218-222`).
- **Render.** `+preview-inner` (`app.hoon:11605`) renders a body by kind for `POST /page-preview`, `page-source?render=1` and `page-dump?render=1` (`app.hoon:9012`). `+render-shown` (`app.hoon:12696`) renders a page's data by view-mode for the `/x` and clearweb views, with an exhaustive `?-` on the mode. `+clearweb-doc` (`app.hoon:11780`) wraps it for the public surface.
- **Publish and the urb:// reader.** `+pub-flush-one` (`app.hoon:7213`) publishes the unwrapped body under the mark named by `+mode-mark` (`app.hoon:7707`), with the mode from `+builder-mode` (`lattice-pub.hoon:132-137`). The reader's `%pub` branch (`app.hoon:2096-2190`) renders by the resolved mode. Every mode other than `%gmi` and `%html` goes through `+preview-inner` and is inlined in lattice's chrome (`app.hoon:2183-2190`), which is only safe because each renderer escapes. A peer's keened page with a mark outside `view-mode` is dropped to the slow peek (`app.hoon:11113-11116`, `8358`).
- **Search.** `+index-walk` (`app.hoon:8593-8612`) yields every page's unwrapped body. `page-search` (`app.hoon:3036`) tokenizes those bodies on every query. The omnibar searches the bodies `page-dump` inlined, client-side (`79-search.js:97-136`).
- **Keys and edit shares.** `+page-type-ok` (`lattice-keys.hoon:299-303`) lists the kinds an agent key may write. `+edit-lock-msg` (`app.hoon:13607`) names the kinds an edit-shared page may run.
- **The client.** The kind list is `KINDS` in `23-tabhead.js:19`. `<lat-editor>` (`25-editor.js:90-120`) is one textarea `#src` plus a Prism overlay, and every module (vim `27-vim.js`, autocomplete, list edit, preview, outline `76-outline.js:145`, tabs `21-tabs.js:99-208`, splits `28-splits.js:447`) reads or writes `src.value`. Save sends `src.value` (`35-pages.js:524-560`). The preview paints content kinds locally first (`60-preview.js:81-105`).
- **Bundle.** `scripts/build-ui.mjs` concatenates `ui-src/lattice/*.js` into one IIFE, with "no deps, no bundler" (`build-ui.mjs:1-4`). `app.js` is 625 KB raw and 197 KB gzipped at 5cc0e7a. Side assets (`vault.js`, `orrery.js`, `theme.js`) are hoon imports (`app.hoon:55-59`), laid as grubs (`app.hoon:145-156`), served by `+serve-ui` with a MIME whitelist (`app.hoon:9356-9370`), and loaded after boot by `sideScripts` (`99-boot.js:61-75`). The service worker precaches a fixed `SHELL` list (`app.hoon:13370`).

## Data model

### The stored file

The page body is exactly the `.fodt` bytes. Lattice never rewrites the XML declaration, the namespace declarations on `<office:document>`, `office:meta`, `office:settings`, `office:scripts`, `office:font-face-decls`, `office:styles` or `office:master-styles`. LibreOffice pretty-prints a flat ODT with a one-space indent per level and one block element per line, inline content kept on its line (checked with LibreOffice on this machine, `soffice --convert-to fodt`). Lattice's serializer writes new blocks in the same layout, so a lattice revision diff is a few lines.

### Parsing

The client parses with a small hand-written, non-validating XML tokenizer (`ui-src/writer/xml.js`), not `DOMParser`. It has to, for three reasons:

- it records the byte span of every element, which the minimal-diff serializer needs;
- it keeps attribute order, namespace prefixes, quote style and entity spelling exactly, which `DOMParser` normalizes away;
- it never processes a DTD, so entity expansion and external entities are impossible by construction (see Security).

### Mapping to the editor model

The fodt is split into three regions.

1. **Head**, everything before `<office:body>`. Kept as raw text. Parsed read-only for styles: `office:font-face-decls`, `office:styles` (named and default styles), `office:automatic-styles` and `office:master-styles` (page layout). Lattice only ever appends to `office:automatic-styles` (see below).
2. **Body**, the children of `<office:text>`. This becomes the ProseMirror document.
3. **Tail**, `</office:text>` to the end. Kept as raw text.

Every editor node carries `src` (its original byte span, or null when lattice made it) and `xattrs` (its attributes in source order, so unknown attributes ride along). Inside `<office:text>` the mapping is:

| ODF | Editor node or mark | Notes |
| --- | --- | --- |
| `text:p` | `paragraph` | `text:style-name` kept. The style decides the look. |
| `text:h` with `text:outline-level` 1 to 6 | `heading` | level from the attribute. Levels 7 to 10 stay headings, shown at level 6 size. |
| `text:p` with a paragraph style named `Quotations` or inheriting from it | `paragraph`, shown as a block quote | ODF has no quote element. The quote button applies LibreOffice's built-in `Quotations` style. |
| `fo:break-before="page"` in the paragraph's automatic style | `paragraph` with `pageBreak` | inserting one adds or reuses an automatic paragraph style. |
| `text:list`, `text:list-item`, `text:list-header` | `list`, `list_item` | `text:style-name` and `text:continue-numbering` kept. Bullet or number comes from the list style. Nesting is a `text:list` inside an item. |
| `table:table` with `table:table-column`, `table:table-header-rows`, `table:table-row`, `table:table-cell` | `table`, `table_row`, `table_cell` (`header` attr) | phase 1 refuses to edit structure of a table that has `table:number-columns-spanned`, `table:number-rows-spanned` or `table:covered-table-cell`. Such a table opens as an opaque block. |
| `text:section` | `section` | a transparent container. Its children stay editable and its attributes ride along. |
| `text:span` with an automatic style | marks `strong`, `em`, `underline`, `strike` | resolved from `fo:font-weight`, `fo:font-style`, `style:text-underline-style`, `style:text-line-through-style`. Any other property in that automatic style is kept in a `spanStyle` mark attr so it is not lost. |
| `text:span` with a named text style | mark `charStyle(name)` | |
| `text:a` | mark `link` | `xlink:href`, `office:target-frame-name`, `text:style-name` and the rest of `xattrs` kept. |
| `text:s`, `text:tab`, `text:line-break` | spaces, a tab character, `hard_break` | written back as the same elements. |
| `text:soft-page-break` | opaque inline atom | a layout hint LibreOffice recomputes. Kept where it was. |
| anything else, inline (`text:bookmark*`, `text:note`, `text:date`, `text:page-number`, every field, `text:change*`, `office:annotation*`, `draw:frame`, `text:ruby`, `text:meta`, `text:reference-mark*`, ...) | `opaque_inline` atom | carries the raw XML string. Shows its text (a field's current value, a note's marker) read-only. |
| anything else, block (`text:tracked-changes`, `text:sequence-decls`, `text:table-of-content`, `text:alphabetical-index`, `table:table` with merges, `draw:*` anchored to the page, ...) | `opaque_block` atom | carries the raw XML string. Shows a labelled box with whatever text it holds. |

The rule for anything not in the table is "opaque, carried verbatim". An opaque node can be moved or deleted as a whole (a delete is an explicit user action) and never edited inside.

**Paired markers.** `text:bookmark-start`/`-end`, `text:reference-mark-start`/`-end`, `text:change-start`/`-end` and `office:annotation`/`office:annotation-end` come in pairs that can span paragraphs. A ProseMirror `filterTransaction` refuses a step that deletes one half of a pair and not the other, and the toolbar says why. The serializer also checks pairs and refuses to save an unbalanced document (it keeps the last good body), so a bug here shows as a refused save, never a corrupt file.

### Styles and automatic-style churn

`office:styles` and `office:automatic-styles` are kept verbatim. Lattice never renames, reorders or deletes a style.

- Applying a **named** style (the style picker lists the named paragraph and character styles the document defines, by `style:display-name`) only changes `text:style-name` on the paragraph or span. No style is added.
- Direct formatting (bold, italic, underline, strike, page break) needs an **automatic** style. Lattice builds a canonical key for the wanted style (family, parent style, and the sorted property set) and reuses any existing automatic style with exactly that key, including ones LibreOffice wrote. Only when none matches does it append a new one.
- A new automatic style is named `L` plus the family letter plus the first eight hex digits of a hash of its canonical key, for example `LT3fa9c210`. Same formatting gives the same name in every session and on every ship, so two edits that bold the same thing do not produce two styles or a spurious diff. It cannot collide with LibreOffice's `P1`, `T1`, `L1` names.
- Lattice never deletes an automatic style it no longer uses. LibreOffice drops unused automatic styles on its next save anyway, and a lattice delete would be churn.
- LibreOffice renumbers its own automatic styles, rewrites `office:settings` (cursor position, view area) and adds `officeooo:rsid` attributes on every save. That churn is LibreOffice's, not lattice's, and lattice cannot prevent it. It is why a LibreOffice save shows as a large revision diff. See Conflicts for how a later merge copes.

### The serializer

Saving walks the editor document against the original source:

- an unchanged node (same `src` span, same attrs, same content) is emitted by copying its original bytes;
- a changed node is re-serialized with the indent of its position, its `xattrs` in their original order, then any attribute lattice changed;
- a new node is serialized in LibreOffice's layout;
- the head is copied, with new automatic styles inserted just before `</office:automatic-styles>`;
- the tail is copied.

So a lattice edit that changes one word changes one line, and an open and save with no edit is byte-identical. Both are tested on every corpus file.

Text is escaped with the five XML entities only. Runs of spaces become `text:s` with `text:c`, a leading space becomes `text:s`, tabs become `text:tab` and hard breaks `text:line-break`, matching ODF whitespace rules.

### Where the model lives in the client

`#src` keeps the fodt text. `<lat-writer>` mounts over the editor area when the open page's kind is `fodt` and hides the textarea and highlighter. On every ProseMirror transaction it marks itself dirty, and on a 300 ms idle (and before any save, tab switch or split park) it serializes into `src.value` and calls `edited()`. Save, autosave, the conflict rule, the offline queue, tabs (`21-tabs.js:99`) and splits (`28-splits.js:447`) see an ordinary text page and need no change. Vim, autocomplete and list editing are switched off while a fodt page is open, since they act on the hidden textarea. A **Source** item in the page menu shows the textarea with the raw XML, for repair. The kind picker refuses to switch a fodt page to another kind and back, since that would reinterpret the XML.

## Editor choice

| Option | Licence | Size (min / gzip, est.) | Lazy load | Mobile | Opaque-node fit | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| ProseMirror (model, state, view, transform, commands, keymap, history, inputrules, schema-list, tables) | MIT | about 270 KB / 85 KB | one asset | good, years of IME fixes, known Android quirks handled | excellent: strict schema, atom nodes with raw attrs, `filterTransaction` for pairs, node views for opaque boxes | **recommended** |
| Tiptap on ProseMirror | MIT core, some extensions paid | ProseMirror plus about 100 KB | one asset | same as ProseMirror | same engine, but its JSON and HTML serializers are bypassed by our own, so its layer adds size and nothing we use | no |
| Lexical | MIT | about 200 KB / 65 KB with rich text, list, table, link | one asset | good | decorator nodes work, but node state must be class instances and the API is still 0.x and churns | second choice |
| Hand-rolled contenteditable | ours | small | yes | poor until years of IME, selection, paste and undo work are done | full control | no |
| WebODF | AGPL-3.0, unmaintained since about 2016 | large | no | poor | native ODF | no |
| Collabora Online (CODE) | MPL-2.0 | a LibreOffice server per document, GBs | n/a | ok | perfect fidelity | no. It needs a server beside the ship and cannot run on Urbit |
| ONLYOFFICE Docs | AGPL-3.0 | server | n/a | ok | converts ODF through OOXML internally, which is lossy | no |
| odfjs | CC0 | small | yes | n/a | reads ODS and fills ODT templates, no editing | no, useful only as reference |
| LibreOffice in WebAssembly (ZetaOffice, ZetaJS) | MPL-2.0 | hundreds of MB, reported near 1 GB of memory in 2025 | no | no | perfect fidelity | no, revisit if it shrinks |

**Licence rules for the client.** Lattice is PolyForm Noncommercial. MIT, ISC and BSD code may go in a bundle with its notices kept. MPL-2.0 is file-level copyleft, so it is acceptable only as a separate, unmodified file whose source we point to, never concatenated into `app.js`. LGPL in a minified JS bundle cannot meet the relinking requirement in any clean way, so it is excluded. GPL and AGPL are excluded. A CI check (`scripts/writer-licences.mjs`) reads the vendored packages' `license` fields and fails on anything outside MIT, ISC, BSD-2 and BSD-3.

**Recommendation.** ProseMirror, used directly. It is the only option that is permissive, small enough to lazy-load, mature on mobile, and built around a strict schema where an opaque atom carrying raw XML is a first-class node. This is lattice's first runtime client dependency, which breaks the "no deps" line in `build-ui.mjs:3` and the phase 1 shell plan's rule. The owner approved that on 2026-11-01 (Decisions, 1). The cost is contained. ProseMirror is vendored at pinned versions into `ui-src/writer/vendor/`, built by esbuild (a dev dependency, run with `npm ci --ignore-scripts` like the test packages in `scripts/package.json`) into one file, `code/nex/lattice/ui-app/writer.js`, and CI rebuilds and diffs it the way it does `app.js` (`ci.yml:144-146`).

## Bundle and lazy loading

`app.js` does not grow by more than about 8 KB raw. It gains the kind tables, a loader, the client text extractor for search, and the hooks in `25-editor.js` and `35-pages.js`. Everything else lives in `writer.js`, estimated at 330 to 380 KB raw and 100 to 120 KB gzipped (ProseMirror plus about 3,000 lines of lattice code: tokenizer, model mapping, style resolver, serializer, toolbar, import and export). Task 1 of the plan measured the ProseMirror part on 2026-11-01: with all twelve packages bundled (model, state, view, transform, commands, keymap, history, inputrules, schema-list, tables, dropcursor, gapcursor, plus orderedmap, rope-sequence and w3c-keyname), esbuild minified, and the MIT notices as a banner, `writer.js` is 267.7 KB raw and 84.0 KB gzipped (gzip -9), in line with the estimate. Two builds are byte-identical. The CI budget for the whole of phase 1 is 400 KB raw and 130 KB gzipped, which leaves about 130 KB raw and 46 KB gzipped for lattice's own writer code.

- `writer.js` is served like `orrery.js`: a `/<` import, a grub at `/app/writer.js`, a line in `+serve-ui`'s whitelist, `application/javascript` so vere gzips it (`app.hoon:9338-9340`), and the `?h=` immutable hash that `app.js` uses.
- It loads only when a fodt page is opened or created, by injecting a script tag, and never at boot. Until it lands the page shows the server render read-only with a "loading editor" note, so a slow pier never shows an empty pane.
- The service worker caches it on first fetch and serves it cache-first after that, so a Writer page opened once is editable offline. It is not added to the install-time `SHELL` precache, which would put about 110 KB and one serialized pier request on every install for users who never open a Writer page. That needs a small "cache on first use" list beside `SHELL` in `+sw-js` (`app.hoon:13370`).
- `scripts/ui-perf.mjs` gains an assertion that opening a non-fodt page makes no request for `writer.js`.

## Rendering fidelity

"WYSIWYG" here means the editor shows the document's own typography in a page-shaped column. It does not mean LibreOffice's layout engine.

What phase 1 renders faithfully:

- **Page width and margins.** From the `style:page-layout` that the first `style:master-page` uses (`fo:page-width`, `fo:margin-left`, `fo:margin-right`, `fo:margin-top`). The editor draws a sheet of that width with those margins, scaled down to fit a narrow pane or a phone.
- **Named styles.** Paragraph and text styles resolved through `style:parent-style-name` and `style:default-style`, converted to CSS classes. Supported properties are `fo:font-size` (absolute and percent), `style:font-name` through `office:font-face-decls`, `fo:font-family`, `fo:font-weight`, `fo:font-style`, `fo:color`, `fo:background-color`, `fo:margin-top`, `fo:margin-bottom`, `fo:margin-left`, `fo:margin-right`, `fo:text-indent`, `fo:line-height`, `fo:text-align`, `style:text-underline-style`, `style:text-line-through-style`, `fo:text-transform`, `fo:font-variant` and `fo:letter-spacing`. Units `cm mm in pt pc px %` are converted. Anything else is ignored for display and kept in the file.
- **Fonts.** The family from the style, then the `svg:font-family` and `style:font-family-generic` of its font-face declaration, then a generic fallback (`serif`, `sans-serif`, `monospace`). Liberation Serif and Liberation Sans, LibreOffice's defaults, map to `"Liberation Serif", "Times New Roman", Times, serif` and the sans equivalent. No web fonts are fetched (no external requests from a document).
- **Lists.** Bullet characters and number formats from the list style's level properties (`text:bullet-char`, `style:num-format`, `style:num-suffix`), with indents from `fo:margin-left` and `text:min-label-width`.
- **Tables.** Column widths from `style:column-width` or `style:rel-column-width`, borders and cell padding from the cell styles.

What phase 1 does not do, said plainly:

- **No pagination.** The editor is one continuous sheet. Page breaks show as a dashed rule labelled "page break". Headers, footers and page numbers are not shown in the editor (they are kept in the file). Line and page breaks will not match LibreOffice exactly, because fonts and hyphenation differ.
- **Print and PDF do paginate.** The print stylesheet sets `@page { size; margin }` from the page layout and lets the browser break pages. Cheap, honest, close enough for a draft, and not identical to LibreOffice.

## Server-side rendering for the reader and published views

A new library, `code/lib/lattice-fodt.hoon`, renders the same phase 1 subset to HTML. It is used by `+preview-inner` (the editor preview, `page-source?render=1` and `page-dump?render=1`), `+render-shown` (the `/x` view and the clearweb view through `+clearweb-doc`), and the reader's `%pub` branch, which already sends every non-`%gmi`, non-`%html` mode through `+preview-inner` (`app.hoon:2187`).

- **A new view-mode `%fodt`.** Added to `+view-mode` (`lattice-pg.hoon:16`), with a constructor ``++ fodt |=(f=@t `result`[`f ~ %fodt ~ ~])``, the builder in `+content-builders` and `+builder-mode`. The exhaustive `?-` in `+render-shown` then refuses to compile until every switch handles it, which is the point.
- **Output is built, never copied.** The renderer emits only `p h1-h6 ul ol li table thead tbody tr th td a span strong em u s br blockquote hr div`, escapes every text node with `+esc`, and writes `style` attributes from parsed property values that match a strict grammar (a number and a unit, a `#rrggbb` colour, a font family of letters, digits, spaces and hyphens). A raw ODF string never reaches the HTML. So the fragment is safe to inline in lattice's chrome for a peer's page, like markdown.
- **Unknown parts.** An opaque block renders as its plain text in a muted box, or nothing if it has none. An opaque inline renders as its text. `office:scripts`, `office:settings`, `office:binary-data` and `draw:*` are skipped entirely.
- **Page shape.** The fragment is wrapped in `<div class="fodt" style="max-width:<page width>;padding:<margins>">` with the document's style rules as scoped CSS classes generated by the same whitelist.
- **Title.** `+page-title-of` (`app.hoon:6754`) looks for a `#` line. For fodt it takes the first `text:h` (or `dc:title` in `office:meta` when set).
- **Cost.** Rendering is a linear scan. Pages over 2 MB render the "page too large or not previewable" note the clearweb view already uses (`app.hoon:11572`). If measurement shows a large document's render costs more than a few hundred milliseconds of pier time, the rendered fragment is cached per revision in a grub beside the page. That is a measured decision in the plan, not assumed.
- **Publishing (decided 2026-11-01).** A published fodt page goes out as its rendered HTML fragment under the existing `%html` mark, not as raw fodt. `+pub-flush-one` calls `fodt-html` for a fodt page and publishes the result with `+mode-mark` giving `%html`. Every peer, including one on an older lattice, renders it through the reader's existing `%html` branch, framed and sandboxed. The published copy is a view, not a document: peers cannot copy it back as a Writer page. No `%fodt` mark goes over the wire, so old peers need no update.

## lattice-fs and LibreOffice

### Mapping

A fodt page appears as `name.fodt` once `fodt` is in `ext_for_kind` and `kind_for_ext` (`projection.rs:109-139`), in `LatticeProjection::write`'s save-type list (`lattice.rs:218-222`), and in the two browser tables (checked by `kind-parity.mjs`). Reads go through `page-source` (`lattice.rs:138`), which returns the unwrapped body, so LibreOffice reads the exact fodt bytes.

### LibreOffice's save pattern

LibreOffice, opening and saving a document in a directory, does the following (to be confirmed with `strace -f -e trace=file` on the LibreOffice versions sneagan uses, as Task 5 of the plan):

- creates a lock file `.~lock.<name>.fodt#` beside the document on open, rewrites it, and removes it on close;
- writes the new content to a temporary file, typically `lu<random>.tmp` in the same directory (or in the system temp dir, then copies), and moves it over the document;
- may probe writability by creating and deleting a scratch file;
- compares the document's mtime with the one it loaded and warns "document has been modified by someone else" when they differ.

How lattice-fs handles each:

- **Lock file.** `.~lock.report.fodt#` starts with `.`, so `is_editor_temp` (`core.rs:747`) accepts it as scratch, and `is_scratch` (`core.rs:714`) sees the extension `fodt#`, which `kind_for_ext` answers `hoon` for, so it is scratch. It lives in the mount's RAM scratch map and never reaches the ship. That is correct, with one limit. The lock is visible only on that mount. The web editor and another device's mount do not see it (see Risks).
- **`lu*.tmp`.** Extension `tmp` is in `TEMP_EXTS` (`core.rs:748`), so the temp is scratch. The rename onto `report.fodt` is `EditorMove::Promote` (`core.rs:1623-1625`), and `promote` (`core.rs:500-537`) writes the temp's bytes with the destination's kind, which becomes `fodt` from the extension. A failed write keeps the temp's bytes for a retry.
- **Copy-over instead of rename.** If LibreOffice truncates and rewrites the file in place, the ordinary handle write path flushes the buffer on close (`core.rs:464-489`), also with kind `fodt`.
- **mtime check.** The mount reports the ship's mtime. After a web edit lands and the mount refreshes, LibreOffice's next save warns about an outside change, which is the behaviour we want.
- **Size.** `MAX_FILE` is 64 MiB (`core.rs:40`). Not a phase 1 concern. Phase 2 images change that (see Risks).

### Folder-move refusals (`fix-folder-move`)

That branch makes a save into a folder under a move answer 409 "is being moved to", and an overwrite of a page that moved away in the last hour answer 409 "moved to" (`+move-guard`, uncommitted in the `lattice-folder-move` worktree). lattice-fs maps those to EBUSY and ENOENT (`lattice.rs` `moved()`), and `promote` and the handle write path throw away the stale listing (`core.rs` `moved_away()`). With LibreOffice holding a document whose folder moved:

- **Listing not yet refreshed.** LibreOffice's temp rename is a `Promote` onto a path the mount still lists, so it is an overwrite, the ship refuses it as moved, and LibreOffice shows a general save error. The document stays open in LibreOffice and "Save As" to the new path works. Nothing is lost and the old folder is not made again. Good.
- **Listing already refreshed.** The old path is gone from the vtree, so `dst_exists` is false (`core.rs:1601`) and `promote` sends `new=1`. `+move-guard` lets a create at a moved-away path through on purpose ("a new page"), so the save lands and the old folder comes back with one document in it. This is the same for every editor's atomic save, not special to LibreOffice, but LibreOffice users keep documents open for hours, so it will happen. The plan adds an fs-matrix case for it and the folder-move fix for release 93 closes it (Decisions, 7).
- **Lock file after a move.** Creating `.~lock.*#` in a directory that no longer exists fails with ENOENT, which LibreOffice tolerates (it opens the document without a lock).

## Security

A shared or edit-shared fodt page is XML written by an untrusted peer, and lattice parses it in the owner's browser and in the owner's ship.

- **No DTD processing, anywhere.** The JS tokenizer and the hoon scanner both reject a document containing `<!DOCTYPE` with an internal subset or any `<!ENTITY`, and decode only `&lt; &gt; &amp; &quot; &apos;` and numeric character references. LibreOffice never writes a DOCTYPE in a flat ODT, so this refuses nothing real. XXE and billion-laughs expansion are impossible by construction, not by configuration. A refused document opens in Source view with a banner.
- **Size and depth caps.** WYSIWYG opens documents up to 8 MB, nesting depth 256 and 200,000 elements. Past a cap the page opens read-only in Source view. The hoon renderer caps at 2 MB and depth 256, and runs under `mule` so a hostile document produces the "not previewable" note rather than a crashed fiber. Search extraction is capped by `+body-cap` (`app.hoon:8313`).
- **Links.** The same rules as the existing renderers. Server side, `+safe-url` (`lattice-md.hoon:40`): http, https, urb, mailto, relative and `#`. Client side, the scheme test in `mdHref` (`59-md.js:39-44`), run after decoding entities. `javascript:`, `data:`, `file:`, `vnd.sun.star.script:` (LibreOffice macro links), `macro:` and `.uno:` links are not made live in the editor, the reader or the published view. They are kept in the file, and the link dialog shows the raw target with a warning.
- **No external fetches.** No fonts, images or linked sections are fetched by lattice from a document. `text:section` with an `xlink:href` (a linked section) and `draw:image` with an external `xlink:href` stay opaque.
- **Macros.** `office:scripts` and `office:event-listeners` are kept verbatim and never interpreted. A document that carries Basic macros gets a "contains macros" note in the page menu, because the same file opened from the mount in LibreOffice will offer to run them. LibreOffice's own macro security (by default it asks or refuses) is the control there.
- **Style values.** CSS is generated only from parsed values that match the grammar above, in the editor and on the ship, so a style property cannot inject `url()`, `expression()` or a closing tag.
- **The editor view.** ProseMirror renders through DOM APIs, not `innerHTML`, and opaque node views set `textContent` only. Paste goes through a ProseMirror `DOMParser` with the schema, so pasted HTML cannot bring attributes or elements the schema does not know.
- **Keys.** `fodt` is not added to `+page-type-ok` (`lattice-keys.hoon:299-303`) in phase 1. The output is escaped, so it would be safe, but agent-written Writer documents stay off for now (Decisions, 6).
- **Edit shares.** `fodt` is added to `+edit-lock-msg`'s list of content kinds (`app.hoon:13607`), since it is content, not hoon.

## Conflicts and offline

- A conflicted save of a fodt page keeps the losing body as `conflicts/<name>-rev<N>` exactly as for any page (`app.hoon:1131-1145`), with the same builder, so the copy is itself a fodt page. It opens in the WYSIWYG editor, and from the mount as `conflicts/<name>-rev<N>.fodt` in LibreOffice, which has its own "Compare Document" for the human merge.
- The offline queue (`08-offline.js`, the desktop's Rust queue) stores the body text and the base rev, so it needs nothing new. A queued fodt save is a full document, typically 30 to 200 KB.
- **Three-way merge later.** Feasible for lattice-to-lattice edits, because the serializer writes one block per line and copies untouched lines, so a line-level diff3 on the body region merges independent paragraph edits cleanly. It is not feasible on raw LibreOffice saves, which renumber automatic styles and rewrite settings. A later merge would first normalize all three versions (drop `office:settings` and rsids, rename automatic styles by content hash as lattice does, re-point references), then diff3 the bodies, then fall back to the `conflicts/` copy on any overlap. That is a later phase, not committed here.

## Search and preview

- **Ship search.** `+index-walk` (`app.hoon:8610`) returns `(fodt-text body)` instead of the raw body when the builder is `%fodt`. `+fodt-text` is a linear scan that keeps the character data inside `<office:body>`, turns block ends into newlines, `text:s` into spaces and `text:tab` into tabs, and drops everything in the head. `+mirror-pages` (`app.hoon:17176`) hashes for change detection and must keep the raw body, so the extraction goes in a separate arm used by search and reindex only.
- **Omnibar.** `79-search.js` gets a `searchText(kind, body)` helper in `app.js` (a few lines of regex, memoized by path and rev), so a search for "invoice" does not match `text:style-name`.
- **Tree and preview.** `page-dump?render=1` and `page-source?render=1` return the server render through `+preview-inner`. `60-preview.js` adds `fodt` to its local-paint kinds once `writer.js` is loaded, using the same renderer as the editor. Before that it waits for the ship's render.
- **Outline and outgoing links.** `76-outline.js` reads `src.value`. For fodt it asks the writer for headings (from `text:h`) and links (from `text:a`) instead.

## Import and export

- **Import `.odt`, in the browser, no desktop needed.** The uploader (`70-upload.js:68`) reads each file as text today. For `.odt` it reads an `ArrayBuffer`, unzips it (central directory parse plus `DecompressionStream('deflate-raw')`, with a small MIT inflate as fallback for older WebKitGTK), takes `content.xml`, `styles.xml`, `meta.xml` and `settings.xml`, and builds one `office:document`: the union of the root namespace declarations, then `office:meta`, `office:settings`, `office:scripts`, `office:font-face-decls` (merged by name), `office:styles`, `office:automatic-styles` (styles.xml's and content.xml's, which ODF keeps in separate name scopes, so a clash is renamed and its references rewritten), `office:master-styles` and `office:body`. This is the inverse of what LibreOffice does when it saves flat ODT. Phase 1 drops `Pictures/` with a visible note listing what was dropped. Phase 2 embeds them as `office:binary-data`. The `.odt` extension is an upload-only alias for kind `fodt` (`EXT_KIND` allows inbound-only aliases, `30-tree.js:13-17`).
- **Import `.docx`, desktop only, optional.** A new desktop command modeled on `desktop/src/pandoc.rs`: locate the user's own binary (PATH, then fixed dirs, `pandoc.rs:29-49`), probe per call (`pandoc.rs:78`), cap concurrency (`pandoc.rs:134`), kill past a deadline, return a clear "not installed" answer, never bundle. Two converters, best first: LibreOffice itself (`soffice --headless --convert-to fodt`, near lossless, MPL so bundling would be legal but is 300 MB) and pandoc (`pandoc -f docx -t odt -o -`, lossy, maps styles to pandoc's reference document). soffice runs with a throwaway profile (`-env:UserInstallation=file:///<tmpdir>`) so a hostile document cannot touch the user's profile or macro settings. Both commands are granted in `desktop/capabilities/workspace-remote.json` with the same justification as `convert_tex`. The page supplies bytes only, never a path or a flag.
- **Export `.odt`.** Client-side zip with every entry STORED (no compression needed), `mimetype` first and uncompressed as ODF requires, `META-INF/manifest.xml`, and `content.xml`, `styles.xml`, `meta.xml`, `settings.xml` split back out of the fodt. Offered from the page menu's Download item (`23-tabhead.js:252`), which downloads `.fodt` as-is by default.
- **Export PDF.** The browser print path, with the print stylesheet above. On the desktop, if `soffice` is installed, a "PDF via LibreOffice" item runs `soffice --headless --convert-to pdf` for exact layout.

## Phases

Detailed tasks, files and tests are in the plan, `docs/superpowers/plans/2026-11-01-writer-wysiwyg.md`.

- **Phase 1.** The scope in decision 3, plus the kind end to end (ship, client, lattice-fs, desktop not required), the server renderer, search, `.odt` import and export, print to PDF, and the round-trip corpus with its LibreOffice headless check.
- **Phase 2.** Images come first. That means `draw:frame` with `draw:image` and `office:binary-data` (base64 inline, which is how flat ODT stores them), insert and resize, server render as `data:` image URIs with a MIME whitelist and a size cap. Then comments (`office:annotation`) shown in the margin, then tracked changes shown (insertions and deletions styled from `text:tracked-changes`), with accept and reject as a stretch. Also the desktop `.docx` import and LibreOffice PDF export.
- **Phase 3, mentioned only.** Calc (`.fods`) and Impress (`.fodp`) as further flat-ODF kinds, reusing the tokenizer, the opaque-node approach and the minimal-diff serializer.

## Risks

1. **Round-trip fidelity.** The serializer and the opaque-node model are the whole promise, and the failure is silent loss in a file the user trusts. Paired markers, whitespace rules, lists that continue numbering across interruptions (`text:continue-list`, `xml:id`), sections, and edits inside tracked-change regions are where loss hides. Mitigations are byte-identical no-op round trips, a corpus that covers every listed feature, the LibreOffice headless check, a refused save rather than a bad one, and keeping every revision (lattice already does).
2. **First client dependency and integration with the one-textarea design.** ProseMirror is vendored and built separately, which is new supply-chain surface and a new build step. The editor must coexist with tabs, splits, ghost editors, vim and the offline queue, all built around `#src`. Mitigation is that `#src` stays the canonical buffer, so most of that code never learns fodt exists.
3. **Ship cost and compatibility.** Hoon parsing a large document on every reader and search request, fodt bodies of 40 KB for a one-line document (LibreOffice writes its whole style sheet), and in phase 2 base64 images that make bodies MBs. Together they inflate `page-dump` (which inlines bodies), the term index, publishing and lattice-fs warm-up. Publishing sends rendered HTML, so old peers are unaffected.
4. **Locks are per mount.** LibreOffice's lock file lives in one mount's RAM. The web editor and other devices do not see it, so two people can edit at once and the second save becomes a `conflicts/` copy. That is safe but surprising.
5. **Fidelity expectations.** Users will compare the editor with LibreOffice and see different line breaks and no page numbers. The editor must say what it is (a "draft layout" note on first open) to keep trust.
6. **LibreOffice versions.** Flat ODT output changes between LibreOffice releases (new namespaces, new attributes). The opaque model absorbs that, but the corpus should be regenerated on each LibreOffice major release.

## Decisions (owner, 2026-11-01)

The owner accepted every recommendation and chose HTML for publishing.

1. ProseMirror is approved as lattice's first runtime client dependency, vendored at pinned versions and built by esbuild into a separate lazily loaded `writer.js`.
2. The kind is named `fodt`.
3. `writer.js` is cached by the service worker on first use, not precached at install.
4. Publishing sends the rendered HTML subset under `%html`, not raw fodt. Every peer renders it, and the published copy is not a document.
5. A document with change tracking switched on opens read-only with a banner in phase 1.
6. Agent keys and the MCP `wiki_write` tool cannot write fodt pages for now.
7. A stale save landing as a create at a moved-away path is treated as a bug and fixed in the folder-move work (release 93), not left open.
8. Desktop `.docx` import prefers the user's `soffice` over pandoc when both are installed.
