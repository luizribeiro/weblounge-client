# 23 — Push notifications

Status: approved (decisions 2026-11-02 and 2026-11-04); lifecycle redesign implemented. This is the brief's subsystem
7; it overrides the earlier statements listed under "Conflicts with signed-off text".

## Problem

When the app isn't on screen, a person should be told about messages that matter to them: DMs and
mentions in v1. That has to work on every platform weblounge ships on (desktop browsers, the iOS
home-screen PWA on an iPhone 16 Pro, the Android PWA; later Tauri desktop, iOS and Android) and on
every network the person uses: our Ergo at weblounge.org and third-party networks (Libera.Chat,
OFTC, private servers), most of which have no `draft/webpush`, always-on or chathistory.

Five facts shape the design:

1. **When the app is closed, nothing on the device is connected.** On the web the engine lives in a
   SharedWorker (or dedicated Worker) owned by the page, not the service worker
   (`app/src/engine/createEngineClient.ts:53-73`); iOS suspends sockets in the background (brief
   §3.10). Something that *stays connected* has to notice each message and send the push.
2. **The IRC push protocol leaves the push decision to the server.** `draft/webpush` is still the
   open IRCv3 PR #471 (https://github.com/ircv3/ircv3-specifications/pull/471). Each payload is one
   encrypted raw IRC line covering "a server-defined subset" of messages, with no vocabulary for
   rules.
3. **A browser push subscription accepts pushes signed by one VAPID key** (RFC 8292 §4.2; Push API
   `subscribe()` throws `InvalidStateError` for another `applicationServerKey`). Every server or
   bouncer signs with its own key (`VAPID` ISUPPORT), so a PWA can't take pushes straight from two
   homes, and the payload carries no network identity.
