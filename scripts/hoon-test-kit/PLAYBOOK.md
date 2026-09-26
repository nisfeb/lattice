# Playbook

How to put a Hoon app's tests on the kit, find what they miss, and close it.
Every rule here comes from something that went wrong at least once on auspex
(2026-09-25). Keep it current: when a run teaches something new, add it
here in the same change.

## Rolling out to an app

Do these in order. Each step has a condition for moving on.

1. **Make the libs reachable.** A test build reaches only what is on the
   test desk. Libs that import nothing are easiest. A lib that imports
   other libs or a `sur/` file works if those are listed in `LIBS` or
   `FILES` too. Logic inside the agent or nexus cannot be tested this way
   at all: move it into a lib first. *Done when* every lib you want tested
   builds on the desk.
2. **Set up the kit and run a baseline.** Vendor the kit, write
   `hoon-test.conf`, then `|new-desk` and `|mount` the test desk, run
   `setup`, then run the suites. *Done when* `hoon-test.sh <pier>` exits 0
   and the count of distinct `OK` lines in the ship's terminal matches the
   number of `++  test-` arms in the files. Count them with `sort -u`: the
   scrollback keeps earlier runs, and `tmux clear-history` does not clear
   what is still on the screen.
3. **Run the cheap mutation pass.** `hoon-mutate.py <pier> --list`, then
   the default ops (`boundary,conjunct`). They aim at caps and guards, and
   give the most real findings per commit. *Done when* every survivor is
   triaged (below).
4. **Close the real gaps**, then rerun only the arms you fixed with
   `--only`. *Done when* every mutant there is killed or has been moved to
   equivalent with a reason.
5. **Run the rest of the menu**: `--ops branch,equal,flag`. Check the
   no-build rate per op first (below). Triage, close, and recheck as
   before.
6. **Write down what the run found**: in the app's own docs, what
   survived and why each equivalent is equivalent. Anything new about the
   *method* goes in this file.

## Reading a mutation run

Each mutant ends in one of four ways:

| verdict | meaning |
|---|---|
| `killed` | some test failed. Good. |
| `SURVIVED` | every test passed with the code broken: a gap, or a mutant that changes nothing |
| `no-build` | the mutant does not compile, and is discarded |
| `timeout` | it ran past the limit, and the ship may be spinning. The run stops and tells you to press ^C in the ship's dojo. With `DOJO_PANE=<tmux pane>` it types the ^C itself and goes on. A signal to the worker does **not** interrupt a spinning event. |

**Check the run's health before reading survivors:**

- **Implausibly fast results (0 s) mean the ship, not the tests.** A dead
  ship used to make every later mutant "killed". Now the runner exits 4
  and the rest of the run is void.
- **A high no-build rate for one op means the site finder is wrong.** The
  first `equal` regex matched the `=(` inside `|=(` gates: 66 of its 87
  mutants never compiled, so most of that op silently never ran. Above a
  handful of no-builds, fix the pattern and rerun that op alone.
