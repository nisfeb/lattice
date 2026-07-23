# lattice-fs

Mount your lattice page tree as a real local filesystem and edit it in neovim
(or any editor / `rg` / `sed` / shell). Each page is a file named `<name>.<ext>`;
folders are directories. A `:w` writes back through the nexus's `page-save`
action, so the page is re-wrapped, re-evaluated, and re-indexed exactly as if you
saved it in the web editor — the filesystem never touches raw grubs.

```
~/lattice/
  demo/
    hello.md        # editable markdown source (envelope stripped)
    theme.css
  counter.hoon      # a hoon page's source
  myblog/
    index.md        # a generated %index page — read-only (0444)
    first.md
```

## Install

Needs Python 3, `fusepy`, and libfuse (`/dev/fuse`, `fusermount`).

```sh
pip install fusepy
```

Put `scripts/lattice-fs` on your `PATH` (the nvim glue calls it by name):

```sh
ln -s "$PWD/scripts/lattice-fs" ~/.local/bin/lattice-fs
```

## Use

```sh
export LATTICE_URL=http://localhost:8080     # your ship's Eyre (default this)
lattice-fs auth                              # log in once (+code, hidden); stores cookie
lattice-fs mount ~/lattice                   # foreground; Ctrl-C to unmount
```

Then in another terminal: `nvim ~/lattice/demo/hello.md`, edit, `:w`. `ls`, `cat`,
`rg`, `mkdir`, `mv`, `rm` all work. Creating `~/lattice/notes/new.md` makes a new
markdown page; `new.hoon` makes a hoon page (extension → kind).

Auth is cookie-only: the `+code` is used once for login and discarded; only the
session cookie is kept (`~/.config/lattice-fs/cookie`, mode 600). On expiry the
client re-logs-in if `LATTICE_CODE` is set, else run `lattice-fs auth` again.

## neovim integration

Source the glue and point it at your mount:

```lua
vim.g.lattice_mount = vim.fn.expand('~/lattice')
vim.cmd('source /path/to/lattice-fs/nvim/lattice-fs.lua')
```

It does two things for buffers under the mount:
- sets `backupcopy=yes` so `:w` writes in place (one save = one eval, no rename churn),
  and keeps vim's backup copies off the tree;
- on `BufWritePost`, pulls the page's evaluator error into the quickfix list
  (`lattice-fs errors <page>` under the hood) — broken hoon opens `:copen`, a fix
  clears it. The 400 ms defer lets the async evaluator run first.

## Architecture

Two layers, so a generic `grubbery-fs` is a clean extraction, not a rewrite:

- **`grubbery_fs/`** — the generic core. Knows only "a tree of files/dirs behind a
  `Projection`". Owns the FUSE ops, the virtual-path tree, read/write caching, and
  auth (`/~/login` is Eyre-generic). Never names markdown, hoon, `page-save`, or a grub.
- **`lattice_fs/projection.py`** — the only lattice-specific file. Maps the seam onto
  the nexus routes (`page-tree`, `page-source`, `page-save`, `folder-new`, `page-del`,
  the err grub via `/x/…/err?data`), the kind↔ext table, and the page-with-children
  convention. A second grubbery app is a new `Projection` subclass, zero core edits.

Writes buffer in an open handle and POST once on flush. Structure comes from one
`page-tree` call cached with a 5 s TTL; a page body is fetched on first read and
cached until its page is written or the tree is invalidated.

## Nexus routes it depends on

Both added to `grubbery-overlay/nex/lattice/app.hoon`, owner-gated:

- `GET /apps/lattice/page-source?name=<path>` → `{kind, body, size, rev, mtime}`
  (raw editable source, envelope stripped server-side).
- `GET /apps/lattice/page-tree` → `{nodes:[{path, page, kind?, size?, rev?, mtime?}]}`
  (whole tree in one call; folders are `page:false`).

Errors are read through the existing generic `/x/<ship>/…/page/<name>/err?data`
proxy (same path the web editor uses) — no dedicated route.

## Known limits

- **Freshness**: the tree is polled every 5 s (the correctness floor); a best-effort
  keep-SSE watcher on `/grubbery/api/keep/…/page` accelerates external-edit
  visibility when it fires. Edits made *through* the mount are reflected immediately.
- **Rename** is read+create+delete (no server rename), so `mv` re-evaluates the page
  under its new name and briefly shows both.
- **mtime** is whole-second and resets to the reload time for pages untouched since
  the last nexus reload; it advances correctly once a page is edited.
- Single-user: concurrent web-editor + mount saves of the same page are last-write-wins.

## Tests

```sh
python3 tests/test_core.py                                   # FUSE ops, offline
LATTICE_URL=… LATTICE_COOKIE_JAR=<jar> python3 tests/test_live.py   # projection vs live nexus
```
