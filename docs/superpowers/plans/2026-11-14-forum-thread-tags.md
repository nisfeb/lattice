# Forum Thread Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors and mods tag forum threads, and readers filter a board by tag and order it by latest comment.

**Architecture:** Tags live in one new grub per board, `/content/tags`, beside the post buckets, so no stored thread changes shape. The grub's presence is the signal that a host takes tags, carried in memory as a `unit` on `$board`. Two new actions carry tags, the pure libs enforce the rules, and the server-rendered forum pages gain a filter panel, an `active` sort and tag inputs with a native `datalist`.

**Tech Stack:** Hoon on grubbery (lattice desk under `code/`), Sail for the pages, bash and curl for ship suites. No client script.

**Spec:** `docs/superpowers/specs/2026-11-14-forum-thread-tags-design.md` (wiki `specs/2026-11-14-forum-thread-tags-design`). Read it first.

## Global Constraints

- Branch `feat-forum-tags` off `origin/main` (version 133 or later), in a new worktree `~/software/personal/lattice-forumtags`. Never work in `~/software/personal/lattice`.
- Commits as nisfeb <business@nisfeb.com>, no AI attribution, subject `type: summary` with no scope and at most 72 characters, body wrapped at 72. Never `--no-verify`.
- Do not push to `main` and do not bump `code/version.json`. A merge to `main` releases to ~ricsul-bilwyt and waits for sneagan.
- Ship work runs on a throwaway fake ship only: `VERE=~/software/vere-v4.6-linux-x86_64 PORT=<free port> scripts/hoon-build.sh check /tmp/forum-tags/b1`. Fleet set `lattice-dev` is not ours. Kill ships you start.
- A tag is `[a-z][a-z0-9-]*`, 1 to 24 characters. A thread carries at most 5 tags.
- The shapes of `post-core`, the post buckets and every existing action do not change.
- No `<script>` on forum pages.
- Comments and prose: no em-dashes, short sentences. Hoon comments follow the file's style.
- Hoon unit suites run with `scripts/offline-tests.sh <suite>`. Every `.hoon` file must build: `scripts/hoon-build.sh check`. `python3 scripts/onload-check.py` and `python3 scripts/code-closure.py` must pass.

## Plan-level calls (mine, differ slightly from the spec)

- **Nothing a person types as a tag is refused.** `+norm-tag` cleans any text into a valid tag or into nothing, and nothing is ignored like an empty input. This removes the "refused with a message" path from the forms, so a bad tag can never cost someone the post they just wrote. The host still drops any invalid tag a hand-made action carries.
- **One grub, not buckets.** A board of 2,500 threads with tags is one small map. Marked with a `ponytail:` comment naming the ceiling.
- **The old-host check runs against a new host with its marker removed**, which looks the same to a peer as a host on 133. That 133 drops unknown actions in silence is established by reading `+apply-forum-notice`.

## Review Focus

1. A tag typed in characters outside a to z, 0 to 9 (for example `日本語` or `!!!`): the thread still posts, with that tag left out. Test in Task 1.
2. A filter address written by hand (`?tags=BUG,<b>,nosuch,,bug`): invalid entries are ignored, a valid tag nobody uses shows an empty list with a way to clear it, and nothing from the address reaches the page as markup. Test in Task 4.
3. A thread that is deleted, pruned or culled by a ban: its tags leave the picker and the filter counts. Test in Task 3.
4. A tags grub that names post ids the board no longer has: counts and the picker ignore them and the board loads. Test in Task 2 and Task 4.
5. A hand-made tag POST against a board whose host has no marker: no action is sent, and the answer says the host does not take tags. Test in Task 6.

---

### Task 1: Types and rules

**Files:**
- Modify: `code/lib/lattice-forum-types.hoon`
- Modify: `code/lib/lattice-forum-rules.hoon`
- Test: `tests/lib/lattice-forum-rules.hoon`, `tests/lib/lattice-forum-types.hoon`
- Modify (literals only): every `tests/lib/lattice-forum-*.hoon` that writes a `board:ft` literal