- **A verdict that changes between `--only <arm>` and the full run means
  the run is contaminated.** Until 2026-09-25 the runner left each lib's
  last mutant on the desk when it moved on to the next lib, so every later
  mutant ran against two breaks: on the calendar, `rules`' last mutant
  "killed" every `rrule` mutant, and `rrule`'s last one (which did not
  build) made every later mutant a no-build. Fixed: the previous lib is
  restored before each mutant. **Rerun any multi-lib pass made before the
  fix** (auspex's included): its killed counts are too high.
- **Some no-builds are expected.** Swapping `?.`/`?:` after a `?=` test
  breaks the type narrowing the other branch relies on, so those mutants
  can't compile. That is correct. The same goes for a tall `?&` condition
  that spans lines: the text-based finder splits it, and both halves fail
  to build.

**After the kit gains an operator, rerun just that operator** over code
already mutated. `--ops wide` is `conjunct`'s wide half alone: on auspex,
whose earlier runs predated it, it found 67 new sites, and one real gap
among the libs' 26.

## Triaging a survivor

**Re-trace every survivor before writing a test for it.** Read the arm and
its callers, and ask whether the mutant can change any output. On auspex,
17 of 44 survivors turned out to be equivalent. A test written for one of
those is written against code that cannot fail.

These kinds of mutant are equivalent, with no output that could differ:

- **A fast path that repeats a check** the loop makes anyway.
- **A comparator behind an equality guard.** `?.  =(a b)  (lth a b)` can
  never compare equal values, so `lth` and `lte` agree there.
- **A running maximum or minimum**: `gth` and `gte` pick the same value
  on a tie.
- **A path that gives the same result at the boundary**, such as shedding
  down to N when there are exactly N.
- **A bound that limits cost, not the answer**, like a `scag` before a
  walk. It is real, but output can't show it.
- **A spelling the rest of the code cannot reach.** On orrery,
  `(gth (lent w) 3)` → `gte` before stripping a plural `s` only changes
  three-letter words, and no two-letter weekday name exists to match.
- **A `$~` default on a mold that is never bunted.** Grep the app for
  `*<mold>`. If the mold is bunted, the default is a real contract, so
  test the bunt. If it is only ever clammed with `;;`, the mutant is
  equivalent.

What is left is a real gap, usually one of these:

- **A whole check no test reaches.** A test that looks complete, such as a
  "bounds" test, may never touch one of the bounds: delete it and every
  test still passes.
- **A boundary only tested from one side.** "cap + 1 is refused" does not
  fail when `lte` becomes `lth`.
- **A branch only tested one way**, such as a search tested with a query
  that hits but never with one that misses.
- **An arm with no test at all.** Mutation finds these even when a
  coverage count says the lib is well covered.

A check that is only defensive, reachable only if some earlier validation
was skipped, can stay untested. Say so in the triage notes.

Some survivors are real but not worth a test. Record them as **accepted**
with the reason, never as equivalent, since output can differ:

- **An exact-instant comparison against now in a pass that reruns every
  few minutes**, such as `(lte r.occ now)`. At the one instant of equality
  the pass decides one way, and the next pass decides the same as either
  spelling would.
- **A sort comparator on ties the output never promises to order.**

`--since` names a line's arm by the nearest arm above it, so code
appended at the end of a core credits its first lines to the core's old
last arm, which then shows up in the run. Drop it with `--only` when the
diff did not touch it.

On orrery's first `--since` run, 44 of 51 mutants survived: 20 real gaps,
20 accepted and 4 equivalent. Code written in a
fix pass arrives without its boundary tests, so run `--since <rev>` right
after the change.

## Writing tests: traps

- **`weld`/`zing` over literal tapes can `fuse-loop`** the type checker
  (`;:  weld  "a"  x  "b"  ==` did, and so did `(zing (reap n "é"))`
  inside a `weld`). Cast: `` `tape`(zing `(list tape)`(reap n "é")) ``.
- **`%+  expect  !>` is wrong**: `expect` takes one vase. Write
  `(expect !>(…))`.
- **`*mold(field x)` does not parse**: a bunt takes no changes. Bind it
  with `=/` first, then change the face. (`?=` needing a wing is under
  "Writing the missing test".)
- **`roll` or `weld` over an untyped literal list mull-grows.** Cast it
  (`` `(list entry)`~[…] ``) or weld through a dry gate.
- **Before trusting a count, check what a structure really holds.** A
  day span puts both its edges in the calendar's index, so a year of
  dates is two keys, not one. The first run of a new suite is as likely to
  find a test's wrong assumption as a bug; read the expected/actual.
- **A new suite can find real bugs before any mutant runs.** The
  calendar's first run found `FREQ=weekly` refused (RFC 5545 values are
  case-insensitive).

- **A loobean bunts to `%.y`.** A value built from a bunt
  (`*inbound-request:eyre`) has every flag set to yes: its
  `authenticated` is `%.y`, so every request in a test looked like the
  owner's and an auth check passed everything. Set each flag the arm
  reads. The mutant on the auth check is what showed it (calendar).
## Writing the missing test

- **Put it in the test that already owns the rule.** Add a new test only
  when nothing owns it.
