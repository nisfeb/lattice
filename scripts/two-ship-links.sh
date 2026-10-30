#!/usr/bin/env bash
# Two-ship checks for shared page links (docs/superpowers/specs/
# 2026-10-29-shared-page-links-design.md). Ship B shares a page with ship
# A, and A moves it into its own tree as a link. Fake fleet ships only,
# never a real one. Cleans up after itself on both ships, so it re-runs.
#
# Usage:  scripts/two-ship-links.sh [section...]     (default: every section)
# Env:    A_URL     ship A base, e.g. http://localhost:8120 (~mec)
#         A_COOKIE  file holding A's raw cookie (urbauth-~mec=...)
#         B_URL     ship B base, e.g. http://localhost:8135 (~mun)
#         B_COOKIE  file holding B's raw cookie (urbauth-~mun=...)
#         B_PIER    B's pier (default ~/fleet/piers/mun)
#         B_STOP    command that takes B offline (default: SIGSTOP its vere
#                   serf, which needs no fleet claim)
#         B_START   command that brings B back (default: SIGCONT them)
#         A_SOCK    A's lick socket, for the lattice-fs read (default
#                   ~/fleet/piers/mec/.urb/dev/grubbery/lattice/fs)
#         A_INST    A's lattice instance in the ball (default
#                   /apps/shell.shell/desks/lattice.desk/desk/data/
#                   lattice.lattice_app), for the sweep section
#
# The set used so far (Task 2): A = ~mec on 8120, cookie /tmp/mec-cookie.txt;
# B = ~mun, fleet set `grubbery`, on 8135, cookie /tmp/mun-cookie.txt. B got
# lattice with `scripts/dev-deploy.py http://localhost:8135 /tmp/mun.raw
# --add`, then approve-weir with its own weir.json as `granted`. Mint B's
# cookie again with scripts/hoon-test-kit/ship-cookie.sh ~/fleet/piers/mun
# http://localhost:8135 /tmp/mun.raw if it 401s.
#
# Prints one ok/FAIL line per check, exits non-zero on any FAIL.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
B_PIER=${B_PIER:-$HOME/fleet/piers/mun}
A_SOCK=${A_SOCK:-$HOME/fleet/piers/mec/.urb/dev/grubbery/lattice/fs}
# B's serf, the vere process that names its pier. Frozen, B answers
# nothing, which is all "offline" means to its peers. Not the king: it is
# tmux's child, and tmux continues a stopped child at once.
b_pids() { pgrep -f -- "--snap-dir $B_PIER( |\$)" | head -1; }
B_STOP=${B_STOP:-'kill -STOP $(b_pids)'}
B_START=${B_START:-'kill -CONT $(b_pids)'}
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0

ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }
# code <curl args>: the status only
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }
# node <route> <path>: one node of A's page-tree or page-dump, or null
node() { A_ "$A/$1" | jq -c --arg p "$2" '[.nodes[] | select(.path==$p)][0]'; }
# entry: B's page in A's shared-with-me, or null
entry() { A_ "$A/shared-with-me" | jq -c --arg h "$BSHIP" --arg s "$BSUF" \
  '[.[] | select(.host==$h and (.path|endswith($s)))][0]'; }
# wait_for <secs> <cmd...>: until cmd prints something that is not null
wait_for() {
  local n=$1; shift
  for _ in $(seq 1 "$n"); do
    local v; v=$("$@" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != null ] && { echo "$v"; return 0; }
    sleep 1
  done
  return 1
}
b_up() {
  for _ in $(seq 1 120); do
    [ "$(code -H "$BK" "$B/shared-with-me")" = 200 ] && return 0
    sleep 2
  done
  return 1
}

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }
BSUF=/page/x/doc/code     # the end of B's absolute code-grub path for x/doc

# share_a <name>: A shares one of its own pages with B, read
share_a() { A_ -X POST "$A/share-file?name=$1&ship=$BSHIP&mode=read"; }
# grant_base <page>: A's absolute base, from the road a grant of <page> made
grant_base() {
  A_ "$A/share-groups" | jq -r --arg g "${BSHIP#\~}" --arg p "/page/$1" \
    '[.[] | select(.name==$g) | .peek[] | select(endswith($p))][0] | sub($p + "$"; "")'
}
# abase: A's absolute base, from a page shared with B for the purpose
abase() {
  A_ -o /dev/null -X POST "$A/page-save?name=t4base&type=md&new=1" --data-binary 'b'
  share_a t4base >/dev/null
  grant_base t4base
  A_ -o /dev/null -X POST "$A/share-group-del?name=${BSHIP#\~}"
  A_ -o /dev/null -X POST "$A/page-del?name=t4base"
}

