#!/usr/bin/env bash
# hoon-test-kit: run an app's Hoon suites on a running fake ship, on a desk
# that holds nothing but the libs under test and their tests. See README.md
# and PLAYBOOK.md.
#
#   hoon-test.sh <pier> setup          once per ship, after |new-desk + |mount
#   hoon-test.sh <pier> [suite ...]    sync, commit, test
#
# The app is described by hoon-test.conf, found in the current directory or
# the nearest one above it (or at $HOON_TEST_CONF); paths in it are relative
# to it. A suite is a test file's name without .hoon; none runs them all.
#
# Prints OK/FAILED/CRASHED per test, with each failure's expected/actual.
# Exits 0 when every test passes, 1 when one fails, 3 when a lib does not
# build, 4 when the ship does not answer. A build error's own message is
# still only on the ship's terminal: clay slogs it and answers ~.
set -euo pipefail

conf=${HOON_TEST_CONF:-}
if [[ -z "$conf" ]]; then
  d=$PWD
  while [[ "$d" != / && ! -f "$d/hoon-test.conf" ]]; do d=$(dirname "$d"); done
  conf="$d/hoon-test.conf"
fi
[[ -f "$conf" ]] || { echo "no hoon-test.conf here or above" >&2; exit 2; }
root=$(cd "$(dirname "$conf")" && pwd)
MARKS="json mime" FILES="" DIALECT=clay CODE="" PRELUDE=""
# shellcheck source=/dev/null
source "$conf"
: "${DESK:?hoon-test.conf sets DESK}" "${LIBS:?hoon-test.conf sets LIBS}" "${TESTS:?hoon-test.conf sets TESTS}"

kit=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ "$DIALECT" == clay || ( "$DIALECT" == grubbery && -n "$CODE" ) ]] ||
  { echo "hoon-test.conf: DIALECT is clay or grubbery, and grubbery needs CODE" >&2; exit 2; }
pier=$(cd "${1:?usage: hoon-test.sh <pier> [setup | suite ...]}" && pwd); shift
sock="$pier/.urb/conn.sock"
# the runtime is only used for its jam/cue framing: $VERE, or the newest
# vere-* sitting beside the pier
VERE=${VERE:-$(ls -d "$(dirname "$pier")"/vere-*-linux-x86_64 2>/dev/null | sort -V | tail -1)}
[[ -x "$VERE" ]] || { echo "no vere binary: set VERE" >&2; exit 2; }

# A LIBS entry is src or src=dest. With no dest it lands at lib/<name>.hoon,
# or, for a grubbery app, at its path under CODE (lib/rules/x.hoon).
lib_src() { echo "${1%%=*}"; }
lib_dest() {
  if [[ "$1" == *=* ]]; then echo "${1#*=}"
  elif [[ "$DIALECT" == grubbery ]]; then echo "${1#"${CODE%/}"/}"
  else echo "lib/${1##*/}"; fi
}

