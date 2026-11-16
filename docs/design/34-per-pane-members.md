# 34 — Per-pane members panel

Status: accepted 2026-11-15 (decisions at the end of this doc). Amends designs 09 and 10
where noted; implements the "Member list per pane" section of `docs/reference/split-view.md`.

## Problem

Luiz, 2026-11-15: "right now it's kind of as if it was a sidebar on the entire app. I think it should
be a sidebar of sorts inside the buffer... the advantage is that we'd be able to support
side-by-side buffers, tiling, etc in the future."

Designs 10 and the split-view addendum already decided (2026-10-28) that each pane owns its member
list and that visibility is remembered per channel. The code took a single-pane shortcut that
cannot grow into that:

- `DesktopShell` renders `MemberPanel` as a sibling of `<main>`, a third app-level column after the
  sidebar and the conversation. It is not inside anything that could be duplicated per pane.
- The panel draws its own 48px "Members N ×" header beside the conversation header, so the
  conversation header spans only the transcript column, not the conversation.
- Open/closed is one unpersisted shell signal (`memberPanelOpen`), defaulting to closed on every
  launch and shared by every channel.
- Inline-vs-drawer is decided from `shellWidth - sidebarWidth`, i.e. from the window, not the pane.
- `drawer: "sidebar" | "members" | null` is shell state, so a members drawer is a window overlay.

Before (built app, local Ergo, 1440×900 and 820×700; review captures, not committed):
`before-light.png`, `before-dark.png`, `before-narrow-light.png`. The narrow capture also shows the
current 320px conversation minimum is too small: with the list inline every message wraps to two to
five lines.

## Structure

A desktop pane is one self-contained box:

```
┌ pane ─────────────────────────────────────────────────────┐
│ header: [☰] #papo  topic…                     [👥 10] […] │  ← spans the whole pane
├────────────────────────────────────────┬──────────────────┤
│ transcript                             │ members (232px)  │
│                                        │ OPERATORS — 2    │
│                                        │ @ mel            │
│ composer                               │ …                │
└────────────────────────────────────────┴──────────────────┘
```

- The **pane header spans the full pane width**, over the members panel. The Members button keeps
  its place at the header's right end; with the panel open it sits right above it.
- The panel's own header row (title, count, ×) is dropped on desktop: the count and pressed state
  are on the header button, which also closes it. The panel keeps its accessible name
  "Members of #papo". The narrow-pane drawer has no header either (decision 2); the mobile drawer
  keeps its header (it needs a visible close).
- The body is a two-column grid: `minmax(0, 1fr) var(--wl-size-members)`. The member column is
  only rendered for a channel with its list shown inline.
- Single pane: the 48px main header (sidebar toggle, title, topic, Members). Multi-pane (later):
  the 38px compact header with the same Members button plus split/close (design 10).

Mockups (static HTML on Lounge/Lounge Night tokens): `after-single-light.png`,
`after-single-dark.png`, `after-split-light.png`, `after-split-dark.png`.

## State

```ts
// navigation/member-visibility.ts
export interface MemberVisibility {
  readonly byChannel: ReadonlyMap<ChannelKey, boolean>;
  readonly lastChoice: boolean;
}
export function membersShown(visibility: MemberVisibility, channel: ChannelKey): boolean;
export function toggleMembers(visibility: MemberVisibility, channel: ChannelKey): MemberVisibility;
```

- **Per channel, as already decided**: `#papo` looks the same in every pane and after switching
  away and back. A channel never toggled follows `lastChoice` (the most recent toggle anywhere).
  `ChannelKey` is the channel's stable `(network, casefolded name)` key, not the session buffer id.
- **Persisted device-locally** with the desktop layout (design 22 UI persistence), so a reload or
  relaunch keeps it. Today it resets to closed on every launch.
- **Width is fixed** at 232px through a new `--wl-size-members` token (the literal `232` is in three
  places today). No drag-resize.
- Presentation is derived, never stored: `inline` when the pane is at least 232 + the minimum
  conversation width, otherwise `drawer`. Pane width comes from a `ResizeObserver` on the pane
  itself, which makes it correct for split panes for free.

