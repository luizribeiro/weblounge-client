# 03 — Transport and connection lifecycle

Status: approved by Luiz; milestone 4 hosted session-token path implemented.

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
not enter snapshots, logs, IPC errors, or persisted network records. `HostedOAuth` is an
attempt-scoped resolved value, not stored network configuration: before every hosted connect or
reconnect, the engine asks its host adapter for a fresh token. The token crosses an adapter
boundary only in a dedicated one-shot secret envelope; the adapter removes its source value after
acknowledgement and the engine immediately stores it behind `SecretRef` for that attempt.
Configuration maps to public builder methods such as `sasl`, `password`, `autojoin`,
`metadata_subscriptions`, `reconnect`, and `connect_timeout`. The app never sends CAP,
AUTHENTICATE, PASS, NICK, or USER itself.

Milestone 1 uses weblounge username/password over SASL and secure WebSocket. Plaintext plus STS is
not exposed in the first release.

### Hosted concierge handover

Deploy-time configuration supplies concierge's issuer URL, session-token endpoint, public client
ID, exact webchat root as redirect URI, the preconfigured WebSocket endpoint, and `#lounge`; no
hostname sniffing or onboarding chooses these values. The session-token endpoint is configuration,
not a path derived from the issuer.

The window keeps the last schema-valid deployment configuration in a versioned local-storage
record. It is public routing and OAuth-client metadata, never a credential. A returning launch uses
that record immediately and revalidates `/config.json` in the background; a changed valid response
takes effect on the next launch so one running session never mixes deployment identities. A cold
launch without a valid record waits for the fetch. Network failures and the startup deadline are
reachability errors; only a missing/HTML response, malformed JSON, or schema violation is a
misconfigured deployment. The service worker never handles `config.json`.

The window's credential path posts an empty JSON object to the configured session-token endpoint
with `credentials: "include"`. It validates the bearer response and yields the token once to the
engine. The endpoint and member cookie never enter a worker: worker fetches do not inherit the
page's test-CA exception in Playwright WebKit, and browser credential behavior must have one owner.
Startup begins the page fetch in parallel with worker initialization. The window first sends the
validated public hosted profile without credentials, allowing the engine to restore its matching
chat-list snapshot; only a subsequent fresh-token request constructs the papo connection. On
reconnect the engine's typed token-required event is routed to one active page, which performs the
same one-shot exchange and returns a fresh token. With no live page, the engine enters a
credential-unavailable failure instead of retrying silently. A valid chat-list snapshot may reveal
the shell while credential acquisition continues; without one, the splash remains until a usable
shell or an actionable failure can render. Each connect attempt makes at most one request; the
provider does not cache bearer tokens or run its own retry loop.

The engine asks the adapter again before every reconnect, even while the preceding token is still
within its advertised lifetime. Connection construction maps that attempt's `HostedOAuth` to
`papo::Client::builder(...).sasl(papo::Sasl::oauth_bearer(token))`. Ergo receives SASL
OAUTHBEARER and introspects the token against concierge over its private loopback endpoint; the
returned `username` is the IRC account.

Credential outcomes remain distinct:

| Outcome | Connection behavior |
|---|---|
| Valid session token | Consume it for exactly one connect attempt. |
| `401 login_required` | Start full OAuth authorization: the redirect flow today, replaced by the in-app sign-in screen tracked in GitHub issue #2. |
| Token rejected by IRC/concierge | Treat it as invalid authentication and start full authorization; never classify it as transport failure. |
| Fetch/network failure | Show Retry immediately. If no connection exists yet, fall back to PKCE after a fixed three-second recovery window; an established shell enters credential-unavailable failure for the same window. |
| `429 invalid_request` | Treat it like a fetch failure; never issue more than one fetch per connection attempt. |
| Invalid endpoint response or deployment contract | Fail visibly as a hosted deployment error; do not send an unvalidated value to papo. |

Full authorization remains concierge's RFC 8414 authorization-code flow. The client generates
random OAuth `state` and a PKCE verifier, keeps both in `sessionStorage`, and redirects to the
authorization endpoint with an S256 challenge. Concierge uses its existing member session (or asks
the member to sign in), then returns a one-minute authorization code and the state to the exact
root redirect URI. The client rejects a missing or mismatched state with a human sign-in retry,
removes the pending verifier, and posts the code, verifier, redirect URI, and configured
`client_id` to the token endpoint without a client secret. Redirect URIs never include the page
fragment. That exchange's bearer token is consumed for the immediate attempt; later reconnects
return to the session-token provider rather than reusing it until expiry.

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

