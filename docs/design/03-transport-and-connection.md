# 03 — Transport and connection lifecycle

Status: proposed for milestone 1 review.

## Problem

Each configured network needs an independent connection that behaves consistently in a browser
worker, Tauri desktop, and Tauri mobile. The browser can open only WebSockets; native builds can
also open TCP/TLS. Connections must expose useful onboarding progress, preserve cached state while
offline, reconnect without battery-hungry polling, and stop cleanly when mobile operating systems
suspend the app.

Papo already owns IRC framing, transport I/O, TLS, STS, CAP negotiation, SASL, registration,
keepalive, rate limiting, reconnection, and typed failure classification. The engine composes those
APIs and must not implement parallel protocol machinery.

## Platform endpoint types

Persisted configuration can describe every endpoint, but a platform connection factory accepts
only endpoint types it can actually open.

```rust
pub struct NetworkConnectionConfig {
    pub endpoints: NonEmptyVec<EndpointDescriptor>,
    pub identity: IdentityConfig,
    pub authentication: AuthenticationConfig,
    pub autojoin: Vec<ChannelNameConfig>,
    pub reconnect: ReconnectPolicy,
}

pub enum EndpointDescriptor {
    Tcp(TcpEndpointDescriptor),
    WebSocket(WebSocketEndpointDescriptor),
}

pub struct TcpEndpointDescriptor {
    pub host: Host,
    pub port: NonZeroU16,
    pub security: TcpSecurity,
}

pub enum TcpSecurity { Tls, StartPlaintextWithSts }

pub struct WebSocketEndpointDescriptor {
    pub url: WebSocketUrl,
}

pub struct WebPlatform;
pub struct NativePlatform;

pub trait Platform {
    type Endpoint: ConnectableEndpoint;
    fn compatible(descriptor: &EndpointDescriptor) -> Option<Self::Endpoint>;
}

pub enum WebEndpoint {
    SecureWebSocket(WebSocketUrl),
}

pub enum NativeEndpoint {
    Tls(TcpEndpoint),
    PlaintextWithSts(TcpEndpoint),
    WebSocket(WebSocketUrl),
}
```

`WebPlatform::Endpoint` has no TCP variant, so browser connection code cannot construct a TCP
attempt. Generic web onboarding also creates only `WebEndpoint`; it may display incompatible
persisted TCP descriptors as unavailable. Production credentials require `wss://` or native TLS.
Plain `ws://` exists only for explicit local development fixtures and is never produced by normal
onboarding.

Native endpoint conversion uses `papo::Endpoint::{tls, plaintext}` for TCP or parses a full
`ws://`/`wss://` URL (including paths). Native `papo` enables its `websocket` Cargo feature and one
rustls provider. Browser `wasm32-unknown-unknown` uses papo's browser WebSocket backend without the
native websocket feature; its TLS policy belongs to the browser.

The endpoint list is ordered by user/preset preference. Compatibility filtering is deterministic
and never silently changes security. Attempting later compatible endpoints after a connection
failure depends on the papo gap listed below.

## Identity and authentication

```rust
pub struct IdentityConfig {
    pub nick: NonEmptyString,
    pub alternate_nicks: Vec<NonEmptyString>,
    pub username: Option<NonEmptyString>,
    pub realname: Option<NonEmptyString>,
}

pub enum AuthenticationConfig {
    None,
    Sasl { account: NonEmptyString, secret: SecretRef, policy: SaslPolicy },
    ServerPassword { secret: SecretRef },
    HostedHandover { token: SecretRef },
}

pub enum SaslPolicy {
    Plain,
    ScramThenPlain,
    OAuthBearer,
    External { identity: Option<String> },
}
```

Secrets are resolved immediately before building papo and are never stored in engine snapshots,
logs, IPC errors, or persisted network records. Configuration maps to public APIs:

- `Client::builder(endpoint, nick)`, `.alt_nicks`, `.username`, and `.realname`;
- `.sasl(Sasl::plain(...))` for weblounge username/password;
- `Sasl::any`, `oauth_bearer`, or `external` only when explicitly configured;
- `.password(Secret)` for bouncer/server passwords;
- `.autojoin` / `.autojoin_with_key`, `.who_on_join`, `.metadata_subscriptions`;
- `.reconnect(papo::Reconnect)` and `.connect_timeout`.

The app does not send `CAP`, `AUTHENTICATE`, `PASS`, `NICK`, or `USER`. Papo refuses credentials
on insecure transports unless `allow_insecure_auth(true)` is explicitly selected; production code
never selects it. Papo requests its stable known capabilities by default. Optional known features
use `Builder::enable(Feature)`, never `request_caps`; the latter is reserved for genuinely unknown
vendor capabilities after Luiz approves them.

