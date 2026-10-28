# Forums in lattice

Lattice hosts forums. A forum is a multi-author, threaded website, and lattice already hosts websites, so hosting a forum is a lattice capability rather than a separate app. This folds the furum forum into lattice and retires furum.

## What a forum is here

- A **board** is a category with a title, a description, a sidebar, a visibility (public or private), and per-ship roles (`%mod`, `%poster`, `%reader`).
- A **post** is a thread: a link, a text body, or both, with a title and an author.
- A **comment** is a threaded reply under a post, nesting by parent.
- **Votes** rank posts and comments by an HN-style hot score (more votes, younger, wins).
- Posts are stored in buckets of 100 so a large board loads fast.

## Reading and posting

- The owner manages and reads their boards in the authed web UI under `/apps/lattice/forum/<board>[/<post>]`.
- A **public** board is world-readable: anyone reads it over peer-to-peer scry, and an anonymous visitor reads it on the open web at the same `/apps/lattice/forum/<board>` address, read-only. It carries the nearest board theme.
- A **private** board is readable and postable only by invited members. The owner invites a ship (`POST /forum-invite?board=&ship=`), which grants that ship a read capability and adds it to the board's member roster, and the invitee gets a notice in their shared-with-me inbox. A non-member cannot read (the grant is the only door) and cannot post (the inbox refuses them with a note).
- A member on another ship posts by poking the host's public `/forum.sig` inbox. Authorship is taken from the Ames transport, never from the message, so a post cannot be forged. The host runs the board's role, size, and rate-limit rules and bans, and sends a note back when it refuses.

## Moderation

- Roles, delete post or comment (author or mod), pin, sidebar, edit board info, set public or private, and auto-prune (below a board's min-score past an age, on a six-hour sweep).
- The owner's banlist culls a banned ship's forum posts and comments across every board, and the ban's inbox drop refuses that ship's future posts.

## Not in this version

Paid boards, a cross-ship board directory, push notifications, and feed syndication (the HN and S2 feeds keep coming from the external cron). None of furum's data is migrated.

## Retiring furum (owner cutover, run after this ships and is verified)

The forum lives in lattice now, so the standalone furum app is decommissioned. This is a manual cutover the owner runs out of band, like a deploy. No data moves.

1. Confirm the lattice forum is live and verified on the ship (a board reads and posts, a private board gates, a cross-ship post lands).
2. Suspend the `%furum` Gall agent on the moon that runs it (`|nuke %furum` / `|suspend %furum` per the ship's setup).
3. Stop publishing the furum desk (it is no longer a source anyone installs).
4. Leave the old furum data in place or archive it; nothing is migrated into lattice.
