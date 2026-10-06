# Logging: what lattice prints, and what it records

Lattice follows the Groundwire Foundation's logging policy (draft of
2026-10-01): a healthy ship prints nothing. A line on the console means
something left its normal range and a person can act on it. Anything else
is state that can be read back, or sits behind the debug switch.

## Levels

Every line goes through `+say` in `nex/lattice/app.hoon`, which takes a level.
`scripts/quiet-check.py` (run in CI) fails on any other `~&`, `~?`, `slog` or
`%slog`.

| level | marker | lattice uses it for |
|---|---|---|
| 3 | `>>>` | nothing. A road lattice needs that is refused is the kernel's one `>>>` line (below) |
| 2 | `>>` | a kind of fiber started crashing and retries by itself; a request crashed; the old app's data could not be carried |
| 1 | `>` | carrying the old app's data; installing `%obelisk` unattended |
| — | none | nothing. Debug output would use it, behind `+dbg` |

Each line names its source first (`lattice /main.sig: …`), says what to do,
and puts the variable part (an instance path, a key) last. Lattice prints
no traces: the kernel prints a crashed fiber's trace itself (below), so a
lattice line points at the record that keeps it.

## Records

- **`/rise.json`** (nexus root): the crash record. One row per fiber: kind,
  count, last crash, when it retries, whether its timer was granted, and
  the first 24 lines of its latest trace. A kind of fiber prints once when
  it starts crashing. A bad build that takes down every page fiber is one
  line. Nothing prints while a fiber retries, or when its clock or timer is
  refused. A reload prunes this record.
- **`/faults.json`** (nexus root, kept across reloads): one row per
  condition: `what`, `n`, `first_ms`, `last_ms`, and `trace` where there is
  one. A row prints at most once,
  when its condition begins (new, or two quiet hours since it last
  happened). Rows:
  - `carry-road`: reading the old app to carry its data is refused (`>>`).
    Cleared when the carry can read it.
  - `registry-road`, `public-grant`, `public-group`: published pages stay
    on this ship. These permissions are optional, so they are recorded and
    never printed. Cleared when the grant goes through.
  - `refused`: the writer's last refused action (a bad key, a missing note,
    a target that exists). A poke is acked before the writer reads it, so
    this row is the only place the reason can go. Recorded, never printed.
  - `request-crash`: a request crashed and was answered 503 (`>>`).
    `request-refused` is the same while a fiber waits after its own crash.
    That crash has already printed, so it is recorded silently.

Read either record with the explorer:
`GET /grubbery/ball/<lattice instance>/faults.json?raw=1`. On grubbery develop's kernel that answers 307 to `/grubbery/api/file/<path>`, so follow redirects (`curl -L`).

A failure that has a requester goes back to them, not to the console. A
search reindex that cannot write the index answers 500 with the reason, and
Settings shows it.

## Debug

`++  dbg  ^-(? |)` is off in every release. The mirror's trace grubs
(`/mirror/tr`, `+mirror-trace`) are written only when it is on. Turn it on
only in a local test build. A commit that turns it on does not merge.

## What the kernel says (grubbery `dist/single-release`, 5ae72f0)

- A refusal lattice handles softly (its probes of optional roads) prints
  nothing.
- A refused road a fiber needs parks it, and the kernel prints one line for
  the app while any of its fibers is parked: `>>> grubbery: <app> is parked:
  it may not <poke|peek|make> <road>; grant it at /apps/grubbery/permits,
  then reload`. That is the one line for it, so lattice adds none.
- A fiber that crashes prints `%fiber-crash <path>` and its trace, with no
  marker, on every crash, retries included. Lattice cannot hold that back,
  so it does not repeat the trace. Kernels before 5ae72f0 also print
  `>>> [%process-dart-vetoed …]` for every soft refusal.

## Not ours

- `lib/lattice-quiz.hoon` is a vendored property-testing library. It prints a
  refuted law's counterexample during a test run. Only `tests/` import it.
