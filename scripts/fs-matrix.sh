#!/usr/bin/env bash
# fs-matrix.sh — end-to-end regression matrix for the lattice-fs FUSE client.
#
# Exercises both projections against a LIVE ship and verifies every claim on the
# ship side (via HTTP), not just through the mount. Every bug this client has
# shipped is a case here: sidecar deletion, O_TRUNC empty-commit, append offset
# after write, rmdir of a populated folder, atomic save onto an existing page,
# mv clobber, generic folder delete no-op.
#
# Usage:  scripts/fs-matrix.sh [ship-url]
#   env:  LATTICE_URL (default http://localhost:8080)
#         cookie at ~/.config/lattice-fs/cookie (run `lattice-fs auth` first)
#
# Exits non-zero on the first failed assertion. Test pages live under
# fsmatrix/ (lattice) and /apps/lattice.lattice_app/fsmatrix (generic scratch);
# both are deleted on exit.

set -u
URL="${1:-${LATTICE_URL:-http://localhost:8080}}"
CK="Cookie: $(cat ~/.config/lattice-fs/cookie)"
BIN="$(cd "$(dirname "$0")/.." && pwd)/lattice-fs-rs/target/release/lattice-fs"
WORK="$(mktemp -d)"
LMNT="$WORK/lat" GMNT="$WORK/gen"
PASS=0 FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  ok: $*"; }
fail() { FAIL=$((FAIL+1)); say "  FAIL: $*"; }

# assert <desc> <expected> <actual>
assert() {
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 — expected $(printf %q "$2"), got $(printf %q "$3")"; fi
}

page() { curl -s -H "$CK" "$URL/apps/lattice/page-source?name=$1" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["body"], end="")
except Exception: print("<missing>", end="")'; }
page_http() { curl -s -o /dev/null -w '%{http_code}' -H "$CK" "$URL/apps/lattice/page-source?name=$1"; }
grub_txt() { curl -s -H "$CK" "$URL/grubbery/api/file/apps/lattice.lattice_app/fsmatrix/$1?blot=/txt"; }
gtree() { curl -s -H "$CK" "$URL/grubbery/api/tree/apps/lattice.lattice_app/fsmatrix"; }
mcp() { # mcp <tool> <json-args>
  curl -s -X POST -H "$CK" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    "$URL/grubbery/mcp" >/dev/null; }

cleanup() {
  cd /
  fusermount -u "$LMNT" 2>/dev/null; fusermount -u "$GMNT" 2>/dev/null
  sleep 0.3
  curl -s -X POST -H "$CK" "$URL/apps/lattice/page-del?name=fsmatrix" -o /dev/null
  mcp delete_folder '{"path":"/apps/lattice.lattice_app/fsmatrix"}'
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -x "$BIN" ] || { say "build first: cargo build --release (missing $BIN)"; exit 2; }
curl -s -o /dev/null --max-time 3 "$URL/" || { say "ship unreachable at $URL"; exit 2; }

# fresh fixtures
curl -s -X POST -H "$CK" "$URL/apps/lattice/page-del?name=fsmatrix" -o /dev/null
mcp delete_folder '{"path":"/apps/lattice.lattice_app/fsmatrix"}'
mcp write_grub '{"path":"/apps/lattice.lattice_app/fsmatrix","name":"gnote","content":"generic body\nline two\n","blot":"hoon"}'
mcp write_grub '{"path":"/apps/lattice.lattice_app/fsmatrix","name":"gdel","content":"delete me\n","blot":"hoon"}'
mcp write_grub '{"path":"/apps/lattice.lattice_app/fsmatrix/gdir","name":"inner","content":"nested\n","blot":"hoon"}'

mkdir -p "$LMNT" "$GMNT"
unset LATTICE_SOCK
LATTICE_URL="$URL" "$BIN" mount "$LMNT" >/dev/null 2>"$WORK/lat.log" &
LATTICE_URL="$URL" "$BIN" mount "$GMNT" --root /apps/lattice.lattice_app/fsmatrix >/dev/null 2>"$WORK/gen.log" &
sleep 2
exec </dev/null

say "── lattice projection ($LMNT)"