## Connection owner

```rust
pub struct ConnectionSupervisor<P: Platform> {
    platform: PhantomData<P>,
    networks: HashMap<NetworkId, NetworkTask>,
}

pub enum NetworkTask {
    Stopped(StoppedConnection),
    Running(RunningConnection),
    Suspending(SuspendingConnection),
}

pub struct RunningConnection {
    pub generation: ConnectionGeneration,
    pub client: papo::Client,
    pub cancel: CancellationToken,
}

pub trait ConnectionFactory<P: Platform> {
    async fn build(
        &self,
        endpoint: P::Endpoint,
        config: ResolvedConnectionConfig,
    ) -> Result<(papo::Client, papo::Events, papo::Driver), ConnectionSetupError>;
}
```

`ConnectionFactory` is an application seam around constructing public papo objects, not a byte
transport abstraction. Production always uses papo's transport. Tests may supply scripted papo
clients through `papo-testing`; no fake IRC parser is introduced.

The supervisor uses `Builder::build()` rather than `connect()` so it can poll `Events` during the
first attempt and show `Event::Connecting`. It starts the `Driver` before awaiting any client
action, then drains `Events` continuously. A task owns one driver and event consumer. The cloneable
`Client` is used only by engine command handlers for that network.

Every event is tagged with the local `NetworkId` and `ConnectionGeneration` before reduction.
Events from a cancelled older generation cannot mutate current state. `Event::Lagged` triggers
state-snapshot recovery; it is never ignored.

## Lifecycle state machine

```text
Stopped ── connect ──> Starting ── Connected ──> Online
   ^                       │           │             │
   │                       └─ failed ──┴─ disconnected
   │                                      │
   │                         retry scheduled by papo
   │                                      │
   ├── user disconnect <── Reconnecting <─┘
   │
   └── suspended <── Suspending <── mobile background
                         │
                         └── foreground rebuilds connection, then syncs
```

Papo's `Reconnect::exponential()` is the default: jittered exponential delay from one second,
capped at five minutes, with a minimum 60-second refusal delay. The engine reflects
`Disconnected.reconnect_in` and `ConnectErrorKind`; it does not maintain a second timer or retry
counter. User “Reconnect now” calls `Client::reconnect()`, which deliberately skips backoff.
Permanent/authentication failures remain stopped until configuration changes or the user retries.

On `Connected`, the engine reads a fresh `Client::state()` snapshot before publishing online state.
`ChannelSynced` marks each autojoin usable. Cached buffers remain readable during every transition;
the composer queues user sends while offline and submits them only after the engine's later
offline-queue policy permits it.

On deliberate disconnect, command intake for that network closes, `Client::quit(reason)` is
awaited with a short shutdown deadline, events drain through `Disconnected`, and then handles are
dropped. Abrupt platform shutdown may drop the handles; papo attempts a bare `QUIT` when possible.

## Onboarding progress

Papo progress maps without inventing protocol milestones:

| Papo event/state | Checklist item |
|---|---|
| `Connecting { phase: Transport }` | Reach host |
| `Connecting { phase: Tls }` or secure browser WebSocket open | TLS / WebSocket |
| `Connecting { phase: Capabilities }` | Negotiate features |
| `Connecting { phase: Authenticating }` | Sign in |
| `Connecting { phase: WaitingForWelcome }` | Finish registration |
| `Connected` plus required initial sync | Sync |

The checklist represents skipped phases explicitly (for example no SASL) and displays stable
`ConnectErrorKind` categories. The supported-feature list comes from `State::features()` and the
product capability projection, not CAP string parsing.

## Multi-network and soju import

Ordinary networks have independent supervisor tasks, so one failure cannot stall another. The
global engine serializes only small cross-network projection commits.

Soju import uses papo's unstable typed API:

1. Create a control `Client` with `Sasl::...device(device_id)` and
   `enable(Feature::Bouncer)`.
2. Call `control.bouncer().networks()` to obtain complete `BouncerNetwork` values.
3. Persist the bouncer's opaque network ID as connection metadata and create one local network
   record for each selected upstream.
4. Build each bound client with `control.bouncer().network(&id)`, which copies endpoint,
   credentials, TLS settings, reconnect policy, and enabled features.
5. Consume `Event::BouncerNetworkChanged` only on the control connection and reconcile by opaque
   ID. Names are labels and need not be unique.

