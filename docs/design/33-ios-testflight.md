# 33 — iOS app through TestFlight

Status: approved by Luiz (2026-11-16), every decision as recommended. The one-crate split and the
darwin dev shell are built; the rest is not. Backlog F36; extends
design 27 (wrapper) and 28 (release) to iOS, and fills in design 23's "Later: Tauri native" for
iOS.

## Problem

On the iPhone weblounge is a home-screen PWA today. Luiz wants a real iOS app distributed through
TestFlight, for two reasons:

1. **Push from a native app.** The app's WKWebView has no `PushManager` and no service worker, so
   Web Push cannot work there. The first TestFlight build must have push, which means APNs.
2. **120 Hz scrolling** on the iPhone 16 Pro's ProMotion display (see "Frame rate" below for what
   is and isn't known).

He has an Apple Developer account, and the macOS wrapper already signs with it (design 28). Builds
need Xcode on the `weblounge-desktop` Mac, which is offline for now. This doc therefore marks
which steps need the Mac and which can be prepared on the Linux host.

## Approach

The iOS app is design 27's wrapper on a phone. It is one Tauri 2 window that loads the hosted
`https://beta.weblounge.org`, for the same reason as on the Mac: concierge OAuth's `redirect_uri`
and the page's return check both need the hosted origin. Every product behaviour stays in the web
build, and the phone shell (design 09/10) renders unchanged. The native side adds only what a
WKWebView can't do: APNs registration, a Notification Service Extension (NSE) that decrypts and
formats pushes, native tap routing, the badge, and lifecycle signals.

