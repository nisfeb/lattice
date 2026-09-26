# Hoon testing

The pure libs' suites (`tests/lib/`) run on a fake ship through the vendored
[hoon-test-kit](../scripts/hoon-test-kit/README.md), configured by
`hoon-test.conf`. Read the kit's `PLAYBOOK.md` before a mutation run.

```sh
scripts/hoon-test-kit/hoon-test.sh <pier>                    # every suite, ~13 s
MUTANT_T=30 DOJO_PANE=<pane> scripts/hoon-test-kit/hoon-mutate.py <pier> --only <arms>
```

Test desk: `%lattice-test` on `~feb` (set up 2026-09-26).

## First mutation pass (boundary, conjunct), 2026-09-26

**Set `MUTANT_T=30`.** A mutant here runs in about 7 s. Four `~feb` deaths
(`loom: external fault`) each came on or after a mutant that spun: the kit's
default 120 s let the spin kill the ship first. With 30 s, two spins were
interrupted and the ship lived. These arms have a mutant that spins or kills
the ship; mutate them only with `MUTANT_T=30`, one arm at a time:
`parse-num` (clip), `block-start` and `rb` (md), `render-gmi` (gmi),
`check-verbose` (quiz).

Found and fixed: `lattice-clip`'s `+unent-one` decoded numeric entities past
U+10FFFF (`&#1999999;`) into bytes that aren't valid UTF-8. `+parse-num`'s
200.000 cap only bounds work; the codepoint check now decides.

Closed: 40 tests, mostly one case per clause of a `|(`/`&(`. The suites
matched substrings, so a clause that a sibling clause also satisfied
(`<b>` for `<i>`, `https://` for `http://`, a trailing newline) was never
tested alone.

| lib | state |
|---|---|
| clip | done. 6 equivalent: `?=(^ acc)` before a flushed space ×3 (`+squeeze` trims both ends), `'>'` in `+attr` (the tag's text ends before any `>`), `+parse-num`'s `gth` (cost bound). 1 accepted: `+lead-strip` `lth->lte` 33 also strips `!`, which only refuses `!javascript:`, a link no browser runs |
| gmi | done except `render-gmi`'s `lst` mutant (spins) |
| share, urls, pub, fuzz, know, sign | done. urls `+strip-prefix` `gte` is a fast path (equivalent) |
| md | **open**: 32 survivors in the block parser (tables, lists, quotes, footnote refs, `+wiki-name-len`), and the arms after `rb` unrun |
| pg | **open**: `+live-location` has 23 survivors against one flow test; `+folder-index` 2 |
| quiz | test tooling, not triaged |

## Not yet applied from the playbook

Every fiber in `code/nex/lattice/app.hoon` restarts through `rise-wait:io`.
After a crash it swallows the first real poke and leaves unpoked fibers
(`/ui/main`, the mirror, `sub/pages`, the fs port, page eval) down until a
reload. The playbook's "Never ship a crash loop" says port calendar's
`+rise-later`, and never release it without tests 7 and 8.
