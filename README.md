# WebLounge

A modern IRCv3 client for the web, desktop, iOS, and Android, built on [papo](https://github.com/luizribeiro/papo).

## Development

Enter the reproducible development shell and install the JavaScript dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
```

Build the worker wasm, then start the web application configured for the local
Ergo instance:

```sh
nix build .#engine-wasm
WEBLOUNGE_IRC_ENDPOINT=ws://127.0.0.1:8067 \
WEBLOUNGE_IRC_NICKNAME=weblounge \
WEBLOUNGE_IRC_ACCOUNT=weblounge \
WEBLOUNGE_IRC_CHANNEL='#weblounge-test' \
  pnpm --filter @weblounge/app dev
```

In another terminal, start a throwaway local Ergo with loopback-only IRC and WebSocket listeners:

```sh
nix run .#ergo
```

The launcher prints the listener URLs and SASL test credentials. History is enabled; its account
database and all on-disk state live in a temporary directory that is removed when the server exits.

For production-shaped testing, run the separate weblounge profile:

```sh
nix run .#ergo-weblounge
```

It keeps weblounge's SASL-only, always-on, `#lounge` autojoin, persistent channel and DM history,
read-marker, Web Push, and service-command settings. A throwaway local CA and certificate terminate
`wss://127.0.0.1:8068` at nginx; Ergo's plaintext WebSocket listener stays on loopback and accepts
only the test app origin printed by the launcher. The default state directory is temporary. Set
`WEBLOUNGE_ERGO_STATE_DIR` to an explicit directory when testing persistence across restarts; the
launcher then leaves that directory in place.

Start the app for this profile with `WEBLOUNGE_IRC_ENDPOINT=wss://127.0.0.1:8068`, account and nick
`weblounge`, and channel `#lounge`. Browsers must trust the printed CA; the automated Playwright
profile instead ignores certificate errors only in its isolated production-profile contexts.

Open <http://127.0.0.1:5173/?irc-password=weblounge-test>. The app consumes the
password at runtime and immediately removes it from the address bar. Do not set
`WEBLOUNGE_IRC_PASSWORD`: production builds reject it so a credential cannot be
embedded in shipped JavaScript.

The debug connection variables are read when Vite starts or builds the app:

- `WEBLOUNGE_IRC_ENDPOINT` enables the connection; omit it to start without IRC.
- `WEBLOUNGE_IRC_NICKNAME` selects the nick and defaults to `weblounge`.
- `WEBLOUNGE_IRC_ACCOUNT` selects the SASL account and defaults to `weblounge`.
- `WEBLOUNGE_IRC_CHANNEL` selects the autojoin channel and defaults to
  `#weblounge-test`.

Run the complete project check suite:

```sh
nix flake check --print-build-logs
```

The full Web Push lifecycle check runs four NixOS VMs and a real browser. It is
part of the Linux CI check matrix and can also be run locally with:

```sh
nice -n 10 nix build --no-link .#push-e2e --max-jobs 2 --cores 4
```

It drives the pinned previous app through Ergo, the push relay, papo's HTTPS
receiver, and the production service worker before upgrading to the current
build.

For a local iteration, select scenarios by Playwright title without changing
the default CI check:

```sh
nice -n 10 nix build --no-link --impure --max-jobs 2 --cores 4 --expr '
  let flake = builtins.getFlake (toString ./.);
  in (flake.packages.${builtins.currentSystem}.push-e2e.override {
    grep = "blocked IndexedDB|portable control";
  })
'
```

## macOS app

`apps/tauri/` is a temporary Tauri 2 wrapper that opens the hosted app at
<https://beta.weblounge.org> in its own window (see
[design 27](docs/design/27-desktop-wrapper.md)). Install the notarized release (Apple silicon) with:

```sh
brew install --cask luizribeiro/tap/weblounge
```

`brew upgrade` installs later releases. To build and launch it from this checkout instead:

```sh
open "$(nix build --no-link --print-out-paths .#desktop)/Applications/weblounge.app"
```

To keep it in the Dock, copy the bundle out of the Nix store:

```sh
ditto "$(nix build --no-link --print-out-paths .#desktop)/Applications/weblounge.app" \
  ~/Applications/weblounge.app
```

To publish a release ([design 28](docs/design/28-desktop-release.md)), bump the version in
`apps/tauri/Cargo.toml` and `apps/tauri/tauri.conf.json`, push it to `main`, and run
`nix develop -c node apps/tauri/release/release.mjs` (`--dry-run` stops before publishing). It
signs with the Developer ID in the login keychain and notarizes through the `notarytool` keychain
profile `weblounge`; the published release then bumps the tap's cask.

For a quick debug build, run `nix develop -c cargo run --manifest-path apps/tauri/Cargo.toml`.
The bare binary keeps its own web storage, so it asks you to sign in separately from the installed
app.

After changing the brand mark, regenerate the bundled icons with
`nix develop -c apps/tauri/scripts/icons.sh`.

## License

WebLounge is available under either the Apache License 2.0 or the MIT license, at your option.
