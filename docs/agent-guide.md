# Interacting with lattice — a guide for agents

Lattice is a personal knowledge base that runs as a **grubbery nexus on an Urbit ship**.
Content is *pages* (markdown/gemtext/html/code), plus a private *knowledge* store and a
crawled *catalog*. This guide is for an AI agent (or any program) that wants to read, search,
and write that content. For *deploying* the nexus, see [`grubbery-ops.md`](./grubbery-ops.md).

There are three ways in, in rough order of how you'll reach for them:

| Surface | Good for | Auth |
|---|---|---|
| **FUSE mount** | reading, `grep`, editing pages as files | filesystem presence (lick) or cookie (HTTP) |
| **HTTP API** | programmatic read/write, search, knowledge store | session cookie |
| **grubbery MCP** | driving the ship itself (inspect the ball, run dojo) | session cookie |

Everything below assumes the ship serves on `http://localhost:8080` and the app is installed
(routes bind under `/apps/lattice` — see §"routing" in `grubbery-ops.md`).

---

## 1. The FUSE mount — the fastest way to read and grep

The mount projects the page tree as files: `pub/index` → `index.md`, a hoon page → `foo.hoon`,
etc. A cold mount warms its whole read-cache in one round-trip (`page-dump`), so `rg`/`cat`
run from RAM.

```bash
# build once
cd lattice-fs-rs && cargo build --release

# mount over lick (local IPC, no cookie — the socket in the pier IS the auth)
export LATTICE_SOCK="$PIER/.urb/dev/grubbery/lattice/fs"
export LATTICE_SHIP=tyr              # ship name, no ~
./target/release/lattice-fs mount ~/lattice-mnt      # foreground; Ctrl-C unmounts

# …or over HTTP (Eyre) — set a cookie instead of LATTICE_SOCK:
#   lattice-fs auth              (prompts for +code once, stores a cookie)
#   LATTICE_URL=http://localhost:8080 ./target/release/lattice-fs mount ~/lattice-mnt
```

Then: `ls ~/lattice-mnt`, `rg pattern ~/lattice-mnt`, `cat ~/lattice-mnt/foo.md`, or write
`echo '# hi' > ~/lattice-mnt/foo.md` (a write is one page-save on flush).

**Mounting a sub-tree** (`--root`, or `LATTICE_ROOT`): when the tree gets large, root the
mount at a sub-path so you only see (and warm) that slice — full page semantics preserved:

```bash
lattice-fs mount ~/notes-mnt --root notes        # mounts /page/notes as the root
```

