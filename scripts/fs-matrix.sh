#!/usr/bin/env bash
# fs-matrix.sh: end-to-end regression matrix for the lattice-fs FUSE client.
#
# Exercises both projections against a LIVE ship and verifies every claim on the
# ship side (via HTTP), not just through the mount. Every bug this client has
# shipped is a case here: sidecar deletion, O_TRUNC empty-commit, append offset
# after write, rmdir of a populated folder, atomic save onto an existing page,
# mv clobber, generic folder delete no-op.
#
# Usage:  scripts/fs-matrix.sh [ship-url]
#   env:  LATTICE_URL and LATTICE_COOKIE (required, a throwaway ship)
#         The mounts run with a temporary HOME that holds only that
#         cookie, so the user's lattice-fs config is never read or written.
#
# Exits non-zero if any assertion failed. Lattice test pages live
# under fsmatrix/. Generic scratch lives under
# /apps/lattice.lattice_app/fsmatrix. Both are deleted on exit.

set -u
LATTICE_URL="${1:-${LATTICE_URL:-}}"
. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
BIN="$(cd "$(dirname "$0")/.." && pwd)/lattice-fs-rs/target/release/lattice-fs"
WORK="$(mktemp -d)"
LMNT="$WORK/lat" GMNT="$WORK/gen"

say()  { printf '%s\n' "$*"; }

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
# the mount reads cookie-<scheme>-<host>-<port> under $HOME/.config; a
# HOME of its own, so the user's config (and their ship's cookie) is
# never read
CFILE=$(python3 - "$URL" <<'PY'
import sys, re
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
port = u.port or (443 if u.scheme == 'https' else 80)
print(re.sub(r'[^A-Za-z0-9._-]', '_', 'cookie-%s-%s-%d' % (u.scheme, u.hostname, port)))
PY
)
mkdir -p "$WORK/home/.config/lattice-fs"
chmod 700 "$WORK" "$WORK/home/.config/lattice-fs"
install -m 600 "$CKF" "$WORK/home/.config/lattice-fs/$CFILE"
HOME="$WORK/home" LATTICE_URL="$URL" "$BIN" mount "$LMNT" >/dev/null 2>"$WORK/lat.log" &
HOME="$WORK/home" LATTICE_URL="$URL" "$BIN" mount "$GMNT" --root /apps/lattice.lattice_app/fsmatrix >/dev/null 2>"$WORK/gen.log" &
sleep 2
exec </dev/null

say "── lattice projection ($LMNT)"

say "create + read-back"
mkdir -p "$LMNT/fsmatrix"
printf 'v1\n' > "$LMNT/fsmatrix/a.md"
sleep 0.4
is "create lands on ship" 'v1' "$(page fsmatrix/a)"
is "read-back over mount" 'v1' "$(cat "$LMNT/fsmatrix/a.md")"

say "append immediately after write (the offset bug)"
printf 'v2\n' >> "$LMNT/fsmatrix/a.md"
printf 'v3\n' >> "$LMNT/fsmatrix/a.md"
sleep 0.4
is "rapid appends intact" 'v1
v2
v3' "$(page fsmatrix/a)"

say "O_TRUNC overwrite (editor :w / shell >)"
printf 'replaced\n' > "$LMNT/fsmatrix/a.md"
sleep 0.4
is "truncate-overwrite" 'replaced' "$(page fsmatrix/a)"

say "atomic save onto existing (temp write + rename)"
printf 'atomic\n' > "$LMNT/fsmatrix/a.md.tmp"
mv -f "$LMNT/fsmatrix/a.md.tmp" "$LMNT/fsmatrix/a.md"
sleep 0.4
is "atomic save" 'atomic' "$(page fsmatrix/a)"
is "kind survives atomic save" 'md' "$(curl -s -H "$CK" "$URL/apps/lattice/page-source?name=fsmatrix/a" | python3 -c 'import sys,json;print(json.load(sys.stdin)["kind"],end="")')"

say "sidecar files never touch the ship"
printf 'backup' > "$LMNT/fsmatrix/a.md~"
rm -f "$LMNT/fsmatrix/a.md~"
sleep 0.4
is "page survives its backup's deletion" 'atomic' "$(page fsmatrix/a)"

say "mv clobber (POSIX rename semantics)"
printf 'clobber-src\n' > "$LMNT/fsmatrix/b.md"; sleep 0.4
mv -f "$LMNT/fsmatrix/b.md" "$LMNT/fsmatrix/a.md"; sleep 0.4
is "dst replaced" 'clobber-src' "$(page fsmatrix/a)"
is "src gone" '404' "$(page_http fsmatrix/b)"