**One crate.** `apps/tauri/` becomes a lib plus bin with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`.
The navigation policy (`navigation.rs`), shell identity (`shell.rs`, now `kind: "ios-app"` on
iOS), the remote capability and the notification center (`notifications/`, through
`objc2-user-notifications`, which also targets iOS) are shared. The menu, close-to-hide, window
state and login item stay `cfg(desktop)`. `tauri.ios.conf.json` is the platform overlay that
Tauri merges automatically. As on the Mac, a dev and a release identity never share an identifier.

**Identity.** Release `org.weblounge.ios` ("weblounge"), dev `org.weblounge.ios.dev`
("weblounge dev", yellow icon). The NSE is `<app id>.notifications`. The App Group is
`group.org.weblounge.ios` (dev: `.dev`), and keychain sharing uses one access group. The icons
come from `app/scripts/generate-icons.mjs`, the single icon source. iPhone only (DL7 keeps iPad
undecided), iOS 17 minimum (`setBadgeCount` needs 16), the same orientations as the PWA.

**Info.plist and entitlements** (in the committed `gen/apple` project, see Boundaries):
`CADisableMinimumFrameDurationOnPhone = true`; `ITSAppUsesNonExemptEncryption = false` (standard
TLS and RFC 8291 only; Luiz confirms in App Store Connect); `aps-environment` (Xcode sets
`development` or `production` from the provisioning profile; TestFlight uses production);
`com.apple.security.application-groups`; `keychain-access-groups`; a `PrivacyInfo.xcprivacy` for
the app and the NSE that declares App Group `UserDefaults`. No `UIBackgroundModes`: alert pushes
with `mutable-content` need none.

## Push on iOS

The design 23 architecture is unchanged. Home → relay → **APNs** → device, the relay never sees
plaintext, and the engine still owns IRC `WEBPUSH REGISTER`. What changes is the platform half,
which in the app is native.

### Registration and token delivery

1. The page's "Turn on notifications" affordance is shown when the shell offers native push (a
   `PushRegistrar` implementation selected by `hostShell() === "ios-app"`; presentation only, as
   design 27 requires). Tapping it calls the native `request_push_permission`, which runs
   `requestAuthorization([.alert, .sound, .badge])` and then `registerForRemoteNotifications()`.
2. The APNs device token reaches the shell through the app delegate's
   `didRegisterForRemoteNotificationsWithDeviceToken`. tao declares the `AppDelegate` class at
   runtime without the remote-notification methods, and its declaration panics if a class of
   that name already exists, so the app can't bring its own `AppDelegate`. A small Swift iOS
   plugin adds the success and failure methods to tao's class with `class_addMethod` when it
   loads; doing it in Rust would need `unsafe`, which the crate denies. Spike S1 confirmed this
   in the iOS 26.5 simulator: the added method received an APNs token (a simulator token),
   before the authorization prompt was even answered. The device checklist re-checks it.
   `push_target()` returns
   `{ platform: "apns", token, environment }` and the page caches it like a `PushSubscription`.
3. The page's existing device flow runs unchanged. It upserts the target at the relay
   (`POST /v1/devices`, `PUT /v1/devices/:id/target` when the token changes) on every launch and
   return to visible, the same rule as `getSubscription()`.
4. **Route keys are created natively.** The NSE runs in its own process and can't read the page's
   IndexedDB, so `create_route_keys(route_id)` generates the P-256 pair and auth secret, keeps the
   private key in the shared keychain group (`kSecAttrAccessibleAfterFirstUnlock`, so pushes
   decrypt while the phone is locked), and returns `p256dh`/`auth`. The page builds the same
   `PushRoute` for `EngineRequest::EnsurePush`. `drop_route_keys` runs where the page now deletes
   route records. The route → network label map that the worker keeps in `weblounge-push-v2` moves
   to the App Group for the NSE.

### Relay delivery to APNs

The relay already accepts `PlatformTarget::Apns { token }` and answers `NotImplemented`. It gains:

- the target `Apns { token, environment: Production | Sandbox }`: the token is 64+ hex characters,
  and the host is fixed (`api.push.apple.com` or `api.sandbox.push.apple.com`), so no SSRF
  validation is needed;
- an `ApnsSender` beside `WebPushSender`. It speaks HTTP/2 with an ES256 provider token (team id,
  key id, `.p8` key) cached for about 40 minutes, since Apple rejects tokens older than an hour and
  refreshes more often than every 20 minutes. Headers: `apns-topic` = the bundle id,
  `apns-push-type: alert`, `apns-priority: 10`, and `apns-expiration` = now + the home's TTL;
- the payload
  `{"aps":{"alert":{"title":"weblounge","body":"New message"},"mutable-content":1,"sound":"default"},"r":<route id>,"c":<inner b64url>}`.
  That is about 3.0 KB, under APNs' 4096 bytes, and the existing 413 at 2,800 home bytes still
  guarantees the fit;
- the urgency policy: APNs is `VisiblePushRequired` (high only), like Apple Web Push, so Ergo's
  normal-urgency `MARKREAD` and maintenance `PING` are dropped;
- the failure mapping: `410 Unregistered` and `400 BadDeviceToken` mean the target is dead, so its
  routes die and the home gets 404, the existing rule. 429 and 5xx count as an ordinary failure
  toward the home;
- **the lease applies unchanged.** The app's page runs the same foreground-lease code, so pushes
  are held while any of the account's devices is foreground. This replaces design 23's "native
  targets need no lease": the iOS app is still the web page, and one rule for every target is
  simpler. `willPresent` also returns no options for a remote notification while the app is
  active, as a second guard.

### The Notification Service Extension

APNs shows the placeholder alert unless the NSE replaces it, so a crashed or slow NSE never
produces a silent push. The NSE is a thin Swift target over one Rust function:

```rust
// crates/push-payload, built as a staticlib for aarch64-apple-ios with a C ABI
pub fn prepare_notification(ciphertext: &[u8], keys: &RouteKeys, route: &RouteMeta)
    -> Result<PreparedNotification, PrepareError>;
