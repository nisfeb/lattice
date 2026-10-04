# Interacting with lattice: a guide for agents

Lattice is a personal knowledge base that runs as a **grubbery nexus on an Urbit ship**. Content is *pages* (markdown/gemtext/html/code) plus a private *knowledge* store, with a term index over both. This guide is for an AI agent (or any program) that wants to read, search, and write that content. For *deploying* the nexus, see [`grubbery-ops.md`](./grubbery-ops.md).

There are four ways in, in rough order of how you'll reach for them:

| Surface | Good for | Auth |
|---|---|---|
| **Agent plugins** ([Claude Code](../plugins/claude/README.md), [Hermes](../plugins/hermes/README.md)) | memory and wiki for an AI agent, with hooks and skills | agent key |
| **FUSE mount** | reading, `grep`, editing pages as files | filesystem presence (lick) or cookie (HTTP) |
| **HTTP API** | programmatic read/write, search, knowledge store | agent key (memory and pages) or session cookie (everything) |
| **grubbery MCP** | driving the ship itself (inspect the ball, run dojo) | session cookie |

An AI agent that only needs memory and pages should use a plugin, or the HTTP API with an agent key: [agent-knowledge.md](agent-knowledge.md) covers both, and how to move off a cookie.

Everything below assumes the ship serves on `http://localhost:8080` and the app is installed. Routes bind under `/apps/lattice`. See the "routing" section in `grubbery-ops.md`.

---

## 1. The FUSE mount, the fastest way to read and grep

The mount projects the page tree as files: `pub/index` becomes `index.md`, a hoon page becomes `foo.hoon`, and so on. A cold mount warms its whole read-cache in one round-trip (`page-dump`), so `rg` and `cat` run from RAM.

```bash
# build once
cd lattice-fs-rs && cargo build --release

# mount over lick: local IPC, no cookie (the socket in the pier IS the auth)
export LATTICE_SOCK="$PIER/.urb/dev/grubbery/lattice/fs"
export LATTICE_SHIP=tyr              # ship name, no ~
./target/release/lattice-fs mount ~/lattice-mnt      # foreground, Ctrl-C unmounts

# …or over HTTP (Eyre). Set a cookie instead of LATTICE_SOCK:
#   lattice-fs auth              (prompts for +code once, stores a cookie)
#   LATTICE_URL=http://localhost:8080 ./target/release/lattice-fs mount ~/lattice-mnt
```

Then: `ls ~/lattice-mnt`, `rg pattern ~/lattice-mnt`, `cat ~/lattice-mnt/foo.md`, or write `echo '# hi' > ~/lattice-mnt/foo.md`. A write is one page-save on flush.

**Mounting a sub-tree** (`--root`, or `LATTICE_ROOT`). When the tree gets large, root the mount at a sub-path so you only see and warm that slice. Full page semantics are preserved:

```bash
lattice-fs mount ~/notes-mnt --root notes        # mounts /page/notes as the root
```

`--root notes` (or `page/notes`, or the full `/apps/lattice.lattice_app/page/notes`) filters the tree to that sub-root and strips the prefix. So `~/notes-mnt/todo.md` is `notes/todo` on the ship, and a write there lands under `notes/`. No `--root` mounts the whole `/page` tree.

**Mounting any other nexus or ball tree.** Give `--root` an absolute ball path:

```bash
lattice-fs mount ~/counter-mnt --root /apps/counter.counter   # browse another nexus
```

This uses grubbery's generic ball API (`/grubbery/api/tree` + `/grubbery/api/file`) plus its `edit_file`/`delete_grub` MCP tools, so it works for *any* tree, not just lattice. Grubs appear as `<name>.txt` and read as their text form (`?blot=/txt`, falling back to `/json` for a grub with no text tube). That keeps them grep and cat friendly.