**Interfaces:**
- Produces, in types:
  - `+$  tag  @tas`
  - `$board` gains a last field `tags=(unit (map post-id (set tag)))`. `~` means this board's host has no tags grub.
  - actions `[%set-tags name=board-name id=post-id tags=(set tag)]` and `[%new-post-tagged name=board-name title=@t url=(unit @t) body=(unit @t) tags=(set tag)]`. The board name stays first, as `+apply-forum-core` reads it from there.
- Produces, in rules:
  - `++  max-tags  5`
  - `++  valid-tag  |=(t=@ ?)`
  - `++  norm-tag  |=(t=@t (unit tag))`: lowercase, every run of characters outside `a-z0-9` becomes one `-`, leading characters that are not letters and trailing dashes are cut, the result is cut to 24, trailing dashes cut again, empty is `~`.
  - `++  norm-tags  |=(ts=(list @t) (set tag))`: `norm-tag` over each, the first `max-tags` distinct results in input order.
  - `++  clean-tags  |=(ts=(set @) (set tag))`: the valid ones, the first `max-tags` in `aor` order. For what a host receives.
  - `++  can-tag  |=([who=@p author=@p brd=board] ?)`: the author or a mod. Reuse `+can-delete`.

- [ ] **Step 1: Write the failing tests** in `tests/lib/lattice-forum-rules.hoon`

```hoon
++  test-norm-tag
  ;:  weld
    (expect-eq !>(`%bug-report) !>((norm-tag:fr 'Bug Report')))
    (expect-eq !>(`%bug-report) !>((norm-tag:fr '  bug__report!! ')))
    (expect-eq !>(`%v2) !>((norm-tag:fr '2-v2')))
    (expect-eq !>(~) !>((norm-tag:fr '日本語')))
    (expect-eq !>(~) !>((norm-tag:fr '!!!')))
    (expect-eq !>(~) !>((norm-tag:fr '')))
    (expect-eq !>(24) !>((met 3 (need (norm-tag:fr 'abcdefghijklmnopqrstuvwxyz-abc')))))
    (expect-eq !>(&) !>((valid-tag:fr (need (norm-tag:fr 'abcdefghijklmnopqrstuvw-xyz')))))
  ==
++  test-norm-tags
  ;:  weld
    (expect-eq !>((sy ~[%a %b])) !>((norm-tags:fr ~['a' 'A' '' 'b' '!!'])))
    (expect-eq !>(5) !>(~(wyt in (norm-tags:fr ~['a' 'b' 'c' 'd' 'e' 'f']))))
    (expect-eq !>(|) !>((~(has in (norm-tags:fr ~['a' 'b' 'c' 'd' 'e' 'f'])) %f)))
  ==
++  test-clean-tags
  ;:  weld
    (expect-eq !>((sy ~[%ok])) !>((clean-tags:fr (sy ~[%ok 'Bad Tag' '' '9x']))))
    (expect-eq !>(5) !>(~(wyt in (clean-tags:fr (sy ~[%a %b %c %d %e %f %g])))))
  ==
++  test-can-tag
  ;:  weld
    (expect-eq !>(&) !>((can-tag:fr ~nec ~nec brd)))   ::  the author
    (expect-eq !>(&) !>((can-tag:fr ~wet ~nec brd)))   ::  a mod
    (expect-eq !>(&) !>((can-tag:fr ~zod ~nec brd)))   ::  the host
    (expect-eq !>(|) !>((can-tag:fr ~bus ~nec brd)))   ::  anyone else
  ==