say "a stale writer after a folder move (a sync client on the mount)"
mkdir -p "$LMNT/fsmatrix/mvold"
printf 'one\n' > "$LMNT/fsmatrix/mvold/one.md"
printf 'two\n' > "$LMNT/fsmatrix/mvold/two.md"
sleep 0.4
# the handle is opened before the move, the move happens on the ship (the
# web client, another device), and the copy is written back after it
stale=$(python3 - "$LMNT/fsmatrix/mvold/two.md" "$URL" "$CK" <<'PY'
import sys, subprocess
f = open(sys.argv[1], 'r+'); old = f.read()
subprocess.run(['curl', '-s', '-X', 'POST', '-H', sys.argv[3],
  sys.argv[2] + '/apps/lattice/page-move?from=fsmatrix/mvold&to=fsmatrix/mvnew'], capture_output=True)
f.seek(0); f.write(old); f.truncate()
try:
    f.close(); print('accepted')
except OSError as e:
    print('refused', e.errno)
PY
)
is "the write back is refused as gone (ENOENT)" "refused 2" "$stale"
is "the old folder is not made again" '404' "$(page_http fsmatrix/mvold/two)"
is "the moved copy is intact" 'two' "$(page fsmatrix/mvnew/two)"
# once the mount has listed the tree again the old file is gone from it,
# so the same write-back arrives as a create: a temp file renamed over
# the old name (most editors, sync clients), or a plain new file
# the old folder made again first, as a sync client does (an empty
# folder: the refused writes below each list the tree again)
sleep 6; ls "$LMNT/fsmatrix" >/dev/null
mkold() { mkdir -p "$LMNT/fsmatrix/mvold" 2>/dev/null; [ -d "$LMNT/fsmatrix/mvold" ] && echo y; }
is "the old folder can be made again" 'y' "$(mkold)"
printf 'stale\n' > "$LMNT/fsmatrix/mvold/.one.md.tmp" 2>/dev/null
mv "$LMNT/fsmatrix/mvold/.one.md.tmp" "$LMNT/fsmatrix/mvold/one.md" 2>/dev/null
is "a temp-and-rename write-back is refused" '404' "$(page_http fsmatrix/mvold/one)"
mkold >/dev/null
twoerr=$( { printf 'stale\n' > "$LMNT/fsmatrix/mvold/two.md"; } 2>&1)
has "a create write-back is refused as gone" 'No such file' "$twoerr"
is "and lands nothing" '404' "$(page_http fsmatrix/mvold/two)"
mkold >/dev/null
is "the moved copies are intact" 'one two' "$(page fsmatrix/mvnew/one) $(page fsmatrix/mvnew/two)"
printf 'three\n' > "$LMNT/fsmatrix/mvold/three.md"; sleep 0.4
is "a new file at the old folder's name still lands" 'three' "$(page fsmatrix/mvold/three)"

