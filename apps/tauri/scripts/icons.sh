#!/usr/bin/env bash
# Regenerates the bundled macOS icons, release and dev; run inside `nix develop`.
set -euo pipefail

tauri_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --filter @weblounge/app icons
cd "$tauri_dir"
for set in icons icons-dev; do
  cargo tauri icon "$set/macos-source.png" --output "$set"
  rm -rf "$set"/android "$set"/ios "$set"/64x64.png "$set"/StoreLogo.png "$set"/Square*.png
done
