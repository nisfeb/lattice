# lattice-fs (Rust)

A single-binary FUSE client that mounts a grubbery ball tree as a local
filesystem, over **either** transport:

- **Eyre** (HTTP) — owner-gated loopback with a session cookie. Works against a
  remote ship too.
- **lick** (unix-socket IPC) — grubbery's local IPC. Auth is filesystem-presence
  (the socket lives in the pier), so no cookie, no `+code`, and it opens a clean
  path to instant push-invalidation.

The projection is written against a `Transport` trait; both transports implement
one generic `get_bytes`/`post`, so nothing above the transport changes when you
switch. This is why Rust: one binary, one seam, both transports.

It mounts in one of two modes, chosen by `--root` (see [Mount modes](#mount-modes)):
the **lattice** projection (full page semantics, read-write) or the **generic**
projection (any other nexus / ball tree, read + overwrite + `rm`).

## Layout

```
src/
  transport.rs   Transport trait (the seam) + TErr (HTTP-style status)
  eyre.rs        EyreTransport — HTTP + cookie auth (ureq)
  lick.rs        LickTransport — unix socket + jam/cue + newt framing
  projection.rs  Projection trait + Node
  lattice.rs     LatticeProjection — the one lattice-specific file
  generic.rs     GenericProjection — any nexus / ball tree (generic ball API + edit_file)
  core.rs        GrubberyFs — the fuser Filesystem (vtree, cache, write-buffering)
  main.rs        CLI (auth | mount | errors) + transport & root selection
```

`fuser` is built with `default-features = false` (no libfuse-dev needed; mounts
via `fusermount3`).

## Use

```sh
cargo build --release

# Eyre (default)
export LATTICE_URL=http://localhost:8080
target/release/lattice-fs auth            # log in once, store the cookie
target/release/lattice-fs mount ~/lattice

# lick (when the nexus fs port is running)
export LATTICE_SOCK=/path/to/pier/.urb/dev/grubbery/lattice/fs
export LATTICE_SHIP='~tyr'
target/release/lattice-fs mount ~/lattice
```

The nvim glue in `../lattice-fs/nvim/lattice-fs.lua` applies unchanged (it just
calls `lattice-fs errors <page>`).

## Mount modes

`--root <val>` (or `LATTICE_ROOT`) chooses what to mount and which projection runs:

| `--root`                                   | Mode      | Access                       |
| ------------------------------------------ | --------- | ---------------------------- |
| *(omitted)*                                | lattice   | whole `/page` tree, RW       |
| `notes` / `page/notes`                     | lattice   | that sub-tree, RW (full page semantics) |
| `/apps/foo.foo_app` (any absolute ball path) | generic | that nexus, read + overwrite + `rm` |

```sh
lattice-fs mount ~/notes  --root notes                 # a lattice sub-tree
lattice-fs mount ~/foo    --root /apps/foo.foo_app      # another nexus (generic)
```

Generic mode is **HTTP-only** (the generic ball API isn't on the lick port), so
set a cookie and don't set `LATTICE_SOCK`.

## Features

- **Fast reads.** A cold mount warms its entire read-cache in one `page-dump`
  round-trip, so `rg`/`cat` run from RAM (grep ~8ms), not one fetch per file.
- **Bounded memory.** Read cache capped at 256 MB, smallest-first; a body >256 KB
  isn't in the warm dump and fetches lazily on first read. An oversized tree
  degrades to lazy read, never OOMs.
- **Editor-safe.** Backup/swap/atomic-save temps (`foo.md~`, `.foo.md.swp`) live
  only in the FUSE layer and never touch the ship.
- **Fresh within 5 s.** External edits (browser, another client) appear on the
  next filesystem access after a 5 s TTL poll — both transports. (The change
  beacon that live-reloads the *web reader* doesn't drive the mount yet; a
  lick push stream is the planned upgrade.)
- **Lattice mode is fully read-write.** `ls`, `cat`, `rg`, `nvim`+`:w`, create,
  `mkdir`, `mv`, `rm`. New files' kind comes from the extension (`.md`→md,
  `.hoon`→hoon, …); generated `%index` pages are read-only; per-page evaluator
  errors via `lattice-fs errors <page>`.
- **Generic mode is read + overwrite + `rm`.** `cat`/`grep` any nexus; overwrite
  an existing grub in place via grubbery's own `edit_file` (atomic, blot
  preserved — no delete-first, so a rejected conversion leaves the old grub
  intact); `rm` → `delete_grub`. No grubbery change required.

## Limitations

- **Generic: no create / `mkdir` / rename.** A foreign nexus's correct mark can't
  be inferred from bytes, and a wrong blot yields a broken grub, so these return
  read-only errors. (Lattice mode has no such limit.)
- **Generic append/`>>` is unreliable.** A grub's mark may normalize its text
  (hoon strips a trailing newline), so file byte-length ≠ stored bytes and an
  offset-based append drifts. Edit by whole-file overwrite (what editors do). A
  grub with no text tube reads (via `/json`) but fails an edit cleanly (`EIO`),
  never corrupts.
- **lick is single-connection.** One `fs.sig` port serves one mount at a time; a
  second lick mount hangs. Use HTTP for a concurrent mount.
- **Eyre freshness is a 5 s poll**, not push — cross-client changes appear within
  ~5 s. A ship restart invalidates the cookie (re-run `auth`); lick needs neither.

## Status

Both transports verified end-to-end on the harness — a full mount matrix
(ls/cat/create/edit-with-truncate/mv/rm/index-readonly/broken→errors) over each:

- **Eyre**: HTTP + cookie auth.
- **lick**: unix socket, no cookie. The nexus serves it from a `/fs.sig` lick
  port (`grubbery-overlay/nex/lattice/app.hoon`); jam/cue is verified against the
  canonical Urbit vectors + round-trips + KB atoms (`cargo test`).

## Wire protocol (lick)

Each frame, both directions: `0x00` + 4-byte LE length + `jam([mark noun])`
(vere 4.5). Request: `[%req [verb path query body]]`. Reply: `[%res [status body]]`
where `status` is an HTTP-style code and `body` a cord (JSON or raw text), so the
errno mapping is identical to Eyre.
```
