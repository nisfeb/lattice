#!/usr/bin/env bash
# Two-ship checks for a forum ban, a deleted comment and thread tags. A
# hosts a board and posts. B upvotes the post over Ames. A comments, B
# replies to that comment, and A deletes its comment: B's reply still
# shows in the thread. Then A bans B, and B's vote and reply are culled
# from the board.
#
# Tags, on a second board: B (not a mod) posts a tagged thread through
# its forum-remote form and it lands with its tags in one action; B
# edits its tags by form and by /forum-post-remote op=tag; B's tags form
# on A's thread is refused and A's tags stay; B's forum-remote board
# filters by tag. Then A's tags marker is deleted through the grubbery
# file API, standing in for an older host: B's submit and thread pages
# drop their tag inputs, B's tags form goes back to its thread unsent,
# the submit page says the host does not take tags yet, op=tag and a
# tagged op=post answer 409 and change nothing, and a post from B (by
# form, with tags it then drops, and by JSON) still lands.
# Fake ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them.
#         LATTICE_DESK: the lattice desk's path in A's ball. Unset, it is
#         discovered: the first of /apps/shell.shell/desks/lattice.desk
#         (dist kernel) and /apps/shell/desks/lattice.desk (develop
#         kernel) that answers.
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2]"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$3"; then fail "$1" "found [$2]"; else ok "$1"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$A_COOKIE")
BSHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$B_COOKIE")
BRD="fb$RANDOM"; BT="ft$RANDOM"
REPLY="orphan$RANDOM from B"

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/forum/$BRD/mod/delete"
  A_ -o /dev/null -X POST "$A/forum/$BT/mod/delete"
}
trap cleanup EXIT

# the thread as A's own urb-read JSON
thread() { A_ "$A/urb-read?url=urb%3A%2F%2F$ASHIP%2Fforum%2F$BRD%2F1"; }
ups()    { thread | jq -r '.post.up'; }
ncom()   { thread | jq -r '.comments | length'; }

echo "==> A starts $BRD and posts"
is "board made" 303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$BRD&title=Ban+$BRD&role=poster")"
is "post made"  303 "$(code -H "$AK" -X POST "$A/forum/$BRD/submit" --data "title=First&body=vote+on+me")"
sleep 2

echo "==> B upvotes it"
code -H "$BK" -X POST "$B/forum-remote/$ASHIP/$BRD/vote" --data "target=post-1" >/dev/null
voted() { [ "$(ups)" = 1 ]; }
if until_ 90 voted; then ok "B's vote lands"; else fail "B's vote lands" "$(thread | head -c 300)"; fi

echo "==> A comments, B replies to it, A deletes its comment"
is "A comments" 303 "$(code -H "$AK" -X POST "$A/forum/$BRD/1/comment" --data "body=top+from+A")"
# B's cooldown after its vote is 10 s
sleep 12
code -H "$BK" -X POST "$B/forum-remote/$ASHIP/$BRD/1/comment" --data "body=${REPLY// /+}&parent=0" >/dev/null
two() { [ "$(ncom)" = 2 ]; }
if until_ 90 two; then ok "B's reply lands"; else fail "B's reply lands" "$(thread | head -c 300)"; fi
is "A deletes its comment" 303 "$(code -H "$AK" -X POST "$A/forum/$BRD/1/delete-comment" --data "comment-id=0")"
is "one comment left" 1 "$(ncom)"
if A_ "$A/forum/$BRD/1" | grep -q "$REPLY"; then ok "the reply to a deleted comment still shows"; else fail "the reply to a deleted comment still shows"; fi

echo "==> A bans B: B's vote and reply go"
is "ban B" 200 "$(code -H "$AK" -X POST "$A/ban?ship=$BSHIP")"
culled() { [ "$(ups)" = 0 ] && [ "$(ncom)" = 0 ]; }
if until_ 30 culled; then ok "B's vote and reply are culled"; else fail "B's vote and reply are culled" "up $(ups), comments $(ncom)"; fi
is "A's post stays" First "$(thread | jq -r '.post.title')"
is "unban B" 200 "$(code -H "$AK" -X POST "$A/unban?ship=$BSHIP")"

