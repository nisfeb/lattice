export const meta = {
  name: 'review-lattice',
  description: 'Comprehensive behavioral bug review of the lattice grubbery nexus, adversarially verified',
  phases: [
    { title: 'Review', detail: 'one reviewer per behavioral dimension' },
    { title: 'Verify', detail: 'adversarially verify each high/critical finding' },
  ],
}

const ROOT = '/home/sneagan/software/personal/lattice/grubbery-overlay'

const PREAMBLE = `You are reviewing the "lattice" Urbit app: a single grubbery NEXUS (an on-load + on-file core compiled by the %grubbery gall agent). Repo root for all files: ${ROOT}/ . Read files with the Read tool at the paths/line-ranges given below.

CRITICAL FRAMING — this narrows what counts as a bug:
- The code ALREADY COMPILES and RUNS on the ~tyr harness. So compile-time errors (mull-grow, nest-fail, fuse-loop, aura mismatch, missing gaps) are OUT OF SCOPE — they cannot exist in running code. Do NOT report them.
- Style, over-engineering, naming, and "could be cleaner" are OUT OF SCOPE. A separate pass handles those.
- IN SCOPE: RUNTIME BEHAVIORAL DEFECTS only. Specifically:
  * Runtime crashes (bail): (need ~) on an empty unit, snag/slag/scag past a list's end, decrement of 0, div by zero, a ?+ / ?- with no matching case hitting an input it can receive.
  * Infinite loops or unbounded recursion at RUNTIME on some reachable input.
  * Wrong logic: wrong branch taken, off-by-one, inverted condition, wrong default, a value silently dropped or double-counted.
  * Security: XSS / HTML injection (unescaped user/page/peer content welded into served HTML), code injection (unescaped content welded into a Hoon gate that gets compiled/evaluated), urQL injection, path traversal (a user-supplied name escaping its intended directory).
  * Privacy: private ("know") or unshared content readable by an unauthenticated HTTP client or a remote ship; a %private page served over clearweb; owner-gate missing on a mutating route.
  * Resource exhaustion / DoS reachable by normal or hostile input (missing size cap on untrusted peer data, unbounded fan-out).
  * Round-trip failures: content that does not survive wrap->store->unwrap->edit, or an escaping scheme that breaks on some byte.

Hoon quick-reference so you reason correctly:
- '...' is a cord (@t). "..." is a tape (list @tD). A literal newline does NOT survive inside a single-quote cord literal built by welding; control bytes are written as \\0a-style hex in test data.
- (need u) bails if u is ~. (snag i l)/(slag i l)/(scag i l) can bail or mis-behave past the end. (sub a b) bails if b>a (no negatives).
- ?~ / ?= refine types. ?+ is a non-exhaustive switch with a default; ?- is exhaustive.
- weir = per-directory ACL {make,poke,peek}; gain = published to the Urbit namespace (peekable/subscribable by OTHER ships). A grub that is gained + has a public peek weir is world-readable over ames. "know" = private vault (gain=%.n, owner weir). "pub" = published pages (gained).
- The owner-gate: authenticated requests from the ship's owner vs. unauthenticated/foreign requests. Mutating routes and private reads must be owner-only.

For EACH real defect, report: file (repo-relative, e.g. nex/lattice/app.hoon), line (1-indexed anchor), severity, a one-sentence summary, and a CONCRETE failure_scenario — the specific input/request/state and the specific wrong output/crash/leak it produces. No hypotheticals ("could potentially"): if you cannot name a concrete triggering input, do not report it.

Severity rubric:
- critical: data loss, private-data leak, XSS/code-injection that runs attacker content, auth bypass, or a reachable ship-hang/infinite-loop.
- high: a crash (bail) on plausible input, a broken feature on common input, or reachable resource exhaustion.
- medium/low: narrow edge cases, defense-in-depth gaps. (Report them, but the run cares most about high/critical.)

Return ONLY real defects. An empty findings list is a valid, respectable answer — do not invent issues to fill it.`

