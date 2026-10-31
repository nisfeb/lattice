#!/usr/bin/env bash
# Two-ship check that /unsub tells the publisher. Ship B publishes a page,
# ship A /subs it and then /unsubs it. B's grubbery must hold A as a
# watcher of the page while subscribed, and drop it at the /unsub, with no
# edit in between. Fake fleet ships only, never a real one.
#
# Usage:  scripts/two-ship-unsub.sh
# Env:    A_URL, A_COOKIE, B_URL, B_COOKIE as in scripts/two-ship-links.sh;
#         B_PIER, the publisher's pier (its conn.sock answers the scry);
#         VERE, a vere binary (fleet piers have none beside them).
#
# Release 85 and before culled the sub grub and sent no %drop, so B kept
# A as a watcher until B's next edit reached A and grubbery's self-heal
# dropped it.
set -uo pipefail

: "${A_URL:?A_URL}" "${A_COOKIE:?A_COOKIE}" "${B_URL:?B_URL}" "${B_COOKIE:?B_COOKIE}"
: "${B_PIER:?B_PIER}" "${VERE:?VERE}"
A="${A_URL%/}/apps/lattice"; B="${B_URL%/}/apps/lattice"
AK="Cookie: $(cat "$A_COOKIE")"; BK="Cookie: $(cat "$B_COOKIE")"
fails=0

ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "want [$2] got [$3]"; fi; }
A_()   { curl -s -m 60 -H "$AK" "$@"; }
B_()   { curl -s -m 60 -H "$BK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' "$@"; }

ASHIP=$(curl -s -m 30 -H "$AK" "${A_URL%/}/~/host")
BSHIP=$(curl -s -m 30 -H "$BK" "${B_URL%/}/~/host")
[ -n "$ASHIP" ] && [ -n "$BSHIP" ] || { echo "FAIL  ships answer /~/host"; exit 1; }

# watchers: how many of B's grubbery subscriptions have a watcher rail
# naming A, i.e. A's keeps on B. Scried over B's conn.sock by a khan thread.
watchers() {
  local hoon='=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  =/  t=@ta  (scot %p SHP)  =/  s  .^([fwd=(axal [dir=(map [path @ta] *) fil=(map @ta (map [path @ta] *))]) *] %gx /(scot %p our.bowl)/grubbery/(scot %da now.bowl)/peek/subs/subs)  %-  pure:m  !>  %+  roll  ~(tap of fwd.s)  |=  [[p=path d=(map [path @ta] *) f=(map @ta (map [path @ta] *))] n=@ud]  =/  ks=(list [path @ta])  (weld ~(tap in ~(key by d)) `(list [path @ta])`(zing (turn ~(val by f) |=(w=(map [path @ta] *) `(list [path @ta])`~(tap in ~(key by w))))))  (add n (lent (skim ks |=([q=path @ta] !=(~ (find ~[t] q))))))'
  hoon=${hoon/SHP/$ASHIP}
  printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$hoon']]]" |
    "$VERE" eval --jam -n 2>/dev/null |
    socat -T 60 -,ignoreeof UNIX-CONNECT:"$B_PIER/.urb/conn.sock" 2>/dev/null |
    "$VERE" eval --cue -n 2>/dev/null | tail -1 | sed -n 's/^\[0 %avow 0 %noun \([0-9]*\)\]$/\1/p'
}
# settle <n>: wait up to 20s for watchers to read n, then print what it reads
settle() {
  local w
  for _ in $(seq 1 20); do w=$(watchers); [ "$w" = "$1" ] && break; sleep 1; done
  echo "$w"
}

URL="urb://$BSHIP/x/unsub"
cleanup() {
  A_ -o /dev/null -X POST --data-urlencode "url=$URL" -G "$A/unsub"
  B_ -o /dev/null -X POST "$B/page-del?name=x/unsub"
}
trap cleanup EXIT
cleanup
base=$(settle 0)
echo "==> /unsub ($ASHIP unsubscribes from $BSHIP's x/unsub; $base watchers before)"
is "B makes x/unsub" 200 "$(code -H "$BK" -X POST "$B/page-save?name=x/unsub&type=md&new=1" --data-binary '# unsub')"
is "B publishes it" 200 "$(code -H "$BK" -X POST "$B/page-share?name=x/unsub&mode=urbit")"
is "A subscribes" 200 "$(code -H "$AK" -X POST --data-urlencode "url=$URL" -G "$A/sub")"
is "  ...B holds A as a watcher" "$((base + 1))" "$(settle $((base + 1)))"
is "A unsubscribes" 200 "$(code -H "$AK" -X POST --data-urlencode "url=$URL" -G "$A/unsub")"
is "  ...B drops A, with no edit between" "$base" "$(settle "$base")"

echo
[ "$fails" -eq 0 ] && echo "two-ship-unsub: all passed" || echo "two-ship-unsub: $fails failed"
[ "$fails" -eq 0 ]
