export const meta = {
  name: 'design-clearweb',
  description: 'Design the standalone clearweb publishing feature for lattice, grounded in the code',
  phases: [
    { title: 'Design', detail: 'independent grounded design proposals' },
    { title: 'Synthesize', detail: 'merge into one recommended design' },
  ],
}

const ROOT = '/home/sneagan/software/personal/lattice/grubbery-overlay'

const CONTEXT = `You are designing a feature for "lattice", a single grubbery NEXUS (nex/lattice/app.hoon, compiled by the %grubbery gall agent). Repo root: ${ROOT}/ . Read the actual code before proposing — a design that doesn't match the code is useless.

THE FEATURE: "standalone clearweb publishing." Today a page can be shared %clearweb, which serves its data over unauthenticated HTTP at /apps/lattice/c/<name>. We want to publish a whole *site* (a builder page + its content pages) as clean, public, navigable standalone web pages.

READ THESE (with the Read tool):
- nex/lattice/app.hoon: the /c/ route (~line 335-339, matches [%c @ ~] — SINGLE segment only), +serve-clearweb (~3122-3140, wraps data in +render-page chrome), +render-page (~3944-3958, the reader chrome: address bar + web-css), +render-bare (~3072-3086, a minimal doc, no address bar, reader CSS), +render-shown (~3156, renders a page's data by view-mode), +apply-eval's %share case (~1330-1342) and +share-weir (~1360), the %share eval-action.
- lib/lattice-eval.hoon: +$ share-mode (%private/%shared/%clearweb) and +$ eval-action.
- lib/lattice-pg.hoon: the page stdlib — data-of/view-of/shown, dir-of/tree-in/entry (the directory-dep primitive), esc. Page code compiles against this.
- examples/static-site/ (site.hoon, theme.css, site.js, content/*.md, README.md): the example this feature should make publishable. site.hoon builds an %html fragment with nav links like "../content/intro/" (which resolve to the OWNER-GATED /x/ path) and links a theme via /f/theme.

KNOWN CAVEATS to solve:
1. Nested /c/ paths don't work — the route matches only [%c @ ~], so /c/content/intro can't be served.
2. serve-clearweb wraps in render-page chrome (address bar). A standalone site wants no lattice chrome.
3. The builder's internal links point at /x/ (owner-gated, 403 for the public). A public site needs links that resolve to public /c/ paths.
4. Publishing a site means sharing every page clearweb one-by-one — tedious.

A PROPOSED DIRECTION (critique and improve it — don't just rubber-stamp; find where it breaks against the real code):
- Route [%c ^] (one-or-more segments); serve-clearweb takes a path, validates via name-pax/valid-name.
- serve-clearweb serves %html pages VERBATIM (author owns the whole document, incl. their theme) and wraps %md/%gmi/%text in a minimal chrome-less doc (reader CSS, no address bar).
- Add a pg helper pub-of(rel) -> "/apps/lattice/c/<rel>" so builders link between public pages.
- Add a %share-tree eval-action + route to set a share mode on a folder and every page under it (publish the whole site at once).
- Rewrite the /site example to a full standalone document with public links; update deploy.sh to publish everything clearweb.

Consider the tension: a page's data is served BOTH at /x/ (owner explorer, inlined into chrome as a fragment) AND at /c/ (public). If the builder emits a FULL html document for a pristine /c/ page, the /x/ view inlines a full doc into its <main> (nested html). If it emits a FRAGMENT, /c/ serves a fragment (browser auto-wraps). Which is right, and how should each surface handle %html? This is the crux — resolve it.`

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chrome_approach', 'nested_paths', 'link_approach', 'publish_convenience', 'example_changes', 'risks', 'rationale'],
  properties: {
    chrome_approach: { type: 'string', description: 'How clearweb serves without chrome; how %html vs %md differ; how the /x/-vs-/c/ full-doc-vs-fragment tension resolves' },
    nested_paths: { type: 'string', description: 'Exact route + serve-clearweb signature change for nested /c/ paths' },
    link_approach: { type: 'string', description: 'How public inter-page links work (pg helper? what URL shape?) and how the builder uses them' },
    publish_convenience: { type: 'string', description: 'Whether/how to publish a whole subtree at once (action, route, UI); or per-page and why' },
    example_changes: { type: 'string', description: 'Concrete changes to examples/static-site to make it publishable' },
    risks: { type: 'array', items: { type: 'string' }, description: 'Real gotchas found in the code (grubbery mechanics, escaping, routing, share-weir, XSS on the public surface)' },
    rationale: { type: 'string', description: 'Why this is the right shape' },
  },
}

const angles = [
  'Lean toward MINIMAL app change: the smallest set of nexus edits that makes the example publishable. Prefer pushing work into the builder page (author-space) over new app machinery.',
  'Lean toward the MOST POWERFUL primitive: what general capability makes "publish any tree of pages as a public site" clean, even beyond this one example. Think about what future sites need.',
  'Lean toward SAFEST public surface: clearweb is the only unauthenticated route. Scrutinize XSS, private-data leakage, and what an anonymous visitor can reach. Design so publishing can never expose a non-clearweb page.',
]

const designs = await parallel(
  angles.map((angle, i) => () =>
    agent(`${CONTEXT}\n\n=== YOUR ANGLE ===\n${angle}\n\nProduce a complete, code-grounded design. Cite the arms/lines you'd change.`, {
      label: `design:${['minimal', 'powerful', 'safe'][i]}`,
      phase: 'Design',
      effort: 'high',
      schema: DESIGN_SCHEMA,
    })
  )
)

const valid = designs.filter(Boolean)
log(`got ${valid.length} designs`)

const synthesis = await agent(
  `${CONTEXT}\n\n=== THREE INDEPENDENT DESIGNS TO MERGE ===\n${JSON.stringify(valid, null, 2)}\n\nYou are the synthesizer. Read the actual code yourself to adjudicate. Produce ONE recommended design that takes the best of each: pick the chrome/link/paths/publish approach that is simultaneously the smallest sound change, the most reusable, and safe on the public surface. Where the three disagree, say which you chose and why. Your risks array must include every real gotcha any design surfaced that survives scrutiny. This is the spec I will implement — be concrete (name arms, molds, routes, the exact serving rule for %html vs other view-modes, the exact pg helper signature).`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high', schema: DESIGN_SCHEMA }
)

return { synthesis, designs: valid }
