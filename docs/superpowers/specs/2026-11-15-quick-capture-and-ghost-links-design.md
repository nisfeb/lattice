# Quick capture, quick open, and ghost links

Design, 2026-11-15. Status: draft for sneagan's review.

## Intent

A lattice user asked for four things that come from one habit. They want to get an idea out of their head as fast as possible, and anything that asks a question first (where should this go, what should it be called) is a distraction. In their words: "Default location of Inbox plus ability to quickly move it whenever I want is a good antidote."

The four requests:

1. A new page should not ask for a name or a place. It lands in an Inbox.
2. Cmd+O opens a file picker that starts with the most recently opened files. Type a name, hit Enter, it opens.
3. The command palette should put the commands they use most, such as Move, within one keystroke.
4. Ghost notes: link to a page that does not exist yet, most often a future day's journal, and when that page is made the link is already there as a backlink.

## What sneagan decided

- Build order: Inbox capture, Cmd+O, the palette, then ghost links.
- A captured page is named the date plus a short random number.
- Anything saved without a user-defined name goes to the Inbox. A page started inside a folder lands in that folder only when the user types a name.
- In the Cmd+O picker, Enter on a name that matches nothing creates a page with that name.
- The palette orders itself by recent use. No pins for now: "start with recent use and see how that lands".
- A link's underlying target stays the page's full path. Short names are for autocomplete and for what is shown.

## Calls made in the design (each one mine, shown in chat and accepted as a set)

- The captured name is `inbox/YYYY-MM-DD-NNNN`: the local date, a dash, four random digits. It stays until the user moves or renames the page. If that name is taken, another four digits are drawn.
- The folder is `inbox`, made the first time it is needed. It is not a setting.
- An unnamed page is saved automatically as soon as it has text. An unnamed page with no text is never saved.
- A name typed by the user always wins, including a name typed into the Cmd+O picker: that page goes where the name says, not to the Inbox.
- The picker lists the last 10 documents opened on this device, most recent first, without the one in front. It shows pages and memories, no commands. Recents are per device and are not synced.
- Ctrl+O on Linux and Windows, Cmd+O on a Mac.
- The palette, opened with nothing typed, lists the commands run most recently first, then the rest in today's order. Use is remembered per device.
- When the text typed after `[[` is a date (`YYYY-MM-DD`), autocomplete offers that day's journal page even if it does not exist, and inserts `[[journal/YYYY-MM-DD]]`.
- Clicking a link to a page that does not exist starts that page, already named, ready to type in.
- A link to a page that does not exist is shown dimmed in the preview.

Added after a reviewer read this against the code on 2026-11-15, also mine and not yet seen by sneagan:

- A captured page is markdown, whatever kind was open before. So is a page made from the picker's Create row and a page started from a ghost link. A typed extension in the picker still wins.
- There is no new keyboard chord for a new page. Browsers keep Ctrl/Cmd+N for themselves. The keyboard road is Cmd+P, then New page, which recent-use ordering puts at or near the top. The Linux desktop's Ctrl+N stays as it is.
- The picker gets one small visible button, Open, beside New page in the tree toolbar. Every palette action must have a home on screen, and the picker had none.
- No new "New page with a name or kind" action. The dialog stays reachable from the + on a tree folder and from the tree menu's New page here, which are its homes already.
- In that dialog, Enter on an empty name or on the untouched folder seed captures to the Inbox with the chosen kind. Only text typed after the folder lands in the folder. Escape and Cancel still cancel.
- In the picker the Create row is shown last whenever no page has exactly the typed name, not only when nothing matches at all, because the matching is loose and a short name nearly always matches something. Shift+Enter creates the typed name straight away.
- "Does not exist" means the ship answered 404 for the page, or the device is offline and the name is absent from a loaded tree. Any other failure (no access, a host that is down) keeps today's locked tab.
- With autosave turned off in Settings, a capture is not saved by itself. The first Ctrl+S captures it to the Inbox, and leaving the page asks the question it asks today. The setting is honoured.

## Goals

1. From the keyboard or one click, a user is typing in a new page with no dialog and no decision. The page is kept.
2. Cmd+O then a few letters then Enter opens any page or memory, and with nothing typed the last documents are one arrow key away.
3. Cmd+P then Enter runs the command the user ran last.
4. A link to a future journal day can be written quickly, looks like a ghost until the day exists, opens the right page when clicked, and shows in that day's Backlinks once it exists.

## Non-goals

