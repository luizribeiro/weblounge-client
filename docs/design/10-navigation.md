# 10 — Navigation

Status: proposed for milestone 1 review.

## Problem

Desktop navigation is a persistent tiling workspace; mobile navigation is a tab bar with native-
feeling pushed screens. They share buffers and overlays but must not force one shell's history into
the other's model. Every pointer interaction—including split-view drag/drop and resize—needs a
keyboard and screen-reader equivalent.

This design consumes the pane tree and geometry rules from subsystem 09. It defines user actions,
focus, routes, and presentation; it does not duplicate the tree reducer.

## Shared destinations

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
  | { readonly kind: "membersDrawer"; readonly bufferId: ChannelBufferId }
  | { readonly kind: "confirmation"; readonly action: DestructiveAction };
```

A typed deep-link parser produces `Destination` or a recoverable `InvalidDeepLink`; route strings
never reach feature components. Desktop and mobile each interpret the same destination according
to their navigation model. A missing network/buffer produces a nonblocking notice and a safe root,
never an empty application.

Overlays form a strict stack above the active shell. Escape/back closes the top dismissible overlay
before changing shell navigation. Opening the switcher while settings is open replaces neither;
the switcher sits above and returns focus to the invoking settings control when dismissed.

## Desktop navigation state

```ts
export interface DesktopNavigation {
  readonly panes: PaneLayout;
  readonly memberPanel: MemberPanelState;
  readonly overlays: readonly Overlay[];
  readonly paneUi: ReadonlyMap<PaneId, PaneUiState>;
}

export type MemberPanelState =
  | { readonly kind: "closed" }
  | { readonly kind: "following"; readonly paneId: PaneId; readonly bufferId: ChannelBufferId };

export interface PaneUiState {
  readonly scroll: ScrollAnchor;
  readonly composerFocus: boolean;
  readonly draftKey: DraftKey;
}
```

Exactly one pane is focused, as guaranteed by `PaneLayout`. Pointer-down within a pane, focus
entering any of its controls/content, or an explicit command focuses it. Focus does not move merely
because the pointer hovers. A 2px accent top border identifies focus only with two or more panes;
focused headers use `surface`, others `panelAlt`.

`PaneUiState` is keyed by stable `PaneId`, so it follows a moved pane. Draft text itself is keyed by
`(PaneId, BufferId)` and owned by the composer subsystem; swapping buffers does not accidentally
send one buffer's draft to another.

## One-pane and multi-pane chrome

The open header question is resolved as follows:

- One pane uses Main's full 48px conversation header: sidebar toggle, title, ellipsized topic,
  search, switcher, and member toggle. Split right/down live in an overflow menu and the command
  registry so the one-pane case remains visually identical to Main.
- Two or more panes use the required 38px compact header in every pane: title, topic, Members with
  count, split right, split down, maximize/restore, and close.
- Multi-pane global actions live in one 38px workspace bar above the tiling surface: sidebar
  toggle, search, switcher, and a pane summary. It is not duplicated per pane. In Tauri its empty
  region may be a window drag region; controls and selectable text never are.
- The workspace bar remains when the sidebar is hidden, so chromeless split view never strands the
  sidebar toggle or global search. One-pane chromeless mode keeps the full header and centres the
  conversation column as specified in subsystem 09.

Every single-line title, topic, status, and pane summary uses the reusable `Line` primitive and
ellipsizes structurally.

## Desktop actions

```ts
export type DesktopAction =
  | { readonly kind: "showHere"; readonly paneId: PaneId; readonly bufferId: BufferId }
  | { readonly kind: "openBeside"; readonly paneId: PaneId; readonly bufferId: BufferId }
  | { readonly kind: "split"; readonly paneId: PaneId; readonly edge: Edge; readonly bufferId?: BufferId }
  | { readonly kind: "close"; readonly paneId: PaneId }
  | { readonly kind: "focus"; readonly paneId: PaneId }
  | { readonly kind: "focusDirection"; readonly direction: Direction }
  | { readonly kind: "move"; readonly paneId: PaneId; readonly target: PaneId; readonly edge: Edge }
  | { readonly kind: "swap"; readonly first: PaneId; readonly second: PaneId }
  | { readonly kind: "maximize"; readonly paneId: PaneId }
  | { readonly kind: "restoreLayout" }
  | { readonly kind: "resize"; readonly splitId: SplitId; readonly delta: RatioDelta }
  | { readonly kind: "toggleMembers"; readonly paneId: PaneId };
