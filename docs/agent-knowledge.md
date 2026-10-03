# The knowledge store, for agents

Lattice keeps a **private, tagged knowledge store** on the ship. It is the
memory your AI agents share with you. Path-like keys (`user/ai-models`),
per-entry tags, history, and a restorable trash.

## MCP tools, compiled into the ship

The `lattice-*` tools live in grubbery's tool bundle
(`desk/gub/lib/tool-bundle/` in nisfeb/grubbery), compile into the ship's
`tools.tools` nexus, and are served by grubbery's own MCP endpoint at
`<ship>/grubbery/mcp`. They read the vault directly and write through
lattice's writer. `tools/list` advertises only `call_tool`, `echo` and
`list_tools`; call a lattice tool by name, or through `call_tool`.

| tool | does |
|---|---|
| `lattice-index` | **session start**: every key grouped by area, plus the full text of the `core` entries |
| `lattice-recall` | **per task**: the entries most relevant to a task description, with snippets, plus what they link to |
| `lattice-search` | ranked search (BM25), snippets, `"quoted phrase"` for verbatim; `weak` when nothing matched well |
| `lattice-read` | one entry: body, provenance, last checked, links, backlinks, `superseded_by` |
| `lattice-save` | create or update, with `author` and `source`; `expected_updated` refuses a stale write; a near-duplicate new key is refused unless `force_new` |
| `lattice-verify` | the entry was checked and still holds |
| `lattice-supersede` | the entry was replaced by another: search leaves it out, reading it points on |
| `lattice-lint` | what a tidy would fix (duplicates, broken links, stale entries, ...), proposals only |
| `lattice-explore` | filter by tag and/or substring; a category (`user`, `feedback`, ...) matches the key prefix |
| `lattice-tags`, `lattice-tag`, `lattice-untag` | the tag vocabulary, and cross-cutting tags |
| `lattice-move`, `lattice-delete`, `lattice-restore`, `lattice-list` | rename, soft-delete, undo, the full listing |

Client config, with a session cookie as the only auth:

```json
{ "mcpServers": { "myship": {
    "url": "https://your-ship.example.com/grubbery/mcp",
    "headers": { "Cookie": "urbauth-~your-ship=0v…" } } } }
```

A ship restart expires the cookie. Mint a fresh one at `/~/login` (see the
README's MCP section for the no-echo flow) and update the header.

## Recall

Search ranks with BM25 over the key (counted twice), the tags and the body.
Words are lower-cased, split on punctuation (`~ricsul-bilwyt` is one word and
also `ricsul` and `bilwyt`), stop words dropped and lightly stemmed. Each hit
carries a `strength`, the share of the query's weight the entry carries, and
an answer whose best hit is under 35 says `weak`: probably nothing is stored
about the question. The code is `+search` in `lib/lattice-know.hoon`, shared
by the tools, the `/know-search` route and the eval.

Measured on the live store (455 entries) with a private set of 42 questions
an agent would ask: the old whole-string substring search put an expected
entry in the top five for none of them; this ranking does for 40. Of five
questions about things never stored, four came back weak.

`scripts/know-eval.mjs` reruns that measurement. The question set is private,
so it lives as a lattice page (`eval/memory-recall`), not in this repo.

## Provenance and supersession

The tools keep each entry's record in front matter at the top of its body:

```
---
author: lattice-53
source: user
created: 2026-10-03
verified: 2026-10-03
verified-by: lattice-53
superseded-by: /feedback/newer-rule
---
the fact
```

`source` says whether the user said it or an agent inferred it. `verified`
is when it was last confirmed true, and an entry that names code (a file, an
arm, a port, a commit) and has not been checked for 30 days counts as stale.
A changed fact is saved as a new entry and the old one superseded, so search
returns the current fact while history keeps what was believed before.

Front matter is plain text, so it travels with the entry through moves,
trash, history, import and export, and anything that does not know about it
just shows it.

Revision history is read over HTTP (`know-history?key=`, `know-read-at?key=&rev=`),
not through MCP: the kernel checks a history read against the reader's own
marks, and grubbery's tools nexus does not carry lattice's, so every revision
would come back filtered out.

## Tidy

`/apps/lattice/know?lint=1` (linked from the knowledge view) lists what a
tidy would fix and offers one-click small edits: keep one of two duplicates,
clear a broken supersede link, mark a stale entry still true. Merging two
entries' text or fixing a link is a person's or an agent's job. Nothing runs
on its own. `lattice-lint` returns the same report to an agent.

## HTTP twins

Every tool has an owner-gated HTTP route under `/apps/lattice/know-*`
(`know-list`, `know-read?key=`, `know-save?key=` with the body as POST data,
`know-move?from=&to=`, `know-tag`/`know-untag?key=&tag=`, `know-delete`/
`know-restore?key=`, `know-explore?tags=&match=&q=`, `know-history?key=`,
`know-search?q=&k=&superseded=`, `know-lint`, `know-verify?key=&author=`,
`know-supersede?old=&new=`, `know-all` for a full export). The web app's
knowledge mode, the /know view, and the MCP tools all converge on the same
vault through the same writer.