pub struct PreparedNotification {
    title: String, body: String, thread_id: String /* the net/buffer tag */,
    user_info: NotificationData /* route, tag, msgid, server time */,
    pushed: Option<PushedMessage>, kind: PreparedKind /* Visible | Control */,
}
```

Decryption (RFC 8291 through the RustCrypto `p256`, `hkdf` and `aes-gcm` crates the relay already
uses; `ece` only has an OpenSSL backend, which can't build for wasm), parsing (the existing
`parse_push_payload`) and the title/body/tag formatting all move into `push-payload`. The
service worker calls the same code through wasm instead of `push-notification.ts`'s formatter, so
the two platforms can't drift (DRY). The NSE then:

- sets the title, body and `threadIdentifier` (the conversation tag, which groups notifications
  the way Safari couldn't) and `userInfo`;
- bumps that conversation's count and the badge in the App Group, mirroring the worker's ledger,
  and sets `content.badge` and the `· N new messages` suffix from it;
- appends the pushed message to an App Group queue (for tap before history);
- on a decrypt or parse failure, keeps the placeholder and flags the route for re-registration
  (design 23 step 7);
- on a control that still arrives (a third-party home that sends `MARKREAD` at high urgency), it
  removes covered delivered notifications and zeroes that conversation's count, but it must still
  show something. Hiding it needs Apple's discretionary `usernotifications.filtering` entitlement.
  This is a known limit; production Ergo never sends one.

The NSE has about 24 MB and 30 s; a Rust staticlib of decrypt plus parse fits easily.

### Read state, badge and cleanup

The page code stays the same. The platform seams it already injects get iOS implementations:

- `app-badge.ts`'s `BadgeNavigator`: `setAppBadge`/`clearAppBadge` call
  `UNUserNotificationCenter.setBadgeCount`. `writeNotificationCounts` also writes the per-tag
  counts and read markers into the App Group, so the NSE starts from the engine's numbers.
- `app-badge.ts`'s `RegistrationProvider`: `getNotifications()` lists delivered notifications
  (`getDeliveredNotifications`, mapping `userInfo` to `data`) and `close()` calls
  `removeDeliveredNotifications(withIdentifiers:)`. `closeReadConversationNotifications` and
  `closeMessageNotifications` (redaction, design 32) then work unchanged. "One notification per
  msgid" holds because the NSE uses the msgid as the request identifier, so a re-delivery replaces
  rather than duplicates.

### Notification taps and deep links

`didReceive response` gives the shell the tapped notification's `userInfo.route`, which is
validated as a same-origin buffer path (`buffer-route.ts` shape) or else dropped.

- **Warm** (page loaded): the shell dispatches the allow-listed page event `weblounge:open-route`,
  the same event the worker's `open-route` message and design 27's click shim feed.
- **Cold** (launched by the tap): the window's first URL is `https://beta.weblounge.org<route>`. The
  page already treats the route URL as the deep-link fallback.
- **Tap before history**: on launch and on every return to foreground, the page drains the App Group
  queue (`take_pushed_messages`) into the engine's `Space::Cache` through the same function the
  service worker uses, before honouring the route. The engine's msgid dedupe covers the rest.

Native taps are reliable, so WebKit bug 268797 (the PWA landing on the chat list) doesn't apply in
the app.

## App lifecycle

- **Foreground signal.** WKWebView maps app background/foreground to `visibilitychange`, so
  `createForegroundSignal` and the lease work as they do in the PWA **[verify on device]**. iOS
  may not deliver `pagehide`/`freeze` on backgrounding, so the shell dispatches a
  `weblounge:lifecycle` `background` event from `applicationDidEnterBackground` inside a
  background-task assertion. The page treats it like `freeze` and releases the lease at once, so
  pushes are never held for the 75 s TTL after the phone locks.
- **Suspension.** iOS suspends the app seconds after it backgrounds; the IRC socket drops and the
  engine reconnects on return, as the PWA does today. Nothing runs in the background except the
  NSE.
- **Web content process killed** while backgrounded (memory pressure): WebKit reloads the page
  itself when the app returns to the foreground, and at once when it is killed in the foreground
  (spike S2, simulator, with no terminate handler set). The shell sets none. A reload is a fresh
  page load, so the engine reconnects as it does on launch. The device checklist re-checks it.