```

Clicking a sidebar buffer dispatches `showHere` to the focused pane. Option-click on macOS and
Alt-click elsewhere (Command-click is also accepted where the platform reserves Option) dispatches
`openBeside` on the right. At six panes this degrades to `showHere`. Sidebar rows visible in any
rendered or hidden tree leaf show the open-in-pane indicator; their unread/mention badges are
visually suppressed. Only the focused buffer row has `aria-current="page"`.

Clicking a network header shows its server buffer in the focused pane. Server buffers are valid
pane contents and use the server-log renderer/command composer. They cannot supply a member panel.

Directional focus uses rendered pane rectangles: eligible panes in the requested half-plane are
ranked first by primary-axis distance, then overlapping secondary span, then stable tree order.
This feels spatial even for nested trees. Under explicit/automatic maximize, focus-direction picks
another tree leaf and makes it the presented pane without discarding zoom.

Closing a leaf promotes its sibling. Closing the final leaf creates and focuses one empty pane with
“Drop a channel here, or pick one from the sidebar.” Splitting or moving clears explicit maximize;
swapping and showing do not. Header double-click toggles maximize/restore.

## Pointer drag and drop

```ts
export type DragPayload =
  | { readonly kind: "buffer"; readonly bufferId: BufferId }
  | { readonly kind: "pane"; readonly paneId: PaneId };

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export interface DropTarget {
  readonly paneId: PaneId;
  readonly zone: DropZone;
}
```

Sidebar rows drag buffers; pane headers drag pane identities. Pointer position within 25% of the
nearest edge selects that edge; otherwise it selects centre. Ties resolve horizontal before
vertical for deterministic corners. When explicitly or automatically focused/maximized, every
zone is centre. At six panes, edge zones render and act as centre.

The preview is a translucent accent overlay labelled Split left/right/up/down, Show here, or Swap.
Dropping a buffer centre shows it; an edge splits. Dropping a pane centre swaps buffers (including
empty); an edge removes and reinserts the pane with its ID. Self-drop is a no-op. A move targets
the tree after source removal; attempts to target a descendant invalidated by removal are rejected
before mutation.

Native HTML drag events are an input adapter only. The model is `DragPayload + DropTarget`, which
is shared by pointer, keyboard, screen-reader action menus, and tests. Browser-default image/link
dragging remains disabled on app chrome.

## Keyboard and screen-reader parity

Every action is registered once in the command/shortcut registry. Defaults avoid browser close-tab
shortcuts; commands without a safe universal chord remain fully available through the switcher.

| Pointer action | Command | Default keyboard path |
|---|---|---|
| Click sidebar row | `pane.show-buffer` | Focus row, Enter |
| Option/Alt-click row | `pane.open-buffer-right` | Ctrl/Command+Enter |
| Focus pane | `pane.focus` | Focus any pane control; or `pane.focus-{direction}` |
| Split right/down | `pane.split-right/down` | Ctrl/Command+\\; Ctrl/Command+Shift+\\ |
| Maximize/restore | `pane.toggle-maximize` | Ctrl/Command+Shift+M |
| Close pane | `pane.close` | switcher command (no browser-conflicting default) |
| Move pane to edge | `pane.move-{direction}` | switcher or keyboard drag mode |
| Swap pane buffers | `pane.swap-with…` | switcher target picker |
| Resize divider | `pane.resize-*` | separator arrows; Shift = 5%; Home/End; 0 reset |
| Members button | `members.toggle` | Ctrl/Command+Shift+U |

Space on a focused draggable row/header enters keyboard drag mode. Arrow keys choose a target pane
spatially; a second arrow selects its matching edge, `C` selects centre, Enter drops, and Escape
cancels. The current target and operation are announced through a polite live region. At the pane
cap, announcements say “Show here; pane limit reached.”

Every draggable also exposes an adjacent accessible “Place…” action. It opens a small dialog with
explicit target pane labels and Show/left/right/up/down choices. This is the primary screen-reader
path and does not depend on understanding drag metaphors. Pane headings include ordinal and title,
for example “Pane 2 of 3, #papo, focused.”

## Shared member panel

There is one 232px desktop member panel. Opening Members first focuses the invoking pane and then
sets `following` to that pane. Thereafter it follows focus automatically when the focused pane
contains a channel. Its chip reads “Following #channel”; content cross-fades for 200ms using only
opacity. Reduced motion replaces content immediately.

An empty, DM, or server pane closes the effective panel but retains the user's open preference.
Focusing a channel restores it. The close button changes the preference to closed; any channel
pane's Members button reopens it. The panel never follows a hidden nonfocused duplicate buffer.

## Read visibility in split view

“Visible in a pane” and “read” are deliberately separate:

- Sidebar badges are suppressed when the buffer occurs anywhere in the saved pane tree, matching
  the prototype, even if a zoom currently hides that leaf.
- A marker may advance only when at least one rendered instance is visible (not hidden by explicit
  or automatic focus), the document/window is foreground and focused, and that instance's message
  list is at the live-edge sentinel.
- All conditions must remain true for 500ms. The coordinator then sends `MarkRead` through the
  latest fully committed event visible at the live edge. It never marks a merely pending send.
- If duplicate panes show the same buffer, any qualifying instance is sufficient; an instance
  scrolled into history does not block another instance at the live edge.
- Without `draft/read-marker`, the same rule advances only the explicitly local fallback marker.

Opening or focusing a pane alone never marks its buffer read. Overlay focus does not invalidate the
window-focus condition, but switching applications, hiding the page, automatic/explicit zooming a
pane away, or leaving the live edge cancels the dwell timer.

## Mobile navigation state

```ts
export type MobileTab = "chats" | "activity" | "settings";

