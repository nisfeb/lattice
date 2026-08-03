# Programmable pages: the manual

The lattice platform (see [platform.md](platform.md)) turns your ship into a
tree of programmable pages. Each page is a small Hoon program whose output is
its own web page, editable and drivable from any browser. This is the manual
for writing them. Worked, verified examples live in
[page-examples/](page-examples/).

## A page is a directory

Every page lives at `/page/<name>/` under the lattice nexus and is a directory
of grubs (files):

| grub | what | written by |
|---|---|---|
| `code` | your Hoon gate (source) | you (page-save) |
| `data` | the gate's current output (any noun) | the evaluator |
| `cmd` | the command inbox `[seq=@ud txt=@t]` | page-cmd |
| `deps` | declared dependencies `(list path)` | you (via the gate) |
| `err` | last compile/run failure text (`''` = healthy) | the evaluator |
| `seen` | last processed command seq (internal) | the evaluator |
| `share` | sharing preset (internal) | page-share |

You write `code`. Everything else the platform maintains. Browse any of them
in the tree explorer at
`/apps/lattice/x/~<you>/apps/lattice.lattice_app/page/<name>/`. The `?raw`
link on a page view shows the grubs.

## The gate: the whole API

Your `code` is one gate. Its sample is fixed, and its product is a `+result`
from the page stdlib (`pg`, which is your compile subject):

```hoon
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
```

**Inputs (the sample):**

- `cmd`: the command that triggered this run, or `~` for a *dependency tick*
  ("something you depend on changed, so update if you need to").
- `dat`: your page's current data (`~` if never produced). Read it to make an
  update relative to the last value (a counter, an accumulator).
- `now`: the time of this run.
- `deps`: each declared dependency as `[path value]`, pre-resolved. A missing
  dependency's value is `~`.

**Output (`+result`):** build it with the `pg` constructors. You name the
render mode and pass the value:

| builder | data becomes | rendered as |
|---|---|---|
| `(text v)` | `v` | escaped text |
| `(html v)` | `v` | **raw HTML**, your own page's markup |
| `(md v)` | `v` | markdown → HTML (escaped, safe for notes/docs) |
| `(gmi v)` | `v` | gemtext → HTML |
| `(raw v)` | `v` | opaque noun, shown escaped |
| `same` | *unchanged* | (no write) |

Then chain modifiers. `(needs r deps)` sets dependencies, `(every r dur)`
sets a timer, and `(sends r pokes)` pokes other pages. `esc` HTML-escapes a
cord. Use it on any dynamic value you weld into `html`.

The subject beneath `pg` is the Hoon standard library. A page is a pure
function from `(command, state, dependencies, time)` to a `result`.

## Rendering: data as its own UI

A page's render mode (`text` / `html` / `gmi` / `raw`) decides how its data
shows in the web view and on the clearweb surface. **`html` inlines your
markup raw.** A page's data can *be* a styled interface with forms and
layout, not just a value. This is your own code producing your own HTML, so
escape any untrusted or dynamic value with `esc` first. A *peer's* page data
is always escaped when you browse it remotely. A foreign ship can never
inject markup into your browser.

## Writing and driving a page

**In the browser:** the landing page (`/apps/lattice`) has a **New page**
card, and every page links to its editor (`/apps/lattice/app?name=<name>`).
The code pane has syntax highlighting, Tab indents, and Ctrl/Cmd-S saves. The
live preview sits beside it, with compile errors inline. New-page mode is
create-only. A taken name is refused rather than overwritten.

**Over HTTP** (the editor uses these same owner-only routes under
`/apps/lattice`):

```
POST /page-save?name=<name>     body = the hoon source    create/replace code
POST /page-cmd?name=<name>      cmd=<text> (query or form) send a command
POST /page-del?name=<name>                                delete the page
POST /page-share?name=<name>&mode=private|shared|clearweb  set sharing
```

`page-cmd` reads `cmd` from the query string for programmatic callers, or
from a form-urlencoded POST body for browser forms. Each command bumps `cmd`'s
seq, so an identical command still runs.

