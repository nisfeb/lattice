#!/bin/sh
# Builds the release binary inside Debian 12, so that it asks for that
# release's glibc (2.36) and not this machine's. A build made on a newer
# system runs only on systems as new. Prints where the binary is.
# Needs docker and the network: the container fetches the crates itself.
# The source is mounted read-only and built on the container's own disk,
# so it works whatever user the container runs as, and writes nothing here
# but the binary.
set -eu
cd "$(dirname "$0")/../.."
image=${RUST_IMAGE:-rust:1.98-slim-bookworm}
name=lattice-rune-build-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --name "$name" -v "$(cd .. && pwd):/src:ro" "$image" sh -ec '
    # the linker is handed -lxkbcommon, though nothing of it ends up needed
    apt-get update -qq && apt-get install -y -qq libxkbcommon-dev >/dev/null
    mkdir -p /build/rune-ui /build/ui-src/sheet
    cp /src/rune-ui/Cargo.toml /src/rune-ui/Cargo.lock /build/rune-ui/
    cp -r /src/rune-ui/src /build/rune-ui/
    # the one file the crate reads from outside itself
    cp /src/ui-src/sheet/blank.fods /build/ui-src/sheet/
    cd /build/rune-ui
    cargo build --release --locked
    strip target/release/lattice-rune
' >&2
mkdir -p target/debian
docker cp "$name:/build/rune-ui/target/release/lattice-rune" target/debian/lattice-rune >&2
echo target/debian/lattice-rune
