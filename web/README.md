# The lattice website — hosted on lattice

`site/` is the whole site, organized to be uploaded into lattice itself and
served from your ship:

- `site/index.html` — the landing page. Fully self-contained: inline CSS,
  system fonts, the flat-green crosshatch icon inlined as SVG + data-URI
  favicon. No external assets, no fonts CDN, no images to upload.
- `site/lattice.gmi` — the gemtext edition, readable through the lattice app
  as `urb://~you/…`. The HTML footer links to it as a sibling page
  (`href="lattice"`), which resolves when both are hosted under one folder.

## Hosting it

1. Open the editor (`/apps/lattice/edit`) and hit **⇡ dir** in the tree pane;
   pick this `site/` directory. It lands as `site/index` (kind `html`) and
   `site/lattice` (kind `gmi`).
2. Open `site/index` in the editor → **share** → **clearweb**. The page goes
   public at `/apps/lattice/c/site/index` — no session needed. Share
   `site/lattice` the same way so the footer's gemtext link resolves.
3. Point your reverse proxy (or visitors) at that URL.

Everything is one HTML file by design: pages on lattice are text, so the site
carries no binary assets and needs no asset routes.