## Per conversation type

| Pane shows | Members button | Panel |
|---|---|---|
| Channel | shown, with count | per channel visibility |
| DM | absent | none; the conversation takes the full width |
| Server buffer | absent | none (brief §5.2) |
| Empty pane | absent | none |

Switching a pane from a channel to a DM removes the column and returns its width at once; switching
back to the channel restores it from that channel's visibility. Visibility is never changed by
switching buffers.

## Narrow panes

- Inline needs `232px + 480px` of pane (amends design 09's 320px conversation minimum; see the
  narrow "before" capture). The sidebar breakpoint (760px) is unchanged.
- Below that, the same button and shortcut open the list as an `OverlayDrawer` anchored to **this
  pane's** right edge, below the pane header, with an invisible scrim covering only this pane's
  body (decisions 2 and 7).
- The drawer is transient: it never changes the channel's persisted visibility, except that closing
  an inline list (button, shortcut) does. Growing past the threshold closes the drawer and shows the
  inline list if the channel's visibility is on; shrinking hides the inline list without changing
  it. Neither remounts the conversation, transcript or composer (design 09).
- The sidebar drawer stays a shell overlay; the shell-level union becomes `"sidebar" | null` and
  each pane owns its own `membersDrawerOpen`. Only one drawer of any kind is open at a time: opening
  one closes the other.

## Focus and keyboard

- `members.toggle` (⌘. / Ctrl+.) and the header button act on the focused pane (single pane: the
  pane). Unchanged bindings.
- Opening inline does not move focus. Closing inline returns focus to the composer when focus was
  inside the panel or on the button (as today).
- Tab order inside a pane: header → transcript → composer → members list.
- **Escape inside the inline panel** returns focus to that pane's composer and leaves the panel
  open: the inline panel is persistent chrome, not an overlay. Escape in the drawer closes it and
  returns focus to the composer (design 15 table, unchanged).
- Activating a member opens the DM **in the same pane** and focuses its composer; a drawer closes
  first.
- **Typing closes the drawer.** The drawer is not modal (`aria-modal="false"`), so the shell's
  type-to-composer forwarding still applies: a printable key typed in the drawer goes to the
  composer, and any input in the composer slides the drawer closed (it covers the composer's right
  edge and Send). Arrows, Home/End, Tab, Enter and Escape behave as before; the desktop list
  has no filter field or type-ahead, so letters have no list meaning to lose. Forwarding is blocked
  by any `aria-modal="true"` dialog (settings, switcher, image viewer, confirmations).
- Pointer-down in the panel focuses its pane (split view rule).

## Motion

Matches design 15's rules:

- Inline open/close is **instant** (no width slide: animating the column would reflow the
  virtualised transcript every frame), and the desktop list content does not fade in. The phone
  drawer keeps its content fade.
- The drawer uses `--wl-motion-drawer-open` / `--wl-motion-drawer-close` and
  `--wl-motion-drawer-curve`, the shared `OverlayDrawer` primitive, unchanged.
- Reduced motion zeroes both through the existing tokens.

## Split view implications

- Every channel pane renders its own panel and drawer; two channels' lists can be visible at once.
- Each panel is its own member-window view. The view id already keys on the pane id
  (`${scope}:desktop:${paneId}`), so the engine needs nothing new; per-view windows exist (PLAN 4c).
- Move, swap and zoom carry the panel with the pane, because it is inside the pane.
- The same channel in two panes: both show or hide together (per-channel visibility). Accepted
  consequence of the 2026-10-28 decision.
- At six narrow panes most lists become drawers; that is the designed degradation.

## What moves in code

- New `shells/desktop/DesktopPane.tsx` (+ `.module.css`): the header, the conversation body
  (banner, `MessageList`, notices, `Composer`), the inline `MemberPanel`, and the pane's members
  `OverlayDrawer`. Props: the pane's buffer, its network, member window, visibility and callbacks.
  It is the unit the split-view `PaneTree` will render per leaf.
