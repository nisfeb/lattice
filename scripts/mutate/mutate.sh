#!/usr/bin/env bash
# Tiny mutation tester (after talon's scripts/mutate/mutate.sh).
#
# For each file in $TARGETS and each mutation operator, flip every occurrence
# one at a time and run the test suite. If the suite still passes, the mutant is
# a SURVIVOR — a test gap worth closing. If it fails (or won't compile), the
# mutant was KILLED. Not a substitute for Pitest, but transparent and dep-free,
# and sufficient for our narrow surface (the pure parsers + the HTTP clients).
#
# Usage:   scripts/mutate/mutate.sh [file ...]
# Output:  mutation-report.md (overwritten each run) + a stdout summary.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# gemini-urbit builds with JDK 21; the Gradle project lives under app/.
: "${JAVA_HOME:=/usr/lib/jvm/java-21-openjdk}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

REPORT="mutation-report.md"
LOG_DIR="app/build/mutation-logs"
mkdir -p "$LOG_DIR"

# ── default targets: the well-tested pure parsers + the knowledge client ──
DEFAULT_TARGETS=(
    "app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/gemtext/UrbUrl.kt"
    "app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/gemtext/GemText.kt"
    "app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/browser/UrlPaths.kt"
    "app/composeApp/src/commonMain/kotlin/io/nisfeb/lattice/knowledge/KnowledgeClient.kt"
)
TARGETS=("${@:-${DEFAULT_TARGETS[@]}}")

# ── mutation operators: name|perl-regex|replacement, applied one hit at a time ──
MUTATIONS=(
    'eq-to-neq|== |!= '
    'neq-to-eq|!= |== '
    'and-to-or|&&|\|\|'
    'or-to-and|\|\||&&'
    'lt-to-gte| < | >= '
    'gt-to-lte| > | <= '
    'lte-to-gt| <= | > '
    'gte-to-lt| >= | < '
    'true-to-false|\btrue\b|false'
    'false-to-true|\bfalse\b|true'
    'drop-not|!([a-zA-Z_(])|$1'
    'plus1-to-plus0|\+ 1|+ 0'
    'minus1-to-minus0|- 1|- 0'
    # domain-specific: catches scheme / endpoint / mark / facet regressions.
    'scheme-urb-to-web|"urb://"|"web://"'
    'endpoint-path-typo|apps/lattice/|apps/lattie/'
    'mark-query-to-tags|know-query|know-tags'
    'match-all-to-any|"all"|"any"'
    'match-any-to-all|"any"|"all"'
)

run_tests() {
    ( cd app && ./gradlew :composeApp:desktopTest --quiet ) > "$LOG_DIR/last.log" 2>&1
}

survived=0; killed=0; skipped=0
declare -a SURVIVORS=()

{
  echo "# Mutation report"
  echo
  echo "_Run: $(date -Iseconds)_"
  echo
  echo "| Status | File | Line | Operator | Before → After |"
  echo "|---|---|---|---|---|"
} > "$REPORT"

for file in "${TARGETS[@]}"; do
    [ -f "$file" ] || { echo "skip: $file (not found)"; continue; }
    echo "mutating $file"
    for spec in "${MUTATIONS[@]}"; do
        name="${spec%%|*}"; rest="${spec#*|}"
        pattern="${rest%%|*}"; replacement="${rest#*|}"
        mapfile -t lines < <(perl -ne 'print "$.\n" if /'"$pattern"'/' "$file" 2>/dev/null || true)
        for line in "${lines[@]}"; do
            [ -z "$line" ] && continue
            orig_line="$(sed -n "${line}p" "$file")"
            trimmed="$(echo "$orig_line" | sed -e 's/^[[:space:]]*//')"
            case "$trimmed" in
                //*|\*/*|\**) skipped=$((skipped+1)); continue ;;
            esac
            cp "$file" "$LOG_DIR/backup.kt"
            perl -i -ne '
                BEGIN { $ln = '"$line"'; }
                if ($. == $ln && !$done) { s/'"$pattern"'/'"$replacement"'/ and $done = 1; }
                print;
            ' "$file"
            new_line="$(sed -n "${line}p" "$file")"
            if [ "$orig_line" = "$new_line" ]; then skipped=$((skipped+1)); continue; fi
            if run_tests; then
                survived=$((survived+1))
                SURVIVORS+=("$file:$line [$name]")
                printf '| ❌ SURVIVED | `%s` | %s | %s | `%s` → `%s` |\n' \
                    "$file" "$line" "$name" \
                    "$(echo "$orig_line" | sed 's/|/\\|/g; s/^[[:space:]]*//')" \
                    "$(echo "$new_line"  | sed 's/|/\\|/g; s/^[[:space:]]*//')" \
                    >> "$REPORT"
                printf '  SURVIVED %s:%s [%s]\n' "$file" "$line" "$name"
            else
                killed=$((killed+1))
            fi
            cp "$LOG_DIR/backup.kt" "$file"
        done
    done
done

{
  echo
  echo "## Summary"
  echo
  echo "- Killed:   $killed"
  echo "- Survived: $survived"
  echo "- Skipped:  $skipped"
  if [ "$survived" -gt 0 ]; then
      awk -v k="$killed" -v s="$survived" 'BEGIN{printf "- Mutation score: %.1f%%\n", 100*k/(k+s)}'
  fi
} >> "$REPORT"

echo; echo "== summary =="; echo "killed: $killed  survived: $survived  skipped: $skipped"
if [ "$survived" -gt 0 ]; then
    echo; echo "survivors (test gaps):"
    for s in "${SURVIVORS[@]}"; do echo "  $s"; done
fi
echo; echo "full report at $REPORT"