**Read + overwrite + rm.** You can `cat` and `grep`, overwrite an existing grub (an editor save, or `echo … > file`), and `rm` it. The overwrite goes through grubbery's own in-place `edit_file`, which preserves the blot and is atomic. A rejected conversion leaves the old grub intact. This is the same "writable file" path the ship's operator has. What it does **not** do: create a *new* grub (the target mark can't be inferred from bytes, so you get `EROFS`), `mkdir`, or rename. And **append or partial writes (`>>`, `tee -a`) are unreliable**. A grub's mark may normalize its text (hoon strips a trailing newline), so the byte length seen as a file need not match the stored bytes, and an append lands at the wrong offset. Edit by whole-file overwrite, not append. A grub whose mark has no text tube reads (via `/json`) but fails the edit cleanly (`EIO`) rather than corrupting. Generic mounts run over HTTP (Eyre), not lick. Set a cookie and don't set `LATTICE_SOCK`.

**Things an agent must know about the mount:**

- **Freshness is a 5-second poll.** External edits (browser, another client) show up within ~5s, on the next filesystem access. There is no push yet.
- **Large files are lazy.** A page body over 256 KB is *not* in the warm dump. The first `cat` or `read` of it fetches on demand, in one round-trip. Small files are all resident.
- **lick is single-connection.** One `fs.sig` port serves one mount at a time. A second lick mount will hang waiting for the socket. Use the HTTP transport for a concurrent mount.
- **Editor temp files are ephemeral.** Backups, swap files, and atomic-save temps (`foo.md~`, `.foo.md.swp`) live only in the FUSE layer and never touch the ship. The client enforces this. Historically a backup's *name* could resolve onto the real page and delete it, so if you run an older build, set your editor's `backupdir`/`directory`/`noswapfile` out of the mount.

---

## 2. HTTP API: read and write pages programmatically

All routes are under `/apps/lattice/…`, authenticated with the session cookie (`Cookie: urbauth-~<ship>=0v…`), or for the memory and page routes in [agent-knowledge.md](agent-knowledge.md#http-routes), an agent key (`Authorization: Bearer <id>.<secret>`). GET reads and POST writes. A POST body is the raw content, and parameters go in the query string.

### Reading pages

| Route | Params | Returns |
|---|---|---|
| `GET /page-tree` | (none) | `{"nodes":[{path,page,kind,size,rev,mtime,share}]}`, shape only, no bodies |
| `GET /page-dump` | (none) | same, **plus `body` inline** per page (omitted for bodies >256 KB). One call for the whole tree. |
| `GET /page-source?name=<p>` | `name` | one page's `{body,kind,…}` |
| `GET /page-errors?name=<p>` | `name` | the page's latest evaluator error as text (`''` = clean) |
| `GET /fetch?url=urb://~ship/rel` | `url` | read a *published* page (own vault, or a remote peer via a grubbery peek) |

`page` is `true` for a file, `false` for a folder. `path` is the page-relative key (no leading slash, no extension). `kind` is one of `md gmi html text js css hoon index`. Derive file size from the actual `body` bytes when present. Trust the reported `size` only when `body` is absent.

```bash
CK="Cookie: $(cat ~/.config/lattice-fs/cookie)"
curl -s -H "$CK" localhost:8080/apps/lattice/page-tree
curl -s -H "$CK" 'localhost:8080/apps/lattice/page-source?name=notes/todo'
```

### Writing pages

| Route | Params | Body | Effect |
|---|---|---|---|
| `POST /page-save?name=<p>&type=<kind>` | `name`, `type` (default `hoon`) | content | create/overwrite a page. **Always send `type`** matching the content (`md`/`gmi`/…) or it is stored as hoon. Add `&new=1` for create-only (409 if it exists). |
| `POST /folder-new?name=<p>` | `name` | (none) | create an empty folder (nested ok) |
| `POST /page-del?name=<p>` | `name` | (none) | delete a page, or a folder and everything under it |

```bash
curl -s -X POST -H "$CK" --data-binary '# Todo
- ship it' 'localhost:8080/apps/lattice/page-save?name=notes/todo&type=md'
```

> The `type` param matters. It selects the content builder, so `?type=md` round-trips as an `.md` page. Omitting it stores the body as raw hoon (kind `hoon`), which over FUSE changes the file's extension.

### History and links

| Route | Params | Returns |
|---|---|---|
| `GET /page-history?name=<p>` | `name` | `{name, revisions:[{rev,updated}]}`, newest first. Every save is a revision. Autosave makes them dense. Pruned to the newest 50. |
| `GET /page-source-at?name=<p>&rev=<n>` | `name`, `rev` | that revision's `{body, kind, rev}`. Restoring = re-saving the old body, so nothing is destroyed. |
| `GET /page-backlinks?name=<p>` | `name` | `{links:[path]}`, the pages whose body contains `[[<name>]]`. |

`[[page-name]]` in a markdown body renders as a link. Names may use `a-z 0-9 - / . _ ~`, and anything else is left verbatim.

### Public forms (the one unauthenticated write)

`POST /apps/lattice/f/<page>` delivers a body as a command to that page. It requires the page to be **clearweb** AND to carry a forms flag set by the owner via `POST /page-forms?name=<p>&on=1` (nearest-flag-wins up the folder tree). Bodies over 8 KB are refused, and submissions carry poke budget 0. Everything else in this guide is owner-gated.

### Published pages & federation

`POST /save?path=<p>` (body = content) writes a *published* page under `pub/`, which is namespace-visible to other ships. `GET /fetch?url=urb://~peer/rel` reads a peer's published page. `POST /follow` and `/sub` subscribe to a peer's pages or feed. `GET /subs` and `/follows` list them.

---

## 3. The knowledge store (`know-*`): private, tagged notes

Separate from pages. A private, owner-only store of path-like keys (`user/ai-models`) with tags, provenance in front matter, and revision history. It is the memory the agent plugins and grubbery's `lattice-*` MCP tools back onto.

| Route | Params / body | Effect |
|---|---|---|
| `GET /know-index` | `brief=1`, `cap=` | the session index, as plain text: every key by area, plus the `core` entries in full |
| `GET /know-recall?task=<t>` | `task`, `k` | the entries most relevant to a task, plus what they link to |
| `GET /know-search?q=<q>` | `q`, `k`, `superseded=1` | ranked search with snippets; `weak` when nothing matched well |
| `GET /know-list` | (none) | keys + tags + metadata (cheap index, no bodies) |
| `GET /know-read?key=<k>` | `key` | one entry |
| `GET /know-explore?tags=<t>&match=<all\|any>&q=<substr>` | `tags`, `match`, `q` | filter by tag and/or substring → keys+tags |
| `GET /know-tags` | (none) | the tag vocabulary with counts |
| `POST /know-save?key=<k>` | `key` + body; `author`, `source`, `expected_updated`, `force_new` | create or update an entry |
| `POST /know-verify`, `/know-supersede` | `key`; `old`, `new` | still true; replaced by another entry |
| `POST /know-tag` / `/know-untag` | `key`, `tag` | add/remove a cross-cutting tag |
| `POST /know-delete` / `/know-restore` | `key` | soft-delete / undo |
| `GET /know-history?key=<k>`, `POST /know-restore-rev` | `key`, rev | per-entry version history |
| `GET /know-lint` | (none) | what a tidy would fix |

[agent-knowledge.md](agent-knowledge.md) has the details: ranking, provenance, which routes an agent key may use, the MCP tools, and the routine an agent should follow.

---

## 4. Search

For ranked results, use `GET /page-search?q=<words>` for pages and `GET /know-search?q=<words>` for memory. Both rank by BM25, take several words at once and label what they find.

`content-search` is the omnibar's term index. One inverted index covers your pages and your knowledge entries. It answers a single normalized term at a time, out of one grub, so cost does not grow with the corpus.

```bash
curl -s -H "$CK" 'localhost:8080/apps/lattice/content-search?term=ostrich'
# -> {columns:["scope","key","tf"], rows:[…]}
```

`scope` is `public`, `private`, or `knowledge`, so you can tell a published page from a private note. For a multi-word query, fire one call per word and merge: rank by how many words a key matched, then by summed `tf`. A word under 3 characters or on the stop list matches nothing and answers 200 with no rows, so you never have to pre-filter.

The index is rebuilt wholesale, not incrementally. Content written since the last rebuild is not findable until you run `POST /search-reindex`. See [`native-index.md`](./native-index.md) for the layout and the tokenizer.

---

## 5. Driving the ship: the grubbery MCP

To inspect or operate the ship itself (not just lattice content), talk to the grubbery MCP. It is JSON-RPC over HTTP at `/grubbery/mcp`, with the session cookie:

```bash
curl -s -X POST -H "$CK" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"browse","arguments":{"path":"/apps"}}}' \
  localhost:8080/grubbery/mcp
```

`tools/list` returns only a cached 3 tools. Call the **`list_tools`** tool to get the live registry (100+ tools). The load-bearing ones: `browse`/`read_grub` (inspect the ball), `run_dojo` (any dojo command), `list_clay_files`/`get_clay_file`, `scry`, `poke_agent`. See `grubbery-ops.md` §8c for the full pattern.

The cookie gives an MCP client every power you have, dojo included. For memory alone, an agent plugin with a scoped key is the safer way in. The `lattice-*` memory tools here still work for clients without a plugin ([agent-knowledge.md](agent-knowledge.md#grubberys-mcp-tools)).

**Never print or log the session cookie.** Anyone holding it is you.

---

## 6. Auth quick reference

- **Agent key (HTTP):** `Authorization: Bearer <id>.<secret>`. Made in Settings, Agent keys. It reaches only the memory and page routes its scope names, signs what it writes, never expires, and is revoked on its own. Use it for agents. See [agent-knowledge.md](agent-knowledge.md#agent-keys).
- **lick (FUSE):** no cookie. Reaching the socket in the pier *is* authorization. Owner-only.
- **HTTP / MCP:** a session cookie, with all your powers. Get one without echoing the `+code`:
  ```bash
  ck=$(curl -s -D - -o /dev/null --data-urlencode "password=$CODE" \
        localhost:8080/~/login | grep -io 'urbauth-[^;]*' | head -1)
  printf '%s' "$ck" > ~/.config/lattice-fs/cookie
  ```
  A ship restart invalidates the cookie, so refresh and reconnect. `lattice-fs auth` does this interactively for the FUSE client.

---

## 7. Gotchas that will bite an agent

- **Routes are `/apps/lattice/…`, not `/grubbery/lattice/…`.** The latter 307s to landscape.
- **`page-save` without `?type=`** stores markdown as hoon (wrong kind, wrong FUSE extension).
- **Freshness is a 5s poll**, not push. Don't expect instant cross-client consistency.
- **Slogs and BANGs from the ship go only to the pier's launching terminal**, never to any API response. You cannot see them over HTTP. Use `check_bin` / `commit` logs for compile status.
- **An agent key gets 403 outside its scope**, including every owner route (publish, share, delete, move, settings). That is the scope working, not a bug. A 401 means the key was revoked or mistyped.
- **The nexus source is the source of truth** for the full route list and exact JSON shapes: `code/nex/lattice/app.hoon` (grep for `%'GET'` / `%'POST'`). This guide covers the routes an agent uses most. There are ~100 in total (comments, bookmarks, templates, streams, settings, per-page sharing, follows, …).
