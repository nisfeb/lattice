# Forum thread tags

Design, 2026-11-14. Status: draft for sneagan's review.

## Intent

People who use lattice forums asked to tag threads. They want tags for three things: to filter a board, to sort it, and to keep it organized. A busy board today is one flat list with three orders (hot, new, top) and pins. There is no way to say "show me only the bug threads" or "show me what people are talking about right now".

## What sneagan decided

- Tags go on threads (posts) inside a board. Boards themselves carry no tags.
- The thread's author can tag it. Admins can tag any thread.
- Tags are user defined. Anyone allowed to tag can make a new one.
- While tagging, the person sees the board's existing tags and can search them, so they pick an existing one where one fits.
- The board page gets a Filter button that filters by tag.
- Post date and latest comment date are orderings, not date windows.

## Calls made in the design (each one mine)

The list below was shown to sneagan in chat and approved as a set, except the reviewer-pass item, which is new since then.

- "Admins" means the board's mods and the ship that hosts the board. The forum has no separate admin role, and none is added.
- The reviewer pass on 2026-11-14 added these, also mine: the host marker, the one-poke tagged post, five inputs in the picker, no tags for comets, and an unchanged rate limit. Each is described under "How it is built".
- Tags can be set when the thread is created and changed afterwards. Mods can remove a tag from anyone's thread.
- A board's tag set is the tags in use on that board's threads. There is no separate tag list to manage. A tag nobody uses any more disappears from the picker.
- A tag is lowercase letters, digits and dashes, 1 to 24 characters, starting with a letter. Input is normalised before it is checked: lowercased, runs of spaces and underscores turned into one dash. So "Bug Report" becomes `bug-report`. A tag that still does not fit is refused with a message.
- A thread carries at most 5 tags.
- Picking two tags in the filter shows threads that carry both.
- Ordering by post date is today's `new` link, unchanged. Ordering by latest comment is a fourth sort link, `active`, newest first only. A thread with no comments uses its post date.
- A tag filter and a sort combine.
- A tag shown on a thread row is a link that applies that tag's filter.
- Active filters show above the list, each with a way to clear it.
- The filter and sort live in the page address (query arguments), so a filtered view can be linked, and paging keeps it.

## Goals

1. An author tags their own thread, at creation and later. A mod or the host tags any thread.
2. The tag input offers the board's existing tags and narrows as the person types.
3. A reader filters a board by one or more tags and orders it by hot, new, top or active.
4. All of it works for a board read from another ship (the `forum-remote` route), and an author on another ship can tag their own thread there.
5. Boards that exist today keep working. No stored thread is rewritten. Their threads have no tags until someone adds them.

## Non-goals

- Renaming or merging tags.
- Tags on boards, tags on comments, a tag page across boards.
- Date-window filters ("posted in the last week").
- Oldest-first orderings.
- A mod-managed fixed tag list, tag colours or descriptions.
- Tags on the anonymous open-web view beyond showing and filtering. Anonymous visitors never tag.

## Anti-goals

- A lattice upgrade must never leave a board unreadable. The board loader refuses a board when a grub it knows does not fit its shape, so the shape of the existing post buckets must not change.
- A ship on the new version and a ship on an older one must keep reading and posting to each other's boards. Tags may be missing across that gap. Posts must not start failing.
- No client script on forum pages. They are server-rendered today and stay that way.

## Constraints from the code (main at version 133)

- Types are in `code/lib/lattice-forum-types.hoon`. A stored post is a `post-core` in a bucket grub of 100 posts under `/content/posts/bN` (`code/lib/lattice-forum-board.hoon`). `+load` clams each known grub and fails the whole board on a mismatch. It ignores grubs it does not know.
- An action reaches a host as a noun under the mark `[/lattice %forum-action]`, clammed by the receiver. Changing the shape of an existing action, such as `%new-post`, breaks old and new ships against each other in both directions.
- The board page is rendered by `code/lib/lattice-forum-render.hoon`. `+parse-sort` reads `?sort=`, `sort-mode` is `?(%hot %new %top)`, 30 threads to a page. Query arguments arrive as a `(map @t @t)`, so a repeated key keeps one value.
- A board on another ship is rendered by `+serve-forum-remote`. It reads the host's whole board (`+forum-read-grubs-remote` peeks the board's `/pub` and `/content` directories, then `+load`) and renders it with the same `render-board` as a local board. Both the public grant and the private-invite grant cover `/content`. Its forms post through `+serve-forum-remote-post`, which pokes the host.
- `+urb-forum-json` is a separate thing: the JSON an agent key reads through `/urb-read`, at most the 100 newest posts.
- A host on version 133 drops an action it cannot clam without a note, and still acks the poke (`+apply-forum-notice`). There is no version or capability signal between ships today.
- A remote action passes a rate gate per ship and board first: ten seconds, doubling on each attempt, mods exempt. The sender of a post never learns the new post's id.
- A comet may only send `%new-post` and `%new-comment` (`+comet-refusal`).
- On the owner's own board, `+serve-forum-post` always redirects, and a refusal is only recorded as a fault.
- Remote actions pass the gates in `+forum-remote-apply`, and the rules are in `code/lib/lattice-forum-rules.hoon` (`+sane-post`, `+can-delete`, `+is-mod`, comet rules, rate limits).
- Every grub the app writes needs a covering on-load row (`scripts/onload-check.py`). Board content sits under `/forum/boards/*`, which is covered.
- Merging to `main` releases to ~ricsul-bilwyt. The merge waits for sneagan's go.

