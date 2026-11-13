# Testing lattice

Lattice is tested on its own fleet set from
[hoon-development](https://github.com/nisfeb/hoon-development), never on
`~ricsul-bilwyt`. Pushing to `main` is a deploy (docs/releasing.md), so
test here first.

| | |
|---|---|
| set | `lattice-dev` (in hoon-development's `fleet/sets.conf`) |
| ship | `~mec`, fake, pier `~/fleet/piers/mec` |
| HTTP | http://localhost:8120 (loopback ames in `~/fleet/piers/mec/.http.ports`) |
| dojo | `tmux attach -t fleet`, window `mec` |
| grubbery | the dev platform's pin (hoon-development `platform/grubbery.ref`) |
| lattice | a dev desk at `/apps/shell/desks/lattice.desk`, the same path as on ricsul, following `/lattice-dev/code` in the ball |
| test desk | `%lattice-test`, mounted, set up for the kit |

Below, `F=~/software/personal/hoon-development/fleet/fleet` and
`U=~/software/personal/hoon-development/bridge/u`. Set `FLEET_WHO` to
your session's name so claims know who is asking.

## Reset

```sh
$F reset lattice-dev compiled   # lattice installed and approved, test desk set up: ~7 s
$F reset lattice-dev            # golden: grubbery and %unix, no lattice
$F ls                           # is ~mec up?
$F up lattice-dev               # restart it from its event log (vere 4.6 sometimes segfaults)
```

Start every test from `compiled`. Refresh it after a deploy that tests
should start from: `$F snap lattice-dev compiled`. For a throwaway point,
`$F --fast snap lattice-dev before-x` takes seconds.

## Offline tests (no ship)

```sh
scripts/offline-tests.sh          # every suite but lattice-sign, ~40 s
scripts/offline-tests.sh md pg    # by name
```

They run the suites in `tests/lib` through `vere eval` with the kit's
`offline-test.py`, taking `test.hoon` from the dev platform's `%base`.
`lattice-sign` needs `cric:crypto`, which `vere eval`'s zuse lacks, so it
runs on the ship only. The ship run is the verdict.

## Does code/ build (CI's hoon-build)

`scripts/hoon-build.sh base DIR` boots a private fake ~zod into `DIR/zod` from `PILL` and installs grubbery from `GRUBBERY` (a `desk/` directory), then stops it. `scripts/hoon-build.sh check DIR` starts that pier, dev-deploys `code/` with `--add`, and `hoon-build-wait.py` asks every `.hoon` file's `?info=1` in the desk until each reports `build.status`. Anything but `vase`, or a bang on the lattice instance, fails with grubbery's error. Both need `VERE` and socat; `PORT` defaults to 8199. Copy the base pier before a check: a check changes it. CI caches the base pier on vere, grubbery's commit and the script, so a warm run is the check alone.

## Ship tests

```sh
export VERE=~/software/vere-v4.6-linux-x86_64   # fleet piers have no vere beside them
scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec            # every suite, ~5 s
scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec lattice-md # one suite
```

`hoon-test.conf` names the libs and suites. On a fresh set (golden, or a
rebuilt pier) make the test desk once: `|new-desk %lattice-test` and
`|mount %lattice-test` in the dojo, then
`scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec setup`.

The HTTP matrices run against the ship too. They write data, so reset
afterwards. Every suite needs `LATTICE_URL` and `LATTICE_COOKIE` and
exits 2 without them: there is no default ship (the old default,
localhost:8080, was the owner's own dev ship).

```sh
scripts/hoon-test-kit/ship-cookie.sh ~/fleet/piers/mec http://localhost:8120 /tmp/mec.jar
awk -F'\t' '$6 ~ /^urbauth-/ {print $6"="$7}' /tmp/mec.jar > /tmp/mec.cookie
LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec.cookie scripts/api-matrix.sh
$F reset lattice-dev compiled
```

Passes (docs/superpowers/specs/2026-11-11-passes-design.md) have three suites, on one ship. `scripts/pass-matrix.sh` (about three minutes) works the seller's routes and forms, gifts, the read group, a lapse, refunds and the card routes with no real Stripe key. `scripts/pass-pay.sh` (about four minutes) pays for a pass on the open web against a local nutshell test mint, never a real one, set up as `../furum/docs/hoon-testing.md` says (port 3338); point `CASHU_VENV` at its virtualenv. `scripts/pass-rails.sh` (about a minute) pays by card and in bitcoin against `scripts/fake-rails.py`, which stands in for Stripe and BTCPay. The real services need the owner's test keys and are not in any suite.

## Release gate

`node scripts/gate.mjs` is the whole release check in about a quarter of an hour, and it never touches ~mec. It deploys this checkout with `dev-deploy.py --approve` to its own base ship (fleet set `lattice-gate`, ~dep on 8150, claimed as `gate-<pid>-<starttime>`, one owner per run, or the name `--as` gives, and released at the end; a set another live gate holds is waited for, up to `GATE_WAIT` seconds, and a claim or clones left by a gate that is gone are taken over and dropped, see `scripts/lib/gate-claim.mjs`), waits for the desk to hold the deploy's version stamp, the instance's bang to read null and the new app.js to be served, then runs `fleet --fast snap ~dep gate` and `fleet clone dep 4 gate`. The ship-bound suites (every browser `ui-*.mjs` but ui-manager and ui-links, `job-check.py`, `big-page-check.py`, `dirshare-check.py` and the Hoon suites) are handed to the four clones longest first, by the times in `scripts/gate-times.json` (`--record` rewrites them), while the pure ui suites, ui-manager, `offline-tests.sh`, code-closure, bill-check, depth-check, quiet-check, onload-check, weir-check, desktop-commands, kind-parity, the parse checks and the app.js freshness check run locally. Each lane's serf is pinned to a performance core of its own (CPUs 0, 2, 4 and 6; `GATE_PIN=0` turns it off) and everything else runs on the other CPUs. A ship suite that fails is run once more, alone, on a fresh clone after the others are dropped; if it passes there it is reported as flaky, which fails the gate only with `--strict`. It prints one table of suite, lane, seconds and result, exits 1 on any failure, keeps the logs of the last ten runs under `~/.cache/lattice-gate/<run>` (`LATTICE_SCRATCH`, `GATE_KEEP_RUNS`), and drops the clones on the way out, Ctrl+C included. Clones run in their own network namespaces and cannot reach each other, so the two-ship suites (ui-links, two-ship-links.sh, two-ship-save.sh, two-ship-comments.sh, two-ship-notify.sh, two-ship-dirshare.py, two-ship-share-race.sh, two-ship-group-share.sh, two-ship-hand-share.sh, two-ship-invariants.sh, two-ship-republish.sh, two-ship-ban.sh, two-ship-access-request.sh) run only with `--two-ship SET`, which uses the base ship as A and the lattice ship of fleet set SET as B (`--two-ship lattice-gate-peer`, ~wep on 8151, set up the same way as ~dep), links them with a `|hi` each way, and drops the idle lanes while they run. stall-check takes about an hour and runs only with `--stall`, on a fifth clone of its own. A clone starts from a fresh vault, so a suite must make the pages it needs (`seed` in `lib/harness.mjs`) rather than find them, and must wait on the event it needs (`waitFor`, `swControlled`) rather than sleep. The one-time setup of ~dep was `PLATFORM_SET=lattice-gate platform/build.sh` in hoon-development, `dev-deploy.py http://localhost:8150 <jar> --add --approve`, the test desk as above, and `fleet snap lattice-gate lattice`.

### The fast loop

For one suite while you work, `node scripts/gate.mjs --only ui-shell.mjs`. `--only` now limits the local checks too (add `--local` to run them as well), and the lanes default to no more than the suites asked for, so one suite gets one clone.

The gate snapshot carries the deploy manifest (`<pier>/.lattice-deploy.json`, the sha256 of every file of `code/` it holds) and the session cookie minted before it was taken. So:

- when the snapshot already holds this checkout's `code/`, the base ship is not booted, deployed, built or snapshotted: the lane is cloned straight from the snapshot and the suite starts;
- when only the client differs (files of `code/nex/lattice/ui-app/`), the lanes are cloned from the snapshot and the changed files are written straight into each lane's `app/` grubs, then checked against what the lane serves. The nexus embeds those files at build time, so going through the desk costs a full rebuild of app.hoon (about three minutes) for a one-line JS change; the hot patch takes a second. It is the default with `--only` (`--hot` asks for it otherwise, `--cold` turns it off), and the lane runs the snapshot's nexus with this checkout's client, so the full gate always deploys;
- when anything else differs, `dev-deploy.py --manifest` sends only those files, with no GET per file (that GET per file was a minute of every deploy, even of two files), and the new state becomes the snapshot.

Keep the snapshot on main's latest code, so a branch's run deploys only its own diff: after a merge, run `node scripts/gate.mjs --warm` in a checkout of origin/main (deploy and snapshot, no suites). `--cold` ignores the snapshot and does the whole deploy. The run ends with a `phases:` line (base up, deploy, build until live, snapshot, clone and boot, suites, teardown) to show where the time went.

`node scripts/gate.mjs --only ui-shell.mjs`, measured 2026-11-03 (the suite itself is 100 to 160 s, by the host's load):

| phase | before | after, code unchanged | after, one ui-app JS file changed |
|---|---|---|---|
| local checks (ran beside it, all 30) | 116 s | none | none |
| base up and cookie | 14 s | none | none |
| deploy | 56 s | none | 1 s (hot patch; 170 s through the desk) |
| build until live | 14 s | none | none (16 s after the desk deploy) |
| snapshot and base down | 6 s | none | none |
| clone and boot | 5 s | 6 s | 7 s |
| teardown | 2 s | 2 s | 2 s |
| setup before the suite | 95 s | 6 s | 8 s (213 s before) |

### Keeping the machine healthy

The gate and the suites share one machine with every other session, so:

- core dumps are off for the gate, the suites and every browser, Xvfb and driver they start (`prlimit` in `lib/hygiene.mjs`, `ulimit -c 0` in `lib/hygiene.sh`), and fleet starts its ships without them too;
- scratch, logs and `TMPDIR` live under `~/.cache/lattice-gate`, never `/tmp`; only the last ten runs are kept;
- every child carries `LATTICE_TEST_OWNER` (the gate's `pid:starttime`) and a `LATTICE_TEST_TAG` of its own. When a suite ends, whatever still carries its tag is killed, even a browser in a process group of its own; at the end of the run, failure and Ctrl+C included, so is whatever carries the owner. A suite or shell suite run by hand is its own owner and does the same;
- `scripts/sweep.sh` kills what a run that died left behind: processes whose owner is gone. It matches only our marker, never a name, so other sessions' browsers, relays and Xvfb displays are left alone (`-n` lists without killing);
- the gate and the Xvfb suites refuse to start with under 10 GB free on `/` or 2 GB on `/tmp`;
- `scripts/clean-targets.sh` lists the Rust `target/` dirs of worktrees whose HEAD is merged into origin/main, and `--yes` deletes them.

## Deploying a change to ~mec

```sh
scripts/dev-deploy.py http://localhost:8120 /tmp/mec.jar
```

It writes the files of `code/` that differ into `/lattice-dev/code` and
stamps that tree's `version.json` with a dev version, which makes the desk
pull. It refuses any ship that is not on localhost. A release that adds a
road needs approving again: post the instance's `weir.json` as `granted`
to `/apps/grubbery/permits` (`approve-weir`), then
`/apps/grubbery/permits/reload`. Without `granted` the grant is empty and
lattice stops serving.

How `compiled` was made, from the golden: `dev-deploy.py ... --add` (which
also POSTs `/apps/grubbery/desks/add`), the approval above, then the test
desk.

## Looking inside with u

```sh
$U lattice-dev our
$U lattice-dev kids /lattice-dev/code                 # files in a ball dir
$U lattice-dev file /apps/shell/desks/lattice.desk/version.json
$U lattice-dev tree /apps/shell/desks/lattice.desk/desk/data
```

`u` guards its subcommands. A raw `.^` in an expression that misses kills
every thread on the ship: check a path with `kids` first. Never point u,
the fleet commands or these scripts at a ship outside `lattice-dev`.
