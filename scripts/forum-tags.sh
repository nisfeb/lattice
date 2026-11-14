#!/usr/bin/env bash
# forum-tags.sh: thread tags on one FAKE ship. Makes a board, posts tagged
# threads through the owner's forms, and checks the submit page's tag
# inputs, the tags on each row, the filter panel and its counts, the tag
# filter, the active sort, the edit-tags form, the urb-read JSON, a
# deleted thread's tags leaving the panel, and that no forum body holds a
# <script>. Deletes its boards at the end.
#
# Usage:  LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec.cookie \
#           scripts/forum-tags.sh
# Env:    OLD_CODE=<dir>: a code/ dir of origin/main (git archive origin/main
#         code | tar -x -C DIR, then OLD_CODE=DIR/code). Adds the upgrade
#         check: deploy OLD_CODE with dev-deploy.py, make a board and a
#         post, deploy this checkout's code/, and check the post is still
#         listed, the board gained its /content/tags grub and the old post
#         takes a tag. It redeploys the ship twice: a throwaway ship only.
#         LATTICE_DESK: the lattice desk's path in the ball, for the
#         grubbery file API. Unset, it is discovered: the first of
#         /apps/shell.shell/desks/lattice.desk (dist kernel) and
#         /apps/shell/desks/lattice.desk (develop kernel) that answers.
#         DEPLOY_WAIT: seconds to wait for a deploy to serve (default 1500).
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail
URL="${LATTICE_URL:?LATTICE_URL}"; URL="${URL%/}"; A="$URL/apps/lattice"; F="$A/forum"
LATTICE_COOKIE="${LATTICE_COOKIE:?LATTICE_COOKIE}"
CK="Cookie: $(cat "$LATTICE_COOKIE")"
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$3"; then ok "$1"; else fail "$1" "no [$2]"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$3"; then fail "$1" "found [$2]"; else ok "$1"; fi; }
get()  { curl -s -m 60 -H "$CK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$CK" "$@"; }
until_() { local n=$1; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }
SHIP=$(curl -s -m 30 -H "$CK" "$URL/~/host")
[ -n "$SHIP" ] || { echo "FAIL  the ship answers /~/host"; exit 1; }

BRD="ft$RANDOM"; UB="fu$RANDOM"
cleanup() {
  code -X POST "$F/$BRD/mod/delete" >/dev/null
  [ -n "${OLD_CODE:-}" ] && code -X POST "$F/$UB/mod/delete" >/dev/null
  [ -n "${JAR:-}" ] && rm -f "$JAR" "$JAR.log"
}
trap cleanup EXIT

# a board's or a thread's urb-read JSON
json() { get "$A/urb-read?url=urb%3A%2F%2F$SHIP%2Fforum%2F$1${2:+%2F$2}"; }
tags() { json "$1" "$2" | jq -c '.post.tags'; }
# the thread ids a board page lists, in page order
ids()  { grep -oE "/forum/$1/[0-9]+\"" | sed -E 's|.*/([0-9]+)"|\1|' | awk '!s[$0]++' | tr '\n' ' ' | sed 's/ $//'; }
# the <script> tags inside the forum's own body (div.ct); the shared
# reader bar around it carries the app's nav scripts and is not counted
ctscripts() {
  python3 -c '
import sys, html.parser
class P(html.parser.HTMLParser):
    d = 0; n = 0; seen = False
    def handle_starttag(s, t, a):
        if t in ("br", "hr", "img", "input", "meta", "link", "wbr", "source"): return
        if s.d: s.d += 1
        elif t == "div" and ("class", "ct") in a: s.d = 1; s.seen = True
        if s.d and t == "script": s.n += 1
    def handle_endtag(s, t):
        if t in ("br", "hr", "img", "input", "meta", "link", "wbr", "source"): return
        if s.d: s.d -= 1
p = P(); p.feed(sys.stdin.read())
print("no forum body" if not p.seen else p.n if p.d == 0 else "unclosed")'
}

echo "==> $SHIP: board $BRD"
is "board made" 303 "$(code -X POST "$F/_new" --data "name=$BRD&title=Tags+$BRD&role=poster")"
SUB=$(get "$F/$BRD/submit")
has "the submit page has the first tag input" 'name="t1"' "$SUB"
has "the submit page has a datalist" '<datalist' "$SUB"

echo "==> a tagged thread"
is "thread 1 posted" 303 "$(code -X POST "$F/$BRD/submit" --data-urlencode 'title=First thread' \
  --data-urlencode 'body=one' --data-urlencode 't1=Bug Report' --data-urlencode 't2=idea' --data-urlencode 't3=!!!')"
is "thread 1 landed" 'First thread' "$(json "$BRD" 1 | jq -r '.post.title')"
is "its tags are normalised, the bad one dropped" '["bug-report","idea"]' "$(tags "$BRD" 1)"
PG=$(get "$F/$BRD")
has "its row shows bug-report" '>bug-report</a>' "$PG"
has "its row shows idea" '>idea</a>' "$PG"

echo "==> a second thread with one of the same tags"
is "thread 2 posted" 303 "$(code -X POST "$F/$BRD/submit" --data-urlencode 'title=Second thread' --data-urlencode 't1=bug-report')"
PG=$(get "$F/$BRD")
has "the panel counts bug-report twice" '>bug-report (2)</a>' "$PG"
has "the panel counts idea once" '>idea (1)</a>' "$PG"
is "the board lists both, newest first" '2 1' "$(ids "$BRD" <<<"$PG")"