```

Use the suite's existing `brd` fixture (host `~zod`, `~wet` a mod), or add one shaped like the fixture in `tests/lib/lattice-forum-act.hoon`.

- [ ] **Step 2: Run** `scripts/offline-tests.sh lattice-forum-rules`. Expected: FAIL, the arms do not exist.
- [ ] **Step 3: Add the types and the rule arms.** Add `~` as the last field of every `board:ft` literal in `tests/lib/`.
- [ ] **Step 4: Run** `scripts/offline-tests.sh lattice-forum-rules lattice-forum-types lattice-forum-act lattice-forum-board lattice-forum-render`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: forum tag types and rules`

### Task 2: Board storage and the host marker

**Files:**
- Modify: `code/lib/lattice-forum-board.hoon` (`parts`, `+load`, `+assemble`, `+grubs`)
- Test: `tests/lib/lattice-forum-board.hoon`

**Interfaces:**
- Consumes: `tag`, `tags.board` from Task 1.
- Produces: the grub `/content/tags` holding `[%1 (map post-id (set tag))]`. `+load` sets `tags.board` to `[~ map]` when the grub is there and `~` when it is not. `+grubs` emits the grub only when `tags.board` is not `~`, with entries for posts the board no longer has left out. `+changed` and `+gone` need no change.

- [ ] **Step 1: Write the failing tests**

```hoon
::  a board written before tags loads, with no marker
++  test-load-no-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/posts/b0 [%1 (my ~[[1 core]])]]])
  ?>  ?=(%& -.r)
  (expect-eq !>(~) !>(tags.p.r))
::  the marker alone: an empty tags grub
++  test-load-empty-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/tags [%1 ~]]])
  ?>  ?=(%& -.r)
  (expect-eq !>(`~) !>(tags.p.r))
::  tags round-trip through +grubs and +load
++  test-tags-round-trip
  =/  b=board:ft  brd(posts (my ~[[1 pst]]), tags `(my ~[[1 (sy ~[%bug %idea])]]))
  =/  r  (load:fb ~(tap by (grubs:fb b)))
  ?>  ?=(%& -.r)
  (expect-eq !>(tags.b) !>(tags.p.r))
::  no marker in memory, no grub written
++  test-grubs-no-marker
  (expect-eq !>(|) !>((~(has by (grubs:fb brd)) /content/tags)))
::  tags for a post that is gone are not written back
++  test-grubs-drop-stale
  =/  b=board:ft  brd(tags `(my ~[[9 (sy ~[%bug])]]))
  (expect-eq !>([%1 ~]) !>((~(got by (grubs:fb b)) /content/tags)))
::  a tags grub of the wrong shape names itself, as the other grubs do
++  test-load-bad-tags
  =/  r  (load:fb ~[[/pub/card [%1 info]] [/content/tags 'junk']])
  (expect-eq !>(|+'unreadable: /content/tags') !>(r))
```

`info`, `core`, `pst` and `brd` are the suite's fixtures, or add them beside the existing ones.

- [ ] **Step 2: Run** `scripts/offline-tests.sh lattice-forum-board`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `tags=(unit (map post-id (set tag)))` to `parts`, a `[%content %tags ~]` case to `+load`, pass it through `+assemble`, emit it in `+grubs`. Comment the one-grub choice: `::  ponytail: one grub for a board's tags; bucket like posts if a board passes ~10,000 tagged threads`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: a board stores its tags beside its posts`

### Task 3: The state transition

**Files:**
- Modify: `code/lib/lattice-forum-act.hoon` (`+act`, `+drop-posts`)
- Test: `tests/lib/lattice-forum-act.hoon`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: `+act` handles `%set-tags` and `%new-post-tagged`. Both leave `tags.brd` non-null. Refusal texts: `'post not found'`, `'only its author or a moderator may tag a post'`, and for a tagged post the same texts `%new-post` gives.

- [ ] **Step 1: Write the failing tests**

