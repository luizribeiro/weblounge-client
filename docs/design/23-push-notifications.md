# 23 — Push notifications

Status: draft, awaiting Luiz's decisions (2026-11-02). Implementation waits for them. This is the
brief's subsystem 7; it overrides the earlier statements listed under "Conflicts with signed-off
text".

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
4. **Every push must show a notification on iOS.** WebKit revokes a Web Push subscription after
   pushes that show nothing (WebKit commit 108ccb442e40, "Enforce silent push quota"; Discourse hit
   it: https://meta.discourse.org/t/290225). WebKit's blog says a missed notification can revoke it
   "for any reason"; the grace count is **[unverified]**, so we design for zero. A native NSE can't
   drop a push either without Apple's discretionary `usernotifications.filtering` entitlement.
   Ergo sends pushes that are meant to be silent: the registration test `PING` (high urgency,
   `irc/handlers.go:4384-4390`), a maintenance `PING` when no push has succeeded for over half the
   14-day expiry (checked every 24 h, `irc/server.go:46,346-351`) and `MARKREAD` when a buffer with a
   still-clearable push is read elsewhere (`handlers.go:3265-3274`; never to the endpoint that sent
   the MARKREAD, `client.go:2101`). Ergo 2.19.1 sends all of them at high urgency
   (`client.go:2127`); upstream PR #2471 (merged 2026-10-22, unreleased) makes the maintenance PING
   and MARKREAD `UrgencyNormal`. The registration PING stays high.
5. **The device can't apply notification rules, so the sender must.** Pushing too much can't be
   undone on iOS (fact 4), and pushing too little can't be fixed while the app is closed. Every
   future rule has to be evaluated by whatever sends the push.

## Goals

- **One model for every network and platform.** Each network is reached through an always-on
  *home* that speaks `draft/webpush` (or `soju.im/webpush`); every device receives pushes through
  one weblounge *push relay*.
- **v1 has no settings.** It notifies on DMs and mentions, which is what homes already push. The
  only control is the one-time "Turn on notifications" step the OS requires.
- **Tapping a notification opens the right buffer**, from a cold start and when the app is open.
- **Never a silent push to iOS. Never a duplicate** while the user is looking at the app.
- **Room to grow without changing the wire format:** per-buffer, per-sender and per-network rules,
  all/mentions/none, keywords, and push and badging controlled separately.
- **The relay never sees plaintext.** It is a small, documented, replaceable service (brief §3.11)
  with the entitlement hook from brief §3.12.

## Non-goals

- Settings UI, rule editing, quiet hours and per-device schedules in v1.
- Push for networks reached directly with no home. Those notify only while the app runs, and the
  UI says so.
- Payments and the entitlements service. The hook allows everyone.
- Reactions, replies-to-you and other Activity kinds as push triggers (Activity, 06).

## Architecture

```text
 IRC network ──► home (always-on, speaks webpush) ──POST aes128gcm──► push relay ──► platform push service ──► device
                 • weblounge.org: Ergo itself                         push.weblounge.org   • browser push svc (Web Push)
                 • 3rd-party: hosted soju (decision 2)                 pins home VAPID     • APNs (Tauri iOS, later)
                 • the user's own soju / Ergo                          wraps, never decrypts • FCM / UnifiedPush (later)
                 • direct (no home): no push, local notifications only
```

### Homes

A network's `Endpoint` is `Direct(url)` or `BouncerBound { bouncer, netid }`. Push depends only on
what that connection negotiated: `Feature::WebPush`, an account and the `VAPID` token. Who runs the
server doesn't matter.

| Network | Home | What it pushes today |
|---|---|---|
| weblounge.org | Ergo (always-on opt-out, `~/weblounge/services/ergo.nix:132-158`) | every DM, plus channel lines containing the account name (`irc/channel.go:1445-1460`) |
| Libera, OFTC, private | hosted soju, one bound connection per network (`ClientBuilder::bouncer_network`, papo `builder.rs:258-276`) | DMs, nick highlights and INVITEs, minus `soju.im/muted` / `soju.im/blocked` targets (soju `upstream.go:767-806`) |
| the user's own soju or Ergo | itself | as the matching row above |
| direct, no webpush | none | nothing; local notifications while running |

Ergo stays direct rather than behind soju: double bouncing has recorded defects in papo
(`~/papo/docs/conformance-matrix.md:188-222`).

Hosted soju (decision 2) reuses what soju has: `auth oauth2` against concierge introspection, so
members get no separate bouncer password; `upstream-user-ip <cidr>` for a per-user source address
(soju(1) says it is "to avoid having the whole bouncer banned"); and built-in identd. It caps each
user at 25 push subscriptions (`downstream.go:3745`). Its cost is `max-user-networks` per member
and disk for message storage under `message-expiry`.

### The push relay, on every platform (decision 1)

The brief (§3.12) says Web Push skips the relay. The PWA needs it too:

1. **One browser subscription serves N homes.** The browser subscribes once, with the relay's VAPID
   key.
2. **Network identity.** Each home gets its own relay *route* URL, so the device knows which network
   a push came from.
3. **No silent pushes to iOS.** The relay can drop pushes that would show nothing. Dropping a push
   is not a silent push; delivering one that shows nothing is.

**Device setup.** The device registers once with the relay and gets a `DeviceId` and a device
secret. Its platform target is a browser `PushSubscription` (later an APNs token, FCM token or
UnifiedPush endpoint). For each home it creates a **route**
(`https://push.weblounge.org/v1/r/<128-bit random id>`) with its own **P-256 key pair and auth
secret**. The private key stays on the device: a non-extractable `CryptoKey` in IndexedDB on the
web, the Keychain or Android Keystore natively.

**Route lifecycle.** `POST /v1/devices/:id/routes` carries the home's VAPID public key, which the
client already has from ISUPPORT (papo `Isupport::vapid()`, `isupport.rs:168`, already in
`ConfigurePushAction`). The relay pins it at creation; there is no trust-on-first-use window.

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
truncated, so the relay answers **413** to any home body over 2,800 bytes.

**Urgency policy.** `Urgency: high` (messages, INVITE, Ergo's probe) is delivered visibly.
Anything lower (maintenance `PING`, `MARKREAD`, soju's probe) is **dropped** for web targets; for
native targets it becomes an APNs background push or an FCM normal-priority message, which lets the
app clear notifications read elsewhere. This needs PR #2471 deployed (server ask).

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

**Cross-device quieting (decision 4).** The baseline lease is per device, so a phone still buzzes
while you type on your laptop. The proposal extends the hold to every device of the account while
any device holds a lease (devices are tied to one concierge account), plus Ergo `webpush.delay` of
about 10 s, which skips pushes for buffers marked read within the window. The client already sends
`MARKREAD` as soon as a buffer is visible and focused (`runtime.rs:1368-1430`); soju uses a fixed
5 s.

| Device state | Who posts OS notifications |
|---|---|
| push enabled on this device | push only; the page never posts its own `Notification` |
| push unavailable or denied, app open | the page, for buffers that aren't visible, deduped by `msgid` |
| Tauri desktop, running (decision 5) | the native engine, from its live connections; it never registers WEBPUSH |

### Service worker

`app/service-worker.js` gains `push`, `notificationclick`, `pushsubscriptionchange` and `message`
handlers. On `push`, inside one `waitUntil`:

1. Look up the route (network label, buffer map) in the `weblounge-push` IndexedDB database.
2. Decrypt the inner payload with **WebCrypto**: ECDH with the non-extractable key, HKDF, AES-GCM
   (about 80 lines of TS). Rust can't reach a non-extractable key, so the Rust `ece` path is for
   native targets only.
3. Parse the plaintext line with papo's parser compiled to wasm (papo ask), and call
   `showNotification` **exactly once**. Chrome and Firefox only check that a notification exists
   when `waitUntil` settles; Safari falls back to the declarative notification if the handler fails.
   A placeholder-then-replace would duplicate where `tag` replacement isn't supported.
4. Only if decryption fails: show the generic "New message" for that network and mark the route for
   re-registration.

The service worker is a classic, non-module worker with a precache list. The parser wasm joins the
precache, is instantiated from the Cache API, and has a `size-limit` budget; shipping a new parser
is an ordinary service-worker update. The worker never touches the engine, never fetches from the
network and handles no non-GET traffic (`19-packaging.md` stays true). It persists nothing beyond
the badge counter (see Conflicts, brief §3.8). iOS lacks `pushsubscriptionchange`, so the page
re-checks the subscription on every launch.

### Tapping a notification

`notification.data` carries the buffer route, e.g. `/weblounge/@mel` (`10-navigation.md:201-222`,
`app/src/navigation/buffer-route.ts`). On `notificationclick`, `clients.matchAll({type:'window',
includeUncontrolled:true})`; if a window exists, `focus()` it and post `{kind:"open-route", route}`
(a new channel: the desktop shell has no `popstate` handling today, only `MobileShell.tsx:503`
listens); otherwise `clients.openWindow(route)`, which works cold because the service worker serves
the cached `index.html` for any navigation.

The tag is `<networkKey>/<bufferKey>`. BCD says Safari doesn't support tags: **[verify on
device]**.

### Badging (separate from push)

- **Sidebar and chat-list badges** come from the engine's read markers (`BufferProjection.unread`,
  `.mentions`, `protocol.rs:251-258`).
- **The app-icon badge** uses `navigator.setAppBadge` where it exists (installed Chrome/Edge PWAs
  on Windows and macOS, Safari 17 web apps, iOS 16.4+ home-screen apps). While a page is open it is
  the sum of `mentions` (the engine counts every DM as a mention, `state.rs:1834-1835`). With no
  page open, the service worker increments a counter in `weblounge-push`; on launch the page
  overwrites it with the engine's value.
- **On the web the closed-app badge can only go up.** MARKREAD pushes are dropped for web targets,
  so reading elsewhere lowers it only when this device next opens. It undercounts when Ergo's
  16-item push queue overflows (`client.go:53`); a `delay` makes that likelier, because the worker
  sleeps per message (`client.go:2084-2098`). It matches the engine for DMs, and for channel
  mentions once the mention rules agree (below).
- When a buffer's read marker advances, the page closes its delivered notifications
  (`registration.getNotifications()` by tag). Linux, Firefox and Chrome Android have no badging API.

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
    Failed { reason: PushFailure, at: Timestamp },
}

