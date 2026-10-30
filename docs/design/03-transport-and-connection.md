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
    HostedOAuth { token: SecretRef },
}
```

Secrets resolve immediately before client construction and enter papo as `papo::Secret`. They do
not enter snapshots, logs, IPC errors, or persisted network records. A hosted token crosses the
main-thread/worker boundary only in a dedicated one-shot secret envelope; the adapter removes its
source value after acknowledgement and the worker immediately stores it behind `SecretRef`.
Configuration maps to public builder methods such as `sasl`, `password`, `autojoin`,
`metadata_subscriptions`, `reconnect`, and `connect_timeout`. The app never sends CAP,
AUTHENTICATE, PASS, NICK, or USER itself.

Milestone 1 uses weblounge username/password over SASL and secure WebSocket. Plaintext plus STS is
not exposed in the first release.

### Hosted concierge handover

Hosted mode copies the deployed gamja flow, not a concierge session-cookie shortcut. Deploy-time
configuration supplies concierge's issuer URL, a public client ID, the exact webchat root as
redirect URI, the preconfigured WebSocket endpoint, and `#lounge`; no hostname sniffing or
onboarding chooses these values.

On first load, the bootstrap fetches concierge's RFC 8414 metadata, generates random OAuth `state`
and a PKCE verifier, keeps both in `sessionStorage`, and redirects to the authorization endpoint
with an S256 challenge. Concierge uses its existing member session (or asks the member to sign in),
then returns a one-minute authorization code and the state to the exact root redirect URI. The
client rejects a missing or mismatched state with a human sign-in retry, removes the pending
verifier, and posts the code, verifier, redirect URI, and the configured `client_id` to the token
endpoint without a client secret. Redirect URIs never include the page fragment.

Concierge returns a bearer access token whose lifetime matches the approving member session. The
bootstrap passes it once into the worker secret store; connection construction maps
`HostedOAuth` to `papo::Client::builder(...).sasl(papo::Sasl::oauth_bearer(token))`. Ergo receives
SASL OAUTHBEARER and introspects the token against concierge over its private loopback endpoint;
the returned `username` is the IRC account. Reconnects reuse the token until expiry. An expired or
revoked token clears the secret and restarts authorization instead of falling back to password.

## Connection owner and identities

```rust
pub struct RunningConnection {
    pub instance: ClientInstanceId,
    pub epoch: ConnectionEpoch,
    pub client: papo::Client,
    pub cancel: CancellationToken,
}

pub enum ConnectionState {
    Connecting { attempt: u32, phase: ConnectPhase },
    Registering { attempt: u32, phase: RegistrationPhase },
    Online { since: Timestamp, actions: NetworkActions },
    Reconnecting { attempt: u32, next_retry_at: Timestamp },
    Offline { reason: OfflineReason },
    Failed { reason: FailureReason, message_key: MessageKey },
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
Connecting → Registering → Online → Reconnecting → Online
     │             │          │            │
     └─────────────┴──────────┴──────→ Offline / Failed
```

Papo's exponential reconnect policy owns delay and jitter: immediate, then approximately 1s, 2s,
5s, up to 30s. The engine reflects `Connecting.attempt`, `Connecting.phase`, and
`Disconnected.reconnect_in`; it does not run another retry timer. “Reconnect now” calls
`Client::reconnect()` on browser `online`, visible `visibilitychange`, and persisted `pageshow`.
Papo's keepalive detects a dead resumed socket; if measurements show its deadline is too slow,
weblounge will request a public short-timeout liveness operation instead of implementing IRC PING.
Authentication and permanent failures enter `Failed`; device-offline conditions enter `Offline`.

On every `Connected`, the engine increments the connection epoch and reads `Client::state()` before
publishing `Online`. `ChannelSynced` marks autojoins ready. On `Event::Lagged`, it re-reads papo
state and schedules history repair where supported.