- Pinned commands, or user-set shortcuts for commands.
- Resolving a short link target (`[[meeting]]`) to a page of that name in some folder. Links stay full paths.
- A setting for the Inbox folder's name, or more than one Inbox.
- Renaming a captured page from its first line.
- Syncing recents or command use between devices.
- Any change to how backlinks are computed on the ship.

## Anti-goals

- A captured page must never be lost. If the save fails or the device is offline, the page is queued like any other new page.
- No new dialog, prompt or question anywhere in the capture path.
- The palette's order must not change while it is open, and typing a query must rank by match as today, not by use.
- Nothing here may slow the editor's start or add a request to it. Recents and command use live in the browser.

## What exists today (main at version 134)

- **New page.** Everything routes through `newFile(into, focusName)` in `ui-src/lattice/35-pages.js`. With `focusName` true it opens one dialog for the page's name and kind (`askNameKind`; an empty field is a cancel today, and the field is seeded with the folder, or with the open page's path). `blankPage(into)` is the plain reset the dialog-free callers use (boot, the tab model). The status line says `new page — name it, write, save`.
- **An unnamed page is never saved today.** `autosave()` returns at once when `current` is null, `save()` on an empty name stops with `name required`, and `saveParked` needs a tab key, so an unnamed tab in the background is not written either. The whole create protocol (`new=1`, the 409, the offline `enqueueSave(..., creating)`, the tree row, `tabFollow`, the address) lives in `save()`. `flushNoAsk`, `guardDirty` and `parkDoc` already call `save()`. A page that has a name but was never saved, such as a journal day started by `openBrief`, is not autosaved today for the same reason.
- **Callers of the new-page path.** The tab strip's + and each split group's own + (`tabNew`, a new tab). The tree toolbar's New page, the phone bar and the Linux desktop's Ctrl+N (they replace the document in the front tab, after `guardDirty`). The + on each tree folder and the tree menu's New page here (`newFile(path)`). Also `dupPage`, the close path in `65-ctl.js`, and boot's `?into=`.
- **Desktop.** There is no File menu any more: `96-deskmenu.js`'s branch for it is dead. The desktop reaches a new page through the visible `#newfile` button, and on Linux through Ctrl+N (`desktop/src/keys.rs` clicks that button). The macOS menu has no new-page item.
- **Kinds.** The dialog is the only place a page's kind is chosen. `blankPage` does not reset the kind picker, and `save()` uses `curKind || pkind.value`, so a blank page takes the kind of whatever was open before.
- **Move or rename on an unsaved page does nothing today.** Its handler (`77-history.js`) says `open something first` when `current` is null, and the phone name sheet (`23-tabhead.js`) leaves Rename out.
- **Keys.** Ctrl/Cmd+O is bound nowhere, in the client or the desktop, and a page may take it from the browser. Vim hands back every chord but Ctrl-r and Ctrl-[. Tool frames forward only k, p and `,` up to the shell (`24-tools.js`).
- **Palette.** `ui-src/lattice/26-palette.js`, opened by Ctrl/Cmd+K and Ctrl/Cmd+P. Actions register through `action()` and `clickAction()` in `13-frame.js`, each with a home element carrying `data-action`. With no query it lists every usable action in registration order. With a query it ranks actions, then up to 50 pages and memories, by `palScore`. `Move or rename` is the action `tpath`.
- **Opening.** `openIn(kind, key, {ev, newTab})` in `21-tabs.js` opens a page or memory in the front tab or a new one.
- **Wikilinks.** Targets are full page paths. Autocomplete (`55-autocomplete.js`) opens on `[[`, ranks existing pages with the last path segment first, and inserts the full path. The renderer (`59-md.js`) shows a bare `[[a/b/c]]` as `c`. The Outgoing links panel (`76-outline.js`) already marks a missing target muted with the title `<name> does not exist yet`.
- **Journal.** Days live at `journal/YYYY-MM-DD` (`briefKey` and `briefForms` in `24-tools.js`; two older dotted spellings are still looked for). `openBrief` shows how a missing day is started: a blank page with the name already shown.
- **Backlinks.** The ship scans page bodies for `[[name]]` and `[[name|` when the Backlinks tab is opened (`+backlink-hit` in `code/lib/lattice-md.hoon`). A link written before its page existed is therefore found once the page exists, as long as it uses the full path.
- **Preferences.** Client preferences are `localStorage` keys, read with a try and a fallback (`05-prefs.js`).
- **Preview.** The preview is a sandboxed frame with `<base target="_top">`. A click on a wikilink in it is a full top-level navigation to `/apps/lattice/app?name=<path>`: the app reloads and boot handles the name. It is not an intercepted click.
- **Opening a missing page today**, on every road (a preview link, an outgoing-links row through `tabLink` and `openIn`, the address bar, boot with `?name=`): `openPage` fails with `open failed`, and `showTab` calls `tabBlank`, an empty locked tab.
- **The renderer.** `mdToHtml` in `59-md.js` shares the editor's closure, so the page tree (`nodes`) is in scope. Its output also feeds the outline, the PDF export (`78-pdf.js`), the Skills pane and a parked split's Read. The preview's own styles are in `localShell`. `outLinks` in `76-outline.js` reads links with a pattern that expects `href` to be the first attribute of the tag. Published and clearweb pages are rendered on the ship and do not use this renderer.
- **A queued create that clashes.** An offline create the ship answers 409 on replay is kept under `conflicts/` (`08-offline.js`). It is not lost.

## How it is built (decided)

### 1. Inbox capture

- The tab strip's +, each split group's +, the tree toolbar's New page, the phone bar's new page and the Linux desktop's Ctrl+N start a blank markdown page with no dialog, cursor in the body. Each keeps what it does today about tabs: the + buttons open a new tab, the others replace the front document.
- The + on a tree folder and the tree menu's New page here keep the dialog, since choosing a folder is already a decision, and the dialog stays the way to pick a kind. In the dialog the name is optional: Enter on an empty name, or on the untouched folder seed, captures the page to the Inbox with the chosen kind. Escape and Cancel cancel.
- An unnamed page gets its name at its first save: `inbox/` plus the local date plus `-` plus four random digits. This is drawn in `save()`, where the create protocol already is, when the name is empty. The save is a create. On a 409 another number is drawn, up to a small number of tries, then the save fails as any save fails. A capture made offline that clashes on replay goes to `conflicts/` like any queued create.
- Autosave is taught to hand a page that has text and has never been saved to `save()`. That covers an unnamed page, and a named one that was never saved (a journal day, a page started from a ghost link). A parked unnamed tab with text is saved the same way. Nothing is saved for an empty page, and closing an empty unnamed tab leaves nothing behind.
- With autosave off in Settings, the page is captured by the first Ctrl+S.
- After the first save the tab, the address and the tree show the new name, as they do today after a named create.
- The status line for a blank page drops "name it": the page needs nothing from the user.
- `Move or rename` works on a captured page exactly as on any saved page. On a page that has not been saved yet, where it does nothing today, it sets the name the first save will use, which then counts as user-defined. The phone's name sheet offers Rename there too.

### 2. Quick open

- A second mode of the palette's own box: same element, same matching, same keys. It lists pages and memories only.
- Opened with Ctrl/Cmd+O from anywhere, as Ctrl/Cmd+K is. Vim does not bind it. Tool frames forward the key up to the shell beside k, p and `,`.
- Its home is a small Open button beside New page in the tree toolbar.
- With nothing typed: the last 10 documents opened on this device, most recent first, leaving out the document in front and any that no longer exist.
- With a query: pages and memories ranked as the palette ranks them today.
- Enter opens the highlighted row with `openIn`. Ctrl/Cmd+Enter opens it in a new tab, as the palette does.
- A Create row, "Create <name>", is listed last whenever no page has exactly the typed name. When nothing else matches it is the only row, so Enter creates. Shift+Enter creates the typed name whatever is highlighted. The new page is markdown unless the name carries an extension, and goes through the same path a named create takes, so the usual name rules and messages apply.
- Recents are recorded where a document comes to the front, in one place, and kept under one `localStorage` key.
- The picker registers as an action with a home in the DOM, as every palette action must, so it is also findable from the palette.

### 3. Palette by recent use

- Each run of an action records its id and the time under one `localStorage` key.
- With no query, usable actions are listed most recently run first, then the never-run ones in registration order. The order is computed when the palette opens and does not move while it is open.
- With a query, ranking is by match as today. Recent use breaks ties only.

### 4. Ghost links

- **Autocomplete.** When the query after `[[` is a full date, `YYYY-MM-DD`, the list's first entry is that day's journal page, `journal/YYYY-MM-DD`, whether or not it exists, marked as not existing yet when it does not. Accepting it inserts the full path. Existing pages that match are listed after it as today.
- **Opening a missing page.** Handled where a page is opened (`openPage` and `showTab`) and at boot, not in a click handler, so every road is covered: a preview link, an outgoing-links row, the address bar, `?name=`. When the ship answers 404 for the name, or the device is offline and the name is absent from a loaded tree, the tab becomes a blank markdown editor with the name already set, the way `openBrief` starts a missing journal day. The first save creates it under that name, which is user-defined. Any other failure keeps today's locked tab. A restored tab for a page deleted on another device is startable under this rule too: nothing is written unless the user types.
- **Dimmed in the preview.** The client renderer marks a wikilink whose target is not in the tree with a class and a title saying it does not exist yet, placed after `href` so the outgoing-links reader still works. The muted style lives in the preview's own shell, so the preview and a parked split's Read dim, and the PDF export and the Skills pane are unchanged. When the tree has not loaded, nothing is dimmed.
- **Backlinks.** No change. The check is that a link written to a missing page shows in that page's Backlinks tab after the page is created.
- **Published and server-rendered pages** are out of scope: the dimming is the editor preview's only.

## Left to the builder

- The exact number of 409 retries, and the wording of status lines and the "Create" row.
- The `localStorage` key names and their size caps.
- Whether quick open is a flag on the palette or a small second function over shared parts, as long as the matching code is not copied.
- The muted style, from the theme variables the editor already uses.
- How the phone bar reaches the dialog-free path, and whether the dead desktop File menu branch in `96-deskmenu.js` is removed while there.

## Tests

- Browser suites beside the existing ones (`scripts/ui-shell.mjs`, `scripts/ui-shell-tabs.mjs`, `scripts/ui-tabs.mjs`, `scripts/ui-offline.mjs`, `scripts/ui-links.mjs`):
  - + then typing saves a page under `inbox/<today>-NNNN` with no dialog shown at any point; a second capture the same day gets a different name; a forced name clash draws a new number.
  - An empty unnamed page is never saved.
  - A capture made offline is queued and lands when the ship is back.
  - A folder's + still shows the dialog; Enter on the untouched seed captures to the Inbox with the chosen kind; a typed name lands in the folder; Escape cancels.
  - A capture started while a spreadsheet or a hoon page was open is markdown.
  - `Move or rename` on a captured page moves it, and on a page not yet saved sets its name.
  - With autosave off, nothing is written until Ctrl+S, which captures to the Inbox.
  - A journal day started from the brief button is autosaved once it has text.
  - Ctrl+O lists recents in order without the front document; typing filters; Enter opens; the Create row is last when no page has that exact name and absent when one does; Enter on no match and Shift+Enter create the named page; a deleted page is not offered; the key works with a tool tab in front.
  - The palette with no query lists the last-run action first; the order holds while open; a query ranks by match.
  - Every palette action still has a home (the existing suite check).
  - `[[2026-12-10` offers `journal/2026-12-10` when it does not exist and inserts the full path; a link to a missing page is muted in the preview and stops being muted once the page exists; opening it by a preview click, an outgoing-links row and `?name=` each starts the named page; a page the viewer may not read still shows the locked tab; the Outgoing links panel still lists a dimmed link; after saving, the page's Backlinks tab lists the linking page.
- The existing suites pass unchanged where behaviour did not change, and are updated where the new-page dialog was expected.
- `scripts/app-js-size.mjs` still passes its ratchet.

## Success

A user clicks +, or presses Cmd+P and Enter, and types a thought. It is saved in the Inbox without a single question. Later they press Cmd+O, see it at the top, open it, press Cmd+P and Enter, and move it. In another note they type `[[2026-12-10`, accept the suggestion, and weeks later that day's journal shows the note in its Backlinks.

## As built (2026-11-15)

Where the build differs from the text above. Everything else stands as written, including no new keyboard chord for a new page and the other calls added in review.

- A link to a missing page starts that page only when the ship answers 404, so only online. Offline it is not started and fails to open as it did before. The design's "or the device is offline and the name is absent from a loaded tree" was dropped. A page created offline can overwrite a page of the same name made elsewhere once the ship is back, because the ship does not check an edit against a page's first revision and does not report who wrote a page. That hole is on main and needs a ship change. Starting ghost pages offline would have made it easy to hit.
- A link whose target is a memory may show dimmed until the memory list has loaded. It is never started as a page.
- The ghost marking is applied to the ship's rendered document as well as to the editor's own render, so a page with a ghost link keeps footnotes, reference links and setext headings.
