# Hosted web deployment

The single `packages.<system>.app` output runs in app mode only when `/config.json` explicitly
contains `{"mode":"app"}`, and in hosted mode when the server supplies the preset below. A missing
file or HTML fallback is a visible deployment error in production; development and test builds may
still default to app mode. Build it with:

```sh
nix build --no-link .#app
```

For a deployment, build without `--no-link` or copy the flake output directly into the web root.
There is no separate hosted build and no hostname-based mode selection.

## Runtime configuration

`/config.json` is fetched from the app origin with revalidation before the engine starts. Its type
is generated from the Rust `DeploymentConfig`; the browser rejects missing fields, extra fields,
insecure non-loopback URLs, fragments, empty values, and wrong JSON types with a visible error.

The beta preset is:

```json
{
  "mode": "hosted",
  "network": {
    "name": "weblounge",
    "endpoint": "wss://beta.weblounge.org/socket",
    "autojoin": ["#lounge"]
  },
  "oauth": {
    "issuer": "https://members.weblounge.org",
    "client_id": "weblounge-client",
    "redirect_uri": "https://beta.weblounge.org/"
  }
}
```

Concierge must register `weblounge-client` as a public authorization-code client with no secret,
require S256 PKCE, and allow exactly `https://beta.weblounge.org/` as its redirect URI. Its RFC
8414 metadata must advertise matching issuer, authorization, and token endpoints. Ergo must accept
SASL OAUTHBEARER and introspect the resulting token against concierge through the existing private
endpoint. Ergo's WebSocket allowed origins must include `https://beta.weblounge.org`.
The client requests the IRC wildcard nickname `*` during registration so Ergo can attach the
authenticated member's existing always-on session instead of making every hosted client contend
for a preset nickname.

## Nginx shape

The app is built for an origin root (`base: "/"`), matching the exact root OAuth callback. A
representative vhost is:

```nginx
root /nix/store/…-weblounge-app;

location = /config.json {
    alias /nix/store/…-weblounge-beta-config.json;
    add_header Cache-Control "no-cache" always;
}

location = /socket {
    proxy_pass http://127.0.0.1:8097;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}

location = /engine_bg.wasm {
    try_files $uri =404;
    add_header Cache-Control "no-cache" always;
}

location /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}

location ~ ^/(fonts|brand)/ {
    try_files $uri =404;
    add_header Cache-Control "no-cache" always;
}

location / {
    try_files $uri /index.html;
    add_header Cache-Control "no-cache" always;
}
```

The root document, runtime config, fixed-name wasm file, fonts, and brand assets are revalidated;
everything under `/assets/`, including the hashed worker and wasm-glue files, is immutable. Moving
`engine_bg.wasm` under a hashed `/assets/` URL would let the large wasm payload use the same
year-long cache policy; that is a follow-up, not part of this deployment. The UI and worker exchange
a build ID and reload once if an old worker meets a new UI. The production build explicitly disables
source maps, fails if debug IRC configuration or the `?irc-password` hook survives tree-shaking,
and verifies that both workers use emitted same-origin `/assets/*.js` URLs rather than `data:` or
`blob:` URLs.

This CSP is sufficient for the current app. Keep the concierge origin in `connect-src` because
metadata discovery and token exchange are browser requests:

```text
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self';
connect-src 'self' wss://beta.weblounge.org/socket https://members.weblounge.org
  https://files.weblounge.org/upload; img-src 'self'
```

Scripts remain nonce-free and do not allow inline execution. The built-app Playwright suite runs
with this policy (plus its loopback fake OAuth origin), and the production verifier checks that
Vite emitted same-origin worker files compatible with `worker-src 'self'`.

The browser test uses a small standards-shaped OAuth server and a mocked engine through the
one-shot hosted request. Pointing the local Ergo profile at a per-test fake introspection endpoint
would replace its production-shaped static settings, so the real SASL boundary is instead covered
by the native `papo_testing::wire()` transcript, including the exact OAUTHBEARER payload and papo's
secret redaction. The deployed concierge-to-Ergo introspection remains a weblounge-side integration
check.
