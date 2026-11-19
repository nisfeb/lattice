#!/bin/sh
# Builds target/bundle/lattice-rune-<version>-x86_64.AppImage: the AppImage
# runtime with a squashfs of the app after it. The binary should be one
# built on an old system (CI builds on Ubuntu 22.04), named by LATTICE_RUNE_BIN,
# or the AppImage runs only where the glibc is as new as this machine's.
#
# Fetched once: the AppImage project's static runtime (type2-runtime,
# about 0.9 MB), which is the first bytes of every AppImage. Name a copy
# already here with APPIMAGE_RUNTIME to fetch nothing.
# The squashfs is made by mksquashfs, in a Debian container when this
# machine has none (docker).
set -eu
cd "$(dirname "$0")/../.."
bin=${LATTICE_RUNE_BIN:-}
if [ -z "$bin" ]; then
    cargo build --release
    bin=target/release/lattice-rune
fi
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
out=target/bundle
app=$out/AppDir
runtime=${APPIMAGE_RUNTIME:-$out/cache/runtime-x86_64}
if [ ! -s "$runtime" ]; then
    mkdir -p "$(dirname "$runtime")"
    curl -fsSL -o "$runtime" https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64
fi
rm -rf "$app" "$out/app.squashfs"
mkdir -p "$app/usr/bin" "$app/usr/share/applications" "$app/usr/share/icons/hicolor/128x128/apps"
install -m 755 "$bin" "$app/usr/bin/lattice-rune"
strip "$app/usr/bin/lattice-rune"
install -m 644 scripts/bundle/lattice-rune.desktop "$app/usr/share/applications/lattice-rune.desktop"
install -m 644 ../desktop/icons/128x128.png "$app/usr/share/icons/hicolor/128x128/apps/lattice-rune.png"
# what the format asks for at the top: the entry, the icon, and what to run
cp "$app/usr/share/applications/lattice-rune.desktop" "$app/lattice-rune.desktop"
cp ../desktop/icons/128x128.png "$app/lattice-rune.png"
ln -s lattice-rune.png "$app/.DirIcon"
# a script, not a link: run through a link the program would be named AppRun, and the desktop entry's window class would not match
printf '%s\n' '#!/bin/sh' 'exec "$(dirname "$(readlink -f "$0")")/usr/bin/lattice-rune" "$@"' > "$app/AppRun"
chmod 755 "$app/AppRun"
# whoever runs it must be able to read it, whatever this shell's umask
chmod -R u=rwX,go=rX "$app"
squash="-root-owned -noappend -comp zstd -quiet -no-progress"
if command -v mksquashfs >/dev/null; then
    mksquashfs "$app" "$out/app.squashfs" $squash
else
    # built on the container's own disk and copied out, so it works whatever user the container runs as
    name=lattice-rune-squash-$$
    trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
    docker run --name "$name" -v "$(pwd)/$app:/AppDir:ro" debian:bookworm-slim sh -ec "
        apt-get update -qq && apt-get install -y -qq squashfs-tools >/dev/null
        mksquashfs /AppDir /app.squashfs $squash" >&2
    docker cp "$name:/app.squashfs" "$out/app.squashfs" >&2
fi
image=$out/lattice-rune-$version-x86_64.AppImage
cat "$runtime" "$out/app.squashfs" > "$image"
chmod 755 "$image"
rm -f "$out/app.squashfs"
echo "$image"
