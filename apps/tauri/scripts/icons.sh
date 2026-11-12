#!/usr/bin/env bash
# Regenerates the bundled macOS icons; run inside `nix develop`.
set -euo pipefail

tauri_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --filter @weblounge/app icons
cd "$tauri_dir"
cargo tauri icon icons/macos-source.png --output icons
rm -rf icons/android icons/ios icons/64x64.png icons/StoreLogo.png icons/Square*.png
