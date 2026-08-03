# Performance review

A measured review of where lattice's time goes, taken 2026-07-28 against the tyr
harness. Every claim below was either measured directly or confirmed by reading
the running code at the cited line. The goal was raw milliseconds, not perceived
speed. UX concealment comes after this list is worked through.

## The measured layer cake

Every request to lattice pays a stack of fixed taxes before any route work runs.
Measured on tyr with serial curl sampling.

| Layer | Cost per request | How it was isolated |
|---|---|---|
| Arvo event, Eyre, event log | ~10ms | ack-only channel PUT, scry, unbound 404 |
| Gall poke machinery | ~0.9s on tyr (vere 4.6), ~0.3s on zod (vere 4.5) | trivial helm-hi poke through a channel |
| Grubbery dispatch | +0.25 to 0.4s | bare 405 vs the generic poke, on both ships |
| Lattice dispatch | +0.65s | 278-byte icon.svg vs the grubbery floor |
| Route work | +0.5s (page-tree) to +4.3s (page-save new=1) | route sampling |

Other established facts. Requests fully serialize, so 4 parallel asset GETs take
7.1s of wall clock. Disk fsync is 2ms on NVMe and is not a factor. Terminal
backpressure was tested and refuted. Nothing external polls tyr. The worker is
idle between requests, so the cost is real CPU inside the event, not queueing.

Route totals as measured. page-tree 2.3s. page-source 1.85s. page-preview 1.8s.
know-list 1.9s. page-save overwrite 3.7 to 3.9s. page-save new=1 6.1s. A cold
editor boot is six serialized requests, roughly 11 seconds.

The consequence that ranks everything below: **eliminating one request saves
~1.8s. No byte-level or render-level optimization competes with that.** Request
count first, darts per request second, route CPU third.

## Tier 1: client request elimination

Pure JS changes in `ui-app/`. Biggest wins, no hoon required.

1. **Asset caching and inlining.** `index.html` loads css, icon, prism, and js as
   four serialized requests, and app.js plus app.css are served `no-cache` with no
   ETag (headers set in `app.hoon:74` area). Inline app.css and the icon into the
   HTML, and give app.js and prism.js versioned URLs with long max-age. Cold boot
   drops from 6 requests (~11s) to 2 (~4.1s). `ui-app/index.html:7`.
2. **Register the service worker.** One exists at `app.hoon:4739` but the editor
   page never registers it and it caches almost nothing. With it, a warm boot
   skips HTML, css, js, prism, and icon entirely, leaving only page-tree on the
   network. Roughly 5 to 9s off every warm boot. The single biggest boot lever.
3. **localStorage snapshot of the tree and last-open page.** Paint instantly from
   the snapshot, reconcile when the ship answers. Removes the remaining 2.3 to
   4.2s from the perceived boot path. `ui-app/app.js:1151`.
4. **Stop the openPage fan-out.** Opening a page fires page-source plus history,
   backlinks, preview, and errors, all serialized (`app.js:243`, `app.js:804`).
   Fetch history and backlinks lazily when their panel opens, and fold the
   rendered preview into the page-source response. Page open drops from 4-5
   requests (~7.3s) to 1-2 (~1.9s).
5. **Fix the autosave pipeline.** Three compounding bugs. There is no in-flight
   guard, so overlapping saves pile up on the serialized pier (`app.js:318`).
   Every save self-echoes through the SSE beacon, triggering a page-tree plus
   page-source refetch of content the client just wrote, ~4.2s wasted per save
   (`app.js:944`). And preview POSTs fire while the pane is hidden on mobile
   (`app.js:534`). A typing pause currently costs ~9.7s of pier time. Guard,
   tag own saves, and skip hidden previews to cut it to ~3.7s.
6. **Patch locally instead of refetching.** Share buttons refetch the whole tree
   (~2.3s, `app.js:587`). Delete refetches the tree (~2.3s, `app.js:624`).
   Tag/untag costs 3 requests where 1 suffices (~3.7s, `app.js:1069`). Knowledge
   save/delete/move refetch lists they can patch (~1.9 to 3.7s, `app.js:1101`).
   Template creation refetches the tree then runs the full open chain
   (`app.js:361`). Upload calls folder-new for directories that already exist
   (~1.8s each, `app.js:666`).
7. **Server-side move route.** Rename is 8 serial requests today, roughly 13 to
   19s (`app.js:733`). A folder move is 3 requests per page plus one per
   subfolder, which is ~70s for ten pages (`app.js:753`). One `page-move` route
   plus local tree patching collapses either to a single request.

## Tier 2: lattice nexus dart diet

Each fiber dart round-trips through the agent at roughly 0.15 to 0.2s. The
nexus spends them freely. All in `grubbery-overlay/nex/lattice/app.hoon`.

