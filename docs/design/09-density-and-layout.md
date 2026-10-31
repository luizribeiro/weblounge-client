# 09 — Density and layout system

Status: platform-environment addendum approved by Luiz on 2026-10-30.

## Problem

The UI has independent message, desktop-list, and mobile-list densities; two responsive shells;
safe areas; and a persistent desktop tree of up to six panes. Layout is UI-only state. The engine
does not know the active shell, pane tree, focus, zoom, or side panels.

## Density data

Checked JSON contains the Appendix B measurements and generates TypeScript types plus CSS custom
properties. It is not compiled into the Rust engine.

```ts
export type DensityId = "compact" | "cozy" | "comfortable";
export type MessageLayout = "oneLine" | "grouped";

export interface DensitySettings {
  readonly messageLayout: MessageLayout;
  readonly message: DensityId;
  readonly desktopList: DensityId;
  readonly mobileList: DensityId;
}
```

Defaults are cozy messages, compact desktop lists, and cozy mobile lists. The three choices remain
independent. Components consume `--wl-density-*` variables rather than branching on preset IDs,
except compact mobile rows use a typed no-preview variant so hidden text is absent from layout and
accessibility output. Touch targets remain at least 44 CSS px and text continues to scale.

## Shell selection

Shell choice follows the primary input, never the viewport width. The web adapter selects mobile
only when `(hover: none) and (pointer: coarse)` matches; every other web environment selects
desktop. Tauri desktop selects desktop and Tauri iOS/Android select mobile from their build target,
without running browser detection. Tablets whose primary input is touch use mobile for now. iPad
with a trackpad or keyboard remains an open product question.

The platform environment installs `data-shell` before the Solid root renders. Resizing never
changes it, remounts the shell, or converts navigation state. A 400px mouse-primary browser is a
narrow desktop; a 1024px touch-primary browser is mobile. A genuine primary-input capability
change may update the web selection, but width changes cannot.

## Platform environment

`app/src/platform/` is the only runtime owner of browser, input, display-mode, safe-area, keyboard,
and platform-quirk detection. It publishes this closed environment on the app root:

```ts
export type PrimaryInput = "touch" | "mouse";
export type DisplayMode = "standalone" | "browser" | "tauri";
export type Shell = "mobile" | "desktop";
export type DesktopPanels = "inline" | "overlay";

export interface PlatformEnvironment {
  readonly input: PrimaryInput;
  readonly display: DisplayMode;
  readonly shell: Shell;
  readonly desktopPanels: DesktopPanels;
}
```

The corresponding root attributes are `data-input`, `data-display`, `data-shell`, and
`data-desktop-panels`. The last attribute is presentation state, not shell selection, and is the
only consumer of the 760px app-container breakpoint. `:root` defines `--wl-safe-top`,
`--wl-safe-right`, `--wl-safe-bottom`, and `--wl-safe-left` from `env(safe-area-inset-*)`. The
platform owns the app geometry: `#root` is fixed and the document never scrolls.

