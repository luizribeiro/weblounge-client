# 22 — Transient notices

Status: approved for the dogfood slice.

## Problem

Some failures matter after their originating buffer is no longer visible. A composer-local notice
cannot explain a failed DM send after that DM has been closed, while a modal would interrupt
unrelated work. The app needs one quiet, reusable transient-notice surface.

## Types and behavior

The app owns at most one `ToastNotice`:

```ts
interface ToastNotice {
  readonly id: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}
```

A newer notice replaces the current one. The surface is a polite live region and never steals
focus. It appears above the focused pane's composer on desktop and above the composer or tab bar on
mobile, inside safe-area insets. It uses theme, spacing, radius, shadow and motion tokens only.
Reduced motion removes the fade.

The notice dismisses after six seconds of unpaused time. Pointer hover and focus within the notice
pause the remaining duration; leaving or blurring resumes it. The action runs once, dismisses the
notice, and delegates navigation to the app rather than embedding engine knowledge in the visual
primitive.

For a send that fails after its DM was closed, the engine's typed failure includes the network and
recipient needed to reopen that existing hidden conversation. The app shows “Message to {nick}
wasn't delivered” with an “Open” action. Opening restores the same buffer identity and failed row so
Retry can be added to the row without reconstructing message state.

## Boundaries

The engine owns send state, hidden DM identity, and typed failure metadata. The app selects and
replaces notices and supplies actions. `Toast` owns only presentation, pause/resume timing,
announcement, and dismissal. It does not inspect IRC failures or navigate directly.

Persistent connection state, command replies, inline validation, notification-center history, and
stacked toast queues remain outside this surface.

## Testing

- Engine reducer tests cover confirmation before close, confirmation after close, failure after
  close, explicit reopen, peer activity reopening, and own activity remaining hidden.
- Component tests use fake time for replacement, six-second dismissal, hover/focus pause, action,
  and reduced motion.
- Desktop and mobile Playwright tests force a post-close send failure through the test harness,
  assert the polite notice and Open action, verify the same failed row reappears, and use
  `page.clock` to assert dismissal without sleeping.
- The native-feel audit remains green while the surface is idle and hidden.
