#!/bin/sh
# Packs the release build for one target into what a release offers, as CI
# and the release workflow run it:
#   sh scripts/bundle/dist.sh <target> <out-dir>
# It builds target/<target>/release first (cargo build --release --locked).
# Linux gives a deb and an AppImage, by deb.sh and appimage.sh. macOS gives
# a tar.gz of the program, signed ad hoc: no bundle and no notarization yet,
# so a downloaded copy has to be let through Gatekeeper by hand. Windows
# gives a zip of the exe. Every name carries the crate's own version.
set -eu
cd "$(dirname "$0")/../.."
target=$1
out=$2
mkdir -p "$out"
out=$(cd "$out" && pwd)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
cargo build --release --locked --target "$target"
rel=target/$target/release
case $target in
    x86_64-unknown-linux-gnu)
        LATTICE_RUNE_BIN=$rel/lattice-rune sh scripts/bundle/deb.sh
        LATTICE_RUNE_BIN=$rel/lattice-rune sh scripts/bundle/appimage.sh
        cp "target/bundle/lattice-rune_${version}_amd64.deb" "target/bundle/lattice-rune-$version-x86_64.AppImage" "$out/"
        ;;
    *-apple-darwin)
        arch=${target%%-*}
        stage=target/dist-$target
        rm -rf "$stage" && mkdir -p "$stage"
        cp "$rel/lattice-rune" "$stage/lattice-rune"
        strip "$stage/lattice-rune"
        codesign --force -s - "$stage/lattice-rune"
        tar -C "$stage" -czf "$out/lattice-rune-$version-macos-$arch.tar.gz" lattice-rune
        ;;
    *-pc-windows-msvc)
        arch=${target%%-*}
        stage=target/dist-$target
        rm -rf "$stage" && mkdir -p "$stage"
        cp "$rel/lattice-rune.exe" "$stage/lattice-rune.exe"
        rm -f "$out/lattice-rune-$version-windows-$arch.zip"
        (cd "$stage" && 7z a -bso0 -bsp0 "$out/lattice-rune-$version-windows-$arch.zip" lattice-rune.exe)
        ;;
    *)
        echo "dist.sh: no packing for $target" >&2
        exit 1
        ;;
esac
ls -l "$out"