8. **page-tree re-peeks every page twice** after a deep peek that already
   returned everything (`app.hoon:3129`). ~0.4s per page per request, so the
   route degrades linearly as pages accumulate. At 20 pages this alone is ~10s.
   Highest-priority nexus fix.
9. **Dead existence peeks on the save path.** put-file peeks before %over, which
   already creates-or-overwrites (`app.hoon:5567`). make-page probes cmd and
   deps on every overwrite (`app.hoon:1950`). page-save peeks existence when
   only new=1 uses the answer (`app.hoon:930`). Together ~1 to 1.6s per save.
10. **Responses relay through main.sig** instead of poking Eyre directly,
    ~0.2s on every route (`app.hoon:373`).
11. **read-page-body does a bowl-our round trip** when callers already hold
    `our`, ~0.2s per reader view (`app.hoon:3814`).
12. **know-read hydrates the whole vault to serve one entry** (`app.hoon:524`).
    Fine on the harness, linear degradation on the real ricsul store.
13. **page-save recompiles and respawns the evaluator in-event**, ~1.5 to 2s of
    the 3.7s overwrite (`app.hoon:255`). Most of it is the ~12 respawn darts.
    Skip the respawn when the kind is unchanged and the compile succeeded.
14. **read-recent hydrates every page's full body to pick the 10 newest**
    (`app.hoon:1855`). Use metadata-only born. Dominates home load at 50+ pages.
15. **unwrap-content runs ream+slap per page just to unquote a cord**
    (`app.hoon:4881`). A linear unescape is microseconds.
16. **Rendering is uncached.** Markdown and gemtext re-render from scratch on
    every GET while the data grub revision sits unused as a cache key
    (`app.hoon:4443`). Caching also shrinks every renderer quadratic below to
    once-per-save instead of once-per-request.

## Tier 3: grubbery framework fixes (upstream PR candidates)

These are the 1.15 to 1.6s floor. All in the running desk at
`software/tyr/grubbery/`. Each is a separate upstreamable fix, same as the six
PRs already merged.

17. **find-nearest-nexus materializes the entire app subtree per request**
    (`app/grubbery.hoon:2609`). Every request spawns a fiber whose neck lookup
    walks ancestors with peek-ball-now, hydrating every grub in the lattice
    subtree, plus a `!<(nexus:nexus ...)` nest against the whole compiled core.
    The neck is already stored in tree jects (`lib/nexus.hoon:477`). Reading it
    directly is O(depth) map gets. Est. 200 to 400ms per request, growing with
    tree size.
18. **notify diffs the entire born tree on every save-file, 4 to 5 times per
    request** (`lib/nexus.hoon:1037`). No pointer-equality short-circuit exists,
    and born includes the mirrored clay desks. A one-line `?: =(old new)` prune
    fixes most of it. Est. 100 to 300ms per request, multiplied on saves.
19. **The marc core is re-extracted via `!<` on every grub read**
    (`app/grubbery.hoon:1488`, also 1366, 1408, 3859). Cache the extraction
    keyed by build ckey. Est. 100 to 300ms per request.
20. **Request/response payloads are jam-hashed twice and mark-clammed with a
    guaranteed cache miss** (`app/grubbery.hoon:1360`). Est. 50 to 200ms,
    growing with body size.
21. **Every request creates, validates, saves, and destroys a versioned request
    grub, and the response threads two extra fiber hops**
    (`lib/fiberio.hoon:1543`). Est. 150 to 300ms per request.
22. **gc-vale-cache rebuilds the whole validation cache map on every record**
    (`app/grubbery.hoon:4286`). Est. 40 to 150ms, unbounded growth.

One verified non-finding worth recording: there is no timer-coupled dispatch.
The floor is pure CPU, so client-side parallelism and HTTP/2 buy nothing until
these pipelines shrink.

## Tier 4: renderer quadratics (DoS class, fix regardless of speed)

The wikilinkify and inline-scanner quadratics fixed earlier had siblings. All
are per-request costs on the unauthenticated clearweb path, the same class that
once wedged tyr for hours. Normal documents are fine. Adversarial ones are not,
and clearweb bodies have no size cap.

23. **Image branch `![` has no scan cap and no no-set guard**, the exact hole
    the link fix closed for `[[` (`lib/lattice-md.hoon:179`).
24. **List rendering welds each `<li>` onto a growing accumulator**
    (`lib/lattice-md.hoon:567`).
25. **Table cells indexed via gulf+snag, O(columns squared) per row**
    (`lib/lattice-md.hoon:447`).
26. **sub-foot-refs runs an uncapped find per `[^` and a full pass even with
    zero footnotes** (`lib/lattice-md.hoon:314`).