cleanup() {
  eval "$B_START" >/dev/null 2>&1   # never leave B frozen
  for id in ${KEYS:-}; do A_ -o /dev/null -X POST "$A/key-revoke?id=$id"; done
  A_ -o /dev/null -X POST "$A/page-share-tree?name=notes&mode=private"
  A_ -o /dev/null -X POST "$A/share-group-del?name=${BSHIP#\~}"
  for p in notes notes2; do A_ -o /dev/null -X POST "$A/page-del?name=$p"; done
  local e; e=$(entry)
  if [ -n "$e" ] && [ "$e" != null ]; then
    A_ -o /dev/null -X POST --data-urlencode "host=$BSHIP" \
      --data-urlencode "path=$(jq -r .path <<<"$e")" -G "$A/shared-with-me-del"
  fi
  B_ -o /dev/null -X POST "$B/page-del?name=x"
  B_ -o /dev/null -X POST "$B/share-group-del?name=${ASHIP#\~}"
}

# B shares x/doc with A in `mode`, and A hears of it
share() {
  B_ -X POST "$B/share-file?name=x/doc&ship=$ASHIP&mode=$1"
}

section_make() {
  echo "==> make ($ASHIP links $BSHIP's x/doc)"
  local AB; AB=$(abase)
  [ -n "$AB" ] && [ "$AB" != null ] || { fail "A's base from a grant"; return; }
  is "B makes x/doc" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md&new=1" --data-binary '# from B')"
  # the notice is best-effort (share-file's `notified` can read false on
  # a slow pier and still land), so the checks wait for its effect instead
  is "B shares it with A, edit" true "$(share edit | jq -r .ok)"
  local e; e=$(wait_for 30 entry)
  [ -n "$e" ] || { fail "A has the shared-with-me entry"; return; }
  ok "A has the shared-with-me entry"
  local PAX; PAX=$(jq -r .path <<<"$e")
  mk() { code -H "$AK" -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=$PAX" --data-urlencode "to=$1" "$A/link-make"; }

  is "A makes notes/taken" 200 "$(code -H "$AK" -X POST "$A/page-save?name=notes/taken&type=md&new=1" --data-binary 'mine')"
  is "make onto an existing page: 409" 409 "$(mk notes/taken)"
  is "make naming our own ship: 400" 400 "$(code -H "$AK" -X POST -G --data-urlencode "host=$ASHIP" --data-urlencode "path=$PAX" --data-urlencode "to=notes/self" "$A/link-make")"
  is "make with no such entry: 404" 404 "$(code -H "$AK" -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=/apps/nope/code" --data-urlencode "to=notes/nope" "$A/link-make")"

  # B offline: refused with the exact copy, and nothing written
  eval "$B_STOP" >/dev/null 2>&1
  is "B is stopped" 000 "$(code -m 5 "$B_URL")"
  local body st
  body=$(A_ -w '\n%{http_code}' -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=$PAX" --data-urlencode "to=notes/doc" "$A/link-make")
  st=$(tail -1 <<<"$body")
  is "make with B stopped: 504" 504 "$st"
  is "  ...with the create-offline copy" "$BSHIP is unreachable, try again when it's online" "$(head -n -1 <<<"$body" | jq -r .error)"
  is "  ...and no link written" null "$(node page-tree notes/doc)"
  is "  ...and the entry stays" "$PAX" "$(entry | jq -r .path)"
  eval "$B_START" >/dev/null 2>&1
  b_up && ok "B back up" || { fail "B back up"; return; }

  local r; r=$(A_ -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=$PAX" --data-urlencode "to=notes/doc" "$A/link-make")
  is "make to notes/doc answers the node" "$BSHIP" "$(jq -r .link.host <<<"$r" 2>/dev/null)"
  local d t; d=$(node page-dump notes/doc); t=$(node page-tree notes/doc)
  is "dump: link.host" "$BSHIP" "$(jq -r .link.host <<<"$d")"
  is "dump: page true" true "$(jq -r .page <<<"$d")"
  is "dump: readonly false" false "$(jq -r .readonly <<<"$d")"
  is "dump: kind frozen from B" md "$(jq -r .kind <<<"$d")"
  is "dump: no body" false "$(jq 'has("body")' <<<"$d")"
  is "tree: link.host" "$BSHIP" "$(jq -r .link.host <<<"$t")"
  is "tree: page true" true "$(jq -r .page <<<"$t")"
  is "tree: readonly false" false "$(jq -r .readonly <<<"$t")"
  is "tree: no body" false "$(jq 'has("body")' <<<"$t")"
  is "entry gone from shared-with-me" null "$(entry)"

  is "move notes to notes2" 200 "$(code -H "$AK" -X POST "$A/page-move?from=notes&to=notes2")"
  is "  ...the link is at notes2/doc" "$BSHIP" "$(node page-tree notes2/doc | jq -r .link.host)"
  is "  ...and none at notes/doc" null "$(node page-tree notes/doc)"
  is "move onto an existing link: 409" 409 "$(code -H "$AK" -X POST "$A/page-move?from=notes2/taken&to=notes2/doc")"
  is "move the link alone to notes2/moved" 200 "$(code -H "$AK" -X POST "$A/page-move?from=notes2/doc&to=notes2/moved")"
  is "  ...it is a link there" "$BSHIP" "$(node page-dump notes2/moved | jq -r .link.host)"
  is "  ...and no /page dir beside it" 0 "$(A_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$AB/page/notes2" "$A/browse" | jq '[.children[] | select(.name=="moved")] | length')"
  is "  ...and gone from notes2/doc" null "$(node page-tree notes2/doc)"
  is "move it back" 200 "$(code -H "$AK" -X POST "$A/page-move?from=notes2/moved&to=notes2/doc")"

  is "unmake notes2/doc" 200 "$(code -H "$AK" -X POST "$A/link-unmake?name=notes2/doc")"
  is "  ...the entry is back" "$PAX" "$(entry | jq -r .path)"
  is "  ...with its mode" edit "$(entry | jq -r .mode)"
  is "  ...and the link is gone" null "$(node page-tree notes2/doc)"

  is "re-make to notes2/doc" 200 "$(mk notes2/doc)"
  is "  ...no /page dir for it" 0 "$(A_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$AB/page/notes2" "$A/browse" | jq '[.children[] | select(.name=="doc")] | length')"
  is "new page under a link: 409" 409 "$(code -H "$AK" -X POST "$A/page-save?name=notes2/doc/sub&type=md" --data-binary 'x')"
  is "batch page under a link: 409" 409 "$(code -H "$AK" -X POST "$A/page-save-batch" --data-binary '[{"name":"notes2/doc/sub","type":"md","body":"x"}]')"
  is "folder under a link: 409" 409 "$(code -H "$AK" -X POST "$A/folder-new?name=notes2/doc/sub")"
  is "folder at a link: 409" 409 "$(code -H "$AK" -X POST "$A/folder-new?name=notes2/doc")"
  is "  ...nothing made" null "$(node page-tree notes2/doc/sub)"
  # a link holds no pages, so nothing goes under one
  is "make under a link: 409" 409 "$(mk notes2/doc/inner)"
  is "  ...and nothing there" null "$(node page-tree notes2/doc/inner)"
  is "A makes notes2/real" 200 "$(code -H "$AK" -X POST "$A/page-save?name=notes2/real&type=md&new=1" --data-binary 'real')"
  is "move a page under a link: 409" 409 "$(code -H "$AK" -X POST "$A/page-move?from=notes2/real&to=notes2/doc/real")"
  is "  ...the page stays" true "$(node page-tree notes2/real | jq -r .page)"
  is "B re-shares it, read" true "$(share read | jq -r .ok)"
  ro() { local v; v=$(node page-tree notes2/doc | jq -r .readonly); [ "$v" = true ] && echo "$v"; }
  is "  ...the link turns readonly" true "$(wait_for 30 ro)"
  is "  ...its mode is read" read "$(node page-dump notes2/doc | jq -r .link.mode)"
  is "  ...and shared-with-me stays without it" null "$(entry)"

  is "delete the folder" 200 "$(code -H "$AK" -X POST "$A/page-del?name=notes2")"
  is "  ...takes the link" null "$(node page-tree notes2/doc)"
}