- **One case per clause of a `?|` or `?&`.** A fixture that meets every
  clause at once kills none of the `conjunct` mutants. Orrery's one
  "ship's own" calendar event carried all three marks (an `orrery` meta
  key, an `orrery-` id and an `orrery` tag), so dropping any one survived.
  Test an event with each mark alone.
- **A window has two edges and each has two sides.** Something ending
  exactly as the window opens is outside, and so is something starting
  exactly as it closes. An all-day event ends at exactly the next
  midnight, so this edge is the common case, not a corner.
- **Build cap-sized values in place.** Use `(crip (reap 64 'a'))` for a
  string of exactly the cap, and `(turn (gulf 1 n) f)` for n items.
- **`?=` takes a wing, not an expression.** For a unit an arm answers,
  test `!=(~ (f x))` or bind it first with `=/`.
- **Test caps as a pair**: exactly the cap is accepted, and one past it is
  refused.
- **For ordering, test the promise, not the key.** Which field breaks a
  tie is arbitrary; that every ship gets the same order is not. "Same
  output for both arrival orders" passes for any total order and fails
  for one that leaves two elements unordered.
- **For n distinct ships**: `(sy (turn (gulf 1 n) |=(i=@ `@p`i)))`.
- **Prove it with the mutant.** Run the suite on the real code (it must
  pass), then `hoon-mutate.py --only <arm>`: the mutant must now be
  killed. A test that never failed proves nothing.

## Look after the ship

Every mutant is a commit, and every commit costs loom. A full menu on one
app is a couple of hundred commits.

- **Use a ship nothing else is building on**, ideally one kept only for
  tests, and `|meld` it before a long run. `~wex` died mid-run at
  `--loom 33` with `loom: external fault`, about 150 test-desk commits
  into a day, while another session rebuilt a nexus on the same ship.
- **On a shared ship, ask before a long run, and stop it cleanly.** One
  session's release checks failed when another's mutations built beside
  them. `^C` (or `kill -INT` to the runner) now finishes the mutant in
  flight and restores the clean libs before exiting; a second `^C` stops
  at once. The suite runs in its own session, so a terminal ^C for the
  runner doesn't cut it off mid-build. An interrupted run before this fix
  left a mutant in the mount: compare the mount with a fresh translation
  before trusting the desk.
- **Another session's gates fail with it, and look like bugs.** When
  `~wex` died (`external fault: 0`) during a mutation run on
  2026-09-25, calendar's two-ship gates were running there and three
  checks failed; they passed on a quiet rerun. Tell the other sessions on
  a ship before a long run, and rerun a failure on a quiet ship before
  believing it.
- **A crash is stop-and-report.** Only the ship's owner restarts a pier.
  Believe the runner when it says the ship stopped answering. On
  2026-09-25, `~nec`'s vere process was still listed while the ship was
  dying, and an agent read it as slow. The runner now names the mutant
  that was running.
- **A crash is not always a full loom.** `~wex` (`--loom 33`) and `~nec`
  (the default 2 GB) both died during kit runs with `loom: external
  fault: 0`, a fault at address 0, outside the loom. After `~nec`'s
  restart, `|mass` showed 617 MB marked of 2 GB, and three commits of a
  6,200-line lib added only about 16 MB. The mutant running at the time
  only flipped a comparison. `~nec` died the same way again that
  afternoon (`external fault: 0x10`), 37 mutants after a meld that had
  freed 562 MB, on a harmless mutant. So neither a fresh meld nor a count
  of commits predicts it (10, about 110 and 37 commits between deaths).
  `~feb` (default loom) died the same way on 2026-09-26, and **twice on
  the same mutant**: lattice-clip's `+parse-num` with `(gte c '0')`
  dropped, so `(sub c '0')` underflows on any byte below `'0'`. So at
  least one trigger is a mutant, not the ship's history. When a ship
  dies, note the mutant, and rerun it alone before blaming vere.
  Its third death that day came on lattice-md's `+block-start`
  `gth`->`gte`: the worker sat at 100% CPU (a spinning mutant), then
  segfaulted before the runner's timeout sent its ^C. A mutant that
  loops can kill the ship, not only park it.
  The fourth death followed the same shape: `+rb` spun 228 s, took the
  ^C, and 60 mutants later another `+rb` mutant killed the ship. Set
  `MUTANT_T` near a few honest runs (30 s where a mutant takes 7), and
  once an arm spins, move on without its other mutants.
  With `MUTANT_T=30`, lattice's next pass took two spins and lived, but
  `+block-start` `gth`->`gte` killed `~feb` again at 30 s: the spin ran
  the worker to 1.1 GB, `hoon-test.sh` exited 4 (no answer), so the
  runner read it as a dead ship and sent no ^C, and the ^C sent by hand
  was followed within seconds by the segfault. `MUTANT_T` shortens
  runs; it does not save the ship. **Keep a list of the arms whose
  mutants kill the ship, and leave them out of every run** (`--only`
  the rest).
  The cause is open; the common factor is vere 4.6 under the kit's
  steady socket traffic, a commit and a build every few seconds. To size
  the risk on your ship, read `total marked:` from `|mass` before and
  after a few mutants.