`--root notes` (or `page/notes`, or the full `/apps/lattice.lattice_app/page/notes`) filters
the tree to that sub-root and strips the prefix, so `~/notes-mnt/todo.md` is `notes/todo` on
the ship; a write there lands under `notes/`. No `--root` mounts the whole `/page` tree.
(Rooting at a *different* nexus's ball tree is not wired up yet.)

**Things an agent must know about the mount:**

- **Freshness is a 5-second poll.** External edits (browser, another client) show up within
  ~5s, on the next filesystem access. There is no push yet.
- **Large files are lazy.** A page body over 256 KB is *not* in the warm dump; the first
  `cat`/`read` of it fetches on demand (one round-trip). Small files are all resident.
- **lick is single-connection.** One `fs.sig` port serves one mount at a time. A second lick
  mount will hang waiting for the socket — use the HTTP transport for a concurrent mount.
- **Editor temp files are ephemeral.** Backups/swap files (`foo.md~`, `.foo.md.swp`, atomic-
  save temps) live only in the FUSE layer and never touch the ship. (This is enforced by the
  client; historically a backup's *name* could resolve onto the real page and delete it, so if
  you run an older build, set your editor's `backupdir`/`directory`/`noswapfile` out of the
  mount.)

---

## 2. HTTP API — read/write pages programmatically

All routes are under `/apps/lattice/…`, authenticated with the session cookie
(`Cookie: urbauth-~<ship>=0v…`). GET reads, POST writes; a POST body is the raw content,
parameters go in the query string.

### Reading pages

| Route | Params | Returns |
|---|---|---|
| `GET /page-tree` | — | `{"nodes":[{path,page,kind,size,rev,mtime}]}` — shape only, no bodies |
| `GET /page-dump` | — | same, **plus `body` inline** per page (omitted for bodies >256 KB) — one call for the whole tree |
| `GET /page-source?name=<p>` | `name` | one page's `{body,kind,…}` |
| `GET /page-errors?name=<p>` | `name` | the page's latest evaluator error as text (`''` = clean) |
| `GET /fetch?url=urb://~ship/rel` | `url` | read a *published* page (own vault, or a remote peer via grubbery namespace) |

`page` is `true` for a file, `false` for a folder. `path` is the page-relative key (no leading
slash, no extension). `kind` is one of `md gmi html text js css hoon index`. Derive file size
from the actual `body` bytes when present; trust the reported `size` only when `body` is absent.

```bash
CK="Cookie: $(cat ~/.config/lattice-fs/cookie)"
curl -s -H "$CK" localhost:8080/apps/lattice/page-tree
curl -s -H "$CK" 'localhost:8080/apps/lattice/page-source?name=notes/todo'
```

### Writing pages

| Route | Params | Body | Effect |
|---|---|---|---|
| `POST /page-save?name=<p>&type=<kind>` | `name`, `type` (default `hoon`) | content | create/overwrite a page. **Always send `type`** matching the content (`md`/`gmi`/…) or it is stored as hoon. Add `&new=1` for create-only (409 if it exists). |
| `POST /folder-new?name=<p>` | `name` | — | create an empty folder (nested ok) |
| `POST /page-del?name=<p>` | `name` | — | delete a page |

```bash
curl -s -X POST -H "$CK" --data-binary '# Todo
- ship it' 'localhost:8080/apps/lattice/page-save?name=notes/todo&type=md'
```

> The `type` param matters: it selects the content builder, so `?type=md` round-trips as an
> `.md` page. Omitting it stores the body as raw hoon (kind `hoon`), which over FUSE changes
> the file's extension.

### Published pages & federation

`POST /save?path=<p>` (body = content) writes a *published* page under `pub/` (namespace-
visible to other ships). `GET /fetch?url=urb://~peer/rel` reads a peer's published page.
`POST /follow` / `/sub` subscribe to a peer's pages or feed; `GET /subs` / `/follows` list them.

---

## 3. The knowledge store (`know-*`) — private, tagged notes

Separate from pages: a private, owner-only key/tag store (this is what the ship's memory tools
back onto). Keys are path-like (`user/ai-models`); entries carry tags and revision history.

| Route | Params / body | Effect |
|---|---|---|
| `GET /know-list` | — | keys + tags + metadata (cheap index, no bodies) |
| `GET /know-read?key=<k>` | `key` | one entry's body |
| `GET /know-explore?tags=<t>&match=<all\|any>&q=<substr>` | `tags`, `match`, `q` | filter by tag and/or substring → keys+tags |
| `GET /know-tags` | — | the tag vocabulary with counts |
| `POST /know-save?key=<k>` | `key` + body | create/overwrite an entry |
| `POST /know-tag` / `/know-untag` | `key`, `tag` | add/remove a cross-cutting tag |
| `POST /know-delete` / `/know-restore` | `key` | soft-delete / undo |
| `GET /know-history?key=<k>`, `POST /know-restore-rev` | `key`, rev | per-entry version history |

There is a matching MCP tool set on the ship (`lattice-list`, `lattice-read`, `lattice-save`,
`lattice-explore`, `lattice-tags`, …) if you reach the store through the ship's MCP rather than
HTTP — same semantics.

---

## 4. Search — `catalog-search`

The catalog is an obelisk-indexed, full-text view of crawled + local pages.

```bash
curl -s -H "$CK" 'localhost:8080/apps/lattice/catalog-search?term=ostrich'
# -> {columns:[…,"publisher","path","tf"], rows:[…]}  — rank by (# terms matched, tf)
```

Other `catalog-*` routes (`catalog-toc`, `catalog-backlinks`, `catalog-by-tag`,
`catalog-query`) expose the index; `POST /catalog-sweep` forces a re-crawl. For raw relational
queries there's `GET /obelisk-query`.

---

## 5. Driving the ship — the grubbery MCP

To inspect or operate the ship itself (not just lattice content), talk to the grubbery MCP —
JSON-RPC over HTTP at `/grubbery/mcp`, with the session cookie:

```bash
curl -s -X POST -H "$CK" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"browse","arguments":{"path":"/apps"}}}' \
  localhost:8080/grubbery/mcp
```

`tools/list` returns only a cached 3 tools — call the **`list_tools`** tool to get the live
registry (100+ tools). The load-bearing ones: `browse`/`read_grub` (inspect the ball),
`run_dojo` (any dojo command), `list_clay_files`/`get_clay_file`, `scry`, `poke_agent`. See
`grubbery-ops.md` §8c for the full pattern.

---

## 6. Auth quick reference

- **lick (FUSE):** no cookie — reaching the socket in the pier *is* authorization. Owner-only.
- **HTTP / MCP:** a session cookie. Get one without echoing the `+code`:
  ```bash
  ck=$(curl -s -D - -o /dev/null --data-urlencode "password=$CODE" \
        localhost:8080/~/login | grep -io 'urbauth-[^;]*' | head -1)
  printf '%s' "$ck" > ~/.config/lattice-fs/cookie
  ```
  A ship restart invalidates the cookie — refresh and reconnect. (`lattice-fs auth` does this
  interactively for the FUSE client.)

---

## 7. Gotchas that will bite an agent

- **Routes are `/apps/lattice/…`, not `/grubbery/lattice/…`.** The latter 307s to landscape.
- **`page-save` without `?type=`** stores markdown as hoon (wrong kind, wrong FUSE extension).
- **Freshness is a 5s poll**, not push — don't expect instant cross-client consistency.
- **Slogs/BANGs from the ship go only to the pier's launching terminal**, never to any API
  response — you cannot see them over HTTP. Use `check_bin` / `commit` logs for compile status.
- **The nexus source is the source of truth** for the full route list and exact JSON shapes:
  `grubbery-overlay/nex/lattice/app.hoon` (grep for `%'GET'` / `%'POST'`). This guide covers the
  routes an agent uses most; there are ~70 in total (comments, bookmarks, templates, streams,
  settings, per-page sharing, obelisk exec, …).
