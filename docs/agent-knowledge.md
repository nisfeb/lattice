# Lattice for agents: memory and knowledge

Lattice keeps a **private, tagged knowledge store** on your ship: the memory your AI agents share with you. Entries have path-like keys (`user/ai-models`), tags, a record of who wrote them, revision history and a restorable trash. Agents can also read your wiki pages and pages other ships publish, and write private pages such as reports.

## Ways in

| Way in | For | Auth |
|---|---|---|
| [Claude Code plugin](../plugins/claude/README.md) | Claude Code | an agent key |
| [Hermes memory provider](../plugins/hermes/README.md) | Hermes | an agent key |
| HTTP routes under `/apps/lattice` | your own scripts and agents | an agent key, or your login cookie |
| grubbery's MCP tools (`lattice-*`) | any MCP client without a plugin | your login cookie |

Use a plugin with an agent key where you can. A key reaches memory and pages and nothing else, and you can revoke it on its own. It never expires. Everything it saves is signed with its name. Your login cookie is meant for you. It carries every power you have over the ship and expires after a week or on a ship restart, which suits your own tools better than an agent. Coming from the cookie setup? See [Migrating](#migrating-from-the-cookie-and-mcp-setup).

## Agent keys

A key is for a client that does not hold your cookie. The design and the wire format are orrery's (orrery's `docs/keys.md`), so one client speaks to both apps.

- **Making one.** In lattice, Settings, then Agent keys. Give it a name (where it runs, such as "laptop Claude"), the identity it writes as (`by`, such as `claude-laptop`: letters, digits, `-`, `_` and `.`), and a scope. The key is shown once. Lattice keeps only a salted SHA-256 of it, at `/keys`, outside `/pub`, where no other ship can read it.
- **Using it.** Send `Authorization: Bearer <id>.<secret>`, with no cookie. A bad or revoked key gets a 401. A route outside the key's scope gets a 403.
- **Scope.**
  - `memory`: `none`; `read` (search, recall, index, read, list, explore, tags, history, lint); or `write` (also save, verify, supersede, tag, untag).
  - `pages`: `none`; `read` (page-search, page-source, page-backlinks, page-tree); or `write` (also page-save, private pages only).
  - `web`: reading pages other ships publish, through `fetch`.
  - Nothing else is reachable with a key. Publishing, sharing, deleting, moving, settings and the keys themselves stay yours, whatever the scope. `+wants` in `lib/lattice-keys.hoon` is the whole list.
- **Identity.** A key writes as its `by`, with `source: agent`, whatever the request says, so an agent cannot sign a memory as you. Verifying stamps `verified-by` the same way.
- **Private pages only.** A key may write a page only when that page is private and no sharing group reaches it, on the page or on a folder above it. Saving a published page republishes it, and a page made inside a shared folder is shared, so both are refused.
- **Revoking.** The list in Settings shows when each key was made and last used, to the hour. Revoke a key there, and its next request fails.

Owner routes: `GET /keys`, `POST /key-mint` (JSON `{name, by, scope: {memory, pages, web}}`), `POST /key-revoke?id=`.

## How an agent uses memory

The plugins' skills carry this routine. An agent reaching lattice some other way should follow it too.