Navigate the explorer to a page dir and you get the **live view**: the
rendered data, any error, a command form, and the sharing controls. It
reloads itself (keep-SSE) whenever the page changes, so a command from one
tab updates every open tab.

## Commands

A command is text. Your gate decides what it means. Common shapes:

- a verb: `inc`, `reset` (see counter)
- a payload: the whole command is the value (see note)
- ignored: a page that only reacts to dependencies ignores `cmd`

A command sent to a page whose code doesn't compile is **not lost**. Once you
fix the code, the pending command runs against the fixed version,
exactly-once, tracked in `seen`.

## Dependencies: the spreadsheet

Return a `dep` list of grub paths and the platform keeps a subscription on
each. When any of them changes, your gate re-runs with `cmd=~` and the fresh
values in `deps`. This is push-based, with no polling, and it is how one page
reacts to another. The tree behaves like a spreadsheet. See doubler.

Dependencies are **explicit**. You declare them, and the platform does not
trace your reads. A page that forgets to declare a dep simply goes stale
until poked. That failure is visible and debuggable, since the `deps` grub is
right there in the tree.

Paths are absolute grub paths, e.g.
`/apps/lattice.lattice_app/page/counter/data`. `data-of` builds one from a
page name: `(data-of %counter)`.

The address bar accepts short `urb://` names for all of this.
`urb://~ship/p/counter` is a page, `urb://~ship/p/counter/data` a grub, and
`urb://~ship/t/<abs>` any tree node. Every view shows its canonical `urb://`
to copy. See [urls.md](urls.md).

## Composition: a page inside a page

A dependency on another page's **`/view`** gives you its *rendered HTML*
instead of its raw data, so a page can lay out the rendered views of other
pages. Name it with `view-of` and pull the fragment out of `deps` with
`shown`:

```hoon
%+  needs
  (html (crip :(weld "<section>" (trip (shown deps %clock)) "</section>")))
~[(view-of %clock)]
```

A view-dep re-renders your page whenever the embedded page's data *or*
render mode changes. It is the same reactive machinery as a data dep, so a
dashboard stays live. See dashboard. Composition is **own-pages only**.
`view-of` only resolves pages in your own tree, so a peer's markup is never
rendered into your page. A foreign `/view` path silently yields nothing.
Nesting works through stored data. If A embeds B and B embeds C, A shows
B-including-C, with no runtime recursion.

Embedding an *always-changing* page (a clock, a timer page) makes the
container re-render at that cadence. That churn is bounded, but it is live.
Compose pages that settle, or accept the refresh rate of the busiest thing
you embed.

## Sharing

Each page has a one-click preset, shown in its live view:

- **private** (default): only you, over authenticated HTTP.
- **shared**: the `data` grub is published to the Urbit namespace and any
  ship can read it over ames, the same federation the published pages use.
  It is live, so a subscribing ship sees updates.
- **clearweb**: shared, and the data is *also* served over unauthenticated
  HTTP at `/apps/lattice/c/<name>`. This is the only public surface. It
  serves that one page's rendered data and nothing else: no tree, no code,
  no other pages.

Sharing is a permission on the page, not a different kind of page. A private
note and a clearweb dashboard are the same machinery with a different grant.

## Safety

- Both **compile and run are fenced** (`mule`). A page that fails to compile
  or crashes at runtime writes `err` and keeps its last good `data`. A
  broken page never takes down the ship or other pages.
- Page code runs in the ship's single event loop, so **the fence catches
  crashes, not non-termination**. Don't write an infinite loop or an
  unbounded recursion in a page. There is no timeout yet, so keep pages to
  bounded, total computation. Heavy or long work is a future platform
  feature (threads), not a page.
- A divergent dependency cycle (A depends on B depends on A, each changing
  the other) will spin. A *converging* one settles, because identical output
  suppresses the next write. Prefer converging derivations.

## Worked examples

All verified on the harness. Full sources in
[page-examples/](page-examples/).

### counter: commands and state
```hoon
=/  n=@ud  ?~(dat 0 (fall (rush ;;(@t u.dat) dim:ag) 0))
=/  m=@ud  ?:(&(?=(^ cmd) =(u.cmd 'inc')) +(n) n)
(text (crip (a-co:co m)))
```
`page-cmd?name=counter&cmd=inc` → `0`, `1`, `2`, …

