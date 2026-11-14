# 27 — Desktop wrapper

Status: draft for Luiz's review; the beta URL and close-to-hide are confirmed (2026-11-12). A temporary step toward the Tauri desktop shell (brief §3, §5.2,
milestone 7); it does not replace that design.

## Problem

Luiz wants weblounge as a macOS app now, before the native engine host, native storage and native
onboarding exist. The brief's desktop app runs the engine natively behind Tauri IPC. That is
weeks of work. A thin Tauri 2 window around the hosted web app gives a dock icon, its own window
and keyboard focus, and a real menu bar today, while every product behaviour stays in the web
build.

This knowingly diverges from the brief's rule that native apps never run the wasm engine. The
divergence is accepted (Luiz, 2026-11-12) because the wrapper is temporary and contains no product
logic, so nothing in it has to be unwound when the native engine arrives.

## Approach

The window loads the hosted deployment, `https://beta.weblounge.org`, rather than a bundled copy of
the app. Hosted sign-in decides this: the concierge OAuth `redirect_uri` comes from the server's
`config.json`, and the return check compares against the page's own origin. A bundled build runs
at `tauri://localhost`, which neither matches. Onboarding (18), the other way to sign in, is not
designed yet. Loading the hosted origin keeps sign-in working unchanged and lets the app update
with every client deploy.

The page learns it runs in the app from one read-only global, so it can use native keymaps (⌘1…9
buffer switching, later ⌘, for Settings; Luiz, 2026-11-13). An initialization script defines
`globalThis.__WEBLOUNGE_SHELL__` as the frozen object `{ kind: "macos-app", version }`, where
`version` is the wrapper's crate version, before any page script runs. Its absence means a plain
browser. Any page script could define the same global, so the page reads it only to pick keymaps
and native affordances, never for a security decision. Every other product behaviour stays the web
build's, and only the narrow capability below exposes IPC to the remote origin.

## Shell

The crate lives at `apps/tauri/`, the location the design index reserves for the native shells.
It contains no product rules, depends on nothing in this workspace, and is its own Cargo workspace
with its own lockfile, so the root workspace and Linux CI never resolve Tauri's dependencies.

- A macOS app icon: the existing felt-and-paper mark that `app/scripts/generate-icons.mjs`
  renders for the PWA, drawn on Apple's rounded-square icon grid and bundled as `.icns`. The
  generator stays the single source for every platform icon.
- One window titled “weblounge”, with a native title bar, a sensible default size and a 400 px
  minimum width: design 09's narrow desktop, where the sidebar and member list become drawers.
  Window size and position persist across launches.
- The standard macOS menu: app (About, Hide, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Select
  All, so text editing shortcuts work), View (Reload, Enter Full Screen) and Window.
- Closing the window hides the app instead of quitting, as macOS chat apps do; ⌘Q quits.
  Reopening from the dock shows the window again.

## Navigation policy

WKWebView reports navigations in every frame, not only the main one, so the policy is about
URLs, not frames.

| Request | Result |
|---|---|
| Navigation to `https:` on the app or concierge host (`beta.weblounge.org`, `members.weblounge.org`) | Stays in the window. OAuth uses `location.replace` to the concierge and its redirects back. |
| Navigation to an in-page document (`about:`, `blob:`, `data:`) | Stays; these never leave the web view. |
| Navigation or new-window request (`target="_blank"`, `window.open`) to any other `http:`, `https:` or `mailto:` URL | Opens in the default browser or mail client; the window does not navigate and no second window opens. Chat links use `target="_blank"`. |
| Any other scheme (`file:`, `javascript:`, `x-apple.systempreferences:`, custom handlers) | Dropped. Chat content must not launch local files or system handlers. |

Without the new-window rule WKWebView silently ignores chat links. The opener plugin's injected link-click script
stays disabled: it cancels the click and opens the link over IPC, which the page does not have.

## What the wrapper does not do

These stay with the native desktop design and fail safely today, as they do in browsers without
the feature:

- Offline launch: WKWebView does not run the app's service worker; design 19 treats a failed
  registration as nonfatal and launches online.
- Web Push and notifications while the app is quit. Notifications while it runs are phase 2.
- Native menus built from the action registry (design 14).
- Raw TCP/TLS networks, native storage, notarization and distribution. The build is ad-hoc signed
  for Luiz's own Mac.

## Build

`nix build .#desktop` on `aarch64-darwin` produces `Weblounge.app`. The bundle needs no frontend
assets. The dev shell gains the Tauri CLI on darwin only. The darwin package build runs the
crate's clippy and unit tests; Linux CI is unaffected. `nix build .#desktop-dmg` wraps that exact
signed bundle in a drag-to-install `Weblounge.dmg`, an HFS+ hybrid image built in the sandbox.

