# urb:// addresses

A `urb://` URL is a **referentially transparent** name: the same text resolves to
the same referent from any ship, any viewer, any year. Resolution is a pure
function of the URL — no lookups, no viewer context, no existence probes. Content
at a referent may change (it's a live page); the *name → location* map does not.

## Grammar

```
urb://~ship                the ship's published front door (its /index)
urb://~ship/<word>/...     a published note  (bare = canonical; "word" is 2+ chars)
urb://~ship/p/<name>/...   a programmable page, or a grub inside it
urb://~ship/n/<rel>        a published note, explicit form
urb://~ship/k/<rel>        a knowledge-vault entry            (reserved; store TBD)
urb://~ship/t/<abs-path>   the raw grubbery tree — any gained grub, any app
```

**The rule:** the first path component decides by *length*.

- **one character** → a **mount letter**. `p`ages, `n`otes, `k`now, `t`ree. Any
  other single letter is a hard error (404), never a fallthrough.
- **two+ characters** → the **legacy published form**, frozen forever:
  `urb://~ship/notes/2026/intro` === `urb://~ship/n/notes/2026/intro`. Every
  federated gemtext link ever written keeps working and keeps its pretty shape.

## Why this is referentially transparent

- **No mutable indirection.** The mount table (`p`/`n`/`k`/`t` → tree prefix) is
  fixed in code and versioned with the app — it ships with the runtime like a
  mark, never with editable data. There is no per-ship alias grub a ship could
  edit to silently re-point a URL.
- **The whole 1-char space is reserved.** An unassigned letter is *invalid*, not
  a store. So a future mount (say `b` for blobs in v3) can only turn an
  already-*invalid* URL into a valid one — it can never re-mean a URL that
  already resolved. Version bumps are monotone. A publish-time lint refuses new
  single-char top-level note names, so the legacy space can't collide either.
- **No existence-dependent resolution.** `/t/a/b` names a file, `/t/a/b/` names a
  directory — the trailing slash disambiguates, so the resolver never has to
  probe the tree to decide what a URL means (grubbery lets a file and a dir share
  a name, so probing would make meaning depend on current state).

## Canonical form

Every view shows its canonical `urb://` in the address bar, ready to copy. The
canonicalizer `en-urb` is the pure inverse of the resolver `de-urb`:

```
de-urb(en-urb(node)) == node          (round-trips to the same referent)
en-urb(de-urb(url))  == canon(url)     (idempotent text normalization)
```

Canonical choices: published notes canonicalize to the **bare** form (not `/n/`)
so federation URLs stay pretty; pages to `/p/`, know to `/k/`; anything with no
nicer name to the `/t/` raw form. Aliases are legal (`urb://~s/t/apps/lattice.lattice_app/page/counter`
names the same node as `urb://~s/p/counter`) but everything that indexes —
catalog, bookmarks — keys on the canonical form, so aliasing never splits state.

## Implementation

- `+de-urb` (app.hoon) — `@t → (unit referent)`, referent = `%pub`/`%tree`.
- `+en-urb` — `[ship path] → @t`, the canonical URL for a tree node.
- The address bar (`GET /apps/lattice?url=…`) resolves via `de-urb`: `%pub` is
  read + rendered inline; `%tree` redirects to the `/x` explorer projection,
  which renders the node and shows its canonical address.
- `/x/~ship/<path>` remains the explorer's own URL (the projection target).

## Not yet

- **Pretty browser URLs.** The address bar shows `urb://…` but the browser
  location for a tree node is still `/apps/lattice/x/~ship/…`. A future
  prefix-swap projection (`/apps/lattice/~ship/p/counter`) would make them one.
- **Relative link authoring sugar.** Writing `=> ../other` in a page and having
  it expand to an absolute canonical `urb://` at save time (RFC-3986 style).
