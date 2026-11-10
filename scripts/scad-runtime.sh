#!/usr/bin/env bash
# scad-runtime.sh: the optional OpenSCAD runtime on a fake ship.
#
#   LATTICE_URL=http://localhost:PORT LATTICE_COOKIE=FILE \
#   SCAD_GOOD=http://127.0.0.1:N/good/ SCAD_BAD=http://127.0.0.1:N/bad/ \
#     scripts/scad-runtime.sh
#
# SCAD_GOOD serves the three release files (build-scad.mjs --release DIR).
# SCAD_BAD serves the same names with one byte of the wasm changed. Both
# must be reachable FROM THE SHIP: a fleet clone is network-isolated, so run
# the server inside its namespace (TESTING.md, "The OpenSCAD runtime").
# SCAD_LOG, if set, is that server's log: the suite checks that nothing
# asked for the runtime before the install did.
#
# It points the ship at those addresses with /scad/source.json, a grub no
# lattice route writes, and removes it at the end. It writes to the ship:
# reset or drop it afterwards.
set -uo pipefail
: "${LATTICE_URL:?set LATTICE_URL}" "${LATTICE_COOKIE:?set LATTICE_COOKIE}"
: "${SCAD_GOOD:?set SCAD_GOOD}" "${SCAD_BAD:?set SCAD_BAD}"
B="${LATTICE_URL%/}/apps/lattice"
CK="Cookie: $(cat "$LATTICE_COOKIE")"
INST=/grubbery/ball/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app
pass=0; fail=0
is()   { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1: want [$2] got [$3]"; fi; }
has()  { case "$3" in *"$2"*) pass=$((pass+1)); echo "  ok   $1";; *) fail=$((fail+1)); echo "  FAIL $1: [$2] not in [${3:0:300}]";; esac; }
G()    { curl -s -m 60 -H "$CK" "$@"; }
code() { curl -s -m 60 -o /dev/null -w '%{http_code}' -H "$CK" "$@"; }
post() { curl -s -m 60 -H "$CK" -H "Origin: ${LATTICE_URL%/}" -X POST "$@"; }
field() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read() or "{}").get(sys.argv[1]); print("null" if v is None else (json.dumps(v) if isinstance(v,(dict,list,bool)) else v))' "$1"; }
status() { G "$B/scad-status"; }
# the source grub, through grubbery's own file API (never a lattice route)
source_set() {
  curl -s -m 30 -H "$CK" -o /dev/null --data "action=create-file&filename=source.json&blot=/json" "${LATTICE_URL%/}$INST/scad"
  curl -s -m 30 -H "$CK" -o /dev/null --data-urlencode "action=write-text" \
    --data-urlencode "content={\"url\":\"$1\"}" "${LATTICE_URL%/}$INST/scad/source.json"
}
source_drop() {
  curl -s -m 30 -H "$CK" -o /dev/null --data "action=delete-grub&filename=source.json" "${LATTICE_URL%/}$INST/scad"
}
# wait for the install fiber to end, up to $1 seconds
settle() {
  for _ in $(seq 1 "$1"); do
    [ "$(status | field busy)" = false ] && return 0; sleep 1
  done; return 1
}

echo "==> an install that never opted in"
s=$(status)
is  "no runtime"                  null  "$(field have <<<"$s")"
is  "no install running"          false "$(field busy <<<"$s")"
is  "the wasm is not served"      404   "$(code "$B/scad/openscad.wasm")"
is  "nor the glue"                404   "$(code "$B/scad/openscad.js")"
is  "an unknown file is not"      404   "$(code "$B/scad/app.hoon")"
if [ -n "${SCAD_LOG:-}" ]; then
  is "nothing fetched the runtime" 0 "$(grep -c 'GET /' "$SCAD_LOG" || true)"
fi

echo "==> a file that is not the pinned one is refused"
source_set "$SCAD_BAD"
is  "status names a source"       true "$(status | field source)"
has "install starts"              '"ok":true' "$(post "$B/scad-install")"
settle 120 || echo "  (install still running after 120 s)"
s=$(status)
has "the error names the hash"    'SHA-256' "$(field error <<<"$s")"
is  "nothing installed"           null "$(field have <<<"$s")"
is  "nothing served"              404  "$(code "$B/scad/openscad.wasm")"
is  "not even the files that passed" 404 "$(code "$B/scad/openscad.js")"

echo "==> the pinned files install"
source_set "$SCAD_GOOD"
t0=$(date +%s.%N)
has "install starts"              '"ok":true' "$(post "$B/scad-install")"
settle 180 || echo "  (install still running after 180 s)"
t1=$(date +%s.%N)
echo "  install took $(python3 -c "print(round($t1-$t0,1))") s, request to done"
s=$(status)
pin=$(field pin <<<"$s")
is  "installed at the pin"        "$pin" "$(field have <<<"$s")"
is  "no error"                    null "$(field error <<<"$s")"
h=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["files"]["openscad.wasm"])' "$s")
hd=$(curl -s -m 60 -D - -o "${TMPDIR:-/tmp}/scad-wasm.$$" -H "$CK" -H 'Accept-Encoding: gzip' "$B/scad/openscad.wasm?h=$h")
has "the wasm is application/wasm" 'content-type: application/wasm' "${hd,,}"
has "  gzipped"                   'content-encoding: gzip' "${hd,,}"
has "  immutable under its hash"  'immutable' "${hd,,}"
is  "  the bytes are the pinned file" "$h" "$(sha256sum < "${TMPDIR:-/tmp}/scad-wasm.$$" | cut -d' ' -f1)"
rm -f "${TMPDIR:-/tmp}/scad-wasm.$$"
has "  and no-cache without it"   'no-cache' "$(curl -s -m 60 -D - -o /dev/null -H "$CK" "$B/scad/openscad.wasm" | tr A-Z a-z)"
is  "the glue is served"          200 "$(code "$B/scad/openscad.js")"
has "the licence is served"       'GNU GENERAL PUBLIC LICENSE' "$(G "$B/scad/COPYING")"
has "a second install while one runs is answered" '"ok"' "$(post "$B/scad-install"; post "$B/scad-install")"
settle 180

echo "==> uninstall frees it"
has "uninstall"                   '"ok":true' "$(post "$B/scad-uninstall")"
s=$(status)
is  "nothing installed"           null "$(field have <<<"$s")"
is  "the wasm is gone"            404  "$(code "$B/scad/openscad.wasm")"
is  "the glue is gone"            404  "$(code "$B/scad/openscad.js")"
is  "the licence is gone"         404  "$(code "$B/scad/COPYING")"

echo "==> an agent key may not install"
is  "a bearer without a key is refused" 401 "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' -X POST "$B/scad-install")"

source_drop
echo "scad-runtime: $pass passed, $fail failed"
[ "$fail" = 0 ]