pub enum PushUnavailable { NoWebPushCap, NoAccount, NoVapid, PersistenceOff, DirectConnection }
pub enum PushFailure { RegistrationLimit, Forbidden, InvalidParams, Internal, Relay(RelayError) }

/// Capability projection (17-capability-model.md:35,79); Some only when registration can work now.
pub struct ConfigurePushAction { pub network: NetworkKey, pub epoch: ConnectionEpoch, pub vapid: B64Url }

EngineRequest::RegisterPush { network: NetworkKey, route: PushRoute }
EngineRequest::UnregisterPush { network: NetworkKey }
EngineEvent::PushRegistrationChanged { network: NetworkKey, state: PushRegistration }
```

The platform seam: on the web the engine runs in a worker and can't call page code, so the seam is
the two requests above plus a TS `PushRegistrar` interface in `app/src/platform/push/`
(`ensureDevice`, `routeFor(home, vapid)`, `activateRoute`, `dropRoute`, `setForeground`). A Rust
`PushRegistrar` trait exists only for the native Tauri plugin. `Notifier` (`show`, `clear`,
`setBadge`) follows the same split.

`crates/push-payload` (pure, no I/O) holds the RFC 8291 decryption (Mozilla's `ece`) for native
targets and maps a papo-parsed line to
`PushEvent { Message { source, target, msgid, time, text, kind }, Invite, MarkRead { target, until }, Ping }`.

### One rule for mentions

Today they disagree. The engine matches the exact nick, case-sensitively, with `-` and `|` as
boundaries (`state.rs:2090-2098`). Ergo matches the casefolded account against the lowercased text,
with `-_|` as word characters and URLs excluded (`channel.go:1445-1460`, `webpush/highlight.go`,
copied from soju's). soju matches the current nick case-sensitively (`user.go:499-513`; a "TODO: use
case-mapping").

A pure `crates/notify-rules` owns the classifier: `mentions_self` = nick **or** account,
casemapped, with Ergo's boundary rule and URL exclusion. The engine badges with it from day one, so
nick-only mentions on weblounge.org keep badging; pushes are a subset until Ergo is patched to match
the nick too (server ask). The visible consequence: badges and pushes agree once that lands.

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
  refusals, bouncer binding and IRC line parsing. Weblounge never formats WEBPUSH itself.
- **Engine:** decides whether a network can register (`ConfigurePushAction`); registers on each
  connection that has a route and refreshes once per 24 h (Ergo expires after 14 d,
  `server.go:327-357`); unregisters on sign-out or network removal; persists `PushRegistration`;
  owns badge counts and the mention classifier; never holds a private key or talks to the relay.
- **Platform** (`app/src/platform/push/` on the web): asks for OS permission (from a user gesture
  on iOS and Firefox); creates the push subscription; talks to the relay; generates and stores
  route keys in its own `weblounge-push` database, since the engine's byte store can't hold live
  `CryptoKey`s; holds the lease; sets the app badge.
- **UI:** one "Turn on notifications" affordance, shown when a network has `ConfigurePushAction`
  and this device hasn't decided; on iOS only in an installed PWA (Safari tabs get "Add to Home
  Screen to get notifications"). Network settings show per-network status ("on / not available on
  this network / turned off in iOS Settings"). No rule controls in v1.
- **Relay** (`crates/push-relay`, in this repo per `docs/design/README.md:37,144`; brief §3.10 makes
  it infrastructure run for every user; deployed from `~/weblounge`):
  - API: `POST /v1/devices`, `PUT /v1/devices/:id/target`, `POST /v1/devices/:id/routes`,
    `PUT /v1/routes/:id/active`, `DELETE /v1/routes/:id`, `POST /v1/devices/:id/lease`,
    `POST /v1/devices/:id/lease/release`, and the public `POST /v1/r/:route` for homes.
  - Device calls carry the device secret. Creating a device requires a concierge session token,
    checked by introspection; that is the entitlement hook and decision 3.
  - It stores devices, targets, routes, pinned VAPID keys, counters, leases and held pushes (≤ 75 s)
    in SQLite, and refuses targets outside an allowlist of push-service hosts (no SSRF).

## Rollout

- **v1: first-party Ergo, web/iOS/Android PWA through the relay.** Prerequisites: a stable
  `NetworkKey`; `Space::Durable` on IndexedDB (`storage.rs:320-341` supports only Cache); a manifest
  `id` and a monochrome badge icon; the shared mention classifier; `config.json` gains
  `push: { relay, relay_vapid }` (`DeploymentConfig`, `ts-rs`, `beta-client.nix`); CSP `connect-src`
  gains `https://push.weblounge.org` (`app/csp.ts`, `vite.config.ts`, `beta-client.nix`). Then the
  relay MVP (web targets), engine wiring (`Feature::WebPush` in `client_builder`, `lib.rs:120-122`),
  and the service worker and page. Platform order: desktop Chrome/Edge/Firefox; the iOS PWA, gated
  on #2471 deployed and a week of dogfooding without revocation; Android; desktop Safari. Any other
  single-network Ergo with webpush uses the same path.