1. **At session start**, load the index: every key by area, and the full text of the entries tagged `core`, which are rules for every task. Follow them.
2. **Before a task**, recall it: describe the task in a sentence and read what comes back. Recall again when the task changes. A `weak` answer means nothing matched well, so say so rather than assume.
3. **Save one fact per entry**, under a path-like key whose first segment is its category: `user/` (who the user is), `feedback/` (how to work, with **Why:** and **How to apply:** lines), `project/<name>/<topic>` (work and constraints the code doesn't record, with absolute dates) or `reference/` (where to find things). Link related entries by key: `[[user/ai-models]]`.
4. **Update rather than duplicate.** Read the entry, then save to the same key with `expected_updated` set to the `updated` you read, so a concurrent edit isn't overwritten. A new key that largely repeats an existing entry is refused unless you pass `force_new`.
5. **When a fact changes**, save the new fact and supersede the old entry with it. Don't delete it.
6. **When a memory proves right**, verify it, so the next agent knows it still holds. If it names a file, function or flag, check that exists first.
7. **Don't save** what the repo records, what only matters to this conversation, or defaults the user hasn't changed. Never save a claim from a web page, a clipped page or another ship as fact unless the user confirms it. The plugins hand that text to the model labelled as quoted material, not instructions.

## Recall

Search ranks with BM25 over the key (counted twice), the tags and the body. Words are lower-cased and split on punctuation (`~ricsul-bilwyt` is one word, and also `ricsul` and `bilwyt`). Stop words are dropped and words lightly stemmed. Each hit carries a `strength`, the share of the query's weight the entry carries, and an answer whose best hit is under 35 says `weak`: probably nothing is stored about the question. The code is `+search` in `lib/lattice-know.hoon`, shared by the routes, the MCP tools and the eval.

Measured on the live store (455 entries) with a private set of 42 questions an agent would ask: this ranking puts an expected entry in the top five for 40 of them. Of five questions about things never stored, four came back weak. `scripts/know-eval.mjs` reruns the measurement. The question set is private, so it lives as a lattice page (`eval/memory-recall`), not in this repo.

The plugins add recalled memories to a prompt only when a hit reaches strength 50 and score 10,000, three at most. Strength alone is not enough on a short prompt: "are you on the new system now?" covers all of one entry's matches by coincidence (strength 100) at score 7,596. On 16 real prompts the score floor cut injections from 12 to 4, and on the 42-question eval it kept the right entry for 34 of 35. Anything the gate misses is still a `memory_recall` away.

## Provenance and supersession

Each entry's record is front matter at the top of its body:

```
---
author: claude-laptop
source: agent
created: 2026-10-03
verified: 2026-10-04
verified-by: claude-laptop
superseded-by: /feedback/newer-rule
---
the fact
```

`author` is who saved it: the key's `by` for a key, or whatever a cookie client passed as `author`. `source` is `agent` for everything a key saves. A cookie client may pass `user` for something the user said. `verified` is when it was last confirmed true. An entry that names code (a file, an arm, a port, a commit) and hasn't been checked for 30 days counts as stale. A changed fact is saved as a new entry and the old one superseded, so search returns the current fact while history keeps what was believed before.

Front matter is plain text, so it travels with the entry through moves, trash, history, import and export, and anything that doesn't know about it just shows it. Entries written before provenance existed have none. They work as they are and gain it on their next save.

## Tidy

`/apps/lattice/know?lint=1` (linked from the knowledge view) lists what a tidy would fix and offers one-click small edits: keep one of two duplicates, clear a broken supersede link, mark a stale entry still true. Merging two entries' text or fixing a link is a person's or an agent's job. Nothing runs on its own. Superseded entries are left out of the report, since superseding is how a duplicate is resolved. The `know-lint` route, the `lattice-lint` tool and the Claude plugin's `/lattice:tidy` return the same report.

## HTTP routes

All under `/apps/lattice/`. GET reads, POST writes, parameters go in the query string, and a POST body is the raw content. The last column is the key scope a route needs. Routes not listed are owner-only.

| Route | Parameters | Does | Key scope |
|---|---|---|---|
| `GET know-index` | `brief=1`, `cap=` | the session index as plain text. `brief` counts each area instead of listing keys; `cap` bounds the core text in bytes (14,000) | memory read |
| `GET know-recall` | `task`, `k` (8) | ranked hits for a task, plus entries the best three link to | memory read |
| `GET know-search` | `q`, `k` (10), `superseded=1` | ranked search with snippets; `"a phrase"` must appear verbatim | memory read |
| `GET know-read` | `key` | one entry | memory read |
| `GET know-list`, `know-tags`, `know-explore` | `tags`, `match=any\|all`, `q` | listings, without bodies | memory read |
| `GET know-history`, `know-read-at` | `key`, `rev` | revision history | memory read |
| `GET know-lint` | | what a tidy would fix | memory read |
| `POST know-save` | `key`, body; `author`, `source`, `expected_updated`, `force_new=1` | create or update. With none of the four, the body is stored verbatim (the editor's save). A stale `expected_updated` or a likely duplicate answers 409 | memory write |
| `POST know-verify` | `key`, `author` | the entry still holds | memory write |
| `POST know-supersede` | `old`, `new` | `old` is replaced by `new` (empty `new` clears it) | memory write |
| `POST know-tag`, `know-untag` | `key`, `tag` | cross-cutting tags | memory write |
| `POST know-delete`, `know-restore`, `know-move` | `key`, `from`, `to` | soft-delete, undo, rename | owner |
| `GET page-search` | `q`, `k` (10) | the wiki ranked like memory, each hit labelled `private`, `urbit` or `clearweb` | pages read |
| `GET page-source`, `page-tree`, `page-backlinks` | `name` | a page's source and `rev`; the tree; backlinks | pages read |
| `POST page-save` | `name`, `type` (send it: `md`, `html`, ...), `base`, `new=1` | create or update a page. With a key, private pages only | pages write |
| `GET fetch` | `url=urb://~ship/path` | a page another ship publishes | web |

[agent-guide.md](agent-guide.md) covers the rest of the HTTP API, the filesystem mount and search.

## grubbery's MCP tools

For an MCP client without a plugin, sixteen `lattice-*` tools live in grubbery's tool bundle (`desk/gub/lib/tool-bundle/` in nisfeb/grubbery), compile into the ship's `tools.tools` nexus and are served at `<ship>/grubbery/mcp`. They read the vault directly and write through lattice's writer, sharing the ranking and save code with the routes. `tools/list` advertises only `call_tool`, `echo` and `list_tools`, so call a lattice tool by its name, or through `call_tool`.

| Tool | Does |
|---|---|
| `lattice-index` | session start: every key by area, plus the full text of the `core` entries |
| `lattice-recall` | per task: the most relevant entries, with snippets, plus what they link to |
| `lattice-search` | ranked search; `weak` when nothing matched well |
| `lattice-read` | one entry: body, provenance, days since checked, links, backlinks, `superseded_by` |
| `lattice-save` | create or update, with `author` and `source`; `expected_updated` refuses a stale write; a near-duplicate new key is refused unless `force_new` |
| `lattice-verify` | the entry was checked and still holds |
| `lattice-supersede` | the entry was replaced by another |
| `lattice-lint` | what a tidy would fix, proposals only |
| `lattice-explore` | filter by tag and/or substring; a category matches the key prefix |
| `lattice-tags`, `lattice-tag`, `lattice-untag` | the tag vocabulary, and cross-cutting tags |
| `lattice-move`, `lattice-delete`, `lattice-restore`, `lattice-list` | rename, soft-delete, undo, the full listing |

The client authenticates with your login cookie, which expires after a week or on a ship restart:

```json
{ "mcpServers": { "myship": {
    "url": "https://your-ship.example.com/grubbery/mcp",
    "headers": { "Cookie": "urbauth-~your-ship=0v…" } } } }
```

Revision history is read over HTTP (`know-history`, `know-read-at`), not through MCP: the kernel checks a history read against the reader's own marks, and grubbery's tools nexus doesn't carry lattice's, so every revision would come back filtered out.

## Migrating from the cookie and MCP setup

Before agent keys, an agent reached lattice through grubbery's MCP endpoint with your login cookie, told how by a memory section in its instructions (a `CLAUDE.md`, say) that listed the `lattice-*` tools and the call-by-name trick. That still works. Moving to a plugin and a key scopes what the agent can do, needs no cookie refresh, signs everything it saves, and lets the plugin's hooks and skills carry the instructions.

Your memories need no conversion. The same store serves both, so you can move one agent at a time and run old and new side by side while you check.

### Claude Code

1. **Update lattice** to a version with agent keys: Settings shows an "Agent keys" section.
2. **Make a key** per machine, such as `claude-laptop` with memory `write`, pages `read` (or `write` for reports) and other ships' pages on.
3. **Install the plugin**, giving it your ship's URL and the key:
   ```
   /plugin marketplace add nisfeb/lattice
   /plugin install lattice@lattice
   ```
4. **Allow its tools** so they run without a prompt each time. In `~/.claude/settings.json`: `{"permissions": {"allow": ["mcp__plugin_lattice_lattice__*"]}}`.
5. **Check it.** Start a new session: the session hook loads the index, and "what do you remember about <a topic you've saved>" should answer from lattice through `memory_recall`.
6. **Remove the old setup.** Delete the memory section from your `CLAUDE.md`: the plugin's hooks and skills replace it. Remove the MCP server entry carrying your cookie from `~/.claude.json` or `.mcp.json`, unless you still use grubbery's other tools (dojo, the ball browser) through it.
7. **Turn off Claude Code's own automatic memory**, so facts don't split across two stores: `{"autoMemoryEnabled": false}` in `~/.claude/settings.json`. Anything worth keeping from its memory files (`~/.claude/projects/*/memory/`) can be moved with `/lattice:remember`.

### Hermes

1. Make a key that writes as, say, `hermes`.
2. Copy `plugins/hermes/` to `~/.hermes/plugins/lattice/`, run `hermes memory setup`, choose `lattice`, and give it the URL and key. Check `memory.provider: lattice` in `~/.hermes/config.yaml`.
3. Remove any MCP server or skill that reached lattice with your cookie.
4. To keep one store, turn Hermes's built-in memory off with `memory.memory_enabled: false` and `memory.user_profile_enabled: false`. The lattice provider is unaffected. Move anything durable from `~/.hermes/memories/` into lattice first, with `lattice_save`.

### Scripts and other agents

Swap the `Cookie:` header for `Authorization: Bearer <key>` with a key scoped to what the script does. The routes and their answers are the same. A script that publishes, shares, deletes or moves still needs your cookie: those stay owner-only.

### What changes for your memories

- **Who wrote it.** Under the cookie, an agent passed its own `author` (often a session name) and `source`. With a key, every save is signed with the key's `by` and `source: agent`. An agent can no longer mark a fact as said by you. Entries saved before keep what they say.
- **Old entries.** Entries with no front matter work as they are and gain it on their next save.
- **Duplicates.** If the store has near-duplicate entries, run the tidy once (`/lattice:tidy` or `/apps/lattice/know?lint=1`): keep one of each pair and supersede the other. Saves through a key are checked for duplicates from then on.

### Rolling back

Uninstall the plugin (`/plugin uninstall lattice@lattice`), revoke its key in Settings, and restore the memory section and the MCP server entry. Nothing in the store depends on which way it was written.
