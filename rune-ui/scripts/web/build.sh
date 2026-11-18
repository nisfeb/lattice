#!/bin/sh
# Builds the browser version into target/web: app.js, app_bg.wasm and
# index.html, a folder any static host can serve.
#   sh scripts/web/build.sh          the release build
#   sh scripts/web/build.sh check    only whether it compiles for wasm32
# Runs in the image scripts/web/Dockerfile describes (built here on first
# use), since the wasm32 target and wasm-bindgen are not on this machine.
# The source is mounted read-only and copied to a docker volume, where the
# build's cache also lives, so a second build is quick and nothing is
# written here but target/web.
set -eu
cd "$(dirname "$0")/../.."
mode=${1:-build}
rune=${RUNE_SRC:-$HOME/.cache/rune-src/rune}
docker image inspect lattice-rune-web >/dev/null 2>&1 || docker build -q -t lattice-rune-web scripts/web >&2
name=lattice-rune-web-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --name "$name" -e MODE="$mode" \
    -v "$(cd .. && pwd):/src:ro" -v "$rune/scripts:/rune-scripts:ro" -v lattice-rune-web-cache:/cache \
    lattice-rune-web sh -ec '
    mkdir -p /cache/build/rune-ui /cache/build/ui-src/sheet
    rm -rf /cache/build/rune-ui/src /cache/build/rune-ui/vendor
    cp -p /src/rune-ui/Cargo.toml /src/rune-ui/Cargo.lock /cache/build/rune-ui/
    cp -rp /src/rune-ui/src /src/rune-ui/vendor /cache/build/rune-ui/
    cp -p /src/ui-src/sheet/blank.fods /cache/build/ui-src/sheet/
    cd /cache/build/rune-ui
    export CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target
    if [ "$MODE" = check ]; then
        cargo check --lib --target wasm32-unknown-unknown --locked
    else
        rm -rf /cache/web
        bash /rune-scripts/web-build.sh lattice-rune --out /cache/web
        rm -rf /out && cp -r /cache/web /out
    fi' >&2
if [ "$mode" != check ]; then
    rm -rf target/web
    mkdir -p target
    docker cp "$name:/out" target/web >&2
    echo target/web
fi
