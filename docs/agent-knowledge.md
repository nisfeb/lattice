# The knowledge store, for agents

Lattice keeps a **private, tagged knowledge store** on the ship — the memory
your AI agents share with you. Path-like keys (`user/ai-models`), per-entry
tags, history, and a restorable trash.

## MCP tools — compiled into the ship

Eleven tools ship WITH the lattice desk (`grubbery-overlay/lib/mcp/
lattice-*.hoon`), are compiled into grubbery's ball on commit, execute in-ship
against the vault directly, and are served by grubbery's own MCP endpoint at
`<ship>/grubbery/mcp`. Nothing to install, register, or refresh — they survive
restarts, redeploys, and ball resets.

| tool | does |
|---|---|
| `lattice-list` | keys + tags + metadata, no bodies |
| `lattice-read` | one entry's body |
| `lattice-search` | substring across keys and bodies |
| `lattice-explore` | filter by tag and/or substring |
| `lattice-tags` | tag vocabulary with counts |
| `lattice-save` | create/overwrite (re-save restores a deleted key) |
| `lattice-move` | rename a key, history preserved |
| `lattice-tag` / `lattice-untag` | cross-cutting tags |
| `lattice-delete` / `lattice-restore` | soft-delete / undo |

Client config — a session cookie is the only auth:

```json
{ "mcpServers": { "myship": {
    "url": "https://your-ship.example.com/grubbery/mcp",
    "headers": { "Cookie": "urbauth-~your-ship=0v…" } } } }
```

A ship restart expires the cookie; mint a fresh one at `/~/login` (see the
README's MCP section for the no-echo flow) and update the header.

## HTTP twins

Every tool has an owner-gated HTTP route under `/apps/lattice/know-*`
(`know-list`, `know-read?key=`, `know-save?key=` with the body as POST data,
`know-move?from=&to=`, `know-tag`/`know-untag?key=&tag=`, `know-delete`/
`know-restore?key=`, `know-explore?tags=&match=&q=`, `know-history?key=`,
`know-all` for a full export). The web app's knowledge mode, the /know view,
and the MCP tools all converge on the same vault through the same writer.