echo "==> tags: A starts $BT, B tags through it"
R="$B/forum-remote/$ASHIP/$BT"
J="$B/forum-post-remote?host=$ASHIP&board=$BT"
B_()    { curl -s -m 60 -H "$BK" "$@"; }
at()    { A_ "$A/urb-read?url=urb%3A%2F%2F$ASHIP%2Fforum%2F$BT%2F$1"; }
atags() { at "$1" | jq -c '.post.tags'; }
# the thread ids B's forum-remote page lists, in page order
rids()  { B_ "$R$1" | ids; }
ids()   { grep -oE "/forum-remote/$ASHIP/$BT/[0-9]+\"" | sed -E 's|.*/([0-9]+)"|\1|' | awk '!s[$0]++' | tr '\n' ' ' | sed 's/ $//'; }
# B is no mod, so A's rate gate holds it to one action per cooldown,
# which doubles unless four cooldowns (40 s at its 10 s base) pass
# between the host taking them. A busy host takes a poke late, so send
# times say little: pace waits 45 s from when B's last action was SEEN
# to land (seen marks it), so the cooldown stays at its base and a
# refusal is never one for speed.
lastb=-100
seen()  { lastb=$SECONDS; }
pace()  { local w=$((lastb + 45 - SECONDS)); if [ "$w" -gt 0 ]; then sleep "$w"; fi; lastb=$SECONDS; }
title_is() { [ "$(at "$1" | jq -r '.post.title')" = "$2" ]; }
# B's forum-remote submit page, when it loaded (its form posts back to it)
RP="/apps/lattice/forum-remote/$ASHIP/$BT"
bsub()  { local p; p=$(B_ "$R/submit"); grep -qF "action=\"$RP/submit\"" <<<"$p" && printf '%s' "$p"; }
# B's refusal notes page, when it loaded
bnotes() { local p; p=$(B_ "$B/forum-notes"); grep -qF 'Refused posts' <<<"$p" && printf '%s' "$p"; }
tags_are() { [ "$(atags "$1")" = "$2" ]; }
is "A makes $BT" 303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$BT&title=Tags+$BT&role=poster")"
is "A posts a tagged thread" 303 "$(code -H "$AK" -X POST "$A/forum/$BT/submit" --data "title=Host+thread&t1=host")"
sleep 2

SUB=$(bsub)
has "B's submit page for A's board loads" 'name="title"' "$SUB"
has "it offers tag inputs" 'name="t1"' "$SUB"
hasnt "it does not say the host takes no tags" 'does not take tags yet' "$SUB"

pace
is "B posts a tagged thread by its forum-remote form" 303 "$(code -H "$BK" -X POST "$R/submit" \
  --data-urlencode 'title=From B' --data-urlencode 'body=b' --data-urlencode 't1=Remote Tag' --data-urlencode 't2=idea')"
if until_ 90 title_is 2 'From B'; then seen; ok "B's thread lands"; else fail "B's thread lands" "$(at 2 | head -c 300)"; fi
is "it lands with its tags, in one action" '["idea","remote-tag"]' "$(atags 2)"
is "its author is B" "$BSHIP" "$(at 2 | jq -r '.post.author')"
bsees() { B_ "$R/2" | grep -q 'From B'; }
until_ 60 bsees
has "B's page of its thread offers tag inputs" 'name="t1"' "$(B_ "$R/2")"
PG=$(B_ "$R/1")
has "B reads A's thread" 'Host thread' "$PG"
hasnt "B's page of A's thread offers no tag inputs" 'name="t1"' "$PG"

pace
is "B's tags form answers 303" 303 "$(code -H "$BK" -X POST "$R/2/tags" --data 't1=edited')"
if until_ 90 tags_are 2 '["edited"]'; then seen; ok "B edits its tags by form"; else fail "B edits its tags by form" "$(atags 2)"; fi

is "B's refusal notes are cleared" 303 "$(code -H "$BK" -X POST "$B/forum-notes/clear")"
has "B has no refusal notes" 'No refusals.' "$(bnotes)"
pace
is "B's tags form on A's thread answers 303" 303 "$(code -H "$BK" -X POST "$R/1/tags" --data 't1=hijack')"
refused() { bnotes | grep -q 'only its author or a moderator may tag a post'; }
if until_ 90 refused; then seen; ok "B is told it may not tag A's thread"; else fail "B is told it may not tag A's thread"; fi
is "A's thread keeps its tags" '["host"]' "$(atags 1)"

pace
is "op=tag is sent" true "$(B_ -X POST "$J" --data 'op=tag&post=2&tags=json-tag,Idea' | jq -r '.ok and .sent')"
if until_ 90 tags_are 2 '["idea","json-tag"]'; then seen; ok "B edits its tags by op=tag"; else fail "B edits its tags by op=tag" "$(atags 2)"; fi

has_rids() { [ "$(rids "$1")" = "$2" ]; }
if until_ 60 has_rids '?tags=host' 1; then ok "B's forum-remote page filters by host"; else fail "B's forum-remote page filters by host" "[$(rids '?tags=host')]"; fi
is "B's forum-remote page filters by json-tag" 2 "$(rids '?tags=json-tag')"
NS=$(B_ "$R?tags=nosuch")
has "B's forum-remote page loads for nosuch" "Tags $BT" "$NS"
is "B's forum-remote page lists none for nosuch" '' "$(ids <<<"$NS")"

