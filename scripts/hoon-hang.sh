#!/usr/bin/env bash
#  hoon-hang.sh: find inputs that make a Hoon parser LOOP FOREVER.
#
#  WHY THIS EXISTS, AND WHY IT CANNOT LIVE IN THE SHIP
#  ---------------------------------------------------
#  +mule and +mong virtualize a computation and catch its CRASH. Neither has a
#  fuel counter, a step limit, or a timeout. There is no such thing in Hoon.
#  So a parser that crashes on hostile input is a caught, reportable failure,
#  and a parser that SPINS on hostile input is an event that never completes:
#  the Arvo event loop is single-threaded, the pier stops answering, and every
#  in-ship test runner (including %quiz, see grubbery-overlay/lib/quiz.hoon)
#  is inside the thing that stopped. A test that hangs reports nothing. It
#  cannot report anything. It is not running any more.
#
#  The only instrument that survives the failure is one OUTSIDE the ship with
#  a wall clock. That is this script. It is not a nicety; it is the entire
#  observable surface of an infinite-loop bug in this codebase.
#
#  WHAT IT DOES
#  ------------
#  Feeds adversarial bodies to the routes that reach the hand-written parsers
#  (/lib/lattice-clip, /lib/lattice-md, /lib/lattice-urls, /lib/catalog-analyzer),
#  each with a hard deadline. After EVERY probe it fires a cheap canary at a
#  route that touches no parser. Three outcomes per probe:
#
#    OK     answered inside the deadline
#    SLOW   blew the deadline, but the canary came back: the ship is alive and
#           the request was merely expensive. Worth reading, not a hang.
#    WEDGE  blew the deadline and the canary never came back inside the grace
#           window. The event did not finish. STOP IMMEDIATELY: every further
#           request queues behind the one that is still running, so continuing
#           destroys the evidence and tells you nothing new.
#
#  The SLOW/WEDGE split is the whole design. A single timeout cannot tell a
#  slow render from a hang, because both look like "no answer yet", and a pier
#  that serialises requests makes a slow render look worse the more you send.
#  Only the canary distinguishes them, and only if it runs after every probe.
#
#  USAGE
#    scripts/hoon-hang.sh [--quick] [--family NAME] [--verbose]
#      --quick        one probe per shape instead of the full ladder
#      --family NAME  clip | md | gmi | urls | catalog | save  (repeatable)
#      --verbose      print the canary timing for every probe
#
#  ENV
#    LATTICE_URL      ship base, default http://localhost:8081 (the ~nec dev
#                     harness). LOOPBACK ONLY, enforced below: this hammers a
#                     ship until it stops answering and must never be aimed at
#                     urbit.sneagan.com or any other real pier.
#    LATTICE_COOKIE   cookie file, default ~/.config/lattice-fs/nec-cookie
#    HANG_TIMEOUT     per-probe deadline in seconds (default 25)
#    CANARY_TIMEOUT   per-canary deadline in seconds (default 30)
#    CANARY_TRIES     canary attempts before declaring a wedge (default 4)
#
#  EXIT
#    0  every probe answered, or was merely SLOW; canary green at the end
#    1  a WEDGE was observed (the interesting outcome; read the report)
#    2  misuse (non-loopback target, no cookie, ship already down)
set -uo pipefail

URL_BASE="${LATTICE_URL:-http://localhost:8081}"
URL_BASE="${URL_BASE%/}"
COOKIE_FILE="${LATTICE_COOKIE:-$HOME/.config/lattice-fs/nec-cookie}"
HANG_TIMEOUT="${HANG_TIMEOUT:-25}"
CANARY_TIMEOUT="${CANARY_TIMEOUT:-30}"
CANARY_TRIES="${CANARY_TRIES:-4}"

QUICK=0
VERBOSE=0
FAMILIES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick)   QUICK=1 ;;
    --verbose) VERBOSE=1 ;;
    --family)  shift; FAMILIES="$FAMILIES $1" ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$FAMILIES" ] || FAMILIES="clip md gmi urls catalog save"

#  Guard rail. This script's SUCCESS CONDITION is finding a request that takes
#  the ship down. Pointing it at anything but a disposable loopback pier is
#  not a mistake, it is an outage.
HOST="$(printf '%s' "$URL_BASE" | sed -E 's#^[a-z]+://##; s#[:/].*##')"
case "$HOST" in
  localhost|127.0.0.1|::1|'[::1]') ;;
  *) echo "REFUSING: $HOST is not loopback. This script wedges ships." >&2; exit 2 ;;
