# Static site — a lattice example

A small **public website** built entirely out of ordinary lattice pages, and
published to the clear web with one action. **Nothing here is a feature of the
app.** It's four kinds of page tied together by two general capabilities: a page
can depend on a *directory* (to enumerate content), and any page can be shared
*clearweb* (to serve over unauthenticated HTTP).

Everything lives under one `/site` folder so a single `%share-tree` publishes it.

## The pieces

| File | Page | Kind | Role |
|------|------|------|------|
| `content/*.md` | `site/content/intro`, `.../guide`, `.../about` | markdown | the content — each is a normal page, viewable at its own URL |
| `theme.css` | `site/theme` | css | the theme, served raw at `/c/site/theme` |
| `site.js` | `site/app` | javascript | a live nav filter, served raw at `/c/site/app` |
| `site.hoon` | `site/index` | hoon | the builder — composes the content into a themed index |

## How it works

`site.hoon` depends on the `/site/content` **directory** and walks it with
`tree-in` to build a nav automatically:

```hoon
=/  pages  (skim (tree-in deps /site/content) |=(e=entry page.e))
```

Every link — the nav entries, the theme, the script — is built with `pub-of`,
which produces the **public** `/c/…` URL (the `/x` explorer path is owner-gated
and would 403 for a visitor):

```hoon
=/  url  (pub-of (weld /site/content pax.e))   ::  /apps/lattice/c/site/content/intro
```

It emits an `%html` **fragment**. The public `/c/` surface wraps it in a bare
standalone document (no lattice chrome, the page owns its own styling via the
`<link>`); the owner's `/x` view inlines the same fragment. One stored
representation, each surface supplies its own shell.

The content dependency is **live**: adding a markdown page under
`/site/content` re-runs the builder and the nav updates — then republish.

## Publish / unpublish

Publishing sets `%clearweb` on every page under `/site` in one serialized
action, so the whole site goes public at once:

```
POST /apps/lattice/page-share-tree?name=site&mode=clearweb
```

Take it all down — with no dangling public pages — the same way:

```
POST /apps/lattice/page-share-tree?name=site&mode=private
```

The public site is then at **`/apps/lattice/c/site/index`**, navigable with no
login. Each page is served chrome-less: `%html` raw (the builder owns its doc),
css/js as their real content-type, and **markdown auto-wrapped in your theme** —
you write only markdown and it is rendered into themed HTML on publication.

### Auto-theming markdown (no HTML authoring)

A page named `theme` (a `css` page) styles every page in its folder and below;
the nearest one up the tree wins (drop a `theme` at `site/` to theme the whole
site, or a `site/blog/theme` to override just the blog). When a markdown page is
served, lattice renders it to HTML, wraps it in `<main class="page">` with a
`&larr; home` link, and links that theme — so you never touch HTML, and the
theme is CSS you pick or write, not markup. A page with no `theme` above it
falls back to the default reader stylesheet.

## Reproduce it

`./deploy.sh <base-url> <cookie-file>` creates all the pages under `/site` and
publishes them in one shot. Or build them by hand in the editor (a `site`
folder, a markdown page per `content/*.md`, a `css` page `theme`, a `javascript`
page `app`, and a hoon page `index`), then hit *clearweb* on the folder.

## The primitives it rests on

- **Directory dependency** — `dir-of` / `tree-in` / the `entry` mold in
  `lib/lattice-pg.hoon`; resolved in `read-dep-vals`, kept live in
  `arm-eval-deps`. "Run a program over a structured tree."
- **Standalone clearweb** — nested `/c/` paths and the chrome-less
  `render-clearweb` shell in `nex/lattice/app.hoon`; `pub-of` for public links;
  `%share-tree` to publish/unpublish a whole subtree.

Neither is about websites — a site is just the first thing they compose into.
