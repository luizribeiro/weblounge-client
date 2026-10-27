# 09 — Density and layout system

Status: proposed for milestone 1 review.

## Problem

The app has independent message, desktop-list, and mobile-list density choices; two responsive
shells; optional side panels; safe areas; and a persistent desktop tiling tree of up to six panes.
These concerns need typed data and deterministic geometry rather than scattered media queries and
component constants.

Layout is UI state. The engine owns networks, buffers, and messages; it does not know which shell
is active or where a buffer is displayed.

## Density schema

Density presets are checked platform-neutral JSON data generated into TypeScript, Rust, and CSS
variables alongside themes. They contain measurements, not colours.

```rust
pub enum DensityId { Compact, Cozy, Comfortable }
pub enum MessageLayout { OneLine, Grouped }

pub struct DensitySettings {
    pub message_layout: MessageLayout,
    pub message: DensityId,
    pub desktop_list: DensityId,
    pub mobile_list: DensityId,
}

pub struct DensityDefinition {
    pub id: DensityId,
    pub message: MessageMetrics,
    pub desktop: DesktopListMetrics,
    pub mobile: MobileListMetrics,
}

pub struct MessageMetrics {
    pub avatar_px: u8,
    pub group_top_px: u8,
    pub continuation_top_px: u8,
    pub one_line_block_px: u8,
    pub line_height: UnitIntervalAboveOne,
    pub font_delta_px: i8,
}

pub struct DesktopListMetrics {
    pub sidebar_row_px: u8,
    pub sidebar_font_px: HalfPixel,
    pub member_row_px: u8,
    pub member_avatar_px: u8,
}

pub struct MobileListMetrics {
    pub row_px: u8,
    pub avatar_px: u8,
    pub previews: PreviewPolicy,
}

pub enum PreviewPolicy { Hidden, TwoLines }
```

Initial values are exactly Appendix B of the brief. Defaults are cozy messages, compact desktop
lists, and cozy mobile lists. The three choices remain independent; choosing compact messages
does not silently compact either navigation list.

Generated variables use `--wl-density-*`. Components may consume variables but may not branch on
the preset ID. The only semantic exception is mobile `PreviewPolicy`, which selects a typed row
variant so compact mode removes previews from layout and accessibility output rather than merely
hiding text with CSS.

Font sizes derive from the active theme base plus the density delta. Values clamp to an accessible
minimum and still scale with browser zoom/Dynamic Type; density never disables user text scaling.
All interactive targets retain at least 44 CSS px on touch even when their visual row is smaller.

## Shell selection and width policy

The shell is selected from the app container, not user agent or outer viewport:

```ts
export type ShellMode =
  | { readonly kind: "mobile"; readonly width: CssPixels }
  | { readonly kind: "desktop"; readonly width: CssPixels };

export const MOBILE_MAX = 759;
```

A single `ResizeObserver` on the app root publishes a width bucket. Widths `0..759px` render the
mobile stack-plus-tabs shell; `760px` and wider render desktop. A 16px hysteresis applies only when
crossing back and forth during live resize (`< 752` enters mobile, `>= 768` returns desktop), while
initial selection uses 760px. This prevents keyboard/scrollbar oscillation without changing the
documented breakpoint.

Both shells read shared engine state. Each retains its own local navigation state. Switching to
mobile does not serialize desktop panes into a stack and does not mutate or discard the desktop
tree. Switching back restores it.

## Desktop frame

```rust
pub struct DesktopFrame {
    pub sidebar: PanelVisibility,
    pub members: PanelVisibility,
    pub panes: PaneLayout,
}

pub enum PanelVisibility { Shown, Hidden }

pub struct FrameMetrics {
    pub sidebar_width: CssPixels,   // 256
    pub member_width: CssPixels,    // 232
    pub pane_header_height: CssPixels, // 38
    pub divider_hit_width: CssPixels,  // 7
    pub divider_gap: CssPixels,     // 1
    pub centered_chat_max: CssPixels,  // 880
}
```

Panel visibility is an explicit user preference. At narrower desktop widths the sidebar may be
temporarily presented as an overlay drawer, but the stored preference does not flip. The shared
member panel consumes 232px only when its focused buffer supports members; otherwise it is absent.

Chromeless mode means both side panels are hidden:

- with one pane, its conversation content column is centered and capped at approximately 880px;
- with two or more panes, the tiling surface fills the available main area and each pane manages
  its own readable message measure; centering the whole tree would waste space and distort ratios;
