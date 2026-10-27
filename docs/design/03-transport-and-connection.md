# 03 — Transport and connection lifecycle

Status: revised for milestone 1 review.

## Problem

Each configured network needs an independent papo connection. Browsers may open WebSockets only;
native shells later may also open TCP/TLS. Papo owns transport I/O, TLS, STS, IRC framing, CAP,
SASL, registration, keepalive, rate limiting, reconnect, and typed failure classification.

Milestone 1 needs one WebSocket vertical slice while retaining an honest endpoint boundary for
later native shells.

## Endpoint configuration

```rust
pub struct NetworkConnectionConfig {
    pub endpoints: NonEmptyVec<EndpointDescriptor>,
    pub identity: IdentityConfig,
    pub authentication: AuthenticationConfig,
    pub autojoin: Vec<ChannelNameConfig>,
}

pub enum EndpointDescriptor {
    TcpTls { host: Host, port: NonZeroU16 },
    WebSocket { url: WebSocketUrl },
}

pub struct BrowserEndpoint {
    pub url: WebSocketUrl,
}

pub enum NativeEndpoint {
    TcpTls { host: Host, port: NonZeroU16 },
    WebSocket { url: WebSocketUrl },
}

pub enum EndpointPolicy {
    Production,
    LocalTest,
}
```

A validated platform boundary converts stored descriptors into `BrowserEndpoint` or
`NativeEndpoint` before engine construction. The web engine accepts only `BrowserEndpoint`, so it
cannot construct TCP; the native engine accepts TLS TCP and WebSocket. Small cfg-selected
conversion functions then turn those types into `papo::Endpoint`. This needs no generic `Platform`
trait or `PhantomData`.

Production onboarding constructs only TLS TCP or `wss://`. `ws://` is accepted solely under the
explicit local-test policy so browser Playwright can reach a loopback fixture. Papo decision CB-4
keeps `Endpoint::tls` and `Endpoint::plaintext` available on every target; where their transport is
unavailable, connection fails at connect time. Weblounge therefore does not use constructor
availability as a platform check: its browser-only endpoint type enforces that web cannot construct
TCP.

Endpoint order is persisted, but milestone 1 connects to the first compatible endpoint. Papo's
builder accepts one endpoint, so ordered failover remains the explicit papo question below rather
than a second retry controller in weblounge.

## Identity and authentication

```rust
pub enum AuthenticationConfig {
    None,
    Sasl { account: NonEmptyString, secret: SecretRef, policy: SaslPolicy },
    ServerPassword { secret: SecretRef },
    HostedHandover { token: SecretRef },
}
```

Secrets resolve immediately before client construction and enter papo as `papo::Secret`. They do
not enter snapshots, logs, IPC errors, or persisted network records. Configuration maps to public
builder methods such as `sasl`, `password`, `autojoin`, `metadata_subscriptions`, `reconnect`, and
`connect_timeout`. The app never sends CAP, AUTHENTICATE, PASS, NICK, or USER itself.

Milestone 1 uses weblounge username/password over SASL and secure WebSocket. Plaintext plus STS is
not exposed in the first release.

## Connection owner and identities

```rust
pub struct RunningConnection {
    pub instance: ClientInstanceId,
    pub epoch: ConnectionEpoch,
    pub client: papo::Client,
    pub cancel: CancellationToken,
}

pub enum ConnectionState {
    Stopped { reason: OfflineReason },
    Connecting { attempt: u32, phase: ConnectPhase },
    Online { since: Timestamp, actions: NetworkActions },
    Reconnecting { retry_at: Timestamp },
    Suspended { since: Timestamp },
}
```

These are deliberately two identities:

- `ClientInstanceId` increments only when the engine builds a new papo client. It fences events
  from a cancelled task after disconnect, endpoint change, or mobile resume.
- `ConnectionEpoch` increments on every `Event::Connected`, including
  `Connected.reconnected == true`. Capability/action projections use this epoch.

Normal papo reconnect keeps one client instance but begins a new epoch. This resolves the earlier
conflict between build generations and reconnect generations. Subsystem 01 uses this exact
connection-state union.

Validated configuration is passed to `papo::Client::builder(...).build()`. `build()` is synchronous
and returns `(Client, Events, Driver)` without a `Result`; validation errors occur before it. Until
papo removes its connect-time `SlowConsumer` disconnect, the engine starts polling the driver and
drains `Events` from the moment `build()` returns, including while connect is in progress. It never
waits for `connect()` or another client action before starting the drain, so the first `Connecting`
events are observable and cannot fill the queue.