The control connection is not shown as a chat network. Its lifecycle is owned by a `BouncerGroup`;
bound networks remain separate application networks. Import is transactional: no local network is
published until its required identifiers and credential reference exist.

## Browser worker ownership

The wasm engine runs in one SharedWorker per origin and owns every papo client. Tabs attach through
ports and never open IRC connections themselves. If SharedWorker is unavailable, one dedicated
Worker owns the current tab's connections. The adapter reports this mode so diagnostics can
explain duplicate connections across tabs.

No connection runs on the main UI thread. Page visibility suppresses UI patches but does not stop
the SharedWorker. The engine relies on papo/server keepalive; it adds no polling interval.

## Mobile suspend and resume

```rust
pub enum AppLifecycle {
    Foreground,
    Backgrounding { deadline: Instant },
    Suspended,
}
```

On iOS and Android backgrounding, the supervisor stops accepting new network actions, flushes
storage, attempts a bounded graceful quit, and drops drivers. It does not start a background or
foreground service to keep IRC alive. Push is the only closed-app delivery path.

On foreground resume, cached state renders before reconnection. The supervisor creates fresh papo
clients and, after registration, the history subsystem uses `recent_conversations`, `history`, and
read markers to repair gaps. A generation boundary prevents late pre-suspend events from being
applied. Desktop minimize and hidden browser tabs do not disconnect; they only suppress rendering.

## CAP and SASL ownership

Papo is authoritative for capability aliases, dependency checks, tag denial, SASL mechanism
selection, authentication timeouts, and capability changes. The engine observes:

- `Connected.caps`, `State::{caps, supports, features}`;
- `CapsChanged` and `FeaturesChanged` after registration;
- typed `Unsupported { feature, reason }` failures;
- `ConnectErrorKind::{Sasl, SaslUnavailable, CapabilityUnavailable}`.

The engine never infers a product feature from a CAP token. The capability subsystem maps papo
`Feature` values and per-object prerequisites into UI-safe feature witnesses.

## Boundaries

This subsystem owns platform-compatible endpoint construction, one connection task per network,
application lifecycle integration, papo builder configuration, progress reporting, and task
cancellation. It must not parse IRC, perform CAP/SASL, create its own socket/TLS/WebSocket stack,
derive capability gates, fetch history, store credentials, or decide navigation.

## Testing

- Compile checks build the engine for native and `wasm32-unknown-unknown`; compile-fail tests prove
  `WebPlatform` call sites cannot pass a TCP endpoint.
- Builder mapping unit tests cover every auth and endpoint variant without exposing secrets.
- `papo-testing::wire` tests progress, disconnect, lag recovery, shutdown, and generation fencing.
- Browser tests run papo's dedicated- and SharedWorker suites against a real WebSocket fixture.
- Native integration runs the same connection scenarios over TCP/TLS and WebSocket.
- Live conformance uses papo's Ergo, persistent Ergo, soju+Ergo, InspIRCd, Solanum, and UnrealIRCd
  profiles; soju tests cover import, duplicate names, bound clients, and notifications.
- Mobile lifecycle tests simulate background deadlines, assert all drivers end, then verify resume
  gap-fill without a blank UI.

## Out of scope

Credential-store implementation, history algorithms, push transport, hosted concierge handover,
network settings UI, WebSocket-to-TCP gateways, proxy settings, and certificate management UI are
separate designs.

## Questions for Luiz / papo gaps

1. Papo's public builder accepts one endpoint and its reconnect policy retries that endpoint. The
   brief requires ordered endpoints (for example native TCP/TLS then WebSocket) and failover. Should
   ordered endpoint failover be added to papo? The client will not implement a parallel retry
   controller around papo without that decision.
2. Papo's docs say browser TCP endpoint constructors are absent, but `Endpoint::tls/plaintext`
   currently compile for browser targets and fail as unavailable when connected. Is compile-time
   removal planned? Weblounge will still make TCP unconstructable in its web platform layer.
3. Papo's soju bouncer and Web Push APIs require the `unstable` feature. Is enabling unstable in a
   shipping client acceptable, or should those APIs stabilize first?
4. Does papo need an explicit pause/resume API for mobile, or is bounded `quit`, drop, rebuild, and
   history repair the intended lifecycle?
5. The hosted concierge token-to-papo authentication mapping is unspecified. Which public papo
   authentication API should receive the existing gamja OAuth handover?
6. Should users be allowed to configure plaintext IRC plus STS in production, or should the first
   client release expose only TLS TCP and secure WebSocket?
7. Should weblounge run the optional WebSocket↔TCP gateway? It would see plaintext and is not part
   of this design without an explicit privacy decision.