- pane headers remain because focus, close, split, and restore controls are structural chrome;
- Tauri window drag regions remain available in the global titlebar, not over selectable content.

## Pane layout tree

```rust
pub const MAX_PANES: usize = 6;

pub struct PaneLayout {
    pub root: PaneNode,
    pub focused: PaneId,
    pub maximized: Option<PaneId>,
}

pub enum PaneNode {
    Leaf(PaneLeaf),
    Split(PaneSplit),
}

pub struct PaneLeaf {
    pub id: PaneId,
    pub buffer: Option<BufferId>,
}

pub struct PaneSplit {
    pub id: SplitId,
    pub axis: SplitAxis,
    pub ratio: SplitRatio,
    pub first: Box<PaneNode>,
    pub second: Box<PaneNode>,
}

pub enum SplitAxis { Row, Column }

pub struct SplitRatio(f32); // constructor accepts only 0.15..=0.85
```

`Row` places children side by side; `Column` stacks them. The root always exists. Closing the last
leaf replaces it with a new empty leaf, so an empty desktop is still a valid one-pane layout. The
same `BufferId` may occur in multiple leaves.

`PaneId` and `SplitId` are random stable IDs. Moving a leaf preserves its `PaneId`, causing scroll
anchor, composer draft focus, and other per-pane ephemeral state to follow it. Removing a split
promotes the remaining sibling; split IDs need not survive that structural removal.

The validated constructor/decoder enforces:

- one through six leaves;
- globally unique pane and split IDs;
- `focused` names exactly one leaf;
- `maximized`, when present, names exactly one leaf;
- every ratio is finite and within `0.15..=0.85`;
- no empty split and no cycles (the serialized representation is a tree);
- every referenced buffer either exists or is converted to an empty leaf during reconciliation.

Invalid persisted data is never partially repaired into an ambiguous tree. Decode returns a
typed error, diagnostics retains the reason, and the shell falls back to one leaf containing the
last valid buffer if it still exists, otherwise one empty leaf.

## Tree operations

```rust
pub enum Edge { Left, Right, Top, Bottom }

pub enum PaneMutation {
    Show { pane: PaneId, buffer: Option<BufferId> },
    Split { pane: PaneId, edge: Edge, buffer: Option<BufferId> },
    Close { pane: PaneId },
    SwapBuffers { first: PaneId, second: PaneId },
    Move { pane: PaneId, target: PaneId, edge: Edge },
    Focus { pane: PaneId },
    Maximize { pane: PaneId },
    Restore,
    Resize { split: SplitId, ratio: SplitRatio },
    ResetRatio { split: SplitId },
}

pub enum MutationOutcome {
    Changed(PaneLayout),
    NoChange,
    DegradedToShow(PaneLayout),
}
```

The pure reducer owns structural invariants. At six leaves, every split returns
`DegradedToShow`: the target leaf shows the requested buffer, focus moves to it, and edge drop
zones present as centre before drop. Split and move clear explicit maximization. Swapping changes
only buffers; pane identities and per-pane state remain in place. Closing promotes the sibling and
chooses focus deterministically: the sibling's most recently focused leaf, then its first leaf.

Every resize is clamped through `SplitRatio`; double-click and the reset command produce `0.5`.
Serialization rounds ratios to four decimal places to prevent pointer-noise churn.

## Geometry and minimum pane size

```rust
pub struct PaneRect { pub x: f32, pub y: f32, pub width: f32, pub height: f32 }

pub struct LayoutProjection {
    pub mode: DesktopPanePresentation,
    pub panes: HashMap<PaneId, PaneRect>,
    pub dividers: Vec<DividerRect>,
}

pub enum DesktopPanePresentation {
    Tree,
    ExplicitMaximize { pane: PaneId },
    AutomaticFocus { pane: PaneId, reason: AutoFocusReason },
}

pub enum AutoFocusReason { InsufficientWidth, InsufficientHeight }
```

Tree geometry recursively divides the available content box using each ratio, subtracting the 1px
gap but not the 7px pointer hit area. A pane's minimum rendered box is 320×240 CSS px, including
its header and composer. If any leaf would fall below either minimum, desktop enters
`AutomaticFocus` and renders only the focused pane, exactly like maximize, without changing or
persisting `maximized` or any ratio. An unobtrusive “Layout hidden at this window size” action can
explain and focus another pane through the switcher.

