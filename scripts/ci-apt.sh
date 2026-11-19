#!/bin/sh
# apt-get update and install for a CI job, which does not wait for ever on
# a mirror that has gone quiet:   sh scripts/ci-apt.sh <package>...
# On 2026-11-18 the runners' Ubuntu mirror stopped part way through the
# WebKit package four times in a row. Plain apt-get sat there until the
# job was cancelled by hand, and a tagged release never got past its first
# step. Here a connection that sends nothing is dropped after 20 seconds
# and asked again, each apt-get has a limit of its own, and the whole is
# tried four times.
set -u
opts="-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=5 -o DPkg::Lock::Timeout=120"
try=1
while :; do
    if sudo timeout 300 apt-get $opts update && sudo timeout 900 apt-get $opts install -y "$@"; then
        exit 0
    fi
    [ "$try" -lt 4 ] || { echo "::error::apt-get failed or stalled $try times" >&2; exit 1; }
    echo "apt-get failed or stalled, try $((try + 1)) of 4" >&2
    # one cut off in the middle of unpacking leaves packages half set up
    sudo dpkg --configure -a || true
    try=$((try + 1))
    sleep 10
done
