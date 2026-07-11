#!/usr/bin/env bash
# Builds OllamaClaudeShim.app (dev-time only — the app itself needs no scripts).
set -euo pipefail
cd "$(dirname "$0")"

APP=../OllamaClaudeShim.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -parse-as-library main.swift -o "$APP/Contents/MacOS/OllamaClaudeShim"
cp Info.plist "$APP/Contents/"
cp ../server.mjs ../dashboard.html "$APP/Contents/Resources/"
codesign --force -s - "$APP"

echo "Built: $(cd "$(dirname "$APP")" && pwd)/OllamaClaudeShim.app"