- **v1.1: hosted soju** for third-party networks, members only, with bring-your-own-bouncer on the
  same path. It needs multi-network support in the engine (`runtime.rs:130-140` holds one network)
  and the server prerequisites (decision 2).
- **Later: Tauri native.** Desktop gets local notifications while running (decision 5). iOS: APNs
  alert pushes (`mutable-content: 1`, not background pushes, which are throttled and dropped after
  force-quit) and an NSE declared as an app-extension target in Tauri's XcodeGen template
  (`bundle > iOS > template`, added in tauri-cli 2.0.0-rc.2; current key name **[unverified]**),
  never by hand-editing `gen/apple`. XcodeGen has no NSE type, so the template supplies its
  Info.plist and source. Route keys go in a shared keychain access group, the route → network and
  buffer map in the App Group container; the NSE has ~24 MB and ~30 s. Android: FCM data messages,
  and UnifiedPush (whose endpoints are Web Push endpoints). Desktop push, if ever: macOS APNs,
  Linux UnifiedPush; Windows App SDK push works unpackaged with a sparse package for identity, an
  Azure AppId, and 30-day channel expiry.

## Failure modes

| Failure | Behaviour |
|---|---|
| permission denied or dismissed | No push; the page notifies while open; status says "off in system settings". Never re-prompt automatically. |
| iOS subscription revoked | Detected at launch (`getSubscription()` null or changed). Re-subscribe silently if still permitted and re-register every home with new routes; else show the status. |
| home refuses (`MAX_REGISTRATIONS`, `FORBIDDEN`, no account, Tor) | `PushRegistration::Failed` in network status. Ergo's default of 4 slots is the likeliest (server ask). The route is deleted. |
| `WARN WEBPUSH PERSISTENCE_REQUIRED` | `Unavailable(PersistenceOff)` plus a hint to turn always-on back on (papo ask). |
| relay down | Homes retry or drop by their own policy (Ergo: 16-push queue, drops on overflow). Messages stay in history. |
| route leaked or abused | Pinned VAPID rejects other signers; rate limits; the device can rotate the route. |
| home's VAPID key changes | The relay rejects the new signer. At the next refresh the engine sees a new `vapid` and creates a new route. |
| lease outlives the page | Held pushes are delivered when it expires: late by ≤ 75 s, not lost. |
| stale notification after reading elsewhere (web) | Cleared when the app next opens; native targets clear it via the background MARKREAD. |
| service worker update pending | New handlers apply once old clients close; the declarative fallback keeps iOS pushes visible meanwhile. |
| inner decrypt fails | One generic "New message" for that network; the route is marked for re-registration. |
| shared-IP ban of hosted soju | Mitigated by `upstream-user-ip` and talking to network staff before launch. |

