{ pkgs, rustToolchain }:
let
  rustPlatform = pkgs.makeRustPlatform {
    cargo = rustToolchain;
    rustc = rustToolchain;
  };
  root = ../apps/tauri;
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
    ];
  };
  cargoLock.lockFile = root + "/Cargo.lock";
  nativeBuildInputs = [ pkgs.cargo-tauri.hook ];
  preCheck = ''
    cargo clippy --offline --release --all-targets -- -D warnings
  '';
  meta.platforms = pkgs.lib.platforms.darwin;
}
