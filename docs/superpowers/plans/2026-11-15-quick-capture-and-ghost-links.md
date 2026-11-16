# Quick Capture, Quick Open and Ghost Links Implementation Plan

As built: see the "As built (2026-11-15)" section at the end of the design document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new page saves itself to an Inbox with no questions, Ctrl/Cmd+O opens recent pages, the palette lists recently run commands first, and a link to a page that does not exist yet starts that page.

**Architecture:** All four pieces are in the editor's client, plain JavaScript under `ui-src/lattice/`, which shares one closure and is bundled into `code/nex/lattice/ui-app/app.js`. Capture is new logic in the one place a page is created, `save()`. Quick open is a second mode of the palette's own box. Recents and command use are `localStorage` keys. No ship code changes.

**Tech Stack:** Vanilla JS (no framework, no new dependencies), `scripts/build-ui.mjs` for the bundle, puppeteer browser suites in `scripts/ui-*.mjs` over `scripts/lib/harness.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-15-quick-capture-and-ghost-links-design.md` (wiki `specs/2026-11-15-quick-capture-and-ghost-links-design`). Read it first, above all "What exists today" and "How it is built".

## Global Constraints

- Branch `feat-quick-capture` off `origin/main` (version 134), in a new worktree `~/software/personal/lattice-capture`. Never work in `~/software/personal/lattice`.
- Commits as nisfeb <business@nisfeb.com>, no AI attribution, subject `type: summary` with no scope and at most 72 characters, body wrapped at 72. Never `--no-verify`.
- Do not push to `main` and do not bump `code/version.json`. A merge to `main` is a release and waits for sneagan.
- No new dialog, prompt or question in the capture path. Never `alert`, `confirm` or `prompt` anywhere: the editor uses its own dialogs.
- No new request at the editor's start. Recents and command use live in `localStorage`, read with a `try` and a fallback as `05-prefs.js` does.
- Every palette action has a home element carrying `data-action="<id>"`. Every chrome button's tooltip equals its accessible name (`scripts/ui-shell.mjs` checks both).
- The captured name is `inbox/YYYY-MM-DD-NNNN`: the device's local date, a dash, four random digits. A captured page is markdown.
- The bundle is committed: after changing `ui-src/`, run `node scripts/build-ui.mjs` and commit `code/nex/lattice/ui-app/app.js` with the source. `node scripts/app-js-size.mjs` must pass.
- Comments and prose: no em-dashes, short sentences. Comments follow the style of the file they are in.
- Browser suites need a ship. Use a throwaway fake ship only, built the way CI builds it: `scripts/hoon-build.sh base <dir>` from `nisfeb/grubbery` `dist/single-release`, then deploy with `scripts/dev-deploy.py <url> <jar> --add --approve`. Keep piers under `~/.cache/capture-piers/` (`/tmp` is a small tmpfs). Use a free port from 8210 to 8219. Never a fleet ship, never `fleet` commands. Kill any ship you start.

## Plan-level calls (mine)

