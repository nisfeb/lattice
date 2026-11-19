#!/bin/sh
# Proves what dist.sh packed for a Mac, on a Mac, as CI runs it:
#   sh scripts/bundle/macapp-check.sh <target> <out-dir>
# The bundle is there and its Info.plist reads, with the crate's version
# and the program's name in it. Its signature holds. The dmg opens, and
# holds the bundle and the way to Applications. And the program inside
# the dmg answers --version, when this machine can run its kind.
set -eu
cd "$(dirname "$0")/../.."
target=$1
out=$(cd "$2" && pwd)
arch=${target%%-*}
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
app=target/dist-$target/lattice-rune.app
plist=$app/Contents/Info.plist
plutil -lint "$plist"
[ "$(plutil -extract CFBundleShortVersionString raw "$plist")" = "$version" ]
[ "$(plutil -extract CFBundleExecutable raw "$plist")" = lattice-rune ]
[ "$(plutil -extract CFBundleIdentifier raw "$plist")" = org.lattice.rune ]
[ -x "$app/Contents/MacOS/lattice-rune" ]
[ -s "$app/Contents/Resources/lattice-rune.icns" ]
codesign --verify --deep --strict "$app"
# lipo names arm64 what the target calls aarch64
kind=$arch
[ "$arch" != aarch64 ] || kind=arm64
lipo -archs "$app/Contents/MacOS/lattice-rune" | grep -qx "$kind"
dmg=$out/lattice-rune-$version-macos-$arch.dmg
[ -s "$dmg" ]
at=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$at" "$dmg" > /dev/null
trap 'hdiutil detach "$at" > /dev/null 2>&1 || true' EXIT
[ -L "$at/Applications" ]
codesign --verify --deep --strict "$at/lattice-rune.app"
# an x86_64 program runs on an arm64 Mac only where Rosetta is, which a runner may not have
if [ "$(uname -m)" = "$kind" ]; then
    said=$("$at/lattice-rune.app/Contents/MacOS/lattice-rune" --version)
    echo "$said"
    echo "$said" | grep -q "$version"
else
    echo "not run here: a $arch program on $(uname -m)"
fi
echo "ok: $dmg"
