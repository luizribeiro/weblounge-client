# 21 — Performance and end-to-end harness

Status: revised for milestone 1 review.

## Problem

Milestone 1 needs repeatable evidence for four product moments: launch, buffer switch, composer
input, and a message burst. The harness must run a real build against a real Ergo server and emit
machine-readable results without depending on papo's private dev-shell environment or a packaged
test-server product.

Broader server matrices, soak tests, and native-shell performance wait until the corresponding
features exist.

## Local Ergo fixture

This repository's flake provides the only milestone-1 real-server fixture. Following
`~/weblounge/lib/test-ergo.nix`, it runs nixpkgs `ergochat` with a generated minimal configuration:
loopback only, a plaintext `ws://127.0.0.1` listener, one fixture account, and only the capabilities
needed by the four scenarios. The runner owns its temporary directory, selects the loopback port,
waits for readiness, passes the URL and account through test environment, and terminates Ergo on
exit. This is fixture wiring inside the harness, not a public CLI contract or reusable server
package.

The fixture serves manual real-server verification and, where cheap, a small automated smoke test
in addition to performance runs. There is no milestone-1 soju matrix, TLS PKI, fault proxy, or
packaged papo test server. Native engine transcript tests instead use `papo_testing::wire()`: a
real papo client over a scripted in-memory pipe. That helper is native-only and is not used by the
browser or performance harness; unpublished `papo` and `papo-testing` stay pinned to the same git
revision.

## Harness pieces

```text
crates/perf-driver/       scripted traffic using public papo clients
app/src/performance/      bounded marks, observers, and dev overlay
tests/e2e/                functional Playwright journeys
tests/performance/        scenario runner and budget evaluator
tests/performance/data/   scenario manifests and reviewed baselines
```

The traffic driver connects ordinary papo clients to the local Ergo URL. It seeds deterministic
accounts/channels, obeys server rate limits, and emits JSON Lines for readiness, barriers,
progress, and failure. Timed work begins only after seed state is confirmed. It never implements
IRC or uses raw protocol sends to bypass papo.

The milestone-2 message-list scroll check has a separate e2e-only Vite entry that directly renders
`MessageList` with 10,000 engine-shaped projections. It is built only when the e2e harness flag is
set and never ships in the production app. This check is deliberately **render-only**: it starts no
engine or worker and measures only list virtualisation and painting. Its fixture uses palette
indices produced by the engine's nick hash, including correct own-nick authorship; real protocol
and history behavior remain covered by the Ergo journeys.

The 10,000-message and 10,000-member scroll scenarios each run five measured passes in one browser
session. They report every pass's frame p95, the median of those per-pass values, and their
p95-of-runs. Frame timings remain diagnostic because throttled animation frames quantise to whole
frames and otherwise-identical single passes can alternate between roughly 16.7ms and 33.4ms. The
milestone-2 gate therefore applies only to the scenarios' DOM and rendered-row bounds.

## Milestone-1 scenarios

All performance gates use Ergo. Each scenario includes functional assertions before accepting
metrics.

1. **Launch:** cold origin, warm cached origin, and warm cache while Ergo is unavailable; cached
   content must never yield a blank screen.
2. **Buffer switch:** move among cached channel, DM, and server buffers.
3. **Input:** type and send through the composer, including optimistic display and echo
   confirmation.
4. **Burst:** receive 2,000 deterministic messages while the UI remains interactive.

The meaningful scenarios run at desktop 1440×900 and mobile 402×874 with Chromium. Pull requests
run this Ergo set only. Server compatibility suites and soju-specific behavior are functional tests
outside the milestone-1 performance gate.

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
  | "wl.burst.applied";