export interface MobileNavigation {
  readonly selectedTab: MobileTab;
  readonly stacks: Readonly<Record<MobileTab, readonly MobileScreen[]>>;
  readonly overlays: readonly Overlay[];
  readonly transition: MobileTransition | null;
}

export type MobileScreen =
  | { readonly kind: "tabRoot"; readonly tab: MobileTab }
  | { readonly kind: "chat"; readonly bufferId: BufferId; readonly eventId?: EventId }
  | { readonly kind: "appearanceSettings" }
  | { readonly kind: "networkSettings" }
  | { readonly kind: "notificationSettings" }
  | { readonly kind: "serverMessages"; readonly networkId: NetworkId }
  | { readonly kind: "onboarding"; readonly route: OnboardingRoute };
```

Each tab has its own nonempty stack rooted in its tab. Selecting another tab preserves the prior
stack. Reselecting the active tab pops it to root; a second reselection scrolls the root list to
top. A chat opened from Activity is pushed on Activity's stack, so Back returns to the exact
Activity scroll/filter state. A chat opened from Chats behaves likewise. The tab bar is hidden on
pushed chat and onboarding screens and remains visible on pushed settings pages only where the
prototype shows it.

Settings root pushes Appearance, Networks, or Notifications. Server messages may be pushed only
from Networks, making it the single supported second level. Types prevent a third settings level.
Tapping a member in the drawer closes the drawer and pushes/replaces the appropriate DM chat on the
current tab's stack.

Back order is: confirmation/dialog, member drawer, current pushed screen, then platform default
(background/close prompt). Android system back, header Back, browser history integration, and iOS
swipe-back dispatch the same action. Browser history stores opaque route IDs, not entire state.

## Mobile transitions and gestures

Forward push lasts 280ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`: entering screen translates from
100% to 0 while the previous screen shifts to −28% and dims. Pop lasts 230ms and reverses. Only
`transform` and `opacity` animate. Reduced motion commits the route in one frame.