## Privacy and security

- **Message content** is end-to-end encrypted from home to device (RFC 8291), padded to a fixed
  record. The relay, Apple, Google and Mozilla see timing, urgency and device. It isn't
  forward-secret (Ergo `docs/MANUAL.md:520-530`).
- **Homes see plaintext.** Hosted soju sees and stores members' third-party messages plus their
  network credentials (we prefer a per-network certfp key, which NickServ can revoke). Onboarding
  says so; bringing your own bouncer is the alternative. Retention: `message-expiry`, encrypted
  disk.
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
  `Failed`; a VAPID change forces a new route.
- **Relay** (Rust integration tests): probing → active (probe discarded with 201), VAPID pin and JWT
  `aud`/`exp`, 404 for dead routes and after a 410 upstream, 413 over budget, TTL passthrough,
  urgency policy, per-tab leases with hold/discard/deliver, rate limits, envelope bytes against fake
  upstreams.
- **Local Ergo end to end** (`nix run .#ergo-weblounge`): the fixture gains `webpush.enabled`,
  `delay` and the relay; two papo clients drive a DM and a mention; the relay's sink records
  envelopes; the read-elsewhere case asserts `delay` suppresses the push. Ergo requires `https`
  (`webpush/security.go:26-35`) and its dialer refuses loopback, private, link-local and CGNAT
  addresses (`security.go:67-76`), so the fixture needs a test-only Ergo patch plus TLS on the sink
  from the repo's throwaway local CA (server ask).