```

Marks carry unique interaction IDs. A measurement-only double-`requestAnimationFrame` helper marks
the first painted frame after state mutation; no permanent animation loop is introduced.

A bounded `PerformanceObserver` buffer records Event Timing, Long Animation Frames where
available, Long Tasks fallback, and layout shifts. Instrumented builds expose a test-only JSON
snapshot containing measures, blocking samples, engine/patch queue depth, rendered rows, and heap
figures. No telemetry is sent.

Rust `tracing` spans cover event receipt, reduction, projection, and encode. Wasm reports aggregate
queue depth/durations through the engine protocol. Clock correlation uses an explicit handshake.

## Browser metrics and budgets

Playwright drives the app. CDP applies 4× CPU throttling, gathers `Performance.getMetrics`, and
captures JS heap, DOM count, layout/style counts, and task duration. Frame sampling exists only
during the measured interaction.

Initial gates on the pinned CI runner are:

| Metric | Budget |
|---|---:|
| Warm/offline-warm launch → cached content painted | p95 ≤ 1,000ms |
| Cached buffer switch → painted | p95 ≤ 100ms |
| Composer key event → paint | p95 ≤ 16.7ms; max ≤ 50ms |
| Main-thread task during burst | max ≤ 50ms |
| Burst received → applied | p95 ≤ 2,000ms |
| Cumulative layout shift per journey | ≤ 0.01 |
| Initial JS gzip | ≤ 250KiB |
| Initial CSS gzip | ≤ 60KiB |

The engine-wasm gzip budget is not guessed. The first optimized vertical-slice build records its
actual size and major contributors (`wasm-opt` + `twiggy`); the reviewed result plus explicit
headroom becomes the baseline before new dependencies land.

The milestone-2 worker boundary measured 719,127 bytes from rustc, 239,018 bytes after
`wasm-bindgen --target web`, and 124,289 bytes after `wasm-opt -Oz`; the optimized artifact is
54,274 bytes with gzip level 9. The checked uncompressed wasm budget is 136,800 bytes: the measured
shipping artifact plus 10% headroom, rounded up to the next hundred bytes. This gate covers the
artifact the browser executes; the gzip figure remains reported for transfer-size tracking.

Until the performance milestone, the wasm size is reported on every build but not enforced (Luiz, 2026-10-29: too early to optimise builds). The budget below is the baseline to re-derive when enforcement returns.

The complete milestone-2 papo client slice measures 3,104,405 bytes from rustc, 2,986,655 bytes
after `wasm-bindgen`, 1,224,614 bytes after `wasm-opt -Oz`, and 494,013 bytes with gzip level 9.
The checked uncompressed budget is therefore 1,347,400 bytes, the measured shipping artifact plus
10% headroom rounded up to the next hundred bytes. The increase links papo's WebSocket transport,
IRC state machine, SASL, history, and Unicode PRECIS implementation into the worker.

Timing scenarios run after one warm-up and produce enough samples for p95. Interaction scenarios
with quantised frame samples repeat within the test and report median and p95-of-runs rather than
treating one pass as stable. A run with fixture errors, missing marks, or an environment mismatch is
invalid, never zero. Absolute budgets apply where adopted; baseline comparison additionally flags
regressions above 10% and a metric-specific noise floor. Baseline updates require a reviewed
environment fingerprint and explanation.

## Bundles and Rust benchmarks

`size-limit` gates JS/CSS and reports dependency provenance. `wasm-opt` produces the checked release
artifact; `twiggy` explains growth. Rare routes remain separate chunks.

Rust uses `divan` for deterministic engine hot paths needed by the four scenarios, initially event
reduction, action projection, and encoding a 2,000-entry patch. `dhat` may assert stable peak
allocations. Microbenchmarks guide changes; only stable measurements on the pinned runner become
gates.

## CI and developer feedback

PR CI starts the flake's one local Ergo fixture and runs the four scenarios in Chromium.
Functional e2e journeys may share the fixture but have independent assertions. Nightly repeats the
same set under stress until later scenarios are designed.

The dev-only overlay displays the latest switch/input duration, recent blocking events, queue
depths, rendered rows, and available memory figures. It updates only when open and when samples
arrive, with no idle polling, and exports its bounded snapshot as JSON.

## Boundaries

This subsystem owns fixture orchestration, traffic scripts, marks/observers, metric collection,
budgets, baselines, regression evaluation, and the dev overlay. It does not implement IRC, ship
telemetry, parse private traffic, or treat a scripted in-memory server as live-server coverage.

## Testing the harness

- Unit tests cover manifest decoding, percentile/budget math, fingerprints, and redaction.
- A tiny self-test app deliberately creates a long task, layout shift, and bundle excess; each
  detector must fail it.
- Driver tests assert deterministic readiness/barriers and teardown after success or failure.
- Golden result JSON keeps schema consumers stable.
- CI periodically runs a deliberate regression to prove the gate remains active.

## Out of scope

Public telemetry, a cloud device lab, continuous third-party load, and native-device automation are
not part of milestone 1.

## Later

- Add scroll/history, reconnect, navigation, six-pane, idle, hidden-tab, and long-session soak
  scenarios when those subsystems exist.
- Expand to soju and other server profiles for compatibility, not a cross-product performance
  matrix.
- Apply the adopted starting memory targets of 220MiB attributable web memory and 350MiB desktop
  RSS when soak/native harnesses land.
- Add Tauri and real-device release measurements with their packaging milestones.

## Decisions

- Use Ergo only in pull-request performance gates.
- Start JS/CSS budgets at 250KiB/60KiB gzip and derive the wasm budget from measurement.
- Adopt 220MiB web-attributable and 350MiB desktop RSS as later soak starting budgets.
- Use `divan` for engine benchmarks.
- Luiz, 2026-10-27: run milestone-1 performance scenarios against this repository's small local
  nixpkgs Ergo fixture; do not depend on a packaged papo test server.
- Luiz, 2026-10-27: reserve `papo_testing::wire()` for native scripted engine tests, with `papo`
  and unpublished `papo-testing` pinned to the same git revision.

## Questions for Luiz / papo gaps

1. Which CI runner class can be pinned for gating measurements, and may later soak jobs reserve it
   for 30–60 minutes?
