# matrix.sh: sourced by the shell matrices. Where the ship is, which cookie
# proves we are logged in, and how a check reports. These used to be copied
# into each suite, and the copies drifted: three cookie defaults, a ~ that
# only some expanded, four spellings of the same ok/FAIL line.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/matrix.sh"
#
# A suite that takes the ship URL as an argument sets LATTICE_URL from it
# before sourcing this.

# Both must be set: there is no default ship. The old fallback was
# localhost:8080, the owner's own dev ship (~tyr). scripts/gate.mjs sets
# both; by hand, point them at a fake ship or a fleet clone.
if [ -z "${LATTICE_URL:-}" ] || [ -z "${LATTICE_COOKIE:-}" ]; then
  echo "LATTICE_URL and LATTICE_COOKIE must be set to a throwaway ship (there is no default ship)" >&2
  exit 2
fi
URL="${LATTICE_URL%/}"
B="$URL/apps/lattice"
CKF="${LATTICE_COOKIE/#\~/$HOME}"

# A suite that sends the session cookie calls this first. A missing cookie
# exits 2, "could not test", rather than failing every check with a 403.
need_cookie() {
  [ -r "$CKF" ] || { echo "no cookie at $CKF (set LATTICE_COOKIE)" >&2; exit 2; }
  CK="Cookie: $(cat "$CKF")"
}

fails=0
ok()    { echo "  ok   - $1"; }
bad()   { echo "  FAIL - $1${2:+ ($2)}"; fails=$((fails + 1)); }
# is <name> <expected> <actual>
is()    { if [ "$3" = "$2" ]; then ok "$1"; else bad "$1" "want $2 got $3"; fi; }
# has / hasnt <name> <needle> <haystack>
has()   { if printf '%s' "$3" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "no '$2' in: $(printf '%s' "$3" | head -c 140)"; fi; }
hasnt() { if printf '%s' "$3" | grep -qF -- "$2"; then bad "$1" "unexpected '$2'"; else ok "$1"; fi; }

# the summary line, then exit 1 if anything failed
finish() {
  echo
  if [ "$fails" = 0 ]; then echo "$(basename "$0" .sh) PASSED"; exit 0; fi
  echo "$(basename "$0" .sh) FAILED ($fails)"; exit 1
}
