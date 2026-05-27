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

Point it at your ship with its authenticated cookie (the same session your MCP
client uses), then run once (re-run after a lattice upgrade — `add-mcp-tool`
overwrites by name):

```sh
LATTICE_URL=https://your-ship.example.com \
LATTICE_COOKIE='urbauth-~sampel-palnet=0v...' \
python3 scripts/setup-knowledge-mcp-tools.py
```

Requires `%lattice` `[0 3 9]`+ and the `%mcp-server` agent installed.
