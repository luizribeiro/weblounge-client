# 21 — Performance and end-to-end harness

Status: proposed for milestone 1 review.

## Problem

Performance is a product contract: cached state appears immediately, input paints within a frame,
long histories scroll smoothly, bursts do not block the main thread, and an all-day session reaches
a memory plateau. There is no device lab, so repeatable local-server scenarios, explicit app marks,
machine-readable metrics, and CI budgets must catch regressions early.

The harness tests real builds and real IRC servers. It does not replace unit/component correctness
tests, and it does not turn unstable microbenchmarks into arbitrary merge blockers.

## Architecture

```text
papo-test-server profiles ── traffic driver (papo clients)
             │                         │
             └──────── IRC ────────────┤
                                       ▼
                              instrumented app build
                                       │
                   Playwright + CDP / Tauri driver
                                       │
                      JSON metrics + artifacts
                                       │
                         budget evaluator → CI
```

The repository will contain these bounded packages when implementation begins:

```text
crates/perf-driver/       scripted bot traffic built on public papo APIs
app/src/performance/      marks, observers, queue counters, dev overlay
tests/e2e/                functional Playwright journeys for both shells
tests/performance/        scenario runner, CDP sampler, budget evaluator
tests/performance/data/   versioned scenario manifests and baselines
```

The driver uses `papo-test-server`'s managed profiles and the same Nix services as papo's
conformance suite: Ergo default, persistent Ergo, soju+Ergo, InspIRCd, Solanum, and UnrealIRCd.
The weblounge NixOS VM fixture is added for concierge, hosted mode, and push scenarios. `papo` and
`papo-testing` remain the only IRC client/protocol implementation in the harness.

`FaultProxy` may interrupt a real server connection for disconnect/timing faults. A fake server is
allowed only for malformed-wire input or timing that no managed server/proxy can produce, and each
use needs a written justification in its scenario manifest.

## Scenario definition

```ts
export interface PerformanceScenario {
  readonly id: ScenarioId;
  readonly profile: ServerProfile;
  readonly seed: SeedPlan;
  readonly viewport: ViewportProfile;
  readonly throttle: ThrottleProfile;
  readonly steps: readonly ScenarioStep[];
  readonly metrics: readonly MetricId[];
  readonly budget: BudgetSetId;
}

export type ScenarioStep =
  | { readonly kind: "launch"; readonly cache: "cold" | "warm" }
  | { readonly kind: "openBuffer"; readonly buffer: FixtureBuffer }
  | { readonly kind: "type"; readonly text: string; readonly cadenceMs: number }
  | { readonly kind: "scroll"; readonly direction: "older" | "newer"; readonly pixels: number }
  | { readonly kind: "traffic"; readonly script: TrafficScriptId }
  | { readonly kind: "disconnect"; readonly durationMs: number }
  | { readonly kind: "setVisibility"; readonly value: "visible" | "hidden" }
  | { readonly kind: "openRoute"; readonly route: FixtureRoute }
  | { readonly kind: "waitForPlateau"; readonly sampleCount: number };

export interface ScenarioResult {
  readonly schemaVersion: 1;
  readonly appRevision: string;
  readonly environment: EnvironmentFingerprint;
  readonly samples: readonly MetricSample[];
  readonly verdicts: readonly BudgetVerdict[];
  readonly artifacts: readonly ArtifactRef[];
}
```

Manifests contain deterministic account/channel names derived from a run seed. The driver reports
ready only after seed history and memberships are confirmed. Timed measurement begins after that
barrier, so server startup and fixture provisioning do not contaminate interaction metrics.

Required scenarios are:

1. cold launch with an empty origin and warm launch with a populated local cache;
2. cached launch while the network is unavailable (“never a blank screen”);
3. switch among cached channel, DM, and server buffers;
4. type and send, including optimistic echo confirmation and offline queueing;
5. scroll bidirectionally through 10,000 messages and load history above the anchor;
6. receive a 2,000-event burst, reactions, joins/parts, and a netsplit-like disconnect;
7. reconnect/resume and history gap-fill through persistent Ergo and soju;
8. open/close mobile pushed screens, member drawer, switcher, and settings;
9. desktop one/six-pane layouts, resize, maximize, and theme/density swap;
10. idle 60 seconds, hidden-tab traffic, and long-session soak.

Every scenario runs at desktop 1440×900 and mobile 402×874 where meaningful. Functional assertions
run before metrics are accepted; a fast but incorrect run is a failed test, not a performance pass.

## Traffic driver

```rust
pub enum TrafficScript {
    Steady { messages_per_second: NonZeroU16, duration: Duration },
    Burst { messages: NonZeroU16, senders: NonZeroU8 },
    SeedHistory { buffers: NonZeroU8, messages_each: NonZeroU32 },
    Reactions { messages: NonZeroU16, reactions_each: NonZeroU8 },
    MembershipChurn { users: NonZeroU16, rounds: NonZeroU8 },
    Disconnect { down_for: Duration },
}

pub struct DriverBarrier {
    pub script_id: ScriptRunId,
    pub expected_events: u64,
    pub completed_at: Timestamp,
}
```

