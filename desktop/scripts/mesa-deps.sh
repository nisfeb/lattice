#!/bin/sh
# Fetches the two C sources mesa-sys compiles into the urb engine
# (urcrypt and the SQLite amalgamation) into desktop/target/mesa-deps,
# where .cargo/config.toml points MESA_SYS_DEPS. It runs the pinned
# mesa-sys checkout's own fetch-deps.sh, which checks each archive's
# SHA-256 and skips a folder already fetched. Run it before any build
# of the desktop: CI, release, nix and cargo tauri dev.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/.." && pwd)
manifest=$(cargo metadata --format-version 1 --manifest-path "$desktop/Cargo.toml" |
  node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const p = JSON.parse(s).packages.find(p => p.name === "mesa-sys");
      if (!p) { console.error("mesa-deps: no mesa-sys in the dependency tree"); process.exit(1); }
      console.log(p.manifest_path);
    });
  ')
# macOS has shasum, not sha256sum
if ! command -v sha256sum >/dev/null 2>&1; then
  shim=$(mktemp -d)
  trap 'rm -rf "$shim"' EXIT
  printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$shim/sha256sum"
  chmod +x "$shim/sha256sum"
  PATH="$shim:$PATH"
fi
MESA_SYS_DEPS="$desktop/target/mesa-deps" sh "$(dirname "$manifest")/fetch-deps.sh"
