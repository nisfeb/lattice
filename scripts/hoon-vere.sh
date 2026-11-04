#!/usr/bin/env bash
# Build the vere that hoon-build-check.py runs: stock vere, with its eval
# kernel (the embedded ivory pill) rebuilt from the arvo ships run.
#
# usage: hoon-vere.sh OUT_DIR
#
# Writes OUT_DIR/vere and OUT_DIR/ivory.pill. Needs zig (vere's version,
# 0.15.2 for v4.6), git and curl. CI caches OUT_DIR under a key of the
# pins below and this script's hash, so it runs once per pin change.
set -euo pipefail
ulimit -c 0

VERE_TAG=vere-v4.6
ARVO_TAG=408k-2

out=$(realpath -m "$1")
here=$(cd "$(dirname "$0")" && pwd)
work="$out/work"
rm -rf "$work"
mkdir -p "$work/sys" "$work/stock"

echo "hoon-vere: arvo $ARVO_TAG sys/"
for f in hoon arvo lull zuse; do
  curl -fsSL -o "$work/sys/$f.hoon" \
    "https://raw.githubusercontent.com/urbit/urbit/$ARVO_TAG/pkg/arvo/sys/$f.hoon"
done

echo "hoon-vere: stock $VERE_TAG to build the pill"
curl -fsSL "https://github.com/urbit/vere/releases/download/$VERE_TAG/linux-x86_64.tgz" \
  | tar xz -C "$work/stock"
stock=$(find "$work/stock" -type f -perm -u+x | head -1)

git clone -q --depth 1 --branch "$VERE_TAG" https://github.com/urbit/vere "$work/vere"
VERE="$stock" python3 "$here/ivory-pill.py" --sys "$work/sys" \
  --out "$out/ivory.pill" --c "$work/vere/pkg/vere/ivory/ivory.c"

echo "hoon-vere: building $VERE_TAG with it"
(cd "$work/vere" && zig build -Doptimize=ReleaseFast)
cp "$work/vere/zig-out/x86_64-linux-musl/urbit" "$out/vere"
rm -rf "$work"
echo "hoon-vere: $out/vere"
