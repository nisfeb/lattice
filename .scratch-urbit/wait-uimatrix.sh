#!/usr/bin/env bash
# Wait for the ui-matrix node process (pid $1) to exit, up to 40 min.
pid="$1"
for i in $(seq 1 240); do
  if ! ps -p "$pid" >/dev/null 2>&1; then
    echo "ui-matrix exited after ~$((i*10))s of waiting"
    exit 0
  fi
  sleep 10
done
echo "ui-matrix still running after 40min"
exit 1
