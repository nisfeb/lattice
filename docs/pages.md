# Programmable pages — the manual

The lattice platform (see [platform.md](platform.md)) turns your ship into a
tree of programmable pages: each page is a small Hoon program whose output is
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
in the tree explorer at `/apps/lattice/x/~<you>/apps/lattice.lattice_app/page/<name>/`
(the `?raw` link on a page view shows the grubs).

## The gate: the whole API

Your `code` is one gate. Its sample is fixed; its product is a `+result` from
the page stdlib (`pg`, which is your compile subject):

```hoon
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
```

**Inputs (the sample):**

- `cmd` — the command that triggered this run, or `~` for a *dependency tick*
  ("something you depend on changed; update if you need to").
- `dat` — your page's current data (`~` if never produced). Read it to make an
  update relative to the last value (a counter, an accumulator).
- `now` — the time of this run.
- `deps` — each declared dependency as `[path value]`, pre-resolved. A missing
  dependency's value is `~`.

**Output (`+result`):** build it with the `pg` constructors — you name the
render mode and pass the value:

| builder | data becomes | rendered as |
|---|---|---|
| `(text v)` | `v` | escaped text |
| `(html v)` | `v` | **raw HTML** — your own page's markup |
| `(gmi v)` | `v` | gemtext → HTML |
| `(raw v)` | `v` | opaque noun, shown escaped |
| `same` | *unchanged* | (no write) |

and chain modifiers: `(needs r deps)` sets dependencies, `(every r dur)` sets a
timer, `(sends r pokes)` pokes other pages. `esc` HTML-escapes a cord — use it
on any dynamic value you weld into `html`.

The subject beneath `pg` is the Hoon standard library. A page is a pure
function from `(command, state, dependencies, time)` to a `result`.

## Rendering — data as its own UI

A page's render mode (`text` / `html` / `gmi` / `raw`) decides how its data
shows in the web view and on the clearweb surface. **`html` inlines your
markup raw** — a page's data can *be* a styled interface (forms, layout), not
just a value. This is your own code producing your own HTML; escape any
untrusted/dynamic value with `esc` first. (A *peer's* page data is always
escaped when you browse it remotely — a foreign ship can never inject markup
into your browser.)

## Writing and driving a page

Everything is owner-only HTTP under `/apps/lattice`:

```
POST /page-save?name=<name>     body = the hoon source    create/replace code
POST /page-cmd?name=<name>      cmd=<text> (query or form) send a command
POST /page-del?name=<name>                                delete the page
POST /page-share?name=<name>&mode=private|shared|clearweb  set sharing
```

`page-cmd` reads `cmd` from either the query string (programmatic callers) or a
form-urlencoded POST body (browser forms). Each command bumps `cmd`'s seq, so an
identical command still runs.

Navigate the explorer to a page dir and you get the **live view**: the rendered
data, any error, a command form, and the sharing controls — and it reloads
itself (keep-SSE) whenever the page changes, so a command from one tab updates
every open tab.

## Commands

A command is text. Your gate decides what it means. Common shapes:

- a verb: `inc`, `reset` (see counter)
- a payload: the whole command is the value (see note)
- ignored: a page that only reacts to dependencies ignores `cmd`

A command sent to a page whose code doesn't compile is **not lost** — once you
fix the code, the pending command runs against the fixed version (exactly-once,
tracked in `seen`).

## Dependencies — the spreadsheet

Return a `dep` list of grub paths and the platform keeps a subscription on each.
When any of them changes, your gate re-runs with `cmd=~` and the fresh values in
`deps`. This is push-based (no polling) and is how one page reacts to another —
the tree behaves like a spreadsheet. See doubler.

Dependencies are **explicit**: you declare them; the platform does not trace your
reads. A page that forgets to declare a dep simply goes stale until poked —
visible and debuggable (the `deps` grub is right there in the tree).

Paths are absolute grub paths, e.g.
`/apps/lattice.lattice_app/page/counter/data`. `data-of` builds one from a page
name: `(data-of %counter)`.

## Composition — a page inside a page

A dependency on another page's **`/view`** gives you its *rendered HTML* instead
of its raw data — so a page can lay out the rendered views of other pages. Name
it with `view-of` and pull the fragment out of `deps` with `shown`:

```hoon
%+  needs
  (html (crip :(weld "<section>" (trip (shown deps %clock)) "</section>")))
~[(view-of %clock)]
```

A view-dep re-renders your page whenever the embedded page's data *or* render
mode changes — same reactive machinery as a data dep, so a dashboard stays live.
See dashboard. Composition is **own-pages only**: `view-of` only resolves pages
in your own tree, so a peer's markup is never rendered into your page (a foreign
`/view` path silently yields nothing). Nesting works through stored data — if A
embeds B and B embeds C, A shows B-including-C — with no runtime recursion.

Embedding an *always-changing* page (a clock, a timer page) makes the container
re-render at that cadence — bounded, but live churn. Compose pages that settle,
or accept the refresh rate of the busiest thing you embed.

## Sharing

Each page has a one-click preset (shown in its live view):