27. **Nested blockquotes strip one `>` per full re-render pass**
    (`lib/lattice-md.hoon:482`).
28. **render-gmi welds onto a growing accumulator, quadratic in document size**
    (`app.hoon:4806`).

## Tier 5: below grubbery

The ~0.9s gall-poke cost on tyr is beneath grubbery's code and caps everything
above. Three cheap experiments before accepting it:

- Measure the floor on ricsul with one curl before assuming it shares tyr's.
  Different machine, different vere, different state.
- A/B vere 4.5 vs 4.6 on tyr. zod on 4.5 pokes 3x faster than tyr on 4.6 on
  the same machine, though ship state is a confound.
- Try a larger persistent memo cache (`--keep-cache-limit`). The serf runs the
  50000-entry default, which the grubbery build graph may thrash.

## Client CPU (no pier cost, mobile feel)

- Full-document Prism re-highlight plus innerHTML swap per keystroke
  (`app.js:100`). Debounce highlight separately from the dirty flag.
- Full tree-pane DOM rebuild on every selection change (`app.js:126`).
- Autocomplete caret mirror copies the full document prefix per keystroke while
  open, forcing layout (`app.js:446`).

## What the end state looks like

With tiers 1 and 2 done: warm editor boot goes from ~11s to one page-tree
request, and to instant perceived paint with the snapshot. Page open goes from
~7.3s to ~1.9s. A typing pause goes from ~9.7s of pier occupancy to ~3.7s, and
the save itself toward ~2.5s. With tier 3 landed upstream, the per-request
floor on tyr drops from ~1.8s toward ~1.1s, bounded below by the vere-level
poke cost until tier 5 is understood.

Method note: 65 raw findings from a 6-lens review were deduplicated to 48 and
adversarially verified against the running code. 44 confirmed, 4 partial with
corrected estimates above, 0 refuted. Full verdicts with mechanism and fix
sketches live in the review transcript.

## Measured results (tyr, same method as the baselines)