- **Playwright** (Chromium, built app; no service worker in dev): Playwright's Chromium has no push
  service, so `PushManager.prototype.subscribe` is stubbed with `addInitScript` to return a fake
  subscription, and delivery uses CDP `ServiceWorker.deliverPushMessage` with the sink's envelope.
  Specs: enable notifications through the UI and see "on" in network status; delivered push →
  `getNotifications()` shows title, body, tag and `data.route`; a focused page produces no
  delivered envelope; opening the buffer closes its notifications; app badge via a stubbed
  `setAppBadge`; the page side of `open-route` (warm) and the deep link (cold), with the
  `notificationclick` routing function unit-tested. `nativeFeelAudit` and the idle/hidden checks
  stay green with the lease heartbeat.
- **Device checklist** (iPhone 16 Pro, an Android phone), recorded in PLAN.md: a week without
  revocation, tags, badge, cold and warm tap, the generic notification on decrypt failure, a missed
  lease release (late, not lost), behaviour after force-quit.

## Conflicts with signed-off text (to fix on approval)

- **Brief §3.12** says Web Push doesn't use the relay. Here it does (decision 1). Web push can stay
  free; that is pricing, not architecture.
- **Brief §3.10** says push works only on servers with `draft/webpush` and points users to soju.
  Here homes, including a hosted soju, are part of the model; the prototype's copy ("on networks
  that support push", `Mobile.dc.html:861`) changes to match.