- One new suite, `scripts/ui-capture.mjs`, holds the checks for all four pieces, one section per task. It is listed wherever the repo lists browser suites (the gate and CI's drift guard).
- Task 1 pulls the part of `newFile` that runs after its dialog into a function, `createPage`, so quick open and ghost links make a named page the same way.
- Recents keep 30 entries and show 10. Command use keeps one timestamp per action id.

## Review Focus

1. Text typed into an unnamed page, then a tab switch, a tab close or a new + within the 2 second autosave delay: the text is captured, not dropped. Test in Task 1.
2. Two captures whose random numbers collide, and a capture whose name was taken by another device: each page is kept under its own name. Test in Task 1.
3. A capture made offline, followed by a reload before the ship is back: it is still queued and lands. Test in Task 1.
4. A name typed into the picker that the dialog would refuse or reshape (a trailing slash, only spaces, an extension, characters the name rules replace): the same result and message as the dialog gives, and never a page with an empty name. Test in Task 2.
5. A link whose target is not a plain page: a memory, a folder, an `urb://` address, a name with `&`, a space or non-ASCII letters. None is dimmed or started wrongly, and the name survives the round trip through the address. Test in Task 4.

---

### Task 1: Inbox capture

**Files:**
- Modify: `ui-src/lattice/35-pages.js` (`save`, `autosave`, `saveParked`, `newFile`, `blankPage`)
- Modify: `ui-src/lattice/21-tabs.js` (`tabNew`), `ui-src/lattice/28-splits.js` (a group's +), `ui-src/lattice/30-tree.js` (the toolbar's New page), `ui-src/lattice/97-mobar.js` (the phone bar), `ui-src/lattice/77-history.js` (`$('mv').onclick`), `ui-src/lattice/23-tabhead.js` (the phone name sheet)
- Modify: `code/nex/lattice/ui-app/app.js` (built)
- Create: `scripts/ui-capture.mjs`
- Modify: the suite lists (`scripts/gate.mjs` and whatever CI's drift guard reads), and any existing suite that expected the new-page dialog from the toolbar or the tab strip

**Interfaces:**
- Produces:
  - `inboxName(d = new Date())` returns `'inbox/' + YYYY-MM-DD + '-' + NNNN` from the local date.
  - `newBlank({ newTab = false } = {})`: a blank markdown page with no dialog and the cursor in the body. It sets the kind to markdown. The dialog-free callers use it.
  - `createPage(name, kind = 'md')`: what `newFile` does today after its dialog returns (the extension rule, `realName`, the pulsing tree row, `save()`). `newFile` calls it. Returns what the old code returned.
  - `startNamed(name)`: a blank markdown editor with the name already set and nothing written, the way `openBrief` starts a missing journal day. `openBrief` uses it.
  - `save()` with an empty name draws `inboxName()` and creates. A 409 on a drawn name draws again, 5 tries at most.
  - A page "never saved" is one where `current === null`. `autosave()` and `saveParked()` hand a never-saved page that has text to `save()`.
  - `$('mv').onclick` on a never-saved page asks for a name with the editor's own dialog and sets it as the name the first save will use.

- [ ] **Step 1: Make a ship.** Build a base pier and deploy this branch, per Global Constraints. Keep a pristine copy of the base at `~/.cache/capture-piers/dist-base` for later tasks. Write the ship's URL and cookie file path in your report.
- [ ] **Step 2: Write `scripts/ui-capture.mjs` section A, failing.** Use `shipEnv`, `launchBrowser`, `openPage`, `makeCheck` from `scripts/lib/harness.mjs` as `scripts/ui-offline.mjs` does, with its request interception for the offline cases. Checks:
  - the tab strip's + shows no dialog, the cursor is in the body, and the kind is markdown even when a spreadsheet was open before;
  - typed text is saved within the autosave delay as `inbox/<today>-NNNN` (match `^inbox/\d{4}-\d{2}-\d{2}-\d{4}$`), and the tab, the address and the tree show that name;
  - a second capture gets a different name;
  - with `Math.random` stubbed to repeat, the second capture still lands under a new name and both pages hold their own text;
  - an empty unnamed page writes nothing (no `page-save` request), and closing its tab leaves no page;
  - text typed then a tab switch at once: the page is captured; the same for + pressed again and for closing the tab;
  - a capture made offline is queued, survives a reload, and lands when the routes answer again;
  - the tree toolbar's New page and a split group's + behave the same;
  - a folder's + still shows the dialog; Enter on the untouched seed captures to the Inbox with the kind chosen in the dialog; a typed name lands in the folder; Escape changes nothing;
  - `Move or rename` on a captured page moves it; on a never-saved page with text it sets the name, and the page is created under that name, not in the Inbox;
  - with `localStorage.latAutosave = '0'` nothing is written until Ctrl+S, which captures to the Inbox;
  - a journal day started from the brief button is saved once it has text;
  - no dialog element was shown at any point of the capture path, and the page threw no error.
- [ ] **Step 3: Run it.** `LATTICE_URL=... LATTICE_COOKIE=... node scripts/ui-capture.mjs`. Expected: the section fails where the dialog appears.
- [ ] **Step 4: Implement.** Draw the name in `save()` where the create protocol already is. Do not copy the create logic anywhere. The status line for a blank page becomes `new page, just write`.
- [ ] **Step 5: Build and run.** `node scripts/build-ui.mjs`, redeploy, run `scripts/ui-capture.mjs` (all ok), then `scripts/ui-shell.mjs`, `scripts/ui-shell-tabs.mjs`, `scripts/ui-tabs.mjs`, `scripts/ui-offline.mjs` and `scripts/ui-offline-invariant.mjs`. Fix what the change broke, and update a check only where it expected the old dialog. `node scripts/app-js-size.mjs` passes.
- [ ] **Step 6: Commit** `feat: a new page saves itself to the inbox, no questions`

### Task 2: Quick open

**Files:**
- Modify: `ui-src/lattice/26-palette.js`, `ui-src/lattice/21-tabs.js` (record a recent where a document comes to the front, and follow a rename), `ui-src/lattice/24-tools.js` (tool frames forward the key), `ui-src/lattice/30-tree.js` (the Open button)
- Modify: `code/nex/lattice/ui-app/app.js` (built), `scripts/ui-capture.mjs`

**Interfaces:**
- Consumes: `createPage(name, kind)` from Task 1.
- Produces:
  - `localStorage.latRecents`: a JSON array of `{ kind: 'page' | 'know', key }`, newest first, 30 at most, no duplicates.
  - `noteRecent(kind, key)`, called from the one place a document tab comes to the front. A rename or move rewrites the entry (hook where `tabsRemap` runs). A delete drops it.
  - `palShow(mode = 'cmd')`, with `mode` `'cmd'` or `'open'`. In `'open'` the box lists pages and memories only, and its placeholder is `open a page`.
  - The action `{ id: 'qopen', name: 'Open a page', home: 'Files', keys: 'Ctrl+O' }`, whose home is a button `#qopen` beside `#newfile` in the tree toolbar, icon and tooltip in the toolbar's existing style.
  - Ctrl/Cmd+O opens it from anywhere, in the capture phase as Ctrl/Cmd+K does, and is forwarded from tool frames beside `k`, `p` and `,`.

Behaviour, with the exact rules:
- No query: the 10 newest recents that still exist, without the document in front.
- A query: pages and memories ranked by `palScore`, 50 at most, as the palette does now.
- A last row `Create <name>` whenever the trimmed query is not empty and no page has exactly that name. Enter on it, or Shift+Enter on any row, calls `createPage` with the typed name.
- Enter opens the highlighted row with `openIn`. Ctrl/Cmd+Enter opens it in a new tab.

- [ ] **Step 1: Write section B of `scripts/ui-capture.mjs`, failing.** Checks:
  - Ctrl+O opens the box in open mode: no action rows, the placeholder says `open a page`;
  - after opening pages a, b, c in that order, the list is b, a (c is in front), and a page deleted since is not listed;
  - a renamed page appears under its new name;
  - typing filters; Enter opens the top row in the front tab; Ctrl+Enter opens it in a new tab;
  - the `Create` row is last when no page has the exact name and absent when one does;
  - Enter with no match, and Shift+Enter with matches, each create the typed page as markdown, at the typed path, not in the Inbox;
  - the names `x/`, three spaces, `notes/a.md` and a name the rules reshape give the same page name and the same message as the new-page dialog gives for them, and none makes a page with an empty name;
  - Ctrl+O works with a tool tab in front, and with vim on while the editor has focus;
  - the Open button opens it, its tooltip equals its accessible name, and the palette lists `Open a page` with its home.
- [ ] **Step 2: Run it.** Expected: section B fails, nothing answers Ctrl+O.
- [ ] **Step 3: Implement.** One box, one matcher. Do not copy `palScore`, `palPaint`'s row building or the key handling: share them.
- [ ] **Step 4: Build and run** `scripts/ui-capture.mjs`, `scripts/ui-shell.mjs` and `scripts/ui-shell-tabs.mjs`. All ok. The size ratchet passes.
- [ ] **Step 5: Commit** `feat: Ctrl+O opens a page, recent ones first`

### Task 3: Palette by recent use

**Files:**
- Modify: `ui-src/lattice/26-palette.js`
- Modify: `code/nex/lattice/ui-app/app.js` (built), `scripts/ui-capture.mjs`

**Interfaces:**
- Produces: `localStorage.latActUse`, a JSON object of action id to the time it last ran (milliseconds). Written when an action runs from the palette or from its home.

Rules:
- No query: usable actions that have a time, newest first, then the rest in registration order. The order is read once when the palette opens.
- A query: `palScore` as today. Between equal scores the more recently run action is first, then registration order.

- [ ] **Step 1: Write section C, failing.** Checks: after running `Move or rename` from the palette, reopening it lists that action first and Enter runs it; running a second action puts it first and the first one second; the order does not change while the box is open even when the storage key is rewritten; a query ranks by match, and a tie goes to the more recent; a never-run action keeps its old relative place; corrupt JSON in the key falls back to registration order with no error.
- [ ] **Step 2: Run it.** Expected: fails on the first check.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Build and run** `scripts/ui-capture.mjs` and `scripts/ui-shell.mjs`. All ok.
- [ ] **Step 5: Commit** `feat: the palette lists the commands last run first`

### Task 4: Ghost links

**Files:**
- Modify: `ui-src/lattice/55-autocomplete.js`, `ui-src/lattice/35-pages.js` (`openPage`), `ui-src/lattice/21-tabs.js` (`showTab`, `tabBlank`, boot's tab for `?name=`), `ui-src/lattice/59-md.js` (the wikilink replace), `ui-src/lattice/60-preview.js` (`localShell`'s styles), `ui-src/lattice/76-outline.js` only if its link reader needs it
- Modify: `code/nex/lattice/ui-app/app.js` (built), `scripts/ui-capture.mjs`

**Interfaces:**
- Consumes: `startNamed(name)` from Task 1, `briefKey` and `hasPage` from `24-tools.js`.
- Produces:
  - In autocomplete, when the query matches `^\d{4}-\d{2}-\d{2}$` and is a real date, the first item is `journal/<query>`, with a muted note `not written yet` when no such page exists. Accepting it inserts the full path.
  - `openPage(name)`: when the ship answers 404 for the page, or the device is offline and a loaded tree does not hold the name, it calls `startNamed(name)` and returns `true`. Every other failure is as today.
  - In `mdToHtml`, a wikilink whose target is a page name absent from a loaded tree gets `class="ghost" title="<name> does not exist yet"` after its `href`. A target that is a memory, a folder, an address with a scheme, or a path starting with `/` is never marked. With no tree loaded nothing is marked.
  - `.ghost` is styled muted in `localShell` only.

- [ ] **Step 1: Write section D, failing.** Checks:
  - `[[2026-12-10` lists `journal/2026-12-10` first with `not written yet`, and Tab inserts `[[journal/2026-12-10]]`; `[[2026-13-45` offers no journal entry; when the day exists it is listed without the note;
  - the preview shows the link as `2026-12-10` with the class `ghost` and the title, and the Outgoing links panel still lists it;
  - a link to an existing page, to a memory, to a folder, to `urb://~zod/x` and to `/apps/lattice/forum` has no `ghost` class;
  - opening the missing page by a click in the preview (a full navigation), by an Outgoing links row and by `?name=journal/2026-12-10` each gives an editable blank markdown page with that name and no write yet;
  - a missing page named `a&b c/é` opens under exactly that name by all three roads;
  - typing saves it under that name, the link loses the `ghost` class on the next paint, and the new page's Backlinks tab lists the linking page;
  - a page the ship refuses with 403 still shows the locked tab, and so does a link whose host is down;
  - a PDF export of the linking page has no `ghost` styling.
- [ ] **Step 2: Run it.** Expected: fails at the first autocomplete check.
- [ ] **Step 3: Implement.** The 404 rule lives in `openPage`, so the tab model and boot need no second copy. Keep `href` the first attribute of the link tag.
- [ ] **Step 4: Build and run** `scripts/ui-capture.mjs`, `scripts/ui-shell.mjs`, `scripts/ui-tabs.mjs`, `scripts/ui-tabsafe.mjs`. All ok. The size ratchet passes.
- [ ] **Step 5: Commit** `feat: a link to a page not yet written starts that page`

### Task 5: Docs and hand back

**Files:**
- Modify: `docs/pages.md` (or the doc that describes the editor's keys and new pages: grep `docs/` for `Ctrl+K`)

- [ ] **Step 1: Document** the Inbox, Ctrl/Cmd+O, the palette's order and ghost links, in the existing doc's style. Short sentences.
- [ ] **Step 2: Run everything once:** every suite in `scripts/ui-capture.mjs`, the other browser suites the earlier tasks ran, `node scripts/app-js-size.mjs`, `node --check` on the bundle, and `git diff --exit-code` after `node scripts/build-ui.mjs` (the committed bundle is current).
- [ ] **Step 3: Commit** `docs: the inbox, quick open and ghost links`
- [ ] **Step 4: Push** `feat-quick-capture` and open a draft PR against `main` as nisfeb, titled `feat: inbox capture, quick open, recent commands, ghost links`. The body lists what was run with counts and what was not verified. Watch CI to green. Do not merge.
