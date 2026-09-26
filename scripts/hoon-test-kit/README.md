# hoon-test-kit

Run a Hoon app's unit suites on a running fake ship **in seconds, with no
dojo**, and check that they actually catch breaks.

- `hoon-test.sh`: syncs the libs under test, their tests and fixtures into
  a desk that holds nothing else, commits it, runs every `test-` arm over
  the pier's `conn.sock`, and prints each test's verdict (with expected and
  actual for a failure) on stdout. On auspex, 156 tests take about 7 s,
  against roughly two minutes for a commit to the app's own desk.
- `grubbery_clay.py`: for a grubbery app, rewrites each lib's grubbery
  imports (`/<`, `/&`) into clay's on the way to the test desk, so libs
  written for grubbery's builder test unchanged.
- `hoon-mutate.py`: breaks one thing at a time in those libs (a boundary,
  a guard's condition, a branch, an equality, a flag), reruns the suites,
  and reports every break that no test noticed.

[PLAYBOOK.md](PLAYBOOK.md) is the procedure: rolling this out to an app,
reading and triaging the results, and every trap we hit building it. Read
it before the first run on a new app.

## Requirements

A running fake ship, and on the machine: `bash`, `python3`, `socat`,
`rsync`, `perl`, and a vere binary. The kit only uses vere for its
`eval --jam/--cue` framing. Set `VERE=<path>`; otherwise the kit uses the
newest `vere-*-linux-x86_64` in the directory that holds the pier.

## Installing it in an app

Vendor the kit, write one config file, and set up a desk once per ship.

```sh
# from the app repo
rsync -a --delete --exclude .git ~/software/personal/hoon-test-kit/ scripts/hoon-test-kit/
git -C ~/software/personal/hoon-test-kit rev-parse --short HEAD > scripts/hoon-test-kit/.kit-version
cp scripts/hoon-test-kit/hoon-test.conf.example hoon-test.conf   # then edit it
```

Rerun the same two lines to update, then commit the vendored copy. The kit
is vendored rather than fetched so an app's tests never change under it.

Then, once per ship. In its dojo:

```
|new-desk %<app>-test
|mount %<app>-test
```

and from the repo:

```sh
scripts/hoon-test-kit/hoon-test.sh <pier> setup
```

Setup copies `lib/test.hoon` and the config's `MARKS` in from the ship's
own `%base`, so they always match its kelvin. It skips anything already
present, so it is safe to rerun.

## hoon-test.conf

At the app repo's root. `bash` sources it and `python` parses it, so it
holds plain `KEY="value"` lines only. Paths are relative to the file.

| key | meaning |
|---|---|
| `DESK` | the test desk, e.g. `auspex-test`. Never the app's own desk. |
| `LIBS` | the libs under test, space-separated, each `src` or `src=dest`. With no dest a lib lands at `lib/<name>.hoon` (for a grubbery app, at its path under `CODE`). These are what `hoon-mutate.py` mutates. List any lib they import too. |
| `DIALECT` | `clay` (default), or `grubbery` for a desk built by grubbery: its libs are translated on the way (below). |
| `CODE` | grubbery only: the code tree's root in the repo (e.g. `code`), which `/lib/...` imports are relative to. |
| `PRELUDE` | grubbery only: faces grubbery puts in every lib's subject that the libs use (e.g. `tarball`). Each becomes a `/+` at the top of every translated lib; ship a lib of that name with `FILES` (a shim of just the molds used is enough). |
| `SHIP_FILES` | optional `desk:path` entries (`grubbery:lib/nexus.hoon`) copied at setup from that desk **on the ship**, and refreshed whenever the ship's copy differs: the libs a grubbery app's code expects in its subject, at exactly the installed version. |
| `TESTS` | a directory; every `*.hoon` in it lands in `tests/lib/`. |
| `FILES` | optional fixtures, landing at the same path on the desk, or `src=dest` to move one (`code/sur/x.hoon=sur/x.hoon`). |
| `MARKS` | marks copied from `%base` at setup. Default `json mime`: a `/*` of a json file needs both. |

The kit finds the config in the current directory or the nearest one above
it. `HOON_TEST_CONF=<path>` overrides that.

## Running

```sh
scripts/hoon-test-kit/hoon-test.sh <pier>                 # every suite
scripts/hoon-test-kit/hoon-test.sh <pier> <suite> ...     # by test file name, no .hoon
NOSYNC=1 scripts/hoon-test-kit/hoon-test.sh <pier>        # commit the mount as it stands

scripts/hoon-test-kit/hoon-mutate.py <pier> --list                   # size a run first
scripts/hoon-test-kit/hoon-mutate.py <pier>                          # boundary,conjunct
scripts/hoon-test-kit/hoon-mutate.py <pier> --ops wide               # just the wide &( |( conditions
scripts/hoon-test-kit/hoon-mutate.py <pier> --live --only <fiber-arms> # judged by a running app (below)
scripts/hoon-test-kit/hoon-mutate.py <pier> --ops branch,equal,flag
scripts/hoon-test-kit/hoon-mutate.py <pier> --only arm-a,arm-b       # recheck after a fix
scripts/hoon-test-kit/hoon-mutate.py <pier> --since main              # only the arms a diff touches
```

`--since <rev>` keeps the mutants in arms that `git diff <rev>` touches in
the libs under test. On a big lib it is how the expensive ops stay
affordable: on orrery's 6,200-line lib the whole menu is about 1,400
mutants, and `--since HEAD` after one review pass was 428.

`hoon-test.sh` exit codes:

| code | meaning |
|---|---|
| 0 | every test passed |
| 1 | a test failed or crashed: the `FAILED`/`CRASHED` lines above say which, with expected and actual |
| 2 | nothing ran, or the run did not finish: the output says why |
| 3 | a lib did not build (named). The compiler's message is only on the ship's terminal: clay slogs it and answers `~`. |
| 4 | the ship did not answer. This is never a test verdict. |

`MUTANT_T=<s>` sets how long a mutant may run before it counts as a spin
(default 120). A spin can kill the ship sooner, so set it near a few
honest runs. `hoon-mutate.py` needs about 10 s **and one commit** per mutant (more for
a big lib: each mutant rebuilds the whole lib and every test file, so
orrery's 6,200 lines take about 16 s, and 15 to 60 s on a busy host), and every
commit costs the ship loom. Size a run with `--list` first, and run long
ones on a ship nothing else is building on (PLAYBOOK.md, "Look after the
ship").

## A grubbery app

Grubbery builds a desk's code itself, and its imports are not clay's:

| grubbery | on the test desk |
|---|---|
| `/<  face  /lib/a/b.hoon` | `/+  face=a-b` (ford finds `lib/a/b.hoon`) |
| `/<  *  /lib/a.hoon` | `/+  *a` |
| `/&  face  /lib/dir/` | one `/*  face-N  %mime  /lib/dir/<file>/<ext>` per file, and `face` bound to the `(axal (map @ta mime))` grubbery hands over; the files are copied along |
| `/&  face  /lib/x/f.txt` | `/*  face  %mime  /lib/x/f/txt` |
| `/<  face  ui/app.js` (relative) | resolved against the importing file's directory (`./`, `../`): a `.hoon` as above; any other file as `/*  face  %mime  /<its path>`, copied along, its extension's mark in `MARKS` |

Other runes (`/$`, `/%`), a relative `/&`, and a path that climbs out of
the code tree are refused by name, not guessed at. Set `DIALECT=grubbery`, `CODE`, and `PRELUDE` for the faces
grubbery supplies (see the calendar's `hoon-test.conf` for a whole
example). A `/&` of text files needs their marks: `MARKS="json mime txt txt-diff"`.
The first build of a lib with hundreds of `/*` imports takes a minute or
more; later runs reuse it.

## Driving a nexus's fibers

`hoon/fiber-test.hoon` runs a grubbery fiber inside a unit test. List it in
`FILES` (`scripts/hoon-test-kit/hoon/fiber-test.hoon=lib/fiber-test.hoon`),
put the nexus itself in `LIBS`, and grubbery's own libs in `SHIP_FILES`
and `PRELUDE`. Then a test starts a grub's fiber the way grubbery does,
through the nexus's `+on-file`, and reads back what it did:

```hoon
/+  *test, ft=fiber-test, tarball
/=  app  /nex/myapp/app
=/  t  %^  run:ft  a-world:ft
         ((on-file:app [/ui/requests %r1] *blot:tarball) ~)
       (request:ft ~zod & %'POST' '/apps/myapp/api/x' '{"a":1}')
(expect-eq !>([200 '{"ok":true}']) !>((status:ft t)))
```

`+run` steps the fiber the way the runtime does and answers `bowl.sig`
reads (now, our, entropy), pokes and makes, recording every dart. It stops
`%done`, `%fail`, or `%wait` on something only the test can answer (a peek,
a keen, a timer). `+feed` supplies an answer and goes on, and
`+answer-peek` answers the last peek with a view. `+run-behind` starts a
process with a real input delivered BEFORE its start kick, as grubbery
does after a reload (crash-loop rule 9), and every step runs under `mule`,
so a crashing step is a `%fail`, as grubbery makes it. `+answer-peek` answers the last peek with a view (`[%none ~]` for "no such
grub"). The `world` sets the clock, the ship, `refuse` (road prefixes a weir
refuses; a dart there gets `%veto`), and `nack` (poke marks refused on
consumption, the way a crashed, waiting fiber refuses them). Those two are
how a test checks crash handling without a ship: a refusing clock or timer
must park the fiber, never spin it. `+pokes` pulls out every poke with a
given mark, `+responses` the HTTP responses, `+status` a request's one
response. Test through `+on-file`, not internal arms: the nexus file's
product is cast to `nexus:nexus`, which hides them, and the grub's own
fiber is the boundary grubbery calls anyway.

## Mutating what only a running app exercises

A nexus's fibers are control flow around reads and writes: no unit test
reaches them, but a live route does. `hoon-mutate.py --live` deploys each
mutant to a **dev** instance and judges it by the app's own live checks,
named in `hoon-test.conf`:

| key | meaning |
|---|---|
| `LIVE_DEPLOY` | a command that deploys `$LIVE_FILE` (the raw source, which the instance builds itself) as `$LIVE_SRC` (its repo path). Exit 0 built, 3 did not build, anything else: the ship is in trouble, and the run stops. |
| `LIVE_CHECK` | a command that exercises the app. Exit 0 all pass (the mutant SURVIVED), 1 a check failed (killed), anything else: it couldn't finish, and the run stops. |

Both run from the repo root. The clean files are deployed again at the
end, however the run ends, and a ^C stops it between mutants. On a
grubbery desk, `write-text` answers only once the desk has rebuilt and
the nexus reloaded, so a deploy script can simply check the file's
`?info=1` `build.status` afterwards (`vase` means built). Auspex's
`scripts/live-deploy.sh` and `scripts/live-check.sh` are a worked example:
every route, plus mail both ways between two ships. At about 80 s a
mutant, use `--only` for the fibers you mean.

## Logging in without a dojo

```sh
ship-cookie.sh <pier> <base-url> <cookie-jar>
```

It gets the ship's `+code` over `conn.sock`, logs in, and writes a curl
cookie jar (mode 600) for route scripts. The code is never printed or
passed in argv. It refuses when `<base-url>` answers as a different ship.

## Claude Code

`skill/hoon-test-kit/SKILL.md` teaches an agent to use the kit. Install it
for every project with:

```sh
ln -s ~/software/personal/hoon-test-kit/skill/hoon-test-kit ~/.claude/skills/hoon-test-kit
```

## Origin

Built for auspex on 2026-09-25. The first mutation runs found 26 real
gaps in a suite that already had 90 tests. `auspex/docs/hoon-testing.md`
is that case study.