say "LibreOffice saves a fodt whose folder moved (spec, Decisions 7)"
# LibreOffice 26.8's save onto an existing document, from the trace in
# scripts/fs-libreoffice.sh: the new body goes to lu<pid><rand>.tmp
# beside the document, the document is opened read-write and locked, an
# O_EXCL create of it fails EEXIST, and the temp is renamed over it.
# `hold` keeps the document open from before the move (a headless
# save does); `reopen` opens it again at save time (the GUI does).
lo_save() { # lo_save <doc> <url> <cookie> <from> <to> <refresh> <hold|reopen>
  python3 - "$@" <<'PY'
import sys, os, fcntl, subprocess, time
doc, url, ck, fr, to, refresh, mode = sys.argv[1:8]
d = os.path.dirname(doc)
f = open(doc, 'r+b'); fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
body = f.read()
if mode == 'reopen': f.close(); f = None
subprocess.run(['curl', '-s', '-X', 'POST', '-H', ck,
  url + '/apps/lattice/page-move?from=' + fr + '&to=' + to], capture_output=True)
if refresh == '1':
    # the mount lists the tree again, so the old folder is gone from it,
    # and only a folder made again (a sync client, the user) takes a save
    # force the re-list: a write-back of a sibling the move carried off
    # is refused, and a refused write drops the listing (the mount's own
    # clock does not notice a move, see the Task 5 report)
    try:
        with open(os.path.join(d, 'b.md'), 'w') as g: g.write('stale\n')
    except OSError: pass
    for _ in range(40):
        if os.path.basename(d) not in os.listdir(os.path.dirname(d)): break
        time.sleep(0.5)
    else:
        print('never relisted'); sys.exit()
    try: os.mkdir(d)
    except OSError: pass
out = []
tmp = os.path.join(d, 'lu4242xfodt1.tmp')
try:
    t = os.open(tmp, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o644)
    os.write(t, body + b'<!-- stale -->'); os.close(t)
except OSError as e:
    print('temp', e.errno); sys.exit()
if f is None:
    try:
        f = open(doc, 'r+b'); out.append('open ok')
    except OSError as e:
        out.append('open %d' % e.errno)
try:
    os.close(os.open(doc, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o644))
    out.append('excl ok')
except OSError as e:
    out.append('excl %d' % e.errno)
try:
    os.rename(tmp, doc); out.append('rename ok')
except OSError as e:
    out.append('rename %d' % e.errno)
try:
    if f: f.close()
except OSError: pass
print(' '.join(out))
PY
}
FODT="$(cd "$(dirname "$0")/.." && pwd)/tests/writer/corpus/01-paragraphs.fodt"
kind() { curl -s -H "$CK" "$URL/apps/lattice/page-source?name=$1" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["kind"], end="")
except Exception: print("<missing>", end="")'; }
pages_under() { curl -s -H "$CK" "$URL/apps/lattice/page-tree" | python3 -c 'import sys,json
p = sys.argv[1]
print(" ".join(n["path"] for n in json.load(sys.stdin)["nodes"] if n["path"].startswith(p) and n.get("page")), end="")' "$1"; }
want=$(md5sum < "$FODT")
# lo_case <name> <refresh> <mode> <expected result line>
lo_case() {
  local o="fsmatrix/lo$1" n="fsmatrix/lo$1-moved" r
  mkdir -p "$LMNT/$o"; cp "$FODT" "$LMNT/$o/a.fodt"; printf 'b\n' > "$LMNT/$o/b.md"
  sleep 0.6
  is "$1: the document lands as fodt" 'fodt' "$(kind "$o/a")"
  r=$(lo_save "$LMNT/$o/a.fodt" "$URL" "$CK" "$o" "$n" "$2" "$3")
  is "$1: the save is refused as gone (ENOENT)" "$4" "$r"
  is "  the old folder does not come back" '' "$(pages_under "$o/")"
  is "  the moved copy keeps the body from before" "$want" "$(page "$n/a" | md5sum)"
}
# listing stale: the rename is an overwrite of a page that moved away
lo_case stale 0 hold 'excl 17 rename 2'
# listing refreshed (spec, Decisions 7): the old path is gone, so the
# O_EXCL create and the rename are both creates at a moved-away path,
# and +move-guard refuses both, with the document held open or not
lo_case fresh 1 hold 'excl 2 rename 2'
lo_case fresh-gui 1 reopen 'open 2 excl 2 rename 2'

say "rmdir safety"
mkdir "$LMNT/fsmatrix/sub" && printf 'x\n' > "$LMNT/fsmatrix/sub/c.md"; sleep 0.4
rmdir "$LMNT/fsmatrix/sub" 2>/dev/null
is "rmdir non-empty refused (ENOTEMPTY)" '1' "$?"
is "page inside survives" '200' "$(page_http fsmatrix/sub/c)"
rm -rf "$LMNT/fsmatrix/sub"; sleep 0.4
is "rm -r removes subtree on ship" '404' "$(page_http fsmatrix/sub/c)"

say "── generic projection ($GMNT)"

is "read text form (not jam)" 'generic body
line two' "$(cat "$GMNT/gnote.txt")"

say "overwrite in place (edit_file)"
printf 'edited via fuse\n' > "$GMNT/gnote.txt"
sleep 0.4
is "overwrite lands, blot preserved" 'edited via fuse' "$(grub_txt gnote)"
is "mark still hoon" '"hoon"' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("gnote")),end="")')"

say "create refused (unknown target mark)"
( echo x > "$GMNT/new.txt" ) 2>/dev/null   # EROFS surfaces at close. Shell rc unreliable
sleep 0.4
is "created grub never lands on ship" 'null' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("new")),end="")')"

say "delete file + rm -r folder"
rm -f "$GMNT/gdel.txt"; sleep 0.4
is "grub deleted on ship" 'null' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["files"].get("gdel")),end="")')"
rmdir "$GMNT/gdir" 2>/dev/null
is "rmdir non-empty refused" '1' "$?"
rm -rf "$GMNT/gdir"; sleep 0.6
is "rm -r clears folder on ship" '{}' "$(gtree | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["dirs"]),end="")')"

if [ "$fails" -ne 0 ]; then
  say "── lattice mount log:"; sed 's/^/  /' "$WORK/lat.log" | tail -40
  say "── generic mount log:"; sed 's/^/  /' "$WORK/gen.log" | tail -10
fi
finish