pace
is "a tagged op=post is sent" true "$(B_ -X POST "$J" --data 'op=post&title=JSON+post&tags=JSON+Post' | jq -r '.ok and .sent')"
if until_ 90 title_is 3 'JSON post'; then seen; ok "the tagged op=post lands"; else fail "the tagged op=post lands" "$(at 3 | head -c 300)"; fi
is "with its tags" '["json-post"]' "$(atags 3)"
is "op=tag to a board B cannot read answers 504" 504 "$(code -H "$BK" -X POST "$B/forum-post-remote?host=$ASHIP&board=nosuch$RANDOM" --data 'op=tag&post=1&tags=x')"

echo "==> tags: A's marker goes, as on an older host"
DESK="${LATTICE_DESK:-}"
if [ -z "$DESK" ]; then
  for d in /apps/shell.shell/desks/lattice.desk /apps/shell/desks/lattice.desk; do
    [ "$(code -H "$AK" "${A_URL%/}/grubbery/ball$d/desk/data/lattice.lattice_app?info=1")" = 200 ] && { DESK=$d; break; }
  done
fi
CONTENT="${A_URL%/}/grubbery/ball$DESK/desk/data/lattice.lattice_app/forum/boards/$BT/content"
is "A's $BT has the marker" 200 "$(code -H "$AK" "$CONTENT/tags?info=1")"
is "the marker is deleted" 303 "$(code -H "$AK" -X POST "$CONTENT" --data 'action=delete-grub&filename=tags')"
is "the marker is gone" 404 "$(code -H "$AK" "$CONTENT/tags?info=1")"
has "A's submit page says its host does not take tags yet" 'does not take tags yet' "$(A_ "$A/forum/$BT/submit")"
# tags as A shows them now the marker (which holds them) is gone
T2=$(atags 2)
is "B's refusal notes are cleared again" 303 "$(code -H "$BK" -X POST "$B/forum-notes/clear")"
has "B has no refusal notes" 'No refusals.' "$(bnotes)"
nosubinputs() { local p; p=$(bsub) && ! grep -q 'name="t1"' <<<"$p"; }
if until_ 60 nosubinputs; then ok "B's submit page drops the tag inputs"; else fail "B's submit page drops the tag inputs"; fi
SUB=$(bsub)
has "B's submit page loads" 'name="title"' "$SUB"
hasnt "it has no tag inputs" 'name="t1"' "$SUB"
has "it says the host does not take tags yet" 'host does not take tags yet.' "$SUB"
noinputs() { local p; p=$(B_ "$R/2"); grep -q 'From B' <<<"$p" && ! grep -q 'name="t1"' <<<"$p"; }
if until_ 60 noinputs; then ok "B's page of its thread drops the tag inputs"; else fail "B's page of its thread drops the tag inputs"; fi
is "B's tags form goes back to its thread unsent" "${B_URL%/}$RP/2" \
  "$(curl -s -m 60 -o /dev/null -w '%{redirect_url}' -H "$BK" -X POST "$R/2/tags" --data 't1=late')"
OP=$(curl -s -m 60 -w '\n%{http_code}' -H "$BK" -X POST "$J" --data 'op=tag&post=2&tags=late')
is "op=tag answers 409" 409 "$(tail -1 <<<"$OP")"
has "saying the host does not take tags yet" "this board's host does not take tags yet" "$OP"
is "a tagged op=post answers 409" 409 "$(code -H "$BK" -X POST "$J" --data 'op=post&title=Late&tags=late')"

pace
is "B's form post with tags answers 303" 303 "$(code -H "$BK" -X POST "$R/submit" --data-urlencode 'title=Plain by form' --data-urlencode 't1=dropped')"
if until_ 90 title_is 4 'Plain by form'; then seen; ok "it lands"; else fail "it lands" "$(at 4 | head -c 300)"; fi
is "without its tags" '[]' "$(atags 4)"

pace
is "a plain op=post is sent" true "$(B_ -X POST "$J" --data 'op=post&title=Plain+by+JSON' | jq -r '.ok and .sent')"
if until_ 90 title_is 5 'Plain by JSON'; then ok "a plain post from B still lands"; else fail "a plain post from B still lands" "$(at 5 | head -c 300)"; fi
# B's actions reach A in order, so with posts 4 and 5 in, anything the
# 409s had sent would have landed before them
is "the refused op=tag changed nothing" "$T2" "$(atags 2)"
is "the refused op=post made no thread" 0 "$(A_ "$A/urb-read?url=urb%3A%2F%2F$ASHIP%2Fforum%2F$BT" | jq '[.posts[] | select(.title == "Late")] | length')"
is "A holds threads 1 to 5 only" '1 2 3 4 5' "$(A_ "$A/urb-read?url=urb%3A%2F%2F$ASHIP%2Fforum%2F$BT" | jq -r '[.posts[].id] | sort | map(tostring) | join(" ")')"
has "B gained no refusal note" 'No refusals.' "$(bnotes)"
is "B's plain posts left A without a marker" 404 "$(code -H "$AK" "$CONTENT/tags?info=1")"

echo "$fails failure(s)"
exit $((fails > 0))