say "create + read-back"
mkdir -p "$LMNT/fsmatrix"
printf 'v1\n' > "$LMNT/fsmatrix/a.md"
sleep 0.4
assert "create lands on ship" 'v1' "$(page fsmatrix/a)"
assert "read-back over mount" 'v1' "$(cat "$LMNT/fsmatrix/a.md")"

say "append immediately after write (the offset bug)"
printf 'v2\n' >> "$LMNT/fsmatrix/a.md"
printf 'v3\n' >> "$LMNT/fsmatrix/a.md"
sleep 0.4
assert "rapid appends intact" 'v1
v2
v3' "$(page fsmatrix/a)"

say "O_TRUNC overwrite (editor :w / shell >)"
printf 'replaced\n' > "$LMNT/fsmatrix/a.md"
sleep 0.4
assert "truncate-overwrite" 'replaced' "$(page fsmatrix/a)"

say "atomic save onto existing (temp write + rename)"
printf 'atomic\n' > "$LMNT/fsmatrix/a.md.tmp"
mv -f "$LMNT/fsmatrix/a.md.tmp" "$LMNT/fsmatrix/a.md"
sleep 0.4
assert "atomic save" 'atomic' "$(page fsmatrix/a)"
assert "kind survives atomic save" 'md' "$(curl -s -H "$CK" "$URL/apps/lattice/page-source?name=fsmatrix/a" | python3 -c 'import sys,json;print(json.load(sys.stdin)["kind"],end="")')"

say "sidecar files never touch the ship"
printf 'backup' > "$LMNT/fsmatrix/a.md~"
rm -f "$LMNT/fsmatrix/a.md~"
sleep 0.4
assert "page survives its backup's deletion" 'atomic' "$(page fsmatrix/a)"

say "mv clobber (POSIX rename semantics)"
printf 'clobber-src\n' > "$LMNT/fsmatrix/b.md"; sleep 0.4
mv -f "$LMNT/fsmatrix/b.md" "$LMNT/fsmatrix/a.md"; sleep 0.4
assert "dst replaced" 'clobber-src' "$(page fsmatrix/a)"
assert "src gone" '404' "$(page_http fsmatrix/b)"

say "rmdir safety"
mkdir "$LMNT/fsmatrix/sub" && printf 'x\n' > "$LMNT/fsmatrix/sub/c.md"; sleep 0.4
rmdir "$LMNT/fsmatrix/sub" 2>/dev/null
assert "rmdir non-empty refused (ENOTEMPTY)" '1' "$?"
assert "page inside survives" '200' "$(page_http fsmatrix/sub/c)"
rm -rf "$LMNT/fsmatrix/sub"; sleep 0.4
assert "rm -r removes subtree on ship" '404' "$(page_http fsmatrix/sub/c)"

say "── generic projection ($GMNT)"

assert "read text form (not jam)" 'generic body
line two' "$(cat "$GMNT/gnote.txt")"

say "overwrite in place (edit_file)"
printf 'edited via fuse\n' > "$GMNT/gnote.txt"
sleep 0.4
assert "overwrite lands, blot preserved" 'edited via fuse' "$(grub_txt gnote)"
assert "mark still hoon" '"hoon"' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("gnote")),end="")')"

say "create refused (unknown target mark)"
( echo x > "$GMNT/new.txt" ) 2>/dev/null   # EROFS surfaces at close; shell rc unreliable
sleep 0.4
assert "created grub never lands on ship" 'null' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("new")),end="")')"

say "delete file + rm -r folder"
rm -f "$GMNT/gdel.txt"; sleep 0.4
assert "grub deleted on ship" 'null' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("gdel")),end="")')"
rmdir "$GMNT/gdir" 2>/dev/null
assert "rmdir non-empty refused" '1' "$?"
rm -rf "$GMNT/gdir"; sleep 0.6
assert "rm -r clears folder on ship" '{}' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["dirs"]),end="")')"

say ""
say "matrix: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  say "── lattice mount log:"; sed 's/^/  /' "$WORK/lat.log" | tail -40
  say "── generic mount log:"; sed 's/^/  /' "$WORK/gen.log" | tail -10
fi
[ "$FAIL" -eq 0 ]
