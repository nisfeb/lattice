#!/usr/bin/env bash
# Two-ship checks for the inbox (lattice wiki specs/2026-11-05-notifications).
# B comments on a page of A's whose comet comments are held: B is no comet
# (the fake network has none), so it is filed, not held, and lands in A's
# Activity, which the badge count follows, and marking it read clears it.
# Then B replies to A's forum post and A sees it in Activity. Then B
# floods A with reply notes, poked from B's pier: A files at most 30 an
# hour from it, counts the rest in one item, and keeps the items before
# the flood; once A bans B, B's notes are dropped. Fake fleet ships only,
# never a real one. Cleans up after itself.
#
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as two-ship-links.sh takes them,
#         B_PIER and VERE for the flood (skipped without them).
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
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$A_COOKIE")
BSHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$B_COOKIE")
P="notify$RANDOM"
BRD="nb$RANDOM"
BODY="hello from $BSHIP $P"
ENC=${BODY// /+}
REPLY="reply from $BSHIP $BRD"

cleanup() {
  A_ -o /dev/null -X POST "$A/unban?ship=$BSHIP"
  A_ -o /dev/null -X POST "$A/page-del?name=$P"
  A_ -o /dev/null -X POST "$A/forum/$BRD/mod/delete"
}
trap cleanup EXIT

count() { A_ "$A/notify-count" | jq -r "$1"; }
echo "==> start from a read inbox"
is "notify-count answers" 200 "$(code -H "$AK" "$A/notify-count")"
is "mark all read" 200 "$(code -H "$AK" -X POST "$A/notify-read?all=1")"
is "nothing unread" 0 "$(count .unread)"
is "held-comments answers" array "$(A_ "$A/held-comments" | jq -r '.items | type')"
held0=$(count .held)

echo "==> A publishes $P with comments on and comets held"
is "page saved"     200 "$(code -H "$AK" -X POST "$A/page-save?name=$P&type=md&new=1" --data-binary "# $P")"
is "page published" 200 "$(code -H "$AK" -X POST "$A/page-share?name=$P&mode=shared")"
is "comments on"    200 "$(code -H "$AK" -X POST "$A/page-comments?name=$P&on=1")"
is "comets held"    200 "$(code -H "$AK" -X POST "$A/page-comets?name=$P&mode=held")"
sleep 3

echo "==> B comments on it"
B_ -o /dev/null -X POST "$B/comment-remote?ship=$ASHIP&page=$P" --data "body=$ENC"
one_unread() { [ "$(count .unread)" = 1 ]; }
if until_ 60 one_unread; then ok "A's badge count shows 1"; else fail "A's badge count shows 1" "$(A_ "$A/notify-count")"; fi
is "a planet's comment is not held" "$held0" "$(count .held)"
item=$(A_ "$A/notify" | jq -c --arg b "$BODY" '[.items[] | select(.body==$b)][0]')
is "Activity lists it"      comment "$(jq -r .kind <<<"$item")"
is "by B"                   "$BSHIP" "$(jq -r .who <<<"$item")"
is "on the page"            "$P" "$(jq -r .where <<<"$item")"
is "unread"                 false "$(jq -r .read <<<"$item")"
id=$(jq -r .id <<<"$item")
is "mark it read" 200 "$(code -H "$AK" -X POST "$A/notify-read?id=$id")"
is "reading clears the count" 0 "$(count .unread)"
is "and the item is read" true "$(A_ "$A/notify" | jq -r --arg i "$id" '.items[] | select(.id==$i) | .read')"

echo "==> A starts a board and posts, B replies"
is "board made" 303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$BRD&title=Notify+$BRD&role=poster")"
is "post made"  303 "$(code -H "$AK" -X POST "$A/forum/$BRD/submit" --data "title=First&body=a+post+to+reply+to")"
sleep 2
code -H "$BK" -X POST "$B/forum-remote/$ASHIP/$BRD/1/comment" --data "body=${REPLY// /+}" >/dev/null
has_reply() { A_ "$A/notify" | jq -e --arg b "$REPLY" '[.items[] | select(.body==$b and .kind=="reply")] | length == 1' >/dev/null; }
if until_ 90 has_reply; then ok "A sees B's reply in Activity"; else fail "A sees B's reply in Activity" "$(A_ "$A/notify" | head -c 400)"; fi
r=$(A_ "$A/notify" | jq -c --arg b "$REPLY" '[.items[] | select(.body==$b)][0]')
is "the reply names the board" "$BRD" "$(jq -r .where <<<"$r")"
is "and the post"              1 "$(jq -r .post <<<"$r")"
is "and its title"             First "$(jq -r .title <<<"$r")"
is "the badge count follows"   1 "$(count .unread)"
is "mark all read again" 200 "$(code -H "$AK" -X POST "$A/notify-read?all=1")"
is "all read"                  0 "$(count .unread)"

# flood <n> <tag>: B pokes A's /forum.sig with n reply notes, bodies
# "<tag> <i>", from a khan thread on B's pier. Prints %sent when done.
flood() {
  local base hoon
  base=$(A_ "$A/streams" | jq -r .base)
  hoon="=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  =/  n=@ud  0  |-  ^-  form:m  ?:  =(n $1)  (pure:m !>(%sent))  ;<  ~  bind:m  (poke [$ASHIP %grubbery] %grubbery-load !>([[/forum-note %& (stab '$base') %'forum.sig'] [%poke [/lattice %forum-note] [%reply-1 %$BRD 1 'Flood' $BSHIP (crip \"$2 {<n>}\")]]]))  \$(n +(n))"
  hoon=${hoon//\\/\\\\}; hoon=${hoon//\'/\\\'}
  printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$hoon']]]" |
    "$VERE" eval --jam -n 2>/dev/null |
    socat -T 300 -,ignoreeof UNIX-CONNECT:"$B_PIER/.urb/conn.sock" 2>/dev/null |
    "$VERE" eval --cue -n 2>/dev/null | tail -1
}
tagged() { A_ "$A/notify" | jq --arg t "$1 " '[.items[] | select(.body | startswith($t))] | length'; }
if [ -n "${B_PIER:-}" ] && [ -n "${VERE:-}" ]; then
  echo "==> B floods A with reply notes"
  TAG="flood$RANDOM"
  sent=$(flood 40 "$TAG")
  case "$sent" in *sent*) ok "B sent 40 notes" ;; *) fail "B sent 40 notes" "$sent" ;; esac
  held() { A_ "$A/notify" | jq -e --arg s "$BSHIP" '[.items[] | select(.title=="more notes held back" and .host==$s)] | length == 1' >/dev/null; }
  if until_ 120 held; then ok "A counts what it held back in one item"; else fail "A counts what it held back in one item" "$(A_ "$A/notify" | head -c 400)"; fi
  n=$(tagged "$TAG")
  if [ "$n" -le 30 ]; then ok "A filed at most 30 of them ($n)"; else fail "A filed at most 30 of them" "$n"; fi
  is "B's comment from before the flood stays" 1 "$(A_ "$A/notify" | jq --arg b "$BODY" '[.items[] | select(.body==$b)] | length')"
  is "B's reply from before the flood stays" 1 "$(A_ "$A/notify" | jq --arg b "$REPLY" '[.items[] | select(.body==$b)] | length')"
  echo "==> A bans B, and B's notes are dropped"
  is "ban B" 200 "$(code -H "$AK" -X POST "$A/ban?ship=$BSHIP")"
  sleep 2
  TAG2="banned$RANDOM"
  flood 1 "$TAG2" >/dev/null
  sleep 10
  is "a banned ship's note is not filed" 0 "$(tagged "$TAG2")"
  is "unban B" 200 "$(code -H "$AK" -X POST "$A/unban?ship=$BSHIP")"
else
  echo "skip  the flood checks: no B_PIER or VERE"
fi

echo "$fails failure(s)"
exit $((fails > 0))