- **Brief §3.8** lists "push payloads written by the notification extension" as an Activity source.
  The v1 service worker persists no payloads; Activity catches up from history when the app opens.
- **`19-packaging.md:11`** puts Web Push out of scope. The service worker gains push handlers and a
  precached parser, with no change to its fetch rules.
- **The engine's mention rule** (`state.rs:2090-2098`) contradicts brief §3.8 and
  `01-engine-state-model.md:196-197`; `notify-rules` fixes it.

## Decisions (open; recommendations, not yet answered)

1. **Run a weblounge push relay for every platform, including the web.** Recommended. Without it
   the web app can take pushes from only one server and can't avoid silent pushes on iOS.
2. **Hosted soju for third-party networks**, members only, with bring-your-own-bouncer also
   supported. Per-user source addresses via `upstream-user-ip` with an IPv6 prefix (plus a small
   IPv4 range if needed), and a heads-up to Libera and OFTC staff before launch. Whether they
   rate-limit per /64 is **[unverified]**; ask them. Recommended; ships after first-party push
   (v1.1).
3. **Turning on push requires a weblounge account.** Recommended. It keeps the relay from abuse and
   is where a paid tier would hook in.
4. **Cross-device quieting:** suppress pushes to your other devices while any of your devices is
   active, plus Ergo `webpush.delay` of about 10 s to skip messages read elsewhere. Recommended
   both. Cost: every push on every device arrives at least 10 s late, even with only one device.
5. **Tauri desktop:** local notifications while running, an option to stay in the tray or menu bar
   and start at login, no push when quit. Recommended.

**Deferred (not v1): where notification rules live.** Proposal: per account on each home (our
Ergo, hosted soju, a self-hosted soju each hold their own), replicated by the client as the merge
point, with only "push on this device" and `AppBadge` kept on the device. This would override
`22-storage.md:43` ("no settings sync"). The transport would be a vendor extension
(`weblounge.org/notify-rules`) in our patched Ergo, contributed to soju.

## Appendix A: server asks