Papo's exponential reconnect policy owns transport delay and jitter: immediate, then approximately
1s, 2s, 5s, up to 30s. The engine reflects `Connecting.attempt`, `Connecting.phase`, and
`Disconnected.reconnect_in`; it does not run a competing transport retry timer. A hosted attempt
is gated on one page-owned credential request before papo connects. The provider itself never
retries. “Reconnect now” asks one active page for a hosted token and then reconnects on browser
`online`, visible `visibilitychange`, and persisted `pageshow`.
The hosted connection owner must not let an automatic papo reconnect bypass that credential gate
with the preceding attempt's token; papo remains authoritative for transport failure
classification and the reported retry schedule.
Foreground reconnect requests race papo's `Client::ping` against the engine's wasm-safe platform
delay, then ask papo to reconnect when the probe does not finish. The engine never implements IRC
PING or a second transport retry policy.
Authentication and permanent failures enter `Failed`; device-offline conditions enter `Offline`.

On every `Connected`, the engine increments the connection epoch and reads `Client::state()` before
publishing `Online`. After the first connection it also schedules engine-owned `CHATHISTORY AFTER`
repair for every ready channel and direct conversation from that buffer's retained cursor. This is
required even when papo builds a fresh hosted client: papo's optional reconnect catch-up covers
only channels retained by one client instance. `ChannelSynced` marks autojoins ready. On
`Event::Lagged`, the engine re-reads papo state and schedules history repair where supported.

Papo disconnects with `DisconnectCause::SlowConsumer` when both event queues fill, including during
connect at the current revision. The event loop therefore starts immediately and performs no slow
storage/UI work; it hands typed changes to bounded engine work. If a slow-consumer disconnect still
occurs, the engine surfaces it in diagnostics, enters papo's normal reconnect path, and rebuilds
projections from the fresh snapshot after `Connected`.

Deliberate disconnect stops command intake, awaits `Client::quit()` within a bounded shutdown, and
drops the task. Mobile backgrounding does not replace the shell or deliberately quit: the worker
and papo connection remain authoritative for as long as the platform keeps them alive. Foreground
requests an immediate reconnect/liveness check, and the engine's retained per-buffer cursors repair
the gap through papo's history API.

### Shell presentation

Once the UI can render a usable shell, connection changes never replace it with startup or error
UI. The last projection, navigation, scroll position, and drafts stay mounted. There is no visible
“Connecting…”, “Reconnecting…”, or “Offline” status copy in normal chrome.

The weblounge logo and title are the sole transient progress indicator: the pair in the mobile
Chats header and desktop sidebar fills while connecting, registering, reconnecting, or hydrating
the first complete live projection. A transient drop that recovers produces only this treatment.
The active conversation title uses the same shared fill while its network is making progress or
its buffer has an initial-history, reconnect-catch-up, or older-history request in flight. Buffer
sync is an engine-owned typed projection; the shell does not infer it with a timer. Mobile and
desktop stop with the same final filling pass when the buffer becomes current.
During progress, the logo tile, chair, and title have a theme-derived dim base. One straight,
soft-edged band reveals a full-colour copy from left to right across the real logo geometry and then
the title, driven by one shared coordinate so it reads as one continuous pass. On recovery, the
current cycle finishes before one final pass fills everything behind its leading edge; the pair then
stays fully filled and has no active animation. Recovery during the cycle's ending rest starts the
final pass immediately. With reduced motion, progress is a static dim base with a partially visible
full-colour logo and brighter title, and recovery snaps to full colour. The error tint and shared
error strip take precedence and never sweep. The implementation uses theme colour mixes and a
registered custom property; it introduces no raw colours, fade, or colour interpolation.

The shared presentation projection exposes semantic progress, one optional actionable error, and
whether sends are blocked; it no longer exposes a user-facing connection label. Any network still
connecting, reconnecting, or hydrating keeps aggregate progress active unless an actionable error
owns the logo tint.

| Situation | Logo | Shared error strip | Composer |
|---|---|---|---|
| Connecting, reconnecting, or hydrating | Shimmer; static dim with reduced motion | None | None |
| Online and hydrated | Still, normal colour | None | No connection hint |
| User action required | Still, error-token tint | A few words and one action | None |

Authentication expiry or refusal, a server that remains unreachable after retries, and another
typed terminal failure project one actionable error for the shell. Mobile renders one shared strip
immediately below the active screen's top bar on Chats and conversation screens; desktop renders it
at the top of the sidebar. It contains short copy and exactly one action, such as “Sign in again” or
“Retry”, and disappears as soon as the condition resolves. Multiple network failures still produce
one deterministic shell projection, not one strip per network. The error tint exists only while the
strip is present.