# repo -> desk: each LIBS file to its dest (a grubbery lib translated into
# clay's dialect on the way, see grubbery_clay.py), each TESTS/*.hoon to
# tests/lib/, each FILES entry to the same path (or src=dest). Output is
# the changed paths, so empty means nothing changed.
sync() {
  local d="$pier/$DESK" f src dst
  mkdir -p "$d/lib" "$d/tests/lib"
  for f in $LIBS; do
    src=$(lib_src "$f"); dst=$(lib_dest "$f")
    mkdir -p "$d/$(dirname "$dst")"
    if [[ "$DIALECT" == grubbery ]]; then
      # shellcheck disable=SC2086
      python3 "$kit/grubbery_clay.py" "$root/$CODE" "$root/$src" "$d/$dst" "$d" $PRELUDE
    else
      rsync -ci "$root/$src" "$d/$dst"
    fi
  done
  # --delete: a test file removed from the repo leaves the desk too, or
  # the suite it held would keep running there
  rsync -rci --delete --include='*.hoon' --exclude='*' "$root/$TESTS"/ "$d/tests/lib/"
  for f in $FILES; do
    src=${f%%=*}; dst=${f#*=}
    mkdir -p "$d/$(dirname "$dst")"
    rsync -ci "$root/$src" "$d/$dst"
  done
}

# Run hoon (a strand producing a vase) in a khan thread over conn.sock and
# print the product noun. The hoon rides as a cord, so it holds no ', and
# on one line, so every newline becomes a two-space gap: one space is not
# a gap, and the parse fails.
# No answer at all is exit 4, never a test verdict: a ship that crashed
# mid-run must not read as a failing suite (or a killed mutant).
ted() {
  local hoon out; hoon=$(sed ':a;N;$!ba;s/\n/  /g')
  out=$(printf '%s\n' "[0 %fyrd [%base %khan-eval %noun [%ted-eval '$hoon']]]" |
    "$VERE" eval --jam -n 2>/dev/null |
    socat -T "${T:-60}" -,ignoreeof UNIX-CONNECT:"$sock" 2>/dev/null |
    "$VERE" eval --cue -n 2>/dev/null | tail -1 |
    sed -E 's/^\[0 %avow 0 %noun (.*)\]$/\1/' |
    # a failed thread's tang arrives as [%leaf <bytes> 0]: make it text
    perl -pe 's/\[%leaf ((?:\d+ )*)0\]/join "", map chr, split " ", $1/ge' |
    # and a product that is itself [%leaf tape] (the test report) arrives bare
    perl -pe 's/^%leaf ((?:\d+ )*)0$/join "", map chr, split " ", $1/e') || true
  [[ -n "$out" ]] || { echo "the ship at $pier did not answer" >&2; return 4; }
  echo "$out"
}

hash() { ted <<EOF
=/  m  (strand ,vase)
;<  h=@uvI  bind:m  (scry @uvI /cz/$DESK)
(pure:m !>(h))
EOF
}

if [[ "${1:-}" == setup ]]; then
  # |new-desk %$DESK and |mount %$DESK in the dojo first: both are one
  # line there. This copies the test harness and the MARKS the suites
  # need in from the ship's own %base, so they always match its kelvin;
  # a file already on the desk is left alone, so setup can be rerun.
  # %json builds through its grad mark, %mime: without it a /* of a json
  # file fails the whole suite as a build error.
  marks=""
  for k in $MARKS; do marks+=" /mar/$k/hoon"; done
  ted >/dev/null <<EOF
=/  m  (strand ,vase)
=/  paz=(list path)  ~[/lib/test/hoon$marks]
=|  fil=soba:clay
|-
?^  paz
  ;<  has=?  bind:m  (scry ? (weld /cu/$DESK i.paz))
  ?:  has  \$(paz t.paz)
  ;<  t=@t  bind:m  (scry @t (weld /cx/base i.paz))
  \$(paz t.paz, fil [[i.paz %ins %hoon !>(t)] fil])
;<  ~  bind:m  (send-raw-card [%pass /setup %arvo %c %info %$DESK %& fil])
(pure:m !>(%ok))
EOF
  echo "setup done: /lib/test.hoon and the marks are on %$DESK"
  # SHIP_FILES: libs the app's code expects from a desk on this ship
  # (a grubbery nexus's tarball, nexus and fiberio come from %grubbery),
  # copied from that desk so they match what is installed. Unlike the
  # harness above, a copy that differs from the ship's is REFRESHED:
  # these move whenever that desk is upgraded.
  if [[ -n "${SHIP_FILES:-}" ]]; then
    sf=""
    for f in $SHIP_FILES; do
      p=${f#*:}; p=${p%.hoon}
      sf+=" [%${f%%:*} /$p/hoon]"
    done
    got=$(ted <<EOF
=/  m  (strand ,vase)
=/  paz=(list [@tas path])  ~[${sf# }]
=|  fil=soba:clay
|-
?^  paz
  =*  d  -.i.paz
  =*  p  +.i.paz
  ;<  t=@t  bind:m  (scry @t (weld \`path\`/cx/[d] p))
  ;<  has=?  bind:m  (scry ? (weld /cu/$DESK p))
  ?.  has  \$(paz t.paz, fil [[p %ins %hoon !>(t)] fil])
  ;<  o=@t  bind:m  (scry @t (weld /cx/$DESK p))
  ?:  =(o t)  \$(paz t.paz)
  \$(paz t.paz, fil [[p %mut %hoon !>(t)] fil])
?~  fil  (pure:m !>(1))
;<  ~  bind:m  (send-raw-card [%pass /setup %arvo %c %info %$DESK %& fil])
(pure:m !>(0))
EOF
)
    if [[ "$got" == 0 ]]; then echo "setup: SHIP_FILES copied or refreshed on %$DESK"
    else echo "setup: SHIP_FILES already current on %$DESK"; fi
  fi
  exit
fi

# NOSYNC=1 commits the mount as it stands: how hoon-mutate.py runs the
# suites against a mutant it wrote there, which a sync would overwrite.
# a sync that fails (a lib the translator refuses) stops here: inside the
# test below, its empty output would read as "nothing changed"
changed=""
if [[ -z "${NOSYNC:-}" ]]; then changed=$(sync) || { echo "could not sync the test desk" >&2; exit 2; }; fi
if [[ -n "${NOSYNC:-}" || -n "$changed" ]]; then
  before=$(hash)
  ted >/dev/null <<EOF
=/  m  (strand ,vase)
;<  =bowl  bind:m  get-bowl
;<  ~  bind:m  (poke [our.bowl %hood] kiln-commit+!>([%$DESK |]))
(pure:m !>(%ok))
EOF
  # the commit lands as a later event than the poke's ack
  for _ in $(seq 60); do [[ "$(hash)" != "$before" ]] && break; sleep 1; done
fi

libs=""
for l in $LIBS; do l=$(lib_dest "$l"); libs+=" /${l%.hoon}/hoon"; done
suites=""
for s in "$@"; do suites+=" /tests/lib/$s/hoon"; done
# ~[] does not parse: an empty list is ~
want="~"; [[ -n "$suites" ]] && want="~[${suites# }]"
# The libs are built first, so a lib that does not compile is its own
# answer. Then each test file is built and its test- arms run here, as
# base's %test thread does, but the report comes back over the socket
# (as [%leaf tape], which ted decodes) instead of going to the ship's
# terminal: OK/FAILED/CRASHED per test, with each failure's tang.
report=$(T=${TEST_T:-600} ted <<EOF
=/  m  (strand ,vase)
;<  =bowl  bind:m  get-bowl
=/  bek=beak  [our.bowl %$DESK da+now.bowl]
=/  libs=(list path)  ~[${libs# }]
|-
?^  libs
  ;<  v=(unit vase)  bind:m  (build-file [bek i.libs])
  ?~  v  (pure:m !>([%leaf "NOBUILD {(spud i.libs)}"]))
  \$(libs t.libs)
;<  all=(list path)  bind:m  (scry (list path) /ct/$DESK/tests/lib)
=/  want=(list path)  $want
=/  fiz=(list path)  ?^(want want (sort (skim all |=(p=path =(%hoon (rear p)))) aor))
=/  show  |=(t=tang ^-(wall (zing (turn t |=(k=tank (~(win re k) 2 118))))))
=|  out=wall
|-
?~  fiz  (pure:m !>([%leaf (zing (turn (flop out) |=(t=tape (weld t (trip 10)))))]))
;<  cor=(unit vase)  bind:m  (build-file [bek i.fiz])
?~  cor  \$(fiz t.fiz, out ["FAILED  {(spud (snip i.fiz))} (build)" out])
=/  arms=(list term)  (sort (skim (sloe p.u.cor) |=(a=term =((end [3 5] a) (crip "test-")))) aor)
=/  lines=wall
  %-  zing
  %+  turn  arms
  |=  a=term
  ^-  wall
  =/  name=tape  "{(spud (snip i.fiz))}/{(trip a)}"
  =/  fire=nock  q:(~(mint ut p.u.cor) p:!>(*tang) [%limb a])
  =/  run  (mule |.(;;(tang .*(q.u.cor fire))))
  ?:  ?=(%| -.run)  ["CRASHED {name}" (show p.run)]
  ?~  p.run  ["OK      {name}" ~]
  ["FAILED  {name}" (show p.run)]
\$(fiz t.fiz, out (weld (flop lines) out))
EOF
)
case "$report" in
  NOBUILD*) echo "a lib did not build: ${report#NOBUILD }"; exit 3 ;;
esac
printf '%s\n' "$report"
passed=$(grep -c '^OK ' <<<"$report" || true)
failed=$(grep -c '^\(FAILED\|CRASHED\)' <<<"$report" || true)
if [[ "$failed" -gt 0 ]]; then echo "hoon tests FAILED: $failed failed, $passed passed"; exit 1; fi
if [[ "$passed" -eq 0 ]]; then echo "no tests ran: $report"; exit 2; fi
echo "hoon tests passed: $passed"