Swipe-back begins only within the logical leading-edge gesture region, tracks one pointer, and is
disabled at a tab root, during text selection, or when a horizontal child scroller owns the
gesture. Velocity/position thresholds either complete or cancel. Focus and browser history commit
only when the gesture completes. The member drawer uses the same gesture arbitration and its own
220ms transform.

Screen DOM is bounded: the active screen and at most one transition neighbour remain mounted.
Scroll/focus state for inactive routes is serialized into lightweight route state, not retained as
hidden full pages.

## Deep links

Desktop buffer links show the destination in the focused pane and optionally scroll to `eventId`;
they do not create a split without an explicit link action. Mobile buffer links select Chats and
push the chat unless invoked from Activity, where they preserve Activity as the return root.
Network links open server buffers on desktop and Networks settings on mobile. Settings/onboarding
links use the shell's native presentation (modal on desktop, stack on mobile).

## Boundaries

This subsystem owns shell navigation state, desktop focus/action semantics, drag/drop adapters,
member-panel following, mobile tab stacks, transitions/back behavior, deep-link interpretation,
and focus restoration. It must not own pane-tree validation, engine buffer state, message scroll
implementation, drafts, command definitions beyond registry IDs, or member data.

## Testing

- Pure reducer tests cover every desktop action, tab/stack transition, back priority, deep link,
  and focus restoration.
- Property tests compare pointer and keyboard drag payloads and assert identical tree outcomes.
- Geometry fixtures test directional focus on nested and uneven panes.
- Playwright covers click/modifier-click, all five zones, move/swap/self-drop, six-pane degradation,
  maximize, close-last, server/empty panes, and member-panel following.
- Keyboard-only and screen-reader tests perform every pointer action, including resize and
  accessible placement dialogs; live-region output is asserted.
- Visibility tests verify the 500ms read dwell, duplicate panes, history scroll, window blur,
  overlays, and zoom-hidden panes.
- Mobile tests cover per-tab stacks, Activity return, settings depth, Android back, interactive
  swipe completion/cancellation, safe areas, reduced motion, and bounded mounted screens.

## Out of scope

Context-menu contents, search UI, threads, detached windows, mobile split view, drag between
windows, and cross-device navigation sync are later work.

## Resolved split-view questions

1. Single pane uses Main's full header; multi-pane uses compact pane headers plus one global
   workspace bar.
2. Chromeless single-pane content centres at ~880px; multi-pane tiling fills the main area and
   keeps structural headers/workspace controls.
3. Minimum pane size is 320×240; insufficient desktop space automatically presents only the
   focused pane without mutating the tree. Below 760px the mobile shell replaces desktop.
4. Server buffers may occupy panes; the shared member panel is unavailable for them.
5. Read markers advance only after a rendered live-edge instance is foreground/focused for 500ms;
   mere presence in the saved tree only suppresses sidebar badges.

## Questions for Luiz

1. Approve the 38px global workspace bar in multi-pane mode; it is the only new chrome required to
   keep global actions reachable when the sidebar is hidden.
2. Is visually suppressing badges for zoom-hidden panes desirable exactly as specified, or should
   suppression track only currently rendered panes even though the addendum says “visible in some
   pane”?
3. Confirm 500ms live-edge dwell before marking read; this is easy to tune without changing types.
4. Should tab reselection pop to root and then scroll to top (proposed), or always preserve the
   current pushed screen?
