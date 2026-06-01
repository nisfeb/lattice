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
| `/x/know/list/json` | keys + metadata + tags (no bodies) |
| `/x/know/read/<key…>/json` | one item `{key, body, updated, tags}` |
| `/x/know/all/json` | all items with bodies + tags |
| `/x/know/trash/json` | soft-deleted keys |
| `/x/know/tags/json` | tag vocabulary + counts (facets) |

Write (poke mark `%lattice-know`, `src==our`): `know-action` =
`[%save key body]` / `[%del key]` / `[%restore key]` / `[%move from to]` /
`[%tag key tag]` / `[%untag key tag]`. `move` renames a live entry (preserving
body/tags/vector); it no-ops if the target already exists (never clobbers).

Discovery is HTTP (owner-authenticated), not a scry — it takes query params:
`GET /apps/lattice/know-explore?tags=a,b&match=all|any&q=text` filters the live
store by a tag set (AND/OR) and a case-insensitive key/body substring, returning
the `know-list` shape. (The `lattice-explore` MCP tool below filters
`/x/know/all/json` client-side instead, so it needs no HTTP.)

These work today with the generic `scry-agent` / `poke-our-agent` MCP tools.

## Dedicated MCP tools

`scripts/setup-knowledge-mcp-tools.py` registers eleven clean-schema tools into a
running `%mcp-server` (compiled in its context, so **no lattice-side
dependency**):

| tool | params |
|---|---|
| `lattice-save` | `key`, `body` |
| `lattice-read` | `key` |
| `lattice-list` | — (returns each item's tags too) |
| `lattice-search` | `query` (case-insensitive substring over keys + bodies) |
| `lattice-explore` | `tag` and/or `query` (ANDed) — tag-filtered discovery |
| `lattice-delete` | `key` (soft) |
| `lattice-restore` | `key` |
| `lattice-move` | `key`, `to` (rename to a new key; preserves body + tags) |
| `lattice-tags` | — (tag vocabulary + counts; call before tagging) |
| `lattice-tag` | `key`, `tag` (normalized lower-case) |
| `lattice-untag` | `key`, `tag` |

**Tagging & discovery.** Tags are free-form, normalized to lower-case, and
cross-cut the path hierarchy. The intended agent flow: `lattice-tags` to see the
existing vocabulary (reuse tags, curb near-duplicates), `lattice-tag` to label an
item, then `lattice-explore` (or the app's Knowledge **Explore** mode) to pull
everything under a tag or matching a substring.

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
endpoint and an existing `LATTICE_COOKIE` skips login. The save/read/list/
search/delete/restore tools need `%lattice` `[0 3 9]`+; the tags + explore tools
need `[0 3 12]`+. Requires the `%mcp-server` agent installed. Verified end-to-end
on a fake ship: save → read → tag → explore → search → delete (soft) → restore
all round-trip.

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