1. Ergo: backport PR #2471 (fix webpush always sending at high urgency) onto the patched 2.19.1 in
   `pkgs/ergochat.nix`. It makes the maintenance PING and MARKREAD `UrgencyNormal`; the
   registration probe stays high, which is correct (the relay's probing state handles it). No
   further urgency patch is needed.
2. Ergo: raise `webpush.max-subscriptions` from the default 4 (`default.yaml:1205`) to about 10;
   each browser, phone and later native app uses one slot. Needed for v1.
3. Ergo: set `webpush.delay` to 10 s if decision 4 is accepted (default 0 s, `default.yaml:1201`;
   unset at `~/weblounge/services/ergo.nix:155-158`).
4. Ergo: a local patch, proposed upstream, so channel highlights match the current nick as well as
   the account (`irc/channel.go:1445-1460`, `irc/webpush/highlight.go`).
5. Ergo test fixture: a test-only patch letting webpush post to a loopback HTTPS endpoint
   (`security.go:26-35,67-76`), plus TLS for the relay sink from the local test CA.
6. Host the relay at push.weblounge.org: `services/push-relay.nix` in the `weblounge.sandbox`
   pattern, an nginx vhost, egress on 443 to push services (later APNs and FCM), SQLite state,
   loopback health checks and alerts.
7. Secrets via sops: the relay's VAPID P-256 key pair (public key published in `config.json`);
   later an APNs `.p8` (team id, key id) and FCM service-account credentials.
8. Concierge: let the relay introspect member session tokens (its own shared secret for
   `/oauth/introspect`, or a push-device scope) and add a stub entitlement endpoint that allows
   everyone.
9. `beta-client.nix`: add `https://push.weblounge.org` to CSP `connect-src` and serve
   `push: { relay, relay_vapid }` in `/config.json` once `DeploymentConfig` lands.
10. Hosted soju (v1.1, decision 2): bouncer.weblounge.org over wss; `auth oauth2` against
    concierge; `upstream-user-ip` with an IPv6 prefix (credenza is IPv4-only today,
    `hosts/credenza/networking.nix`, so this needs IPv6 or a small dedicated IPv4 range); built-in
    identd; `max-user-networks` about 5; `message-expiry`; `disable-inactive-user 30d`; egress on
    6697; an abuse contact in rDNS or realname; a member cap; a heads-up to support@libera.chat and
    OFTC staff before launch.

## Appendix B: papo asks

1. Surface `WARN WEBPUSH PERSISTENCE_REQUIRED` on a successful `register()` (e.g.
   `RegisterOutcome { persistence_required: bool }`); push silently never arrives otherwise. Today
   `requests::empty` drops it (`papo/src/requests.rs:351-355`).
2. Type `FAIL WEBPUSH FORBIDDEN` (Ergo: push disabled, no account or Tor, `handlers.go:4327-4402`)
   as its own `Refusal`; `refusal.rs:520-521` maps only `INVALID_PARAMS` and `MAX_REGISTRATIONS`.
3. Fix the stale doc comments on `webpush().register`/`unregister` (`ext/webpush.rs:58-59,87-88`),
   which say refusals are `Refusal::Other`; papo-core already types two of them.
4. Map soju's subscription-limit failure (sent as `INTERNAL_ERROR` at 25) as clearly as
   `MAX_REGISTRATIONS`, or document that it can't be told apart.
5. Accept Ergo's real success reply, `WEBPUSH REGISTER <endpoint> <keys>`, in tests; the fixture
   uses `WEBPUSH SUCCESS` (`ext/webpush.rs:152`).
6. Web push conformance scenarios against Ergo 2.19.x and soju 0.11.x: register, refresh,
   unregister, limit, `FORBIDDEN` without an account, and register on a bound soju network
   (`docs/ircv3-support.md:50-51` lists no coverage).
7. A parser entry point for a push payload: one raw line, no CRLF, possibly with dropped tags or
   multiline-truncated, with the user's own nick as DM target, yielding a typed event (message,
   notice, action, invite, markread, ping) with msgid and time. No I/O, small enough to precache in
   a service worker as wasm, and buildable as a native static lib for the iOS NSE.
8. Emit an event when the `VAPID` ISUPPORT value differs from the previous connection, or confirm
   that reading `Isupport::vapid()` after each `Connected` is the intended pattern.
9. Confirm that the `unstable` feature (already enabled, `Cargo.toml:14`) is fine to ship with the
   webpush and bouncer APIs (`docs/design/README.md:153` lists it as open).