4. **Every push must show a notification on iOS.** Apple says Safari does not support invisible
   pushes and that every push must present immediately
   (https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
   WebKit says an event handler that shows nothing can have its subscription revoked
   (https://webkit.org/blog/12945/meet-web-push/); a badge update alone does not satisfy that promise
   (https://webkit.org/blog/14112/badging-for-home-screen-web-apps/). A native NSE can't drop a push
   either without Apple's discretionary `usernotifications.filtering` entitlement.
   Ergo sends pushes that are meant to be silent: the registration test `PING` (high urgency,
   `irc/handlers.go:4384-4390`), a maintenance `PING` when no push has succeeded for over half the
   14-day expiry (checked every 24 h, `irc/server.go:46,346-351`) and `MARKREAD` when a buffer with a
   still-clearable push is read elsewhere (`handlers.go:3265-3274`; never to the endpoint that sent
   the MARKREAD, `client.go:2101`). Stock Ergo 2.19.1 sends all of them at high urgency
   (`client.go:2127`), but production already backports upstream commit `9975d8d` in
   `~/weblounge/pkgs/ergochat.nix`, making the maintenance PING and MARKREAD `UrgencyNormal`. The
   registration PING stays high.
5. **The device can't apply notification rules, so the sender must.** Pushing too much can't be
   undone on iOS (fact 4), and pushing too little can't be fixed while the app is closed. Every
   future rule has to be evaluated by whatever sends the push.

## Goals

- **One model for every network and platform.** A network gets push when its connection reaches an
  always-on *home* that speaks `draft/webpush` (or `soju.im/webpush`); every device receives pushes
  through one weblounge *push relay*. Other networks get no push, and the client says so plainly.
- **v1 has no settings.** It notifies on DMs and mentions, which is what homes already push. The
  only control is the one-time "Turn on notifications" step the OS requires.
- **Tapping a notification opens the right buffer and shows the pushed message at once**, from a
  cold start and when the app is open, before the connection is up.
- **Never a silent push to iOS. Never have the worker turn a control into a notification. Never a
  duplicate** while the user is looking at the app.
- **Room to grow without changing the wire format:** per-buffer, per-sender and per-network rules,
  all/mentions/none, keywords, and push and badging controlled separately.
- **The relay never sees plaintext.** It is a small, documented, replaceable service (brief §3.11)
  with the entitlement hook from brief §3.12.

## Non-goals

- Settings UI, rule editing, quiet hours and per-device schedules in v1.
- A hosted bouncer (see Future). Networks whose connection has no `draft/webpush` or
  `soju.im/webpush` get no push; they notify only while the app runs, and the UI says so.
- Payments and the entitlements service. The hook is concierge's introspection, which admits every
  member.
- Reactions, replies-to-you and other Activity kinds as push triggers (Activity, 06).

## Architecture

```text
 IRC network ──► home (always-on, speaks webpush) ──POST aes128gcm──► push relay ──► platform push service ──► device
                 • weblounge.org: Ergo itself                         push.weblounge.org   • browser push svc (Web Push)
                 • the user's own soju / Ergo                          pins home VAPID     • APNs (Tauri iOS, later)
                 • no webpush: no push, local notifications only       wraps, never decrypts • FCM / UnifiedPush (later)
```

### Homes

A network's `Endpoint` is `Direct(url)` or `BouncerBound { bouncer, netid }`. Push depends only on
what that connection negotiated: `Feature::WebPush`, an account and the `VAPID` token. Who runs the
server doesn't matter.

| Network | Home | What it pushes today |
|---|---|---|
| weblounge.org | Ergo (always-on opt-out, `~/weblounge/services/ergo.nix:132-158`) | every DM, plus channel lines containing the account name (`irc/channel.go:1445-1460`) |
| the user's own soju, one bound connection per network (`ClientBuilder::bouncer_network`, papo `builder.rs:258-276`) | soju | DMs, nick highlights and INVITEs, minus `soju.im/muted` / `soju.im/blocked` targets (soju `upstream.go:767-806`); caps each user at 25 push subscriptions (`downstream.go:3745`) |
| the user's own Ergo | itself | as the weblounge.org row |
| Libera, OFTC, private, reached directly with no webpush | none | nothing; local notifications while running |

Users with their own soju or any webpush-capable server get push through our relay, which needs a
weblounge account (decision 3).

### The push relay, on every platform (decision 1)

The brief (§3.12) says Web Push skips the relay. The PWA needs it too:

1. **One browser subscription serves N homes.** The browser subscribes once, with the relay's VAPID
   key.
2. **Network identity.** Each home gets its own relay *route* URL, so the device knows which network
   a push came from.
3. **No silent pushes to iOS.** Production classifies controls as normal urgency, so the relay can
   drop them for visible-only services. Dropping a push is not a silent push; delivering one that
   shows nothing is. Worker classification remains the final correctness boundary wherever a
   control is delivered.

**Device setup.** On every launch and every return to visible, the page compares
`PushManager.getSubscription()` with its stored endpoint and upserts that target at the relay. A
new device for an endpoint atomically takes ownership, retires the old device's routes, and gets a
new `DeviceId` and device secret. An existing live device updates changed target keys with
`PUT /v1/devices/:id/target`; a 410 from any device call means its target is dead and the page must
upsert again. Sign-out calls `DELETE /v1/devices/:id`. Its platform target is a browser
`PushSubscription` (later an APNs token, FCM token or UnifiedPush endpoint). For each home it owns a **route**
(`https://push.weblounge.org/v1/r/<128-bit random id>`) with its own **P-256 key pair and auth
secret**. The private key stays on the device: a non-extractable `CryptoKey` in IndexedDB on the
web, the Keychain or Android Keystore natively.

**Route lifecycle.** Idempotent `POST /v1/devices/:id/routes` carries the home's VAPID public key
and the page's optional current route id. The client already has the home key from ISUPPORT (papo
`Isupport::vapid()`, `isupport.rs:168`, already in `ConfigurePushAction`). If that route is live for
the device and home, the relay returns it. Otherwise the relay retires every live route for that
device and home and creates one fresh probing route. It pins the VAPID key at creation; there is no
trust-on-first-use window and the relay, rather than a tab, owns route convergence.

```text
probing ──(client: PUT /v1/routes/:id/active, after papo returns REGISTER success)──► active
   │                                                                                 │
   └────────────── DELETE /v1/routes/:id, or the device's target dies ──────────► dead (404)
```

- A `probing` route answers 201 and discards every push. Both homes send their registration probe
  synchronously before replying to REGISTER (Ergo's high-urgency `PING`, `handlers.go:4384-4406`;
  soju's `NOTE WEBPUSH REGISTERED` at normal urgency, `downstream.go:3776-3786`,
  `server.go:343-349`), so the probe always lands while the route is probing. Ergo fails REGISTER
  with `INVALID_PARAMS` unless the probe gets a 2xx, and the probe can't be told from a DM by urgency
  or content, so urgency alone can't filter it.
- Re-registering an existing endpoint sends no probe (`refreshPushSubscription`), so refreshes keep
  the route active.
- Activating a probing route atomically marks every other route for the same device and pinned home
  VAPID key dead. The relay enforces this convergence because a page can lose old route keys and
  therefore cannot unregister every stale home endpoint itself; the resulting 404 lets the home
  prune each superseded subscription on its next push. Routes for other devices or home keys are
  untouched. Repeating activation for the surviving active route is a no-op, while dead routes
  remain 404.
- Probing routes expire after five minutes. Expiry, replacement, device takeover and upstream target
  death all turn their public endpoints into 404s and queue those endpoints for explicit home
  cleanup. `GET /v1/devices/:id/dead-endpoints?home_vapid=...` offers at most five matching
  endpoints without deleting them; the engine sends exact `WEBPUSH UNREGISTER` commands before
  registration, then the page acknowledges the completed ids. Failed cleanup is offered again.
  Once a device has no routes left, the relay removes its target and retains only the credential
  tombstone needed to return 410 instead of letting stale clients recreate routes.

**Delivery.** The home encrypts each push to the route key (RFC 8291) and POSTs it. The relay:

- verifies the VAPID JWT against the pinned key, with `aud` equal to the relay origin and an
  unexpired `exp`;
- rate-limits per route and per VAPID key, and checks the entitlement hook;
- answers **404** for a dead route. Ergo and soju prune a subscription only on 404
  (`irc/webpush/webpush.go:143`, soju `server.go:372-374`); 410 just counts as a failure. When the
  device's upstream subscription dies (410 from a browser push service, APNs `Unregistered`), the
  relay marks all its routes dead and answers 404, never 410;
- passes the home's `TTL` (7 d for Ergo and soju) through to the push service (and to
  `apns-expiration`);
- applies the urgency policy and the lease (below);
- forwards the **inner ciphertext untouched**, wrapped for the target. On the web that is a fresh
  RFC 8291 message signed with the relay's VAPID key, carrying a Declarative Web Push envelope
  (https://webkit.org/blog/16535/meet-declarative-web-push/):
  `{"web_push":8030,"mutable":true,"notification":{"title":"New message","navigate":"/","data":{"r":<route id>,"c":<inner b64url>}}}`.
  Safari 18.4+ shows that fallback if the service worker fails; Chrome and Firefox hand the JSON to
  the service worker.

**Size budget.** Ergo and soju pad every push to one 2048-byte record (`webpush.go:122-134`,
`RecordSize: 2048`; soju `server.go:358`), so size leaks nothing for these homes. The inner body is
about 2.13 KB (record plus the 86-byte aes128gcm header), about 2.85 KB in base64url; the envelope
brings it to about 3.0 KB and the outer encryption to about 3.1 KB, under the 4096-byte Web Push,
APNs and FCM limits. The ciphertext is base64url-encoded exactly once. An encrypted body can't be
truncated, so the relay answers **413** to any home body over 2,800 bytes. In front of it, nginx
caps bodies at about 4 KB (`client_max_body_size`) and rate-limits with `limit_req`.

**Urgency policy.** The relay forwards `high` to every push service. Apple Web Push drops everything
lower because iOS and Safari require every delivered push to show a notification. FCM and Windows
Push also pass only `high`, because Chromium may replace a silent Web Push with its own "site
updated in the background" notification. Mozilla additionally forwards `normal`; all services drop
`low` and `very-low`. Production Ergo 2.19.1 carries the `9975d8d` backport, so its `MARKREAD` and
maintenance `PING` are normal urgency: relay logs confirm they are dropped for Apple and forwarded
to Firefox. Because the ciphertext is opaque, an unpatched or different home can still misclassify
a control as high. The worker therefore consumes either control silently regardless of delivery
urgency: `MARKREAD` records its timestamp, closes only notifications at or before that marker and
lowers the badge, while `PING` repeats the same bounded cleanup.

The relay sees which home is pushing (IP and VAPID key), the route and device, timing and urgency.
It never sees the sender, the target or the text.

### One notification source per device

**Foreground lease (web targets only).** The device can't drop a Web Push, and neither can an
iOS NSE in the background (fact 4), so duplicates are suppressed at the relay:

- Each tab holds its own lease, keyed by a per-tab id; the relay keeps a set per device. A tab holds
  its lease while it is visible **and** focused, renewing with `POST /v1/devices/:id/lease` every
  30 s (TTL 75 s). The signal is the engine's existing `setVisibility` (`App.tsx:419-421`), extended
  with focus, not a second listener.
- Release is `POST /v1/devices/:id/lease/release`, sent with `navigator.sendBeacon` (which can't
  send PUT or DELETE) on `visibilitychange`/`pagehide`. iOS suspends JS soon after hiding, so the
  release often never arrives.
- While any lease is live, the relay **holds** user-visible pushes instead of dropping them. A
  renewal proves the page was alive and showed everything up to that moment, so it discards pushes
  held before it. When every lease expires without renewal, the relay delivers the held pushes. A
  missed release makes a push late by at most the TTL, never lost. Held ciphertext is the only
  message data the relay stores, for at most 75 s.

Native targets need no lease: on iOS, `userNotificationCenter(_:willPresent:)` returns no
presentation options while the app is foreground; on Android, the app handles the FCM data message
and posts nothing.

**Cross-device quieting (decision 4).** The relay lease is the only mechanism: the hold covers
every device of the account while any device holds a lease (devices are tied to one concierge
account), so a phone stays quiet while you type on your laptop. Ergo's `webpush.delay` stays at its
default of 0, so pushes are never delayed by the home.

| Device state | Who posts OS notifications |
|---|---|
| push enabled on this device | push only; the page never posts its own `Notification` |
| push unavailable or denied, app open | the page, for buffers that aren't visible, deduped by `msgid` |
| Tauri desktop, running (decision 5) | the native engine, from its live connections; it never registers WEBPUSH |

### Service worker

`app/service-worker.js` gains `push`, `notificationclick`, `pushsubscriptionchange` and `message`
handlers. On `push`, inside one `waitUntil`:

1. Look up the route (network label, buffer map) in the `weblounge-push-v2` IndexedDB database.
2. Decrypt the inner payload with **WebCrypto**: ECDH with the non-extractable key, HKDF, AES-GCM
   (about 80 lines of TS). Rust can't reach a non-extractable key, so the Rust `ece` path is for
   native targets only.
3. Parse the plaintext line with `push-payload` compiled to wasm (see Types).
4. For a visible payload, call `showNotification` exactly once, before any further database work.
   Chat notification data includes
   its conversation tag, `msgid` and server time as well as the route. A duplicate chat `msgid`
   re-shows the same conversation tag so tag-capable platforms replace the prior notification. A
   decrypted `MARKREAD` or `PING` never calls `showNotification`; it only performs marker-bounded
   cleanup. A visible push never performs cleanup before or after showing itself.
5. After presentation, store the message (msgid, time, target, sender, text) in the engine's
   `Space::Cache` IndexedDB store, keyed so the engine reads it as part of the buffer's history,
   then persist and apply the badge count.
6. Serialize push events, but give each delivery its own deadline when its push event is received.
   If route lookup, decryption or parsing has not produced a visible presentation within two
   seconds, show the generic notification once and suppress all later presentation or route writes
   from that delivery. IndexedDB opens, requests and transactions have shorter deadlines, reject on
   `blocked`, close on every path and close on `versionchange`.
7. A decryption failure shows the generic "New message" for that network and marks the route for
   re-registration by re-reading the current route id inside its write transaction. Parser failures
   show generic without changing keys.

The service worker is a classic, non-module worker with a precache list. The parser wasm joins the
precache, is instantiated from the Cache API, and has a `size-limit` budget; shipping a new parser
is an ordinary service-worker update. The worker never talks to the engine, never fetches from the
network and handles no non-GET traffic (`19-packaging.md` stays true). It persists only pushed
messages (step 4) and the badge counter. iOS lacks `pushsubscriptionchange`, so the page
re-checks the subscription on every launch.

The optimized parser Wasm is currently 46,764 bytes and has a build-enforced 128 KiB ceiling. Its
8 KiB classic `wasm-bindgen` bootstrap and the Wasm are both explicit shell-precache entries; the
ceiling leaves room for the remaining typed payload variants without letting this narrow parser
grow into a second engine.

### Tapping a notification

`notification.data` carries the buffer route, e.g. `/weblounge/@mel`, plus the conversation tag,
message id and server time needed for read-marker cleanup (`10-navigation.md:201-222`,
`app/src/navigation/buffer-route.ts`). On `notificationclick`, `clients.matchAll({type:'window',
includeUncontrolled:true})`; if a window exists, `focus()` it and post `{kind:"open-route", route}`
(a new channel: the desktop shell has no `popstate` handling today, only `MobileShell.tsx:503`
listens); otherwise `clients.openWindow(route)`, which works cold because the service worker serves
the cached `index.html` for any navigation.

**Tap before history.** The engine loads the buffer's stored pushed messages from the local store
before any connection exists, so the tapped message is on screen on a cold start before the
connection is up; on a warm tap, `open-route` makes the running engine read them too. When chathistory or the live connection later delivers the same `msgid`, the
engine deduplicates it, so it never shows twice. The stored messages are also the push source for
Activity (brief §3.8).

The tag is `<networkLabel>/<bufferKey>`. The stable label avoids per-run `NetworkId` churn. BCD says Safari doesn't support tags: **[verify on
device]**.

### Badging (separate from push)

- **Sidebar and chat-list badges** come from the engine's read markers (`BufferProjection.unread`,
  `.mentions`, `protocol.rs:251-258`).
