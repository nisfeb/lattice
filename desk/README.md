# %lattice — gemtext over Urbit

The Gall agent. It publishes the `.gmi` files in your ship's `/pub` directory
to the Urbit namespace, serves them to other ships over remote scry, and follows
remote files you subscribe to. The browser/editor app (`../app`) drives it over
its authenticated HTTP API at `/apps/lattice`.

## Building & installing

This directory holds **only lattice's own source**. The standard base-dev libs
and marks a desk needs are vendored at build time by
[`peru`](https://github.com/buildinspace/peru) (pinned in `../peru.yaml`), so
build the installable desk with `../build.sh` rather than committing this
directory directly:

```dojo
|new-desk %lattice
|mount %lattice
```
```bash
./build.sh -p ~/path/to/your-ship/lattice   # from the repo root
```
```dojo
|commit %lattice
|install our %lattice
```

`build.sh` assembles `desk/` + the vendored deps into `dist/` and copies that
into the mounted desk. See the repo root README for the full picture.

## Files

- `app/lattice.hoon` — the Gall agent. Watches the desk for Clay commits,
  publishes each `/pub/*.gmi` via `%grow` (and `%cull`s removed ones), follows
  subscribed remote files, and serves `/apps/lattice` over Eyre. Endpoints are
  access-controlled (own-ship pokes/watches only; HTTP requires a session).
- `mar/gmi.hoon` — the `%gmi` mark (`text/gemini`), backed by `@t`.
- `sur/lattice.hoon` — agent state.
- `tests/lib/lattice.hoon` — unit tests for the pure helpers in `lib/lattice`.

## Content lives in /pub

Publish by writing gemtext to `/pub/<path>/gmi` on the desk (the app's editor
does this for you). Each file becomes fetchable from any ship as
`urb://~your-ship/<path>` — the `/pub` prefix and `.gmi` extension are dropped.
`/pub/index.gmi` is your home page; if absent, an auto-generated listing is
served for `urb://~ship/`. (Content is **not** kept in `/lib` — that's for the
desk's source libraries.)
