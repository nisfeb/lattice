#!/usr/bin/env bash
# Foreground wait: poll for the ui-matrix node process to exit, then print
# the flushed pipeline output file. Cap at ~9.5 min per invocation (under
# the Bash tool's 10-minute ceiling); re-run if it exits 3.
out="/tmp/claude-1001/-home-sneagan-software-personal-lattice/dbeda9bd-b751-4a0d-a7d3-4624625553f8/tasks/b0jt5u6pl.output"
for i in $(seq 1 38); do
  if ! pgrep -f "node scripts/ui-matrix" >/dev/null; then
    echo "=== ui-matrix exited; output: ==="
    cat "$out"
    exit 0
  fi
  sleep 15
done
echo "still running after $((38*15))s"
exit 3
