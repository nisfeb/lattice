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

cleanup() {
  eval "$B_START" >/dev/null 2>&1   # never leave B frozen
  for id in ${KEYS:-}; do A_ -o /dev/null -X POST "$A/key-revoke?id=$id"; done
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

  is "unmake notes2/doc" 200 "$(code -H "$AK" -X POST "$A/link-unmake?name=notes2/doc")"
  is "  ...the entry is back" "$PAX" "$(entry | jq -r .path)"
  is "  ...with its mode" edit "$(entry | jq -r .mode)"
  is "  ...and the link is gone" null "$(node page-tree notes2/doc)"

  is "re-make to notes2/doc" 200 "$(mk notes2/doc)"
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
  is "no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"
  is "dump: still a link" "$BSHIP" "$(node page-dump notes/doc | jq -r .link.host)"
  is "batch save onto the link: 409" 409 "$(code -H "$AK" -X POST "$A/page-save-batch" --data-binary '[{"name":"notes/doc","type":"md","body":"# batch"}]')"
  local sv; sv=$(LICK_SAVE='# via lick' lick_read notes/doc)
  is "lick save through the link" ok "$(sed -n 's/^LICK_SAVED=//p' <<<"$sv")"
  is "  ...lands on B" "# via lick" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
  is "  ...still no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"

  # keys: notes/ scope alone never reaches the other ship
  local T1 T2 id; KEYS=
  read -r id T1 < <(mint '{"off":null}'); KEYS="$id"
  K1() { code -H "Authorization: Bearer $T1" "$@"; }
  is "key, pages only: read 403" 403 "$(K1 "$A/page-source?name=notes/doc")"
  is "key, pages only: save 403" 403 "$(K1 -X POST "$A/page-save?name=notes/doc&type=md" --data-binary '# key1')"
  is "  ...no code grub in the link dir" 0 "$(A_ "$A/page-history?name=notes/doc" | jq '.revisions // [] | length')"
  is "  ...B is unchanged" "# via lick" "$(B_ "$B/page-source?name=x/doc" | jq -r .body)"
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
  s=$(A_ -w '\n%{http_code}' "$A/page-source?name=notes/doc")
  is "HTTP read with B stopped: 504" 504 "$(tail -1 <<<"$s")"
  is "  ...with the read-failure copy" "$CR" "$(head -n -1 <<<"$s" | jq -r .error)"
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

trap cleanup EXIT
cleanup
sections=("$@"); [ ${#sections[@]} -eq 0 ] && sections=(make proxy)
for s in "${sections[@]}"; do "section_$s"; done
echo
[ "$fails" -eq 0 ] && echo "two-ship-links: all passed" || echo "two-ship-links: $fails failed"
[ "$fails" -eq 0 ]