### card: data as HTML (`html` + `esc`)
```hoon
=/  msg=@t  ?~(cmd 'send a command to set my text' u.cmd)
%-  html  %-  crip
;:  weld
  "<div style=\"padding:1rem;border:2px solid #1a6ed8;border-radius:8px\">"
  "<h2>Card</h2><p>"  (trip (esc msg))  "</p></div>"
==
```
This renders a real styled box. The command value is `esc`-escaped, and the
box markup is raw.

### greeter: a command as input
```hoon
=/  who=@t  ?~(cmd 'world' u.cmd)
(text (cat 3 'hello, ' who))
```

### note: the command is the value
```hoon
?~(cmd same (text u.cmd))
```

### clock: using `now`
```hoon
(text (scot %da now))
```

### doubler: a derived page (dependencies)
```hoon
=/  tgt=path  /apps/lattice.lattice_app/page/counter/data
?~  deps  (needs same ~[tgt])
=/  v=@ud  (fall (rush ;;(@t +.i.deps) dim:ag) 0)
(needs (text (crip (a-co:co (mul 2 v)))) ~[tgt])
```
The first run declares the dep. Thereafter, incrementing `counter` re-runs
doubler automatically, with no command needed.

### dashboard: composition (embedding rendered views)
```hoon
%+  needs
  %-  html  %-  crip
  ;:  weld
    "<div style=\"display:grid;gap:12px\">"
    "<section><h3>clock</h3>"    (trip (shown deps %clock))    "</section>"
    "<section><h3>counter</h3>"  (trip (shown deps %counter))  "</section>"
    "</div>"
  ==
~[(view-of %clock) (view-of %counter)]
```
This lays out the *rendered* views of `clock` and `counter`. Editing either
re-renders the dashboard live.

## Public forms: anyone can write to a page

A clearweb page can carry a real `<form>` that anonymous visitors submit.
Each submission arrives as a **command** to the page, so the form, the
store, and the results view collapse into one gate.

It is opt-in twice, and both switches are owner-only:

1. the page is shared `clearweb`, and
2. public forms are enabled on it (or a folder above it):
   `POST /page-forms?name=<page>&on=1`.

Then `POST /apps/lattice/f/<page>` delivers the body as a command. Build
the markup with the stdlib helpers: `form-of` gives the action URL and
`form-html` a ready-made single-field form.

```hoon
(weld "<h1>Guestbook</h1>" (form-html /guestbook "sign"))
```

### Writing wikilinks

A wikilink name is the **full page path from the root**, not a relative one.
`[[wiki/notes/todo]]` links to that page whether you write it from
`wiki/notes/index` (a sibling) or from anywhere else. `[[todo]]` means a
top-level page called `todo`, and `[[../x]]` does not resolve.

The editor makes that cheap. Type `[[` and a list of your pages appears at the
caret, filtered as you type and ranked with siblings of the page you are
editing first. **Tab** completes the highlighted one to its full path and
closes the brackets, arrows move the selection, Escape dismisses. It reads the
page tree the editor already holds, so there is no request and no index.

Names may use `a-z 0-9 - / . _ ~`. Anything else is left as literal text, which
is also how you write `[[not a link]]` on purpose.

`+guestbook` is a ready-made builder for the common case, in the same shape
as `folder-index`. Your whole page is one call:

```hoon
(guestbook cmd dat /my/page "Guestbook")
```

It renders the form, folds each submission into the page's own data, and
escapes everything it shows. A **`guestbook` template** creates exactly that
page with the path filled in:

```
POST /template-new?template=guestbook&name=<your-page>
```

The logic lives in the stdlib rather than being copied into each page, so a
fix reaches every guestbook and your page stays three readable lines. Source:
[page-examples/guestbook.hoon](page-examples/guestbook.hoon).

Standing limits on this surface, since it is the only public write:

