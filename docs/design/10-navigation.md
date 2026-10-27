# 10 — Navigation

Status: revised for milestone 1 review.

## Problem

Desktop uses a persistent tiling workspace; mobile uses tabs with pushed screens. They share
buffers and overlays without sharing navigation history. Every pointer operation must also be
available through typed command IDs and accessible controls.

Subsystem 09 owns the pane reducer and geometry. Subsystem 14 will own command definitions,
shortcut chords, conflict resolution, and the keymap; this document references command IDs only.

## Shared destinations and overlays

```ts
export type Destination =
  | { readonly kind: "buffer"; readonly bufferId: BufferId; readonly eventId?: EventId }
  | { readonly kind: "network"; readonly networkId: NetworkId }
  | { readonly kind: "settings"; readonly page: SettingsPage }
  | { readonly kind: "onboarding"; readonly preset?: PresetId }
  | { readonly kind: "activity"; readonly itemId?: ActivityItemId };

export type Overlay =
  | { readonly kind: "switcher"; readonly query: string }
  | { readonly kind: "settingsModal"; readonly page: SettingsPage }
  | { readonly kind: "membersDrawer" }
  | { readonly kind: "confirmation"; readonly action: DestructiveAction };
```

A typed parser produces a destination or recoverable invalid-link result. Missing objects show a
nonblocking notice and a safe root. Overlays form a strict stack; dismissing the top layer restores
focus to its invoker before shell navigation changes.

## Desktop state and chrome

```ts
export interface DesktopNavigation {
  readonly panes: PaneLayout;
  readonly memberPanelOpen: boolean;
  readonly overlays: readonly Overlay[];
  readonly paneUi: ReadonlyMap<PaneId, PaneUiState>;
}
```

The member panel stores only the user's open preference. Its following pane and buffer are derived
from the focused leaf and that buffer's action projection; no second `{paneId, bufferId}` pair can
drift. Per-pane scroll/focus state keys on stable `PaneId`; drafts key on `(PaneId, BufferId)` in
the composer subsystem.

Pointer-down or focus entering a pane dispatches `pane.focus`; hover does not. With multiple panes,
the focused pane has the 2px accent top border and focused header surface.

- One pane uses Main's full 48px header with global controls. Structural pane actions are in its
  overflow menu and command registry.
- Multiple panes use 38px compact headers plus one 38px workspace bar for sidebar, search,
  switcher, layout status, and summary.
- The workspace bar remains when the sidebar is hidden. Single-pane chromeless content centres;
  multi-pane tiling fills the available main area.

All one-line titles, topics, and status text use the reusable ellipsizing `Line` primitive.

## Desktop actions

Sidebar click shows a buffer in the focused pane. The platform's modified-click gesture dispatches
`pane.open-buffer-right`. At six panes it degrades to show-here. Clicking a network header shows
its server buffer, which has no members action.

Directional focus and global resize use subsystem 09's `paneInDirection` and `nearestDivider`
queries. With zoom active, directional focus changes which focused pane is rendered. Closing and
focus outcomes are entirely the pane reducer's deterministic rules.

| User operation | Command ID |
|---|---|
| Enter the transient pane-command mode | `pane.mode` |
| Focus pane after focus/pointer entry | `pane.focus` |
| Show selected buffer | `pane.show-buffer` |
| Open buffer beside focused pane | `pane.open-buffer-right` |
| Split focused pane | `pane.split-right`, `pane.split-down` |
| Focus spatial neighbour | `pane.focus-left`, `pane.focus-right`, `pane.focus-up`, `pane.focus-down` |
| Move pane | `pane.move-left`, `pane.move-right`, `pane.move-up`, `pane.move-down` |
| Toggle focused-pane zoom | `pane.toggle-zoom` |
| Close focused pane | `pane.close` |
| Grow or shrink at nearest divider | `pane.grow`, `pane.shrink` |
| Adjust a focused divider | `separator.decrease`, `separator.increase` |
| Toggle sidebar | `sidebar.toggle` |
| Toggle shared member panel | `members.toggle` |
| Join channel or start DM | `buffer.open` |
| Show a network's server buffer | `network.open-server` |

Global navigation uses the same registry IDs everywhere:

| User operation | Command ID |
|---|---|
| Open switcher, shortcut help, search, or settings | `switcher.open`, `shortcuts.open`, `search.open`, `settings.open` |
| Dismiss/cancel/focus composer | `navigation.escape` |
| Traverse buffer-view history | `navigation.back`, `navigation.forward` |
| Move through buffers | `buffer.previous`, `buffer.next` |
| Move through unread buffers | `buffer.previous-unread`, `buffer.next-unread` |
| Jump by unread priority or sidebar slot | `buffer.jump-important`, `buffer.jump-1` … `buffer.jump-9` |
| Mark the current buffer or all buffers read | `buffer.mark-read`, `buffer.mark-all-read` |
| Request the preceding history page | `buffer.load-older` |

Subsystem 14 assigns bindings, owns the `pane.mode` scope, and exposes the same commands through
the switcher, help, menus, and slash-command views. Availability comes from the focused buffer's
subsystem-17 actions and current layout, not ad hoc capability checks in navigation.

## Drag, drop, and accessible placement