## How it is built (decided)

**Storage.** Tags are stored beside the posts, not inside them: new grubs under the board's `/content` (not a sibling directory, so the existing read grants cover them), holding a map from post id to its set of tags. The post buckets keep their shape, so no stored thread is rewritten. An older lattice that meets these grubs ignores them. Deleting or pruning a thread drops its tags.

**Host marker.** A ship has to know whether a board's host takes tags before it offers them, because an older host drops the new actions in silence. So a host on the new version makes sure every board has its tags grub, empty when the board has no tags, in the sweep the writer already runs at start. That is one small write per board, once, and no stored thread is touched. A ship reading a board treats the presence of that grub as "this host takes tags".

**Actions.** Two new actions. `%set-tags` sets a thread's whole tag set, `[%set-tags name=board-name id=post-id tags=(set @tas)]` or a shape close to it. `%new-post-tagged` is `%new-post` with a tag set, so a tagged thread is created in one poke: one pass through the rate gate, and no need to know the new id. Existing actions keep their shapes. The host checks who is asking (the author of that thread, a mod, or the host), normalises and checks each tag, and enforces the limit of 5. The host is the only place the rules are enforced. A client never decides.

**Tagging at creation.** The new-thread form has tag fields. With no tags filled in, the form sends the plain `%new-post` as today. With tags, it sends `%new-post-tagged`. If a tag is refused, the thread still lands with the tags that passed, and the author gets a note naming the refused one.

**Old hosts.** When the board's host has no marker, the forms show no tag fields and say in one line that this board's host does not take tags yet. The new actions are never sent to such a host, so nothing is dropped and nothing hangs. Reading still works, with no tags shown.

**Rate limit.** The rate gate is not loosened. A later tag edit by an author who is not a mod counts against the cooldown like any other action.

**Comets.** A comet cannot tag, at creation or later. The comet rule stays as it is and a comet's form shows no tag fields.

**Refusals on your own board.** The owner's HTTP handler runs the tag check before it pokes, so a bad tag comes back as a message on the form, not as a silent redirect.

**Picker.** Five small text inputs, one per tag, each with a native `datalist` of the board's tags in use, most used first. A `datalist` matches the whole value of its input, so one input per tag is what makes the suggestions work for every tag and not only the first, with no script. Empty inputs are ignored. The same five inputs make the edit-tags form on the thread page, filled with the thread's current tags.

**Filter.** The Filter button is a native disclosure (`details`) on the board page. It lists the board's tags with their thread counts. Each tag is a link that adds itself to, or removes itself from, the filter in the address. With many tags the list shows the most used and a small search form finds the rest. The address carries the filter as one argument, for example `?sort=active&tags=bug,idea`.

**Active sort.** A thread's last activity is the newest comment's time, or the post's time when there are none. It is computed from the board as loaded. Pinned threads stay on top as today.

**Remote boards.** The remote board page loads the whole board, tags included, so it renders the same Filter and sort over every thread with no extra work. The remote forms gain the tag fields when the host has the marker.

**Agents.** `+urb-forum-json` carries each post's tags and last activity time as extra fields. It takes no tag filter. The JSON posting route (`/forum-post-remote`, the `op=` route) gains a tag op, so an agent key or the desktop can tag within its scope.

**Where tags show.** On each thread row and on the thread page, as small links. On the thread page the author, a mod or the host also sees an edit-tags form.

## Left to the builder

- The exact grub layout for tags (one grub or buckets of 100 like posts) and where tags sit in the in-memory `$board`.
- The exact shapes of the two actions.
- Whether last activity is computed per render or kept, as long as a board of 2,500 threads does not render noticeably slower than today.
- The look of tag chips and the filter panel, using the forum's existing theme variables.
- How many tags the filter lists before it falls back to search.

## Tests

- Hoon unit tests beside the existing ones in `tests/lib/lattice-forum-*.hoon`: tag normalising and refusal, the limit, who may tag, filter by one and by two tags, the active order, a board with no tag grubs loads, deleting a thread drops its tags.
- An upgrade check: a board written by version 133 loads and renders on the new version with no tags, then takes one.
- `scripts/two-ship-forum.sh`: a remote author creates a tagged thread in one action and edits its tags later, a non-author non-mod is refused, a comet sees no tag fields, the remote page filters over the whole board.
- An old-host check: against a host on 133 the forms show no tag fields and the one-line notice, no tag action is sent, and an ordinary post to that host still lands.
- An upgrade check that every existing board has its marker after the writer starts.
- `scripts/onload-check.py` passes.

## Success

A person opens a busy board, clicks Filter, picks `bug`, switches to `active`, and sees the bug threads with the most recent discussion first. They start a thread, type `bu`, pick `bug` from the suggestions, and the thread shows up under that filter. A board from before the upgrade looks exactly as it did.
