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
    papo-test-infra = {
      url = "github:luizribeiro/papo/5cf80f3591e8eef1487dee558b32d3e0f6539a19";
      flake = false;
    };
    crane.url = "github:ipetkov/crane";
    weblounge-client-previous.url = "github:luizribeiro/weblounge-client/9f094ac0c2b2b6e94976c96c67ca391ece57102b";
  };

  outputs =
    {
      crane,
      flake-utils,
      git-hooks,
      nixpkgs,
      papo-test-infra,
      rust-overlay,
      self,
      weblounge-client-previous,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        buildSha = self.shortRev or "dirty";
        buildTimestamp = toString (self.lastModified or 0);
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
            "git+https://github.com/luizribeiro/papo?rev=20c6a95#20c6a9567c824a9406555cdd07d829478bca9b7b" =
              "sha256-ECtbDRM5Zd8ydk9AubwrbBSlvhxq+WvDIu67WWLhbCE=";
          };
        };
        cargoArtifacts = craneLib.buildDepsOnly cargoArgs;
        checkCargoArgs = cargoArgs // {
          CARGO_PROFILE = "dev";
        };
        checkCargoArtifacts = craneLib.buildDepsOnly checkCargoArgs;
        pushRelay = craneLib.buildPackage (
          cargoArgs
          // {
            pname = "weblounge-push-relay";
            inherit cargoArtifacts;
            cargoExtraArgs = "--package weblounge-push-relay";
            doCheck = false;
          }
        );
        pushRelayCheck = craneLib.cargoTest (
          checkCargoArgs
          // {
            pname = "weblounge-push-relay-test";
            cargoArtifacts = checkCargoArtifacts;
            cargoTestExtraArgs = "--package weblounge-push-relay";
          }
        );
        pushRelayE2e = craneLib.buildPackage (
          cargoArgs
          // {
            pname = "weblounge-push-relay-e2e";
            inherit cargoArtifacts;
            cargoExtraArgs = "--package weblounge-push-relay --features push-e2e";
            doCheck = false;
          }
        );
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
            '';
          }
        );
        pushPayloadWasm = craneLib.mkCargoDerivation (
          cargoArgs
          // {
            pname = "weblounge-push-payload-wasm";
            cargoArtifacts = null;
            doInstallCargoArtifacts = false;
            nativeBuildInputs = [
              pkgs.binaryen
              wasmBindgenCli
            ];
            buildPhaseCargoCommand = ''
              cargo build --release --package weblounge-push-payload \
                --target wasm32-unknown-unknown --locked
            '';
            installPhaseCommand = ''
              mkdir -p $out/bindgen $out/dist
              raw=target/wasm32-unknown-unknown/release/weblounge_push_payload.wasm
              wasm-bindgen --target no-modules --out-dir $out/bindgen \
                --out-name push-payload "$raw"
              wasm-opt -Oz $out/bindgen/push-payload_bg.wasm -o $out/dist/push-payload_bg.wasm
              cp $out/bindgen/push-payload.js $out/dist/push-payload.js

              optimized_size=$(stat -c %s $out/dist/push-payload_bg.wasm)
              if [ "$optimized_size" -gt 131072 ]; then
                echo "push payload parser exceeds its 128 KiB budget: $optimized_size bytes" >&2
                exit 1
              fi
              echo "push payload parser wasm bytes: optimized=$optimized_size"
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
          hash = "sha256-UQqq4uncZL85zrwjobRizxTF/lmtEbvgwsHbOKZpRQQ=";
        };
        appRuntimeInputs = [
          pkgs.librsvg
          pkgs.nodejs
          pkgs.pnpm
        ];
        vitestEnvironment = {
          maxWorkers = 4;
          testTimeout = 15000;
        };
        vitestCommand = command: ''
          WEBLOUNGE_VITEST_MAX_WORKERS=${toString vitestEnvironment.maxWorkers} \
            WEBLOUNGE_VITEST_TEST_TIMEOUT=${toString vitestEnvironment.testTimeout} \
            ${command}
        '';
        playwrightCommand = ''
          playwright_status=0
          pnpm --filter @weblounge/app e2e || playwright_status=$?
          if [[ "$playwright_status" -ne 0 ]]; then
            while IFS= read -r -d $'\0' context; do
              echo "Playwright error context: $context"
              head --bytes=32768 "$context"
              echo
            done < <(find app/test-results -type f -name error-context.md -print0)
            exit "$playwright_status"
          fi
        '';
        e2eNetworkRunner = pkgs.writeShellScript "weblounge-e2e-network-run" ''
          ip link set lo up
          ip link add e2e-online type dummy
          ip address add 192.0.2.1/24 dev e2e-online
          ip link set e2e-online up
          ip route add default via 192.0.2.2 dev e2e-online
          exec "$@"
        '';
        e2eNetwork = pkgs.writeShellApplication {
          name = "weblounge-e2e-network";
          runtimeInputs = [
            pkgs.iproute2
            pkgs.util-linux
          ];
          text = ''
            ${builtins.readFile ./app/e2e/e2e-network.sh}
          '';
        };
        e2eNetworkFallbackTest = pkgs.runCommand "weblounge-e2e-network-fallback-test" { } ''
          ${pkgs.bash}/bin/bash ${./app/e2e/e2e-network.test.sh} \
            ${./app/e2e/e2e-network.sh}
          touch $out
        '';
        runE2e = command: ''
          ${pkgs.lib.getExe e2eNetwork} ${e2eNetworkRunner} \
            ${pkgs.runtimeShell} -c ${pkgs.lib.escapeShellArg command}
        '';
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
          nativeBuildInputs = appRuntimeInputs ++ [
            pkgs.pnpmConfigHook
          ];
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          WEBLOUNGE_PUSH_PAYLOAD_WASM_DIR = "${pushPayloadWasm}/dist";
          WEBLOUNGE_BUILD_SHA = buildSha;
          WEBLOUNGE_BUILD_TIMESTAMP = buildTimestamp;
          buildPhase = ''
            runHook preBuild
            pnpm --filter @weblounge/app build
            runHook postBuild
          '';
          installPhase = ''
            cp -r app/dist $out
          '';
        };
        checkApp = app.overrideAttrs {
          # Revision metadata does not change the behavior exercised by CI.
          WEBLOUNGE_BUILD_SHA = "ci";
          WEBLOUNGE_BUILD_TIMESTAMP = "0";
        };
        ciDeps = pkgs.linkFarm "weblounge-ci-deps" [
          {
            name = "app";
            path = checkApp;
          }
          {
            name = "engine-wasm";
            path = engineWasm;
          }
          {
            name = "rust-check-dependencies";
            path = checkCargoArtifacts;
          }
          {
            name = "rust-release-dependencies";
            path = cargoArtifacts;
          }
          {
            name = "push-relay";
            path = pushRelay;
          }
        ];
        e2eApp = checkApp.overrideAttrs {
          WEBLOUNGE_E2E_HARNESS = "1";
          WEBLOUNGE_IRC_ENDPOINT = "ws://127.0.0.1:4173/socket";
          WEBLOUNGE_IRC_NICKNAME = "weblounge";
          WEBLOUNGE_IRC_ACCOUNT = "weblounge";
          WEBLOUNGE_IRC_CHANNEL = "#weblounge-test";
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
            pkgs.fontconfig
            pkgs.curl
            localErgo
          ];
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          WEBLOUNGE_APP_DIR = "${e2eApp}";
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          WEBLOUNGE_E2E_ERGO = "1";
          WEBLOUNGE_E2E_IRC_TARGET = "ws://127.0.0.1:8066";
          WEBLOUNGE_E2E_FORWARDER_URL = "http://127.0.0.1:8091";
          WEBLOUNGE_EXPECTED_BUILD_SHA = "ci";
          buildPhase = ''
            runHook preBuild
            ${runE2e ''
              weblounge-ergo >ergo.log 2>&1 &
              ergo_pid=$!
              node app/e2e/socket-forwarder.mjs >forwarder.log 2>&1 &
              forwarder_pid=$!
              export WEBLOUNGE_ERGO_CONTROL_PID="$ergo_pid"
              trap 'kill "$forwarder_pid" "$ergo_pid" 2>/dev/null || true; wait "$forwarder_pid" "$ergo_pid" 2>/dev/null || true' EXIT
              ready=false
              for _ in $(seq 1 200); do
                if grep --quiet 'local Ergo is ready' ergo.log; then
                  ready=true
                  break
                fi
                if ! kill -0 "$ergo_pid" 2>/dev/null; then
                  cat ergo.log >&2
                  exit 1
                fi
                sleep 0.05
              done
              if [[ "$ready" != true ]]; then
                cat ergo.log >&2
                exit 1
              fi
              forwarder_ready=false
              for _ in $(seq 1 200); do
                if curl --silent --fail http://127.0.0.1:8091/health >/dev/null; then
                  forwarder_ready=true
                  break
                fi
                if ! kill -0 "$forwarder_pid" 2>/dev/null; then
                  cat forwarder.log >&2
                  exit 1
                fi
                sleep 0.05
              done
              if [[ "$forwarder_ready" != true ]]; then
                cat forwarder.log >&2
                exit 1
              fi
              ${playwrightCommand}
            ''}
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
        e2eDev = pkgs.stdenvNoCC.mkDerivation {
          pname = "weblounge-e2e-dev";
          version = "0.1.0";
          src = appSource;
          inherit pnpmDeps;
          nativeBuildInputs = appRuntimeInputs ++ [
            pkgs.pnpmConfigHook
            pkgs.fontconfig
          ];
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          WEBLOUNGE_E2E_DEV = "1";
          buildPhase = ''
            runHook preBuild
            ${runE2e playwrightCommand}
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
        previousApp = weblounge-client-previous.packages.${system}.app;
        upgradeE2e = pkgs.stdenvNoCC.mkDerivation {
          pname = "weblounge-upgrade-e2e";
          version = "0.1.0";
          src = appSource;
          inherit pnpmDeps;
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
            pkgs.fontconfig
          ];
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          WEBLOUNGE_APP_DIR = "${e2eApp}";
          WEBLOUNGE_ENGINE_WASM_DIR = "${engineWasm}/dist";
          WEBLOUNGE_E2E_APP_ONLY = "1";
          WEBLOUNGE_PREVIOUS_APP_DIR = "${previousApp}";
          WEBLOUNGE_PREVIOUS_BUILD_SHA = weblounge-client-previous.shortRev;
          buildPhase = ''
            runHook preBuild
            pnpm --filter @weblounge/app e2e \
              --project=chromium service-worker.spec.ts
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
        pushE2eHarness = pkgs.stdenvNoCC.mkDerivation {
          pname = "weblounge-push-e2e-harness";
          version = "0.1.0";
          src = appSource;
          inherit pnpmDeps;
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ];
          buildPhase = "true";
          installPhase = ''
            mkdir -p $out
            cp -r app node_modules package.json pnpm-lock.yaml pnpm-workspace.yaml $out/
          '';
        };
        pushE2e = import ./nix/push-e2e.nix {
          inherit
            checkApp
            papo-test-infra
            pkgs
            previousApp
            pushE2eHarness
            pushRelayE2e
            ;
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
          pnpm-deps-hash = {
            enable = true;
            entry = "${
              pkgs.writeShellApplication {
                name = "pnpm-deps-hash-hook";
                runtimeInputs = [ pkgs.gnused ];
                text = ''
                  expected=$(nix eval --raw .#pnpm-deps.outputHash)
                  build_output=$(nix build --no-link .#pnpm-deps-probe 2>&1 || true)
                  got=$(printf '%s\n' "$build_output" | sed -n 's/.*got: *\(sha256-[^ ]*\).*/\1/p' | tail -n 1)
                  if [ -z "$got" ]; then
                    echo "Could not compute the pnpm dependency hash." >&2
                    exit 1
                  fi
                  if [ "$got" != "$expected" ]; then
                    echo "flake.nix pnpmDeps hash is stale: replace $expected with $got" >&2
                    exit 1
                  fi
                '';
              }
            }/bin/pnpm-deps-hash-hook";
            files = "(^|/)(package\\.json|pnpm-lock\\.yaml|pnpm-workspace\\.yaml)$";
            pass_filenames = false;
          };
          test-wait-policy = {
            enable = true;
            entry = "${pkgs.nodejs}/bin/node app/scripts/test-wait-policy.ts";
            files = "^app/(e2e/.*\\.tsx?|playwright\\.config\\.ts)$";
          };
          platform-boundary-policy = {
            enable = true;
            entry = "${pkgs.nodejs}/bin/node app/scripts/platform-boundary-policy.ts";
            files = "^app/src/.*\\.(css|tsx?)$";
          };
          protocol-types = {
            enable = true;
            entry = "${
              pkgs.writeShellApplication {
                name = "protocol-types-hook";
                runtimeInputs = [
                  rustToolchain
                  pkgs.diffutils
                ];
                text = ''
                  generated="$(mktemp -d)"
                  trap 'rm -rf -- "$generated"' EXIT
                  cargo run --locked --package weblounge-engine \
                    --example export_protocol -- "$generated"
                  diff --recursive --unified app/src/engine/generated "$generated"
                '';
              }
            }/bin/protocol-types-hook";
            files = "(^|/)(Cargo\\.(toml|lock)|crates/engine/(src|examples)/.*\\.rs|app/src/engine/generated/.*\\.ts)$";
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
        webloungeErgo = import ./nix/ergo-weblounge.nix { inherit pkgs; };
        ergoIntegration = craneLib.mkCargoDerivation (
          checkCargoArgs
          // {
            pname = "weblounge-ergo-integration";
            cargoArtifacts = checkCargoArtifacts;
            doInstallCargoArtifacts = false;
            nativeBuildInputs = [ localErgo ];
            buildPhaseCargoCommand = ''
              weblounge-ergo >ergo.log 2>&1 &
              ergo_pid=$!
              trap 'kill "$ergo_pid" 2>/dev/null || true; wait "$ergo_pid" 2>/dev/null || true' EXIT
              ready=false
              for _ in $(seq 1 200); do
                if grep --quiet 'local Ergo is ready' ergo.log; then
                  ready=true
                  break
                fi
                if ! kill -0 "$ergo_pid" 2>/dev/null; then
                  cat ergo.log >&2
                  exit 1
                fi
                sleep 0.05
              done
              if [[ "$ready" != true ]]; then
                cat ergo.log >&2
                exit 1
              fi
              WEBLOUNGE_ERGO_URL=ws://127.0.0.1:8067 \
                cargo test --locked --package weblounge-engine \
                  --test ergo -- --nocapture
            '';
            installPhaseCommand = "touch $out";
          }
        );
      in
      {
        checks = {
          pre-commit = preCommitCheck;
          rustfmt = craneLib.cargoFmt cargoArgs;
          clippy = craneLib.cargoClippy (
            checkCargoArgs
            // {
              cargoArtifacts = checkCargoArtifacts;
              cargoClippyExtraArgs = "--workspace --all-targets -- -D warnings";
            }
          );
          cargo-test = craneLib.cargoTest (
            checkCargoArgs
            // {
              cargoArtifacts = checkCargoArtifacts;
              cargoTestExtraArgs = "--workspace";
            }
          );
          ergo-integration = ergoIntegration;
          protocol-types = protocolTypes;
          push-relay-build = pushRelay;
          push-relay-test = pushRelayCheck;
          wasm = engineWasm;
          push-payload-wasm = pushPayloadWasm;
          app-build = checkApp;
          e2e-network-fallback = e2eNetworkFallbackTest;
          inherit e2e;
          e2e-dev = e2eDev;
          upgrade-e2e = upgradeE2e;
          biome = appCheck "biome" "${pkgs.biome}/bin/biome check .";
          tsc = appCheck "tsc" "${pkgs.pnpm}/bin/pnpm typecheck";
          vitest = appCheck "vitest" (vitestCommand "${pkgs.pnpm}/bin/pnpm test");
        };
        formatter = pkgs.nixfmt-tree;
        packages = {
          inherit app;
          previous-app = previousApp;
          ci-deps = ciDeps;
          engine-wasm = engineWasm;
          push-payload-wasm = pushPayloadWasm;
          ergo-weblounge = webloungeErgo;
          pnpm-deps = pnpmDeps;
          pnpm-deps-probe = pnpmDeps.overrideAttrs { outputHash = pkgs.lib.fakeHash; };
          push-relay = pushRelay;
          push-e2e = pushE2e;
        };
        apps.ergo = {
          type = "app";
          program = pkgs.lib.getExe localErgo;
        };
        apps.ergo-weblounge = {
          type = "app";
          program = pkgs.lib.getExe webloungeErgo;
        };
        devShells.default = pkgs.mkShell {
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          packages = [
            rustToolchain
            wasmBindgenCli
            pkgs.binaryen
            pkgs.biome
          ]
          ++ appRuntimeInputs
          ++ hooks.enabledPackages;
          inherit (hooks) shellHook;
        };
      }
    );
}
