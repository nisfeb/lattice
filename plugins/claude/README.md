# Lattice for Claude Code

This plugin makes lattice on your Urbit ship Claude's memory, keeps your stored skills (reusable procedures) on hand, and makes your wiki and other ships' published pages its knowledge.

- **At session start** a hook loads the memory index: every area, and the core rules (entries tagged `core`) in full, in two parts when they run past one hook's 10,000 characters.
- **On each prompt** a hook recalls memories that strongly match it, three at most, and adds them as background. A weak or merely coincidental match adds nothing.
- **Tools** cover memory (`memory_recall`, `memory_search`, `memory_read`, `memory_save`, `memory_verify`, `memory_supersede`, `memory_tag`, `memory_explore`, `memory_tidy`, `memory_index`), skills (`skill_index`, `skill_read`, `skill_save`) and knowledge (`wiki_search`, `wiki_read`, `wiki_write`, `urb_read`, `urb_list`, and `web_read`, the old name of `urb_read`).
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

Node 16 or later must be on your `PATH` (Node 18 or later for `import-skills.mjs`, which uses `fetch`).

## What a key can do

A key reaches only what its scope names. Publishing, sharing, deleting, settings and the keys themselves stay yours whatever the scope. Everything a key saves is signed with its name and `source: agent`, so you can always tell an agent's memory from yours. A key writes pages only within the paths its write scope grants (a granted path may be a published one); it can never publish, share, move or delete. Revoke a key in Settings, Agent keys, and its next request fails. See [docs/agent-knowledge.md](../../docs/agent-knowledge.md#agent-keys).

The `skills` part of a key's scope is `none` (the default), `read` (`skill_index` and `skill_read`) or `write` (`skill_save` too). A key sees sensitive skills only when it is cleared for sensitive material and asks for them (`skill_index` with `sensitive: true`). Skills a key saves carry its name as author and `source: agent` in their front matter.

## Skills

A skill is a procedure in the Agent Skills format: a `SKILL.md` with front matter `name` and `description`, then markdown, plus optional files (`md`, `txt`, `json`, `yaml` only, no code).

- `skill_index`: every skill as `name: description`, with tags and author. Optional `sensitive`.
- `skill_read`: `name`, and optional `path`. With no path it returns `SKILL.md` and the skill's file list; with a path, such as `references/notes.md`, that file.
- `skill_save`: `name`, `body` (the whole file), optional `path` (default `SKILL.md`), `expected_updated` (the `updated` you read, when editing) and `sensitive`. A new skill starts with `SKILL.md`.

The plugin's skills skill tells Claude to check the index when a task might match, and to save a skill only when you ask.

### Your skills as Claude Code skills

At session start a hook mirrors the ship's skills into `skills/` in Claude Code's config dir (`$CLAUDE_CONFIG_DIR`, else `~/.claude`, so a second account or a harness like reins gets them too), where Claude Code loads them like any other skill, triggering included, and picks up changes without a restart. Set the plugin's `skills_dir` option to mirror somewhere else, or to `off` to turn it off.

- It writes only directories it owns: each holds a `.lattice-skill.json` marker naming that directory. A skill of your own with the same name is left alone, and the session start says so. A copy of a mirrored skill under another name is yours, and so is anything behind a link you put inside one.
- A skill deleted or superseded on the ship is removed from the mirror. A file you add inside a mirrored skill is kept.
- Sensitive skills are never written to disk. A key without the `skills` scope mirrors nothing.

To bring skills you already have into lattice once, run `import-skills.mjs` from the plugin directory with a key that has `skills` write:

```
LATTICE_URL=https://your-ship.example.com LATTICE_KEY=<key> node import-skills.mjs          # what it would do
LATTICE_URL=https://your-ship.example.com LATTICE_KEY=<key> node import-skills.mjs --yes    # do it
```

With no directories named it reads that same `skills/` and every installed plugin's `skills/`. It imports `SKILL.md` and its text files (md, txt, json, yaml), lists the files it leaves out (scripts and the like), and lists a skill the ship already has as a duplicate to merge by hand rather than overwriting it. After importing, the mirror carries the ship's copy, so remove your local one when you are happy with it.

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
- **Skills directory** (default empty): where the ship's skills are mirrored, `$CLAUDE_CONFIG_DIR/skills` (else `~/.claude/skills`) when empty. `off` turns the mirror off.
