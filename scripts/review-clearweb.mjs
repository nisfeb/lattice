export const meta = {
  name: 'review-clearweb',
  description: 'Adversarial review of the standalone clearweb publishing feature, public-surface focus',
  phases: [
    { title: 'Review', detail: 'security + correctness dimensions' },
    { title: 'Verify', detail: 'adversarially verify each high/critical finding' },
  ],
}

const ROOT = '/home/sneagan/software/personal/lattice/grubbery-overlay'

const PREAMBLE = `You are reviewing a just-landed feature in "lattice" (a grubbery nexus). Repo root: ${ROOT}/ . Read the code with the Read tool.

THE FEATURE — "standalone clearweb publishing." /apps/lattice/c/<path> is the ONLY unauthenticated HTTP surface (every other route is behind an owner login). It now serves whole sites publicly. What changed (all in nex/lattice/app.hoon unless noted):
- The /c route (~line 338): matches [%c ^] and passes t.suffix (a path) to serve-clearweb.
- +serve-clearweb (~3134): now takes pax=path; validates each segment with (levy pax |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg)))); builds pdir=(weld app-base (weld /page pax)); reads /share on that exact leaf and 404s unless %clearweb; then branches on view-mode: %css/%js served RAW via send-typed+mime-of, %html wrapped in render-clearweb with css="", everything else wrapped in render-clearweb with web-css.
- +render-clearweb (~3122): a bare html doc — doctype/head/title/optional <style>/body — NO address bar, NO scripts. Title via (esc title).
- +apply-share (~1360): the factored %share body (share-weir + gain + write /share grub). +apply-eval %share calls it; new %share-tree case peeks the folder ball, murn+collect-tree to page paths, loops apply-share over them. POST /page-share-tree route (~818) pokes %share-tree.
- +heal-share-weirs (~1417): now peeks DEEP and walks collect-tree recursively (was top-level only).
- lib/lattice-eval.hoon: %share-tree eval-action variant. lib/lattice-pg.hoon: +pub-of |=(rel=path (weld "/apps/lattice/c" (spud rel))) and it is used by examples/static-site/site.hoon.

FRAMING — the code COMPILES and RUNS on ~tyr (deployed, tested: /c/site/index and nested /c/site/content/* serve anonymously; a private page 404s; subtree publish+unpublish work). So compile errors are OUT OF SCOPE. Report only RUNTIME behavioral defects with a concrete trigger:
- LEAK: any way an anonymous visitor reaches a page/grub that is NOT %clearweb — path tricks, the per-leaf gate being bypassed, a directory listing, existence disclosure (a private page returning anything other than a flat 404), a shared-but-not-clearweb page served, reading a non-/data grub (code/cmd/share).
- XSS on the public surface: unescaped content in render-clearweb's title or body reaching an anonymous browser; note %html render-shown emits author markup RAW by design (owner-authored) — flag only if a NON-owner could get markup into a served page.
- WRONG SERVING: css/js served with the wrong content-type (so a <link>/<script> breaks), or wrapped in <pre>; render-clearweb producing malformed html; a valid clearweb page 404ing.
- SHARE-TREE bugs: publishing a page it shouldn't (or missing one it should), unpublish leaving a page still public or a dangling weir grant, apply-share not equivalent to the old inline %share, the murn/collect-tree/weld path math being wrong (wrong pdir), non-termination.
- REGRESSION: the old single-segment /c/<name> behavior broken; the %share route behavior changed; heal-share-weirs now crashing or missing pages.

Severity: critical = private-data leak, XSS reaching the public, auth bypass, or reachable hang. high = a broken feature on plausible input, a crash (bail) on a reachable request, wrong content-type breaking a real site. medium/low = narrow edge cases.

For each real defect: file, line, severity, one-sentence summary, and a CONCRETE failure_scenario (exact request/state -> exact wrong result). No hypotheticals. An empty list is a fine answer.`

const FIND = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['file', 'line', 'severity', 'summary', 'failure_scenario'],
    properties: {
      file: { type: 'string' }, line: { type: 'integer' },
      severity: { enum: ['critical', 'high', 'medium', 'low'] },
      summary: { type: 'string' }, failure_scenario: { type: 'string' }, fix_hint: { type: 'string' },
    },
  } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['verdict', 'severity', 'reasoning'],
  properties: { verdict: { enum: ['confirmed', 'refuted', 'uncertain'] }, severity: { enum: ['critical', 'high', 'medium', 'low'] }, reasoning: { type: 'string' }, evidence: { type: 'string' } },
}