- **Storage.** The app's WKWebView storage is separate from the PWA's: the user signs in once more
  and the app is a new relay device. No service worker means no offline launch, which design 19
  already treats as nonfatal. App-Bound Domains might enable service workers later (out of scope).

## Keyboard and safe areas

The phone layout's keyboard handling (`keyboard-motion.ts`, `viewport-geometry.ts`) reads
`visualViewport`, and WKWebView is the same WebKit as the PWA. The expectation is that it carries
over, but three things differ and are checked on device in the first build:

- Safe-area insets: `env(safe-area-inset-*)` needs `viewport-fit=cover` (already in
  `index.html`) and a web view scroll view that doesn't add its own insets. If Tauri leaves
  `contentInsetAdjustmentBehavior` automatic, the shell sets it to `.never` so the page keeps
  owning the insets.
- The status bar: no `apple-mobile-web-app-status-bar-style`; the shell follows the theme's light
  or dark scheme.
- Keyboard: the web view must not scroll the whole document when the composer focuses; the PWA's
  Playwright keyboard specs can't drive WKWebView, so screenshots compared with the PWA are the
  check.

## Frame rate (120 Hz)

What is known: on iPhone, an app gets frame rates above 60 Hz only with
`CADisableMinimumFrameDurationOnPhone` in its Info.plist (Apple, "Optimizing ProMotion refresh
rates for iPhone 13 Pro and iPad Pro"). UIKit scroll views then run at up to 120 Hz.

What is not known: WebKit has a preference, "Prefer Page Rendering Updates near 60fps", which
Safari exposes as a feature flag and which is on by default. It caps the page's rendering updates
(`requestAnimationFrame`, JS-driven layout and paint) at 60 Hz. As far as I can tell WKWebView
inherits that default, and no public `WKPreferences` API turns it off; a private one would risk
App Store review. Composited overflow scrolling of the transcript is driven by the UI process and
may reach 120 Hz, but every row the virtualizer mounts during a scroll is a 60 Hz rendering
update. So the Info.plist key is **necessary but may not be sufficient**, and whether the app
scrolls more smoothly than the PWA is an open question that only the device answers.

Spike S3, the first thing done on the Mac: build a dev app with the key and measure on the iPhone
16 Pro, the app against the PWA, with rAF intervals from the existing debug overlay and a fling recorded
with Instruments' Core Animation frame-rate track. The
result goes in this doc. Push alone justifies the app, so a 60 Hz result doesn't stop it.

## TestFlight distribution

- **App Store Connect** (browser, any machine): the App IDs (app and NSE, release and dev) with
  Push Notifications, App Groups and Keychain Sharing; an APNs auth key (`.p8`, "Keys" in the
  developer portal; one key serves sandbox and production); an App Store Connect app record for
  `org.weblounge.ios`; an App Store Connect API key for uploads (a different key from the APNs
  one).
- **Signing**: Xcode automatic signing with Luiz's team on the Mac creates the Apple Distribution
  certificate and profiles. That is a different certificate from design 28's Developer ID
  Application, but the same team and the same login keychain.
- **Internal testing**: up to 100 App Store Connect users, no review, and a build is available
  minutes after processing. Luiz tests here first.
- **External testing**: up to 10,000 testers by email or a public link (friends need no App Store
  Connect role). The first build of each version goes through Beta App Review (usually within a
  day), which needs a beta description, a feedback email, and a **demo weblounge account** for
  reviewers, because the app is unusable without signing in. Builds expire after 90 days.
- **Versioning**: `CFBundleShortVersionString` is the crate version, shared with the desktop
  wrapper since it is one crate. `CFBundleVersion` must grow with every upload, so it is
  `git rev-list --count HEAD` on `origin/main` (Tauri's `bundle.iOS.bundleVersion`; key name
  **[unverified]**). Tag `ios-v<version>+<build>`.
- **Release script**: `apps/tauri/release/release-ios.mjs` on the Mac, outside Nix like design
  28. It reuses `plan.mjs`'s preconditions (clean worktree, `HEAD` on `origin/main`, tag free,
  versions agree), runs `cargo tauri ios build --export-method app-store-connect`, uploads the IPA
  with `xcrun altool --upload-app` and the API key, then tags. The first build may simply go through
  Xcode's Organizer.

