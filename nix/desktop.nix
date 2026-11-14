{ pkgs, rustToolchain }:
let
  rustPlatform = pkgs.makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };
  root = ../apps/tauri;
  rcodesign = pkgs.lib.getExe pkgs.rcodesign;
in
rustPlatform.buildRustPackage {
  pname = "weblounge-desktop";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    inherit root;
    fileset = pkgs.lib.fileset.unions [
      (root + "/Cargo.toml")
      (root + "/Cargo.lock")
      (root + "/build.rs")
      (root + "/tauri.conf.json")
      (root + "/icons")
      (root + "/src")
      (root + "/release/plan.mjs")
      (root + "/release/plan.test.mjs")
    ];
  };
  cargoLock.lockFile = root + "/Cargo.lock";
  nativeBuildInputs = [ pkgs.cargo-tauri.hook ];
  preCheck = ''
    cargo clippy --offline --release --all-targets -- -D warnings
    ${pkgs.lib.getExe pkgs.nodejs} --test 'src/*.test.mjs' 'release/*.test.mjs'
  '';
  # Nix's toolchain links its own libiconv, which neither exists on other Macs nor passes the hardened
  # runtime's library validation; the identical system copy lives in the dyld shared cache.
  postFixup = ''
    binary="$out/Applications/weblounge.app/Contents/MacOS/weblounge-desktop"
    for library in $(otool -L "$binary" | awk '/\/nix\/store\/.*libiconv/ { print $1 }'); do
      install_name_tool -change "$library" /usr/lib/libiconv.2.dylib "$binary"
    done
    if otool -L "$binary" | tail -n +2 | grep /nix/store \
      || otool -l "$binary" | grep -A2 LC_RPATH | grep /nix/store; then
      echo "$binary still loads code from the Nix store" >&2
      exit 1
    fi
  '';
  # UNUserNotificationCenter rejects every call unless the signature binds the Info.plist, which the
  # linker's ad-hoc signature does not. A post phase runs after darwin's own fixup re-signing.
  postPhases = [ "signBundlePhase" ];
  signBundlePhase = ''
    bundle="$out/Applications/weblounge.app"
    ${rcodesign} sign "$bundle"
    signature="$(${rcodesign} print-signature-info "$bundle/Contents/MacOS/weblounge-desktop")"
    grep -q "identifier: org.weblounge.desktop" <<<"$signature"
    grep -q "'Info (1):" <<<"$signature"
  '';
  meta.platforms = pkgs.lib.platforms.darwin;
}
