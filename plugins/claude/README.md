# Lattice for Claude Code

This plugin makes lattice on your Urbit ship Claude's memory, and makes your wiki and other ships' published pages its knowledge.

- **At session start** a hook loads the memory index: every area, and the core rules (entries tagged `core`) in full, in two parts when they run past one hook's 10,000 characters.
- **On each prompt** a hook recalls memories that strongly match it, three at most, and adds them as background. A weak or merely coincidental match adds nothing.
- **Tools** cover memory (`memory_recall`, `memory_search`, `memory_read`, `memory_save`, `memory_verify`, `memory_supersede`, `memory_tag`, `memory_explore`, `memory_tidy`, `memory_index`) and knowledge (`wiki_search`, `wiki_read`, `wiki_write`, `web_read`).
- **Skills** say when and how to use them. **Commands:** `/lattice:recall`, `/lattice:remember`, `/lattice:tidy`.

Saving stays deliberate: nothing is extracted from your sessions automatically.

## Install

1. In lattice, open Settings, then Agent keys. Make a key: a name, the identity it writes as (such as `claude-laptop`), and its scope. Copy the key. It is shown once.
2. In Claude Code:
   ```
   /plugin marketplace add nisfeb/lattice
   /plugin install lattice@lattice
   ```
3. Give the plugin your ship's URL and the key when it asks. The key is kept in your system's credential store.
4. Optional, so tools run without a prompt each time: allow them in `~/.claude/settings.json`:
   ```json
   { "permissions": { "allow": ["mcp__plugin_lattice_lattice__*"] } }
   ```

Node 16 or later must be on your `PATH`.

## What a key can do

A key reaches only what its scope names. Publishing, sharing, deleting, settings and the keys themselves stay yours whatever the scope. Everything a key saves is signed with its name and `source: agent`, so you can always tell an agent's memory from yours. A key writes private pages only: never a published page, and never one inside a folder you share. Revoke a key in Settings, Agent keys, and its next request fails. See [docs/agent-knowledge.md](../../docs/agent-knowledge.md#agent-keys).

Pages from other ships, and pages you clipped from the web, come back to Claude labelled as quoted material, not instructions, and the memory skill tells it not to save their claims as fact without you.

## One memory, not two

Claude Code has its own automatic memory. Two stores drift apart, so with this plugin turn that one off in `~/.claude/settings.json`:

```json
{ "autoMemoryEnabled": false }
```

If your `CLAUDE.md` describes reaching lattice some other way (such as grubbery's MCP endpoint and a cookie), remove that section: the plugin's hooks and skills replace it. The full move, step by step, is in [Migrating from the cookie and MCP setup](../../docs/agent-knowledge.md#migrating-from-the-cookie-and-mcp-setup).

## Settings

- **Ship URL**: such as `https://urbit.example.com`.
- **Agent key**: from lattice's Settings.
- **Prompt recall strength** (default 50): memories are added to a prompt only when the best match is at least this strong, from 0 to 100, and also scores at least 10,000, so a short prompt that happens to share common words with an entry adds nothing. 101 turns prompt recall off. The session index loads either way.