- **The app-icon badge** uses `navigator.setAppBadge` where it exists (installed Chrome/Edge PWAs
  on Windows and macOS, Safari 17 web apps, iOS 16.4+ home-screen apps). While a page is open it is
  the sum of `mentions` (the engine counts every DM as a mention, `state.rs:1834-1835`). With no
  page open, the service worker increments a counter in `weblounge-push-v2`; on launch the page
  overwrites it with the engine's value.
- The worker stores a notified count and latest read timestamp per conversation tag. Every delivered
  `MARKREAD` zeros that tag, closes only notifications whose server time is at or before the marker,
  and recomputes the badge without calling `showNotification`, regardless of urgency. Re-delivery of
  an existing chat `msgid` replaces its notification without incrementing the count again.
  Maintenance `PING` repeats that bounded cleanup. It undercounts when Ergo's 16-item push queue
  overflows (`client.go:53`).
- Opening or foregrounding the page corrects the badge from the engine and closes each notification
  at or before that buffer's engine-owned read marker, covering a delayed, missed or failed control
  cleanup on every platform. The same cleanup runs whenever a buffer's read counters change. It
  scans notification data rather than relying on tag filtering, which Safari does not support. The
  page seeds the worker's per-tag counts and markers from engine DM unread, channel mention and read
  state so later closed-page recomputation has the same base. Linux, Firefox and Chrome Android have
  no badging API, but cleanup still runs.

## Types

Rust lives in `crates/engine` unless noted; TS is generated with `ts-rs`.

```rust
/// Stable across runs and restarts; NetworkId stays the per-run handle.
pub struct NetworkKey(Uuid);                // persisted in Space::Durable

pub struct PushRoute {                      // what the platform hands the engine; no private material
    pub route_id: RouteId,
    pub endpoint: HttpsUrl,                 // https://push.weblounge.org/v1/r/<route_id>
    pub p256dh: B64Url,
    pub auth: Secret<B64Url>,               // papo::Secret
}

pub enum PushRegistration {                 // per network, persisted in Space::Durable
    Unavailable(PushUnavailable),
    Registered { route: RouteId, vapid: B64Url, refreshed_at: Timestamp },
    Failed { route: RouteId, reason: PushFailure, at: Timestamp },
}

pub enum PushUnavailable { NoWebPushCap, NoAccount, NoVapid, PersistenceOff, DirectConnection }
pub enum PushFailure { RegistrationLimit, Forbidden, InvalidParams, Internal, Relay(RelayError) }

/// Capability projection (17-capability-model.md:35,79); Some only when registration can work now.
pub struct ConfigurePushAction { pub network: NetworkKey, pub epoch: ConnectionEpoch, pub vapid: B64Url }

EngineRequest::EnsurePush { network: NetworkKey, route: PushRoute, unregister: Vec<HttpsUrl> }
EngineRequest::UnregisterPushRoute { network: NetworkKey, route_id: RouteId, endpoint: HttpsUrl }
EngineEvent::PushRegistrationChanged { network: NetworkKey, state: PushRegistration }
```

The platform seam: on the web the engine runs in a worker and can't call page code, so the seam is
the two requests above plus a TS `PushRegistrar` interface in `app/src/platform/push/`
(`ensureDevice`, `routeFor(home, vapid)`, `activateRoute`, `dropRoute`, `setForeground`). A Rust
`PushRegistrar` trait exists only for the native Tauri plugin. `Notifier` (`show`, `clear`,
`setBadge`) follows the same split.

