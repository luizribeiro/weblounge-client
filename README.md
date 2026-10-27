# WebLounge

A modern IRCv3 client for the web, desktop, iOS, and Android, built on [papo](https://github.com/luizribeiro/papo).

## Development

Enter the reproducible development shell and install the JavaScript dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
```

Build the worker wasm, then start the web application:

```sh
nix build .#engine-wasm
pnpm --filter @weblounge/app dev
```

In another terminal, start a throwaway local Ergo with loopback-only IRC and WebSocket listeners:

```sh
nix run .#ergo
```

The launcher prints the listener URLs and SASL test credentials. History is enabled; its account
database and all on-disk state live in a temporary directory that is removed when the server exits.

Run the complete project check suite:

```sh
nix flake check --print-build-logs
```

## License

WebLounge is available under either the Apache License 2.0 or the MIT license, at your option.
