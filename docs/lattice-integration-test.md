# %lattice integration test recipe

How to verify the `%lattice` desk end-to-end. Part A (single ship) and Part B
(two ships, remote `%keen`) are both verified working.

## Two ways to drive a dev ship

**Dojo (canonical).** Boot a fakezod, mount the desk, sync files, commit, install:

```
$ urbit -F zod                      # boots ~zod, prints its http port
~zod> |new-desk %lattice            # first time only
~zod> |mount %lattice
# from the repo, with $PIER = the ship's pier dir:
$ rsync -a desk/ "$PIER/lattice/"   # NOTE: do not --delete; keep base marks
~zod> |commit %lattice
~zod> |install our %lattice
```

**MCP server (what we used).** If the ship runs the `%mcp-server` agent, the
helper `scripts/mcp-zod.sh <tool> <json>` drives it over HTTP. It needs a
`.mcp.json` (gitignored) with the ship URL and a session cookie:

```bash
COOKIE=$(curl -si -X POST http://localhost:8081/~/login \
  -d 'password=<+code>' | sed -n 's/^set-cookie: *\(urbauth[^;]*\).*/\1/p')
# .mcp.json -> { "mcpServers": { "zod": {
#   "url": "http://localhost:8081/mcp", "headers": { "Cookie": "<COOKIE>" } } } }

./scripts/mcp-zod.sh new-desk    '{"desk":"lattice"}'
./scripts/mcp-zod.sh mount-desk  '{"desk":"lattice"}'   # syncs to $PIER/lattice
cp -r desk/{app,sur,mar,lib}/* "$PIER/lattice/..."      # add our files (keep base marks)
./scripts/mcp-zod.sh commit-desk '{"desk":"lattice"}'
./scripts/mcp-zod.sh install-app '{"desk":"lattice"}'
```

> **State migrations need nuke → commit → revive.** Changing `state-0`'s shape
> makes a live commit fail `%load-failed` and roll back. Nuke first, commit the
> new code, then `revive-agent` (which re-runs `on-init`). Plain `install-app`
> after a nuke does NOT re-initialize.

> **A bare `new-desk` ships only `bill/hoon/kelvin/mime/noun` marks.** The
> `%gmi` mark's `grad %txt` needs `/mar/txt/hoon`; we ship it in `desk/mar/`.

All `fetch` requests need auth on a fakezod — pass the session cookie:
`curl -b "urbauth-~zod=…"`.

## Part A — single ship (publish + local fetch)

Drop the sample content (`desk/lib/*.gmi`) and commit. Then:

```bash
PORT=8081 ; CK="urbauth-~zod=…"
F(){ curl -s -b "$CK" -G "http://localhost:$PORT/apps/lattice/fetch" --data-urlencode "url=$1"; echo; }

F "urb://~zod/hello"                 # -> {"body":"# Hello from lattice\n…","mark":"gmi"}
F "urb://~zod/notes/2026/intro"      # nested file
F "urb://~zod/"                      # authored lib/index.gmi, else generated listing
F "urb://~zod/nope"                  # -> {"error":"not found"} (404)
curl -s -b "$CK" "http://localhost:$PORT/apps/lattice/fetch"   # -> missing url param (400)
```

Publishing/edit/remove (watch the dojo trace, or the agent's `~&` lines):

```bash
# edit: change a file's content, commit -> "1 updated, 0 removed" + %grow
# remove: delete a file, commit       -> "0 updated, 1 removed" + %cull /<spur> (vN)
# add:    new .gmi, commit             -> "1 updated, 0 removed" + %grow
```

The state peek (read it in dojo — the MCP `scry-agent` tool can't reach a
peek because gall prepends the `%x` care):

```
~zod> .^(json %gx /=lattice=/published)     # NOTE: /published, not /x/published
```

## Part B — two ships (remote %keen) — VERIFIED (~zod ↔ ~tyr)

Remote fetch works: `handle-http` fires an ames `%keen`; `on-arvo` relays the
`[%ames %sage [spar gage]]` answer (NOT `%tune` on this kernel). The path
`/g/x/1/lattice//1/<spur>` is correct. **First introduce the ships** — from
each dojo `|hi ~other` (or poke hood `%helm-send-hi [~other ~]`) — because
ames only sends `%keen` to ships it already knows.

```bash
# install %lattice on the 2nd ship (~tyr); add lib/from-tyr.gmi there; |hi both ways
# then from ~zod:
F "urb://~tyr/from-tyr"               # -> {"mark":"gmi","body":"# Hello from ~tyr\n…"}
F "urb://~tyr/hello"                  # -> ~tyr's hello file
```

A missing remote path (`urb://~tyr/nope`) hangs forever: remote scry can't
prove absence, so the peer sends no answer and there is no 404. Add a Behn
timeout if the HTTP request should fail fast instead.