Bot peers are ordinary papo clients with server-advertised rate behavior. Managed performance
profiles explicitly configure suitable local rate limits; the harness does not use `send_raw` to
bypass papo. History is seeded before browser measurement. Burst completion is correlated through
unique message IDs/text and the app's applied engine revision, not a fixed sleep.

The driver emits JSON Lines for start, barrier, progress, and failure so agents and CI can inspect
it without parsing prose. Secrets and message bodies outside deterministic fixture content are
never logged.

## App instrumentation

```ts
export type AppMark =
  | "wl.launch.start"
  | "wl.cache.hydrated"
  | "wl.cached-content.painted"
  | "wl.buffer-switch.start"
  | "wl.buffer-switch.painted"
  | "wl.input.received"
  | "wl.input.painted"
  | "wl.burst.received"
  | "wl.burst.applied"
  | "wl.history.requested"
  | "wl.history.anchored";

export interface PerformanceSnapshot {
  readonly measures: readonly AppMeasure[];
  readonly eventTiming: readonly EventTimingSample[];
  readonly longTasks: readonly BlockingSample[];
  readonly longAnimationFrames: readonly BlockingSample[];
  readonly layoutShifts: readonly LayoutShiftSample[];
  readonly engineQueueDepth: number;
  readonly patchQueueDepth: number;
  readonly renderedMessageRows: number;
}
```

The app uses `performance.mark/measure` with unique interaction IDs. “Painted” marks occur from a
double-`requestAnimationFrame` helper after the state mutation, used only while measuring an active
interaction. There is no permanent animation loop.

One `PerformanceObserver` records Event Timing, Long Animation Frames where available, Long Tasks
as fallback, and layout shifts without recent input. It writes to a bounded ring buffer exposed
through a test-only global API in instrumented builds. Production builds retain only cheap marks
needed by the optional dev overlay; no remote telemetry is sent.

Rust emits `tracing` spans for event receive, reduction, storage flush, projection, and history
merge. Native debug/perf builds can export `tracing-chrome`; wasm exposes aggregate queue depth and
durations through the engine protocol. Clocks are correlated by a startup handshake, never by
assuming Rust and browser monotonic epochs match.

## Browser and process metrics

Playwright drives behavior. A CDP session applies CPU throttling (4× primary, 6× stress), network
latency/throughput, touch emulation, and Page Visibility. `Performance.getMetrics` supplies JS heap,
DOM nodes, layout/style counts, and task duration before/after each step.

Frame timing comes from Long Animation Frames plus a bounded `requestAnimationFrame` sampler that
runs only during scripted scroll/transition intervals. CLS comes from `PerformanceObserver`.
Memlab runs dedicated open-buffer → navigate-away → return leak journeys outside the timing run.

Process RSS is sampled for desktop Tauri by PID after quiescence. Browser “tab memory” is reported
as JS heap + wasm linear memory + attributed DOM/image estimates because browser-process RSS is not
stable enough for a tab budget. Native engine allocation hot paths use `dhat` in dedicated tests.

## Initial absolute budgets

These are proposal values, measured at 4× CPU on the pinned Linux CI runner unless noted. A budget
change is a reviewed product change, not an automatic baseline update.

| Metric | Budget |
|---|---:|
| Warm launch → cached content painted | p95 ≤ 1,000ms |
| Offline warm launch → cached content painted | p95 ≤ 1,000ms |
| Cached buffer switch → painted | p95 ≤ 100ms |
| Composer key event → paint | p95 ≤ 16.7ms; max ≤ 50ms |
| Scripted scroll/transition frame time | p95 ≤ 16.7ms |
| Main-thread task during 2,000-event burst | max ≤ 50ms |
| Burst received → fully applied | p95 ≤ 2,000ms, UI remains interactive |
| Cumulative layout shift per journey | ≤ 0.01 |
| Virtualized message rows after 10k scroll | ≤ 220 |
| Total DOM nodes in chat journey | ≤ 3,000 |
| Initial JS (gzip) | ≤ 250KiB |
| Initial CSS (gzip) | ≤ 60KiB |
| Engine wasm (gzip) | ≤ 1.5MiB |

One-frame input/scroll budgets at 4× are deliberately strict targets from the brief. The harness
reports 4× and 6× distributions even if early implementation misses; Luiz must approve any relaxed
gate rather than the harness silently normalizing poor performance.

## Idle, hidden, and memory budgets

```ts
export interface PlateauBudget {
  readonly warmupMinutes: number;
  readonly comparisonWindows: number;
  readonly maxGrowthPercent: number;
  readonly absoluteBytes: number;
}
```

- Idle 60s: main-thread task time attributable to the app ≤100ms, no recurring rAF/timer, and at
  most five app wake-ups excluding actual server/network events.
- Hidden with traffic: zero style recalculations, layouts, and paints attributable to incoming
  messages; one coalesced catch-up occurs after visibility.
