#!/usr/bin/env bash
# Builds the macOS WidgetKit extension (see docs/macos-widget.md).
# macOS only. Output:
#   src-tauri/macos-widget-build/ResonanceWidget.appex  (signed with entitlements)
# This is the path referenced by src-tauri/tauri.macos.conf.json (bundle.macOS.files).
#
# Requires FULL Xcode + XcodeGen. A plain-swiftc (Command Line Tools only) build is
# NOT possible: such binaries register in pluginkit but crash at launch inside
# ExtensionKit (_EXRunningExtension bootstrap) and never appear in the widget
# gallery — Apple's extension runtime needs metadata that only Xcode's extension
# target emits (see docs/macos-widget.md, "Known limitations").
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-widget: macOS only" >&2
  exit 1
fi
if ! command -v codesign >/dev/null 2>&1; then
  echo "build-macos-widget: codesign not found (install Xcode Command Line Tools)." >&2
  exit 1
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "build-macos-widget: full Xcode is required (xcodebuild not found)." >&2
  echo "  A swiftc/CLT-only build is not supported: the widget registers but crashes" >&2
  echo "  in ExtensionKit at launch and never appears in the widget gallery." >&2
  echo "  Install Xcode, then: xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "build-macos-widget: xcodegen not found (brew install xcodegen)." >&2
  exit 1
fi

ENTITLEMENTS="macos-widget/ResonanceWidget.entitlements"
OUT_DIR="src-tauri/macos-widget-build"

cd macos-widget
xcodegen generate
xcodebuild \
  -project ResonanceWidget.xcodeproj \
  -scheme ResonanceWidget \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -derivedDataPath build/DerivedData \
  build
appex="$(find build/DerivedData/Build/Products/Release -maxdepth 1 -type d -name 'ResonanceWidget.appex' | head -n 1)"
if [[ -z "$appex" ]]; then
  echo "build-macos-widget: ResonanceWidget.appex not found in build products" >&2
  exit 1
fi
appex="$PWD/$appex"

# Sign the extension inner-first with its own entitlements; tauri-bundler later signs the
# outer .app without touching PlugIns content (it does not re-sign .appex bundles).
codesign --force --sign - --entitlements "../$ENTITLEMENTS" "$appex"
codesign --verify --strict "$appex"
cd ..
mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/ResonanceWidget.appex"
cp -R "$appex" "$OUT_DIR/ResonanceWidget.appex"
echo "build-macos-widget: copied $(basename "$appex") to $OUT_DIR/"
