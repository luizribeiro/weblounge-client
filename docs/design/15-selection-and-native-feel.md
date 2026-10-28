# 15 — Selection and native feel

Status: milestone 2 foundation.

## Problem

The DOM must retain useful text selection and native editing while the application shell behaves
like app chrome. Browser defaults make those goals conflict: selection can cross controls, copied
DOM text includes presentation, and context menus, dragging, focus flashes, overscroll, and idle
animation expose the webview.

This foundation supplies opt-in content selection, structural truncation, one context-surface
registry, data-driven copy, motion tokens, and a reusable browser audit. It does not build menus or
the final message UI.

## Selection and copy

Chrome is non-selectable by default. Chrome includes sidebars, channel and member rows, tab bars,
headers, buttons, badges, settings labels, form labels, timestamps, delivery state, and composer
buttons. Content opts in only through `Selectable`: message text, topics, server-log lines, code
blocks, and link previews. Inputs and editable controls retain their native selection behavior.
Each message row is a selection boundary in structure; its chrome remains outside `Selectable`.
The message list owns cross-row selection, so a drag can include adjacent content rows but cannot
spill into the surrounding header, composer, or sidebar.

The message list handles `copy` when a non-collapsed selection intersects its registered rows. It
maps the selection endpoints to stable row IDs, takes the inclusive rows from message data, and
writes `text/plain`; it never serializes `innerText` or cloned DOM. The pure model is:

```ts
export type CopyRow =
  | { readonly kind: "message"; readonly time: Date; readonly author: string; readonly text: string }
  | { readonly kind: "action"; readonly time: Date; readonly author: string; readonly text: string }
  | { readonly kind: "day-divider"; readonly label: string };

serializeCopyRows(rows: readonly CopyRow[]): string;
```

Messages, including mentions, serialize as `[22:01] <luiz> text`; actions as
`[22:01] * tomo is grabbing coffee`; dividers as `--- Today ---`. The initial debug view derives
message rows from `MessageProjection`; final message rows will carry their already-derived display
kind from the engine. An empty range leaves native copy alone. Copying an input always remains
native.

## Context surfaces

One `ContextMenuRegistry` maps registered elements to a closed surface kind (`chrome`,
`selectable`, or `input`) plus an optional command context. A single root `contextmenu` handler
resolves the composed path. It permits the browser menu only for selectable content, inputs,
textareas, selects, and editable controls; otherwise it calls `preventDefault`. `Selectable`
registers itself, and feature roots register their chrome. Future menus add typed menu providers to
the same records and dispatch command IDs through subsystem 14's registry; they do not add local
right-click handlers. Tauri later replaces presentation with native menus while retaining the
same surface and command resolution.

## Browser-default contract

The global stylesheet is intentionally small; component appearance remains in CSS Modules per
subsystem 08.

| Web default | Concrete default |
|---|---|
| Selection and I-beam | App root uses `user-select: none` and `cursor: default`; `Selectable` and editable controls opt into text selection/cursor. |
| Tap highlight and touch callout | Clear `-webkit-tap-highlight-color` and disable callout on chrome; restore callout for selectable/editable content. |
| Mouse focus flash | Suppress ordinary outlines and restore the token-driven ring only with `:focus-visible`. |
| Image/link drag | Chrome assets set `draggable={false}` and base CSS disables WebKit user drag; a root `dragstart` fallback rejects chrome drags. |
| Rubber-band and pull-to-refresh | `html`, `body`, root, and app shell fill the viewport, do not page-scroll, and use `overscroll-behavior: none`; lists own scrolling. |
| Mobile input zoom | Editable controls compute to at least `16px` on coarse-pointer/mobile layouts. |
| Font layout shift | Task 4 self-hosts and preloads subsets with metric-matched fallbacks or `size-adjust`; the foundation uses the system stack and the audit observes font readiness. |
| Accidental zoom suppression | The viewport remains user-scalable; controls use `touch-action: manipulation` without disabling accessibility zoom. |

Raw fallback geometry exists only until task 4 emits the full theme/density token sets and is
marked there. No raw colour is introduced.

## Motion tokens

Motion is a global semantic token layer owned by subsystem 08, not by individual themes:

```css
--wl-motion-push-in: 280ms;
--wl-motion-push-out: 230ms;
--wl-motion-members: 220ms;
--wl-motion-fade: 200ms;
--wl-motion-preview-fade: 420ms;
--wl-motion-standard-curve: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Components may transition only `transform` and `opacity`. Under `prefers-reduced-motion: reduce`,
all duration tokens become `0ms`; components do not add independent media queries or timers.

## Primitives

`app/src/ui/Selectable.tsx` is the only content-selection opt-in. It renders a semantic wrapper,
marks the context surface, and applies its CSS Module. `app/src/ui/Line.tsx` renders one structural
line with `min-width: 0`, hidden overflow, no wrapping, and ellipsis. It is used for every name,
topic, time, status, and label slot rather than copying declarations into features. Neither
primitive owns theme, density, message semantics, or copy formatting.

## Audit and waste checks

`nativeFeelAudit(page)` runs against the built app in Playwright and is part of `nix flake check`.
It asserts:

- every audited descendant outside `Selectable` or an editable control computes to
  `user-select: none`, and chrome never computes to a text cursor;
- chrome right-click is prevented while selectable text right-click is not;
- a pointer selection across two rows stays in the list and its `copy` payload is IRC-style text;
- chrome images and links are not draggable;
- cumulative layout shift stays at or below `0.01` through `document.fonts.ready`;
- an instrumented short idle window executes no app `requestAnimationFrame`, timeout, or interval
  callbacks after startup settles (network callbacks are outside those APIs and therefore exempt);
- while visibility is emulated as hidden, a second Ergo client can deliver messages without
  mutating the message-list DOM; becoming visible causes one batched catch-up mutation.

The timer instrumentation is installed before app code and counts callbacks, not registrations.
Tests use bounded waits rather than app polling. The hidden test uses the real local Ergo fixture
because only a real worker event proves that engine state continues while rendering pauses.

## Boundaries

This subsystem owns selection opt-in, line truncation, browser-default policy, context-surface
registration, copy serialization/adaptation, motion variables, and the native-feel audit. Feature
components own row data and semantic markup. Subsystem 14 owns commands. Subsystem 08 owns the
eventual generated theme values and fonts. The engine owns IRC semantics and never reads DOM
selection.

## Testing

Component tests cover `Selectable`, `Line`, context resolution, and handler cleanup. Pure unit
tests cover messages, actions, dividers, mentions, empty input, and newline normalization in the
serializer. The debug message list wires real row data into the copy handler. Playwright covers
computed styles, pointer selection/copy, context menus, CLS, idle, hidden catch-up, and the built
app. Every later user-visible UI task keeps this audit green.

## Later

- Render command-backed browser menus and Tauri native menus from registered providers.
- Add final message action/divider projections with the message-list milestone.
- Add bundled metric-adjusted font faces and preload hints with task 4.
- Extend the waste harness to the planned 60-second idle and long-session soak gates.
- Verify long-press, rubber-band behavior, Dynamic Type, and native menus on real iOS/Android and
  Tauri devices; Playwright cannot faithfully emulate them.

## Questions for Luiz

1. Should copying one partially selected message serialize the whole IRC row, as this foundation
   does, or preserve only the selected substring?
2. When final message kinds land, should notices use `-nick- text` or the ordinary `<nick>` form?
