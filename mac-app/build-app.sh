#!/usr/bin/env bash
# Builds FauxClaude.app (dev-time only — the app itself needs no scripts).
set -euo pipefail
cd "$(dirname "$0")"

APP=../FauxClaude.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -parse-as-library main.swift -o "$APP/Contents/MacOS/FauxClaude"
cp Info.plist "$APP/Contents/"
cp ../server.mjs ../dashboard.html "$APP/Contents/Resources/"
if [ -f ../assets/logo.png ]; then mkdir -p "$APP/Contents/Resources/assets"; cp ../assets/logo.png ../assets/llama.png "$APP/Contents/Resources/assets/"; fi
cp ../assets/menubar-llama.png ../assets/menubar-llama-dim.png "$APP/Contents/Resources/" 2>/dev/null || true
cp ../assets/FauxClaude.icns "$APP/Contents/Resources/" 2>/dev/null || true
codesign --force -s - "$APP"

echo "Built: $(cd "$(dirname "$APP")" && pwd)/FauxClaude.app"
