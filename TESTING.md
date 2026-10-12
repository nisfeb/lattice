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
| lattice | a dev desk at `/apps/shell.shell/desks/lattice.desk`, the same path as on ricsul, following `/lattice-dev/code` in the ball |
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
afterwards:

```sh
scripts/hoon-test-kit/ship-cookie.sh ~/fleet/piers/mec http://localhost:8120 /tmp/mec.jar
awk -F'\t' '$6 ~ /^urbauth-/ {print $6"="$7}' /tmp/mec.jar > /tmp/mec.cookie
LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec.cookie scripts/api-matrix.sh
$F reset lattice-dev compiled
```

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
desk. On a fresh ship lattice tries to install `%obelisk` from
`~dister-nomryg-nilref`; a fake ship cannot reach it and nothing depends on
it.

## Looking inside with u

```sh
$U lattice-dev our
$U lattice-dev kids /lattice-dev/code                 # files in a ball dir
$U lattice-dev file /apps/shell.shell/desks/lattice.desk/version.json
$U lattice-dev tree /apps/shell.shell/desks/lattice.desk/desk/data
```

`u` guards its subcommands. A raw `.^` in an expression that misses kills
every thread on the ship: check a path with `kids` first. Never point u,
the fleet commands or these scripts at a ship outside `lattice-dev`.