- **private** (default) — only you, over authenticated HTTP.
- **shared** — the `data` grub is published to the Urbit namespace and any ship
  can read it over ames (the same federation the published pages use). Live: a
  subscribing ship sees updates.
- **clearweb** — shared, and the data is *also* served over unauthenticated HTTP
  at `/apps/lattice/c/<name>`. This is the only public surface: it serves that
  one page's rendered data, nothing else — no tree, no code, no other pages.

Sharing is a permission on the page, not a different kind of page. A private
note and a clearweb dashboard are the same machinery with a different grant.

## Safety

- Both **compile and run are fenced** (`mule`). A page that fails to compile or
  crashes at runtime writes `err` and keeps its last good `data`. A broken page
  never takes down the ship or other pages.
- Page code runs in the ship's single event loop, so **the fence catches
  crashes, not non-termination**. Don't write an infinite loop or an unbounded
  recursion in a page — there is no timeout yet. Keep pages to bounded, total
  computation. Heavy or long work is a future platform feature (threads), not a
  page.
- A divergent dependency cycle (A depends on B depends on A, each changing the
  other) will spin; a *converging* one settles (identical output suppresses the
  next write). Prefer converging derivations.

## Worked examples

All verified on the harness. Full sources in
[page-examples/](page-examples/).

### counter — commands and state
```hoon
=/  n=@ud  ?~(dat 0 (fall (rush ;;(@t u.dat) dim:ag) 0))
=/  m=@ud  ?:(&(?=(^ cmd) =(u.cmd 'inc')) +(n) n)
(text (crip (a-co:co m)))
```
`page-cmd?name=counter&cmd=inc` → `0`, `1`, `2`, …

### card — data as HTML (`html` + `esc`)
```hoon
=/  msg=@t  ?~(cmd 'send a command to set my text' u.cmd)
%-  html  %-  crip
;:  weld
  "<div style=\"padding:1rem;border:2px solid #1a6ed8;border-radius:8px\">"
  "<h2>Card</h2><p>"  (trip (esc msg))  "</p></div>"
==
```
renders a real styled box; the command value is `esc`-escaped, the box markup
is raw.

### greeter — a command as input
```hoon
=/  who=@t  ?~(cmd 'world' u.cmd)
(text (cat 3 'hello, ' who))
```

### note — the command is the value
```hoon
?~(cmd same (text u.cmd))
```

### clock — using `now`
```hoon
(text (scot %da now))
```

### doubler — a derived page (dependencies)
```hoon
=/  tgt=path  /apps/lattice.lattice_app/page/counter/data
?~  deps  (needs same ~[tgt])
=/  v=@ud  (fall (rush ;;(@t +.i.deps) dim:ag) 0)
(needs (text (crip (a-co:co (mul 2 v)))) ~[tgt])
```
first run declares the dep; thereafter, incrementing `counter` re-runs doubler
automatically — no command needed.

### dashboard — composition (embedding rendered views)
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
lays out the *rendered* views of `clock` and `counter`; editing either re-renders
the dashboard live.

## Timers — a page on a schedule

Return `(every r dur)` and the platform re-runs your gate every `dur` (with
`cmd=~`, like a dependency tick). A self-updating clock, a poller, a countdown.
See ticker. The delay is clamped to a floor (`>= 1s`) so a page can't drive
itself faster than the rate window.

**A timer is sustained load.** Each tick is a real event (re-run + writes). The
next tick is armed for `dur` *after the run finishes*, so there is always at
least `dur` of real idle between runs — a timer whose gate is slower than its
interval no longer pins the loop; it just runs at a high duty cycle and the ship
stays responsive. Still: use the *slowest* interval that does the job (seconds,
not sub-second), keep the gate light, and prefer a dependency tick over a timer
when something else already changes on the cadence you want.

## Pokes — one page drives another

Return `(sends r pokes)` where `pokes` is a list of `[page-name command]`, and
the platform sends each as a command to that page (bumping its `cmd`). A page
reached via a poke gets a **decremented budget**, so a poke chain — a cycle
included — terminates after a fixed depth (`poke-budget-max`) regardless of
timing. One run emits at most `poke-cap` pokes. See relay/sink. This is the
capped-authority dart: a page can drive other *pages*, but still can't poke
arbitrary agents, make HTTP requests, or write outside the page tree.

## Known limits (today)

- **Explicit dependencies.** No auto-tracing; declare what you read.
- **Bounded compute only.** No execution timeout; a runaway (non-terminating)
  gate hangs the loop — the `mule` fence catches crashes, not divergence.
- **Timer duty cycle isn't capped.** The next tick is armed after the run ends,
  so a timer can never pin the loop, but a page whose gate is heavy relative to
  its interval will still run at a high duty cycle (the rate cap keys on rerun
  *rapidity*, not on how long each run takes). Keep timer gates light.
- **Own HTML renders raw; peer HTML is always escaped.** Your own `html` page
  data is inlined verbatim (escape dynamic values with `esc`); a *peer's* page
  data browsed remotely is always escaped and served inert, so a foreign ship
  can never inject markup into your origin.
