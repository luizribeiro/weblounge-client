# 27 — Desktop wrapper

Status: draft for Luiz's review. A temporary step toward the Tauri desktop shell (brief §3, §5.2,
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
It contains no product rules and depends on nothing in this workspace.

- One window titled “weblounge”, with a native title bar, the chair icon from
  `~/weblounge/web/images/chair.svg`, a sensible default size and a minimum size above the 760 px
  desktop panel boundary. Window size and position persist across launches.
- The standard macOS menu: app (About, Hide, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Select
  All, so text editing shortcuts work), View (Reload, Enter Full Screen) and Window.
- Closing the window hides the app instead of quitting, as macOS chat apps do; ⌘Q quits.
  Reopening from the dock shows the window again.

## Navigation policy

| Request | Result |
|---|---|
| Main-frame navigation to an `https:` URL | Stays in the window. OAuth uses `location.replace` to the concierge and its redirects back. |
| New-window request (`target="_blank"`, `window.open`) | Opens in the default browser. Chat links use `target="_blank"`. |
| Main-frame navigation to any other scheme (`mailto:`, `http:`, custom) | Opens with the system handler; the window does not navigate. |

Without the new-window rule WKWebView silently ignores chat links.

## What the wrapper does not do

These stay with the native desktop design and fail safely today, as they do in browsers without
the feature:

- Offline launch: WKWebView does not run the app's service worker; design 19 treats a failed
  registration as nonfatal and launches online.
- Web Push and system notifications: WKWebView exposes neither. Design 23's desktop notifications
  come from the native engine.
- Tauri-only shortcuts and native menus built from the action registry (design 14): the page sees
  the `web` target, so web-safe chords apply.
- Raw TCP/TLS networks, native storage, notarization and distribution. The build is ad-hoc signed
  for Luiz's own Mac.

## Build

`nix build .#desktop` on `aarch64-darwin` produces `Weblounge.app`. The bundle needs no frontend
assets. The dev shell gains the Tauri CLI on darwin only; Linux CI is unaffected beyond formatting,
clippy and unit tests for the crate.

## Testing

Playwright cannot drive WKWebView, so the AGENTS.md browser requirement is met by the unchanged web
app's existing suites, and the wrapper gets:

- Unit tests for the navigation policy, as a pure function from (request kind, URL) to
  stay/open-externally.
- A manual check before reporting done: launch the built app, sign in through the concierge, send
  a message, open a chat link in the default browser, hide with ⌘W and reopen from the dock, and
  confirm text editing shortcuts.

## Later

The native desktop design replaces the remote URL with the bundled UI, a `TauriEngineClient`, the
native engine host, SQLite storage and native onboarding. The window, menu, close-to-hide and
navigation policy carry over.
