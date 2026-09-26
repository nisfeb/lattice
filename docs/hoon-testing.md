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
`check-verbose` (quiz). `MUTANT_T` does not save the ship from the first
three: `block-start` killed it at 30 s. Leave them out of every run.

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
| md | done, 19 tests. 5 equivalent: the autolink's `'<'` and `"<https"` checks repeat `"<http"`, its no-set guard and the blank-row check in `+take-table-rows` only save work, `+render-footnotes` sorts distinct numbers, `+rb`'s heading `gth` sees n>0 always, `+cap-quote-depth` at exactly 32 rewrites to itself, `+safe-url` compares two different bytes' positions. 3 accepted: `+take-task` at exactly 4 bytes, `+join-para` on a line of two spaces, `+find-cap`'s cost cap. **Unmeasured**: `+block-start` and `+rb` (their mutants kill the ship) |
| pg | done, 7 tests. 7 equivalent: the 1.440-minute cap gives 1.440 either way; state has 0 or 5 fields, never 4, so the `(lent next)` checks at 363, 367 and 570 can't differ, and `live` implies 5 |
| quiz | test tooling, not triaged |

## Crash handling (playbook: "Never ship a crash loop"), 2026-09-26

Every long-lived fiber restarted through `rise-wait:io`, which took the
first poke after a crash as its restart signal and dropped it (to the
writer, a user's save), and left fibers nobody pokes (`/ui/main`, the
mirror, a sub, a page, the fs port) down until a reload. They now use
`+rise-later`, ported from calendar: a wait of 1, 2, 4 up to 60 minutes,
pokes refused while waiting, a soft clock and timer, and the record in
`/rise.json` at the nexus root. A crashed request fiber answers 503
(`+crash-503`) instead of parking with the browser waiting, which every
write would otherwise do while the writer waits.

Tested on `~wex` (stock kernel; the app's own messages acted):

| test | result |
|---|---|
| 7: upgrade over the existing data, 3 reloads, then 3 more with 40 writes in flight | route 200 throughout, 40/40 writes 200, no crash record |
| injected crash in the mirror | record n=2, 3 at 2 and 4 minute gaps; CPU near 0; "again (3 times running)" |
| 8: `/sys/behn/` refused | crashed fibers print "no timer (weir?)" and park; CPU near 0 |
| 8: `/sys/bowl.sig` refused as well | every fiber parks: the route dies, the explorer answers, CPU near 0 |
| injected writer crash, then a write | 503 in 0.6 s; reads still 200; refused pokes don't count as crashes |

Seen along the way, and fixed after: the fs port's `%keep` on
`/sys/lick/lattice/fs/in` was vetoed on some reloads (2 of about 7),
because grubbery weighs a keep as a read and `/sys/lick/` was declared only
as a poke. It is now in `+weir-json`'s peek list too, which puts it in
`ask.json`, so subscribers get a consent prompt for it on that release.
With it granted on `~wex`: 8 reloads, no fs port failure, and
`lattice-fs` mounted over lick and read pages. `scripts/weir-check.py`
did not catch it: it matches roads, not their category.
