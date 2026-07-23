# lattice-fs (Rust)

A single-binary FUSE client that mounts the lattice page tree as a local
filesystem, over **either** transport:

- **Eyre** (HTTP) — owner-gated loopback with a session cookie. Works against a
  remote ship too.
- **lick** (unix-socket IPC) — grubbery's local IPC. Auth is filesystem-presence
  (the socket lives in the pier), so no cookie, no `+code`, and it opens a clean
  path to instant push-invalidation.

The projection is written against a `Transport` trait; both transports implement
one generic `get_bytes`/`post`, so nothing above the transport changes when you
switch. This is why Rust: one binary, one seam, both transports.

## Layout

```
src/
  transport.rs   Transport trait (the seam) + TErr (HTTP-style status)
  eyre.rs        EyreTransport — HTTP + cookie auth (ureq)
  lick.rs        LickTransport — unix socket + jam/cue + newt framing
  projection.rs  Projection trait + Node
  lattice.rs     LatticeProjection — the one lattice-specific file
  core.rs        GrubberyFs — the fuser Filesystem (vtree, cache, write-buffering)
  main.rs        CLI (auth | mount | errors) + transport selection
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

`ls`, `cat`, `rg`, `nvim` + `:w`, `mkdir`, `mv`, `rm` all work; new files' kind
comes from the extension (`.md`→md, `.hoon`→hoon, …); generated `%index` pages
are read-only. The nvim glue in `../lattice-fs/nvim/lattice-fs.lua` applies here
unchanged (it just calls `lattice-fs errors <page>`).

## Status

- **Eyre**: complete, verified on a real mount (reads, all writes incl.
  shrinking truncate, mkdir/mv/rm/rmdir, index-readonly, nvim `:w`, broken→errors).
- **lick**: client complete. jam/cue is verified against the canonical Urbit
  vectors + round-trips + KB atoms (`cargo test`). End-to-end needs the nexus
  `fs` lick-port fiber (models on `gub/nex/lick-echo`), which dispatches the same
  `[verb path query body] -> [status body]` protocol the transport speaks.

## Wire protocol (lick)

Each frame, both directions: `0x00` + 4-byte LE length + `jam([mark noun])`
(vere 4.5). Request: `[%req [verb path query body]]`. Reply: `[%res [status body]]`
where `status` is an HTTP-style code and `body` a cord (JSON or raw text), so the
errno mapping is identical to Eyre.
```
