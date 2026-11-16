#!/usr/bin/env bash
# Regenerates the bundled macOS and iOS icons, release and dev; run inside `nix develop`.
set -euo pipefail

tauri_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pnpm --filter @weblounge/app icons
cd "$tauri_dir"
for set in icons icons-dev; do
  cargo tauri icon "$set/macos-source.png" --output "$set"
  rm -rf "$set"/android "$set"/ios "$set"/64x64.png "$set"/StoreLogo.png "$set"/Square*.png
done

# The Xcode project picks the icon set named after the bundle identifier the build carries.
install_ios_icon() {
  local set="$1" identity="$2" identifier
  identifier="$(node -p "require('./$identity').identifier")"
  install -m 644 "$set/ios-source.png" "gen/apple/Assets.xcassets/$identifier.appiconset/AppIcon.png"
}
install_ios_icon icons tauri.ios.release.conf.json
install_ios_icon icons-dev tauri.ios.conf.json