After tiers 1, 2 and 4 landed in lattice, plus all seven framework fixes
(upstream PRs gwbtc/grubbery #20 through #24):

| Route | Baseline | After | Change |
|---|---|---|---|
| Lattice static floor (icon.svg) | 1.80s | 0.78s | -57% |
| page-tree | 2.31s | 0.83s | -64% |
| Page open (source + preview) | ~3.7s, 2 requests | 0.82s, 1 request | -78% |
| page-save overwrite | 3.70s | 1.30s | -65% |
| Grubbery bare 405 | 1.15s | 0.20s | -83% |

The lattice floor now sits on the ~0.75s tyr gall-poke bound (tier 5), so
further request-level gains on this harness need the vere-level experiments.
Request-count wins stack on top: warm editor boot is one page-tree request
after the service worker installs, page open is one request, saves no longer
echo, and a rename is one request. The tier-3 state bump (%0 to %1: marcs,
nexi, transient eyre conns) migrated live on a populated pier.

## Addendum 2026-07-30: regression scare, two refutations, a production number

Re-measured after the obelisk in-process port, the browser-history feature and
the bucket index landed. Serial curl on tyr read 1.1-1.6s for the icon floor
against the review's 0.78s, an apparent ~0.5s regression. Investigated by
live A/B on the harness (desk-commit an older app.hoon, measure, restore).

What the experiments established:

- **Grub count does not tax the floor.** With all 256 /idx/b bucket grubs
  freshly rebuilt vs the index empty: no measurable difference. The
  permanent-fiber-slot ceiling is about memory, not per-request time.
- **Compiled-core size does not tax the floor.** app.hoon padded with 3.000
  dead arms (7.069 -> 10.073 lines, desk v204): no measurable difference. No
  surviving per-request nest against the whole core.
- **The apparent regression tracks machine load, not code.** An early rollback
  of the bucket-index commit looked ~0.2s faster, but later same-code samples
  drifted to the same values as background load fell (load avg 1.3 -> 0.8,
  several active sessions and builds on this box). The 0.78s baseline was
  taken on an idle machine. tyr floors are only comparable idle. Interleave
  A/B samples in time before believing any delta under ~0.3s.
- **Production is fine.** ~ricsul-bilwyt (urbit.sneagan.com, idle host)
  serves the icon floor in 0.51-0.88s over TLS and a real WAN, at the
  review-era tyr floor. User-felt latency there is still bounded by the
  tier-5 poke cost, not by anything that landed since.

No code fix warranted. The open levers stand: tier-5 experiments (vere 4.5
vs 4.6, --keep-cache-limit), and one new tier-1 item:

29. **Uploads pay one page-save per file, serialized.** A 20-file drop is
    ~20 requests. The bucket-index rebuild already demonstrates the fix
    shape: one request carrying N files, written as ONE bole (one %make
    dart, one tree hash), plus local tree patching in the client. Collapses
    a folder upload to a single request. Hoon-side. The evaluator-respawn
    caveats in +instantiate-template do not apply to plain content kinds.

---

## 2026-07-31: desktop boot and file toggling

sneagan: "5 seconds from first click until the editor is loaded and 1 second
or more toggling between files even if the file was already opened."
Measured against ~ricsul-bilwyt (urbit.sneagan.com) from the laptop.

**The binding constraint is request COUNT, not bytes.**

| probe | ttfb | ship-side |
|---|---|---|
| ping RTT | 34ms | n/a |
| `/~/name` (plain eyre, 14 bytes) | 150ms | ~115ms |
| `/apps/lattice/icon.svg` (870 hardcoded bytes) | ~445ms | ~410ms |
| `/apps/lattice/app/app.js` (98.8KB) | 567ms | ~410ms + ~100ms transfer |

Size is irrelevant. The floor is per-request. And **the pier serializes**: six
requests in parallel measured 2.62s against 2.75s in series, so fetching wider
buys nothing. ~300ms of each lattice request is our own per-request fiber
dispatch, not Urbit. `icon.svg` is a compile-time constant returned before the
auth gate and before any peek, yet costs 3x a plain eyre route. That last item
is the highest-leverage number in the system and is deliberately NOT addressed
here (it is grubbery-side surgery). Everything below reduces the count instead.

Cold editor load was ~12 serialized requests (reader home, `/app` doc,
prism.js, app.js, manifest, icon-192, sw.js, share-groups, shared-with-me,
page-tree, legacy-status, page-source). 12 x ~450ms = the reported 5s.
Toggling was 1-2 requests because `openPage` had no body cache at all and
localStorage held exactly one page.

Fixed, in descending order of payoff:

30. **The desktop bridge bound an ephemeral port.** `TcpListener::bind(("127.
    0.0.1", 0))` gave every launch a different port, hence a different web
    ORIGIN, hence an empty service-worker cache and empty localStorage every
    single start. The desktop could never reuse anything and never got
    `bootSnap()`'s paint-from-snapshot. That is precisely why it felt slower
    than the same UI in a browser, where the origin is stable. Now a
    deterministic port (41863, probing a 16-wide range), and the listener is
    re-pointed rather than rebound when the ship changes.
31. **The app opened on the reader.** Reaching the editor was a SECOND full
    document load (16KB shell + 124KB of JS), so "first click" cost a whole
    page load. The desktop now opens `/apps/lattice/app` directly. `urb://`
    links still route to the reader through the navigation guard.
32. **`page-tree` replaced by `page-dump` on boot.** The dump returns the same
    nodes PLUS every page body from ONE deep peek, and measured FASTER than
    page-tree (0.95s vs 1.16s, since page-tree re-peeks each code grub). Those
    bodies are what make a toggle free. No hoon change was needed. The route
    already existed for the FUSE client.
33. **`openPage` now has three tiers.** Cached render -> 0 requests; body from
    the dump -> paint the editor immediately and fetch only to fill `share`
    and the preview; nothing -> as before. Re-opening a page costs nothing.
34. **share-groups and shared-with-me deferred.** Issued at parse time they
    put two round-trips AHEAD of the tree on a serialized pier. Neither is
    needed to read or edit. Boot calls them once the editor is usable.
35. **Shell revalidation deferred 5s in the service worker.** The shell and
    app.js are `no-cache`, so a warm boot still re-fetched both. Served from
    cache at 0ms, they nonetheless queued ahead of `page-dump`. On a cache hit
    the revalidation is now held behind a `waitUntil` timer, so page-dump wins
    the pier. Verified: it moved from 3rd to 2nd request, with both shell
    revalidations landing last.

Net on a warm desktop launch: the critical path is ONE request (page-dump),
with the tree and last page painted from localStorage before it. Re-opening a
page is zero requests.

Cache invalidation is rev-based, and pruning only on FORWARD movement matters.
Comparing revs for mere inequality evicted good entries whenever the dump
trailed page-source by one revision, which it does right after a write (the
evaluator settles after the writer). That bug showed up as a flaky check
before it showed up as a slow toggle.

Checked by `scripts/ui-perf.mjs` (headless Chromium, asserts request COUNTS
because wall-clock on a shared harness ship is noise). `scripts/ui-matrix.mjs`
still passes. Both run against tyr, never production.

Still open: item 29 (batch upload), the ~300ms fiber dispatch above, and
URL-versioning the bundle so app.js could be `immutable` and skip
revalidation entirely rather than merely deferring it.
