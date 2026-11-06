#!/usr/bin/env bash
# MCP knowledge-tool matrix: drives all eleven in-ball lattice-* tools over
# JSON-RPC at /grubbery/mcp, end to end on one scratch key, then the
# plugin's urb_read, urb_list and skill_* tools as agent keys. This is the
# contract every agent's memory store depends on; platform.md marks it
# must-not-regress. Run against the tyr harness, never production.
#
# Usage:  scripts/mcp-matrix.sh
# Env:    LATTICE_URL     ship base (required, a throwaway ship)
#         LATTICE_COOKIE  cookie file (required)
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
MCP="$URL/grubbery/mcp"
K="mcpmx/$$"

# tool <name> <json-args>  -> the tool's text result on stdout
tool() {
  python3 - "$1" "$2" <<'PY' > /tmp/mcpmx-req.$$
import json,sys
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))
PY
  curl -s -m 30 -X POST "$MCP" -H "$CK" -H 'Content-Type: application/json' \
    --data-binary @/tmp/mcpmx-req.$$ \
  | python3 -c 'import json,sys
r=json.load(sys.stdin)
print(r.get("result",{}).get("content",[{}])[0].get("text", "RPC-ERROR: "+json.dumps(r.get("error"))))'
  rm -f /tmp/mcpmx-req.$$
}

echo "==> save / read / list / search"
has "lattice-save"   "created"          "$(tool lattice-save "{\"key\":\"$K\",\"body\":\"mcp matrix memory body\"}")"
has "lattice-read"   "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K\"}")"
has "lattice-list"   "$K"               "$(tool lattice-list '{}')"
has "lattice-search body" "$K"          "$(tool lattice-search '{"query":"mcp matrix memory"}')"
has "lattice-search key"  "$K"          "$(tool lattice-search '{"query":"mcpmx"}')"

echo "==> tags: tag / tags / explore / untag"
has "lattice-tag"    "tagged"       "$(tool lattice-tag "{\"key\":\"$K\",\"tag\":\"MCPMX-TAG\"}")"
has "tags case-fold in read" "mcpmx-tag" "$(tool lattice-read "{\"key\":\"$K\"}")"
has "lattice-tags vocabulary" "mcpmx-tag" "$(tool lattice-tags '{}')"
has "lattice-explore by tag" "$K"       "$(tool lattice-explore '{"tag":"mcpmx-tag"}')"
has "lattice-untag"  "mcpmx-tag"        "$(tool lattice-untag "{\"key\":\"$K\",\"tag\":\"mcpmx-tag\"}")"
hasnt "tag gone after untag" "mcpmx-tag" "$(tool lattice-read "{\"key\":\"$K\"}")"

echo "==> move (history-preserving rename)"
has "lattice-move"   "moved"            "$(tool lattice-move "{\"key\":\"$K\",\"to\":\"$K-moved\"}")"
has "body at new key" "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
hasnt "old key gone from list" "\"$K\"" "$(tool lattice-list '{}' | python3 -c 'import json,sys
d=json.loads(sys.stdin.read())
print(json.dumps([k["key"] for k in d["keys"]]))')"

echo "==> delete / restore / re-save restores"
has "lattice-delete" "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
has "read after delete errors" "not found" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
has "lattice-restore" "restored"        "$(tool lattice-restore "{\"key\":\"$K-moved\"}")"
has "body back after restore" "mcp matrix memory body" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"
has "delete again"   "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
has "re-save a deleted key" "created"   "$(tool lattice-save "{\"key\":\"$K-moved\",\"body\":\"second life\"}")"
has "re-saved body serves" "second life" "$(tool lattice-read "{\"key\":\"$K-moved\"}")"

echo "==> cleanup"
has "final delete"   "deleted"          "$(tool lattice-delete "{\"key\":\"$K-moved\"}")"
hasnt "scratch key gone" "$K"           "$(tool lattice-list '{}')"


