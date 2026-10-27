{
  description = "A modern IRCv3 client built on papo";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    {
      crane,
      flake-utils,
      git-hooks,
      nixpkgs,
      rust-overlay,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit overlays system; };
        rustToolchain = pkgs.rust-bin.stable."1.98.1".minimal.override {
          extensions = [
            "clippy"
            "rust-analyzer"
            "rustfmt"
          ];
          targets = [ "wasm32-unknown-unknown" ];
        };
        wasmBindgenCliVersion = "0.2.129";
        engineWasmBudgetBytes = 1347400;
        wasmBindgenCliSource = pkgs.fetchCrate {
          pname = "wasm-bindgen-cli";
          version = wasmBindgenCliVersion;
          hash = "sha256-pcecKQd7E8Opw6bkFoE569epUi7gh5qpQF1e5PJY6V8=";
        };
        wasmBindgenCli = pkgs.buildWasmBindgenCli {
          version = wasmBindgenCliVersion;
          src = wasmBindgenCliSource;
          cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
            pname = "wasm-bindgen-cli-${wasmBindgenCliVersion}";
            version = wasmBindgenCliVersion;
            src = wasmBindgenCliSource;
            hash = "sha256-vmUrWVU7kPJJxO5qIVeAkwQyWDELO1Z4Z5gitz2kco8=";
          };
        };
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        cargoSource = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./Cargo.lock
            ./Cargo.toml
            ./crates
          ];
        };
        cargoArgs = {
          src = cargoSource;
          strictDeps = true;
          pname = "weblounge-client-workspace";
          version = "0.1.0";
          cargoLock = ./Cargo.lock;
          outputHashes = {
            "git+https://github.com/luizribeiro/papo?rev=7d5e4bf2da42f1863753e1311ee817db9e08aa2f#7d5e4bf2da42f1863753e1311ee817db9e08aa2f" =
              "sha256-1mPbzeYvAHzSTXACVOXG+EiofM36bzFvcLlqHVjFLlo=";
          };
        };
        cargoArtifacts = craneLib.buildDepsOnly cargoArgs;
        protocolSource = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./Cargo.lock
            ./Cargo.toml
            ./crates
            ./app/src/engine/generated
          ];
        };
        protocolTypes = craneLib.mkCargoDerivation (
          cargoArgs
          // {
            pname = "weblounge-protocol-types";
            src = protocolSource;
            inherit cargoArtifacts;
            doInstallCargoArtifacts = false;
            buildPhaseCargoCommand = ''
              cargo run --release --locked --package weblounge-engine \
                --example export_protocol -- "$TMPDIR/generated"
              diff --recursive --unified \
                app/src/engine/generated "$TMPDIR/generated"
            '';
            installPhaseCommand = "touch $out";
          }
        );
        engineWasm = craneLib.mkCargoDerivation (
          cargoArgs
          // {
            pname = "weblounge-engine-wasm";
            cargoArtifacts = null;
            doInstallCargoArtifacts = false;
            nativeBuildInputs = [
              pkgs.binaryen
              pkgs.gzip
              wasmBindgenCli
            ];
            buildPhaseCargoCommand = ''
              cargo build --release --package weblounge-engine-wasm \
                --target wasm32-unknown-unknown --locked
            '';
            installPhaseCommand = ''
              mkdir -p $out/bindgen $out/dist
              raw=target/wasm32-unknown-unknown/release/weblounge_engine_wasm.wasm
              cp "$raw" $out/engine.raw.wasm
              wasm-bindgen --target web --out-dir $out/bindgen \
                --out-name engine "$raw"
              wasm-opt -Oz $out/bindgen/engine_bg.wasm -o $out/engine.wasm
              cp $out/bindgen/engine.js $out/engine.js
              cp $out/engine.js $out/dist/engine.js
              cp $out/engine.wasm $out/dist/engine_bg.wasm

              raw_size=$(stat -c %s $out/engine.raw.wasm)
              bindgen_size=$(stat -c %s $out/bindgen/engine_bg.wasm)
              optimized_size=$(stat -c %s $out/engine.wasm)
              gzip_size=$(gzip -9 -n -c $out/engine.wasm | wc -c)
              echo "engine wasm bytes: raw=$raw_size bindgen=$bindgen_size optimized=$optimized_size gzip=$gzip_size"
              if [ "$optimized_size" -gt ${toString engineWasmBudgetBytes} ]; then
                echo "engine wasm exceeds ${toString engineWasmBudgetBytes}-byte budget" >&2
                exit 1
              fi
            '';
          }
        );
        appSource = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./.gitignore
            ./app
            ./biome.json
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
          ];
        };
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "weblounge-app";
          version = "0.1.0";
          src = appSource;
          fetcherVersion = 5;
          hash = "sha256-PoFTXdWNS24vSnzR3912vtXtkf0TAkef8YD+WKhU3g0=";
        };
        appCheck =
          name: command:
          pkgs.stdenvNoCC.mkDerivation {
            pname = "weblounge-${name}";
            version = "0.1.0";
            src = appSource;
            inherit pnpmDeps;
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pnpm
              pkgs.pnpmConfigHook
            ];
            buildPhase = ''
              runHook preBuild
              ${command}
              runHook postBuild
            '';
            installPhase = "touch $out";
          };
        app = pkgs.stdenvNoCC.mkDerivation {
          pname = "weblounge-app";
          version = "0.1.0";
          src = appSource;
          inherit pnpmDeps;
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          buildPhase = ''
            runHook preBuild
            pnpm --filter @weblounge/app build
            runHook postBuild
          '';
          installPhase = ''
            cp -r app/dist $out
          '';
        };
        e2e = pkgs.stdenvNoCC.mkDerivation {
          pname = "weblounge-e2e";
          version = "0.1.0";
          src = appSource;
          inherit pnpmDeps;
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          WEBLOUNGE_APP_DIR = "${app}";
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          buildPhase = ''
            runHook preBuild
            pnpm --filter @weblounge/app e2e
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
        cargoHook = name: command: {
          enable = true;
          entry = "${
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = [ rustToolchain ];
              text = command;
            }
          }/bin/${name}";
          files = "(^|/)(Cargo\\.(toml|lock)|.*\\.rs)$";
          pass_filenames = false;
        };
        offlineHooks = {
          check-merge-conflicts.enable = true;
          end-of-file-fixer.enable = true;
          trim-trailing-whitespace.enable = true;
          nixfmt.enable = true;
          deadnix = {
            enable = true;
            settings = {
              noLambdaArg = true;
              noLambdaPatternNames = true;
            };
          };
          check-toml.enable = true;
          actionlint.enable = true;
          biome = {
            enable = true;
            settings.flags = "--no-errors-on-unmatched";
          };
          yamllint = {
            enable = true;
            excludes = [ "^pnpm-lock\\.yaml$" ];
          };
        };
        projectHooks = {
          rustfmt-check = cargoHook "rustfmt-check" "cargo fmt --all -- --check";
          clippy-check = cargoHook "clippy-check" (
            "cargo clippy --workspace --all-targets --locked -- -D warnings"
          );
          cargo-test = cargoHook "cargo-test" "cargo test --workspace --locked";
          tsc = {
            enable = true;
            entry = "${
              pkgs.writeShellApplication {
                name = "tsc-hook";
                runtimeInputs = [
                  pkgs.nodejs
                  pkgs.pnpm
                ];
                text = "pnpm typecheck";
              }
            }/bin/tsc-hook";
            files = "(^|/)(app/.*\\.tsx?|package\\.json|pnpm-lock\\.yaml)$";
            pass_filenames = false;
          };
          vitest = {
            enable = true;
            entry = "${
              pkgs.writeShellApplication {
                name = "vitest-hook";
                runtimeInputs = [
                  pkgs.nodejs
                  pkgs.pnpm
                ];
                text = "pnpm test";
              }
            }/bin/vitest-hook";
            files = "(^|/)(app/.*\\.tsx?|package\\.json|pnpm-lock\\.yaml)$";
            pass_filenames = false;
          };
        };
        hooks = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = offlineHooks // projectHooks;
        };
        preCommitCheck = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = offlineHooks;
        };
        localErgo = import ./nix/ergo.nix { inherit pkgs; };
      in
      {
        checks = {
          pre-commit = preCommitCheck;
          rustfmt = craneLib.cargoFmt cargoArgs;
          clippy = craneLib.cargoClippy (
            cargoArgs
            // {
              inherit cargoArtifacts;
              cargoClippyExtraArgs = "--workspace --all-targets -- -D warnings";
            }
          );
          cargo-test = craneLib.cargoTest (
            cargoArgs
            // {
              inherit cargoArtifacts;
              cargoTestExtraArgs = "--workspace";
            }
          );
          protocol-types = protocolTypes;
          wasm = engineWasm;
          app-build = app;
          inherit e2e;
          biome = appCheck "biome" "${pkgs.biome}/bin/biome check .";
          tsc = appCheck "tsc" "${pkgs.pnpm}/bin/pnpm typecheck";
          vitest = appCheck "vitest" "${pkgs.pnpm}/bin/pnpm test";
        };
        formatter = pkgs.nixfmt-tree;
        packages = {
          inherit app;
          engine-wasm = engineWasm;
        };
        apps.ergo = {
          type = "app";
          program = pkgs.lib.getExe localErgo;
        };
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            wasmBindgenCli
            pkgs.binaryen
            pkgs.nodejs
            pkgs.pnpm
            pkgs.biome
          ]
          ++ hooks.enabledPackages;
          inherit (hooks) shellHook;
        };
      }
    );
}
