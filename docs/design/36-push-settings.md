# 36 — Push notifications switch

Status: decisions 1–4 by Luiz (2026-11-17); the rest follow from them and design 29.
This fills in design 29's planned `PushOnThisDevice` row (Notifications → This device).

## Problem

Push has no switch. Once permission is granted it stays on until sign-out; the only way to stop
pushes to one device is the OS or browser settings, which also blocks page notifications. A
registration that keeps failing says nothing: on 2026-11-16 the iOS app "turned on" while the
relay answered 501, and the only trace was `/debug push`. Settings → Notifications exists only in
a browser tab, where its one row ("Show unread in the tab") applies, so the iPhone web app, the iOS
app and the Mac app have no Notifications section at all.

## Decisions

1. **Off stops pushes to this device** (Luiz). Turning the switch off removes this device's routes:
   each home gets `UNREGISTER`, and the relay deletes the device and with it every route
   (`DELETE /v1/devices/{id}`, which the relay already has). Other devices keep their pushes.
   Turning it on registers again, asking the OS or browser for permission when it was never asked.
   The choice is per device and survives reloads.
2. **Where it shows** (Luiz). The push row shows wherever the page can push: the same condition the
   notification prompt uses (push configured, and either the iOS shell or Web Push outside an iOS
   browser tab). "Show unread in the tab" stays browser-tab only. Visibility becomes per row; the
   section shows when any row applies.
3. **Blocked** (Luiz). With permission denied, the switch is off and disabled, with a line naming
   where to unblock it: "Blocked in iOS Settings → Notifications → weblounge" on iOS (the app and
   the home-screen web app), "Blocked in System Settings → Notifications → weblounge" in the Mac
   app, "Blocked in this site's browser settings" elsewhere. The iOS app adds an "Open Settings"
   button when the shell has the `open_app_settings` command (decision 7).
4. **Failure is visible** (Luiz). When registration still fails after the existing retries, the row
   shows "Couldn't turn on notifications" and a Retry button; the switch stays on, since that is the
   user's choice. It clears by itself when a later attempt succeeds.
5. **Storage.** A new engine app setting, `push_on_this_device: bool`, default `true` (design 29's
   `PushOnThisDevice`). Engine settings are already device-only (design 29 D9), persist, and reach
   every tab through `settings_changed`. `true` means "push when permitted", so today's behaviour
   is unchanged: the switch reads on only when the setting is on *and* permission is granted.
6. **The prompt.** The prompt asks someone who has not decided. Off is a decision, so the prompt
   hides while the setting is off. Off does not write the prompt's permanent dismissal, and
   dismissing the prompt does not turn the setting off: dismissal means "stop asking", and the
   switch stays there for later. Turning on from the switch asks for permission, after which the
   prompt's own rule (permission `default`) hides it.
7. **"Open Settings" capability.** The button shows wherever the iOS native bridge exists, and
   calls its `open_app_settings` command (`crates/native-bridge`, c8d977c3; no request, answers
   null). Every iOS shell build answers it: none shipped before the command landed, so the bridge
   itself is the capability check and the shell identity needs no command list.