# mint <web-scope json>: a key reading and writing notes/ on A, with the
# given web scope. Prints "<id> <token>"; the caller puts the id on KEYS.
mint() {
  local j; j=$(A_ -X POST "$A/key-mint" -H 'content-type: application/json' --data-binary \
    "{\"name\":\"links-proxy\",\"by\":\"two-ship-links\",\"scope\":{\"memory\":\"none\",\"pages\":{\"some\":{\"read\":[\"/notes\"],\"write\":[\"/notes\"]}},\"web\":$1,\"sensitive\":false}}")
  jq -r '"\(.key.id) \(.token)"' <<<"$j"
}
# lick_read <name>: one page-source over A's lick port, timed (lick_live.rs)
lick_read() {
  ( cd "$(dirname "$0")/../lattice-fs-rs" && LATTICE_SOCK="$A_SOCK" LATTICE_SHIP="$ASHIP" \
      LICK_SOURCE="$1" cargo test -q --test lick_live lick_source -- --nocapture 2>/dev/null )
}

section_proxy() {
  echo "==> proxy ($ASHIP reads and writes $BSHIP's x/doc through notes/doc)"
  cleanup   # the make section leaves its own x/doc behind
  is "B makes x/doc" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md&new=1" --data-binary '# from B')"
  is "B shares it with A, edit" true "$(share edit | jq -r .ok)"
  local e; e=$(wait_for 30 entry)
  [ -n "$e" ] || { fail "A has the shared-with-me entry"; return; }
  is "A links it at notes/doc" 200 "$(code -H "$AK" -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=$(jq -r .path <<<"$e")" --data-urlencode "to=notes/doc" "$A/link-make")"
  local CR="$BSHIP is unreachable or no longer shares this page"

  local s; s=$(A_ "$A/page-source?name=notes/doc")
  is "read: B's body" "# from B" "$(jq -r .body <<<"$s")"
  is "read: link.host" "$BSHIP" "$(jq -r .link.host <<<"$s")"
  is "read: kind" md "$(jq -r .kind <<<"$s")"
  local rev; rev=$(jq -r .rev <<<"$s")
  is "save with the right base" 200 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md&base=$rev" --data-binary '# via A')"
  is "  ...lands on B" "# via A" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "  ...and A reads it back" "# via A" "$(A_ "$A/page-source?name=notes/doc" | jq -r .body)"
  is "save with a stale base: 409" 409 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md&base=$rev" --data-binary '# stale')"
  is "  ...B is unchanged" "# via A" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  # a save that names no base (an agent's wiki_write, a queued edit) claims
  # the rev A last read, never nothing: B's newer text is a 409
  is "B edits x/doc first" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md" --data-binary '# B first')"
  is "save with no base over it: 409" 409 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# blind')"
  is "save with base=0 over it: 409" 409 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md&base=0" --data-binary '# blind0')"
  is "  ...B's text survives" "# B first" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "  ...and A reads it" "# B first" "$(A_ "$A/page-source?name=notes/doc" | jq -r .body)"
  is "save with no base once read" 200 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# via A')"
  is "  ...lands on B" "# via A" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"
  is "dump: still a link" "$BSHIP" "$(node page-dump notes/doc | jq -r .link.host)"
  is "batch save onto the link: 409" 409 "$(code -H "$AK" -X POST "$A/page-save-batch" --data-binary '[{"name":"notes/doc","type":"md","body":"# batch"}]')"
  local sv; sv=$(LICK_SAVE='# via lick' lick_read notes/doc)
  is "lick save through the link" ok "$(sed -n 's/^LICK_SAVED=//p' <<<"$sv")"
  is "  ...lands on B" "# via lick" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "  ...still no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"
  # the mount's save carries the rev it read: the owner's newer text wins
  is "B edits x/doc itself" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md" --data-binary '# B again')"
  sv=$(LICK_SAVE='# lick over B' lick_read notes/doc)
  is "lick save over B's newer text: 409" 409 "$(sed -n 's/^LICK_SAVED=//p' <<<"$sv" | cut -d' ' -f1)"
  is "  ...B's text survives" "# B again" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"

  # the mount reads, B edits, a background read pulls that in, and the
  # mount saves the text it read: it claims the rev it read, so 409
  brev() { B_ "$B/page-source?name=x/doc" | jq -r .rev; }
  at_rev() { local v; v=$(node page-dump notes/doc | jq -r .rev); [ "$v" = "$1" ] && echo "$v"; }
  local between
  between="curl -s -m 60 -o /dev/null -H '$BK' -X POST '$B/page-save?name=x/doc&type=md' --data-binary '# B newer'"
  between="$between && for i in \$(seq 1 20); do r=\$(curl -s -m 60 -H '$BK' '$B/page-source?name=x/doc' | jq -r .rev); curl -s -m 60 -o /dev/null -H '$AK' '$A/page-source?name=notes/doc'; [ \"\$(curl -s -m 60 -H '$AK' '$A/page-dump' | jq -r '[.nodes[] | select(.path==\"notes/doc\")][0].rev')\" = \"\$r\" ] && exit 0; sleep 1; done; exit 1"
  sv=$( cd "$(dirname "$0")/../lattice-fs-rs" && LATTICE_SOCK="$A_SOCK" LATTICE_SHIP="$ASHIP" \
      LICK_STALE=notes/doc LICK_SAVE='# B again' LICK_BETWEEN="$between" \
      cargo test -q --test lick_live lick_stale_save -- --nocapture 2>/dev/null )
  is "mount read B's text" "# B again" "$(sed -n 's/^LICK_READ=//p' <<<"$sv")"
  is "  ...B edits and A's cache takes it" true "$(sed -n 's/^LICK_BETWEEN=//p' <<<"$sv")"
  is "  ...the mount's stale save is refused (EEXIST)" 17 "$(sed -n 's/^LICK_STALE_SAVED=//p' <<<"$sv" | cut -d' ' -f1)"
  is "  ...B's newer text survives" "# B newer" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  # again after a save that landed: the claim is the rev that save made
  local between2="${between//B newer/B newest}"
  sv=$( cd "$(dirname "$0")/../lattice-fs-rs" && LATTICE_SOCK="$A_SOCK" LATTICE_SHIP="$ASHIP" \
      LICK_STALE=notes/doc LICK_FIRST='# mount first' LICK_SAVE='# mount second' LICK_BETWEEN="$between2" \
      cargo test -q --test lick_live lick_stale_save -- --nocapture 2>/dev/null )
  is "mount saves once" ok "$(sed -n 's/^LICK_FIRST_SAVED=//p' <<<"$sv")"
  is "  ...B edits and A's cache takes it" true "$(sed -n 's/^LICK_BETWEEN=//p' <<<"$sv")"
  is "  ...the mount's second, stale save is refused (EEXIST)" 17 "$(sed -n 's/^LICK_STALE_SAVED=//p' <<<"$sv" | cut -d' ' -f1)"
  is "  ...B's newest text survives" "# B newest" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"

  # each lick read starts a background read, also after an earlier one ended
  local want
  want=$(brev); lick_read notes/doc >/dev/null
  is "a lick read refreshes the cache to B's rev" "$want" "$(wait_for 20 at_rev "$want")"
  is "B edits again" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md" --data-binary '# B three')"
  want=$(brev); lick_read notes/doc >/dev/null
  is "  ...the next lick read refreshes it again" "$want" "$(wait_for 20 at_rev "$want")"
  is "  ...with B's body" "# B three" "$(lick_read notes/doc | sed -n 's/^LICK_BODY=//p' | jq -r .body)"

  # keys: notes/ scope alone never reaches the other ship
  local T1 T2 id; KEYS=
  read -r id T1 < <(mint '{"off":null}'); KEYS="$id"
  K1() { code -H "Authorization: Bearer $T1" "$@"; }
  is "key, pages only: read 403" 403 "$(K1 "$A/page-source?name=notes/doc")"
  is "key, pages only: save 403" 403 "$(K1 -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# key1')"
  is "  ...no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"
  is "  ...B is unchanged" "# B three" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "key, pages only: tree omits the link" null "$(curl -s -m 60 -H "Authorization: Bearer $T1" "$A/page-tree" | jq -c '[.nodes[] | select(.path=="notes/doc")][0]')"
  is "  ...and names no host" 0 "$(curl -s -m 60 -H "Authorization: Bearer $T1" "$A/page-tree" | grep -c "$BSHIP")"
  read -r id T2 < <(mint "{\"some\":{\"$BSHIP\":{\"read\":[\"/apps\"],\"write\":[\"/apps\"]}}}"); KEYS="$KEYS $id"
  K2() { code -H "Authorization: Bearer $T2" "$@"; }
  is "key, pages and web: read 200" 200 "$(K2 "$A/page-source?name=notes/doc")"
  is "  ...tree lists the link" "$BSHIP" "$(curl -s -m 60 -H "Authorization: Bearer $T2" "$A/page-tree" | jq -r '[.nodes[] | select(.path=="notes/doc")][0].link.host')"
  rev=$(A_ "$A/page-source?name=notes/doc" | jq -r .rev)
  is "  ...save 200" 200 "$(K2 -X POST "$A/page-save?name=notes/doc&type=md&base=$rev" --data-binary '# via key')"
  is "  ...lands on B" "# via key" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "  ...stale base 409" 409 "$(K2 -X POST "$A/page-save?name=notes/doc&type=md&base=$rev" --data-binary '# stale key')"
  for id in $KEYS; do A_ -o /dev/null -X POST "$A/key-revoke?id=$id"; done; KEYS=
  is "  ...both keys revoked" 0 "$(A_ "$A/keys" | jq '[.[] | select(.name=="links-proxy")] | length')"

  # B offline: the dump and the mount answer at once, from the cache
  A_ "$A/page-source?name=notes/doc" >/dev/null   # the cache holds '# via key'
  eval "$B_STOP" >/dev/null 2>&1
  is "B is stopped" 000 "$(code -m 3 "$B_URL")"
  local t0 t1; t0=$(date +%s%N)
  is "dump with B stopped answers" 200 "$(code -m 10 -H "$AK" "$A/page-dump")"
  t1=$(date +%s%N)
  local dms=$(( (t1-t0)/1000000 ))
  is "  ...within 2s (${dms}ms)" yes "$( [ "$dms" -lt 2000 ] && echo yes || echo "no, ${dms}ms")"
  nok() { local v; v=$(node page-dump notes/doc | jq -r .link.seen.ok); [ "$v" = false ] && echo "$v"; }
  local lk; lk=$(lick_read notes/doc)
  is "lick read with B stopped: cached body" "# via key" "$(sed -n 's/^LICK_BODY=//p' <<<"$lk" | jq -r .body 2>/dev/null)"
  local ms; ms=$(sed -n 's/^LICK_MS=//p' <<<"$lk")
  is "  ...within 2s (${ms:-?}ms)" yes "$( [ -n "$ms" ] && [ "$ms" -lt 2000 ] && echo yes || echo "no, ${ms:-no answer}ms")"
  ms=$(lick_read notes/doc | sed -n 's/^LICK_MS=//p')
  is "  ...a second read too, the refresh runs apart (${ms:-?}ms)" yes "$( [ -n "$ms" ] && [ "$ms" -lt 2000 ] && echo yes || echo "no, ${ms:-no answer}ms")"
  is "  ...and its background read marks seen.ok=false" false "$(wait_for 15 nok)"
  sv=$(LICK_SAVE='# offline lick' lick_read notes/doc)
  is "lick save with B known offline: 503" 503 "$(sed -n 's/^LICK_SAVED=//p' <<<"$sv" | cut -d' ' -f1)"
  is "  ...with the read-failure copy" "$CR" "$(sed -n 's/^LICK_SAVED=[0-9]* //p' <<<"$sv")"
  ms=$(sed -n 's/^LICK_SAVE_MS=//p' <<<"$sv")
  is "  ...within 1s (${ms:-?}ms)" yes "$( [ -n "$ms" ] && [ "$ms" -lt 1000 ] && echo yes || echo "no, ${ms:-no answer}ms")"
  s=$(A_ -w '\n%{http_code}' "$A/page-source?name=notes/doc")
  is "HTTP read with B stopped: 504" 504 "$(tail -1 <<<"$s")"
  is "  ...with the read-failure copy" "$CR" "$(head -n -1 <<<"$s" | jq -r .error)"
  is "  ...and the owner gets the last copy read" "# via key" "$(head -n -1 <<<"$s" | jq -r .cached.body)"
  local T3; read -r id T3 < <(mint "{\"some\":{\"$BSHIP\":{\"read\":[\"/apps\"],\"write\":[\"/apps\"]}}}"); KEYS="$id"
  s=$(curl -s -m 60 -w '\n%{http_code}' -H "Authorization: Bearer $T3" "$A/page-source?name=notes/doc")
  is "  ...a key gets the 504" 504 "$(tail -1 <<<"$s")"
  is "  ...but never the cached copy" false "$(head -n -1 <<<"$s" | jq 'has("cached")')"
  A_ -o /dev/null -X POST "$A/key-revoke?id=$id"; KEYS=
  is "save with B stopped: 504" 504 "$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# offline')"
  eval "$B_START" >/dev/null 2>&1
  b_up && ok "B back up" || { fail "B back up"; return; }
  okb() { local v; v=$(node page-dump notes/doc | jq -r .link.seen.ok); [ "$v" = true ] && echo "$v"; }
  A_ "$A/page-source?name=notes/doc" >/dev/null
  is "a read with B back marks seen.ok" true "$(wait_for 20 okb)"

  # B revokes: the read fails with the copy, and the dump says so
  is "B revokes A's grant" 200 "$(code -H "$BK" -X POST "$B/share-group-del?name=${ASHIP#\~}")"
  s=$(A_ -w '\n%{http_code}' "$A/page-source?name=notes/doc")
  is "read after revoke: 504" 504 "$(tail -1 <<<"$s")"
  is "  ...with the read-failure copy" "$CR" "$(head -n -1 <<<"$s" | jq -r .error)"
  is "  ...and page-dump shows seen.ok=false" false "$(wait_for 20 nok)"
  is "save after revoke: refused" yes "$(c=$(code -H "$AK" -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# revoked'); [ "$c" -ge 400 ] && echo yes || echo "no, $c")"
  is "  ...B is unchanged" "# via key" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
}

