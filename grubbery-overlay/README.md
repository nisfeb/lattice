# grubbery-overlay

Canonical source for the **lattice nexus** that runs inside the `%grubbery`
framework (phase 1 of `docs/grubbery-migration.md`). The nexus *must* physically
live in the `%grubbery` desk — grubbery's `sync-gub` only loads `gub/` from its
own desk — so we keep the source here, in the lattice repo under our version
control and tests, and **copy** it into a grubbery desk tree with
`scripts/sync-overlay.sh`. This survives the grubbery dev's pushes to
`gwbtc/grubbery`: re-sync after pulling.

## Layout

```
grubbery-overlay/
  lib/lattice-know.hoon        pure vault helpers — base+clay types only, no
                               grubbery types, so the SAME file compiles in a
                               desk /lib (for unit tests) and in gub/lib (for
                               the nexus). This is where the TDD'd logic lives.
  nex/lattice/app.hoon         the lattice nexus (on-load + main.sig writer)
  mar/lattice/*.hoon           marks: know-entry, know-action, know-index
  tests/lib/lattice-know.hoon  unit tests for the pure lib (run via run-tests)
```

`sync-overlay.sh` maps `lib/` → both `gub/lib/` (deployed; the nexus imports it)
and `lib/` (so desk-level `/tests` can import it), `nex|mar` → `gub/`, and
`tests/` → desk `tests/`.

## Bootstrap (instantiate the nexus)

The nexus code only runs once a directory is made carrying its `neck`. Register
it the way grubbery registers every app — one idempotent (`%fall`) row in
grubbery's own `lib/root.hoon` on-load (re-apply after pulling the dev's pushes):

```hoon
[%fall %| /apps/'lattice.lattice_app' [`[`[/lattice %app] ~ %.n ~] ~]]
```

On commit, root on-load `%make`s `/apps/lattice.lattice_app`, loads our nexus,
and materializes `ver.ud`, `main.sig`, `know/index`, `know/trash`,
`know/vault/`. The plan's alternative (a one-time `%make` dart, no root edit) is
equivalent; the row is simpler and self-heals on reload.

## Dev loop (test to the same standard as existing code)

Tested on the **~zod fakezod** with `%grubbery` installed — grubbery is a clean,
disposable harness and the nexus's real home. (We do **not** test in the
`%lattice` app desk: that pier's `%lattice` agent crash-loops its on-load when
synced over, which aborts commits. Grubbery sidesteps that entirely.)

```bash
scripts/sync-overlay.sh                      # overlay -> ~zod pier grubbery desk
scripts/mcp-zod.sh commit-desk '{"desk":"grubbery"}'   # may MCP-timeout but still
                                                       # completes; verify via test
scripts/mcp-zod.sh run-tests '{"desk":"grubbery","path":"/tests/lib/lattice-know"}'
```

Pure logic gets thorough hoon test-arms here (matching how grubbery tests its
libs and how lattice tests `lib/lattice`); the nexus fiber/io glue stays thin and
is covered by on-ship integration tests. First cold `commit-desk grubbery` is
slow (pytz tree builds); incremental commits are fast.

To upstream into grubbery proper, run `sync-overlay.sh ~/software/groundwire/grubbery/desk`
and commit that repo.
