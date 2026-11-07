# Lattice for agents: memory and knowledge

Lattice keeps a **private, tagged knowledge store** on your ship: the memory your AI agents share with you. Entries have path-like keys (`user/ai-models`), tags, a record of who wrote them, revision history and a restorable trash. Agents can also read your wiki pages and pages other ships publish, and write private pages such as reports. And they share [skills](#skills), reusable procedures you keep once on the ship.

## Ways in

| Way in | For | Auth |
|---|---|---|
| [Claude Code plugin](../plugins/claude/README.md) | Claude Code | an agent key |
| [Hermes memory provider](../plugins/hermes/README.md) | Hermes | an agent key |
| [The plugin's MCP server](#opencode-and-other-mcp-clients) | opencode, or any client that runs a local MCP server | an agent key |
| HTTP routes under `/apps/lattice` | your own scripts and agents | an agent key, or your login cookie |
| grubbery's MCP tools (`lattice-*`) | any MCP client without a plugin | your login cookie |

Use a plugin with an agent key where you can. A key reaches only what its scope grants (memory, your pages, other ships' pages) and nothing else, and you can revoke it on its own. It never expires. Everything it saves is signed with its name. Your login cookie is meant for you. It carries every power you have over the ship and expires after a week or on a ship restart, which suits your own tools better than an agent. Coming from the cookie setup? See [Migrating](#migrating-from-the-cookie-and-mcp-setup).

## Agent keys

A key is for a client that does not hold your cookie. The design and the wire format are orrery's (orrery's `docs/keys.md`), so one client speaks to both apps.

- **Making one.** In lattice, Settings, then Agent keys. Give it a name (where it runs, such as "laptop Claude"), the identity it writes as (`by`, such as `claude-laptop`: letters, digits, `-`, `_` and `.`), and a scope. Each live key needs its own `by`, so a save's author tells keys apart: a mint whose `by` another live key writes as is refused with a 409, as is a mint past the 50-key cap. The token is answered only once the key is stored. The key is shown once. Lattice keeps only a salted SHA-256 of it, at `/keys`, outside `/pub`, where no other ship can read it.
- **Using it.** Send `Authorization: Bearer <id>.<secret>`, with no cookie. A bad or revoked key gets a 401. A route outside the key's scope gets a 403.
- **Scope.** Read and write are independent, and it is default-deny: a key reaches only what its scope grants. Build it in Settings, or send the JSON shape below.
  - `memory`: `none`; `read` (search, recall, index, read, list, explore, tags, history, lint); or `write` (also save, verify, supersede, tag, untag).
  - `pages`: `none`, or `read`/`write` over **all** pages, or **scoped** to named path subtrees with independent read and write sets. Read covers page-search, page-source, page-backlinks, page-tree; write adds page-save. A read-scoped key sees only its paths (the tree, search and backlinks are filtered to them).
  - `web` (other ships' pages): `off`; read **all** ships (through `fetch`, `urb-read`, `browse`, `browse-file`); or **scoped** per ship, each with its own read and write path sets. Write means `remote-save` to a page a peer shared to you for editing. The web scope never reaches the owner's own ship: on these routes our own pages take the `pages` scope, by its paths and sensitive clearance, the same as `page-source`. `browse` of our own ship is refused to every key, and `browse-file` of our own ship reads a page's code grub and nothing else (`/know`, `/keys` or any other grub is a 403).
  - `skills`: `none`; `read` (skills, skill, skill-file, skill-history, skill-read-at); or `write` (also skill-save, skill-supersede, skill-tag, skill-untag). See [Skills](#skills).
  - `sensitive`: clearance for content marked sensitive, both memories and pages ([Sensitive content](#sensitive-content)). Off unless you tick it.
  - `origin`: reserved. A source-ship hook in the mold that nothing reads or enforces yet.
  - Nothing else is reachable with a key. Publishing, sharing, deleting, moving, settings and the keys themselves stay yours, whatever the scope. `+wants` in `lib/lattice-keys.hoon` is the whole list.
- **Identity.** A key writes as its `by`, with `source: agent`, whatever the request says, so an agent cannot sign a memory as you. Verifying stamps `verified-by` the same way.
- **Writes land where the scope grants, published or not.** A key writes a page when its write scope covers that path. A write grant covers a published or shared page too, since granting the path is your explicit consent (this replaces the earlier blanket "private pages only" rule). A key still cannot publish a page, change its sharing, or move or delete it.
- **No code pages.** A key saves md, gmi, text, tex, css and index pages. A save with `type` hoon, html or js, or with no `type`, is refused with a 403. Hoon would run with lattice's own authority, and html or js would run in your browser.
- **A key's save is answered after it lands.** The writer checks a key's memory or skill save again against the entry as it is when written, since you may have tagged it core or marked it sensitive after the key read it. The route waits for that outcome and answers the writer's refusal as a 403 (or a 409 when another write came first), never an ok for a save that did not land.
- **Core is yours.** Every session loads the entries tagged `core` as rules, so only you add or remove the tag. A key cannot tag an entry or a skill `core`, and it cannot edit, supersede or untag one that has the tag. Those requests get a 403. Core entries that keys tagged before this rule show in a notice in the Knowledge view, where you keep each one (it then counts as yours) or untag it. The plugins quote any memory a key wrote, core or not, so it reaches the model as material, not instructions.
- **Sensitive content** (memories and pages) stays out of reach of keys without clearance. See below.
- **Revoking.** The list in Settings shows when each key was made and last used, to the hour. Revoke a key there, and its next request fails.

Owner routes: `GET /keys`, `POST /key-mint`, `POST /key-revoke?id=`, and for the core notice `GET /know-core-agents` (the live core entries a key wrote) and `POST /know-core-keep?key=` (keep one: it becomes `source: user`, with `kept: <day>`, and its `author` stays the key's). The mint JSON is `{name, by, scope}`, where `scope` is `{memory, pages, web, sensitive, skills}`: `memory` and `skills` are each `"none"|"read"|"write"` (absent is `none`; keys made before skills existed are `none`); `pages` is `{"all":"none|read|write"}` or `{"some":{"read":[path,...],"write":[path,...]}}`; `web` is `{"off":null}`, `{"all":null}` or `{"some":{"~ship":{"read":[...],"write":[...]}}}`; `sensitive` is a bool. The scope builder in Settings writes exactly this.

## Sensitive content

Some things should reach only the agents you trust with them: health, money, a family matter. This covers both **memories** and **pages**. Mark a memory sensitive, or mark a page or folder sensitive, and only you and keys cleared for sensitive content can see it.

- **Marking.** Put `sensitive: yes` in the entry's front matter (edit it in the knowledge view), or save it with `sensitive=1`. Any key may mark an entry sensitive. Only you can clear the mark (remove the line, or save with `sensitive=0`). A key's save never lowers it.
- **A key without clearance** never sees a sensitive entry. It is absent from the index, lists, tags, explore and the tidy, from search and recall results, from the entries recall links to, and from duplicate warnings. Reading, history, tagging, verifying or superseding it answers "not found". Saving over its key is refused.
- **A cleared key** finds sensitive entries only by asking: search, recall, or reading one by key. Listings never show them, so loading the index at session start exposes nothing, and a core rule marked sensitive does not load at session start for any key. Orrery's digest of your day is sensitive too: a cleared key gets it in the index only by asking with `world=1`, which taints the key. The plugins' automatic recall passes `sensitive=0`, which leaves sensitive entries out, so it never taints a key either.
- **Sensitive pages** work the same way, by path. Mark a page or a folder sensitive (the share panel's checkbox, or `POST /page-sensitive?name=&on=1`); a folder mark covers every page under it. A key without clearance never sees a sensitive page: it is filtered from the tree, search and backlinks, and page-source and history answer 403. Such a key cannot write a sensitive page either, even when the path is in its write scope. A cleared key reads them normally, and reading one taints the key just as a sensitive memory does.
- **No passing it on.** When a cleared key reads sensitive content, lattice records it, and for the next 12 hours that key's writes go only to sensitive destinations. A new memory it saves is sensitive and comes back marked (`"sensitive": true`); it may not edit, tag or supersede an ordinary memory, since an edited one would silently disappear for every other key. Its page writes follow the same rule: an already-sensitive page is fine, a new page it creates is marked sensitive, and flipping an existing non-sensitive page is refused. A foreign `remote-save` is refused outright, since a peer's page cannot be verified sensitive. So an agent cannot copy or paraphrase sensitive content into a place a key without clearance can read. The key list in Settings shows when the window ends.
- **Clearance is set when a key is made.** To clear an agent that already has a key, make a new key with clearance and give it to the agent.
- **What it does not do.** It decides what a key can read and where its writes land, which lattice enforces itself. It cannot stop a cleared agent from repeating what it read in its reply to you, or in an outside tool such as email. The text also reaches the agent's model provider, like everything an agent reads. Your login cookie, and grubbery's MCP tools that use it, see everything.

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
| `GET know-recall` | `task`, `k` (8), `sensitive=0` | ranked hits for a task, plus entries the best three link to | memory read |
| `GET know-search` | `q`, `k` (10), `superseded=1`, `sensitive=0` | ranked search with snippets; `"a phrase"` must appear verbatim. `sensitive=0` leaves sensitive entries out | memory read |
| `GET know-read` | `key` | one entry | memory read |
| `GET know-list`, `know-tags`, `know-explore` | `tags`, `match=any\|all`, `q` | listings, without bodies | memory read |
| `GET know-history`, `know-read-at` | `key`, `rev` | revision history | memory read |
| `GET know-lint` | | what a tidy would fix | memory read |
| `POST know-save` | `key`, body; `author`, `source`, `expected_updated`, `force_new=1`, `sensitive=1` (or `0`, owner only) | create or update. With none of these, the body is stored verbatim (the editor's save). A stale `expected_updated` or a likely duplicate answers 409. `force_new=1` skips the duplicate check | memory write |
| `POST know-save-batch` | JSON `{"items":[{"key","body", and any know-save option}]}`, at most 50; options are strings, or `true`/`false` for `"1"`/`"0"` | many saves in one request: one store read, one duplicate pass, one cache write, roughly ten times faster than single saves. Each item is checked exactly as `know-save` checks one, and against the earlier items. Answers `{"saved":n,"results":[...]}` in item order; a refused item carries `ok:false`, `status` and `error` and is not written, the rest are | memory write |
| `POST know-verify` | `key`, `author` | the entry still holds | memory write |
| `POST know-supersede` | `old`, `new` | `old` is replaced by `new` (empty `new` clears it) | memory write |
| `POST know-tag`, `know-untag` | `key`, `tag` | cross-cutting tags | memory write |
| `POST know-delete`, `know-restore`, `know-move` | `key`, `from`, `to` | soft-delete, undo, rename | owner |
| `GET page-search` | `q`, `k` (10) | the wiki ranked like memory, each hit labelled `private`, `urbit` or `clearweb` | pages read |
| `GET page-source`, `page-tree`, `page-backlinks` | `name` | a page's source and `rev`; the tree; backlinks. Filtered to the key's read paths, and sensitive pages hidden from an uncleared key | pages read |
| `POST page-save` | `name`, `type` (send it: `md`, `html`, ...), `base`, `new=1` | create or update a page. With a key: within its write scope, published or not, and not hoon, html or js | pages write |
| `POST page-save-batch` | JSON `[{name, type, body}]` | many page saves in one request, gated per item | pages write |
| `GET fetch` | `url=urb://~ship/path` | a page another ship publishes (our own: by the pages scope) | web read |
| `GET urb-read` | `url=urb://...`, `list=1` | what the reader shows at any urb:// address, as JSON: a published or shared page (with its public comments), a folder's entries, a forum board or thread, a tree file (binary as type and size), or the owner's own page or folder (published or not) through the key's page scope, filtered by its paths and sensitive clearance. `list=1` lists the folder, or the ship's root. 504 the ship does not answer, 404 nothing there for this ship, 403 the key's scope | web read (our own ship: the pages scope instead) |
| `GET browse`, `browse-file` | `ship`, `path` | a peer's shared tree, or one file in it. Our own ship: `browse` 403, `browse-file` only a page's code grub, by the pages scope | web read |
| `POST remote-save` | `ship`, `path`, body | save to a page a peer shared to you for editing | web write |

[agent-guide.md](agent-guide.md) covers the rest of the HTTP API, the filesystem mount and search.

## Skills

A skill is a reusable procedure, stored once on your ship and shared with every agent whose key can read skills: Claude Code on any machine, Hermes, opencode. It uses Anthropic's Agent Skills format, so a Claude Code skill moves in and out unchanged: a `SKILL.md` with front matter and a markdown body, plus optional reference files.

```
---
name: deploy-ship
description: Deploying lattice to a fleet ship. Use when the user asks to deploy or ship a build.
---
# Deploy

1. ...
```

- **Where they live.** In lattice's private store at `/skills/vault/<name>/skill`, beside `/know` and outside the page tree, one grub per skill holding `SKILL.md` and its files. They are not in the filesystem mount and no other ship can read them.
- **Names and files.** A name is lower-case letters, digits and single hyphens, 1 to 64 characters, not starting or ending with a hyphen. A file is a relative path of letters, digits, `.`, `-` and `_`, ending `.md`, `.txt`, `.json`, `.yaml` or `.yml`, with no empty, `.` or `..` segment, so a path never leaves its skill. At most 64 files a skill. A new skill starts with `SKILL.md`.
- **No code.** Text only. A skill never carries a script, html, js or hoon. Tools an agent can run are a separate, later registry that points at tools without shipping them. Claude Code does run a `` !`command` `` (at the start of a line or after whitespace) or a ` ```! ` fenced block when the skill is invoked, so only you write those: a key's save with one, in `SKILL.md` or any file, is a 403, and your save marks the skill as for the fields below.
- **Checked on save.** `SKILL.md` needs front matter whose `name` is the skill's own and a `description` of at most 1,024 bytes. Quoted values and YAML block descriptions (`>` or `|`) are read as YAML is. Other front matter lines and comments are kept as they are.
- **Permissions are yours.** Claude Code acts on some front matter: `allowed-tools` runs the tools it names with no prompt, Bash included, `hooks` registers commands for the session, and `shell` picks what runs `` !`command` `` lines. Since the plugin mirrors skills into Claude Code on every machine, an agent key may write only front matter that grants nothing: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `paths`, `metadata`, `license`, `compatibility`, `version`, `tags` and the provenance fields. Any other top-level field, including one a later Claude Code adds, a quoted or explicit key, or a front matter not closed by a line that is exactly `---`, refuses the key's save with a 403. Only you set the rest, in the Skills view or with the cookie on `skill-save`. Your save marks such a skill `permissions-by: owner` and `permissions-set: <day>` in its front matter, which the ship sets and no writer can; reads answer it as `owner_permissions: true`. A key may not edit a skill you marked, nor add a file to it: keeping your grant while a key rewrites the steps it covers would hand the key the grant, so it is refused rather than merged. A skill a key stored with such fields before this check stays unmarked, and the mirror leaves them out, until you write them yourself (saving it unchanged, or marking it sensitive, does not mark it). Removing them removes the mark.
- **The same rules as memory.** A key's save is signed with its `by` and `source: agent` in `SKILL.md`'s front matter, with `created`, `verified` and `verified-by`; saving another file stamps `SKILL.md` too. Every save is a revision. Tags work as for memories. A key may not tag a skill `core`, nor edit, add a file to, supersede or untag one tagged `core`. A deleted skill goes to the trash and comes back whole.
- **Sensitive skills.** `sensitive: yes` in the front matter, or a save with `sensitive=1`, marks a skill sensitive, and the rules are memory's: a key without clearance never sees it (absent from the index, "not found" on reads, history and tags, refused on saves). A cleared key lists it only by asking (`GET skills?sensitive=1`), so loading the index at session start exposes and taints nothing; reading one taints the key for 12 hours, and a tainted key's new skills are sensitive and it may not edit an ordinary one. Only you can clear the mark.
- **How an agent uses them.** Progressive disclosure, as Claude Code does: load the index (one `name: description` line each) at session start or when a task might match, read a skill's full `SKILL.md` when its description fits, and a reference file only when the steps call for it. Save a procedure as a skill when the user asks. The plugins carry this as `skill_index`, `skill_read` and `skill_save`. The Claude Code plugin also mirrors the skills into Claude Code's `skills/` (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`) at session start, so Claude Code loads them natively, and `import-skills.mjs` brings existing Claude Code skills in ([the plugin README](../plugins/claude/README.md#your-skills-as-claude-code-skills)).

| Route | Parameters | Does | Key scope |
|---|---|---|---|
| `GET skills` | `sensitive=1` | the index: `{"skills":[{name, description, tags, updated, author, sensitive, superseded_by, owner_permissions, files}]}`, by name | skills read |
| `GET skill` | `name` | `SKILL.md` as `body`, the index fields, and `files: [{path, bytes}]` | skills read |
| `GET skill-file` | `name`, `path` | one file: `{name, path, body, updated}` | skills read |
| `GET skill-history`, `skill-read-at` | `name`, `rev` | revisions, and the skill as of one | skills read |
| `POST skill-save` | `name`, `path` (`SKILL.md`), body; `expected_updated`, `sensitive=1` (or `0`, owner only), `author`, `source`, `new=1` | create or update one file. `new=1` creates only: a name that is taken, even by a save that races this one, is a 409. Answers `{ok, created, sensitive, owner_permissions, conflicted, prior, updated}`. A stale `expected_updated` saves and is flagged `conflicted`, as with memory. The owner's save with none of the options is stored verbatim, but for the `permissions-by` mark. A key's save that sets permissions, or edits a skill whose permissions you set, is a 403 | skills write |
| `POST skill-supersede` | `old`, `new` | `old` is replaced by `new` (`superseded-by` in its front matter); empty `new` clears it | skills write |
| `POST skill-tag`, `skill-untag` | `name`, `tag` | tags, folded to lower case | skills write |
| `POST skill-delete`, `skill-restore`, `skill-file-delete`; `GET skill-trash` | `name`, `path` | to the trash and back, drop one file, list the trash | owner |

The Skills view (Knowledge, then Skills) lists them with author and last change, and lets you read, edit, add files, tag core, mark sensitive, see history, delete and restore.

## Where your memories live

On your ship, in lattice's own store, not on any computer. Each memory is one entry under its key, with its tags, who saved it and when, every earlier revision, and a trash you can restore from. You read and edit them in lattice's knowledge view (`/apps/lattice/know`, or the knowledge mode in the editor's menu). Agents reach them only through their key, and only as its scope allows. They are not in the filesystem mount, which carries your pages only. `GET /apps/lattice/know-all` exports the lot as JSON (owner only), and `POST /know-import` reads such an export back.

## opencode and other MCP clients

The Claude Code plugin is two things: a small MCP server, `plugins/claude/server.mjs` (plain Node 16 or later, no dependencies), which offers the `memory_*`, `skill_*` and `wiki_*` tools, `urb_read`, `urb_list` and `web_read` over lattice's HTTP routes with an agent key; and Claude-specific wrapping around it, hooks that load the index at session start, add strong matches to each prompt and mirror the ship's skills, plus three skills (memory, wiki and skills) and commands. Any client that can run a local MCP server can use the server as it is, and the skill as its instructions.

For opencode, copy `plugins/claude/` somewhere, make a key for it (Settings, Agent keys), and add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lattice": {
      "type": "local",
      "command": ["node", "/path/to/lattice-plugin/server.mjs"],
      "environment": { "LATTICE_URL": "https://your-ship.example.com", "LATTICE_KEY": "<the key>" },
      "enabled": true
    }
  },
  "instructions": ["/path/to/lattice-plugin/skills/memory/SKILL.md", "/path/to/lattice-plugin/skills/wiki/SKILL.md", "/path/to/lattice-plugin/skills/skills/SKILL.md"]
}
```

The skill tells an agent without hooks to start each session with `memory_index`. Recall before each task is the agent's own job there, as the skill says.

ChatGPT cannot run a local server: it reaches MCP servers over HTTPS. That would need lattice to serve MCP itself, behind an agent key, which it does not do yet.

## grubbery's MCP tools

**When you need this.** For memory and pages, use an agent key: a plugin, or the server above. grubbery's MCP endpoint is for operating the ship itself, with tools for its files, its dojo and its forge, and it runs on your login cookie. That cookie carries every power you have over the ship, including reading sensitive memories with no clearance, and expires after a week or a restart. Give it only to an agent you would hand the ship to. Its own tools are documented in nisfeb/grubbery. On newer grubbery kernels it is served at `<ship>/grubbery/tools`, with `<ship>/grubbery/mcp` kept as an alias.

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
