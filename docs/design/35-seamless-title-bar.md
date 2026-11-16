# 35 — Seamless title bar (macOS app)

Status: direction agreed with Luiz (2026-11-15) from the mocks
(https://claude.ai/artifact/UkJSHQUbFMj4aA5YkV2692); split view stays open (decision 2). This
fills in design 27's "Phase 3: seamless title bar".

## Problem

The macOS app shows a standard title bar above the page: a strip that holds only the traffic
lights and wastes 28px. Luiz wants the lights inside the app's own UI, as Slack, Linear and
Notes do. That needs the window to draw no title strip, the page to leave room for the lights,
and the page to stay draggable by its chrome. The prototype has no reference for this layout.

## Approach

**Native window.** The main window is built with `TitleBarStyle::Overlay`, `hidden_title(true)`
and `traffic_light_position`. Tauri 2.12's public API only sets the position when the window is
built, so the geometry is fixed for the window's life. The lights' centres sit 24px from the top,
the midline of the 48px conversation header, with the first light 20px from the left. The exact
`y` is calibrated on macOS 26 by screenshot, because its title-bar metrics differ from older
releases.

**The inset.** The wrapper owns the geometry and publishes it in design 27's identity global
(see Types). When the field is present, the page sets `data-window-controls="overlay"` on the
root and `--wl-window-controls-inline` / `--wl-window-controls-block` (84px and 48px). When it is
absent (a browser, the PWA, an older wrapper), nothing changes. The field stays optional for good,
because older wrappers keep loading newer pages. The variable names are platform-neutral, so a
Chromium desktop PWA could fill them from `env(titlebar-area-*)` later.

**Full screen.** macOS hides the lights in full screen, and CSS can't tell native full screen
apart from a large window. The page asks the window directly, as `badge.js` already does for the
Dock badge: it invokes `plugin:window|is_fullscreen` on mount and after every `resize`, and sets
`data-window-controls` to `hidden` or `overlay`. In `hidden` every inset is 0. Reading the state
rather than waiting for a native event also covers a launch straight into full screen, which the
window-state plugin restores (it persists every flag but visibility). Whether a `resize` fires
after the full-screen transition settles is **[verify in the built app]**; if not, the shell
nudges the page to re-check by dispatching a `resize` from `WindowEvent::Resized` with
`eval_in_page`.

**Dragging.** Tauri's window plugin injects its drag script into every page, the remote one
included. Regions are marked `data-tauri-drag-region="deep"`: the plain attribute only drags when
the press lands on the marked element itself, while `deep` also drags from its text children and
still leaves buttons, links, inputs and focusable elements clickable. A double-click zooms
(decision 3). The page adds the attribute only while `data-window-controls` is `overlay`, so a
browser never sees drag regions. `-webkit-app-region` is Chromium-only, and WKWebView swallows the
mousedowns that `isMovableByWindowBackground` would need, so neither is an alternative.

**Theme.** The lights follow the window's appearance, not the page's. Whenever the resolved theme
changes, the page invokes `plugin:window|set_theme` with `"light"` or `"dark"` (decision 4).

## Types

```ts
// app/src/platform/host-shell.ts: the parsed identity global
interface WindowControls {
  readonly inlineStart: number; // CSS px reserved at the top-left
  readonly blockSize: number;   // CSS px, the band's height
}
interface HostShell {
  readonly kind: "macos-app";
  readonly version: string;
  readonly windowControls?: WindowControls;
}
type WindowControlsState = "overlay" | "hidden"; // data-window-controls; absent outside the app
```

`shell.rs` serializes the same optional field. A missing or malformed field parses to "no
window controls".

## Layout

| State | Lights | Page |
|---|---|---|
| Sidebar visible | top-left of the sidebar | a new 48px row tops the sidebar, level with the conversation header; search and settings move into it; the brand row below loses its buttons (decision 1) |
| Sidebar hidden | over the conversation header | the header's leading padding becomes the reserved width; the sidebar toggle stays in the header and lands just right of the lights (decision 6) |
| Narrow window (overlay panels) | over the header | as "sidebar hidden"; the sidebar drawer's top row is the same 48px row, so it opens under the lights cleanly |
| Full screen | hidden by macOS | the sidebar's lights row collapses and the brand row gets its buttons back (decision 5) |
| Split view | open | decision 2 |

Drag regions: the sidebar's lights row and the single-pane conversation header (background,
title and topic). Never the transcript, composer, lists or drawer bodies, and none in full screen.

## Boundaries

| Area | Change |
|---|---|
| `apps/tauri/src/window.rs` | overlay title bar, hidden title, light position |
| `apps/tauri/src/shell.rs` | `windowControls` in the identity global |
| `apps/tauri/tauri.conf.json` | the `remote-page` capability gains `core:window:allow-start-dragging`, `core:window:allow-internal-toggle-maximize`, `core:window:allow-is-fullscreen` and `core:window:allow-set-theme`; its description names them |
| `app/src/platform/` | parse `windowControls`; one module owns `data-window-controls`, the CSS variables, the full-screen check and the theme call |
| `app/src/shells/desktop/` | the sidebar lights row, the header inset, drag-region attributes; tokens only |

The page never decides anything security-relevant from the identity global (design 27), and any
script on the beta origin could move, zoom or re-theme the window; that is accepted.

## Ship order

The web change ships first: an old wrapper over the new page changes nothing, but a new wrapper
over an old page would draw the lights over the sidebar logo. The wrapper release follows.

## Decisions

1. Sidebar visible: give the lights their own 48px row rather than the brand row. **Agreed.**
2. Split view: a 48px window strip above the panes, or only the top-left pane's header reserves
   the inset? **Open**, to settle when split view is built. Both keep the same 48px top-left
   band, so this choice doesn't change the window geometry.
3. Double-click on a drag region zooms (Tauri's behaviour); honouring the System Settings
   "Double-click a window's title bar" choice comes later. **Agreed.**
4. The lights match the in-app theme, not the system appearance. **Agreed.**
5. Full screen collapses the sidebar's lights row. **Agreed.**
6. The sidebar toggle stays in the conversation header. **Agreed.**

## Out of scope

Split-view layout (decision 2); Windows and Linux title bars; the double-click system setting;
full-window overlays (Settings, image viewer, onboarding) beyond reserving the inset, audited when
built.

## Testing

- **Unit:** `host-shell.ts` parses the field, a missing one and a malformed one; the Rust identity
  serializes it; the state module against a fake `invoke` (full screen on mount, after a resize,
  and the theme call on a theme change).
- **Playwright (web):** a journey fakes the identity and `__TAURI_INTERNALS__` with
  `addInitScript` and checks three states: overlay (insets, lights row, drag-region attributes),
  hidden (no insets, no drag regions) and a plain browser, which must be unchanged. It covers
  sidebar visible, sidebar hidden and the narrow drawer. `nativeFeelAudit` and the idle/hidden
  checks stay green.
- **Manual (design 27 checklist, built app):** light alignment with the header midline, dragging
  from header text and double-click zoom, entering and leaving full screen (including launch into
  full screen), light/dark switching, and a live resize to the 400px minimum.
