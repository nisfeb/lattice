# hygiene.sh: sourced by the shell suites that start Xvfb, browsers or
# drivers. The shell half of lib/hygiene.mjs (read it for the why): no core
# dumps, every child marked with LATTICE_TEST_OWNER and LATTICE_TEST_TAG,
# scratch under ~/.cache/lattice-gate, and a disk check.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/hygiene.sh"
#   lattice_disk_ok || exit 2        # before anything heavy
#   lattice_reap                     # in the EXIT trap: kill what we started

ulimit -c 0

_lattice_tag() { # pid -> pid:starttime
  local s; s=$(<"/proc/$1/stat"); s=${s##*) }
  # shellcheck disable=SC2086
  set -- $s; echo "$1:${20}"
}
_lattice_me=$$:$(_lattice_tag $$ | cut -d: -f2)
export LATTICE_TEST_OWNER=${LATTICE_TEST_OWNER:-$_lattice_me}
export LATTICE_TEST_TAG=${LATTICE_TEST_TAG:-$_lattice_me}
export LATTICE_SCRATCH=${LATTICE_SCRATCH:-$HOME/.cache/lattice-gate}
if [ -z "${TMPDIR:-}" ]; then
  export TMPDIR=$LATTICE_SCRATCH/tmp
  mkdir -p "$TMPDIR"
fi

lattice_disk_ok() {
  local r t
  r=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
  t=$(df --output=avail -BG /tmp | tail -1 | tr -dc 0-9)
  if [ "$r" -lt 10 ] || [ "$t" -lt 2 ]; then
    echo "refusing to start: / has ${r} GB free (need 10), /tmp ${t} GB (need 2)" >&2
    return 1
  fi
}

# Kill what carries this script's tag, when the script is its own owner
# (under gate.mjs the gate does it). Never this shell or its subshells.
lattice_reap() {
  [ "$LATTICE_TEST_OWNER" = "$_lattice_me" ] || return 0
  local e p
  for e in /proc/[0-9]*/environ; do
    p=${e#/proc/}; p=${p%/environ}
    [ "$p" = $$ ] || [ "$p" = "${BASHPID:-}" ] && continue
    grep -qzxF "LATTICE_TEST_TAG=$LATTICE_TEST_TAG" "$e" 2>/dev/null && kill -KILL "$p" 2>/dev/null
  done
  return 0
}
