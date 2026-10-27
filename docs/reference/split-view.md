# Desktop split view (addendum to the brief)

The brief (§5.2) describes the desktop/web app with **one** conversation in the main area. The prototype's "Desktop — split view" board (`prototype/SplitView.dc.html`) extends this: the main area is a **tiling layout of panes**, each showing one buffer. **This is a requirement, not an exploration:** the desktop shell must support it. One pane is just the degenerate case, and must look and behave like the single-conversation layout in `prototype/Main.dc.html`.

Port the behaviour below, not the prototype's code.

## Model

- The layout is a **binary tree**. A leaf is a pane showing one buffer (or nothing: an *empty pane*). A split has a direction (`row` = side by side, `col` = stacked), two children and a ratio.
- Leaves have stable ids (they survive moves), so per-pane UI state (scroll position, composer draft focus) follows the pane.
- **At most 6 panes.** When the limit is reached, every "split" action degrades to "show here" (replace the target pane's buffer). Edge drop zones collapse to the centre zone.
- One pane is **focused** at any time. The focused pane gets a 2px accent top border (only when there are 2+ panes) and a surface-coloured header; unfocused headers use `panelAlt`. Pointer-down anywhere in a pane focuses it.
- Optionally one pane is **maximized** (zoomed): it fills the main area, others are hidden but kept in the tree, dividers are hidden. Splitting or moving clears the zoom.
- The layout (tree, ratios, focus) is UI state, persisted locally so it's restored on launch (§3.13, "never a blank screen"). It is desktop-shell only; the mobile shell never shows splits.
- The same buffer may appear in more than one pane (e.g. "Split right" duplicates the current buffer).

## Pane chrome

Each pane has a 38px header: title (`#channel` or nick), topic (ellipsized), then buttons:
- **Members** (icon + member count), pressed when the shared member panel is following this pane; clicking focuses the pane and shows the member panel.
- **Split right**, **Split down**: split this pane, the new pane shows the same buffer and takes focus.
- **Maximize / Restore layout** (also: double-click the header).
- **Close pane.** Closing a leaf promotes its sibling. Closing the last pane leaves one empty pane ("Drop a channel here, or pick one from the sidebar.").

Below the header: the message list and the pane's own composer (each pane has its own composer and draft).

## Sidebar interactions

- **Click** a channel/DM: show it in the focused pane.
- **⌥-click** (or ⌘-click): open it in a new pane to the right of the focused pane.
- Rows for buffers that are visible in some pane show a small "open in a pane" indicator; their unread/mention badges are suppressed (they're on screen). The row for the focused pane's buffer is the "current" (selected) row.
- The sidebar header subtitle summarises the layout, e.g. "3 panes · 3 open", or "1 of 3 panes (maximized) · 3 open".

## Drag and drop

- Sidebar rows are draggable. Pane headers are draggable (to move a pane).
- While dragging over a pane, the drop zone is chosen by pointer position: within 25% of an edge → that edge (`left`, `right`, `top`, `bottom`), otherwise `center`. When zoomed, always `center`.
- A translucent accent overlay previews the zone, labelled: "Split left / right / up / down", "Show here" (dropping a buffer in the centre) or "Swap" (dropping a pane in the centre).
- Dropping a **buffer**: centre → show it in that pane; edge → split that pane on that side with the new buffer.
- Dropping a **pane**: centre → swap the two panes' buffers; edge → remove the pane from its place and re-insert it on that side of the target (keeping its id). Dropping a pane onto itself does nothing.
- Must also be keyboard- and screen-reader-operable (design the keyboard equivalents: e.g. commands in the registry for split right/down, close, maximize, focus pane left/right/up/down, move pane). The prototype only does pointer DnD.

## Resizing

- A divider sits between the two children of every split: a 7px hit area, `col-resize`/`row-resize` cursor, a 1px accent line while dragging (invisible otherwise; the 1px gap between panes shows `panelBorder`).
- Dragging sets the split's ratio, clamped to 0.15–0.85 of that split's box. Double-click resets to 0.5.
- Dividers are `role="separator"` with `aria-orientation`; they should also be keyboard-adjustable (arrow keys), which the prototype lacks.

## Shared member panel

- There is still **one** member panel (232px, right side), not one per pane. It **follows the focused pane**: a chip at its top reads "Following **#channel**", and its contents cross-fade (200ms, disabled with reduced motion) when focus moves to a pane with a different buffer.
- It hides when the focused pane is empty or a server buffer; it can be closed and reopened via any pane's Members button.

## Open design questions (resolve in the navigation / layout design docs)

- How the single-pane case maps onto Main's full header (sidebar toggle, search, ⌘K, member toggle) vs. the compact per-pane header. Proposal to evaluate: one-pane layout shows the full main header; with 2+ panes each pane gets the compact header and the global actions move elsewhere.
- How chromeless mode (§5.2) interacts with multiple panes.
- Minimum pane size and what happens when the window shrinks (e.g. auto-maximize focused pane below some width; never show splits in the mobile shell).
- Whether server buffers can occupy a pane (the prototype doesn't show it; the brief's server buffer hides the member list, which fits the "panel hides" rule above).
- Read markers: a buffer visible in any pane counts as being read (the prototype suppresses its badges). Define precisely when the read marker moves (e.g. visible and window focused).