## Lifecycle

```text
Stopped → Connecting → Online → Reconnecting → Online
   ↑          │           │           │
   └──────── failure/user disconnect ─┘
              Online → Suspended → Connecting
```

Papo's exponential reconnect policy owns delay, jitter, and attempt count. The engine reflects
`Connecting`, `Connected`, and `Disconnected.reconnect_in`; it does not run another retry timer.
“Reconnect now” calls `Client::reconnect()`. Authentication/permanent failures remain stopped until
the user or configuration changes.

On every `Connected`, the engine increments the connection epoch and reads `Client::state()` before
publishing `Online`. `ChannelSynced` marks autojoins ready. On `Event::Lagged`, it re-reads papo
state and schedules history repair where supported.

Papo disconnects with `DisconnectCause::SlowConsumer` when both event queues fill, including during
connect at the current revision. The event loop therefore starts immediately and performs no slow
storage/UI work; it hands typed changes to bounded engine work. If a slow-consumer disconnect still
occurs, the engine surfaces it in diagnostics, enters papo's normal reconnect path, and rebuilds
projections from the fresh snapshot after `Connected`.

Deliberate disconnect stops command intake, awaits `Client::quit()` within a bounded shutdown, and
drops the task. Mobile backgrounding uses the same bounded quit/drop path; foreground creates a
new client instance and history later repairs the gap. Hidden browser tabs and minimized desktop
windows remain connected.

## Onboarding progress

Papo events map directly to the checklist:

| Papo state | Checklist item |
|---|---|
| `Connecting::Transport` | Reach host |
| `Connecting::Tls` or WebSocket open | TLS / WebSocket |
| `Connecting::Capabilities` | Negotiate features |
| `Connecting::Authenticating` | Sign in |
| `Connecting::WaitingForWelcome` | Finish registration |
| `Connected` plus initial sync | Sync |

Skipped phases remain explicit. Supported features come from `Client::state()` and subsystem 17,
not CAP string parsing.

## Multi-network, bouncers, and workers

Networks have independent tasks; one failure cannot stall another. The wasm engine lives in a
SharedWorker and owns all clients for the origin. Dedicated-worker fallback owns only its tab and
reports that mode through diagnostics.

Soju import later uses papo's typed bouncer API rather than parsing vendor messages. It waits for
the shipping decision about papo `unstable` recorded in the design index. WebSocket-to-TCP gateways
are outside this subsystem and remain the brief's product/privacy question.

## Boundaries

This subsystem owns descriptor conversion, client/task lifecycle, builder configuration, progress,
connection identities, cancellation, and app suspend/resume. It does not parse IRC, negotiate
CAP/SASL, implement a socket stack, derive feature actions, fetch history, or store credentials.

## Testing

- Pure mapping tests cover endpoint/auth configuration and assert secret-safe failures.
- Native/WASI transcript tests may use `papo_testing::wire()` for progress, reconnect, lag, slow
  consumer, shutdown, and instance/epoch fencing; it is a scripted server, not browser wasm.
- Browser tests use `ws://127.0.0.1` from the real-server CLI under `LocalTest`; production-policy
  tests reject it.
- Live Ergo tests use the CLI contract from subsystem 21. If papo does not export it, this repo's
  flake supplies the same contract with nixpkgs `ergochat`; later soju tests use the same fallback.
- Mobile lifecycle tests simulate the bounded background deadline and fresh-instance resume.

## Out of scope

Credential storage, history algorithms, push, hosted handover implementation, proxies,
certificate-management UI, and gateway deployment are separate designs.

## Later

- Add native TCP/TLS conversion with the Tauri desktop milestone.
- Add soju import and Web Push after the `unstable` shipping decision.
- Reconsider a generic `Platform` trait and `PhantomData` only if cfg-selected endpoint
  construction later proves insufficient.

## Decisions

- Follow papo decision CB-4: endpoint constructors are target-independent; Weblounge's validated
  browser endpoint type excludes TCP.
- Drain papo `Events` immediately from `build()`, including during connect, until connect-time
  slow-consumer disconnects are removed upstream.
- Use `Client::reconnect()` for reconnect-now; bounded quit/drop/rebuild for mobile suspend.
- Expose only TLS TCP and secure WebSocket in production onboarding.
- Use `ws://` only for explicit loopback test fixtures.

## Questions for Luiz / papo gaps

1. Should ordered endpoint failover be added to papo? It is not required for milestone 1.
2. How does the hosted concierge login hand its token to papo—most likely through
   `Sasl::oauth_bearer`?