## Testing

Playwright cannot drive WKWebView, so the AGENTS.md browser requirement is met by the unchanged web
app's existing suites, and the wrapper gets:

- Unit tests for the navigation policy, as a pure function from (request kind, URL) to stay,
  open externally or drop.
- A manual check before reporting done: launch the built app, sign in through the concierge, send
  a message, open a chat link in the default browser, hide with ⌘W and reopen from the dock, quit
  while hidden and relaunch to a visible window in its saved place, and confirm text editing
  shortcuts.

## Phase 2: badge and notifications while running

Luiz wants notifications while the app runs and none while it is quit (2026-11-12). The work splits
by where it can be built and tested: wrapper parts on the Mac, which alone runs the window; the web
part on a Linux host, which alone runs the local-Ergo Playwright journeys.

### Wrapper, no web deploy

1. **Dock badge.** The page already calls `navigator.setAppBadge`/`clearAppBadge` with the mention
   count (`app/src/platform/push/app-badge.ts`), guarded by existence; WKWebView lacks the Badging
   API, so the call is a no-op today. The wrapper's initialization script defines both functions on
   `navigator`, forwarding to the window's `set_badge_count` over IPC. A capability scoped to
   `remote.urls: ["https://beta.weblounge.org/*"]` and the main window grants only
   `core:window:allow-set-badge-count`. The badge is correct while the app runs and keeps its last
   value when quit.
2. **No background throttling.** The window uses `BackgroundThrottlingPolicy::Disabled` so the
   engine worker keeps its connection while hidden.
3. **Open at Login.** A checked item in the app menu, off by default, backed by the autostart
   plugin from Rust only (design 23 decision 5). A login launch starts with the window hidden;
   the Dock icon shows it, as after ⌘W.

### Web app, deployed to beta

4. Design 23's page-posted path, which is designed but not built: with push unavailable or denied
   and the app open, the page posts a `Notification` for buffers that are not visible,
   deduplicated by `msgid`. It is a web feature with its own Playwright coverage and also serves
   browsers without push. The wrapper sees it only after a beta deploy.

### Wrapper, after the deploy

5. The wrapper supplies its own `window.Notification`. The Tauri notification plugin's shim has no
   `close()` or click support and its macOS backend cannot report clicks or remove notifications,
   so it cannot serve the page (2026-11-13). The shim implements exactly the surface the page uses,
   with `app/e2e/page-notification-stub.ts` as the reference: `"Notification" in window`, static
   `permission`, `requestPermission()` returning a promise, `new Notification(title, { body, tag })`,
   instance `onclick` (assigned; the event is ignored) and instance `close()`.

   Natively, `UNUserNotificationCenter` (through `objc2-user-notifications`) backs it:

   | Page call | Native behaviour |
   |---|---|
   | `requestPermission()` | `requestAuthorization` for alert, sound and badge; `permission` follows the result and the current settings at launch. |
   | `new Notification(title, { body, tag })` | Posts a request whose identifier is the tag, so a newer notification for a conversation replaces the older one; without a tag the shim generates one. |
   | click | The delegate shows and focuses the window (unhiding it after ⌘W) and runs that instance's `onclick` in the page. |
   | `close()` | Removes the delivered and pending request with that identifier. |

   The delegate presents notifications while the app is frontmost, because the page already
   decides when a notification is warranted. Commands for posting, closing and permission are
   app-defined, and the remote capability grants exactly those.

   A spike on 2026-11-13 confirmed that authorization, posting, click identity, removal and
   same-identifier replacement work from an ad-hoc-signed bundle, but only when the signature binds
   the Info.plist (identifier `org.weblounge.desktop`). The stock Tauri and Nix bundles are not
   signed that way, and every call fails with `UNErrorDomain` 1, so the build re-signs the bundle.

The remote capability is the only path from the page to Tauri, and it grows one named permission
at a time. Close-to-hide plus Open at Login keep the app running, which covers what Luiz asked for.

## Phase 3: seamless title bar

The phase 1 window uses the standard macOS title bar. A seamless window, with the traffic lights
over the sidebar and no title strip, needs an overlay title bar plus web app changes: the desktop
shell must reserve the traffic-light area at the sidebar top, and mark
drag regions, which in turn need the window-drag permission for the remote origin. The prototype
has no reference for this, so the layout needs Luiz's sign-off before it is built.

## Later

The native desktop design replaces the remote URL with the bundled UI, a `TauriEngineClient`, the
native engine host, SQLite storage and native onboarding. The window, menu, close-to-hide and
navigation policy carry over.
