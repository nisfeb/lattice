# Static site — a lattice example

A small website built entirely out of ordinary lattice pages. **Nothing here
is a feature of the app.** It's four kinds of page tied together by one
general primitive: a page can depend on a *directory* and receive its tree.

## The pieces

| File | Page | Kind | Role |
|------|------|------|------|
| `content/*.md` | `content/intro`, `content/guide`, `content/about` | markdown | the content — each is a normal page, viewable at its own URL |
| `theme.css` | `theme` | css | the theme, served as an asset at `/f/theme` |
| `site.js` | `site-js` | javascript | a live nav filter, served at `/f/site-js` |
| `site.hoon` | `site` | hoon | the builder — composes the content into a themed index |

## How it works

`site.hoon` declares one dependency — the `/content` **directory**:

```hoon
(needs (html body) ~[(dir-of /content)])
```

Because that dep is a directory, the evaluator resolves it to a listing of
every page under it, which `site.hoon` reads with `tree-in`:

```hoon
=/  pages  (skim (tree-in deps /content) |=(e=entry page.e))
```

It turns that into a nav of cards, links a css theme (`<link href="/f/theme">`)
and a js filter (`<script src="/f/site-js">`), and renders as `%html`.

The dependency is **live**: the builder keeps a subscription on the `/content`
directory, so adding or removing a markdown page re-runs it and the index
updates on its own — no build step, no hand-maintained list.

Each content page is still an independent, shareable page at its own URL. The
site is just a *lens* over them.

## Reproduce it

Run `./deploy.sh <base-url> <cookie-file>` (an authenticated session cookie),
or create the pages by hand in the editor:

1. New folder `content`, then a markdown page in it per `content/*.md`.
2. A `css` file `theme` with `theme.css`.
3. A `javascript` file `site-js` with `site.js`.
4. A hoon page `site` with `site.hoon`.

Open `site` and you have a site. Add another page under `content/` and watch
the index pick it up.

## The primitive it rests on

`dir-of` (the dep path for a folder), `tree-in` (its listing from `deps`), and
the `entry` mold live in `lib/lattice-pg.hoon`. The evaluator resolves a
directory dep in `read-dep-vals` and keeps a live subscription on it in
`arm-eval-deps`. That capability isn't about websites — it's "run a program
over a structured tree," which also covers indexes, feeds, and dashboards.
