# 09 — Density and layout system

Status: revised for milestone 1 review.

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

A `ResizeObserver` on the app container selects mobile for widths below 760px and desktop at 760px
or wider. Selection never uses the user agent. Both shells retain independent local navigation
state, so crossing the boundary neither converts nor discards the desktop pane tree.

Milestone 1 uses the exact breakpoint with no resize hysteresis.

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

## Frame and responsive presentation

One pane has the prototype's 48px main header. Multi-pane mode has 38px pane headers plus the 38px
workspace bar defined by subsystem 10. Dividers expose a 7px hit target around a 1px gap. Sidebar,
member-panel, and chromeless presentation are inputs from navigation/settings rather than fields in
the pane tree; member-panel preference and following state live only in subsystem 10.

Each pane's minimum rendered box is 320×240px. If the tree cannot meet that minimum, only the
focused pane is rendered without mutating the tree or persisted zoom flag. The workspace bar shows
the status “Layout hidden at this window size.” Growing the window restores the tree. Explicit
zoom wins over this automatic presentation.

With one pane and both side panels hidden, conversation content is centred at about 880px. With
multiple panes, the tree fills the main area. Headers remain because they contain structural pane
controls.

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

Mobile never renders or mutates the pane tree. The shell exports logical variables from
`env(safe-area-inset-*)`, consumes each inset once, and clears the software keyboard through the
Visual Viewport/Tauri keyboard adapter. It never ships prototype hard-coded safe-area values.

## Boundaries

This subsystem owns density measurements, breakpoint selection, pane-tree validation/reduction,
geometry/directional queries, responsive presentation, and layout persistence. It does not own
buffer content, member-panel state, read markers, navigation actions, command bindings, themes, or
virtual-list behavior.

## Testing

- Schema tests verify every Appendix B value and default.
- Property tests cover tree decode and mutation invariants, including close focus and six-pane
  degradation.
- Geometry tests cover nested splits, directional focus, nearest-divider selection, RTL, ratio
  clamping, and the 320×240 automatic presentation boundary.
- Persistence tests cover corruption, missing buffers, zoom restoration, migrations, and resize
  write coalescing.
- Playwright covers the 760px shell switch, one through six panes, explicit/automatic zoom,
  chromeless mode, safe areas, browser zoom, and theme × density combinations.
- Accessibility tests cover focus rings, separators, and 44px touch targets.

## Out of scope

Custom densities, arbitrary panel widths, floating windows, more than six panes, mobile splits,
and cross-device layout sync are not planned.

## Later

- Add resize hysteresis only if measured browser/keyboard oscillation occurs.

## Decisions

- Use 760px as the exact mobile/desktop shell boundary.
- Use 320×240px as the minimum pane box with reversible focused-pane presentation.
- Persist zoom with the pane tree.
- Show narrow-layout status in the workspace bar.