```ts
export type DragPayload =
  | { readonly kind: "buffer"; readonly bufferId: BufferId }
  | { readonly kind: "pane"; readonly paneId: PaneId };

export type DropZone = "center" | "left" | "right" | "top" | "bottom";
```

Within 25% of an edge selects that edge; otherwise the zone is centre. Deterministic corner ties
prefer horizontal. Zoom and the six-pane cap collapse edge zones to centre.

Dropping a buffer shows or splits. Dropping a pane swaps at centre or removes/reinserts it at an
edge while preserving its ID. Self-drop is a no-op. The preview labels the operation.

Native drag events are only adapters over `DragPayload + DropTarget`. Command-registry placement
actions and an adjacent “Place…” dialog expose explicit target pane and position choices for
keyboard and screen-reader users. Live-region announcements report target, operation, and pane-cap
degradation. This document does not assign keys to those commands.

## Sidebar badges and read visibility

An open-in-pane indicator may reflect any leaf retained in the saved tree. Badge suppression is
stricter: unread and mention badges are suppressed only when the buffer appears in a currently
rendered, visible pane. A leaf hidden by explicit zoom or automatic narrow-window presentation does
not suppress badges.

A read marker advances only when at least one instance is rendered, the document/window is
foreground and focused, and that instance is at its live-edge sentinel for 500ms. The coordinator
sends `MarkRead` through the latest fully committed visible event. Pending sends do not count. For
duplicate panes, any qualifying instance is sufficient. Without read sync, the same rule advances
only the local read position.

Opening or focusing alone never marks read. Hiding/zooming the pane, leaving the live edge, or
losing window focus cancels the dwell. Thus a mention in a zoom-hidden pane both badges and remains
unread.

## Shared member panel

Opening from a pane focuses that pane and sets `memberPanelOpen`. While open, contents derive from
the focused channel and cross-fade for 200ms; reduced motion swaps immediately. Empty, DM, and
server panes hide the effective panel without clearing the preference, so focusing a channel
restores it. Closing the panel clears the preference.

The chip reads “Following #channel”. There is exactly one 232px panel and it never follows a
hidden, nonfocused duplicate.

## Mobile navigation

```ts
export type MobileTab = "chats" | "activity" | "settings";

export interface MobileNavigation {
  readonly selectedTab: MobileTab;
  readonly stacks: Readonly<Record<MobileTab, readonly MobileScreen[]>>;
  readonly overlays: readonly Overlay[];
  readonly transition: MobileTransition | null;
}
```

Each tab has its own nonempty stack. Switching tabs preserves stacks. Reselecting the current tab
pops to root; reselecting again scrolls the root list to top. A chat opened from Activity remains
on Activity's stack, so Back restores its exact state. Settings permits root → section and Networks
→ Server messages, but no deeper route.

Back processing dismisses the top overlay, then pops a screen, then yields to the platform. Android
back, header controls, browser history, and the swipe gesture dispatch the same action. Browser
history stores opaque route IDs rather than state snapshots.

Hardware-keyboard and accessible controls dispatch `mobile.tab-chats`, `mobile.tab-activity`, and
`mobile.tab-settings`. Mobile Back dispatches `navigation.back`; overlay dismissal still uses
`navigation.escape`. Activity's control dispatches `activity.mark-all-read`. Subsystem 14 owns
their bindings and resolves the shared command IDs against the mobile scope.

Forward push is 280ms and pop is 230ms using the brief's transform/opacity motion. Reduced motion
commits immediately. Swipe-back begins at the logical leading edge and yields to selection or a
horizontal child scroller. Only the active screen and one transition neighbour remain mounted.

## Deep links

Desktop buffer links show in the focused pane unless the invoking action explicitly requests a
split. Mobile links push on the invoking tab, with external buffer links selecting Chats. Network
links open the server buffer on desktop and Networks settings on mobile. Settings and onboarding
use modal desktop presentation and stack mobile presentation.

## Boundaries

This subsystem owns shell navigation, desktop focus/action semantics, placement adapters,
member-panel preference/following, mobile stacks, transitions/back, deep-link interpretation, and
focus restoration. It does not own pane validation, engine state, message scrolling, drafts,
capability inference, command definitions, or shortcut chords.

## Testing

- Reducer tests cover desktop actions, tab stacks, back priority, deep links, and focus restoration.
- Geometry fixtures cover directional focus and nearest-divider use on uneven nested panes.
- Playwright covers click/modified-click, five drop zones, move/swap/self-drop, pane-cap
  degradation, zoom, close-last, server/empty panes, and member following.
- Command-only accessibility tests perform every pointer operation through registry IDs and the
  placement dialog.
- Visibility tests cover rendered versus zoom-hidden badges, 500ms dwell, duplicate panes, history
  scroll, blur, and automatic narrow presentation.
- Mobile tests cover per-tab stacks, Activity return, settings depth, platform back, swipe,
  reduced motion, and bounded mounted screens.

## Out of scope

Context menus, search UI, threads, detached windows, mobile splits, cross-window drag, and
cross-device navigation sync are later work.

## Decisions

- Use one 38px workspace bar in multi-pane mode.
- Suppress badges only for buffers in rendered, visible panes.
- Wait 500ms at the focused live edge before marking read.
- Reselecting a mobile tab pops to root, then a second reselection scrolls to top.
