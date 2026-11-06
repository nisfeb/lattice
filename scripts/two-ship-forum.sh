#!/usr/bin/env bash
# Two-ship checks for a forum ban and a deleted comment. A hosts a board
# and posts. B upvotes the post over Ames. A comments, B replies to that
# comment, and A deletes its comment: B's reply still shows in the
# thread. Then A bans B, and B's vote and reply are culled from the
# board. Fake fleet ships only, never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them.
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$A_COOKIE")
BSHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$B_COOKIE")
BRD="fb$RANDOM"
REPLY="orphan$RANDOM from B"

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/forum/$BRD/mod/delete"
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

echo "$fails failure(s)"
exit $((fails > 0))
