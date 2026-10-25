# Send to orrery

Orrery is the assistant nexus on the same ship (`/apps/orrery`). "Send to
orrery" hands it a page as a situation to look after. Orrery reads the page,
works out what it is about, proposes tasks and events, and follows the page on
every edit until the situation is resolved. The page stays the source of truth.

Lattice's side is small: a button, one POST, and a status badge
(`ui-app/orrery.js`). Lattice keeps no follow state and pushes no edits.
Orrery reads the page's edits itself, with a grubbery keep on the page's grub.
**Orrery depends on the page layout below. Changing it breaks orrery's
follows, so change this file and tell orrery in the same change.**

## The button

- In the editor's controls pane (an "orrery" section) and in the reader's
  address bar, on the owner's own pages only: never a peer's (`urb://` of
  another ship), never a folder or an unsaved page.
- Hidden unless `GET /apps/orrery/api/version` answers 200. Lattice asks that
  once per browser session.
- `POST /apps/orrery/api/follow` with `{path, title, text, links}`. `path` is
  the page's lattice name without a leading slash (`notes/brave/catch-all`).
  `text` is the page as written. `links` are the page's lattice-internal
  links as page paths, in order, once each: `[[name]]`, `[[name|label]]`,
  `/apps/lattice/app?name=`, and uploads at `/apps/lattice/f/<path>`.
- The badge, from `GET /apps/orrery/api/follow?path=`:

  | status | shows |
  |---|---|
  | none | the button "Send to orrery" |
  | queued | "orrery is reading…" (asked again every 3 s for a minute, then every 30 s, for half an hour at most: orrery retries a down model every five minutes) |
  | following | "followed by orrery · \<title\> · \<open\> open", linking to `/apps/orrery/#body/<situation>`, and "send again" |
  | resolved | "resolved by orrery: \<outcome\>", and "send again" |
  | failed | orrery's note, and "send again" |

- Lattice's perf rule is that re-opening a page costs no request. So a
  page's status is asked on its first open in a browser session and
  cached. It is asked again after a send, and while queued.

## What orrery reads

R is the lattice instance in the ball. On a desk install that is
`/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app`, and the
instance also claims the alias name `lattice`. For a page P:

| grub | mark | noun |
|---|---|---|
| `R/page/<P>/show` | `[/lattice %eval-data]` | `?(%text %html %gmi %md %js %css %noun)` |
| `R/page/<P>/data` | `[/lattice %eval-data]` | the page's output. A `@t` whenever `show` is not `%noun`: for a content page (md, gmi, html, text, js, css, tex) the text exactly as written |
| `R/page/<P>/code` | `[/lattice %page]` | `@t`, the source. A content page's text sits in a Hoon envelope here, so read `data` |
| `R/pub/vault/<P>/gmi` | `[/lattice %page]` | `@t`, the body of a page that only exists published |

Rule, with no call to lattice: peek `R/page/<P>/data`, and if it is absent,
`R/pub/vault/<P>/gmi`.

- **Edits:** every save rewrites `code`, and the page's evaluator rewrites
  `data` and gains a revision. A keep on `R/page/<P>/data` fires on each
  edit that changes the text.
- **Moves:** the path is the page's identity, and pages have no id. A move
  copies each page to its new path and deletes the old directory, so the keep
  sees the old `data` culled. Every move also writes `R/moves.json`
  (`[/ %json]`, kept across reloads): `{"moves": [{"from": "a/b", "to": "c/b",
  "at_ms": n}, ...]}`, newest first, the last 100. A page at `from` is now at
  `to`, and a page under `from/` is now under `to/` (a folder move is one
  row). When a followed page's `data` vanishes, a row for it means the same
  follow at the new path; no row means a delete.
- **Weir:** orrery asks peek (with keep) on `R/page/`, `R/pub/vault/` and
  `R/moves.json`.

# What lattice reads from orrery (release 67)

The reverse direction, the mirror of "Send to orrery" above: lattice reads
orrery's own data over a same-ship peek road. Orrery is unchanged by this.
Lattice declares the road in its own `weir-json`, and on the same ship the
owner's grant is automatic. It is all read-only. Lattice never writes into
orrery.

Lattice resolves orrery's instance the way orrery resolves lattice's: the
first `%|` lane in `/sys/link/orrery/dest.lanes` is orrery's instance base,
R_orr (`+orrery-base`, a mirror of orrery's `+find-base`). Every read fails
soft, so no orrery, a missing grub, or a stale one all degrade to nothing.

What it reads (orrery version 117), all `[/ %json]`:

| grub | used for |
|---|---|
| `R_orr/world.json` | the world digest: `{at, day, time, zone, away, today[], late[], situations[], proposed, text}` |
| `R_orr/briefs/<day>` | a day's brief: `{day, at, sent, tags, text, today[], said, map, notes}` |
| `R_orr/reviews/<day>` | a Sunday review: `{day, at, sent, text, line, notes}` |

Three features use them:

- **World at session start.** `+index-text` leads the session index with a `## World, from orrery` block carrying `world.json`'s `text`, when the digest is fresh (its `at` within a day). The owner session always gets it. An agent key gets it only when the key is cleared for sensitive content and asks with `world=1` (the `memory_index` tool's `world` option), and getting it taints the key for 12 hours like any sensitive read, because the digest carries the owner's private day (calendar, open situations). The session hooks do not ask, so an agent's session starts without it. An `at` older than a day, no digest, or no orrery all yield no block.
- **Journal pages.** A pass on the mirror-loop (every wake, and on boot)
  mirrors each `briefs/<day>` into a private page `journal/<day>` and each
  `reviews/<day>` into `journal/week-<day>`, body `# Brief, <day>` or
  `# Review, <day>` then the record's `text`. Each page is marked sensitive
  (a `%page-sensitive` poke before the `%make`), so an uncleared key cannot
  read it. A day is written again only when that record's `at` moves, so a
  hand edit survives. `[situation/x]` in the text becomes `[[situation/x]]`.
  The last-synced `at` per page lives in `journal-synced.json`, reviews keyed
  `week-<day>` so a shared Sunday never collides with its brief.
- **Body facts.** On a reader page whose path is a two-segment orrery body id
  (`person/sarah`), `ui-app/orrery.js` fetches
  `GET /apps/orrery/api/body/<kind>/<slug>` and shows a compact block (name, a
  few attrs, open actions). A non-body path (`journal/2026.10.19`) gets a 404
  and shows nothing.

Weir: lattice asks peek on `/apps/shell.shell/desks/orrery.desk/`.