# mcp <tool> <json args>: one tools/call to the lattice MCP server, as key $T
mcp() {
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | LATTICE_URL="$A_URL" LATTICE_KEY="$T" command node "$(dirname "$0")/../plugins/claude/server.mjs" \
    | jq -r '.result.content[0].text'
}

section_exposure() {
  echo "==> exposure (a link of $ASHIP's, to $BSHIP's x/doc, reaches no one else)"
  cleanup
  is "B makes x/doc" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/doc&type=md&new=1" --data-binary '# secret of B')"
  is "B shares it with A, edit" true "$(share edit | jq -r .ok)"
  local e; e=$(wait_for 30 entry)
  [ -n "$e" ] || { fail "A has the shared-with-me entry"; return; }
  is "A links it at notes/doc" 200 "$(code -H "$AK" -X POST -G --data-urlencode "host=$BSHIP" --data-urlencode "path=$(jq -r .path <<<"$e")" --data-urlencode "to=notes/doc" "$A/link-make")"
  is "A makes notes/real" 200 "$(code -H "$AK" -X POST "$A/page-save?name=notes/real&type=md&new=1" --data-binary 'real page')"

  # A grants B the whole notes/ folder (a dir road, the ACL editor's way).
  # Its absolute base comes from the page grant share-file makes.
  is "A shares notes/real with B" true "$(share_a notes/real | jq -r .ok)"
  local AB; AB=$(grant_base notes/real)
  [ -n "$AB" ] && [ "$AB" != null ] || { fail "A's base from its grant"; return; }
  is "A grants B notes/" 200 "$(code -H "$AK" -X POST "$A/share-group-save?name=${BSHIP#\~}" \
    --data-binary "{\"ships\":[\"$BSHIP\"],\"peek\":[\"$AB/page/notes\"],\"make\":[]}")"
  bb() { B_ -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$1" "$B/$2"; }
  local ls; ls=$(bb "$AB/page/notes" browse)
  is "B lists A's notes/: the real page" 1 "$(jq '[.children[] | select(.name=="real")] | length' <<<"$ls")"
  is "  ...and not the link" 0 "$(jq '[.children[] | select(.name=="doc")] | length' <<<"$ls")"
  is "B reads A's real page (the grant works)" "real page" "$(bb "$AB/page/notes/real/code" browse-file | jq -r .body)"
  local c
  c=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$BK" -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$AB/page/notes/doc" "$B/browse")
  is "B can't list the link's dir" yes "$( [ "$c" = 404 ] || [ "$c" = 504 ] && echo yes || echo "no, $c")"
  c=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$BK" -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$AB/page/notes/doc/link" "$B/browse-file")
  is "B can't peek the link grub" yes "$( [ "$c" = 404 ] || [ "$c" = 504 ] && echo yes || echo "no, $c")"
  c=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$BK" -G --data-urlencode "ship=$ASHIP" --data-urlencode "path=$AB/links/notes/doc/link" "$B/browse-file")
  is "B can't peek A's link store" yes "$( [ "$c" = 404 ] || [ "$c" = 504 ] && echo yes || echo "no, $c")"
  is "  ...and A still has the link" "$BSHIP" "$(node page-tree notes/doc | jq -r .link.host)"

  # published as a site, the folder publishes its real pages only
  is "A publishes notes/ clearweb" 200 "$(code -H "$AK" -X POST "$A/page-share-tree?name=notes&mode=clearweb")"
  is "clearweb notes/real 200" 200 "$(code "$A/c/notes/real")"
  is "clearweb notes/doc 404" 404 "$(code "$A/c/notes/doc")"
  is "  ...with no trace of B's text" 0 "$(curl -s -m 60 "$A/c/notes/doc" | grep -c 'secret of B')"
  is "/list has notes/real" 1 "$(A_ "$A/list" | grep -c 'notes/real')"
  is "/list has no notes/doc" 0 "$(A_ "$A/list" | grep -c 'notes/doc')"
  is "A unpublishes notes/" 200 "$(code -H "$AK" -X POST "$A/page-share-tree?name=notes&mode=private")"

  # agents: a key's search never lists it, and a read comes back quoted
  local T id; KEYS=
  read -r id T < <(mint "{\"some\":{\"$BSHIP\":{\"read\":[\"/apps\"],\"write\":[\"/apps\"]}}}"); KEYS="$id"
  is "key search: no hit on the link" 0 "$(curl -s -m 60 -H "Authorization: Bearer $T" "$A/page-search?q=secret" | grep -c 'notes/doc')"
  local r; r=$(mcp wiki_read '{"name":"notes/doc"}')
  is "wiki_read of the link: quoted" 1 "$(grep -c "<quoted from=\"$BSHIP" <<<"$r")"
  is "  ...holding B's text" 1 "$(grep -c 'secret of B' <<<"$r")"
  is "  ...closed" 1 "$(grep -c '^</quoted>$' <<<"$r")"
  is "wiki_read of a real page: not quoted" 0 "$(mcp wiki_read '{"name":"notes/real"}' | grep -c '<quoted')"
  for id in $KEYS; do A_ -o /dev/null -X POST "$A/key-revoke?id=$id"; done; KEYS=
}