This replaces the mobile Chats status line/dot and inline retry, the mobile conversation subtitle's
connection status/retry, the desktop sidebar's connection suffix/retry, and the footer connection
dot. Connection/authentication paths that currently use full-screen hosted status move to the
shared strip once the shell exists; a host failure that prevents constructing any shell remains on
the original inline startup surface. That surface keeps the launch-image chair fixed and adds only
an error line and action below it; normal progress has no visible text. Conversation subtitles
return to topic/type content. Transient states never
become buffer notices or live-region chatter; the shell may expose `aria-busy` without announcing a
repeating status string. The actionable strip uses alert semantics.

Sends submitted outside `Online` become ordered pending records owned by the engine and flush in
order after `Connected`. They appear as pending transcript rows; the composer adds no connection
hint. A better visual treatment for queued delivery is a later design decision. Server-dependent
commands reject with a short offline reason. A worker host uses `messageerror`, a heartbeat, and a
bounded request timeout to detect termination, rebuild the worker, repeat `Hello`, and request a
snapshot. Persisting queued sends across that new engine instance waits for the storage subsystem;
the UI must state this limitation rather than duplicate the queue.

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
- OAuth state, PKCE, callback, one-shot secret transfer, and redaction have pure or mocked HTTP
  tests. Provider tests cover success, `401` authorization, transient network and `429` failures,
  invalid responses, and one fresh fetch per connect and reconnect. Browser coverage checks the
  session-token happy path does not navigate off-origin, a network-level failure shows Retry and
  reaches PKCE within three seconds, reconnect acquisition originates in a page rather than a
  worker, and callback failures show an explicit sign-in retry. The existing weblounge VM remains
  the manual end-to-end concierge/Ergo check.
- State-machine table tests cover every transition, papo-projected retry timing, fresh hosted
  credentials per attempt, and authentication rejection versus transient credential/transport
  failure.
- Playwright desktop and mobile WebKit tests preserve the mounted shell through offline/online,
  visibility, socket loss, Ergo restart, and worker replacement. Transient recovery shows only the
  logo treatment and never connection copy or an error strip. Reduced-motion coverage asserts a
  static dim with no animation.
- Playwright desktop and mobile coverage holds a local-Ergo history request and reconnect catch-up
  open, then asserts the conversation title fills until the engine reports that buffer current.
  Light and dark captures cover the shared treatment; hidden-page and idle audits stay green.
- Presentation tests keep exactly one actionable strip while navigating between mobile Chats and a
  conversation, place the desktop strip at the sidebar top, exercise Sign in again and Retry, tint
  the logo, and remove the strip and tint on resolution. Per-header status/retry components and the
  footer connection dot are absent.
- Ordered pending-send coverage asserts the composer hint appears only while delivery is blocked
  and disappears when the queue flushes; hosted reauthorization uses the shared strip.

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
- Gate hosted reconnect-now on a fresh adapter credential and keep the last usable shell mounted.
- Queue sends in the engine while not online and flush them in submission order after reconnect.
- Treat hosted token rejection as reauthorization, never as a transient transport failure.
- Treat hosted token acquisition failure as transient, never as token rejection or a reason to
  clear the member session.
- Luiz, 2026-10-31: use the shell logo as the only transient connection/hydration indicator, with a
  reduced-motion static dim; route user-actionable failures through one shared error strip and
  affected sends through a composer-local queue hint.
- Acquire at most one fresh hosted token before every connection attempt; never reconnect with a
  cached token merely because it has not expired.
- Luiz, 2026-11-01: only a live page may call the hosted session-token endpoint. The worker routes
  token-required events and never owns the endpoint or member-cookie fetch. Missing page ownership
  and page-level network failures become visible failures, with a three-second PKCE fallback when
  a page is present.
- Expose only TLS TCP and secure WebSocket in production onboarding.
- Use `ws://` only for explicit loopback test fixtures.
- Luiz, 2026-10-31: hosted auth normally exchanges the concierge member cookie for a short-lived
  token before every connect or reconnect. A missing/invalid login uses the authorization-code
  flow with state and PKCE; both paths map the bearer to papo's `Sasl::oauth_bearer`, and Ergo
  introspects it against concierge.
- Luiz, 2026-10-29: beta's public client ID is `weblounge-client`; it is runtime deployment data,
  replacing gamja's old client registration without creating a separate build.
- Luiz, 2026-10-27: use native `papo_testing::wire()` and the repository's small local Ergo
  fixture; do not depend on a packaged papo test server.

## Questions for Luiz / papo gaps

1. Should ordered endpoint failover be added to papo? It is not required for milestone 1.
