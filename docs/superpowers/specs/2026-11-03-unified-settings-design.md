# Unified settings

2026-11-03. The owner: "the connections and fuse setting ui doesn't follow the
theme of the rest of lattice. we should merge it with the other settings pane
and get all settings into one place."

## What there was

- **Settings**, the ship-served page (`+settings-html` in app.hoon), opened as a
  tab of the editor. One long page: search index, agent keys, commons mirror,
  backup, theme, typography, editor, publishing, clipping bookmarklets, legacy
  import, advanced, and on the desktop two buttons out to the manager.
- **The manager**, the desktop's own page (`desktop/ui/manager.html`), at the
  app's local origin: connect a node, use anonymously, ship software, local
  piers, lattice-fs mounts, scheduled backups. Its own green palette and
  lowercase headings, no theme, no light/dark beyond the system's.

## Decisions

**One surface, two documents, one look.** Both pages render the same layout: a
tab list on the left in two groups, and one panel at a time.

| Group | Tab | Holds | Lives on |
|---|---|---|---|
| Lattice | Appearance | Theme, Typography | ship page |
| | Editor | vim, wrap, autosave; Publishing | ship page |
| | Agent keys | keys | ship page |
| | Data and backup | export/restore, search index, commons mirror, legacy import | ship page |
| | Clipping | the two bookmarklets | ship page |
| | Advanced | Explorer | ship page |
| This computer (desktop only) | Connection | node status, connect form, use anonymously, ship software | manager |
| | Files | local piers over lick, mounts | manager |
| | Scheduled backups | the schedules | manager |

**The manager's commands stay on the manager.** The security audit kept
`connect`, `add_mount`, the schedule commands and the rest off the ship page
(`capabilities/workspace-remote.json`): anything the ship serves runs there.
So the two groups cross over by navigation, not by granting commands. On the
ship page a "This computer" tab calls `open_manager(section)` (now
`connection`, `files` or `backups`). On the manager a "Lattice" tab calls
`go_home({settings: tab})`, which opens the editor at
`/apps/lattice/app?settings=<tab>` and 99-boot opens that tab of Settings.
Both lists are closed sets checked in Rust, and the bridge's bootstrap
accepts that one query and no other. No new command.

**The manager works with no node.** It loads nothing from a ship. The "Lattice"
group shows only once a ship is configured. With no node it is the three
desktop tabs, Connection first, exactly the first-run page it was.

**One stylesheet.** `code/nex/lattice/ui-app/settings.js` holds the CSS (as a
style it injects) and the tab model. The ship page loads it from the ship; the
manager loads a byte-identical copy at `desktop/ui/settings.js`, written by
`scripts/build-ui.mjs` and diffed in CI, and cross-checked by
`desktop-commands.mjs` with the tab names on both sides. Every colour is a
theme variable with lattice's default as its fallback, so both pages follow
light and dark and the user's theme, accent and Talon font.

**The manager wears the user's theme.** It is another origin, so it cannot read
the ship page's localStorage. `theme.js` now sends its resolved variables with
the `set_theme` call it already makes; the shell keeps only theme.js's own
variable names with well-formed values in config.json, and `status` returns
them. The manager paints them from its own cached copy at first paint.

**Old anchors keep working.** `latOpenSettings('backup' | 'legacy' | ...)`
scrolls an element into view; settings.js shows the panel holding any element
scrolled into view, so every existing caller lands on the right tab. Hashes
(`#keys`) pick a tab on load too.

## Budget

The Settings page is its own document, so its tabs never touch app.js. app.js
grows 546 bytes, for the `?settings=` hand-off and a fallback in
`latOpenManager` for a shell older than the new section names. The Writer
guard in ui-writer.mjs (release 107 + 8 KB) is replaced by a general ratchet,
`scripts/app-js-size.mjs` with `scripts/app-js-size.json`: app.js may grow 4 KB
past the agreed size, and beyond that the change must raise the size and
state why.

## Migration

Nothing stored moves. Every preference keeps its key (localStorage on the
ship origin, %settings on the ship, config.json on the desktop). The one new
stored thing is `theme` in config.json, filled by the next ship-page load.
