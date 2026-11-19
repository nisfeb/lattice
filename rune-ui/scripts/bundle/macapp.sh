#!/bin/sh
# Makes lattice-rune.app from a built program:
#   sh scripts/bundle/macapp.sh <program> <version> <dir>
# It writes <dir>/lattice-rune.app and nothing else. It uses no tool that
# only a Mac has, so the bundle's shape and its Info.plist can be checked
# anywhere. Signing it and packing it into a dmg are dist.sh's, on a Mac.
#
# The identifier is the Rune client's own, so it stands beside the desktop
# app (org.lattice.desktop) with settings of its own. The lowest system is
# 11.0, the oldest the arm64 target runs on.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin=$1
version=$2
dir=$3
app=$dir/lattice-rune.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/lattice-rune"
chmod 755 "$app/Contents/MacOS/lattice-rune"
cp "$here/../../../desktop/icons/icon.icns" "$app/Contents/Resources/lattice-rune.icns"
printf 'APPL????' > "$app/Contents/PkgInfo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>lattice-rune</string>
	<key>CFBundleExecutable</key>
	<string>lattice-rune</string>
	<key>CFBundleIconFile</key>
	<string>lattice-rune</string>
	<key>CFBundleIdentifier</key>
	<string>org.lattice.rune</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>lattice-rune</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
PLIST
echo "$app"
