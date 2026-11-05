#!/usr/bin/env bash
# Two-ship checks for public comments (lattice wiki specs/2026-11-04-public-comments).
# Ship B publishes a page with comments on, ship A comments on it over
# Ames, and the comment shows in the reader on both ships; then B's
# delete and its comments switch take it out and bring it back. Fake fleet
# ships only, never a real one. Cleans up after itself.
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
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
# until <secs> <cmd...>: until cmd succeeds
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$A_COOKIE")
BSHIP=$(sed -n 's/^urbauth-\(~[a-z-]*\)=.*/\1/p' "$B_COOKIE")
P="pubc$RANDOM"
BODY="hello from $ASHIP $P"
ENC=${BODY// /+}

cleanup() { B_ -o /dev/null -X POST "$B/page-del?name=$P"; }
trap cleanup EXIT

echo "==> B publishes $P with comments on"
is "page saved"       200 "$(code -H "$BK" -X POST "$B/page-save?name=$P&type=md&new=1" --data-binary "# $P")"
is "page published"   200 "$(code -H "$BK" -X POST "$B/page-share?name=$P&mode=shared")"
is "comments on"      200 "$(code -H "$BK" -X POST "$B/page-comments?name=$P&on=1")"
sleep 3

echo "==> A comments on it"
loc=$(A_ -o /dev/null -w '%{redirect_url}' -X POST "$A/comment-remote?ship=$BSHIP&page=$P" --data "body=$ENC")
case "$loc" in *"sent="*) ok "the redirect carries the sent comment";; *) fail "the redirect carries the sent comment" "$loc";; esac
view=${loc#*/apps/lattice}
plain=${view%%&sent=*}
in_inbox() { B_ "$B/comments-inbox" | jq -e --arg b "$BODY" '[.items[] | select(.body==$b)] | length == 1' >/dev/null; }
if until_ 60 in_inbox; then ok "B filed it"; else fail "B filed it"; fi
landed() { "$1" "${2}${plain}" | grep -qF "<p class=\"cmeta\">$ASHIP</p><p class=\"cbody\">$BODY</p>"; }
if until_ 30 landed B_ "$B"; then ok "B's reader shows it"; else fail "B's reader shows it"; fi
if until_ 90 landed A_ "$A"; then ok "A's reader shows it"; else fail "A's reader shows it"; fi
sent=$(A_ "$A$view")
if grep -qF "comment pending" <<<"$sent"; then fail "A's sent view drops pending once it landed"; else ok "A's sent view drops pending once it landed"; fi
pub=$(B_ "$B$plain" | grep -c "class=\"comment\"")
is "one comment shown" 1 "$pub"

echo "==> B turns comments off, then on"
is "comments off" 200 "$(code -H "$BK" -X POST "$B/page-comments?name=$P&on=0")"
gone() { ! landed B_ "$B"; }
if until_ 30 gone; then ok "off hides it"; else fail "off hides it"; fi
is "comments on again" 200 "$(code -H "$BK" -X POST "$B/page-comments?name=$P&on=1")"
if until_ 30 landed B_ "$B"; then ok "on shows it again"; else fail "on shows it again"; fi

echo "==> B deletes it"
id=$(B_ "$B/comments-inbox" | jq -r --arg b "$BODY" '[.items[] | select(.body==$b)][0].id')
is "deleted" 200 "$(code -H "$BK" -X POST "$B/comment-del?page=$P&id=$id")"
if until_ 30 gone; then ok "delete takes it out of B's reader"; else fail "delete takes it out of B's reader"; fi
pend=$(A_ "$A$view")
if grep -qF "comment pending" <<<"$pend"; then ok "A's sent view shows it pending again"; else fail "A's sent view shows it pending again"; fi

echo "$fails failure(s)"
exit $((fails > 0))