echo "==> the tag filter"
is "?tags=bug-report,idea lists thread 1 only" 1 "$(get "$F/$BRD?tags=bug-report,idea" | ids "$BRD")"
is "?tags=bug-report lists both" '2 1' "$(get "$F/$BRD?sort=new&tags=bug-report" | ids "$BRD")"
NO=$(get "$F/$BRD?tags=nosuch")
is "?tags=nosuch lists none" '' "$(ids "$BRD" <<<"$NO")"
has "?tags=nosuch offers clear" '>clear</a>' "$NO"
PG=$(get "$F/$BRD")
has "the unfiltered board loads" "Tags $BRD" "$PG"
hasnt "the unfiltered board offers no clear" '>clear</a>' "$PG"

echo "==> the active sort"
is "a comment on thread 1" 303 "$(code -X POST "$F/$BRD/1/comment" --data 'body=fresh')"
is "?sort=new keeps thread 2 first" '2 1' "$(get "$F/$BRD?sort=new" | ids "$BRD")"
is "?sort=active puts the commented thread first" '1 2' "$(get "$F/$BRD?sort=active" | ids "$BRD")"

echo "==> editing a thread's tags"
is "the tags form answers 303" 303 "$(code -X POST "$F/$BRD/1/tags" --data 't1=other')"
is "thread 1's tags are replaced" '["other"]' "$(tags "$BRD" 1)"
PG=$(get "$F/$BRD")
has "the panel shows other" '>other (1)</a>' "$PG"
has "the panel counts bug-report once now" '>bug-report (1)</a>' "$PG"
hasnt "the panel dropped idea" '>idea (' "$PG"

echo "==> the urb-read JSON"
T1=$(json "$BRD" 1)
is "the thread carries tags" '["other"]' "$(jq -c '.post.tags' <<<"$T1")"
is "the thread's active is its comment, after its creation" true \
  "$(jq -r '(.post.active | startswith("~2")) and .post.active > .post.created' <<<"$T1")"
is "every board post carries tags and active" true \
  "$(json "$BRD" | jq -r '[.posts[] | has("tags") and has("active")] | length == 2 and all')"

echo "==> no script in a forum body"
for p in "" "?tags=other&sort=active" /submit /1 /mod; do
  is "no <script> in the body of $BRD$p" 0 "$(get "$F/$BRD$p" | ctscripts)"
done

echo "==> deleting a thread takes its tags off the panel"
is "thread 1 deleted" 303 "$(code -X POST "$F/$BRD/1/delete")"
PG=$(get "$F/$BRD")
is "the board lists thread 2 only" 2 "$(ids "$BRD" <<<"$PG")"
hasnt "the panel dropped other" '>other (' "$PG"
has "the panel keeps thread 2's tag" '>bug-report (1)</a>' "$PG"

if [ -n "${OLD_CODE:-}" ]; then
  echo "==> upgrade from $OLD_CODE"
  WAIT="${DEPLOY_WAIT:-1500}"
  DESK="${LATTICE_DESK:-}"
  if [ -z "$DESK" ]; then
    for d in /apps/shell.shell/desks/lattice.desk /apps/shell/desks/lattice.desk; do
      [ "$(code "$URL/grubbery/ball$d/desk/data/lattice.lattice_app?info=1")" = 200 ] && { DESK=$d; break; }
    done
  fi
  [ -n "$DESK" ] || { fail "the lattice desk is found in the ball"; echo "$fails failure(s)"; exit 1; }
  ok "the lattice desk is at $DESK"
  MARK="$URL/grubbery/ball$DESK/desk/data/lattice.lattice_app/forum/boards/$UB/content/tags?info=1"
  # dev-deploy.py takes a curl jar: make one from the cookie, for the
  # host in LATTICE_URL
  JAR=$(mktemp); chmod 600 "$JAR"
  IFS='=' read -r cn cv <"$LATTICE_COOKIE"
  host=${URL#*://}; host=${host%%/*}; host=${host%%:*}
  printf '%s\tFALSE\t/\tFALSE\t0\t%s\t%s\n' "$host" "$cn" "$cv" >"$JAR"
  # the deploy serves when thread 2's JSON has (new) or lacks (old) active
  active() { [ "$(json "$BRD" 2 | jq -r '.post | has("active")' 2>/dev/null)" = "$1" ]; }
  deploy() { # code dir, want active
    python3 "$HERE/dev-deploy.py" "$URL" "$JAR" --code "$1" >"$JAR.log" 2>&1 \
      || { fail "dev-deploy $1" "$(tail -3 "$JAR.log")"; return 1; }
    if until_ "$WAIT" active "$2"; then ok "$1 serves"; else fail "$1 serves" "after $WAIT s"; return 1; fi
  }
  if deploy "$OLD_CODE" false; then
    is "old code: board made" 303 "$(code -X POST "$F/_new" --data "name=$UB&title=Old+$UB&role=poster")"
    is "old code: post made" 303 "$(code -X POST "$F/$UB/submit" --data-urlencode 'title=Legacy post' --data-urlencode 't1=ignored')"
    is "old code writes no tags grub" 404 "$(code "$MARK")"
    if deploy "$HERE/../code" true; then
      has "the board still lists the post" 'Legacy post' "$(get "$F/$UB")"
      hasmark() { [ "$(code "$MARK")" = 200 ]; }
      if until_ 120 hasmark; then ok "the board gained /content/tags"; else fail "the board gained /content/tags" "$(code "$MARK")"; fi
      is "the old post's tags form answers 303" 303 "$(code -X POST "$F/$UB/1/tags" --data 't1=legacy')"
      is "the old post takes a tag" '["legacy"]' "$(tags "$UB" 1)"
    fi
  fi
fi

echo "$fails failure(s)"
exit $((fails > 0))