const DIMENSIONS = [
  {
    key: 'paths',
    label: 'path-and-name-handling',
    focus: `Path & name handling (RECENTLY CHANGED — high risk). Read nex/lattice/app.hoon lines 3600-3660 (name-pax, valid-name, pax-of, pax-str, kind-of, mime-of, read-page-names, collect-pages), 4317-4345 (ensure-dirs, collect-entries), 2842-3010 (page-rel, read-page-body, page-dir-name), 2231-2260 (pub-path, pub-road), 2495-2510 (know-key), 2567-2600 (strip-prefix, de-urb). Look for: a user-supplied page/file name that escapes its directory (traversal via '..', leading '/', empty segments, '.'), a name that produces a malformed or ambiguous storage road, name-pax accepting something valid-name/pax-of then crash on, pax-str/spat/stab round-trip mismatches, ensure-dirs failing to create an intermediate dir, and collision between a file and a directory of the same name.`,
  },
  {
    key: 'wrap',
    label: 'content-wrap-unwrap',
    focus: `Content wrap/unwrap & typed files (RECENTLY CHANGED — high risk). Read nex/lattice/app.hoon lines 3554-3630 (content-env-pre, wrap-content, unwrap-content, content-builders, kind-of, mime-of) and 3661-3695 (edit-template, md-template, starter-for, share-btn). wrap-content escapes a body cord and welds it into a Hoon gate string "(BUILDER 'ESCAPED')" that is later COMPILED and RUN. Look for: any body byte or sequence that breaks out of the single-quote cord literal (unescaped quote, backslash, or a byte the escaper misses) — that is CODE INJECTION into a compiled gate. Check unwrap-content correctly detects the prefix and extracts builder+body for EVERY builder, that a body containing the delimiter " '" does not confuse extraction, and that round-trip (wrap then unwrap) is lossless for adversarial bodies (embedded quotes, backslashes, newlines, the literal text content-env-pre, or a fake "(md '...')" wrapper). Confirm builder can't be spoofed to an arbitrary gate.`,
  },
  {
    key: 'http-auth',
    label: 'http-routing-auth-permissions',
    focus: `HTTP routing, auth & permissions. Read nex/lattice/app.hoon lines 325-1249 (handle-request — the full route dispatch) with attention to which routes check the owner-gate vs. which serve unauthenticated. Also 1343-1398 (share-weir, heal-share-weirs, read-share), 3072-3104 (serve-asset, serve-clearweb), 3917-3946 (ensure-pub-weir, read-weir). Look for: a MUTATING route (create/delete/share/import/eval-command) reachable WITHOUT the owner-gate; a PRIVATE 'know' read or an unshared page served to an unauthenticated or foreign request; serve-clearweb serving a %private page; a route that returns owner-only data (know vault, drafts, config) on an unauthenticated path; wrong HTTP method allowed; a share downgrade/upgrade not reflected in the weir. Map each route to: does it mutate or read-private, and is it gated? Report any gap.`,
  },
  {
    key: 'eval',
    label: 'page-eval-engine',
    focus: `Page eval engine (pokes, deps, timers, flood guards). Read nex/lattice/app.hoon lines 1279-1586 (apply-eval, eval-run, view-src, arm-eval-deps, read-dep-vals, emit-pokes) and the caps at 1418-1431 (recompute-cap, rerun-gap, poke-cap, poke-budget-max) plus read-eval-seen/write-eval-seen (1443-1454). Look for: a page-to-page poke chain or dep cycle that is NOT actually bounded by the budget (off-by-one letting it exceed poke-budget-max, or budget not decremented on some path), a rapid-rerun runaway that escapes recompute-cap, a wake-timer that re-arms immediately (busy loop), poke-cap not enforced, a command seq that reprocesses or skips, or a dep whose value read can bail. Verify the flood guards actually terminate for a hostile page that pokes itself or a 2-cycle.`,
  },
  {
    key: 'markdown',
    label: 'markdown-gfm-renderer',
    focus: `Markdown/GFM renderer safety & correctness. Read the ENTIRE file lib/lattice-md.hoon (605 lines). This renders untrusted markdown (own notes AND, via the crawler, PEER pages) to HTML that is served. Look for: XSS — does it neutralize javascript:/data: URLs in links and images, strip/escape raw inline HTML, escape <>&" in text and code and in link titles/hrefs, prevent attribute-injection via crafted link text or reference labels? Also: any input (unterminated fence, deeply nested list/quote, a table with mismatched columns, a footnote referencing itself, a huge run of one char) that causes a RUNTIME crash (bail) or a non-terminating loop. Trace the footnote collection and the list/quote nesting for termination. Check that scag/slag/snag are called on general lists, not in a way that bails past the end.`,
  },
  {
    key: 'render',
    label: 'rendering-and-asset-serving',
    focus: `Rendering & asset serving (partly RECENTLY CHANGED). Read nex/lattice/app.hoon lines 3010-3135 (render-page-view, render-bare, serve-asset, serve-clearweb, page-data-html, render-shown), 3136-3350 (page-view-html, share-controls-html, page-sse-script, explore-crumbs, explore-dir-html, explore-file-html, send-raw, mark-mime), 3327-3450 (mark-mime, browse-json, send-html/view/typed, send-png), 3508-3553 (render-gmi), 3696-3854 (edit-html, edit-js, home-index-html). Look for: page NAMES or peer content welded into served HTML without escaping (XSS via a page named "<script>"), serve-asset returning the wrong content-type or serving a private page's data, render-bare's srcdoc iframe letting fragment/link clicks escape or execute, a JS/CSS asset served with a type that lets it run in the page context when it should be inert, and explore/browse listing leaking private paths. Check mark-mime maps every served kind correctly.`,
  },
  {
    key: 'federation',
    label: 'federation-and-remote',
    focus: `Federation & remote reads (UNTRUSTED peer input). Read nex/lattice/app.hoon lines 2534-2840 (parse-urb-url, referent, de-urb, en-urb, remote-road, peek-remote-wait, peek-remote-shallow-wait, take-peek-or-wake, the take-*-drain helpers), 2145-2230 (catalog-scan-peer, catalog-reconcile-peer and their loops), 2057-2096 (body-cap, manifest-max, catalog-index-page, index-remote-page), 4171-4230 (read-pub-index-remote, read-follows, read-subs). Look for: a malformed urb:// URL or peer response that crashes the parser (bail) instead of returning ~, a remote peek with no timeout that can hang the fiber, untrusted peer page bodies not capped by body-cap before the analyzer, manifest-max not actually limiting pages per peer (a hostile peer floods the catalog), a peer able to inject rows for pages it doesn't own, or remote-road building a road that peeks a peer's PRIVATE tree. Peer data is hostile; every size/count bound must actually hold.`,
  },
  {
    key: 'storage',
    label: 'storage-core-and-obelisk',
    focus: `Storage core & obelisk bridge. Read nex/lattice/app.hoon lines 3947-4160 (apply, apply-pub), 4231-4345 (apply-sub, retag, entry-road, read-entry, read-index, put-file, ensure-dirs, collect-entries), and the obelisk bridge 1590-1810 (import-item, parse-import, obelisk-exec, obelisk-query, poke-obk) plus 1989-2048 (catalog-run, catalog-init, know-reindex) and obelisk-cell-cord 1921-1988. Look for: urQL INJECTION — a knowledge key, tag, or page body welded into a urQL statement without escaping (a tag containing a quote or ; corrupts the query or injects DDL), soft-delete (trash) that loses data or resurrects deleted entries, put-file suppressing a write it should make (or vice-versa), retag dropping tags, a parse-import that crashes on malformed import JSON, and collect-entries missing entries in nested dirs. Check obelisk-cell-cord renders every aura without bail.`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'severity', 'reasoning'],
  properties: {
    verdict: { enum: ['confirmed', 'refuted', 'uncertain'] },
    severity: { enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    evidence: { type: 'string' },
  },
}

const results = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(`${PREAMBLE}\n\n=== YOUR DIMENSION: ${d.label} ===\n${d.focus}`, {
      label: `review:${d.key}`,
      phase: 'Review',
      effort: 'high',
      schema: FINDINGS_SCHEMA,
    }),
  (review, d) => {
    const findings = (review && review.findings) || []
    const hicrit = findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    // low/medium pass through unverified; high/critical get an adversarial verifier
    const verifiedHi = parallel(
      hicrit.map((f) => () =>
        agent(
          `You are an ADVERSARIAL verifier for a code-review finding on the lattice grubbery nexus. Repo root: ${ROOT}/ . Your DEFAULT is "refuted": a finding survives only if you can construct a concrete, reachable reproduction.\n\nFINDING (dimension ${d.label}):\n- file: ${f.file}\n- line: ${f.line}\n- severity claimed: ${f.severity}\n- summary: ${f.summary}\n- failure scenario: ${f.failure_scenario}\n\nDo this: Read the cited file around that line AND every arm/caller it depends on (the actual data flow into it). Determine whether the claimed input is REACHABLE (can a real HTTP request / page / peer actually deliver it, given the owner-gate, name validation, size caps, and escaping that already exist upstream) and whether it actually produces the claimed crash/leak/wrong-output. A guard elsewhere that prevents the input REFUTES the finding. If a Hoon-level claim can be settled by evaluating an expression, you MAY use the mcp__tyr__prod-hoon tool (load it via ToolSearch "select:mcp__tyr__prod-hoon") to test the isolated logic — e.g. test what (stab ...) or an escaper does on a specific byte. Reason concretely; do not rubber-stamp.\n\nReturn verdict=confirmed only with a concrete reproduction in evidence; refuted if a guard prevents it or the logic is actually correct; uncertain only if genuinely undecidable from the code. Adjust severity if the real impact differs from the claim.`,
          {
            label: `verify:${f.file.split('/').pop()}:${f.line}`,
            phase: 'Verify',
            effort: 'high',
            schema: VERDICT_SCHEMA,
          }
        ).then((v) => ({ finding: f, dimension: d.label, verdict: v }))
      )
    )
    return verifiedHi.then((verified) => ({
      dimension: d.label,
      lowmed: findings.filter((f) => f.severity === 'medium' || f.severity === 'low').map((f) => ({ finding: f, dimension: d.label })),
      verified: verified.filter(Boolean),
    }))
  }
)

const clean = results.filter(Boolean)
const confirmedHiCrit = clean
  .flatMap((r) => r.verified)
  .filter((v) => v.verdict && v.verdict.verdict === 'confirmed')
  .map((v) => ({ ...v.finding, dimension: v.dimension, verify: v.verdict }))
const uncertain = clean
  .flatMap((r) => r.verified)
  .filter((v) => v.verdict && v.verdict.verdict === 'uncertain')
  .map((v) => ({ ...v.finding, dimension: v.dimension, verify: v.verdict }))
const lowmed = clean.flatMap((r) => r.lowmed).map((v) => ({ ...v.finding, dimension: v.dimension }))

log(`confirmed high/critical: ${confirmedHiCrit.length}; uncertain: ${uncertain.length}; low/med (unverified): ${lowmed.length}`)

return {
  confirmed_high_critical: confirmedHiCrit.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1)),
  uncertain,
  low_medium: lowmed,
}