- **A batch of passes must stop at the first dead ship.** A script that
  runs one `hoon-mutate.py` pass after another should check the first's
  output for "stopped answering" before starting the next.

- **Never type into a dojo someone may be using.** `|new-desk` and `|mount`
  are the owner's to run: if the pane shows input you did not send (a
  `|pack`, a half-typed line), stop and ask.
- **In a shell tool, `rm` may be `rm -i`** and wait forever on a prompt,
  and `pkill -f <pattern>` kills the tool's own shell when the pattern is
  in its command line. Use `rm -f`, and put a `pkill` in a script file.
- **A clean mount is not a clean desk.** After a crash the mount can hold
  clean files while clay still holds the last mutant. rsync then sees no
  change and never commits. `NOSYNC=1 hoon-test.sh <pier>` commits the
  mount as it stands and settles it. `hoon-mutate.py` restores this way
  itself when a run ends.

## Testing nexus code

A grubbery nexus mixes code that touches the tree with code that doesn't,
and `-test` can build neither while it sits in the nexus. Three steps, in
order of value per hour. Auspex took the first two on 2026-09-25
(`auspex/docs/hoon-testing.md`, "Reaching the nexus").

1. **Move the pure arms into a lib.** Split the nexus core into arms. An arm
   is a fiber if it uses `;<`, `bind:m`, `pure:m` or `form:m`, and it
   touches grubbery if it names `tarball`, `nexus`, `rail`, `dart` or
   `bowl`. Keep the arms that are neither and whose every callee also
   qualifies, so you have a closed set. Move the ones that carry logic,
   usually the HTTP JSON, view and filter rules, query parsing and storage
   layout, into a lib the kit already builds.
   - **Leave a one-line alias** in the nexus for each (`++  x  x:uc`), so
     no call site changes. Renaming call sites collides with faces that
     share an arm's name.
   - **Prove the nexus unchanged on a ship.** Capture every read route's
     JSON, put the old code back, capture again, and diff. Auspex: 50
     routes, byte-identical.
   - Then test the moved arms and mutate them like any lib.
   - **Count `+$` molds as arms** when you pick the closed set. A mold
     between two arms is otherwise swallowed into the arm above it, stays
     behind, and the lib fails `-find.<mold>`. Molds are pure: move them
     and alias them too (`+$  x  x:uc`).
   - **Make the route diff mean something.** Seed varied data first; a
     ship with two items proves little. Capture twice with the old code
     and check those two agree before comparing old with new, strip
     any time-dependent field, and include the refusals. Calendar: 58
     routes; auspex: 50, both byte-identical.
   - **A grubbery build error is not on the console**, which says only
     "did not compile". It's on the file: `GET /grubbery/ball/<desk>/code/
     lib/x.hoon?info=1`, field `build.detail`.
   - A moved arm may use a lib from grubbery's own subject (`sut` in
     `app/grubbery.hoon`: `json-utils`, `html-utils`, ...). Put it in
     `PRELUDE` and fetch the real one with `SHIP_FILES`.
   - **Then lift the decisions out of the fibers.** The closed pure set is
     usually small: on orrery it was 21 arms of 238, about 280 of 5,600
     lines, while the rules the business depends on sat inside fibers,
     between a read and a write. Leave the fiber its reads and writes,
     and move each decision into a pure arm that takes what was read:
     - A refusal becomes `(unit [code=@ud why=@t])`, and the fiber sends
       it: `?^  refused  (send-err eyre-id code.u.refused why.u.refused)`.
       Keep the checks in their old order, so the same request gets the
       same error.
     - A router's `?:` chain becomes a table in the lib, answering a tag
       and who may take the route (`%own`, `%writes`, `%any`), and the
       nexus dispatches on the tag with `?+`. The access table is then
       testable, and a new route can't be added without an access. Write
       a script that generates the table and the nexus's dispatch from
       the old chain, so no row is retyped, and generate the test's
       expected table from the lib the same way.
     - Look for the same rule written out more than once. Orrery had the
       chat and mail readers' sifts, three copies of the owner's-timezone
       fallback, and six of "today's count from the record": each became
       one arm.
     - When a lifted block took a binding the fiber still uses, the
       nexus fails `-find.<face>`, one ship rebuild later. Before
       staging, search the rest of the arm for the face in every form,
       `s+day` included, not just `(day` and ` day `.
     - Orrery moved 21 arms and 5 molds, and lifted 37 arms. A route
       capture of 68 answers (every read route as the owner, a writing
       key and a read-only key, plus every refusal the router makes) came
       back identical, apart from timestamps and the passes that ran again
       when the nexus reloaded. Mint the capture's keys before the first
       capture, or their last-used stamps differ too.
2. **A route script on a live dev ship.** Drive every route the clients
   use, the way they use them, including every refusal the API promises.
   This is the only layer that sees wiring: a route pointed at the wrong
   handler, a missing grant, a mark the nexus doesn't hold. Tag everything
   it creates and delete it all in a `finally`, restore any settings, and
   poll after writes, since the writer applies them after the route
   answers. **Prove it bites**: rename one route on the ship, and exactly
   that check must fail.
   - Log in with `ship-cookie.sh <pier> <base-url> <cookie-jar>`. It
     fetches `+code` over `conn.sock`, posts it on stdin (never in argv,
     never printed), keeps only the cookie, and refuses when the port
     answers as a different ship. Fake ships move ports on restart.
3. **Drive the fibers** with `hoon/fiber-test.hoon` (README, "Driving a
   nexus's fibers"). A fiber is `$-(input output)`, so a test can run one
   exactly as the runtime does. To get there:
   - **Build the nexus on the test desk.** Put it in `LIBS` with
     `DIALECT=grubbery`; put the faces grubbery gives every nexus that it
     uses in `PRELUDE` (count them: auspex needed `tarball nexus loader
     io=fiberio http-utils`), and the libs behind them in `SHIP_FILES`
     from `%grubbery`. Its web-client files arrive as relative `/<`
     imports, and those need their marks (`html js json svg`).
   - **Enter through `+on-file`**, like grubbery: `((on-file:app rail blot)
     ~)` is the grub's process, and its starting state is whatever that
     grub holds. For a request grub that is `[src inbound-request]`, which
     `+request` builds.
   - **Assert what the fiber did:** the pokes it sent (the writer's actions,
     by mark) and the response it gave. How it did it is not the contract.
   - **Answer like grubbery answers.** Every bowl read gets a reply *and*
     an ack; answering with only the reply leaves `take-bowl` waiting
     forever for the ack, and the run stops `%wait` after one dart. When a
     run stalls, print each step's input kind and verb: the stall is the
     step whose input it wanted and never got.
   - **An asset or read route stops at its peek.** The harness leaves
     peeks unanswered, and that is enough: assert which grub the route
     read (`+peeks`). Auspex's router went from 11 surviving mutants to
     none with one table test over its five asset routes and one for
     `whoami`.
   - Mutating the nexus rebuilds it per mutant (about 20 s each on
     auspex), so mutate by arm with `--only`: the route handlers you
     tested, and the router, whose survivors are exactly the routes no
     fiber test reaches yet.

## Mutating fibers against a running app (`--live`)

When the pure decisions are lifted and covered, what is left in a fiber
is control flow: acting on a refusal, dispatch, "nothing changed" early
returns. `hoon-mutate.py --live` measures it with the app's own live
checks (README, "Mutating what only a running app exercises"). What
auspex's first runs taught (2026-09-26, 70 live mutants, about 2 h):

- **A survivor is first a question about the judge.** Every survivor of
  auspex's first live run pointed at a step no check took: a reply into
  an existing thread, an archived thread getting mail, an attachment
  fetched from another ship, a forgotten peer. Adding each step killed
  the mutants behind it (18 survivors to 9 to 3). Ask which user-visible
  step would have noticed, and add it.
- **Check where the effect is not masked.** A rule's label was written
  only when a thread's archive state didn't change, so checking it on
  the thread whose un-archiving rewrote everything missed it.
- **Some survivors are decisions after all.** A one-line "did this write
  anything" that other logic depends on is worth lifting and testing.
- **State the ship keeps can hide a mutant.** A /proto already in the
  farm, a cached peer record. Clear what the API lets you (auspex's
  `forget-peer`), and name what it doesn't.
- **The judge is re-read for every mutant.** Don't edit the check
  scripts during a run.

## Never ship a crash loop (grubbery apps)

Calendar versions 18 and 19 locked their users' ships on 2026-09-24 and
2026-09-25. Before touching any fiber's crash handling, its start-up code,
or anything that reads stored state, know how that happened.

- **A restartable fiber's first step takes the kick; it never sends.**
  After a reload or restart grubbery queues the start's null kick behind
  any inputs already waiting (a timer wake, news, a late HTTP answer). A
  first step that only sends (`send-dart`, so also `poke`, `get-time`,
  `cancel-timer`, `nonce`) asserts it was kicked, and a queued real
  input crashes it: `real-input-to-oneshot-step`. With a back-off it does
  not spin, but every reload is a crash and each lengthens the wait: a
  day of reloads left calendar's sync fiber parked an hour, publishing
  nothing, which read as a cross-version share bug. Start the handler
  with `|=(input :+ ~ q.state ?~(in [%done ~] [%skip ~]))` (calendar's
  `+take-kick`, commit 9733316). Test: reload the instance several times
  with writes in flight; `rise.json` must not move. Any `+rise-later`
  ported before 2026-09-25 evening has this.
**How one crash becomes a hung ship.** A fiber that returns `%fail` is
restarted at once, with `prod=[~ tang]`, in the same Gall event, and
`+abet` runs the take queue until it is empty. A fiber that fails again
before it reaches a wait therefore restarts forever inside one event: HTTP
dies and the worker sits at 100% CPU. A weir veto on a hard dart is a
`%fail`. A fresh install's weir refuses everything until the user approves
the permits, and a user can uncheck roads later. So `poke:io`,
`set-timer:io`, `cancel-timer:io`, `get-time:io` and `nonce:io` can fail at
any time; every poke and peek draws entropy from `/sys/bowl.sig`. And a
poke that a fiber holds (`%skip`) while it waits hangs its sender, because
grubbery re-offers every held poke on each step.

1. **After a crash, the first thing a fiber does must be a wait that
   cannot fail**, with no hard dart before it. `rise-wait:io` is safe: it
   sends nothing and waits for a poke. To retry on a timer, make the clock
   and the timer soft: send on a fixed wire (no nonce), and treat `%veto`
   as "no timer, wait for a poke". Never `%fail` inside the crash handler.
   Reference: calendar's `+rise-later`, `+soft-behn`, `+soft-now` and
   `+rise-park` (`code/nex/calendar/app.hoon`, commit `da42ed6`).
2. **Never retry without a wait between tries.** Back off 1, 2, 4, up to 60
   minutes, and print the full trace only for the first couple of crashes.
3. **While a crashed fiber waits, refuse pokes; don't hold them.** Return
   `%fail` with a marker tang, and on restart treat that tang as "not a
   crash". Never `%skip` them. `rise-wait` takes the first poke as its
   restart signal and drops its payload, so a real poke arriving then is
   lost. And a fiber nobody pokes (a sync loop, a tick, an HTTP
   dispatcher) stays down under `rise-wait` until a reload.
4. **Everything that runs at start must be total over old data.** Wrap
   every read of stored state in `mole` with a fallback. Never apply
   `need`, `snag`, `got:by`, `;;` or `!<` to a stored noun without one.
   Make migrations idempotent, and `mole` them item by item, so an item
   that won't convert is left as it was.
5. **`mole` bounds crashes, not time.** Any loop whose length comes from
   data needs a cap: an RRULE `COUNT`, an index, a date range, pages from
   a remote. Urbit is single-threaded, so a long loop freezes the ship.
6. **Validate at the door.** Never store what a later reader can't handle.
   Calendar 17 stored a weekday spelled "Monday", and 18's start-up
   conversion crashed on it every time.
7. **Test the upgrade, not just the new code.** Put the previous release
   on a test ship with old and malformed data, including whatever the old
   code accepted unchecked. Switch to the new code and watch for five
   minutes: the instance's bang is null, the worker is idle, the route
   answers, and pokes are acked.
8. **Test a refusing weir.** On a test ship, remove `/sys/behn/` and then
   `/sys/bowl.sig` from the instance's poke weir (explorer action
   `del-weir-road`, then `reload-nexus`). The app must park, with the
   worker near 0% CPU, not spin. Measure CPU from deltas in
   `/proc/<worker pid>/stat`, not `ps %cpu`. A slow `?info=1` is not a
   hang, and a dead route with CPU at 0 is a parked fiber, not a spin.

**Testing crash handling: what auspex's fix taught (2026-09-25).**

- **Unit-test the park, then prove it live.** `fiber-test`'s `refuse`
  and `nack` cover the rules without a ship: a crash waits and sets a
  timer, a poke while waiting is refused, a refused clock or timer parks,
  and each of those failed against the old `rise-wait` code. They didn't
  catch the one bug that mattered, though. Only a live cycle did.
- **Live, inject the crash.** When the app's start-up survives every weir
  refusal (auspex's did), a refused road never reaches the crash path.
  Deploy a test-only build to the test ship with a `fiber-fail:io` right
  after `+rise-later`, then watch the crash record grow 1, 2, 4 minutes
  apart with CPU at 0. Then deploy the real code, whose clean start clears
  the leftover timer.
- **That found a real bug: time units.** `time:enjs` writes MILLISECONDS
  and `du:dejs` reads SECONDS (`di` reads ms). A record written then read
  back put the wake in the year 58704. The first crash was fine; the first
  refused poke re-read the record and replaced the one-minute timer. A
  round-trip test of the record now pins it. Read behn's timer table
  (`/grubbery/ball/sys/behn/main.behn-state`) whenever a wake doesn't come.
- **A refused poke must still answer the browser.** With `poke:io`, a
  crashed writer's refusal failed the request fiber, which parked with the
  request unanswered until the browser gave up. Use `poke-soft:io` and
  answer 503 ("recovering from a crash").
- **A reload removes a grub the loader doesn't know**, such as
  `rise.json`, so `reload-nexus` resets the crash count.
- **100% CPU and no answer can be a long build, not a spin.** A shared
  test ship rebuilding another app's nexus (25 s a time, one per write)
  looks exactly like a spin. Read the dojo: repeated `build: cache MISS`
  lines that finish mean building. Wait at least one build's length
  before sending ^C, because ^C rolls back whatever event it interrupts,
  and on a shared ship that may be someone else's write.

What orrery's run of 7 and 8 added (2026-09-25):

- **Test on the stock kernel.** A grubbery build that parks a fiber whose
  dart was refused (a kernel-side guard) acts before the app's own crash
  handler, so on such a kernel test 8 proves only the kernel. Check which
  one acted: the app's own messages and its `rise.json`, or a grub bang
  saying "fiber parked: a dart was refused by the weir".
- **Refusing behn or bowl.sig only tests parking.** To test the back-off
  itself, refuse a road that leaves the clock and the timer alone, and
  make a fiber use it: with `/sys/iris/` refused, a forced model call
  crashes the generator, which then waits 1, 2 and 4 minutes, printing
  "again (3 times running)" on the third, and comes back each time.
- **Know when a poke should be refused.** Only a fiber parked in its wait
  refuses. A poke that lands during a settle or a pass is taken, and may
  be what starts the pass that crashes, so it answers ok.
- **Porting `+rise-later` brings its marks.** `+soft-now` names `%bowl-req`
  and `%time`; a guest desk must carry `mar/bowl-req.hoon` and
  `mar/time.hoon`, or its closure check fails.
- **Fibers that crash together share one record.** With a refused weir
  every fiber crashes at once, each writes `rise.json` back from what it
  read, and some rows are lost: those fibers' counts restart at 1. They
  still wait; a grub per fiber would end it.
- **A kernel reload drops staged code.** Code written into a desk's tree
  with `write-text`, not committed to the desk's source, is replaced when
  grubbery reloads. After someone else's kernel commit, check the code
  that runs by a route whose answer changed, not by the version route.
- **Feed the upgrade test through the old code's own routes**: settings
  of the wrong types, inbox items with odd fields, values at the size
  caps, actions with payloads of odd shapes. Orrery's
  `scripts/upgrade-seed.py` and `scripts/ship-watch.py` are the pair.

**If a ship is spinning,** press ^C in its dojo (with tmux:
`tmux send-keys -t <pane> C-c`); `kill -INT` on the worker does nothing.
Then remove the trigger straight away: approve the app's permits, or
restore the weir. The interrupted event rolls back.

**Releases.** A version bump pushed to the release branch reaches the
publisher within about 15 minutes, and every subscriber minutes after
that. Nothing gates it. Keep releases small, and never push start-up or
crash-handling changes without doing 7 and 8 first.

## Traps in building the runner

These are already handled in the scripts. They are here for anyone
changing them.

- **khan-eval takes the hoon as one cord.** Every newline must become
  *two* spaces: one space is not a gap, and the parse fails with
  `syntax error {1 N}`. The cord cannot contain `'`.
- **In a bash heredoc, escape Hoon's `$(` as `\$(`** (and backticks), or
  bash runs it.
- **`~[ x]` with a leading space is a syntax error, and so is `~[]`.**
  An empty generated list must be written `~`.
- **A backslash escape in the thread's hoon is read by the outer cord.**
  `"\0a"` arrives as a raw newline inside a tape, and the parse fails.
  Write `(trip 10)`.
- **A product that is itself `[%leaf tape]` arrives bare** (`%leaf 79 75 …
  0`, no brackets), unlike a failed thread's leaf. The report decodes both.
- **The commit lands after the poke acks.** The runner polls `/cz/<desk>`
  until the hash moves, and skips the commit when nothing changed, or it
  would wait forever.
- **`%json` needs `%mime`.** `mar/json.hoon` declares `++grad %mime`.
  Without it, any `/*` of a json file fails its whole test file as
  `FAILED … (build)`: one line, easy to miss among the OKs.
- **Copy support files from `%base`, never vendor them.** `lib/test.hoon`
  and the marks are tied to the ship's kelvin.
- **`%test` returns only a flag.** Per-test lines go to the ship's
  terminal. A failed thread's tang comes back as `[%leaf <bytes> 0]`; the
  runner decodes it into text.
- **Name sites by `+$` and `+*` as well as `++`**, or a default inside a
  mold is credited to the next arm.

## Not built yet

- **CI.** The runner needs no dojo, so a fake ship booted in Actions can
  run it. tlon-apps' `backend/run-tests.sh` boots one from a pier archive.
- **An allowlist of reviewed equivalent mutants**, keyed by arm and op,
  so they stop being re-reported.
- **More operators**: arithmetic, list operations, a deleted line.
- **Wide conjunctions that span lines.** `conjunct` now reads the wide
  `&(a b)`, `|(a b)`, `?&(…)` and `?|(…)` as well as the tall forms, but
  only when the form opens and closes on one line.