esac
[ -r "$COOKIE_FILE" ] || { echo "no cookie at $COOKIE_FILE" >&2; exit 2; }
COOKIE="$(cat "$COOKIE_FILE")"
B="$URL_BASE/apps/lattice"
NS="hang$$"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

#  ── payload generators ────────────────────────────────────────────────────
#  awk, not a bash loop: these run to hundreds of thousands of repetitions and
#  a shell loop spends longer building the payload than the ship spends
#  choking on it.

#  rep <count> <string>            -> string repeated count times
rep() { awk -v n="$1" -v s="$2" 'BEGIN{o="";for(i=0;i<n;i++)o=o s;printf "%s",o}'; }
#  nest <count> <open> <close>     -> open^n close^n  (balanced, deep)
nest() { awk -v n="$1" -v o="$2" -v c="$3" 'BEGIN{a="";b="";for(i=0;i<n;i++){a=a o;b=b c}printf "%s%s",a,b}'; }
#  lines <count> <prefix>          -> prefix + newline, count times
lines() { awk -v n="$1" -v p="$2" 'BEGIN{for(i=0;i<n;i++)printf "%s\n",p}'; }

scale() { [ "$QUICK" -eq 1 ] && echo "$2" || echo "$1"; }

#  ── probe machinery ───────────────────────────────────────────────────────

N_OK=0; N_SLOW=0; N_WEDGE=0; N_TOTAL=0; N_MISS=0
SLOW_LIST=""
MISS_LIST=""
WEDGED=""

#  canary: a route that reads one grub and parses nothing. If THIS answers,
#  the event loop is turning and the previous probe merely cost a lot. If it
#  does not, the previous event never finished.
canary() {
  local i rc
  for i in $(seq 1 "$CANARY_TRIES"); do
    rc=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$CANARY_TIMEOUT" \
           -H "Cookie: $COOKIE" "$B/bookmarks" 2>/dev/null)
    case "$rc" in
      2*|3*|4*) return 0 ;;   #  any real HTTP answer means the ship is turning
    esac
    sleep 5
  done
  return 1
}

#  probe <family> <label> <curl-args...>
#  Runs one adversarial request under a hard deadline, then the canary.
probe() {
  local fam="$1" label="$2"; shift 2
  N_TOTAL=$((N_TOTAL + 1))
  local t0 t1 dt rc
  t0=$(date +%s)
  rc=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HANG_TIMEOUT" \
         -H "Cookie: $COOKIE" "$@" 2>/dev/null)
  t1=$(date +%s); dt=$((t1 - t0))

  if [ "$rc" != "000" ]; then
    N_OK=$((N_OK + 1))
    #  A 404/405 means the request never reached a parser. That is a BROKEN
    #  PROBE, not a passing one, and it is indistinguishable from a passing one
    #  in the OK column. Count them separately or a typo'd route reads as
    #  "no hangs found" forever.
    case "$rc" in
      404|405) N_MISS=$((N_MISS + 1)); MISS_LIST="$MISS_LIST
    $fam/$label (http $rc)" ;;
    esac
    printf '  OK    %-8s %-38s %ss http=%s\n' "$fam" "$label" "$dt" "$rc"
    #  Still canary. A probe can answer 200 and leave a background fiber
    #  spinning; the next probe would then be blamed for it.
    if ! canary; then
      N_WEDGE=$((N_WEDGE + 1)); WEDGED="$fam/$label (after a 2xx answer)"
      return 1
    fi
    return 0
  fi

  printf '  ????  %-8s %-38s deadline %ss blown, checking canary...\n' "$fam" "$label" "$HANG_TIMEOUT"
  if canary; then
    N_SLOW=$((N_SLOW + 1))
    SLOW_LIST="$SLOW_LIST
    $fam/$label"
    printf '  SLOW  %-8s %-38s over %ss, ship alive\n' "$fam" "$label" "$HANG_TIMEOUT"
    return 0
  fi
  N_WEDGE=$((N_WEDGE + 1)); WEDGED="$fam/$label"
  return 1
}

post() { probe "$1" "$2" -X POST --data-binary "@$3" "$4"; }
get()  { probe "$1" "$2" "$3"; }