## Building on the Mac

iOS builds run from the dev shell, with three differences from the macOS build:

- **Xcode's SDKs, not Nix's.** The dev shell points `DEVELOPER_DIR` and `SDKROOT` at Nix's macOS
  SDK and puts xcbuild's `xcrun` first on `PATH`; neither knows `iphoneos` or `iphonesimulator`,
  so `cc` build scripts (e.g. `objc2-exception-helper`) fail. iOS commands therefore run under
  `env -u DEVELOPER_DIR -u SDKROOT PATH="/usr/bin:$PATH"`, which puts Apple's `xcrun` first. A
  wrapper script for local builds and the release script will own this (neither exists yet).
- **No `rustup`.** `cargo tauri ios init` runs `rustup target add` for every iOS target and fails
  without it. The dev shell already provides `aarch64-apple-ios` and `aarch64-apple-ios-sim`, so
  the planned wrapper puts a `rustup` stand-in on `PATH` that answers `target list --installed`
  from the sysroot and accepts `target add`. `x86_64-apple-ios` (Intel simulators) isn't needed.
- **Tools on `PATH`.** `tauri ios init` needs `xcodegen` and `cocoapods`, and installs missing ones
  through Homebrew or `sudo gem`; the darwin dev shell provides both. `libimobiledevice` is only
  needed to deploy to a device from the CLI, which Xcode does without it.

## Boundaries

**Client (this repo)**

