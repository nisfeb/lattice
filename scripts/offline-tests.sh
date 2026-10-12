#!/usr/bin/env bash
# offline-tests.sh: run the Hoon suites in tests/lib through vere eval,
# with no ship (scripts/hoon-test-kit/offline-test.py). Seconds per suite.
# The ship run (TESTING.md) stays the verdict.
#
#   scripts/offline-tests.sh            every suite that runs offline
#   scripts/offline-tests.sh md pg      by name, no .hoon
#
# lattice-sign needs cric:crypto, which vere eval's zuse does not have, so
# it runs on the ship only.
set -uo pipefail
cd "$(dirname "$0")/.."
ship_only=" lattice-sign "
if (($#)); then names=("$@"); else
  names=(); for f in tests/lib/*.hoon; do n=$(basename "$f" .hoon)
    [[ $ship_only == *" $n "* ]] || names+=("$n"); done
fi
fail=0
for n in "${names[@]}"; do
  out=$(python3 scripts/hoon-test-kit/offline-test.py "tests/lib/$n.hoon" 2>&1); rc=$?
  printf '%-22s %s\n' "$n" "$(tail -1 <<<"$out")"
  ((rc == 0)) || { fail=1; sed -n '1,40p' <<<"$out"; }
done
exit $fail