Papo disconnects with `DisconnectCause::SlowConsumer` when both event queues fill, including during
connect at the current revision. The event loop therefore starts immediately and performs no slow
storage/UI work; it hands typed changes to bounded engine work. If a slow-consumer disconnect still
occurs, the engine surfaces it in diagnostics, enters papo's normal reconnect path, and rebuilds
projections from the fresh snapshot after `Connected`.

Deliberate disconnect stops command intake, awaits `Client::quit()` within a bounded shutdown, and
drops the task. Mobile backgrounding does not replace the shell or deliberately quit: the worker
and papo connection remain authoritative for as long as the platform keeps them alive. Foreground
requests an immediate reconnect/liveness check, and papo history catch-up repairs the gap.

Once the UI has rendered a usable shell, connection changes never replace it with startup or error
UI. The last projection, navigation, scroll position, and drafts stay mounted. `Reconnecting` and
`Offline` render quiet shell indicators; only `Failed` offers retry. Transient disconnects never
become buffer notices. Hosted authentication failure is distinct: an expired or revoked token
clears its owner and restarts sign-in, while transport failure remains in the shell.

Sends submitted outside `Online` become ordered pending records owned by the engine and flush in
order after `Connected`. Server-dependent commands reject with a short offline reason. A worker
host uses `messageerror`, a heartbeat, and a bounded request timeout to detect termination, rebuild
the worker, repeat `Hello`, and request a snapshot. Persisting queued sends across that new engine
instance waits for the storage subsystem; the UI must state this limitation rather than duplicate
the queue.

The milestone-2 single-network runtime rejects a second `Connect` while a client exists with the
typed `engine.network_already_connected` command error. It never replaces a live client implicitly;
future multi-network support routes `Connect` through configured network identity instead.

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
- Native transcript tests use `papo_testing::wire()` for progress, reconnect, lag, slow consumer,
  shutdown, SASL OAUTHBEARER mapping, and instance/epoch fencing; it is a scripted in-memory pipe,
  not browser wasm. `papo` and `papo-testing` are pinned to the same git revision.
- Browser tests use the repository flake's local Ergo at a plaintext `ws://127.0.0.1` listener
  under `LocalTest`; production-policy tests reject it.
- The same minimal Ergo fixture supplies manual verification and a small automated connection
  smoke test; there is no packaged papo test-server dependency.
- OAuth state, PKCE, callback, one-shot secret transfer, expiry, and redaction have pure or mocked
  HTTP tests. Browser coverage checks callback failures show an explicit sign-in retry. The
  existing weblounge VM remains the manual end-to-end concierge/Ergo check.
- State-machine table tests cover every transition, papo-projected retry timing, and hosted token
  expiry versus transient transport failure.
- Playwright desktop and mobile WebKit tests preserve the mounted shell through offline/online,
  visibility, socket loss, Ergo restart, and worker replacement; they also cover ordered pending
  sends and hosted reauthorization.

## Out of scope

Credential storage, history algorithms, push, hosted deployment wiring, proxies,
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
- Use `Client::reconnect()` for reconnect-now and keep the last usable shell mounted.
- Queue sends in the engine while not online and flush them in submission order after reconnect.
- Treat hosted token rejection as reauthorization, never as a transient transport failure.
- Expose only TLS TCP and secure WebSocket in production onboarding.
- Use `ws://` only for explicit loopback test fixtures.
- Luiz, 2026-10-27: hosted auth uses concierge's authorization-code flow with state and PKCE, then
  maps the bearer token to papo's `Sasl::oauth_bearer`; Ergo introspects it against concierge.
- Luiz, 2026-10-29: beta's public client ID is `weblounge-client`; it is runtime deployment data,
  replacing gamja's old client registration without creating a separate build.
- Luiz, 2026-10-27: use native `papo_testing::wire()` and the repository's small local Ergo
  fixture; do not depend on a packaged papo test server.

## Questions for Luiz / papo gaps

1. Should ordered endpoint failover be added to papo? It is not required for milestone 1.
