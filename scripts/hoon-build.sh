#!/usr/bin/env bash
# hoon-build.sh: every .hoon file under code/ compiles, on a fake ~zod with
# grubbery, the way a ship builds it. CI's hoon-build job runs it.
#
#   hoon-build.sh base  DIR   boot ~zod from $PILL into DIR/zod, install
#                             grubbery from $GRUBBERY (a desk/ directory),
#                             and stop it: the pier CI caches
#   hoon-build.sh check DIR   start DIR/zod, dev-deploy code/, and wait until
#                             every .hoon file reports a build status; exit 1
#                             if any is not a vase or the instance's bang is
#                             not null, printing the error
#
# Env: VERE (vere binary), PILL and GRUBBERY (base only), PORT (default
# 8199), WAIT (seconds to wait for the build, default 900). Needs socat.
# The pier is private to DIR: never point this at a real ship's pier.
set -euo pipefail
cmd=${1:?usage: hoon-build.sh base|check DIR}
dir=$(mkdir -p "${2:?pier parent dir}" && cd "$2" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
pier=$dir/zod
port=${PORT:-8199}
url=http://localhost:$port
VERE=${VERE:?set VERE to a vere binary}
ulimit -c 0
say() { printf 'hoon-build: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

khan() { # hoon thread -> its result, as vere prints it
  local h=${1//\\/\\\\}
  h=${h//\'/\\\'}
  printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$h']]]" |
    "$VERE" eval --jam -n 2>/dev/null |
    socat -T 1500 -,ignoreeof UNIX-CONNECT:"$pier/.urb/conn.sock" 2>/dev/null |
    "$VERE" eval --cue -n 2>/dev/null | tail -1
}
poke() { # mark noun: poke hood, as a dojo |command would
  local out
  out=$(khan "=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  ;<  ~  bind:m  (poke [our.bowl %hood] $1 !>($2))  (pure:m !>(%ok))")
  [[ $out == *'%avow'* ]] || die "poke $1 failed: $out"
}
up() { [[ $(curl -s -m 5 "$url/~/host" 2>/dev/null) == '~zod' ]]; }
start() { # [boot]: run vere detached, logging to DIR/vere.log
  local args=(-t zod)
  ! up || die "port $port already answers; another ~zod is running"
  [[ ${1:-} == boot ]] && args=(-t -F zod -c zod -B "${PILL:?set PILL}")
  (cd "$dir" && setsid nohup "$VERE" "${args[@]}" --http-port "$port" --loom 32 \
    >>"$dir/vere.log" 2>&1 </dev/null & echo $! >"$dir/vere.pid")
  local t=$SECONDS
  until up; do
    kill -0 "$(cat "$dir/vere.pid")" 2>/dev/null || { tail -40 "$dir/vere.log" >&2; die "vere exited"; }
    ((SECONDS - t < 900)) || { tail -40 "$dir/vere.log" >&2; die "~zod did not come up"; }
    sleep 2
  done
  say "~zod up on $url after $((SECONDS - t)) s"
}
stop() {
  local pid
  pid=$(cat "$dir/vere.pid" 2>/dev/null || true)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid"
  for _ in $(seq 120); do kill -0 "$pid" 2>/dev/null || { rm -f "$dir/vere.pid"; return 0; }; sleep 1; done
  die "~zod (pid $pid) did not stop"
}

base() {
  [[ ! -e $pier ]] || die "$pier exists"
  [[ -f ${GRUBBERY:?set GRUBBERY to grubbery desk/}/sys.kelvin ]] || die "$GRUBBERY has no sys.kelvin"
  start boot
  # |new-desk %grubbery, then |mount, copy, |commit and |install
  khan '=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  =/  b=path  /(scot %p our.bowl)/base/(scot %da now.bowl)  =/  fs=(list path)  ~[/mar/noun/hoon /mar/hoon/hoon /mar/txt/hoon /mar/kelvin/hoon /sys/kelvin]  =/  files  (malt (turn fs |=(p=path [p `page:clay`[(rear p) .^(* %cx (weld b p))]])))  ;<  ~  bind:m  (poke [our.bowl %hood] %helm-pass !>((new-desk:cloy %grubbery ~ files)))  (pure:m !>(%ok))' |
    grep -q '%avow' || die "new-desk failed"
  poke %kiln-mount "[(en-beam [our.bowl %grubbery da+now.bowl] /) %grubbery]"
  for _ in $(seq 60); do [[ -f $pier/grubbery/sys.kelvin ]] && break; sleep 1; done
  command cp -Rf "$GRUBBERY"/. "$pier/grubbery/"
  say "committing grubbery"
  poke %kiln-commit '[%grubbery |]'
  say "installing grubbery"
  poke %kiln-install '[%grubbery our.bowl %grubbery]'
  local t=$SECONDS
  until [[ $(curl -s -o /dev/null -w '%{http_code}' -m 10 "$url/grubbery/ball" || true) =~ ^(200|30[0-9]|401|403)$ ]]; do
    ((SECONDS - t < 1800)) || die "grubbery did not start serving"
    sleep 5
  done
  say "grubbery serving after $((SECONDS - t)) s"
  stop
}

check() {
  [[ -d $pier ]] || die "no pier at $pier (run base first)"
  local logs=$dir/check; mkdir -p "$logs"
  start
  VERE=$VERE "$here/hoon-test-kit/ship-cookie.sh" "$pier" "$url" "$logs/jar" >&2 || die "no cookie"
  local add=--add
  [[ -f $dir/deployed ]] && add=
  python3 "$here/dev-deploy.py" "$url" "$logs/jar" $add >"$logs/deploy.log" 2>&1 ||
    { cat "$logs/deploy.log" >&2; die "dev-deploy failed"; }
  tail -2 "$logs/deploy.log" >&2
  touch "$dir/deployed"
  stamp=$(grep -oE 'version.json = \S+' "$logs/deploy.log" | awk '{print $3}')
  python3 "$here/hoon-build-wait.py" "$url" "$logs/jar" "$stamp" "$here/../code" --wait "${WAIT:-900}"
}

case $cmd in
  base) base ;;
  check) rc=0; check || rc=$?; stop; exit $rc ;;
  stop) stop ;;
  *) die "unknown command $cmd" ;;
esac