| Area | Change |
|---|---|
| `apps/tauri/` | lib + mobile entry; iOS identity overlay; shared navigation, shell and notification modules; iOS commands `request_push_permission`, `push_target`, `create_route_keys`, `drop_route_keys`, `take_pushed_messages`, badge, delivered-notification list/remove; tap, lifecycle and content-process handling; capability scoped to `https://beta.weblounge.org/*` granting exactly those |
| `apps/tauri/gen/apple/` | committed Xcode project from `tauri ios init`: the XcodeGen `project.yml` with the NSE target, Info.plist, entitlements and privacy manifests. Changes go through `project.yml`, never the generated `.xcodeproj` |
| NSE (Swift, in `gen/apple`) | keychain and App Group I/O plus calls into `push-payload`; no rules of its own |
| `crates/push-payload` | decrypt + format moved here; `staticlib` C ABI for iOS; the service worker switches to the wasm formatter |
| `crates/push-relay` | APNs target, `ApnsSender`, DB target enum (migration), urgency and failure mapping |
| `app/src/platform/` | `HostShellKind` gains `"ios-app"`; an IPC `PushRegistrar`, `BadgeNavigator` and `RegistrationProvider`; the `weblounge:open-route` and `weblounge:lifecycle` listeners; pushed-message drain |
| `nix/`, flake | the darwin dev shell has the iOS Rust targets, the Tauri CLI, `xcodegen` and `cocoapods` (see "Building on the Mac"); no Nix package for iOS (Xcode signing can't run in the sandbox) |

**Server (`~/weblounge`, deployed by Luiz)**

- sops secret `push-relay-apns-key` (the `.p8`), plus team id, key id and topic in
  `services/push-relay.nix`'s environment. Egress is already 443 to the internet.
- Nothing for concierge, nginx, CSP or CORS: the page origin is still `beta.weblounge.org`.
  `webpush.max-subscriptions` is already 10, and the app takes one slot per phone.
- Optional, before external testing: the reviewer demo account.

**Where each step runs**

| Linux host, now | The Mac (Xcode), later |
|---|---|
| relay APNs support and its tests | `tauri ios init`, NSE target, first Xcode open |
| `push-payload` decrypt/format, C ABI, `cargo check --target aarch64-apple-ios` | building the staticlib and linking the NSE |
| page seams and Playwright journeys with a stubbed `__TAURI_INTERNALS__` | spike S3 (120 Hz) |
| Rust and Swift sources for the shell (they compile only on the Mac) | signing, archive, upload, TestFlight groups |
| `~/weblounge` secret wiring (after Luiz creates the APNs key in the browser) | the device checklist on the iPhone 16 Pro |

The developer-portal and App Store Connect setup is web-only and can happen any time.

## Out of scope

Android and FCM; iPad and landscape-specific layouts (DL7); App Store release (guideline 4.2
"minimum functionality" is a real risk for a web wrapper, though native push helps; in-app
account deletion, 5.1.1(v), would also apply); bundling the UI, the native engine, native
TCP/TLS (F16); App-Bound Domains and offline launch; the notification-filtering entitlement;
Universal Links and a custom URL scheme; share extension, Live Activities and widgets; CI builds
(they need signing secrets, as in design 28).

## Testing

- **Relay** (Rust integration, Linux CI): a fake APNs HTTP/2 server on the existing test TLS. It
  covers the JWT's claims and its reuse window, headers, payload bytes and size, high-only
  urgency, 410/`BadDeviceToken` → routes dead → 404 to the home, 429/5xx as failures, and the
  lease hold for an APNs device.
- **`push-payload`**: the RFC 8291 §5 vectors, the captured Ergo/soju fixtures through
  `prepare_notification`, and a C ABI round trip. The service worker's existing unit and Playwright
  suites must stay green after the formatter moves.
- **Page**: unit tests for the IPC registrar, badge and notification-list seams against a fake
  `invoke`. A local-Ergo Playwright journey runs with `__WEBLOUNGE_SHELL__ = ios-app` and a stubbed
  `__TAURI_INTERNALS__`, modelled on `page-notification-stub.ts`: turn on notifications, the relay
  creates an APNs device (push-e2e fixture with the fake APNs), a DM reaches fake APNs, and
  `prepare_notification` on that payload yields the right title and route. Then a stubbed tap
  opens the buffer, a drained pushed message shows before the connection, and reading removes the
  delivered notification. `nativeFeelAudit` and the idle/hidden checks stay green.
- **Shell**: unit tests for route validation and the iOS identity, run by the darwin build.
- **Device checklist** (iPhone 16 Pro, recorded in PLAN.md): install from TestFlight; sign in
  through the concierge; allow notifications; DM and mention while locked, then detailed text,
  grouping and badge; cold and warm tap; read elsewhere removes the notification and lowers the
  badge; force-quit still receives; a deleted message withdraws its notification; background for
  10 minutes and return (no blank view); keyboard, safe areas and status bar against PWA
  screenshots; the S3 frame-rate measurement.

## Decisions

1. Bundle ID `org.weblounge.ios` (dev `org.weblounge.ios.dev`)? **Agreed.**
2. Load the hosted `beta.weblounge.org`, as the Mac wrapper does, rather than bundling the UI? **Agreed.**
3. Ship the Notification Service Extension (detailed text) in the first build rather than generic
   "New message" pushes? **Agreed.**
4. Move decrypt and notification formatting into `push-payload` (Rust), shared by the service
   worker and the NSE? **Agreed**, so the two can't drift.
5. One `apps/tauri` crate for macOS and iOS? **Agreed.**
6. Should the iOS app take part in the relay's foreground lease (a phone in use quiets the laptop
   and the reverse), overriding design 23's "native needs no lease"? **Agreed.**
7. Internal TestFlight (you) first, then an external group with a public link for friends, which
   needs Beta App Review and a reviewer demo account? **Agreed.** Luiz creates the demo account.
8. Declare the export-compliance exemption (`ITSAppUsesNonExemptEncryption = false`)? **Agreed.**
9. Share the desktop's version number and use the commit count as the build number? **Agreed.**
10. iPhone only, iOS 17 minimum? **Agreed.**
11. Ship the app even if S3 shows WKWebView stays at 60 Hz for page rendering? **Agreed**, push alone
    justifies it.
