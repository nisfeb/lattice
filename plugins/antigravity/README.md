# Lattice for Google Antigravity

This plugin makes lattice on your Urbit ship Antigravity's persistent memory, and makes your wiki, skills, and other ships' published pages its knowledge.

- **At session start** a `SessionStart` hook loads the memory index: every area, and the core rules (entries tagged `core`) in full. Core entries written by agent keys are wrapped as quoted material.
- **On each user prompt** a `PreInvocation` hook recalls memories that strongly match it, three at most, and injects them as background (deduplicated per user message in a private `0700` temp directory so tool-call loops do not re-recall). Agent-written hits are wrapped as quoted material. A weak or coincidental match adds nothing.
- **Tools** cover memory (`memory_recall`, `memory_search`, `memory_read`, `memory_save`, `memory_verify`, `memory_supersede`, `memory_tag`, `memory_explore`, `memory_tidy`, `memory_index`), skills (`skill_index`, `skill_read`, `skill_save`), and knowledge (`wiki_search`, `wiki_read`, `wiki_write`, `urb_read`, `urb_list`, `web_read`).
- **Rules and skills** (`rules/AGENTS.md`, `skills/memory`, `skills/skills`, `skills/wiki`) describe when and how to use them.

Saving stays deliberate: nothing is extracted from your sessions automatically.

## Install

1. In lattice, open **Settings**, then **Agent keys**. Make a key: a name, the identity it writes as (such as `agy-laptop`), and its scope. Copy the key. It is shown once.
2. Link or copy this directory into Antigravity's global plugins folder:
   ```bash
   mkdir -p ~/.gemini/config/plugins
   ln -s /path/to/lattice/plugins/antigravity ~/.gemini/config/plugins/lattice
   ```
   (Or copy the directory instead of symlinking.)
3. Create `~/.gemini/config/lattice.json` with restrictive permissions:
   ```bash
   install -m 600 /dev/null ~/.gemini/config/lattice.json
   cat > ~/.gemini/config/lattice.json <<'EOF'
   {
     "ship_url": "https://urbit.example.com",
     "key": "<id>.<secret>",
     "recall_strength": 50
   }
   EOF
   ```
   Alternatively, export `LATTICE_URL` and `LATTICE_KEY` (and optionally `LATTICE_RECALL_STRENGTH`) in your environment.
4. Restart Antigravity CLI (`agy`) or App. Check `/mcp` and `/hooks` to confirm the `lattice` server and hooks are active.

Node 16 or later must be on your `PATH`.

## Settings

Configuration is loaded in this order (first match wins per field):

1. Environment variables: `LATTICE_URL`, `LATTICE_KEY`, `LATTICE_RECALL_STRENGTH`
2. JSON file at `LATTICE_CONFIG` (if set), `${PLUGIN_DATA}/config.json` (if present), or `~/.gemini/config/lattice.json`

Fields:

- **`ship_url`**: your ship's web address, such as `https://urbit.example.com`. Must use `https://`, or `http://` only for loopback or LAN addresses. Redirects are never followed with the agent key.
- **`key`**: agent key from lattice's Settings (`<id>.<secret>`).
- **`recall_strength`** (default `50`): memories are added to a prompt only when the best match is at least this strong (`0` to `100`) and scores at least `10,000`. Set to `101` to turn automatic prompt recall off (the session index still loads).

## What a key can do

A key reaches only what its scope names. Publishing, sharing, deleting, settings, and the keys themselves stay yours whatever the scope. Everything a key saves is signed with its name and `source: agent`. A key writes private pages only. Pages from other ships, forum boards and threads, linked pages, clipped web pages, and agent-written memories and skills come back labelled as quoted material, not instructions. See [docs/agent-knowledge.md](../../docs/agent-knowledge.md#agent-keys).