const DIMS = [
  { key: 'leak', focus: `THE PUBLIC/PRIVATE BOUNDARY (highest priority). Read the /c route (~335-339), +serve-clearweb (~3126-3160), +read-share (~1434), +read-show-mode (~1443), +name-pax/pax-str (~3651). Try to reach a non-clearweb page or a non-/data grub as an anonymous visitor. Consider: path segments that pass the levy but resolve somewhere unintended; whether the per-leaf /share read can be fooled (a public folder with a private child; a page whose /share is absent/malformed); whether serve-clearweb ever returns a directory ball or a listing; whether a %shared (not %clearweb) page is served; whether "no data" or 404 responses disclose existence of a private page differently than a truly-absent one; whether pdir can escape /page. Grubbery peeks a noun tree, so reason about what [%& %& pdir %data] and [%& %| pax] actually resolve to for adversarial pax.` },
  { key: 'serving', focus: `SERVING CORRECTNESS + XSS. Read +serve-clearweb (~3126-3160), +render-clearweb (~3122), +render-shown (~3156), +mime-of (~3660), +send-typed (~3459), +web-css. Check: css/js go through send-typed with the right mime (a stylesheet/script must NOT be <pre>-wrapped or text/html); the (mule |.(;;(@t ...))) clam and its 415 fallback; render-clearweb emits well-formed html for empty css, empty inner, a title with special chars (is (esc title) enough? pax segments are %ta-sane, but confirm); %noun/%text/%gmi modes render sanely; the "no data" branch. XSS: can any anonymous-reachable text (title, md/gmi body, %html body) carry attacker markup — and who is the author (owner only)?` },
  { key: 'share', focus: `SHARE-TREE + APPLY-SHARE + HEAL. Read +apply-eval %share and %share-tree (~1342-1360), +apply-share (~1360), the /page-share-tree route (~818), +heal-share-weirs (~1417), +collect-tree (~3705), +share-weir (~1398). Check: is apply-share byte-for-byte equivalent to the old inline %share (weir road, gain-if-exists, write /share)? Does %share-tree enumerate EXACTLY the pages under the folder (collect-tree relative paths + (weld base i.rels) — is the path math right, or off by a segment / missing the folder page itself / including folders)? Does mode=private actually revoke every weir grant (no dangling public page over ames or http)? Termination of the loop. Does heal-share-weirs' new recursive walk build the right pp path ((weld (weld root /page) i.rels)) and not crash on an empty tree? Idempotency and the share-weir read-modify-write race across N pages.` },
]

const results = await pipeline(
  DIMS,
  (d) => agent(`${PREAMBLE}\n\n=== YOUR DIMENSION: ${d.key} ===\n${d.focus}`, { label: `review:${d.key}`, phase: 'Review', effort: 'high', schema: FIND }),
  (review, d) => {
    const fs = (review && review.findings) || []
    const hi = fs.filter((f) => f.severity === 'critical' || f.severity === 'high')
    return parallel(hi.map((f) => () =>
      agent(`You are an ADVERSARIAL verifier. Repo root: ${ROOT}/ . Default to "refuted" unless you can construct a concrete, reachable reproduction against the actual code. This is the PUBLIC unauthenticated surface, so a real leak/XSS is critical — but a guard upstream (the [%c ^] route shape, the levy per-segment check, the per-leaf %clearweb gate, name-pax validation on writes) REFUTES a finding.\n\nFINDING (${d.key}):\n- ${f.file}:${f.line} [${f.severity}]\n- ${f.summary}\n- scenario: ${f.failure_scenario}\n\nRead the cited arm AND its callers/guards. Determine if the exact trigger is reachable by a real HTTP request and produces the claimed result. You MAY load mcp__tyr__prod-hoon (ToolSearch "select:mcp__tyr__prod-hoon") to test an isolated Hoon claim (e.g. what (levy ...) or a path weld yields for an adversarial input). Return confirmed only with a concrete reproduction; refuted if a guard prevents it or the logic is correct.`,
        { label: `verify:${f.file.split('/').pop()}:${f.line}`, phase: 'Verify', effort: 'high', schema: VERDICT }
      ).then((v) => ({ finding: f, dimension: d.key, verdict: v }))
    )).then((verified) => ({ dimension: d.key, lowmed: fs.filter((f) => f.severity === 'medium' || f.severity === 'low').map((f) => ({ ...f, dimension: d.key })), verified: verified.filter(Boolean) }))
  }
)

const clean = results.filter(Boolean)
const confirmed = clean.flatMap((r) => r.verified).filter((v) => v.verdict && v.verdict.verdict === 'confirmed').map((v) => ({ ...v.finding, dimension: v.dimension, verify: v.verdict }))
const uncertain = clean.flatMap((r) => r.verified).filter((v) => v.verdict && v.verdict.verdict === 'uncertain').map((v) => ({ ...v.finding, dimension: v.dimension, verify: v.verdict }))
const lowmed = clean.flatMap((r) => r.lowmed)
log(`confirmed high/critical: ${confirmed.length}; uncertain: ${uncertain.length}; low/med: ${lowmed.length}`)
return { confirmed_high_critical: confirmed, uncertain, low_medium: lowmed }