8. **What counts as failed.** Per network, the synchronizer counts failed attempts in a row in its
   existing `#retryAttempts`. A network is failing once that count reaches 3 (the first try and two
   backoff retries, about 2–3 s with `relayRetryDelay`'s 0.5–1 s and 1–2 s), or at once for a
   failure it never retries: `invalid_request` (400) and a home's `web_push_forbidden`. Retried
   failures are `unavailable` (unreachable, 5xx including 501, 403 and other 4xx), `capacity`,
   engine send errors and the home's other `Failed` reasons. `gone` and `dead_route` recover by
   themselves (a new device or a rotated route) and count only if that attempt fails too.
   `unauthorized` is not shown here: it already restarts hosted sign-in. The count resets on
   activation (as today), on `push_route_required` and on Retry. Backoff retries continue while the
   row shows the failure.
   A rejected Web Push `subscribe()` (`runConfiguredPush` throwing, before any synchronizer exists)
   is recorded in `App.tsx` as a setup failure; Retry runs the setup again.

## Behaviour

| Permission | Setting | Registration | Switch | Line |
|---|---|---|---|---|
| default or granted | not loaded | — | disabled | — |
| denied | any | — | off, disabled | Blocked in …, Open Settings (iOS app) |
| default | any | — | off | — |
| granted | off | — | off | — |
| granted | on | ok or in progress | on | — |
| granted | on | failing | on | Couldn't turn on notifications, Retry |

Toggling on: `default` asks first (denied → blocked, no answer → stays off); on a grant, or when
already granted, the setting becomes `true` and the push setup that today starts on a grant runs.
Toggling off writes `false`. Each tab reacts to its own `settings_changed`, with no channel
message: it keeps a reference to its synchronizer if it has one, runs `resetPushSetup()` (the
block `startConfiguredPush` already runs when the push config changes: dispose the owner, lease,
channel and synchronizer, and bump the setup generation), then awaits that synchronizer's
`signOut()`. A tab that takes the released lock before its own change arrives builds a
synchronizer and then signs it out the same way, so every route still ends up removed.

Turning on again needs nothing new. `App.tsx` already keeps every `push_route_required` it has
seen (`knownPushRequirements`) and replays them into each new synchronizer, so the homes register
again. Retry runs `retryNow()` (which also lifts the relay client's backoff gate, so it tries at once) in
the tab that owns the synchronizer; any other tab sends `retry`
over the push channel; a setup failure reruns `startConfiguredPush`.

On the phone the root row's value is the push state ("Push on", "Push off", "Push blocked",
"Couldn't turn on"), or the tab value where there is no push row.

## Types

```ts
// features/settings/push-settings.ts
type PushSwitchStatus = "off" | "on" | "blocked" | "failed";
type PushBlockedIn = "ios" | "macos" | "browser";
interface PushSettings {
  readonly status: PushSwitchStatus | undefined; // undefined until settings load
  readonly blockedIn: PushBlockedIn;
  readonly onToggle: (on: boolean) => void;
  readonly onRetry: () => void;
  readonly onOpenSystemSettings: (() => void) | undefined;
}
interface SettingsPageProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  readonly push: PushSettings | undefined; // undefined: this platform has no push row
}
interface SettingsSectionDefinition {
  // replaces `shown: () => boolean` and `summary(settings)`
  readonly shown: (push: PushSettings | undefined) => boolean;
  readonly summary: (settings: AppSettings, push: PushSettings | undefined) => string;
}

// platform/push/push-sync.ts: the diagnostic gains one field
interface PushRouteDiagnostic {
  readonly networkId: number;
  readonly state: PushRelayRouteState;
  readonly routeIdPrefix?: string;
  readonly lastError?: string;
  readonly failing: boolean;
}
class PushSynchronizer { retryNow(): void }
// push-sync-channel: { kind: "retry" }
```

## Boundaries

- The engine stores the choice and nothing else; it never starts or stops push.
- `App.tsx` owns the lifecycle. One gate (`pushPermitted`) requires the setting to be loaded and
  `true`, so launch, foreground and target refreshes never start push while it is off or before
  the saved value is known. The launch start moves from the permission read into an effect on the
  setting, the permission, the config and the started engine, so a late settings load still starts
  push. Off reuses `resetPushSetup()` and `PushSynchronizer.signOut()`; there is no second teardown
  path.
- `PushSynchronizer` decides which route failures count; `App.tsx` adds its own setup failure; the
  page only renders the result.
- No relay or engine protocol change beyond the setting.

## Out of scope

Notify me about and highlight rows (design 29); per-network push; retrying a failed off (it is best-effort like sign-out: the home `UNREGISTER` happens
first, so the home stops pushing even if the relay delete fails); showing a missing APNs token as a
failure (the token normally arrives just after the grant).

## Testing

- Rust: `AppSetting::PushOnThisDevice` (so `entries()` grows to four), default `true`, change and
  reload, a record saved before the field existed, and invalid-value fallback reported in
  `invalid_fields`. These are the tab indicator's tests, parameterised over both switches.
- Unit: `pushSwitchStatus` for every row of the table; the prompt hides while off; the synchronizer
  marks failing after three failures and at once for unretried ones, clears on success, and
  `retryNow` re-runs; the channel decodes `retry`; section visibility per platform and push support;
  the Notifications page's switch, blocked line, Open Settings and Retry.
- Playwright (hosted fake engine and relay): desktop Chromium on, then off with
  `DELETE /v1/devices/device-1` and the home `UNREGISTER` asserted, then on again; the iPhone layout;
  the iOS app stub blocked with Open Settings, and a 501 relay with Retry recovering; the tab row
  only in a browser tab. `nativeFeelAudit` on the desktop journey; screenshots light and dark.