- `DesktopShell.tsx` keeps the sidebar, sidebar drawer, settings, switcher, the action registry and
  routes `members.toggle` to the focused pane. It loses `memberPanelOpen`, `membersInline`,
  `membersVisible`, the members drawer and the third column. `data-chromeless` stops considering
  the member list (chromeless is about the sidebar now that the list is inside the pane).
- New `navigation/member-visibility.ts` (pure, unit-tested) plus its persistence next to the
  desktop layout.
- `MemberPanel`: a `header` prop (`"titled" | "none"`); desktop passes `"none"`, mobile keeps
  `"titled"`. `MemberPanel.module.css` loses the `flex: 0 0 232px` sizing (the grid sizes it) and the
  border moves to the pane grid.
- `ConversationHeader`: unchanged API; it now spans the pane because of where it is rendered.
- Tokens: `--wl-size-members: 232px`; `--wl-size-members-min-conversation: 480px`.
- `MobileMemberDrawer` and `MobileChannelDetails`: unchanged.

## Out of scope

- The split-view tree, compact pane headers, split/close/move commands and drag and drop (design 09
  and 10 work; this doc only makes the pane self-contained).
- Resizable member column, a member filter on desktop, member search.
- Any change to the phone members drawer.
- Any engine or papo change.

## Testing

- Unit: `member-visibility` (per-channel toggle, `lastChoice` default for unseen channels, decode of
  invalid or future persisted data, casefold keys); the inline-or-drawer presentation function at
  the threshold boundaries.
- Component: `DesktopPane` renders no members column for DM, server and empty panes; channel panes
  follow visibility; Escape in the panel focuses the composer.
- Playwright, local Ergo (extend `member-panel.spec.ts`, keep its ops/voice/bot groups and DM open):
  - geometry: the header's left and right edges equal the pane's; the panel's top equals the
    header's bottom; panel 232px; transcript + panel fill the pane;
  - toggle by button and Ctrl+.; the choice survives reload; `#a` shown and `#b` hidden stay so
    when switching between them; a never-toggled channel follows the last choice;
  - DM and server buffer: no button, no column, full-width transcript;
  - narrow window: the drawer opens from the pane's edge below its header; the header button,
    Escape and scrim close it, focus returns to the composer, resizing across the threshold keeps the composer draft and element identity;
  - committed light/dark screenshots of the open panel (also fixes stale T8 member-panel captures).
- Every touched journey keeps `nativeFeelAudit` and its idle/hidden checks green; screenshots are
  compared with the mockups above before merge.

## Decisions (Luiz, 2026-11-15)

1. The pane header spans the whole pane, over the members panel. Yes.
2. The inline panel drops its own "Members N ×" header row on desktop. Yes. **Changed:** the
   narrow-pane drawer drops it too and looks like the inline list: no title or ×, no shadow, the
   same background and 1px left divider. It starts below the pane header (its top is the header's
   bottom, as the inline column's is), so the header's Members button stays visible, shows its
   pressed state and closes the drawer with the same slide as Escape. Escape and a click elsewhere
   in the pane body still close it; the header stays live, so the drawer is not modal. It keeps the
   accessible name "Members". The phone drawers keep their header and shadow.
3. Visibility is per channel; a never-toggled channel follows the last choice. Yes.
4. Visibility persists across reloads and launches. Yes.
5. Fixed 232px, no resize. Yes.
6. The conversation keeps at least 480px beside an inline list; below that the list is a drawer.
   Yes.
7. **Changed:** the desktop narrow-pane drawer has no dimmed backdrop at all; dimming stays
   phone-only. It keeps its slide, Escape closes it, and a click elsewhere in its pane still closes
   it through an invisible scrim. The desktop sidebar drawer and the phone drawers are unchanged.
8. **Changed:** no fade at all. Inline open/close is instant and the desktop list content no longer
   fades in; the phone drawer is unchanged.
9. Escape inside the inline list focuses the composer and leaves the list open. Yes.
10. Activating a member opens the DM in the same pane. Yes.
11. The same channel in two panes shares its open/closed state. Accepted.
12. Ship now as a single-pane refactor ahead of split view. Yes.
