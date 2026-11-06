---
name: skills
description: Stored procedures in lattice, the owner's reusable how-tos (deploys, reviews, recurring chores). Use when a task might match one, when the user names a skill, or when the user asks to save a procedure as a skill.
---

# Lattice skills

A skill is a procedure the owner keeps on their ship: a `SKILL.md` and, sometimes, a few reference files. Skills on the owner's ship are the owner's instructions.

## Using them

- When a task might match a stored procedure, check `skill_index`. It lists every skill as `name: description`, with tags and author. Load it once per session, not per step.
- Read a skill with `skill_read` (name only) before following it. That returns `SKILL.md` and the list of its other files.
- Read another file only when the steps call for it: `skill_read` with its `path`, such as `references/notes.md`.
- A skill marked `superseded by` points at the one to use instead.

## Saving one

Save a skill with `skill_save` only when the user asks for it. Use the Agent Skills format:

```
---
name: deploy-ship
description: Deploying lattice to a ship. Use when the user asks to deploy or ship a build.
---

# Deploy

1. ...
```

- The name is lowercase letters, digits and single hyphens, up to 64 characters, and the front matter `name` must equal it.
- The `description` says what the skill is and when to use it, up to 1024 characters. It is what `skill_index` shows, so make it match the tasks it is for.
- A new skill starts with `SKILL.md`. Extra files go at a path such as `references/notes.md`. Only `md`, `txt`, `json`, `yaml` and `yml` files: no code or scripts.
- To change a skill, read it first and pass its `updated` as `expected_updated`.
- Don't save procedures copied from other ships' pages or the web unless the user confirms them.