This policy preserves all six panes through window shrink and avoids unusable slivers. Growing the
window until every pane meets the minimum automatically restores the tree. Explicit maximize wins
over automatic focus. The mobile shell always wins over every desktop presentation below the shell
breakpoint.

The 0.15 ratio clamp and 320×240 minimum solve different problems: clamp prevents losing a child
during resize; automatic focus handles nested trees and small windows where no legal ratio can
satisfy physical minimums.

## Divider behavior

Each split creates a 7px hit target centered over the 1px inter-pane gap, with `role="separator"`,
`aria-orientation`, `aria-valuemin="15"`, `aria-valuemax="85"`, and current percent. Pointer drag
uses capture and previews a 1px accent line; only the affected split is recomputed. Pointer-up
commits persistence. Double-click resets to 0.5.

Keyboard arrows adjust one percentage point; Shift+Arrow adjusts five. Home/End set 0.15/0.85 and
`0` resets to 0.5. Direction follows separator orientation and writing direction. These are direct
separator semantics in addition to command-registry resize actions.

## Persistence

```rust
pub struct PersistedDesktopLayoutV1 {
    pub version: Literal<1>,
    pub tree: PersistedPaneNode,
    pub focused: PaneId,
    pub maximized: Option<PaneId>,
    pub sidebar: PanelVisibility,
    pub members: PanelVisibility,
}
```

Layout is device-local UI persistence, separate from engine/storage IRC state and from future
synced settings. Writes occur after discrete mutations and once at pointer-resize end, with a
250ms trailing debounce for keyboard resize. A final best-effort write runs on page hide/Tauri
close. The previous valid record is retained until the new record commits atomically.

At launch, the cached engine buffer index loads before reconciliation. Unknown buffer IDs become
empty leaves without changing pane count or IDs. Later buffer deletion uses the same rule. A newly
available buffer never implicitly fills an empty pane.

Schema versions migrate one step at a time with fixture tests. Newer unknown versions fall back
safely and are not overwritten until the user changes layout, preserving possible downgrade data.

## Mobile frame and safe areas

Mobile never renders or mutates `PaneLayout`. Its frame consists of one tab root, a pushed-screen
stack, optional drawer/sheet layers, and the bottom tab bar. Navigation details are subsystem 10.

The shell exports logical safe-area variables from `env(safe-area-inset-top/right/bottom/left)` and
uses CSS logical properties. The root consumes top/bottom insets exactly once; nested screens use
provided content insets and cannot double-pad. The composer clears the software keyboard through
the Visual Viewport/Tauri keyboard adapter while retaining the home-indicator inset.

Mobile header and tab controls maintain 44px minimum targets. Onboarding's dark header and chat
preview use the same safe-area contract. No prototype hard-coded 62pt/34pt values ship.

## Boundaries

This subsystem owns density data, CSS measurement variables, shell breakpoint selection, desktop
frame geometry, pane tree invariants/reducer, responsive presentation, and local layout
persistence. It must not own buffer content, read markers, drag command semantics, mobile history,
theme colours, virtual-list internals, or engine settings storage.

## Testing

- Schema tests verify Appendix B values, defaults, and generated variables.
- Property tests generate valid trees and arbitrary mutation sequences, asserting one-to-six
  unique leaves, valid focus/maximize references, ratio bounds, and encode/decode identity.
- Geometry tests cover nested row/column trees, every edge insertion, rounding, RTL separators,
  and the 320×240 automatic-focus boundary.
- Persistence tests cover corruption, unknown buffers, atomic replacement, migrations, newer
  versions, and resize write coalescing.
- ResizeObserver component tests cross mobile/desktop hysteresis without losing either shell's
  state.
- Playwright covers one through six panes, explicit/automatic maximize, chromeless behavior,
  browser zoom, Dynamic Type, safe areas, software keyboard, and all theme × density combinations.
- Accessibility tests exercise keyboard separators and confirm touch targets remain 44px.

## Out of scope

User-created density presets, arbitrary panel widths, floating windows, more than six panes,
mobile splits, cross-device layout sync, and per-pane member panels are not planned.

## Questions for Luiz

1. Approve 760px as the shell boundary, with 16px live-resize hysteresis.
2. Approve 320×240px as the minimum pane box and reversible automatic focus when any nested pane
   would be smaller; the performance/visual harness will validate it.
3. Should explicit maximization persist across relaunch (proposed), or should launch always restore
   the full tree?
4. In narrow desktop presentation, should the hidden-layout explanation be a persistent small
   banner or only a switcher/status entry?
