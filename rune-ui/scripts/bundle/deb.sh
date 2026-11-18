#!/bin/sh
# Builds target/bundle/lattice-rune_<version>_amd64.deb from the release
# build. A deb is an ar archive of three members, so ar and tar make it: no
# dpkg is needed to build one. The package is lattice-rune, beside the
# shipped desktop app's package (lattice), never in place of it.
set -eu
cd "$(dirname "$0")/../.."
# LATTICE_RUNE_BIN names a binary built elsewhere, as build-in-debian.sh builds one
bin=${LATTICE_RUNE_BIN:-}
if [ -z "$bin" ]; then
    cargo build --release
    bin=target/release/lattice-rune
fi
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
out=target/bundle
stage=$out/deb
rm -rf "$stage"
mkdir -p "$stage/data/usr/bin" "$stage/data/usr/share/applications" "$stage/control"
install -m 755 "$bin" "$stage/data/usr/bin/lattice-rune"
strip "$stage/data/usr/bin/lattice-rune"
install -m 644 scripts/bundle/lattice-rune.desktop "$stage/data/usr/share/applications/lattice-rune.desktop"
# the icon is the desktop app's
for size in 32x32 128x128; do
    install -D -m 644 "../desktop/icons/$size.png" "$stage/data/usr/share/icons/hicolor/$size/apps/lattice-rune.png"
done
# the newest glibc symbol the build asks for is the oldest libc6 it runs on
glibc=$(objdump -T "$bin" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | cut -d_ -f2)
cat > "$stage/control/control" <<EOF
Package: lattice-rune
Version: $version
Architecture: amd64
Maintainer: nisfeb <business@nisfeb.com>
Installed-Size: $(du -sk "$stage/data" | cut -f1)
Depends: libc6 (>= $glibc), libgcc-s1
Recommends: libxkbcommon0, libxkbcommon-x11-0, libwayland-client0, libvulkan1, mesa-vulkan-drivers | libgl1, libxcursor1, libxi6, libxrandr2, libx11-xcb1, fonts-dejavu-core
Suggests: fuse3, openscad
Section: editors
Priority: optional
Description: An experimental native client for lattice, drawn with Rune
 Not the shipped desktop app, and installable beside it.
EOF
# whoever installs it must be able to read it, whatever this shell's umask
chmod -R u=rwX,go=rX "$stage/data"
(cd "$stage/data" && find usr -type f -exec md5sum {} + > ../control/md5sums)
tar_as_root="tar --owner=0 --group=0 --numeric-owner -czf"
(cd "$stage/control" && $tar_as_root ../control.tar.gz ./control ./md5sums)
(cd "$stage/data" && $tar_as_root ../data.tar.gz ./usr)
printf '2.0\n' > "$stage/debian-binary"
deb=$out/lattice-rune_${version}_amd64.deb
rm -f "$deb"
# the order of the three is the format
(cd "$stage" && ar rc "../$(basename "$deb")" debian-binary control.tar.gz data.tar.gz)
echo "$deb"
