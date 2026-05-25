# %lattice — gemtext over Ames

Drop `.gmi` files into `lib/` and `|commit %lattice`. Each file becomes
fetchable from any ship at `urb://~your-ship/path/to/file` (the `.gmi`
extension is omitted from the URL). It's gemtext content cross-linked over
Urbit's native primitives — no DNS, no TLS.

## Files

- `app/lattice.hoon` — the Gall agent. Watches `lib/` for Clay commits,
  publishes each `.gmi` via `%grow` (and `%cull`s removed ones), and serves
  `/apps/lattice/fetch` over Eyre.
- `mar/gmi.hoon` — the `%gmi` mark (`text/gemini`), backed by `@t`.
- `mar/txt.hoon` — standard `%txt` mark; `%gmi`'s `grad %txt` depends on it.
- `sur/lattice.hoon` — agent state.
- `lib/` — your gemtext content. `lib/index.gmi` is the home page; if absent,
  an auto-generated listing is served for `urb://~ship/`.

## Publishing

Filesystem + `|commit` *is* the publish step:

1. write `lib/notes/intro.gmi`
2. `|commit %lattice`

On each commit the agent diffs `lib/` by content hash and `%grow`s new or
changed files, `%cull`s removed ones. It's now fetchable at
`urb://~your-ship/notes/intro` from anywhere.

## Endpoint

```
GET /apps/lattice/fetch?url=urb://~ship/path   ->   {"mark":"gmi","body":"…"}
```

For `~ship == self`, reads `/lib/<path>/gmi` from local Clay. For another
ship, issues an Ames `%keen` remote scry and relays the answer. Requires a
session cookie (standard Eyre auth); url-encode the `url` query value.

Errors: `400` missing/bad url, `404` not found / peer has no value.

## Install

```
> |mount %lattice
> |install our %lattice
```

See `../docs/lattice-integration-test.md` for the end-to-end test recipe and
the dev gotchas (state migration order, the `txt` mark dependency, the `//1`
publication-path shape).

## Status

Local publish + fetch + index and **remote (`%keen`) cross-ship fetch** are
all verified working (`~zod`↔`~tyr`). Peers must be introduced (`|hi`) before
remote fetch works, and a missing remote path currently hangs (remote scry
can't prove absence). See the integration recipe.