```hoon
++  test-set-tags
  =/  b1=board:ft  (ok brd ~nec [%new-post %main 'hi' ~ ~])
  =/  b2=board:ft  (ok b1 ~nec [%set-tags %main 1 (sy ~[%bug %idea])])
  ;:  weld
    (expect-eq !>(`(my ~[[1 (sy ~[%bug %idea])]])) !>(tags.b2))
    ::  a mod and the host may, a bystander may not
    (expect-eq !>(&) !>((good (act:fa b1 ~wet now [%set-tags %main 1 (sy ~[%bug])]))))
    (expect-eq !>(&) !>((good (act:fa b1 ~zod now [%set-tags %main 1 (sy ~[%bug])]))))
    (expect-eq !>(|) !>((good (act:fa b1 ~bus now [%set-tags %main 1 (sy ~[%bug])]))))
    (expect-eq !>(|) !>((good (act:fa b1 ~nec now [%set-tags %main 7 (sy ~[%bug])]))))
    ::  the empty set clears, and keeps the marker
    (expect-eq !>(`~) !>(tags:(ok b2 ~nec [%set-tags %main 1 ~])))
    ::  invalid tags are dropped, valid ones kept, five at most
    (expect-eq !>(`(my ~[[1 (sy ~[%ok])]])) !>(tags:(ok b1 ~nec [%set-tags %main 1 (sy ~[%ok 'Bad One'])])))
    (expect-eq !>(5) !>(~(wyt in (~(got by (need tags:(ok b1 ~nec [%set-tags %main 1 (sy ~[%a %b %c %d %e %f])]))) 1))))
    ::  the write is the tags grub
    =/  r  (act:fa b1 ~nec now [%set-tags %main 1 (sy ~[%bug])])
    ?>  ?=(%& -.r)
    (expect-eq !>(&) !>((lien puts.p.r |=(g=grub:fb =(pax.g /content/tags)))))
  ==