- Submissions are capped at 8 KB.
- Two limits you set, both optional:
  `POST /page-forms?name=<page>&on=1&cap=<n>&gap=<seconds>`
  - `cap` is the **absolute number of submissions** the page will accept.
    0 (the default) means no limit. Over the cap the surface returns `429`.
  - `gap` is the **minimum seconds between submissions**. 0 means no
    cooldown. Inside the window the surface returns `429`.
  Both are read with the same nearest-wins walk as the on/off flag, so a
  folder can set the policy for a whole site.
- `GET /page-forms?name=<page>` reports `{on, cap, gap, count, remaining}`,
  and `POST /page-forms-reset?name=<page>` zeroes the counter. A cap you
  cannot reset would be a one-shot switch rather than a limit.
- Submissions also coalesce in the page's single command slot, and a page
  that reruns too fast is parked, so the practical ceiling is about one
  accepted submission per second even with no `gap` set.
- Both limits are checked when the request arrives rather than in the writer,
  so a refused submission gets an honest `429` instead of a redirect that
  pretends it landed. The trade is that a simultaneous burst can overshoot
  the cap by the number of requests in flight.
- A submission carries **poke budget 0**, so it can never start a poke
  chain into other pages.
- The page's gate decides what the text means. Escape it with `esc`
  before welding it into `html`, exactly as with any other input.
- Turning the flag off (`on=0`) stops submissions immediately, and a page
  that is not clearweb refuses them outright.

## Version history

Every save of a page is a kept revision. `GET /page-history?name=` lists
them, `GET /page-source-at?name=&rev=` reads one, and the editor's history
panel views and restores them (a restore re-saves the old body as a fresh
newest revision, so nothing is destroyed). Autosave means every typing
pause is a recoverable version.

History self-prunes on save past the newest **50** revisions per page
(`+history-keep` in app.hoon), so the stored *content* stays bounded instead of
archiving every keystroke forever. Two honest caveats:

- Pruning covers a page's **source**. A page's computed `data` is a separate
  grub with its own history, which the prune does not cover.
- With autosave writing a revision per typing pause, 50 revisions is roughly
  50 pauses, minutes of active writing. It is a deep undo buffer for the
  current session, not a long-term archive.
- Deleting a page does not remove its stored revisions.

## Timers: a page on a schedule

Return `(every r dur)` and the platform re-runs your gate every `dur`, with
`cmd=~`, like a dependency tick. A self-updating clock, a poller, a
countdown. See ticker. The delay is clamped to a floor (`>= 1s`) so a page
can't drive itself faster than the rate window.

**A timer is sustained load.** Each tick is a real event (re-run + writes).
The next tick is armed for `dur` *after the run finishes*, so there is
always at least `dur` of real idle between runs. A timer whose gate is
slower than its interval no longer pins the loop. It just runs at a high
duty cycle, and the ship stays responsive. Still, use the *slowest* interval
that does the job (seconds, not sub-second), keep the gate light, and prefer
a dependency tick over a timer when something else already changes on the
cadence you want.

## Pokes: one page drives another

Return `(sends r pokes)` where `pokes` is a list of `[page-name command]`,
and the platform sends each as a command to that page, bumping its `cmd`. A
page reached via a poke gets a **decremented budget**, so a poke chain,
cycles included, terminates after a fixed depth (`poke-budget-max`)
regardless of timing. One run emits at most `poke-cap` pokes. See
relay/sink. This is the capped-authority dart. A page can drive other
*pages*, but still can't poke arbitrary agents, make HTTP requests, or write
outside the page tree.

## Known limits (today)

- **Explicit dependencies.** No auto-tracing. Declare what you read.
- **Bounded compute only.** No execution timeout. A runaway
  (non-terminating) gate hangs the loop, because the `mule` fence catches
  crashes, not divergence.
- **Timer duty cycle isn't capped.** The next tick is armed after the run
  ends, so a timer can never pin the loop. But a page whose gate is heavy
  relative to its interval will still run at a high duty cycle, since the
  rate cap keys on rerun *rapidity*, not on how long each run takes. Keep
  timer gates light.
- **Own HTML renders raw. Peer HTML is always escaped.** Your own `html`
  page data is inlined verbatim, so escape dynamic values with `esc`. A
  *peer's* page data browsed remotely is always escaped and served inert. A
  foreign ship can never inject markup into your origin.
