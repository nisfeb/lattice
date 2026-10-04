# Lattice for Hermes

A Hermes memory provider that makes lattice on your Urbit ship Hermes' memory, and makes your wiki and other ships' published pages its knowledge.

- **System prompt:** the memory index (every area, and the core rules in full) loads once per session.
- **Each message:** memories that strongly match it, three at most, are recalled and sent with that turn as recalled memory. A weak match adds nothing.
- **Tools:** `lattice_recall`, `lattice_search`, `lattice_read`, `lattice_save`, `lattice_verify`, `lattice_supersede`, `lattice_wiki_search`, `lattice_wiki_read`, `lattice_wiki_write`, `lattice_web_read`.

Nothing is extracted from conversations automatically. Saving is the agent's deliberate act.

## Install

1. In lattice, open Settings, then Agent keys. Make a key that writes as, say, `hermes`, with the scope you want. Copy the key. It is shown once.
2. Copy this directory to `~/.hermes/plugins/lattice/` (or `$HERMES_HOME/plugins/lattice/` for another profile).
3. Run `hermes memory setup`, choose `lattice`, and give it your ship's URL and the key. The key goes to `~/.hermes/.env` as `LATTICE_TOKEN`; the URL goes to `~/.hermes/lattice.json`.
4. Check `memory.provider: lattice` is set in `~/.hermes/config.yaml`.

To keep one memory instead of two, turn Hermes' built-in memory off in `~/.hermes/config.yaml` with `memory.memory_enabled: false` and `memory.user_profile_enabled: false`. The lattice provider is unaffected. Move anything durable from `~/.hermes/memories/` into lattice first. Coming from a setup that reached lattice with your login cookie? See [Migrating](../../docs/agent-knowledge.md#migrating-from-the-cookie-and-mcp-setup).

Optional, in `~/.hermes/lattice.json`: `"recall_strength": 50` sets how strong a match must be before it is added to a message, from 0 to 100. 101 turns per-message recall off.

## What a key can do

A key reaches only what its scope names. Publishing, sharing, deleting, settings and the keys themselves stay yours. Everything a key saves is signed with its name and `source: agent`. A key writes private pages only. Pages from other ships and clipped web pages come back labelled as quoted material, not instructions. See [docs/agent-knowledge.md](../../docs/agent-knowledge.md#agent-keys).
