# 19 — Web packaging

Status: app-shell service-worker slice approved by Luiz on 2026-10-31.

## Problem

An installed web app must reach the existing inline splash and load its engine without waiting for
the network. The app may persist its last validated public deployment configuration, but the
service worker must not retain configuration, credentials, OAuth traffic, IRC traffic, or API
responses, and a newly deployed build must not replace code during a live session.

This slice covers the web app shell only. Web Push, native Tauri packaging, background sync, and
durable IRC state remain later work.

## Build contract

Vite emits a small handwritten service worker beside `index.html`. The production build writes a
content-derived version and an exact precache manifest into it after all output names are final.
The manifest contains `index.html`, hashed application CSS and JavaScript, workers, Inter, engine
Wasm, the manifest, and icons. iOS startup images are launch metadata rather than runtime shell
assets: only the real app document declares them, and the browser fetches the one matching the
device without the worker downloading every device variant. Installation fails if any required
shell entry cannot be fetched, so an incomplete worker never becomes the offline authority.

The cache is named `weblounge-shell-<build version>`. Activation retains the immediately previous
shell cache and deletes anything older. Cache entries use same-origin root-relative URLs so the
build remains auditable and compatible with beta's `default-src 'none'`, `script-src 'self'`, and
`worker-src 'self'` policy.

The Nix build also passes Vite a support-facing identity: the flake's short revision (or `dirty`)
and source timestamp. It is compiled into the app rather than fetched, formats as one UTC line,
and reads `weblounge dev` on the development server. The line is available through `/version`, at
the top of every debug-overlay section, and as `window.weblounge.version`. This identity is distinct
from the content-derived UI/worker compatibility and service-worker cache versions.

Development does not register a service worker. Production registration is scheduled after page
load and the first interactive frame, during browser idle time. Shell requests use low fetch
priority and bounded concurrency so installation does not compete with first-launch interaction.
Registration failure is nonfatal because an online launch still works.

The HTML startup surface owns the only launch chair. Normal startup exposes screen-reader status
but no visible “Connecting” copy; the fixed launch-image geometry communicates progress until the
shell logo can take over. A cold-start failure changes only the status line and reveals its action
below the same chair. Application code never replaces it with a second branded screen.

## Request policy

Navigation requests use the network first, including app deep links, with the versioned shell's
`index.html` as a fallback when the network fails or takes more than 2.5 seconds. Exact precache
URLs use cache-first. Hashed assets from the immediately previous shell remain available to a
running old page during an update. The worker bypasses `config.json`. The window validates
and versions the last good public deployment configuration in local storage, starts from it
without a network round trip, and revalidates in the background. A valid changed response is
persisted for the next launch; a failed or invalid response leaves the last good value intact. A
first launch with no valid cached configuration waits for the network.

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
action. `/version` appends “update ready — restart the app” when that state is set.

## Boundaries and failure modes

The build owns the manifest and version; the worker owns shell fetch routing and cache cleanup; the
window owns registration and update observation. None of them owns deployment config contents,
engine persistence, IRC reconnection, or push events.

Browsers without service workers stay online-only. Private-mode quota failures leave the current
page usable. A failed update leaves the prior active worker and cache intact. Old caches are removed
only after the new worker has installed successfully and reached activation.

## Testing

The production verifier checks the worker's version, exact manifest, and presence of every listed
file. Playwright proves that online navigations use fresh HTML, a second offline launch renders the
splash and starts engine Wasm from cache, and activation retains only one injected old cache;
configuration, session-token, OAuth, API, and WebSocket-shaped traffic is neither cached nor
intercepted by the worker. Development coverage asserts that no registration occurs.

The existing startup, hosted-mode, console-clean, brand, CSP mirror, and native-feel checks remain
green in development and production.

Build-identity coverage formats UTC timestamps in a unit test and drives the production composer
and debug overlay to prove that both show the revision baked into the Nix artifact.
