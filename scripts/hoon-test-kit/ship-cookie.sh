#!/usr/bin/env bash
# hoon-test-kit: log in to a running ship's HTTP server without its dojo,
# and keep only the session cookie.
#
#   ship-cookie.sh <pier> <base-url> <cookie-jar>
#
# Jael answers the +code scry to a khan thread over the pier's conn.sock (the
# same channel hoon-test.sh uses). The code is POSTed to /~/login and never
# printed or written anywhere; <cookie-jar> gets the curl cookie jar that
# /~/login sets, which a route script then sends. Checks that <base-url> is
# the same ship as <pier> first: fake ships move ports when they restart.
set -euo pipefail

pier=$(cd "${1:?usage: ship-cookie.sh <pier> <base-url> <cookie-jar>}" && pwd)
url=${2:?base url, e.g. http://localhost:8080}; url=${url%/}
jar=${3:?cookie jar path}
VERE=${VERE:-$(ls -d "$(dirname "$pier")"/vere-*-linux-x86_64 2>/dev/null | sort -V | tail -1)}
[[ -x "$VERE" ]] || { echo "no vere binary: set VERE" >&2; exit 2; }

# one cord, "~ship code": the ship renders both, nothing here parses @p
hoon='=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  ;<  c=@p  bind:m  (scry @p [%j %code (scot %p our.bowl) ~])  (pure:m !>((rap 3 ~[(scot %p our.bowl) (scot %p c)])))'
out=$(printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$hoon']]]" |
  "$VERE" eval --jam -n 2>/dev/null |
  socat -T 20 -,ignoreeof UNIX-CONNECT:"$pier/.urb/conn.sock" 2>/dev/null |
  "$VERE" eval --cue -n 2>/dev/null | tail -1) || true
[[ -n "$out" ]] || { echo "the ship at $pier did not answer" >&2; exit 4; }
ship=$(grep -oE "'~[a-z-]+~" <<<"$out" | tr -d "'" | sed 's/~$//')
code=$(grep -oE "~[a-z]{6}(-[a-z]{6}){3}'" <<<"$out" | tr -d "'~")
unset out
[[ -n "$ship" && -n "$code" ]] || { echo "could not read the ship's name and code" >&2; exit 1; }

at=$(curl -s -m 5 "$url/~/host" || true)
[[ "$at" == "$ship" ]] || { echo "$url is ${at:-nothing}, not $ship: fake ships move ports on restart" >&2; exit 2; }
# the code goes in on stdin, so it is never in argv (ps) or on screen
status=$(printf '%s' "$code" | curl -s -o /dev/null -w '%{http_code}' -c "$jar" --data-urlencode 'password@-' "$url/~/login")
unset code
[[ "$status" == 200 || "$status" == 204 ]] || { echo "login answered $status" >&2; exit 1; }
chmod 600 "$jar"
echo "logged in to $ship at $url"
