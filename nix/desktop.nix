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
  # UNUserNotificationCenter rejects every call unless the signature binds the Info.plist, which the
  # linker's ad-hoc signature does not. A post phase runs after darwin's own fixup re-signing.
  postPhases = [ "signBundlePhase" ];
  signBundlePhase = ''
    bundle="$out/Applications/Weblounge.app"
    ${rcodesign} sign "$bundle"
    signature="$(${rcodesign} print-signature-info "$bundle/Contents/MacOS/weblounge-desktop")"
    grep -q "identifier: org.weblounge.desktop" <<<"$signature"
    grep -q "'Info (1):" <<<"$signature"
  '';
  meta.platforms = pkgs.lib.platforms.darwin;
}
