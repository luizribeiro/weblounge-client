# 19 — Web packaging

Status: app-shell service-worker slice approved by Luiz on 2026-10-31.

## Problem

An installed web app must reach the existing inline splash and load its engine without waiting for
the network. Caching must not retain deployment configuration, credentials, OAuth traffic, IRC
traffic, or API responses, and a newly deployed build must not replace code during a live session.

This slice covers the web app shell only. Web Push, native Tauri packaging, background sync, and
durable IRC state remain later work.

## Build contract

Vite emits a small handwritten service worker beside `index.html`. The production build writes a
content-derived version and an exact precache manifest into it after all output names are final.
The manifest contains `index.html`, hashed application CSS and JavaScript, workers, Inter, engine
Wasm, the manifest and icons, and every iOS startup image. Installation fails if any required entry
cannot be fetched, so an incomplete worker never becomes the offline authority.

The cache is named `weblounge-shell-<build version>`. Activation deletes every older
`weblounge-shell-` cache. Cache entries use same-origin root-relative URLs so the build remains
auditable and compatible with beta's `default-src 'none'`, `script-src 'self'`, and
`worker-src 'self'` policy.

Development does not register a service worker. Production registration happens after page load;
registration failure is nonfatal because an online launch still works.

## Request policy

Navigation requests use the versioned shell's `index.html` cache entry first, including app deep
links. Exact precache URLs use cache-first. `config.json` uses network-first and a separate runtime
cache: a successful same-origin response replaces the cached public deployment configuration, and
an offline launch falls back to the last response. It is not part of the immutable precache because
it selects hosted versus app mode and can change independently of a build.

Every other request passes through to the browser without a service-worker `respondWith`. In
particular, the worker never handles non-GET requests, cross-origin requests, `/socket`, OAuth or
session-token endpoints, API paths, upload traffic, or WebSocket upgrades. This allowlist makes
credential safety independent of endpoint naming conventions.

If the app shell cache is absent or corrupt, navigation falls back to the network. Failed network
requests retain normal browser errors; the worker does not synthesize successful responses.

## Updates

The worker does not call `skipWaiting`, and the page does not ask it to. A newly installed worker
therefore remains waiting while any page uses the previous build, then activates on a later launch
after those clients close. `clients.claim()` lets that activation own the new launch without a
second reload.

The page observes `updatefound` and a waiting worker and records a typed `update-ready` state. This
slice deliberately has no toast or reload button: the next-launch policy needs no mid-session user
action. The state is the minimal seam for a future settings/about indicator.

## Boundaries and failure modes

The build owns the manifest and version; the worker owns shell fetch routing and cache cleanup; the
window owns registration and update observation. None of them owns deployment config contents,
engine persistence, IRC reconnection, or push events.

Browsers without service workers stay online-only. Private-mode quota failures leave the current
page usable. A failed update leaves the prior active worker and cache intact. Old caches are removed
only after the new worker has installed successfully and reached activation.

## Testing

The production verifier checks the worker's version, exact manifest, and presence of every listed
file. Playwright proves that a second launch renders the splash and starts engine Wasm while all
app-origin network requests are blocked; activation removes an injected old cache; config remains
network-first; and session-token, OAuth, API, and WebSocket-shaped traffic is neither cached nor
intercepted. Development coverage asserts that no registration occurs.

The existing startup, hosted-mode, console-clean, brand, CSP mirror, and native-feel checks remain
green in development and production.
