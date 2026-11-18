#!/bin/sh
# Loads a page in headless Chromium with WebGPU, in a throwaway profile,
# and writes a screenshot. Console lines that matter go to stdout.
#   sh scripts/web/shot.sh URL OUT.png [seconds]
set -eu
profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT
timeout 90 chromium --headless=new --no-sandbox --user-data-dir="$profile" --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan \
    --window-size=1100,700 --enable-logging=stderr --v=0 --virtual-time-budget="${3:-12}000" --screenshot="$2" "$1" 2>&1 \
    | grep CONSOLE | grep -v -E 'Inter-|HTTP 404|Password field' | sed 's/^[^"]*//' | cut -c1-220 | head -12 || true
