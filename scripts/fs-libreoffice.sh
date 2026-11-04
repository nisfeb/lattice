#!/usr/bin/env bash
# fs-libreoffice.sh: LibreOffice saves a fodt page through lattice-fs.
#
# Real soffice, a throwaway profile, a live ship and a fresh mount. It
# checks on the ship (over HTTP) that a headless save and a GUI save each
# land as one revision of a fodt page, byte-identical to what the mount
# serves, and that LibreOffice's lock file and temps never reach the ship.
#
# Usage:  scripts/fs-libreoffice.sh [ship-url]
#   env:  LATTICE_URL and LATTICE_COOKIE (required, a throwaway ship)
#         The mount
#           runs with a temporary HOME that holds only this cookie, so the
#           user's lattice-fs config is never read or written.
#         LO_TRACE=<dir>  also record every file call LibreOffice makes on
#           the mount (scripts/lib/fstrace.c, needs cc) into <dir>
#   needs soffice, a built lattice-fs (cargo build --release), and Xvfb
#   for the GUI case (skipped without it).
#
# LibreOffice's save pattern, recorded with LO_TRACE on LibreOffice
# 26.8.0.3 against a lattice-fs mount (2026-11-02; this machine has no
# strace, so fstrace.c logged the libc calls instead). Stats and access
# probes are left out, except where they decide something.
#
# Headless, new document (--convert-to fodt --outdir <mount dir>):
#   access report.fodt          ENOENT (x5)
#   open .~lock.report.fodt#    R  ENOENT, then RW|CREAT|EXCL, 57 bytes, close
#   access <dir>                0 (the directory is the writability probe)
#   open lu<pid><rand>.tmp      RW|CREAT|EXCL, close, reopen RW|CREAT,
#                               write the whole body, close
#   open report.fodt            RW|CREAT|EXCL ok: a COPY, not a rename.
#                               fcntl F_SETLK write lock, write the body
#                               from the temp, close
#   unlink lu<pid><rand>.tmp
#   open report.fodt            RW, F_SETLK, fsync, close
#   unlink .~lock.report.fodt#
#
# Headless, existing document (the same command again):
#   access report.fodt W=0 X=EACCES (the writability probe)
#   lock file as above
#   lu<pid><rand>.tmp           created and written as above
#   open report.fodt            RW|CREAT|EXCL fails EEXIST
#   rename lu<pid><rand>.tmp -> report.fodt
#   open report.fodt            RW, F_SETLK, fsync, close
#   unlink .~lock.report.fodt#
#
# GUI (soffice under Xvfb, open, type, .uno:Save, close):
#   open report.fodt            RW, F_SETLK, held while loading; R twice
#   access W=0 X=EACCES, lock file created (60 bytes)
#   load ends: the RW handle is closed and the lock file unlinked
#   save: lu<pid><rand>.tmp RW|CREAT|EXCL, close, reopen RW|CREAT
#         open report.fodt RW, F_SETLK, lock file created again, close
#         write the temp, close
#         open report.fodt RW|CREAT|EXCL fails EEXIST
#         rename lu<pid><rand>.tmp -> report.fodt
#         open report.fodt RW, F_SETLK, fsync, close
#   close: open report.fodt RW, F_SETLK, close; unlink the lock file
#
# What lattice-fs does with it: the lock file and the temp are scratch
# (core.rs is_scratch, is_editor_temp) and stay in the mount's RAM. The
# first save's O_EXCL create plus write is an ordinary create with kind
# fodt. A later save's rename is EditorMove::Promote, an overwrite with
# the destination's kind. The read-write opens that write nothing send
# nothing. LibreOffice never calls utimensat or futimens on the mount,
# so the ENOENT a touch of a scratch name gets does not matter to it.
# No change to core.rs was needed.

set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib/hygiene.sh"   # no cores, marked children
lattice_disk_ok || exit 2
LATTICE_URL="${1:-${LATTICE_URL:-}}"
. "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
need_cookie
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/lattice-fs-rs/target/release/lattice-fs"
CORPUS="$ROOT/tests/writer/corpus"
WORK="$(mktemp -d)"
LMNT="$WORK/lat" PROF="$WORK/prof" SRC="$WORK/src"
D=folibre            # the test folder on the ship
XPID=""