`crates/push-payload` (pure, no I/O) holds the RFC 8291 decryption (Mozilla's `ece`) for native
targets and maps a line parsed by `papo_proto::LineRef::parse` / `parse_bytes` to
`PushEvent { Message { source, target, msgid, time, text, kind }, Invite, MarkRead { target, until }, Ping }`.
That parser has no tokio and no I/O and builds for wasm and as an iOS static lib. `papo-proto` is
internal and unstable, so it is pinned at the same git rev as papo and the two are bumped together.

### One rule for mentions

Today they disagree. The engine matches the exact nick, case-sensitively, with `-` and `|` as
boundaries (`state.rs:2090-2098`). Ergo matches the casefolded account against the lowercased text,
with `-_|` as word characters and URLs excluded (`channel.go:1445-1460`, `webpush/highlight.go`,
copied from soju's). soju matches the current nick case-sensitively (`user.go:499-513`; a "TODO: use
case-mapping").

A pure `crates/notify-rules` owns the classifier: `mentions_self` = nick **or** account,
casemapped, with Ergo's boundary rule and URL exclusion. The engine badges with it from day one, so
nick-only mentions on weblounge.org keep badging. Ergo stays unpatched in v1, so a channel line that
names only the nick badges but doesn't push.

## Rules data model (room to grow; v1 ships only the defaults)

Users will see a layered cascade, as in Slack, Discord and Element:

```rust
enum Scope { Global, Network(NetworkKey), Buffer(NetworkKey, BufferKey) }
enum Alert { All, MentionsAndDirect, Nothing }
enum UnreadBadge { Count, Dot, Hidden }
struct ScopeSettings { alert: Option<Alert>, push: Option<bool>, unread: Option<UnreadBadge>, mute_until: Option<Timestamp> }
struct SenderRule { network: NetworkKey, who: SenderMatch /* account | nick | mask */, effect: SenderEffect /* Mute | Vip */ }
struct Keyword { id: KeywordId, pattern: WordPattern /* word-bounded, casemapped */, scopes: ScopeFilter }
enum AppBadge { MentionsAndDirect, AllUnread, None }   // device-local
```

These compile into an ordered, Matrix-shaped list ("Push rules" in the Matrix client-server spec),
which is both the wire and the evaluation format:

```rust
struct Rule { kind: RuleKind, conditions: Vec<Condition>, actions: Actions }
enum RuleKind { Override, Content, Buffer, Sender, Underride }   // evaluation order
struct Actions { level: Option<Level>, push: Option<bool>, badge: Option<BadgeEffect> }
```

- **One precedence rule: per-field first-defined.** Rules are walked in `RuleKind` order, then list
  order; each field takes its value from the first matching rule that defines it. A more specific
  rule leaves a field `None` to inherit it.
- **Mentions and keywords override.** The defaults are:
  - Override: own message → nothing; `mentions_self` → `Highlight`, push, badge;
  - Content: each keyword → `Highlight`, push, badge;
  - Underride: DM → `Direct`, push, badge; other message → `Message`, no push, unread only.
- **Mute** is a Buffer rule with push off and the unread badge hidden. Because mentions and
  keywords sit above it, a mention in a muted buffer still pushes and badges, as in Slack, Discord
  and Telegram.
- **Unknown conditions never match** (from Matrix, for forward compatibility).
- **Each home enforces only a subset**, and the client shows only the controls that home can honour
  (brief §3.9): Ergo today, DMs and account mentions; soju adds per-target mute and block; a home we
  control, the full list.
- **Never store rules in `draft/metadata-2` on Ergo:** it always replies with visibility `*`
  (`irc/metadata.go:77,93,102`), and rules reveal who you've muted and your keywords.

Where rules live is deferred (see Decisions).

## Boundaries

- **papo** owns `draft/webpush` and `soju.im/webpush`, `VAPID`, labelled REGISTER/UNREGISTER, typed
  refusals (including `Refusal::WebPushForbidden`), `RegisterOutcome { persistence_required }`,
  bouncer binding and IRC line parsing (`papo-proto`). Weblounge never formats WEBPUSH itself.
- **Engine:** decides whether a network can register (`ConfigurePushAction`), reading
  `Isupport::vapid()` after each `Connected`; registers on each connection that has a route and refreshes once per 24 h (Ergo expires after 14 d,
  `server.go:327-357`); unregisters on sign-out or network removal; persists `PushRegistration`;
  shows stored pushed messages and deduplicates them by `msgid`; owns badge counts and the mention classifier; never holds a private key or talks to the relay.
- **Platform** (`app/src/platform/push/` on the web): asks for OS permission (from a user gesture
  on iOS and Firefox); creates the push subscription; talks to the relay; generates and stores
  route keys in its own `weblounge-push-v2` database, since the engine's byte store can't hold live
  `CryptoKey`s; holds the lease; sets the app badge.
- **UI:** one "Turn on notifications" affordance, shown when a network has `ConfigurePushAction`
  and this device hasn't decided; on iOS only in an installed PWA (Safari tabs get "Add to Home
  Screen to get notifications"). Each network's info/settings shows its status: "on", "turned off
  in iOS Settings", or, when the connection has no webpush, "This network doesn't support
  notifications while weblounge is closed". No rule controls in v1.
- **Relay** (`crates/push-relay`, in this repo per `docs/design/README.md:37,144`; brief §3.10 makes
  it infrastructure run for every user; deployed from `~/weblounge`):
  - API: `POST /v1/devices`, `PUT /v1/devices/:id/target`, `DELETE /v1/devices/:id`,
    `POST /v1/devices/:id/routes`, `GET` and `POST /v1/devices/:id/dead-endpoints`,
    `PUT /v1/routes/:id/active`, `DELETE /v1/routes/:id`, `POST /v1/devices/:id/lease`,
    `POST /v1/devices/:id/lease/release`, and the public `POST /v1/r/:route` for homes.
  - Device calls carry the device secret. Creating a device requires a concierge session token,
    checked by introspection as concierge client `push-relay` over loopback; that is the
    entitlement hook and decision 3.
  - It stores devices, targets, routes, pinned VAPID keys, counters, leases and held pushes (≤ 75 s)
    in SQLite. Against SSRF (it runs with `IPAddressAllow=any`), it refuses targets outside an
    allowlist of push-service hosts, targets that resolve to private or loopback addresses, and
    redirects.

### Relay slice 1 implementation (2026-11-02)

The deployable relay uses Axum on the workspace's Tokio runtime. Axum keeps the API typed and lets
the public home route enforce its 2,800-byte body limit before buffering. State uses `rusqlite`
with bundled SQLite: the service is small, every operation is short, and each connection runs on
Tokio's blocking pool rather than blocking an HTTP worker. This avoids an async ORM and a host
SQLite dependency. Outbound HTTP uses Reqwest with Rustls, proxy discovery off and redirects
disabled. The relay implements the small RFC 8291/RFC 8292 wrapping layer with the RustCrypto
P-256, HKDF and AES-GCM crates; it therefore has no OpenSSL runtime dependency.

The process contract for `weblounge-server` is:

- listen on `127.0.0.1:8098` by default (`--listen` / `PUSH_RELAY_LISTEN`);
- put SQLite at `<state-dir>/push-relay.sqlite3`, with `./state` as the development default
  (`--state-dir` / `PUSH_RELAY_STATE_DIR`);
- keep the state directory mode at 0700 and the WAL-mode database at 0600, with SQLite
  `user_version` tracking schema migrations;
- serve the database-backed health check at `GET /healthz`;
- read the relay VAPID PEM from `--vapid-key-file` / `PUSH_RELAY_VAPID_KEY_FILE` and the concierge
  client secret from `--concierge-secret-file` / `PUSH_RELAY_CONCIERGE_SECRET_FILE`;
- call `--concierge-url` / `PUSH_RELAY_CONCIERGE_URL` as Basic client `push-relay`; and
- allow browser calls to the device and route APIs only from the comma-separated exact HTTP(S)
  origins in `--allowed-origins` / `PUSH_RELAY_ALLOWED_ORIGINS` (empty by default); CORS permits
  `Authorization` and `Content-Type` without credentials and never applies to `/v1/r/:route`; and
- use `https://push.weblounge.org` as the default VAPID audience and route origin, overridable with
  `--origin` / `PUSH_RELAY_ORIGIN` for tests or another deployment.

Web targets are restricted to `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`web.push.apple.com` and Edge's `*.notify.windows.com`. Registration and every delivery resolve
the target again, reject the whole answer set if any address is non-public, then try the validated
addresses IPv4-first until one connects, with each HTTPS connection pinned and all attempts inside
the existing 15-second delivery deadline. Concierge calls and DNS resolution each have a
five-second deadline. An account may
hold at most 20 devices and each device at most 25 live routes; dead routes do not consume the
route limit. Slice 1 stores only Web Push targets; APNs and FCM target variants return 501. Leases,
held pushes, and the Web Push urgency policy are implemented; application rate limits remain a
later slice.
Delivery logs contain only an eight-character route-id prefix and the resulting HTTP status; they
never include authorization, device secrets, endpoints or bodies.

### Page client slice 2 implementation (2026-11-03)

Hosted `config.json` may contain `push: { relay, relay_vapid }`. Absence disables the complete
page subsystem. The decoder accepts the block only on hosted deployments, requires `relay` to be
an exact HTTPS origin, and verifies that `relay_vapid` is a base64url uncompressed point on P-256.
Unknown keys are forward-compatible and recorded for `/debug`, while malformed known keys still
reject the configuration. Cached deployment configuration goes through the same decoder before it
can enable push. Beta's CSP permits the production relay origin.

The engine's web IndexedDB schema now has a real `Space::Durable` object store. The relay device id
and redacted device secret are read, written and cleared through a narrow engine protocol; they are
never placed in local storage or the page-owned database. Device creation is serialized across
tabs with a Web Lock and rechecks durable storage inside the lock, so one hosted browser profile
creates one relay device. Route creation, replacement, activation and deletion are likewise locked
per network so tabs sharing the engine cannot create competing relay routes. Cache storage may
still fall back to memory, but Durable fails closed when IndexedDB is unavailable.

The page owns `weblounge-push-v2`, with one route record keyed by pinned home VAPID key. A bounded,
failure-tolerant service-worker update wait precedes push setup. The page and current worker create
the new database directly, then copy routes and badge state by opening deployed `weblounge-push`
without requesting a version change. A deployed page may therefore retain its old connection
without blocking current push delivery; a missing old database is also valid. Each record
contains its relay device id, current `NetworkId` and label, relay endpoint, public key, auth secret
and a non-extractable ECDH private `CryptoKey`. Each route receives independently generated P-256
and 16-byte auth material. The one-time copy migrates route-id-keyed records deployed in build
`3252cde0a0221c58dc7f54e78efeb49cf226efd5` by keeping one record per home, preferring an active
record over a retiring duplicate and then a complete record. Records without a device id or label
are exact-unregistered and removed on first convergence.

On each eligible connection the engine emits one `PushRouteRequired` to the active shell. The page
buffers it until setup is ready, upserts the browser target, calls the relay's idempotent
`ensureRoute(home_vapid, my_route_id?)`, drains dead endpoints, and sends one
`EnsurePush { route, unregister }`. Only `PushState::Registered` activates the probing route.
Reconnect reuses the relay-owned route, while a changed home or relay VAPID key starts convergence
for the new key. Activation failure is retried; a dead route rotates. `invalid_parameters` rotates
once per connection, `registration_limit` drains dead endpoints and retries once, temporary errors
keep the current route and back off, and `web_push_forbidden` deletes the route and remains visibly
off. Relay 410 clears the dead device and re-upserts; 401 enters hosted reauthorization.

The relay owns reconciliation and retires every duplicate live route for the same device and home.
Its dead-endpoint drain returns at most five endpoints for the requested home VAPID key. The page
acknowledges only after the engine has exact-unregistered them, so failures are re-offered before a
later REGISTER instead of losing cleanup work. Local legacy route keys likewise remain until the
relay convergence call succeeds. Hosted sign-out attempts every exact IRC unregister but always
deletes the relay device and local records even when IRC is unavailable.

Every registration outcome carries the route id that produced it. The engine emits even an older
generation's command result instead of silently dropping it, while only the current generation
changes engine state. `attach_shell` replays status but never replays route activation work to every
tab. A successful REGISTER schedules a route-scoped refresh after 24 hours.

`ensurePushSubscription` never prompts: permission must already be `granted`. On every launch,
return to visible and `pushsubscriptionchange`, the page calls `getSubscription()`, replaces a
subscription pinned to an older relay key, and upserts the resulting target. Live `relay_vapid`
changes dispose the old synchronizer and rebuild it. Failed setup promises are cleared so a later
visibility or worker event can retry.

Unit coverage uses a fetch-backed fake relay and deterministic engine/route stores. Chromium
Playwright stubs `PushManager.subscribe`, drives hosted startup through a fake relay, and proves
device and route creation occur before the engine boundary while activation waits for
`Registered`. It stops there: the local Ergo profile still lacks the documented TEST-NET address,
test CA and relay target-allowlist seam needed for a real registration probe.

### Lifecycle incident evidence (2026-11-04)

Relay records from the affected iPhone show that its endpoint, P-256 key and auth secret remained
unchanged after device creation. Apple returned 201 for that target at 15:57 and 18:50 UTC, so a
browser subscription rotation is unlikely to explain the observed silent delivery. Launch and
visibility target upserts remain a robustness boundary, but the primary recovery paths are the
worker's blocked-IndexedDB deadline, its generic fallback when a route key is unavailable, and
serialized notification cleanup. Chromium coverage exercises all three, including simultaneous
deliveries to separate conversation tags.

At 19:24:33 UTC the affected iPhone incremented the app badge for push test 6 without leaving a
visible notification, while Firefox showed the same push. Luiz later reported that the badge
appeared only after a noticeable delay without opening the app. That makes a pre-presentation
IndexedDB stall a leading hypothesis alongside immediate cleanup: the deployed ordering could wait
on message storage before calling `showNotification`, allowing iOS to abandon presentation before
the delayed handler reached its badge work. Visible delivery now presents immediately after the
bounded route-key read, decryption and parsing; message handoff and badge persistence happen only
after `showNotification` resolves. A two-second fallback independently guarantees a generic
notification if those prerequisite steps stall.

Cleanup also compares notification server time with the stored read marker and cannot close a newer
notification; the visible-delivery path does not run cleanup. Chromium deterministically delivers
an encrypted message followed by a cleanup control and asserts that the newer notification remains,
and holds an old push-database connection open while asserting generic presentation within the hard
deadline. Playwright WebKit exposes no equivalent synthetic Web Push delivery API, so the final
presentation check remains on the iPhone device checklist.

Firefox desktop also reproduced the deployed control bug: reading a DM in Halloy immediately
created a generic "New message" notification. The deployed worker treated the successfully parsed
`MARKREAD` presentation like an unknown payload. The redesigned worker returns from its control
branch before `showNotification`, advances the marker, closes the covered DM notification and
recomputes the badge. Chromium exercises that path through CDP delivery. Playwright Firefox's
headless notification backend returns `NS_ERROR_FAILURE`, so its scoped E2E worker is compiled from
the exact production worker source with only the unavailable OS-notification boundary replaced by
an in-worker ledger. It still decrypts and parses the encrypted envelopes, persists the marker,
closes the covered notification and recomputes the badge in Firefox. The production build check
proves that the message injection and ledger are absent from the shipped worker.

The same Halloy read left the affected iPhone PWA's icon badge stale. Production carries the
`9975d8d` backport, and relay logs confirm that its normal-urgency `MARKREAD` was acknowledged but
not forwarded to Apple while the equivalent Firefox control was forwarded. A suspended page can
therefore retain the worker's last count even when its engine buffers already hold the authoritative
read state. Launch hydration, every engine counter change and every return to the foreground now
enqueue a serialized replacement of the worker's aggregate and per-conversation counts.
Serialization ensures an older foreground snapshot cannot finish after a newer read-marker update.
WebKit E2E seeds that dropped-control state on an Apple endpoint while the page is backgrounded,
foregrounds the app and asserts that both the icon badge spy and worker state converge to the
engine's zero count.

The live relay's route convergence reduced the phone to one route, while the deployed client could
still delete that relay route without a confirmed IRC UNREGISTER, leaving an Ergo slot until the
next push received 404. The redesigned page exact-unregisters before ordinary and forbidden route
retirement. Every relay retirement also queues the exact endpoint in the account-wide drain, so a
later `EnsurePush` retries cleanup even when the immediate UNREGISTER or sign-out cannot complete.

### Service-worker client slice 3 implementation (2026-11-03)

The classic worker is generated from typed source as one self-contained script. It imports only
the classic `wasm-bindgen` parser bootstrap, loads the parser Wasm from the versioned shell cache,
and keeps the existing same-origin GET-only fetch boundary. `crates/push-payload` is a pure
`papo-proto` adapter for message, notice, action, invite, MARKREAD and PING lines. Its optimized
Wasm is 46,764 bytes under a build-enforced 128 KiB ceiling; both bootstrap and Wasm are explicit
precache entries.

Push delivery is serialized. It reads the route's non-extractable P-256 key through the route-id
index, derives the RFC 8291 content key and nonce with WebCrypto ECDH and HKDF, decrypts AES-GCM,
and sends only the plaintext IRC line to the parser. Visible chat lines carry the sender, body,
stable `<networkLabel>/<buffer>` tag and buffer route. The worker presents that notification before
opening the engine database for message handoff or the push database for badge persistence.
Successfully parsed `MARKREAD` and `PING` are silent cleanup controls; unknown routes and failures
fall back to one generic notification. Only a decryption failure marks the current route for
replacement, because a parser failure does not imply that its key material is stale. The
two-second presentation and shorter IndexedDB deadlines keep a blocked route-key upgrade
from preventing the generic fallback.

Chat pushes are written as versioned `pushed-message\0...` records in the engine's Cache object
store. The web engine scans at most its 500-row timeline budget before connecting and exposes an
explicit reload request for a warm notification tap. Both paths feed the ordinary timeline insert,
so ordering, unread projection and `msgid` deduplication against history or live delivery retain
one source of truth. A cold cached timeline can reveal the addressed buffer while IRC is offline;
an `open-route` message remains pending in a warm page until the engine creates that buffer.

Playwright uses the full Chromium channel because its legacy headless shell hard-denies
notification permission. CDP delivers envelopes encrypted from the stored route keys and asserts
the routed notification plus decrypt and parse fallbacks. With local Ergo, the browser starts from
the cached deep link while offline, shows the pushed row, reconnects, receives the same `msgid`
from CHATHISTORY and still renders it once. The unmocked Ergo → relay → push-service half remains a
later infrastructure slice.

### Badge and active-device slice 4 implementation (2026-11-03)

The relay now stores per-tab leases and opaque held pushes in SQLite. Leases are account-wide for
delivery decisions: any unexpired tab on any device holds pushes for every device on that account.
A renewal atomically discards ciphertext held before it, because the foreground account has read
past that delivery point. Releasing the last tab or letting every lease expire wakes one persisted
delivery drainer; upstream death still marks all routes on the target device dead. Release accepts
the ordinary authenticated JSON request and a form-encoded POST carrying the device secret, which
lets a cross-origin `sendBeacon` release without a preflight or custom headers.

The page derives foreground from visibility and focus once, feeds that result to the existing
engine `setVisibility` boundary, and uses the same result for its per-tab relay lease. It renews
every 30 seconds while foreground and clears the heartbeat before release on blur, hide,
`pagehide`, or disposal. A renewal that finishes after hiding cannot recreate the timer. Relay
credentials flow directly from existing durable storage or device creation into the lease, so the
page never polls.

The app-icon badge is the unread count of direct buffers plus the mention count of other buffers.
The page overwrites both the Badging API and a versioned `weblounge-push-v2` counter from engine
projections; zero uses `clearAppBadge`. After showing a notification, the classic worker atomically
increments that counter and applies it through its own Badging API. Both sides feature-detect and
remain inert when the deployment has no `push` block. Urgency filtering, application rate limits,
stable network identity, and the unmocked delivery chain remain later slices.

### Permission prompt slice 5 implementation (2026-11-03)

The desktop sidebar and mobile chat list show one compact notification prompt only when push is
configured, Web Push is available, browser permission remains `default`, and the device has not
dismissed it. iOS additionally requires the installed `display-mode: standalone`; Android and
desktop browsers do not. The UI waits for the engine-owned preference read before painting, so a
remembered dismissal never flashes during startup.

If the Settings-space read fails or remains pending past a bounded deadline, the page treats the
prompt as not dismissed. Losing access to optional preference storage must not permanently hide
notification setup. The debug overlay reports the configured, supported, permission, dismissed,
iOS, and display conditions so a suppressed prompt can be diagnosed from the affected browser.

Background deployment-config revalidation publishes a compatible `push` block into the running
page. The prompt preference load and granted-permission startup react to that live value, so adding
push at the server does not require one more launch.

The tap handler calls `Notification.requestPermission()` before doing any asynchronous work. A
grant enters the existing subscription, relay-device, route, and IRC registration path; denial
hides the prompt without starting push. Explicit dismissal writes a versioned record through the
engine's Settings space. The web database now implements that approved space as its own IndexedDB
store rather than letting the page own settings persistence.

Fresh-profile Firefox and Chromium drive the built app with push configured and a stalled
preference read, while Chromium desktop, Android-profile Chromium, and installed-iPhone-profile
WebKit cover permission, relay registration, dismissal across reload, and denial. The visible
prompt also passes the native-feel and idle-work audit; light and dark references cover both shell
placements.

### Push observability implementation (2026-11-04)

The relay emits info-level structured events to stderr for successful device, route, and lease
lifecycle changes; every inbound push disposition; and each push-service HTTP response. Device and
route fields are eight-character prefixes, upstream targets are hostnames only, and tests capture
the output to prove that credentials, endpoint paths, tab ids, and opaque bodies are absent.
Inbound refusals distinguish the pinned VAPID key, JWT, and body-size boundaries without logging
their inputs. These logs are operational only: they contain no account names, nicks, IP addresses,
or other personal identifiers.

The page retains the latest typed `PushState` per network and receives a narrow diagnostic
projection from `PushSynchronizer`: `none`, `probing`, `active`, or `dead`, an optional eight-character
route prefix, and a classified last operation error. `/debug push` combines those values with the
configured, supported, permission, dismissed, iOS, and display prompt inputs. Every other debug
section includes the same secret-free per-network summary. A real papo wire test covers Ergo's
`FAIL WEBPUSH INVALID_PARAMS ... :Test push message failed to send` as
`Failed(InvalidParameters)`, and the hosted browser journey renders that failure after observing
the route move through probing and active.

### Web Push urgency policy implementation (2026-11-04)

Active Web Push routes accept RFC 8030's `very-low`, `low`, `normal`, and `high` urgency values,
defaulting a missing header to `normal`. Mozilla endpoints pass `normal` and `high`; Apple, FCM and
Windows Push endpoints pass only `high`; lower urgencies return 201 without forwarding. Probing
routes still return 201 before inspecting headers because registration probes must succeed
independently of a home's urgency choice. Structured inbound logs record the parsed urgency and
dropped, held, or forwarded outcome without inspecting ciphertext.

### Read-elsewhere cleanup implementation (2026-11-04)

The worker persists versioned per-conversation notification counts and read timestamps beside the
aggregate badge. Visible message and invite pushes increment their notification tag. Chat
notifications also carry their tag, `msgid` and server time in notification data. A decrypted
`MARKREAD` stores the `timestamp=` reference, zeros the matching count and closes only notifications
from that conversation at or before the marker. A maintenance `PING` repeats marker-bounded cleanup
without calling `showNotification`; both controls are silent even if count persistence fails and
regardless of the request's urgency. Visible and generic pushes do not perform cleanup. Production's
patched Ergo sends these controls at normal urgency, so the relay keeps them away from Apple, FCM
and Windows Push while forwarding them to Mozilla.

An unpatched or different home can still send a control at high urgency, which the opaque relay must
forward. That is a residual Apple compatibility risk, not the production weblounge path. WebKit
requires every handled push to produce a visible notification and explicitly says a badge update
does not count. Our Declarative Web Push envelope also gives Safari a generic proposed notification;
WebKit may display that fallback when the worker intentionally produces no replacement
(https://webkit.org/blog/16535/meet-declarative-web-push/). If it treats the handler as a silent-push
violation instead, it may revoke the subscription. The worker still must not synthesize a
misleading "New message" for a successfully parsed control. Launch and foreground subscription
refresh recover a revoked subscription when permission remains granted; engine-owned foreground
reconciliation repairs stale badges.

While the page is open, engine counters and read markers replace the worker's per-tag baseline and
the aggregate badge. Initial buffer hydration and subsequent counter changes scan notification data
and close only messages at or before each engine marker, even when the same conversation has newer
unread messages. Opening or foregrounding the app explicitly repeats that serialized replacement.
This is the correction path on iOS, where production intentionally drops normal-urgency controls.

## Rollout

- **v1: first-party Ergo, web/iOS/Android PWA through the relay.** Prerequisites: Ergo backups
  (see Failure modes); a stable
  `NetworkKey`; a manifest `id` and a monochrome badge icon; the shared mention classifier;
  `config.json` gains
  `push: { relay, relay_vapid }` (`DeploymentConfig`, `ts-rs`, `beta-client.nix`); CSP `connect-src`
  gains `https://push.weblounge.org` (`app/csp.ts`, `vite.config.ts`, `beta-client.nix`). Then the
  relay MVP (web targets), engine wiring (`Feature::WebPush` in `client_builder`, `lib.rs:120-122`),
  and the service worker and page. Platform order: desktop Chrome/Edge/Firefox; the iOS PWA after a
  week of dogfooding the deployed `9975d8d` backport; Android; desktop Safari. Any other
  single-network Ergo with webpush uses the same path.
- **Then: bring-your-own soju** on the same path, once the engine supports multiple networks
  (`runtime.rs:130-140` holds one network).
- **Later: Tauri native.** Desktop gets local notifications while running (decision 5). iOS: APNs
  alert pushes (`mutable-content: 1`, not background pushes, which are throttled and dropped after
  force-quit) and an NSE declared as an app-extension target in Tauri's XcodeGen template
  (`bundle > iOS > template`, added in tauri-cli 2.0.0-rc.2; current key name **[unverified]**),
  never by hand-editing `gen/apple`. XcodeGen has no NSE type, so the template supplies its
  Info.plist and source. Route keys go in a shared keychain access group; the route → network and
  buffer map, and each pushed message for tap before history, in the App Group container; the NSE has ~24 MB and ~30 s. Android: FCM data messages,
  and UnifiedPush (whose endpoints are Web Push endpoints). Desktop push, if ever: macOS APNs,
  Linux UnifiedPush; Windows App SDK push works unpackaged with a sparse package for identity, an
  Azure AppId, and 30-day channel expiry.

The first two client slices keep the platform/IRC boundary explicit before stable network identity
lands. The page creates and owns each relay subscription and route; the engine accepts its opaque
route material, owns the IRC `REGISTER`/`UNREGISTER` exchange, and reports `Registered`,
`RegisteredButNoDelivery`, `Unsupported`, or a typed `Failed` outcome. A reconnect refreshes an
existing registration. A changed home VAPID key instead emits a route-replacement request so the
page can unregister the old endpoint, discard its relay route, and create one pinned to the new
key. Hosted sign-out
and explicit network removal unregister before quitting; a transient socket disconnect retains
the registration so it can keep delivering while the client is offline. These slices key engine
state and page route records by the current `NetworkId`; durable `NetworkKey` storage and route
migration remain a v1 prerequisite above.

## Failure modes

| Failure | Behaviour |
|---|---|
| permission denied or dismissed | No push; the page notifies while open; status says "off in system settings". Never re-prompt automatically. |
| iOS subscription revoked | Detected at launch (`getSubscription()` null or changed). Re-subscribe silently if still permitted and re-register every home with new routes; else show the status. |
| home refuses (`MAX_REGISTRATIONS`, `FORBIDDEN`, no account, Tor) | `PushRegistration::Failed` in network status. Limit drains relay-known dead endpoints once; invalid parameters rotate once; forbidden retires the route; temporary failures keep it for backoff. |
| soju's 25-subscription cap | soju sends it as `INTERNAL_ERROR`, indistinguishable from other errors, so the engine counts its own registrations and reports `RegistrationLimit` at 25. |
| `RegisterOutcome { persistence_required: true }` | `Unavailable(PersistenceOff)` plus a hint to turn always-on back on. |
| Ergo's VAPID key lost | It lives in Ergo's datastore; losing it breaks every pinned route. Ergo backups are a v1 prerequisite. |
| relay down | Homes retry or drop by their own policy (Ergo: 16-push queue, drops on overflow). Messages stay in history. |
| route leaked or abused | Pinned VAPID rejects other signers; rate limits; the device can rotate the route. |
| home's VAPID key changes | The relay rejects the new signer. At the next refresh the engine sees a new `vapid` and creates a new route. |
| lease outlives the page | Held pushes are delivered when it expires: late by ≤ 75 s, not lost. |
| stale notification or badge after reading elsewhere (web) | A delivered control is handled silently; opening or foregrounding the app reconciles from engine state if background cleanup was missed. |
| service worker update pending | New handlers apply once old clients close; the declarative fallback keeps iOS pushes visible meanwhile. |
| inner decrypt fails | One generic "New message" for that network; the route is marked for re-registration. |

## Privacy and security

- **Message content** is end-to-end encrypted from home to device (RFC 8291), padded to a fixed
  record. The relay, Apple, Google and Mozilla see timing, urgency and device. It isn't
  forward-secret (Ergo `docs/MANUAL.md:520-530`).
- **Homes see plaintext.** Our Ergo already does; a user's own bouncer is theirs to trust.
- **Private keys** never leave the device; papo redacts the auth secret in logs.
- **Relay abuse:** device creation needs a weblounge session; routes are unguessable, VAPID-pinned
  and rate-limited.
- **The lease** reveals "device in use now" to the relay, the same class of metadata it already
  sees.

## Testing

- **Pure crates** (`push-payload`, `notify-rules`): RFC 8291 §5 vectors; captured Ergo and soju
  payloads (PRIVMSG, NOTICE, ACTION, INVITE, MARKREAD, PING, truncated multiline); mention tables
  (nick ≠ account, casemapping, `-_|`, URLs, nick changes) checked against `highlight.go`; the rule
  fold (mention in a muted buffer, keyword vs Buffer rule, inherited `None` fields).
- **Engine** (`papo_testing::wire()`): REGISTER when `ConfigurePushAction` is present and none
  without account or VAPID; daily refresh; UNREGISTER on sign-out; each typed refusal becomes
  `Failed`; a VAPID change forces a new route; a stored pushed message shows before connecting and
  is deduplicated by `msgid` against chathistory and live lines.
- **Relay** (Rust integration tests): probing → active (probe discarded with 201), VAPID pin and JWT
  `aud`/`exp`, 404 for dead routes and after a 410 upstream, 413 over budget, TTL passthrough,
  SSRF refusals (private and loopback resolution, redirects), urgency policy, per-tab leases with hold/discard/deliver, rate limits, envelope bytes against fake
  upstreams.
- **Local Ergo end to end** (`nix run .#ergo-weblounge`): the fixture gains `webpush.enabled`, the
  production `9975d8d` backport and the relay; two papo clients drive a DM and a mention; the relay's
  sink records envelopes; the read-elsewhere case asserts that normal-urgency `MARKREAD` is dropped
  for Apple, forwarded to Mozilla, and silently applied by the Firefox worker. The unpatched stock
  Ergo 2.19.1 scenario is intentionally skipped because it is not the production package. Ergo
  requires `https` (`webpush/security.go:26-35`) and its dialer refuses loopback, private,
  link-local and CGNAT addresses (`security.go:67-76`), but Ergo 2.19.1's `isInternalIP` does not
  block TEST-NET-3. So no Ergo patch: the relay, as Ergo's push target, listens on a 203.0.113.0/24 address with a test CA
  that Ergo trusts, reusing papo's `nix/webpush-receiver.nix` once it lands. Our relay, in turn,
  refuses documentation addresses and unlisted hosts and trusts only WebPKI roots, so the test
  starts it with a test-only target allowlist and CA for the fake push service; the binary has no
  such seam yet.
- **One unmocked chain.** One test runs the whole path with no stubs between the ends: Ergo sends a
  real encrypted push → our relay → the fake push service → CDP `ServiceWorker.deliverPushMessage`
  → the service worker decrypts and parses it with the real `papo-proto` → the notification → the
  tap opens the buffer.
- **Upgrade guard.** The captured Ergo and soju payload fixtures are recorded from that end-to-end
  run and checked in. The `push-payload` tests over them and the full chain run in CI on every
  push, so every papo or `papo-proto` bump commit must pass both.
- **Playwright** (Chromium, built app; no service worker in dev): Playwright's Chromium has no push
  service, so `PushManager.prototype.subscribe` is stubbed with `addInitScript` to return a fake
  subscription, and delivery uses CDP `ServiceWorker.deliverPushMessage` with the sink's envelope.
  Specs: enable notifications through the UI and see "on" in network status; delivered push →
  `getNotifications()` shows title, body, tag and `data.route`; a focused page produces no
  delivered envelope; opening the buffer closes its notifications; app badge via a stubbed
  `setAppBadge`; the page side of `open-route` (warm) and the deep link (cold), with the
  `notificationclick` routing function unit-tested; tap before history: on a cold start with the
  IRC connection blocked, the tapped buffer shows the pushed message, and once the connection and
  chathistory deliver the same `msgid` it still appears exactly once. `nativeFeelAudit` and the idle/hidden checks
  stay green with the lease heartbeat.
- **Device checklist** (iPhone 16 Pro, an Android phone), recorded in PLAN.md: a week without
  revocation, tags, badge, cold and warm tap, the generic notification on decrypt failure, a missed
  lease release (late, not lost), behaviour after force-quit.

## Conflicts with signed-off text (to fix on approval)

- **Brief §3.12** says Web Push doesn't use the relay. Here it does (decision 1). Web push can stay
  free; that is pricing, not architecture.
- **Brief §3.10** says push works only on servers with `draft/webpush` and points users to soju.
  That stands; push to those servers now goes through our relay with a weblounge account, and the
  per-network copy is "This network doesn't support notifications while weblounge is closed"
  (prototype: "on networks that support push", `Mobile.dc.html:861`).
- **`19-packaging.md:11`** puts Web Push out of scope. The service worker gains push handlers, a
  precached parser and writes of pushed messages to the engine's cache, with no change to its fetch
  rules.
- **The engine's mention rule** (`state.rs:2090-2098`) contradicts brief §3.8 and
  `01-engine-state-model.md:196-197`; `notify-rules` fixes it.

## Decisions (2026-11-02)

1. **Our own push relay** (push.weblounge.org) for every platform, including the web.
2. **No hosted bouncer** for now (see Future). Networks without webpush get no push and say so;
   bring-your-own soju or any webpush-capable server gets push through the relay.
3. **The relay requires a weblounge account** (concierge session).
4. **Cross-device quieting** relies only on the relay lease: pushes are held on all your devices
   while any of them holds one.
5. **Tauri desktop:** local notifications while running, tray/menu-bar and start-at-login option,
   no push when quit.
6. **The account-wide lease is acceptable for v1.** Renewing activity on one device may discard
   held pushes for the account; an activity-based lease is a later optimization.
7. **Control pushes are silent wherever delivered.** A successfully decrypted `MARKREAD` or `PING`
   never makes the worker create a notification; it only clears notification state or lowers the
   badge, regardless of urgency. Production's patched Ergo emits controls at normal urgency, which
   the relay forwards only to Mozilla. A different home that mislabels a control as high retains the
   Apple declarative-fallback or subscription-revocation risk; a badge update cannot satisfy
   `userVisibleOnly`.

**Deferred (not v1): where notification rules live.** Proposal: per account on each home (our
Ergo, a self-hosted soju each hold their own), replicated by the client as the merge
point, with only "push on this device" and `AppBadge` kept on the device. This would override
`22-storage.md:43` ("no settings sync"). The transport would be a vendor extension
(`weblounge.org/notify-rules`) in our patched Ergo, contributed to soju.

## Future: hosted bouncer

Maybe later, not today: a members-only hosted soju (bouncer.weblounge.org) would bring push to
third-party networks. It would reuse `auth oauth2` against concierge, `upstream-user-ip` with an
IPv6 prefix for per-user source addresses, and built-in identd, and would need a heads-up to Libera
and OFTC staff. Ergo would stay direct rather than behind it: double bouncing has recorded defects
in papo (`~/papo/docs/conformance-matrix.md:188-222`). It would store members' third-party messages
and network credentials, which onboarding would have to say.

## Appendix A: server asks

In deploy order:

1. Concierge: an introspection client for the relay in concierge's per-client table (client id
   `push-relay`, its own secret, loopback only). No entitlement endpoint.
2. The relay host at push.weblounge.org: `services/push-relay.nix` in the `weblounge.sandbox`
   pattern, DNS, a cert, an nginx vhost with `limit_req` and `client_max_body_size` of about 4 KB,
   egress on 443 to push services (later APNs and FCM), SQLite state, loopback health checks, smoke
   tests, an #ops alert and `tests/e2e/push.py`. Secrets via sops: the relay's VAPID P-256 key pair
   (public key published in `config.json`); later an APNs `.p8` (team id, key id) and FCM
   service-account credentials.
3. Keep the production `9975d8d` backport in `~/weblounge/pkgs/ergochat.nix` until an Ergo release
   contains it, and raise `webpush.max-subscriptions` from the default 4 (`default.yaml:1205`) to 10,
   since each browser, phone and later native app uses one slot. The backport makes the maintenance
   PING and MARKREAD `UrgencyNormal`; the registration probe stays high, which the relay's probing
   state handles.
4. `beta-client.nix`: add `https://push.weblounge.org` to CSP `connect-src` and serve
   `push: { relay, relay_vapid }` in `/config.json` once `DeploymentConfig` lands.

Also before v1: backups of Ergo's datastore, which holds its VAPID key (see Failure modes).

Test only: the Ergo patch letting webpush post to a loopback HTTPS endpoint
(`security.go:26-35,67-76`) goes in test overrides, never the deployed Ergo; the relay sink gets TLS
from the local test CA.

Not in v1: an Ergo patch so channel highlights match the current nick as well as the account
(`irc/channel.go:1445-1460`, `irc/webpush/highlight.go`); the hosted bouncer (bouncer.weblounge.org,
`upstream-user-ip`, though credenza is IPv4-only, `hosts/credenza/networking.nix`; identd, egress on
6697, a staff heads-up).

## Appendix B: papo asks

1. Fix the stale doc comments on `webpush().register`/`unregister` (`ext/webpush.rs:58-59,87-88`),
   which say refusals are `Refusal::Other`.
2. Accept Ergo's real success reply, `WEBPUSH REGISTER <endpoint> <keys>`, in tests; the fixture
   uses `WEBPUSH SUCCESS` (`ext/webpush.rs:152`).
3. Web push conformance scenarios against Ergo 2.19.x and soju 0.11.x: register, refresh,
   unregister, limit, `FORBIDDEN` without an account, and register on a bound soju network
   (`docs/ircv3-support.md:50-51` lists no coverage).
4. Confirm that the `unstable` feature (already enabled, `Cargo.toml:14`) is fine to ship with the
   webpush and bouncer APIs (`docs/design/README.md:153` lists it as open).