# A's lick port sweeps /link-done as it starts: an answer a reload left
# behind (its save fiber ended inside the minute it waits) has no reader
section_sweep() {
  echo "==> sweep (/link-done on $ASHIP, across a reload of lattice)"
  local inst="${A_URL%/}/grubbery/ball${A_INST:-/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app}"
  done_ls() { A_ "$inst/link-done?list=1" | jq -c '[.children[].name]'; }
  A_ -o /dev/null -X POST --data 'action=create-file&filename=orphan&blot=/noun' "$inst/link-done"
  is "an orphan answer sits in /link-done" '["orphan"]' "$(done_ls)"
  is "lattice reloads" yes "$(c=$(code -H "$AK" -X POST --data 'action=reload-nexus' "$inst"); [ "$c" = 200 ] || [ "$c" = 303 ] && echo yes || echo "no, $c")"
  empty() { [ "$(done_ls)" = "[]" ] && echo "[]"; }
  is "  ...and the port sweeps it" '[]' "$(wait_for 60 empty)"
}

trap cleanup EXIT
cleanup
sections=("$@"); [ ${#sections[@]} -eq 0 ] && sections=(make proxy exposure sweep)
for s in "${sections[@]}"; do "section_$s"; done
echo
[ "$fails" -eq 0 ] && echo "two-ship-links: all passed" || echo "two-ship-links: $fails failed"
[ "$fails" -eq 0 ]