say() { printf '%s\n' "$*"; }

cleanup() {
  lattice_reap
  cd /
  [ -n "$XPID" ] && kill "$XPID" 2>/dev/null
  fusermount -u "$LMNT" 2>/dev/null || fusermount3 -u "$LMNT" 2>/dev/null
  sleep 0.3
  curl -s -X POST -H "$CK" "$B/page-del?name=$D" -o /dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

command -v soffice >/dev/null || { say "soffice not installed"; exit 2; }
[ -x "$BIN" ] || { say "build first: cargo build --release (missing $BIN)"; exit 2; }
curl -s -o /dev/null --max-time 3 "$URL/" || { say "ship unreachable at $URL"; exit 2; }

# the mount reads cookie-<scheme>-<host>-<port> under $HOME/.config
CFILE=$(python3 - "$URL" <<'PY'
import sys, re
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
port = u.port or (443 if u.scheme == 'https' else 80)
print(re.sub(r'[^A-Za-z0-9._-]', '_', 'cookie-%s-%s-%d' % (u.scheme, u.hostname, port)))
PY
)
mkdir -p "$WORK/home/.config/lattice-fs" "$LMNT" "$SRC"
chmod 700 "$WORK" "$WORK/home/.config/lattice-fs"
install -m 600 "$CKF" "$WORK/home/.config/lattice-fs/$CFILE"

# json field of a page, or <missing>
pj() { curl -s -H "$CK" "$B/page-source?name=$1" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)[sys.argv[1]], end="")
except Exception: print("<missing>", end="")' "$2"; }
body() { curl -s -H "$CK" "$B/page-source?name=$1" | python3 -c 'import sys,json
try: sys.stdout.buffer.write(json.load(sys.stdin)["body"].encode())
except Exception: pass'; }
# every page path, one per line, filtered by a python regex
pages() { curl -s -H "$CK" "$B/page-tree" | python3 -c 'import sys,json,re
r = re.compile(sys.argv[1])
for n in json.load(sys.stdin)["nodes"]:
    if n.get("page") and r.search(n["path"]): print(n["path"])' "$1"; }
conflicts() { pages '^conflicts/' | sort; }
# no LibreOffice lock or temp anywhere on the ship
no_scratch() { is "$1" '' "$(pages '(^|/)(\.~lock\.|lu[0-9a-z]+\.tmp$)|\.tmp$|#$' | tr '\n' ' ')"; }
same_as_mount() { # the ship's body is byte-identical to the mount's file
  if cmp -s <(body "$D/report") "$LMNT/$D/report.fodt"; then echo same; else echo differs; fi; }

TRACE=""
if [ -n "${LO_TRACE:-}" ]; then
  mkdir -p "$LO_TRACE"
  cc -shared -fPIC -O1 -o "$WORK/fstrace.so" "$ROOT/scripts/lib/fstrace.c" -ldl \
    || { say "could not build fstrace.so"; exit 2; }
  TRACE=1
fi
# lo <trace-name> <soffice args...>: soffice with the throwaway profile
lo() {
  local t="$1"; shift
  if [ -n "$TRACE" ]; then
    FSTRACE_ROOT="$LMNT/$D" FSTRACE_LOG="$LO_TRACE/$t.log" LD_PRELOAD="$WORK/fstrace.so" \
      timeout 180 soffice -env:UserInstallation="file://$PROF" "$@"
  else
    timeout 180 soffice -env:UserInstallation="file://$PROF" "$@"
  fi
}

curl -s -X POST -H "$CK" "$B/page-del?name=$D" -o /dev/null
unset LATTICE_SOCK
HOME="$WORK/home" LATTICE_URL="$URL" "$BIN" mount "$LMNT" >/dev/null 2>"$WORK/lat.log" &
sleep 2
exec </dev/null
mkdir -p "$LMNT/$D"
C0=$(conflicts)

say "headless save, new document (--convert-to fodt --outdir <mount>)"
cp "$CORPUS/10-unknown.fodt" "$SRC/report.fodt"
lo headless-new --headless --convert-to "fodt:OpenDocument Text Flat XML" \
  --outdir "$LMNT/$D" "$SRC/report.fodt" >/dev/null 2>&1
sleep 0.6
is "the page exists with kind fodt" 'fodt' "$(pj "$D/report" kind)"
is "page-source is the file the mount serves" same "$(same_as_mount)"
has "it is LibreOffice's save of the document" 'office:document' "$(body "$D/report" | head -c 4000)"
R1=$(pj "$D/report" rev)
no_scratch "no lock file or temp reached the ship"

say "headless save over the same name"
cp "$CORPUS/03-inline.fodt" "$SRC/report.fodt"
lo headless-over --headless --convert-to "fodt:OpenDocument Text Flat XML" \
  --outdir "$LMNT/$D" "$SRC/report.fodt" >/dev/null 2>&1
sleep 0.6
is "one new revision" "$((R1 + 1))" "$(pj "$D/report" rev)"
is "still kind fodt" 'fodt' "$(pj "$D/report" kind)"
is "page-source is the file the mount serves" same "$(same_as_mount)"
has "it holds the new document" 'Strong_20_Emphasis' "$(body "$D/report")"
is "no conflicts/ copy" "$C0" "$(conflicts)"
no_scratch "no lock file or temp reached the ship"
is "the folder holds the one page" "$D/report" "$(pages "^$D/" | tr '\n' ' ' | sed 's/ $//')"

say "GUI save (open, type, Save, close)"
XV=$(command -v Xvfb)
if [ -z "$XV" ]; then
  say "  skip - no Xvfb"
else
  # a private display, never the user's
  n=91; while [ -e "/tmp/.X11-unix/X$n" ] || [ -e "/tmp/.X$n-lock" ]; do n=$((n + 1)); done
  "$XV" ":$n" -nolisten tcp -screen 0 1280x1024x24 >/dev/null 2>&1 & XPID=$!
  sleep 1
  # a Basic macro in the throwaway profile's own library drives the GUI:
  # My Macros run without a security prompt, and no pyuno is needed
  cat > "$PROF/user/basic/Standard/Module1.xba" <<'XBA'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
Sub Go(sUrl As String)
  Dim oDoc As Object, oText As Object, oDisp As Object
  oDoc = StarDesktop.loadComponentFromURL(sUrl, &quot;_blank&quot;, 0, Array())
  Wait 1500
  oText = oDoc.getText()
  oText.insertString(oText.getEnd(), &quot; typed in the GUI&quot;, False)
  oDisp = createUnoService(&quot;com.sun.star.frame.DispatchHelper&quot;)
  oDisp.executeDispatch(oDoc.getCurrentController().getFrame(), &quot;.uno:Save&quot;, &quot;&quot;, 0, Array())
  Wait 1500
  oDoc.close(True)
  StarDesktop.terminate()
End Sub
</script:module>
XBA
  R2=$(pj "$D/report" rev)
  DISPLAY=":$n" lo gui --norestore --nologo \
    "macro:///Standard.Module1.Go(\"file://$LMNT/$D/report.fodt\")" >/dev/null 2>&1
  sleep 0.6
  is "one new revision" "$((R2 + 1))" "$(pj "$D/report" rev)"
  is "still kind fodt" 'fodt' "$(pj "$D/report" kind)"
  has "the edit is on the ship" 'typed in the GUI' "$(body "$D/report")"
  is "page-source is the file the mount serves" same "$(same_as_mount)"
  is "no conflicts/ copy" "$C0" "$(conflicts)"
  no_scratch "no lock file or temp reached the ship"
  is "the folder holds the one page" "$D/report" "$(pages "^$D/" | tr '\n' ' ' | sed 's/ $//')"
fi

[ -n "$TRACE" ] && say "traces in $LO_TRACE"
if [ "$fails" -ne 0 ]; then
  say "── mount log:"; sed 's/^/  /' "$WORK/lat.log" | tail -30
fi
finish
