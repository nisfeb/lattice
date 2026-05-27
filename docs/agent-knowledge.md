# Agent knowledge store (MCP)

A **private** knowledge store inside the `%lattice` agent for programmatic
agents (via the [urbit-mcp-server](https://github.com/...) `%mcp` agent). It is
kept entirely separate from lattice's published gemtext pages:

- Stored in agent **state** (`know` / `trash`), **never grown or published** —
  not remotely scryable, owner-only (local `on-peek` + `src==our` pokes).
- Items are keyed by a **path-like key**, e.g. `projects/lattice/architecture`.
- **Delete is soft**: `delete` moves an item to a recoverable `trash`; `restore`
  brings it back. Permanent purge is **not** exposed to agents, so an agent
  cannot destroy knowledge.

## Agent interface (the durable contract)

Read (scry, JSON, owner-local):

| scry path | returns |
|---|---|
| `/x/know/list/json` | keys + metadata (no bodies) |
| `/x/know/read/<key…>/json` | one item `{key, body, updated}` |
| `/x/know/all/json` | all items with bodies |
| `/x/know/trash/json` | soft-deleted keys |

Write (poke mark `%lattice-know`, `src==our`): `know-action` =
`[%save key body]` / `[%del key]` / `[%restore key]`.

These work today with the generic `scry-agent` / `poke-our-agent` MCP tools.

## Dedicated MCP tools

`scripts/setup-knowledge-mcp-tools.py` registers six clean-schema tools into a
running `%mcp-server` (compiled in its context, so **no lattice-side
dependency**):

| tool | params |
|---|---|
| `lattice-save` | `key`, `body` |
| `lattice-read` | `key` |
| `lattice-list` | — |
| `lattice-search` | `query` (case-insensitive substring over keys + bodies) |
| `lattice-delete` | `key` (soft) |
| `lattice-restore` | `key` |

### Setup

The `/mcp` endpoint is read from the repo's shared `.mcp.json` (the same file
your MCP client uses). For auth you give the ship's web login code (`+code` in
the dojo) and the script exchanges it for a session itself — you never fetch or
paste a session cookie:

```sh
python3 scripts/setup-knowledge-mcp-tools.py            # the lone mcpServers entry
python3 scripts/setup-knowledge-mcp-tools.py <server>   # or a named entry
# → prompts: ship +code (hidden):
```

The code is read **without echo**, used only for the login request, then dropped
— it is never printed, logged, or stored. For unattended runs pass it via
`LATTICE_CODE` (popped from the env at startup); `LATTICE_URL` overrides the
endpoint and an existing `LATTICE_COOKIE` skips login. Requires `%lattice`
`[0 3 9]`+ and the `%mcp-server` agent installed. Verified end-to-end on a fake
ship: save → read → search → delete (soft) → restore all round-trip.

### Re-running / upgrades

`%mcp-server` keeps its tools in a **set** — there is no overwrite or delete, so
running the script twice registers *duplicate* tools (and a stale duplicate can
shadow the good one). To re-register cleanly after a lattice upgrade, reset the
server's tool state first, then run the script:

```
|nuke %mcp-server      :: clears its state (you'll confirm y/N)
|revive %mcp-server    :: re-runs on-init, reloading only the default tools
```

This wipes user-registered tools/prompts/resources on that ship — re-add any
others afterwards. On the fakes the agent's desk is `%mcp` (`|nuke`/`|revive`
the `%mcp-server` *agent*, not the desk).