echo "==> plugin urb_read / urb_list (plugins/claude/server.mjs, as an agent key)"
# One ship's cases: its own pages by address, published or not, a folder
# index, a forum board and thread, html as text, a long page cut with an
# offset, and the errors. scripts/two-ship-urb-read.sh reads another ship.
UP="mcpurb$$"; SHIP=$(curl -s -m 30 -H "$CK" "$URL/~/host")
sc() { curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$CK" "$@"; }
is "own published page made" 200 "$(sc -X POST "$B/page-save?name=$UP/pub&type=md&new=1" --data-binary '# own published')"
is "  ...published"         200 "$(sc -X POST "$B/page-share?name=$UP/pub&mode=shared")"
is "own private page made"  200 "$(sc -X POST "$B/page-save?name=$UP/priv&type=md&new=1" --data-binary '# own private')"
is "a page outside the key" 200 "$(sc -X POST "$B/page-save?name=${UP}x/priv&type=md&new=1" --data-binary '# out of scope')"
big=$(python3 -c 'print("word " * 12000)')
is "a long page"            200 "$(sc -X POST "$B/page-save?name=$UP/big&type=md&new=1" --data-binary "$big")"
is "an html page"           200 "$(sc -X POST "$B/page-save?name=$UP/h&type=html&new=1" --data-binary '<p>html&nbsp;text</p><style>x{}</style>')"
is "  ...published"         200 "$(sc -X POST "$B/page-share?name=$UP/h&mode=shared")"
is "a board"                303 "$(sc -X POST "$B/forum/_new" --data "name=$UP&title=Urb+$UP&role=poster")"
is "  ...a post"            303 "$(sc -X POST "$B/forum/$UP/submit" --data "title=Board+post&body=post+body")"
kj=$(curl -s -m 30 -H "$CK" -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary \
  "{\"name\":\"mcp-urb\",\"by\":\"mcp-matrix\",\"scope\":{\"memory\":\"none\",\"pages\":{\"some\":{\"read\":[\"/$UP\"],\"write\":[]}},\"web\":{\"all\":null},\"sensitive\":false}}")
KID=$(printf '%s' "$kj" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"]["id"])')
KTOK=$(printf '%s' "$kj" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
plug() {
  python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$1" "$2" \
  | LATTICE_URL="$URL" LATTICE_KEY="$KTOK" node "$(dirname "${BASH_SOURCE[0]}")/../plugins/claude/server.mjs" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["content"][0]["text"])'
}
u() { plug urb_read "{\"url\":\"urb://$SHIP/$1\"${2:+,\"offset\":$2}}"; }
r=$(u "$UP/pub");  has "g. own published page" "own published" "$r"; hasnt "  ...not quoted" "<quoted" "$r"
r=$(u "$UP/priv"); has "g. own private page"   "own private" "$r";   hasnt "  ...not quoted" "<quoted" "$r"
has "g. own private page by /p/"               "own private" "$(u "p/$UP/priv")"
has "own page outside the key's pages: no access" "no access" "$(u "${UP}x/priv")"
hasnt "  ...and none of its text"              "out of scope" "$(u "${UP}x/priv")"
r=$(u "$UP/big");  has "a long page is cut"     "truncated: characters 0 to 40000" "$r"
r=$(u "$UP/big" 40000); has "  ...and reads on at the offset" "word" "$r"; hasnt "  ...to its end" "truncated" "$r"
has "h. html comes back as text"               "html text" "$(u "$UP/h")"
hasnt "  ...without its tags"                  "<p>" "$(u "$UP/h")"
has "d. the folder's index lists its pages"     "urb://$SHIP/$UP/pub" "$(u "$UP/")"
has "urb_list of the ship's root"              "urb://$SHIP/$UP/" "$(plug urb_list "{\"url\":\"urb://$SHIP/\"}")"
r=$(u "forum/$UP");   has "e. own board"         "Board post" "$r"; has "  ...with the thread's address" "urb://$SHIP/forum/$UP/1" "$r"
has "e. own thread"                            "post body" "$(u "forum/$UP/1")"
has "a missing page: not found"                "not found" "$(u "$UP/ghost")"
has "a ship that does not answer: unreachable" "ship unreachable" "$(plug urb_read '{"url":"urb://~sampel-palnet/notes"}')"
has "web_read is urb_read"                     "own published" "$(plug web_read "{\"url\":\"urb://$SHIP/$UP/pub\"}")"
curl -s -m 30 -o /dev/null -H "$CK" -X POST "$B/key-revoke?id=$KID"
for n in "$UP" "${UP}x"; do curl -s -m 30 -o /dev/null -H "$CK" -X POST "$B/page-del?name=$n"; done
curl -s -m 30 -o /dev/null -H "$CK" -X POST "$B/forum/$UP/mod/delete"

echo "==> plugin skill_index / skill_read / skill_save (as agent keys)"
SK="mcpskill-$$"
mintk() {  # mintk <skills scope>  -> "<id> <token>"
  curl -s -m 30 -H "$CK" -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary \
    "{\"name\":\"mcp-skills-$1\",\"by\":\"mcp-matrix\",\"scope\":{\"memory\":\"none\",\"pages\":{\"all\":\"none\"},\"web\":{\"off\":null},\"sensitive\":false,\"skills\":\"$1\"}}" \
  | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["key"]["id"], j["token"])'
}
read -r WID WTOK <<<"$(mintk write)"; read -r RID RTOK <<<"$(mintk read)"; read -r NID NTOK <<<"$(mintk none)"
# plugr <token> <tool> <json-args>  -> the tool's text, prefixed ERR: when it is an error
plugr() {
  python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$2" "$3" \
  | LATTICE_URL="$URL" LATTICE_KEY="$1" node "$(dirname "${BASH_SOURCE[0]}")/../plugins/claude/server.mjs" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(("ERR: " if r.get("isError") else "")+r["content"][0]["text"])'
}
SKMD=$(printf -- '---\nname: %s\ndescription: mcp matrix skill. Use when the matrix runs.\n---\n\n# Steps\n\nmcp matrix skill body\n' "$SK")
SKARGS=$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"body":sys.argv[2]}))' "$SK" "$SKMD")
has "skill_save makes a skill"           '"created":true' "$(plugr "$WTOK" skill_save "$SKARGS")"
has "skill_index: name: description"     "- $SK: mcp matrix skill." "$(plugr "$WTOK" skill_index '{}')"
has "skill_read: SKILL.md"               "mcp matrix skill body" "$(plugr "$WTOK" skill_read "{\"name\":\"$SK\"}")"
has "skill_save an extra file"           '"ok":true' "$(plugr "$WTOK" skill_save "{\"name\":\"$SK\",\"path\":\"references/notes.md\",\"body\":\"extra notes file\"}")"
has "skill_read with a path"             "extra notes file" "$(plugr "$WTOK" skill_read "{\"name\":\"$SK\",\"path\":\"references/notes.md\"}")"
has "  ...and in the file list"          "references/notes.md" "$(plugr "$WTOK" skill_read "{\"name\":\"$SK\"}")"
has "a code file is refused"             "ERR: 400" "$(plugr "$WTOK" skill_save "{\"name\":\"$SK\",\"path\":\"run.sh\",\"body\":\"echo\"}")"
has "a read key reads"                   "mcp matrix skill body" "$(plugr "$RTOK" skill_read "{\"name\":\"$SK\"}")"
has "  ...but cannot save"               "ERR: 403" "$(plugr "$RTOK" skill_save "$SKARGS")"
has "a none key cannot list"             "ERR: 403" "$(plugr "$NTOK" skill_index '{}')"
curl -s -m 30 -o /dev/null -H "$CK" -X POST "$B/skill-delete?name=$SK"
for k in "$WID" "$RID" "$NID"; do curl -s -m 30 -o /dev/null -H "$CK" -X POST "$B/key-revoke?id=$k"; done

finish