want() { case " $FAMILIES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

#  ── the corpus ────────────────────────────────────────────────────────────
#  Five shapes, because these are the five ways a hand-written scanner loops:
#    1. DEPTH        a recursive descent that recurses per nesting level
#    2. LENGTH       one unbroken token, so every "scan to the delimiter" is
#                    a full-input scan and any re-scan is quadratic
#    3. UNTERMINATED a forward scan for a delimiter that is not there, where
#                    the failure branch forgets to consume what it scanned
#    4. BACKTRACK    a prefix that ALMOST matches, repeated, so a scanner that
#                    rewinds on a failed match rewinds once per repetition
#    5. REPETITION   many small complete constructs, to catch per-construct
#                    work that is superlinear in the count
#
#  Cases are ordered cheapest-first inside each family so a wedge lands on the
#  smallest input that causes it.

echo "hoon-hang.sh -> $B"
echo "  deadline ${HANG_TIMEOUT}s  canary ${CANARY_TIMEOUT}s x${CANARY_TRIES}  families:$FAMILIES"
echo

if ! canary; then
  echo "ABORT: the ship is not answering BEFORE any probe. Nothing to measure." >&2
  exit 2
fi

#  ── clip: POST /clip-html, the hand-rolled HTML tokenizer ──────────────────
#  NOTE this route ARCHIVES on success, so it writes pages under the run's url.
#  That is deliberate: the write path is part of what a hostile page reaches.
if want clip && [ -z "$WEDGED" ]; then
  echo "family clip  (/clip-html -> to-md:lattice-clip, page-title:lattice-clip)"
  D=$(scale 20000 2000); L=$(scale 400000 40000); R=$(scale 100000 10000)

  nest "$D" '<div>' '</div>'          > "$WORK/c-depth-div"
  nest "$D" '<blockquote>' '</blockquote>' > "$WORK/c-depth-quote"
  nest "$D" '<b>' '</b>'              > "$WORK/c-depth-inline"
  rep  "$L" 'a'                       > "$WORK/c-long-token"
  { printf '<p>'; rep "$L" 'a'; }     > "$WORK/c-long-text"
  { printf '<a href="'; rep "$L" 'a'; } > "$WORK/c-unterm-attr"
  { printf '<!--'; rep "$L" 'x'; }    > "$WORK/c-unterm-comment"
  { printf '<script>'; rep "$L" 'x'; } > "$WORK/c-unterm-script"
  { printf '<pre>'; rep "$L" 'x'; }   > "$WORK/c-unterm-pre"
  rep  "$R" '<'                       > "$WORK/c-bt-lt"
  rep  "$R" '&'                       > "$WORK/c-bt-amp"
  rep  "$R" '&#'                      > "$WORK/c-bt-nument"
  rep  "$R" '&#x'                     > "$WORK/c-bt-hexent"
  rep  "$R" '<a href='                > "$WORK/c-bt-attr"
  rep  "$R" '<!--'                    > "$WORK/c-bt-comment"
  rep  "$R" '<li>'                    > "$WORK/c-rep-li"
  rep  "$R" '<h6>x</h6>'              > "$WORK/c-rep-h6"
  { printf '<main>'; rep "$R" '<article>'; } > "$WORK/c-rep-region"
  #  the region extractor runs +between three times over the WHOLE document
  #  before the walk starts; an unterminated <main> makes each one a full scan
  { printf '<main>'; rep "$L" 'x'; }  > "$WORK/c-unterm-main"

  for f in c-depth-div c-depth-quote c-depth-inline c-long-token c-long-text \
           c-unterm-attr c-unterm-comment c-unterm-script c-unterm-pre c-unterm-main \
           c-bt-lt c-bt-amp c-bt-nument c-bt-hexent c-bt-attr c-bt-comment \
           c-rep-li c-rep-h6 c-rep-region; do
    [ -z "$WEDGED" ] || break
    post clip "$f" "$WORK/$f" "$B/clip-html?url=https://example.com/$NS-$f" || break
  done
  echo
fi

#  ── md: POST /page-preview?type=md, the GFM renderer ───────────────────────
#  Non-persisting by construction ("Nothing is written"), so this family can be
#  hammered without residue. lattice-md's own comments record a quadratic in
#  the blockquote depth that was capped at 32; the ladder below goes well past
#  the cap on purpose, to check the cap is the only thing standing there.
if want md && [ -z "$WEDGED" ]; then
  echo "family md    (/page-preview?type=md -> render-md:lattice-md)"
  D=$(scale 20000 2000); L=$(scale 400000 40000); R=$(scale 100000 10000)

  rep  "$D" '>'                       > "$WORK/m-depth-quote"
  rep  "$D" '> '                      > "$WORK/m-depth-quote-sp"
  rep  "$D" '['                       > "$WORK/m-depth-brack"
  rep  "$D" '!['                      > "$WORK/m-depth-img"
  rep  "$D" '*'                       > "$WORK/m-depth-em"
  rep  "$D" '`'                       > "$WORK/m-depth-code"
  rep  "$L" 'a'                       > "$WORK/m-long-token"
  { printf '['; rep "$L" 'a'; }       > "$WORK/m-unterm-link"
  { printf '```'; rep "$L" 'a'; }     > "$WORK/m-unterm-fence"
  { printf '<!--'; rep "$L" 'a'; }    > "$WORK/m-unterm-comment"
  rep  "$R" '[a](b)'                  > "$WORK/m-rep-link"
  rep  "$R" '[a]'                     > "$WORK/m-bt-ref"
  rep  "$R" '[^a]'                    > "$WORK/m-bt-footnote"
  rep  "$R" '|a|b|'                   > "$WORK/m-bt-table"
  rep  "$R" '[['                      > "$WORK/m-bt-wikilink"
  lines "$R" '- a'                    > "$WORK/m-rep-list"
  lines "$R" '###### h'               > "$WORK/m-rep-head"
  lines "$R" '| a | b |'              > "$WORK/m-rep-table"

  for f in m-depth-quote m-depth-quote-sp m-depth-brack m-depth-img m-depth-em \
           m-depth-code m-long-token m-unterm-link m-unterm-fence m-unterm-comment \
           m-rep-link m-bt-ref m-bt-footnote m-bt-table m-bt-wikilink \
           m-rep-list m-rep-head m-rep-table; do
    [ -z "$WEDGED" ] || break
    post md "$f" "$WORK/$f" "$B/page-preview?type=md" || break
  done
  echo
fi

#  ── gmi: POST /page-preview?type=gmi, the gemtext renderer ─────────────────
if want gmi && [ -z "$WEDGED" ]; then
  echo "family gmi   (/page-preview?type=gmi -> render-gmi)"
  L=$(scale 400000 40000); R=$(scale 100000 10000)

  rep  "$L" 'a'                       > "$WORK/g-long-token"
  { printf '```'; rep "$L" 'a'; }     > "$WORK/g-unterm-pre"
  lines "$R" '# h'                    > "$WORK/g-rep-head"
  lines "$R" '=> urb://~zod/x label'  > "$WORK/g-rep-link"
  lines "$R" '* item'                 > "$WORK/g-rep-list"
  lines "$R" '> quote'                > "$WORK/g-rep-quote"
  rep  "$R" '=>'                      > "$WORK/g-bt-arrow"

  for f in g-long-token g-unterm-pre g-rep-head g-rep-link g-rep-list \
           g-rep-quote g-bt-arrow; do
    [ -z "$WEDGED" ] || break
    post gmi "$f" "$WORK/$f" "$B/page-preview?type=gmi" || break
  done
  echo
fi

#  ── urls: GET /?url=, the urb:// codec ─────────────────────────────────────
#  This one reaches +de-urb, which calls +stab (the real Hoon path parser)
#  under a +mule. A url is a QUERY parameter, so the sizes here are bounded by
#  what eyre will accept in a request line rather than by what curl will send.
if want urls && [ -z "$WEDGED" ]; then
  echo "family urls  (/?url= -> de-urb:lattice-urls)"
  S=$(scale 20000 2000)

  U_SLASH="urb://~zod/$(rep "$S" '/')"
  U_LONG="urb://~zod/$(rep "$S" 'a')"
  U_DOT="urb://~zod/$(rep "$S" '.')"
  U_SEG="urb://~zod$(rep "$S" '/a')"
  U_TILDE="urb://$(rep "$S" '~')"
  U_PCT="urb://~zod/$(rep "$S" '%2e')"
  U_HEP="urb://~zod/$(rep "$S" '-')"
  U_SHIP="urb://~$(rep "$S" 'zod')"

  for pair in "u-slash:$U_SLASH" "u-long:$U_LONG" "u-dot:$U_DOT" "u-seg:$U_SEG" \
              "u-tilde:$U_TILDE" "u-pct:$U_PCT" "u-hep:$U_HEP" "u-ship:$U_SHIP"; do
    [ -z "$WEDGED" ] || break
    lbl="${pair%%:*}"; val="${pair#*:}"
    #  NOTE: "$B?url=" and not "$B/?url=". The reader is the `?~ suffix`
    #  branch, and a trailing slash makes the suffix ~[''] rather than ~, which
    #  falls through to the 404. A probe family that 404s is a family that
    #  never reached the parser, and it looks exactly like a passing run.
    get urls "$lbl" "$B?url=$val" || break
  done
  echo
fi

#  ── catalog: GET /catalog-search, the term normalizer + urQL path ──────────
if want catalog && [ -z "$WEDGED" ]; then
  echo "family catalog  (/catalog-search?term= -> catalog-normalize-term)"
  S=$(scale 20000 2000)

  for pair in "k-long:$(rep "$S" 'a')" \
              "k-quote:$(rep "$S" "%27")" \
              "k-back:$(rep "$S" '%5C')" \
              "k-pct:$(rep "$S" '%25')" \
              "k-space:$(rep "$S" '+')" \
              "k-hash:$(rep "$S" '%23')"; do
    [ -z "$WEDGED" ] || break
    lbl="${pair%%:*}"; val="${pair#*:}"
    get catalog "$lbl" "$B/catalog-search?term=$val" || break
  done
  echo
fi

#  ── save: POST /page-save with hostile bodies ──────────────────────────────
#  The write path: the body is wrapped and handed to the page pipeline, so this
#  is the one family that persists. Everything it makes is namespaced under the
#  run's pid and torn down at the end.
if want save && [ -z "$WEDGED" ]; then
  echo "family save  (/page-save?type=md -> writer + render pipeline)"
  L=$(scale 200000 20000); R=$(scale 50000 5000)

  rep  "$L" 'a'                       > "$WORK/s-long-token"
  rep  "$R" '>'                       > "$WORK/s-depth-quote"
  rep  "$R" '[['                      > "$WORK/s-bt-wikilink"
  { printf '```'; rep "$L" 'a'; }     > "$WORK/s-unterm-fence"

  for f in s-long-token s-depth-quote s-bt-wikilink s-unterm-fence; do
    [ -z "$WEDGED" ] || break
    post save "$f" "$WORK/$f" "$B/page-save?type=md&name=$NS-$f" || break
  done

  #  teardown, best effort. A wedge means the ship cannot answer, so this is
  #  skipped rather than retried into the wall.
  if [ -z "$WEDGED" ]; then
    for f in s-long-token s-depth-quote s-bt-wikilink s-unterm-fence; do
      curl -s -o /dev/null --max-time 30 -X POST -H "Cookie: $COOKIE" \
        "$B/page-del?name=$NS-$f" 2>/dev/null
    done
  fi
  echo
fi

#  ── report ────────────────────────────────────────────────────────────────
echo "── hoon-hang report ──"
printf 'probes %s   ok %s   slow %s   wedge %s   unreached %s\n' "$N_TOTAL" "$N_OK" "$N_SLOW" "$N_WEDGE" "$N_MISS"
if [ -n "$MISS_LIST" ]; then
  echo "UNREACHED (404/405: the route did not accept the probe, so no parser ran):$MISS_LIST"
  echo "  Fix the route before believing this run found nothing."
fi
if [ -n "$SLOW_LIST" ]; then
  echo "SLOW (blew the ${HANG_TIMEOUT}s deadline, ship recovered):$SLOW_LIST"
  echo "  These are not hangs. They are inputs whose cost is set by the sender,"
  echo "  which on a single-threaded pier is still a denial of service."
fi
if [ -n "$WEDGED" ]; then
  echo
  echo "WEDGE: $WEDGED"
  echo "  The ship stopped answering the canary and did not come back within"
  echo "  ${CANARY_TRIES} x ${CANARY_TIMEOUT}s. The event never completed. This is the"
  echo "  infinite-loop class that no in-ship test can report."
  echo "  Probing STOPPED here on purpose: further requests queue behind the"
  echo "  running event and would only confirm the same fact."
  echo "  The pier needs a restart. Replay with:"
  echo "    HANG_TIMEOUT=$HANG_TIMEOUT $0 --family ${WEDGED%%/*}"
  exit 1
fi
echo "canary green at end of run."
exit 0