++  test-new-post-tagged
  =/  b1=board:ft  (ok brd ~nec [%new-post-tagged %main 'hi' ~ `'body' (sy ~[%bug])])
  ;:  weld
    (expect-eq !>(`[1 ~nec 'hi' ~ `'body' now ~ ~ 0]) !>((~(get by posts.b1) 1)))
    (expect-eq !>(`(my ~[[1 (sy ~[%bug])]])) !>(tags.b1))
    ::  the same refusals as a plain post
    (expect-eq !>(|) !>((good (act:fa brd ~marzod now [%new-post-tagged %main 'hi' ~ ~ ~]))))
    (expect-eq !>(|) !>((good (act:fa brd ~nec now [%new-post-tagged %main '' ~ ~ ~]))))
  ==
++  test-drop-drops-tags
  =/  b1=board:ft  (ok brd ~nec [%new-post-tagged %main 'hi' ~ ~ (sy ~[%bug])])
  ;:  weld
    (expect-eq !>(`~) !>(tags:(ok b1 ~nec [%delete-post %main 1])))
    (expect-eq !>(`~) !>(tags:(drop-posts:fa b1 ~[1])))
    (expect-eq !>(`~) !>(tags:(cull:fa b1 |=(p=@p =(p ~nec)))))
  ==
```

- [ ] **Step 2: Run** `scripts/offline-tests.sh lattice-forum-act`. Expected: FAIL.
- [ ] **Step 3: Implement.** `%new-post-tagged` shares the `%new-post` branch's checks and post. Both actions run their tags through `clean-tags:fr`. `+drop-posts` deletes each id from the map when `tags.b` is not `~`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forum actions that set a thread's tags`

### Task 4: The pages

**Files:**
- Modify: `code/lib/lattice-forum-render.hoon`
- Test: `tests/lib/lattice-forum-render.hoon`, `tests/lib/lattice-forum-css.hoon` if it pins class names

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `+$  sort-mode  ?(%hot %new %top %active)`. `+parse-sort` takes `'active'`.
  - `+$  view  [mode=sort-mode page=@ud tags=(set tag) tq=@t]`
  - `++  parse-view  |=(args=(map @t @t) view)`: `tags` is the `tags` argument split on commas, each kept only if `valid-tag:fr`. `tq` is the `tq` argument cut to 24 characters.
  - `++  last-active  |=([brd=board p=post] @da)`: the newest comment's `created` under the post, or `created.p`.
  - `++  sort-by  |=([mode=sort-mode now=@da brd=board posts=(list post)] (list post))`: the signature gains `brd`.
  - `++  tags-of  |=([brd=board id=post-id] (list tag))`, `aor` order.
  - `++  tag-counts  |=(brd=board (list [=tag n=@ud]))`: tags on posts the board has, most used first, ties by `aor`.
  - `++  view-query  |=([mode=sort-mode tags=(set tag)] tape)`: `"sort=active&tags=bug,idea"`, tags in `aor` order, the `tags` part left out when empty.
  - `++  render-board  |=([c=ctx brd=board v=view] [title=@t body=manx])` and `++  render-list  |=([c=ctx brd=board v=view] manx)`.
  - `++  render-submit  |=([c=ctx brd=board] [title=@t body=manx])`: takes the board, not its name.
  - `++  tag-inputs  |=([brd=board have=(list tag)] manx)`: five `input(type "text", name "t1".."t5", list "tags", maxlength "40")` filled from `have`, and one `datalist#tags` of `tag-counts`.
  - Form fields `t1` to `t5`, and a form on the thread page posting to `{base}/{id}/tags`.

Page behaviour:
- The sort bar gains `active`. Every sort link, tag link and pagination link carries `view-query`, so a filter survives a sort change and paging.
- A `details` element labelled `Filter` after the sort bar, open when a filter or `tq` is set. It lists the 30 most used tags as links with their counts. A tag in the filter is marked and its link removes it. Others add themselves. Below, a GET form with one text field `tq` and hidden `sort` and `tags` fields. With `tq` set, the list is every tag containing `tq`, not the top 30.
- Above the list, when a filter is set: each tag with a `✕` link that removes it, and `clear`.
- The filter keeps threads that carry every tag in `tags.v`. It applies to pinned threads too.
- A thread row and the thread page show the thread's tags as links to `{base}?{(view-query %hot (sy ~[tag]))}`.
- Tag inputs, the edit-tags form, and the tags row of the submit form show only when `authed.c`, `tags.brd` is not `~`, the viewer is not a comet (`is-comet:fr who.c`), and for the edit form `can-tag:fr`. When `tags.brd` is `~` and the viewer could otherwise tag, the submit page shows one line: `This board's host does not take tags yet.`
- Chips and the panel use the forum's theme variables, as the existing classes in `+forum-css` do.

- [ ] **Step 1: Write the failing tests.** Use the suite's existing way of rendering to a string and searching it. Assertions:

```hoon
++  test-parse-view
  =/  v  (parse-view:fre (my ~[['sort' 'active'] ['tags' 'BUG,<b>,nosuch,,bug'] ['page' '2']]))
  ;:  weld
    (expect-eq !>(%active) !>(mode.v))
    (expect-eq !>(2) !>(page.v))
    (expect-eq !>((sy ~[%nosuch %bug])) !>(tags.v))
  ==
++  test-view-query
  ;:  weld
    (expect-eq !>("sort=active&tags=bug,idea") !>((view-query:fre %active (sy ~[%idea %bug]))))
    (expect-eq !>("sort=hot") !>((view-query:fre %hot ~)))
  ==
++  test-last-active
  ::  b: post 1 at ~2026.1.1 with a comment at ~2026.3.1, post 2 at ~2026.2.1 with none
  ;:  weld
    (expect-eq !>(~2026.3.1) !>((last-active:fre b (~(got by posts.b) 1))))
    (expect-eq !>(~2026.2.1) !>((last-active:fre b (~(got by posts.b) 2))))
    (expect-eq !>(~[1 2]) !>((turn (sort-by:fre %active now b ~(val by posts.b)) |=(p=post:ft id.p))))
  ==
++  test-tag-counts
  ::  tags: 1 -> bug idea, 2 -> bug, 9 (no such post) -> ghost
  (expect-eq !>(~[[%bug 2] [%idea 1]]) !>((tag-counts:fre b)))
```

and, on rendered pages:
- a board filtered by `bug` shows post 2 and not a post without it; filtered by `bug,idea` shows only post 1;
- filtered by `nosuch` shows no rows and a `clear` link;
- every pagination and sort link on a filtered page contains `tags=bug`;
- the page for `?tags=<b>` contains no `<b>` it did not have before;
- the submit page of a board with `tags ~` has no `name="t1"` and has the old-host line; with `` `~ `` it has `t1` to `t5` and a `datalist`;
- a comet viewer (`~sampel-sampel-sampel-sampel--sampel-sampel-sampel-sampel` or any 16-byte `@p`) sees no `t1`;
- the thread page shows the edit-tags form to the author and to a mod, not to another poster;
- no page contains `<script`.

- [ ] **Step 2: Run** `scripts/offline-tests.sh lattice-forum-render`. Expected: FAIL.
- [ ] **Step 3: Implement** the arms and the page changes above.
- [ ] **Step 4: Run** `scripts/offline-tests.sh lattice-forum-render lattice-forum-css`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: filter a board by tag and sort it by latest comment`

### Task 5: The app

**Files:**
- Modify: `code/nex/lattice/app.hoon`: `+forum-form-act`, `+serve-forum-owner`, `+serve-forum-public`, `+serve-forum-remote`, `+serve-forum-post`, `+serve-forum-remote-post`, `+forum-remote-apply`, `+apply-forum-core` (board creation), the writer start beside `+put-forum-comets`, `+urb-forum-json`, the `[%'POST' %forum-post-remote]` route, and any other caller of `render-board`, `render-submit` or `sort-by` (grep for them)
- Modify: `docs/forum.md`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `++  forum-form-tags  |=(grab=$-(@t (unit @t)) (set tag:ft))`: `norm-tags:fr` over fields `t1` to `t5`.
  - `+forum-form-act`: `[%submit ~]` gives `%new-post-tagged` when `forum-form-tags` is not empty and `takes=?` is true, else `%new-post`. `[@ %tags ~]` gives `%set-tags` when `takes`, else `~`. The gate gains a `takes=?` argument: whether the board has the marker.
  - `++  forum-tag-markers  |=(root=@ud form:m)`: for each board whose grubs have no `/content/tags`, put `[%1 ~]` there through `+forum-put`. Called at the writer start where `+put-forum-comets` is called first (near line 588). Never fails the start: a board that does not load is skipped.
  - A new board is created with `tags` set to `` `~ ``.
  - `+forum-remote-apply`: `%new-post-tagged` passes the `%new-post` checks. `%set-tags` needs no extra check, `+act` refuses with its own text.
  - `+urb-forum-json`: each post gains `'tags'` (array of strings, `aor` order) and `'active'` (`@da` as the other times are written).
  - `/forum-post-remote`: `op=post` with a `tags` field (comma separated, through `norm-tags:fr`) sends `%new-post-tagged`. `op=tag` with `post` and `tags` sends `%set-tags`. Before either tag action is sent, the remote board is read (`+forum-read-grubs-remote`, `+load:fb`), and when its `tags` is `~` the route answers 409 `this board's host does not take tags yet` and sends nothing.
  - `+serve-forum-remote-post` does the same check for a tag form, and redirects back to the board without sending.

- [ ] **Step 1: Wire the pages.** Replace each `(parse-sort:fre args) (parse-page:fre args)` pair with `(parse-view:fre args)`, pass the board to `render-submit:fre`, and thread `takes` into `forum-form-act`.
- [ ] **Step 2: Add `+forum-tag-markers`, the creation default, the remote gate, the JSON fields and the two JSON ops.**
- [ ] **Step 3: Build.** Run `VERE=~/software/vere-v4.6-linux-x86_64 PORT=<port> scripts/hoon-build.sh check /tmp/forum-tags/b1`. Expected: `every .hoon file under code/ built, bang null`.
- [ ] **Step 4: Static checks.** Run `python3 scripts/onload-check.py code/nex/lattice/app.hoon` and `python3 scripts/code-closure.py`. Expected: `0 uncovered`, and pass.
- [ ] **Step 5: Update `docs/forum.md`** with a short Tags section: who may tag, the limits, the filter and `active`, and that a host on an older version shows no tag fields.
- [ ] **Step 6: Commit** `feat: forum pages, routes and the host marker for tags`

### Task 6: Ship suites

**Files:**
- Create: `scripts/forum-tags.sh` (one ship)
- Modify: `scripts/two-ship-forum.sh`
- Modify: `.github/workflows/ci.yml` only if the other forum ship suites are listed there

**Interfaces:**
- Consumes: the routes of Task 5. Env as the other ship suites: `LATTICE_URL`, `LATTICE_COOKIE`, and for two ships `A_URL A_COOKIE B_URL B_COOKIE`.

- [ ] **Step 1: Write `scripts/forum-tags.sh`** in the style of `scripts/geojson-views.sh` and `scripts/two-ship-forum.sh` (`ok`, `fail`, `is`, a cleanup trap that deletes its board). Checks:
  - a new board's submit page has `name="t1"` and a `datalist`;
  - a thread posted with `t1=Bug Report&t2=idea&t3=!!!` shows `bug-report` and `idea` on its row, and the post landed;
  - a second thread with `t1=bug-report` makes the filter panel show `bug-report` with count 2;
  - `?tags=bug-report,idea` lists the first thread only, `?tags=nosuch` lists none and offers `clear`;
  - `?sort=active` puts a thread with a fresh comment above a newer thread with none;
  - posting to `/<board>/1/tags` with `t1=other` replaces the thread's tags;
  - the thread's `urb-read` JSON carries `tags` and `active`;
  - deleting the thread removes its tags from the filter panel;
  - no forum page contains `<script`.
- [ ] **Step 2: Add the upgrade check to `scripts/forum-tags.sh`** behind `OLD_CODE=<dir>` (a checkout of `origin/main`'s `code/`): deploy `OLD_CODE` with `scripts/dev-deploy.py`, make a board and a post, deploy this branch's `code/`, then check that the board page still lists the post, that the grubbery file API shows `/content/tags` under the board, and that the old post takes a tag.
- [ ] **Step 3: Extend `scripts/two-ship-forum.sh`:** B creates a tagged thread on A's board through B's `forum-remote` submit form, and it lands with its tags in one action. B edits its tags. B is refused when it tags A's thread (the thread's tags do not change). B's `forum-remote` board page filters by tag. Then A's marker is removed through the grubbery file API to stand in for an old host: B's submit page shows no `t1` and shows `does not take tags yet`, `op=tag` through B's `/forum-post-remote` answers 409, and a plain post from B still lands. B is not a mod, so the host's rate gate applies to it: wait out the cooldown between B's actions (ten seconds, doubling), as the script's existing B steps do, or a refusal for speed will read as a tag failure.
- [ ] **Step 4: Run** `scripts/forum-tags.sh` with `OLD_CODE` set on a throwaway ship, and `scripts/two-ship-forum.sh` on two throwaway ships. Use fresh ships that have never talked to a reset ship. Expected: every line `ok`.
- [ ] **Step 5: Run the rest of what the change can break:** `scripts/offline-tests.sh` (all suites), `scripts/hoon-build.sh check`, and the existing forum checks in `scripts/route-smoke.sh` if it covers forum routes.
- [ ] **Step 6: Commit** `test: ship suites for forum tags`

### Task 7: Hand back

- [ ] **Step 1:** Push `feat-forum-tags` and open a draft PR against `main` as nisfeb, titled `feat: tag forum threads, filter by tag, sort by latest comment`. The body lists what was run with counts, and what was not verified.
- [ ] **Step 2:** Watch CI to green. Do not merge.