- Keyboard closed, `#root` fills the layout viewport through CSS alone. iOS 26 Home Screen apps
  with a `black-translucent` status bar get a layout viewport short by the top inset and WebKit
  paints nothing below it ([WebKit 301108](https://bugs.webkit.org/show_bug.cgi?id=301108)), so
  making `#root` taller only clips the composer. The viewport is full once the document is at
  least screen tall, so in standalone `html` has
  `min-block-size: min(100lvh, calc(100% + var(--wl-safe-top)))`; the `100lvh` cap keeps it at
  `100%` when the viewport is already full or the status bar is opaque. If a WebKit release keeps
  the viewport short anyway, the composer still sits whole inside the painted area above an
  unpainted band.
- Keyboard open (the visual viewport over 120px shorter than the layout viewport, pinch zoom
  excluded), `#root` takes the visual viewport's height from `--wl-app-height` and keeps
  `--wl-app-top` at zero. A short touch that ends within 10px and under 500ms moves the composer field
  above the viewport synchronously, focuses it with `preventScroll`, and restores it the next
  frame, following [React Aria's iOS
  technique](https://github.com/adobe/react-spectrum/blob/7eae25e124a9d235ff30f12bd86383b894a1ea04/packages/%40react-aria/overlays/src/usePreventScroll.ts#L142-L154).
  This leaves drags and long-press callouts native while preventing WebKit's focus pan rather than
  following its curve. A platform-owned non-passive
  vertical `touchmove` lock prevents document panning while the keyboard is open, but preserves
  textarea caret and loupe gestures, selected text, multitouch, horizontal navigation gestures,
  and an inner scroller that can still move in the gesture direction. The transcript uses
  `overscroll-behavior: contain` at its own boundary. These compensate for [WebKit
  240860](https://bugs.webkit.org/show_bug.cgi?id=240860), [271773](https://bugs.webkit.org/show_bug.cgi?id=271773),
  and [244232](https://bugs.webkit.org/show_bug.cgi?id=244232).
- A surviving iOS pan is still undone with `scrollTo(0, 0)`, but its stale `offsetTop` is never
  published. Because WebKit can fire viewport events before updating their values, each event
  re-measures on following frames until geometry holds for two of them. App-height publication
  synchronously signals a live-edge transcript to re-anchor after the new height takes effect and
  before paint; the later `ResizeObserver` notification is not the first correction.
- `?debug=viewport` (persisted until `?debug=off`) shows a platform-owned overlay of the live
  layout, visual viewport, safe-area, app geometry and element rects for on-device checks.

`--wl-safe-bottom-effective` follows the bottom safe inset while the keyboard
is closed and becomes zero under `data-keyboard="open"`, so components never interpret keyboard
state themselves. Tests can replace those custom properties on the root without impersonating a
device. The web adapter derives display mode from `(display-mode: standalone)` and keyboard geometry
from `visualViewport`; Tauri injects the same contract from its target and keyboard plugin. Theme
and motion code consumes platform-owned preference observers or token-file media queries rather
than issuing its own `matchMedia` calls.

Components consume only these attributes and properties. A repository check rejects
`env(safe-area`, `matchMedia(`, `navigator.userAgent`, `navigator.platform`, and media-query
`max-width:` outside `app/src/platform/` and the explicit token/breakpoint files. It distinguishes
media queries from ordinary `max-width` declarations. The existing modifier-key adapter, theme
preference, reduced-motion check, touch sizing, and safe-area declarations all move behind this
boundary.

Device or model sniffing is forbidden. The sole exception is
`app/src/platform/quirks.ts`, whose closed entries each carry a name, the narrowest available
detection (a feature test whenever possible), an upstream bug URL, and a concrete removal
condition. The planned `iosGestureEvents` entry for WebKit pinch suppression follows that shape;
quirks cannot select a shell or provide ordinary layout policy.

Width still controls presentation inside the desktop shell. `760px` is the single desktop-panel
breakpoint: at or above it the sidebar can be inline; below it the sidebar is transient. Member
lists independently use the existing pane calculation of a 232px list beside at least a 320px
conversation. The minimum supported desktop viewport is `360px`.

## Desktop pane tree

```ts
export const MAX_PANES = 6;

export interface PaneLayout {
  readonly root: PaneNode;
  readonly focused: PaneId;
  readonly zoomed: boolean;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLeaf {
  readonly kind: "leaf";
  readonly id: PaneId;
  readonly bufferId?: BufferId;
}

export interface PaneSplit {
  readonly kind: "split";
  readonly id: SplitId;
  readonly axis: "row" | "column";
  readonly ratio: SplitRatio;
  readonly first: PaneNode;
  readonly second: PaneNode;
}
```

`zoomed` applies to the focused leaf, so zoom cannot point at a different pane. Directional focus
while zoomed changes the presented pane. Splitting or moving clears zoom; changing focus, showing a
buffer, and swapping do not. The same buffer may appear in multiple leaves.

The root always exists. Closing the last leaf creates one focused empty leaf. Stable pane IDs keep
per-pane scroll/focus state attached during moves. Decoding validates one-to-six unique leaves,
unique split IDs, one valid focus, finite ratios in `0.15..=0.85`, and existing buffer references.
Unknown buffers become empty leaves. Other invalid persisted data falls back to one leaf with the
last valid buffer when possible.

## Tree operations and geometry

```ts
export type PaneMutation =
  | { readonly kind: "show"; readonly paneId: PaneId; readonly bufferId?: BufferId }
  | { readonly kind: "split"; readonly paneId: PaneId; readonly edge: Edge; readonly bufferId?: BufferId }
  | { readonly kind: "close"; readonly paneId: PaneId }
  | { readonly kind: "swap"; readonly first: PaneId; readonly second: PaneId }
  | { readonly kind: "move"; readonly paneId: PaneId; readonly target: PaneId; readonly edge: Edge }
  | { readonly kind: "focus"; readonly paneId: PaneId }
  | { readonly kind: "toggleZoom" }
  | { readonly kind: "setRatio"; readonly splitId: SplitId; readonly ratio: SplitRatio }
  | { readonly kind: "resetRatio"; readonly splitId: SplitId };
```

At six leaves, split degrades to show-here. Closing an unfocused pane retains focus; closing the
focused pane focuses the first leaf of the promoted sibling in stable tree order. No unstored focus
history influences the result. Resize mutations always take an absolute ratio; pointer/keyboard
adapters convert deltas before dispatch. Reset uses `0.5`.

Pure geometry exports:

```ts
paneInDirection(layout, rects, from, direction): PaneId | undefined;
nearestDivider(layout, rects, from, direction): DividerAdjustment | undefined;
```

The first ranks candidates by primary-axis distance, secondary overlap, then tree order. The
second finds the nearest divider whose movement grows/shrinks the focused pane and returns its
split ID plus ratio sign. Subsystem 14 commands consume these queries; shortcut chords are not
defined here.

The command registry maps to layout operations with these exact IDs:

| Command IDs | Layout operation |
|---|---|
| `pane.mode` | none; subsystem 14 opens the transient pane-command scope |
| `pane.focus`, `pane.show-buffer` | `focus`, `show` |
| `pane.open-buffer-right`, `pane.split-right`, `pane.split-down` | `split`, degrading to `show` at six leaves |
| `pane.focus-left`, `pane.focus-right`, `pane.focus-up`, `pane.focus-down` | `paneInDirection` then `focus` |
| `pane.move-left`, `pane.move-right`, `pane.move-up`, `pane.move-down` | `paneInDirection` then `move` |
| `pane.grow`, `pane.shrink` | `nearestDivider` then `setRatio` |
| `pane.toggle-zoom`, `pane.close` | `toggleZoom`, `close` |
| `separator.decrease`, `separator.increase` | focused split then `setRatio` |

Directional suffixes are four distinct closed `CommandId` members, not runtime-built strings.
Subsystem 14 owns their bindings and availability; this subsystem remains the only reducer and
geometry implementation.

## Frame and responsive presentation

One pane has the prototype's 48px main header. Multi-pane mode has 38px pane headers plus the 38px
workspace bar defined by subsystem 10. Dividers expose a 7px hit target around a 1px gap. Sidebar,
member-panel, and chromeless presentation are inputs from navigation/settings rather than fields in
the pane tree; per-channel member visibility lives only in subsystem 10. Layout supplies each
pane's width so navigation can choose inline member list or overlay drawer.

On narrow desktop, one shared drawer primitive presents the sidebar from the left or the focused
pane's member list from the right. Its state is a closed union (`"sidebar" | "members" | null`),
so the two overlays cannot be open together. Both directions use the same scrim, motion tokens,
focus containment, and dismissal behavior as the mobile members drawer and future split-view
overlay. The header button and `sidebar.toggle` open the sidebar drawer when it cannot be inline;
`members.toggle` does the same on the right when the focused pane cannot fit its list.

Choosing a channel, pressing Escape, or activating the scrim closes a desktop drawer and returns
focus to the composer. Growing across the panel breakpoint removes a transient drawer and restores
the corresponding inline panel when its persisted visibility says shown; shrinking collapses the
inline presentation without changing that preference. Neither transition remounts the desktop
shell, pane, conversation, message list, or composer, so draft and scroll state retain element
identity. At 360px the header, one focused conversation, and composer must still lay out without
overlap.

Each pane's minimum rendered box is 320×240px. If the tree cannot meet that minimum, only the
focused pane is rendered without mutating the tree or persisted zoom flag. The workspace bar shows
the status “Layout hidden at this window size.” Growing the window restores the tree. Explicit
zoom wins over this automatic presentation.

With one pane, the conversation, message list, and composer fill all space between visible side
panels; hiding a panel immediately gives that width back to the conversation. Multiple panes also
fill the main area. Headers remain because they contain structural pane controls.

Every divider is a keyboard-focusable separator with orientation and 15–85 values. Pointer drag
previews the affected ratio and commits an absolute value on release; double-click resets it.
Direct separator arrow behavior is defined by ARIA semantics, while global grow/shrink actions use
the nearest-divider query through subsystem 14.

## Persistence

```ts
export interface PersistedDesktopLayoutV1 {
  readonly version: 1;
  readonly root: PersistedPaneNode;
  readonly focused: PaneId;
  readonly zoomed: boolean;
  readonly sidebar: "shown" | "hidden";
}
```

Tree, ratios, focus, zoom, and sidebar preference are device-local UI persistence. Member-panel
state is persisted by navigation, not duplicated here. Writes occur after discrete mutations and
once after resize; the previous valid value remains until atomic replacement succeeds. Unknown
future versions are preserved until the user changes layout.

## Mobile and safe areas

Mobile never renders or mutates the pane tree. `viewport-fit=cover` enables the platform safe-area
values, and `apple-mobile-web-app-status-bar-style` is `black-translucent`: the themed header paints
through the status region while its content starts below `--wl-safe-top`. This is the only
component that consumes the top inset. The shell frame consumes the left/right insets once so
landscape children use an already-safe content box.

The screen frame reaches the physical bottom edge. Its active bottom surface consumes
`--wl-safe-bottom` once: the tab bar on a root tab, the composer on a conversation, or the bottom of
an open drawer. A root list with no bottom bar scrolls beneath the home-indicator region and keeps
its final content clear with bottom content padding. Composer padding is the larger of its ordinary
spacing and the safe inset, never their sum. Content may scroll under opaque or translucent bars,
but interactive controls and text never enter the inset. The keyboard adapter publishes
the app geometry and `data-keyboard`; the conversation bottom follows the larger effective
obstruction without adding safe-area padding in both shell and component. The composer transitions
to its ordinary bottom padding with the reduced-motion-aware platform motion tokens while staying
pinned to the live edge. No component reads raw `env()` or ships the prototype's iPhone
measurements.

## Boundaries

This subsystem owns density measurements, the platform-environment contract, shell selection,
desktop panel breakpoints, safe-area/keyboard geometry, pane-tree validation/reduction,
geometry/directional queries, responsive presentation, and layout persistence. It does not own
buffer content, member-panel preference, read markers, navigation actions, command bindings,
themes, or virtual-list behavior.

## Testing

- Schema tests verify every Appendix B value and default.
- Property tests cover tree decode and mutation invariants, including close focus and six-pane
  degradation.
- Geometry tests cover nested splits, directional focus, nearest-divider selection, RTL, ratio
  clamping, and the 320×240 automatic presentation boundary.
- Persistence tests cover corruption, missing buffers, zoom restoration, migrations, and resize
  write coalescing.
- Platform unit tests cover web media-feature mapping, Tauri target mapping, reactive preference
  changes, injected safe-area/keyboard values, and quirk-registry metadata.
- Playwright keeps one desktop shell element across 1440, 900, 600, and 400px widths and across
  the old 760px boundary, preserving its draft and scroll. At 400px it covers left drawer open,
  channel selection, scrim/Escape dismissal, and composer focus; touch iPhone and Android profiles
  select mobile.
- Safe-area Playwright profiles inject iPhone portrait (top 62px, bottom 34px), iPhone landscape
  (left/right 62px, bottom 21px), and Android gesture navigation (bottom 24px). They assert header,
  composer/tab bar, drawer, interactive controls, and text stay inside the safe content box, with
  light/dark screenshots for every profile.
- Mobile WebKit taps the composer through an emulated focus pan and samples opening frames to keep
  visual viewport, document, and app top at zero. With the keyboard open, vertical header drags
  stay locked, horizontal gestures remain available, and the transcript still scrolls by touch.
  Desktop WebKit cannot reproduce the real iOS software keyboard or its compositor pan, so these
  tests prove the event policy and published geometry; an iPhone remains the final motion check.
- Playwright also covers one through six panes, explicit/automatic zoom, chromeless mode, browser
  zoom, and theme × density combinations.
- Accessibility tests cover focus rings, separators, and 44px touch targets.

## Out of scope

Custom densities, arbitrary panel widths, floating windows, more than six panes, mobile splits,
and cross-device layout sync are not planned.

## Later

- Decide whether an iPad with a trackpad/keyboard should offer desktop shell selection.

## Decisions

- Choose the shell from primary input capability, never viewport width.
- Use 760px only as the desktop sidebar presentation breakpoint and support desktop down to 360px.
- Centralize browser/Tauri adaptation in `app/src/platform/`; components consume root attributes
  and geometry tokens.
- Use `black-translucent` status-bar style with one themed header owner for the top inset.
- Use 320×240px as the minimum pane box with reversible focused-pane presentation.
- Persist zoom with the pane tree.
- Show narrow-layout status in the workspace bar.
