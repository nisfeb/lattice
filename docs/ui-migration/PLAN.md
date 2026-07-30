# UI migration — HTML-in-hoon → lattice-hosted app

> **Superseded layout note (2026-07-30):** the client was restructured into
> light-DOM web components built from `ui-app/src/` — see
> `ui-app/README.md` and
> `docs/superpowers/plans/2026-07-30-ui-web-components.md`. `app.js` is now
> a built artifact (`scripts/build-ui.mjs`); everything below about the
> serving architecture still holds.

Settled architecture (do not relitigate):
- UI source: real files in `grubbery-overlay/nex/lattice/ui-app/` (index.html,
  app.js, app.css). No cords, no escaping, normal tooling.
- `app.hoon` lays them into the ball via `/<` mime imports + `%over` on-load
  rows (guestbook.js pattern) and serves them owner-gated at
  `/apps/lattice/app[/asset]` with correct MIME, streamed from the grubs —
  never from core constants (a 26KB core constant hung every request fiber).
- Vanilla JS on the existing JSON API; SSE via the /beacon/rev keep;
  Prism at /apps/lattice/prism.js.
- Editor first, then /know. Reader/home/clearweb stay server-rendered.

Milestones: see PROGRESS.md. One per loop iteration:
1. Scaffold (serve hello-world app that fetches page-tree)
2. Editor core (tree, Prism editor, save, Cmd+S)
3. Preview / errors / command / share / delete
4. Upload (pickers + drag-drop + progress)
5. Mobile tabs, toggles, beacon-driven refresh
6. Parity audit; delete edit-* cords; /edit routes to the app; docs
7. /know inside the app

Dev loop: repo file → sync-overlay → desk commit (~4 min) for checkpoints;
for rapid iteration, write the asset grubs directly (instant) and land the
final in the repo. Verify every deploy: page-tree 200, served JS node --check,
curl-grep the app shell.
