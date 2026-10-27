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
        hooks = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
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
            yamllint = {
              enable = true;
              excludes = [ "^pnpm-lock\\.yaml$" ];
            };
          };
        };
      in
      {
        checks.pre-commit = hooks;
        formatter = pkgs.nixfmt-tree;
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
