#!/bin/sh
# apt-get update and install for a CI job, which does not wait for ever on
# a mirror that has gone quiet:   sh scripts/ci-apt.sh <package>...
# On 2026-11-18 the runners' Ubuntu mirror (us-east-2.ec2.archive.ubuntu.com)
# slowed to nothing part way through the WebKit package, time after time.
# Plain apt-get sat there until the job was cancelled by hand, and a tagged
# release never got past its first step. apt's own timeout did not help: the
# mirror still sent a little.
# So each try has a limit, and a try that fails or runs out is made again
# from the main archive instead of the regional mirror. What was fetched
# before is kept, so each try starts where the last stopped.
set -u
opts="-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120"
try=1
while :; do
    # -k: one that does not stop when told is stopped. And nothing may ask a question no one is there to answer
    log=$(mktemp)
    ok=yes
    sudo timeout -k 30 180 apt-get $opts update || ok=no
    if [ "$ok" = yes ]; then
        sudo timeout -k 30 420 env DEBIAN_FRONTEND=noninteractive apt-get $opts install -y "$@" > "$log" 2>&1 || ok=no
        cat "$log"
    fi
    [ "$ok" = yes ] && exit 0
    # a name apt does not know is not the mirror's doing: trying again cannot help
    if grep -q 'Unable to locate package\|has no installation candidate' "$log"; then
        echo "::error::apt-get does not know a package asked for" >&2
        exit 1
    fi
    [ "$try" -lt 5 ] || { echo "::error::apt-get failed or stalled $try times" >&2; exit 1; }
    echo "apt-get failed or stalled, try $((try + 1)) of 5, from archive.ubuntu.com" >&2
    # one cut off in the middle of unpacking leaves packages half set up
    sudo dpkg --configure -a || true
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources /etc/apt/apt-mirrors.txt; do
        [ -f "$f" ] && sudo sed -i -E 's#https?://[a-z0-9.-]*(ec2\.archive\.ubuntu\.com|azure\.archive\.ubuntu\.com)/ubuntu#http://archive.ubuntu.com/ubuntu#g' "$f"
    done
    try=$((try + 1))
    sleep 5
done