- Web soak (20 buffers, 50k events): JS heap ≤96MiB, wasm linear memory ≤128MiB, and combined
  attributable tab memory ≤220MiB.
- Desktop soak: total Tauri app RSS ≤350MiB after quiescence.
- Plateau: median of the final three five-minute windows grows ≤5% from the preceding three;
  retained DOM nodes do not trend upward.

Absolute memory values are starting gates and must be checked on Luiz's Mac/phone before release.
Wasm memory is measured separately because it can grow but not shrink. A run fails on either the
absolute cap or sustained growth, catching both oversized steady state and leaks.

Manual release checks use macOS Activity Monitor Energy, `top -stats pid,command,cpu,power`, and
Xcode's energy gauge/xctrace on Luiz's iPhone. The iOS Simulator is correctness-only, never a speed
baseline.

## Statistical policy and baselines

Timing scenarios run five times after one unrecorded warm-up. Budgets use the median run's p95 and
the worst safety metric (longest task, CLS). A run with fixture errors, missing marks, browser
background throttling, or environment mismatch is invalid and retried once, never counted as zero.

CI also compares against a versioned baseline from the same runner. It fails when both conditions
hold: regression exceeds 10% and exceeds a metric-specific noise floor (10ms interactions, 2MiB
memory, 5KiB bundles). Absolute budgets always apply. Baseline updates require a command that writes
the environment fingerprint and a reviewed diff explaining each movement.

PR CI runs a smoke set against persistent Ergo in one desktop and one mobile viewport. Nightly CI
runs 4×/6×, leaks, soak, and the six-server matrix. Release CI adds hosted-mode VM tests and Tauri
desktop; mobile simulator journeys run where automation is reliable.

## Bundle and engine benchmarks

`size-limit` enforces JS/CSS chunks and reports why a dependency entered the bundle. `twiggy` and
`wasm-opt` report wasm size; the checked artifact is the release wasm after optimization. Rare
routes (settings and onboarding) have separate lazy-chunk budgets and may not enter the initial
chunk.

Rust uses `divan` for deterministic hot-path benchmarks: applying live events, merging an
out-of-order history page, capability projection, member snapshot replacement, and encoding a
2,000-entry patch. `dhat` asserts peak allocations for the same fixtures. These guide changes but
only stable allocation/time thresholds on pinned CI become gates.

## Lighthouse and native shells

Lighthouse CI covers installable PWA correctness and mobile load metrics with a JSON budget, but it
does not replace app interaction marks. Web vitals aimed at document sites are secondary to cached
content, buffer switch, input latency, and long-session behavior.

The same semantic scenario IDs run against Tauri where automation permits. A native adapter maps
launch, route, and lifecycle controls; result JSON keeps platform in its fingerprint. Desktop and
web baselines are separate. iOS/Android correctness tests assert suspend/resume, push-to-cache, and
safe areas; performance release sign-off uses real devices.

## Dev performance overlay

The dev-only overlay shows last buffer-switch/input duration, recent p95 frame time, long-task
count, engine/patch queue depths, rendered rows, JS heap where available, and wasm memory. It updates
only when open and on incoming samples—no idle polling or permanent rAF. It can export the bounded
snapshot as JSON for an agent or bug report.

## Boundaries

This subsystem owns fixtures/orchestration, traffic scripts, app marks/observers, metric collection,
budgets, baselines, regression evaluation, and the dev overlay. It must not implement IRC, add
production telemetry, parse private user traffic, dictate feature architecture, or use synthetic
servers when real fixtures suffice.

## Testing the harness

- Unit tests validate manifest decoding, metric aggregation, percentile math, budget/noise rules,
  baseline fingerprints, and redaction.
- A tiny self-test app deliberately creates a long task, CLS, timer, DOM leak, and bundle excess;
  every detector must fail it.
- Driver tests assert deterministic barriers and cleanup of accounts, clients, and server
  processes after failure.
- Golden JSON results keep schema consumers stable and agent-readable.
- CI periodically runs a known-good and deliberately regressed build to detect broken gates.

## Out of scope

Public telemetry, production analytics, a cloud device lab, continuous third-party server load,
and automated App Store energy acceptance are not planned.

## Questions for Luiz / papo gaps

1. Which CI runner class can be pinned for gating measurements, and may nightly soak jobs reserve
   it for roughly 30–60 minutes?
2. Approve the initial 220MiB web-attributable and 350MiB desktop RSS budgets; real-device data may
   tighten them.
3. Approve the proposed bundle budgets (250KiB JS, 60KiB CSS, 1.5MiB gzip wasm) before dependency
   selection makes them accidental.
4. Should pull requests run only persistent Ergo (proposed) while the full six-profile performance
   matrix is nightly, or must soju also gate every change?
5. Papo's conformance crates provide the server fixtures, but their application-facing stability
   is limited. Should weblounge consume `papo-test-server` by pinned revision, or should papo expose
   a supported reusable harness package/API?
6. Confirm whether `divan` is preferred over Criterion for engine benchmarks; this design chooses
   `divan` for faster CLI-friendly runs.
