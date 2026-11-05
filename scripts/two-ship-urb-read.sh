#!/usr/bin/env bash
# Two-ship checks for the plugin's urb_read and urb_list (+serve-urb-read).
# Ship A publishes a page, shares a private page and a folder with ship B
# alone, and starts a forum board. B's agent key, through the plugin's MCP
# server, reads each of them by its urb:// address, and B's own private
# page too. Fake fleet ships only, never a real one. Cleans up after
# itself on both ships, so it re-runs.
#
# Usage:  scripts/two-ship-urb-read.sh
# Env:    A_URL, A_COOKIE (a file holding A's raw cookie), B_URL, B_COOKIE
#
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0
ok()    { echo "ok    $1"; }
fail()  { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()    { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()   { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2] in: $(head -c 300 <<<"$3")"; fi; }
hasnt() { if grep -qF -- "$2" <<<"$3"; then fail "$1" "unexpected [$2]"; else ok "$1"; fi; }
A_()    { curl -s -m 60 -H "$AK" "$@"; }
B_()    { curl -s -m 60 -H "$BK" "$@"; }
code()  { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
# until_ <secs> <cmd...>: until cmd succeeds
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

ASHIP=$(A_ "${A_URL%/}/~/host"); BSHIP=$(B_ "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
P=urbrd$$; BRD=urbrd$$; KEY=; WKEY=

# mcp <tool> <json args>: one tools/call to the plugin's MCP server, as B's key
mcp() {
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | LATTICE_URL="$B_URL" LATTICE_KEY="$TOK" command node "$(dirname "$0")/../plugins/claude/server.mjs" \
    | jq -r '.result.content[0].text'
}
read_() { mcp urb_read "{\"url\":\"$1\"}"; }

cleanup() {
  for k in $KEY $WKEY; do B_ -o /dev/null -X POST "$B/key-revoke?id=$k"; done
  B_ -o /dev/null -X POST "$B/page-del?name=${P}x"
  B_ -o /dev/null -X POST "$B/know-delete?key=$P/secret"
  A_ -o /dev/null -X POST "$A/page-del?name=$P"
  A_ -o /dev/null -X POST "$A/share-group-del?name=${BSHIP#\~}"
  A_ -o /dev/null -X POST "$A/forum/$BRD/mod/delete"
  B_ -o /dev/null -X POST "$B/page-del?name=$P"
}
trap cleanup EXIT

echo "==> A publishes, shares and posts"
is "A makes a published page" 200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/pub&type=md&new=1" --data-binary '# Published by A')"
is "  ...and publishes it"     200 "$(code -H "$AK" -X POST "$A/page-share?name=$P/pub&mode=shared")"
is "A makes a clearweb page"   200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/cw&type=md&new=1" --data-binary '# Clearweb by A')"
is "  ...on the clearweb"      200 "$(code -H "$AK" -X POST "$A/page-share?name=$P/cw&mode=clearweb")"
is "A makes an html page"      200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/h&type=html&new=1" --data-binary '<h1>Html by A</h1><script>evil()</script><p>a &amp; b</p>')"
is "  ...and publishes it"     200 "$(code -H "$AK" -X POST "$A/page-share?name=$P/h&mode=shared")"
is "A makes a private page"    200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/priv&type=md&new=1" --data-binary '# Private for B')"
is "  ...shares it with B"     true "$(A_ -X POST "$A/share-file?name=$P/priv&ship=$BSHIP&mode=read" | jq -r .ok)"
is "A makes an unshared page"  200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/hid&type=md&new=1" --data-binary '# Not for B')"
for n in one two; do
  is "A makes dir/$n"          200 "$(code -H "$AK" -X POST "$A/page-save?name=$P/dir/$n&type=md&new=1" --data-binary "# Dir $n")"
done
is "A shares the folder with B" true "$(A_ -X POST "$A/share-file?name=$P/dir&ship=$BSHIP&mode=read" | jq -r .ok)"
is "A opens comments on the page" 200 "$(code -H "$AK" -X POST "$A/page-comments?name=$P/pub&on=1")"
is "A starts a board"          303 "$(code -H "$AK" -X POST "$A/forum/_new" --data "name=$BRD&title=Urb+$BRD&role=poster")"
is "  ...and posts"            303 "$(code -H "$AK" -X POST "$A/forum/$BRD/submit" --data "title=First+post&body=forum+body+by+A")"
is "B makes its own private page" 200 "$(code -H "$BK" -X POST "$B/page-save?name=$P/mine&type=md&new=1" --data-binary '# Mine, private')"
sleep 3
B_ -o /dev/null -X POST "$B/comment-remote?ship=$ASHIP&page=$P/pub" --data "body=comment+from+B"
B_ -o /dev/null -X POST "$B/forum-remote/$ASHIP/$BRD/1/comment" --data "body=reply+from+B"

j=$(B_ -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary \
  "{\"name\":\"urb-read\",\"by\":\"two-ship-urb-read\",\"scope\":{\"memory\":\"none\",\"pages\":{\"some\":{\"read\":[\"/$P\"],\"write\":[]}},\"web\":{\"all\":null},\"sensitive\":false}}")
KEY=$(jq -r .key.id <<<"$j"); TOK=$(jq -r .token <<<"$j")
[ -n "$TOK" ] && [ "$TOK" != null ] || { fail "B mints a key" "$j"; exit 1; }

echo "==> B's key reads A by urb:// address"
r=$(read_ "urb://$ASHIP/$P/pub")
has "a. a published page"         "Published by A" "$r"
has "  ...quoted"                 "<quoted from=\"urb://$ASHIP/$P/pub\">" "$r"
cm() { read_ "urb://$ASHIP/$P/pub" | grep -qF 'comment from B'; }
if until_ 60 cm; then ok "f. its public comments"; else fail "f. its public comments"; fi
has "  ...quoted apart from the page" "<quoted from=\"the public comments on urb://$ASHIP/$P/pub\">" "$(read_ "urb://$ASHIP/$P/pub")"
has "b. a page shared with B alone" "Private for B" "$(read_ "urb://$ASHIP/$P/priv")"
has "  ...said to be shared"        "shared with this ship" "$(read_ "urb://$ASHIP/$P/priv")"
has "c. a clearweb page"            "Clearweb by A" "$(read_ "urb://$ASHIP/$P/cw")"
r=$(read_ "urb://$ASHIP/$P/h")
has "h. an html page, as text"      "Html by A" "$r"
has "  ...entities decoded"         "a & b" "$r"
hasnt "  ...scripts dropped"        "evil()" "$r"
r=$(read_ "urb://$ASHIP/$P/dir/")
has "d. a shared folder's index"    "urb://$ASHIP/$P/dir/one" "$r"
has "  ...every entry"              "urb://$ASHIP/$P/dir/two" "$r"
has "  ...a page in it"             "Dir one" "$(read_ "urb://$ASHIP/$P/dir/one")"
r=$(read_ "urb://$ASHIP/forum/$BRD")
has "e. a forum board"              "First post" "$r"
has "  ...with the thread's address" "urb://$ASHIP/forum/$BRD/1" "$r"
th() { read_ "urb://$ASHIP/forum/$BRD/1" | grep -qF 'reply from B'; }
r=$(read_ "urb://$ASHIP/forum/$BRD/1")
has "e. a forum thread"             "forum body by A" "$r"
if until_ 30 th; then ok "  ...with its comments"; else fail "  ...with its comments" "$(read_ "urb://$ASHIP/forum/$BRD/1" | tail -5)"; fi
has "urb_list of A's root"          "urb://$ASHIP/$P/" "$(mcp urb_list "{\"url\":\"urb://$ASHIP/\"}")"
has "web_read still reads"          "Published by A" "$(mcp web_read "{\"url\":\"urb://$ASHIP/$P/pub\"}")"
r=$(read_ "urb://$BSHIP/$P/mine")
has "g. B's own private page"       "Mine, private" "$r"
hasnt "  ...not quoted"             "<quoted" "$r"

echo "==> errors say why"
has "a page not shared with B"      "not found" "$(read_ "urb://$ASHIP/$P/hid")"
hasnt "  ...and shows nothing of it" "Not for B" "$(read_ "urb://$ASHIP/$P/hid")"
has "a missing post"                "not found" "$(read_ "urb://$ASHIP/forum/$BRD/99")"
has "not a urb:// address"          "not a urb://" "$(read_ "https://example.com")"
has "B's own page outside the key"  "no access" "$(read_ "urb://$BSHIP/other/page")"

echo "==> the web scope never reaches B's own ship"
is "B makes a page outside the key" 200 "$(code -H "$BK" -X POST "$B/page-save?name=${P}x/other&type=md&new=1" --data-binary '# beyond-scope words')"
is "B makes a sensitive page"       200 "$(code -H "$BK" -X POST "$B/page-save?name=$P/sens&type=md&new=1" --data-binary '# sensitive words')"
is "  ...marked sensitive"          200 "$(code -H "$BK" -X POST "$B/page-sensitive?name=$P/sens&on=1")"
is "B saves a memory"               200 "$(code -H "$BK" -X POST "$B/know-save?key=$P/secret" --data-binary 'memory words')"
BASE=$(B_ "$B/streams" | jq -r .base)
[ -n "$BASE" ] && [ "$BASE" != null ] || fail "B's base from /streams"
j=$(B_ -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary \
  '{"name":"urb-web","by":"two-ship-urb-read","scope":{"memory":"none","pages":{"all":"none"},"web":{"all":null},"sensitive":false}}')
WKEY=$(jq -r .key.id <<<"$j"); WTOK=$(jq -r .token <<<"$j")
kc() { curl -s -m 60 -o /dev/null -w '%{http_code}' -G -H "Authorization: Bearer $1" "${@:2}"; }
kb() { curl -s -m 60 -G -H "Authorization: Bearer $1" "${@:2}"; }
know="$BASE/know/vault/$P/secret/entry"
is "web-all key: browse-file of B's /know is 403"  403 "$(kc "$WTOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$know" "$B/browse-file")"
hasnt "  ...and shows none of it"                  "memory words" "$(kb "$WTOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$know" "$B/browse-file")"
is "web-all key: browse-file of B's /keys is 403"  403 "$(kc "$WTOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$BASE/keys/keys" "$B/browse-file")"
is "web-all key: browse of B's tree is 403"        403 "$(kc "$WTOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$BASE" "$B/browse")"
is "web-all key: browse-file of B's private page is 403" 403 "$(kc "$WTOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$BASE/page/$P/mine/code" "$B/browse-file")"
is "web-all key: fetch of B's page is 403"         403 "$(kc "$WTOK" --data-urlencode "url=urb://$BSHIP/$P/mine" "$B/fetch")"
is "web-all key: urb-read of B's page is 403"      403 "$(kc "$WTOK" --data-urlencode "url=urb://$BSHIP/$P/mine" "$B/urb-read")"
is "web-all key: urb-read of B's /know tree is 403" 403 "$(kc "$WTOK" --data-urlencode "url=urb://$BSHIP/k/$P/secret" "$B/urb-read")"
is "web-all key: urb-read of B's raw tree is 403"  403 "$(kc "$WTOK" --data-urlencode "url=urb://$BSHIP/t$know" "$B/urb-read")"
is "web-all key: urb_list of B's root is 403"      403 "$(kc "$WTOK" --data-urlencode "url=urb://$BSHIP/" --data-urlencode list=1 "$B/urb-read")"
is "web-all key: still reads A"                    200 "$(kc "$WTOK" --data-urlencode "url=urb://$ASHIP/$P/pub" "$B/urb-read")"

echo "==> a pages-scoped key reads only its paths of B's own"
is "browse-file of a page in its paths"            "# Mine, private" "$(kb "$TOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$BASE/page/$P/mine/code" "$B/browse-file" | jq -r .body)"
is "browse-file of a page outside them is 403"     403 "$(kc "$TOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$BASE/page/${P}x/other/code" "$B/browse-file")"
is "browse-file of /know is 403"                   403 "$(kc "$TOK" --data-urlencode "ship=$BSHIP" --data-urlencode "path=$know" "$B/browse-file")"
is "fetch of a page outside them is 403"           403 "$(kc "$TOK" --data-urlencode "url=urb://$BSHIP/${P}x/other" "$B/fetch")"
has "urb_read of a page outside them: no access"   "no access" "$(read_ "urb://$BSHIP/${P}x/other")"
hasnt "  ...and none of its text"                  "beyond-scope words" "$(read_ "urb://$BSHIP/${P}x/other")"
r=$(read_ "urb://$BSHIP/$P/sens")
hasnt "a sensitive page, without clearance: nothing" "sensitive words" "$r"
has "  ...an error"                                "not found" "$r"
r=$(mcp urb_list "{\"url\":\"urb://$BSHIP/\"}")
has "urb_list of B's root: the folder in its paths" "urb://$BSHIP/$P/" "$r"
hasnt "  ...not the folder outside them"           "${P}x" "$r"
r=$(read_ "urb://$BSHIP/$P/")
has "B's folder lists its page"                     "urb://$BSHIP/$P/mine" "$r"
hasnt "  ...not the sensitive one"                 "$P/sens" "$r"

echo
[ "$fails" -eq 0 ] && echo "two-ship-urb-read: all passed" || echo "two-ship-urb-read: $fails failed"
[ "$fails" -eq 0 ]
