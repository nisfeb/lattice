#!/usr/bin/env bash
#
# Build a portable Linux AppImage for lattice Desktop.
#
# Wraps the jpackage app-image (from
# `:composeApp:createReleaseDistributable`) into a single self-contained
# `.AppImage` runnable on most Linux distros. The bundled JRE means testers
# don't need Java installed.
#
# Output: dist/lattice-x86_64.AppImage
#
# Gradle lives in app/ (not the repo root). FUSE is needed at *runtime* on the
# tester's machine — most desktop distros have it; otherwise the AppImage can be
# run with --appimage-extract-and-run or unpacked with --appimage-extract.
#
# Usage: scripts/build-appimage.sh [--skip-build]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$ROOT/app"

SKIP_BUILD=0
if [[ "${1:-}" == "--skip-build" ]]; then
    SKIP_BUILD=1
fi

DIST_SRC="$APP/composeApp/build/compose/binaries/main-release/app/lattice"
ICON_SRC="$APP/composeApp/icons/lattice.png"
TOOLS_DIR="$ROOT/build/tools"
APPIMAGETOOL="$TOOLS_DIR/appimagetool-x86_64.AppImage"
WORK_DIR="$ROOT/build/appimage"
OUT_DIR="$ROOT/dist"
APPDIR="$WORK_DIR/lattice.AppDir"

# 1. Build the jpackage app-image unless asked to skip. jlink needs a full JDK
#    (jmods). CI sets JAVA_HOME via setup-java; locally we fall back to a JDK
#    that ships jmods. Override by exporting JAVA_HOME.
if [[ "$SKIP_BUILD" -eq 0 ]]; then
    echo "==> Building lattice distributable"
    if [[ -z "${JAVA_HOME:-}" || ! -e "${JAVA_HOME:-}/jmods/java.naming.jmod" ]]; then
        for cand in /usr/lib/jvm/temurin-17 /usr/lib/jvm/java-21-openjdk \
                    /usr/lib/jvm/java-17-openjdk; do
            if [[ -e "$cand/jmods/java.naming.jmod" ]]; then
                export JAVA_HOME="$cand"
                break
            fi
        done
    fi
    : "${JAVA_HOME:?JAVA_HOME must point to a JDK with jmods (java.naming, jdk.crypto.ec)}"
    (cd "$APP" && PATH="$JAVA_HOME/bin:$PATH" ./gradlew :composeApp:createReleaseDistributable)
fi

if [[ ! -d "$DIST_SRC" ]]; then
    echo "ERROR: distributable not found at $DIST_SRC" >&2
    exit 1
fi

# 2. Fetch appimagetool if not cached.
mkdir -p "$TOOLS_DIR"
if [[ ! -x "$APPIMAGETOOL" ]]; then
    echo "==> Fetching appimagetool"
    curl -fL --output "$APPIMAGETOOL" \
        "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$APPIMAGETOOL"
fi

# 3. Stage the AppDir. The native launcher (bin/lattice) finds its bundled JRE
#    under lib/runtime/ via a relative path, so nothing needs rewriting.
echo "==> Staging AppDir at $APPDIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
cp -r "$DIST_SRC/." "$APPDIR/"

cp "$ICON_SRC" "$APPDIR/lattice.png"

cat > "$APPDIR/lattice.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=lattice
GenericName=Urbit gemtext browser
Exec=lattice
Icon=lattice
Categories=Network;
Comment=Browse and publish gemtext over Urbit
Terminal=false
StartupWMClass=lattice
EOF

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
exec "${HERE}/bin/lattice" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# 4. Package. ARCH is required by appimagetool 13+; --appimage-extract-and-run
#    avoids needing FUSE on the build host (e.g. CI).
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/lattice-x86_64.AppImage"
echo "==> Packaging into $OUT_FILE"
ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "$OUT_FILE"

ls -lh "$OUT_FILE"
echo
echo "Built $OUT_FILE"
echo "Testers run it with: chmod +x lattice-x86_64.AppImage && ./lattice-x86_64.AppImage"
