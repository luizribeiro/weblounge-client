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

The page does not know it is in Tauri. No Tauri API is exposed to the remote origin, so the
platform target stays `web` and the UI behaves exactly as in a browser tab. Exposing IPC to a
remote origin is a security boundary this step does not need.

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

Without the new-window rule WKWebView silently ignores chat links.

## What the wrapper does not do

These stay with the native desktop design and fail safely today, as they do in browsers without
the feature:

- Offline launch: WKWebView does not run the app's service worker; design 19 treats a failed
  registration as nonfatal and launches online.
- Web Push and notifications while the app is quit. Notifications while it runs are phase 2.
- Tauri-only shortcuts and native menus built from the action registry (design 14): the page sees
  the `web` target, so web-safe chords apply.
- Raw TCP/TLS networks, native storage, notarization and distribution. The build is ad-hoc signed
  for Luiz's own Mac.

## Build

`nix build .#desktop` on `aarch64-darwin` produces `Weblounge.app`. The bundle needs no frontend
assets. The dev shell gains the Tauri CLI on darwin only. The darwin package build runs the
crate's clippy and unit tests; Linux CI is unaffected.

## Testing

Playwright cannot drive WKWebView, so the AGENTS.md browser requirement is met by the unchanged web
app's existing suites, and the wrapper gets:

- Unit tests for the navigation policy, as a pure function from (request kind, URL) to stay,
  open externally or drop.
- A manual check before reporting done: launch the built app, sign in through the concierge, send
  a message, open a chat link in the default browser, hide with ⌘W and reopen from the dock, quit
  while hidden and relaunch to a visible window in its saved place, and confirm text editing
  shortcuts.

## Phase 2: notifications while running

Luiz wants notifications while the app runs and none while it is quit (2026-11-12).

1. The web app ships design 23's page-posted path, which is designed but not built: with push
   unavailable or denied and the app open, the page posts a `Notification` for buffers that are
   not visible, deduplicated by `msgid`. It is a web feature with its own Playwright coverage and
   also serves browsers without push.
2. The wrapper supplies `window.Notification`, which WKWebView lacks, through the Tauri
   notification plugin's Web Notification shim, delivering macOS notifications. A capability
   grants `https://beta.weblounge.org` the notification plugin and nothing else; this is the only
   exception to the page not reaching Tauri. Whether the shim forwards clicks (to open the
   buffer) is verified before building; if not, a click only activates the app.
3. Background throttling is disabled for the window so the engine worker keeps its connection
   while hidden.
4. The app menu gains an “Open at Login” toggle (design 23 decision 5).

Close-to-hide plus Open at Login keep the app running, which covers what Luiz asked for.

## Phase 3: seamless title bar

The phase 1 window uses the standard macOS title bar. A seamless window, with the traffic lights
over the sidebar and no title strip, needs an overlay title bar plus web app changes: the desktop
shell must know it runs in the wrapper, reserve the traffic-light area at the sidebar top, and mark
drag regions, which in turn need the window-drag permission for the remote origin. The prototype
has no reference for this, so the layout needs Luiz's sign-off before it is built.

## Later

The native desktop design replaces the remote URL with the bundled UI, a `TauriEngineClient`, the
native engine host, SQLite storage and native onboarding. The window, menu, close-to-hide and
navigation policy carry over.
