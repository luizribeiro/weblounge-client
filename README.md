# WebLounge

A modern IRCv3 client for the web, desktop, iOS, and Android, built on [papo](https://github.com/luizribeiro/papo).

## Development

Enter the reproducible development shell and install the JavaScript dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
```

Start the web application:

```sh
pnpm --filter @weblounge/app dev
```

Run the complete project check suite:

```sh
nix flake check --print-build-logs
```

## License

WebLounge is available under either the Apache License 2.0 or the MIT license, at your option.
