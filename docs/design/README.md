# weblounge design index

Status: milestone 1 design set revised after review. No implementation is authorized by these
documents alone.

## Problem

This index maps the build brief to focused subsystem designs, repository boundaries, and a
reproducible toolchain. The brief, its addenda, and the prototype remain authoritative.

## Milestone 1 documents

| Subsystem | Document | Primary decision |
|---|---|---|
| 1. Engine state model | [01-engine-state-model.md](01-engine-state-model.md) | The engine adds application identity and bounded timelines while projecting live IRC state from papo. |
| 2. Engine ↔ UI protocol | [02-engine-ui-protocol.md](02-engine-ui-protocol.md) | Rust-defined JSON commands and atomic typed patches use one adapter contract. |
| 3. Transport and connection | [03-transport-and-connection.md](03-transport-and-connection.md) | Papo owns transport, CAP, SASL, and reconnect; platform conversion keeps browser TCP unavailable. |
| 8. Theming and tokens | [08-theming-and-tokens.md](08-theming-and-tokens.md) | One data file per theme generates CSS variables and picker previews. |
| 9. Density and layout | [09-density-and-layout.md](09-density-and-layout.md) | TypeScript density data and a validated six-leaf pane tree drive the two shells. |
| 10. Navigation | [10-navigation.md](10-navigation.md) | Desktop uses focused tiling; mobile uses independent tab stacks. |
| 14. Commands and shortcuts | [14-commands-and-shortcuts.md](14-commands-and-shortcuts.md) | One typed registry resolves capability-aware actions and platform/shell-safe bindings. |
| 17. Capability model | [17-capability-model.md](17-capability-model.md) | Typed papo features become per-buffer and per-message action projections. |
| 21. Performance harness | [21-performance-harness.md](21-performance-harness.md) | A real-server CLI, app marks, CDP metrics, and measured budgets gate regressions. |

Later designs retain the brief's two-digit numbering. Storage (04), history (05), Activity (06),
push (07), rendering (11), virtualization (12), composer (13), selection (15), settings (16),
onboarding (18), packaging (19), and hosted mode (20) remain undesigned.

## Repository and dependency boundaries

```text
crates/engine/          platform-neutral product state and papo composition
crates/engine-wasm/     worker entry and wasm bindings only
crates/perf-driver/     scripted real-server traffic
crates/push-relay/      later independently deployed service
app/src/engine/         EngineClient and worker/Tauri adapters
app/src/features/       feature-sliced SolidJS UI
app/src/shells/         desktop and mobile composition
app/src/ui/             shared primitives
app/themes/             one data file per theme
apps/tauri/             later desktop/mobile shells
tests/                  e2e, performance, and visual suites
```

Dependencies point inward as follows:

```text
app features → app UI + EngineClient types
shells       → app features + navigation/layout
adapters     → generated protocol + worker/Tauri API
engine-wasm  → engine
Tauri shell  → engine
engine       → papo + reviewed platform-service interfaces
perf-driver  → papo
```

The engine has no DOM or Tauri types. Features cannot import concrete adapters or another
feature's internals. `engine-wasm` and shells contain no product rules. These edges are enforced
by Cargo dependencies and TypeScript import rules.

Milestone 1 does not introduce a generic `Engine<S, C, P, N>`. The concrete engine owns papo and
the services required by the vertical slice. Storage, push, and notification interfaces are
added only with their reviewed designs.

## Toolchain

The repository flake pins Rust, Node.js LTS, pnpm, Chromium/Playwright, Biome, TypeScript, Vite,
Vitest, `cargo-nextest`, rustfmt, clippy, `wasm-opt`, `twiggy`, `size-limit`, Lighthouse CI, and
memlab. `wasm-bindgen-cli` is pinned to papo's `wasm-bindgen` version, currently `0.2.129` at papo
revision `7d5e4bf`.

The initial dev shell contains only tools needed for the web vertical slice. Tauri libraries,
the Android SDK/NDK, and `rust-src` wait for the packaging milestone. CI initially
gates x86_64-linux with Chromium; platform packaging checks arrive with their shells.

Rust uses edition 2024, strict clippy/rustfmt, `thiserror`, and no `unwrap` outside tests. The
browser engine is `wasm32-unknown-unknown` in a worker; native Tauri later runs the same engine
crate directly. TypeScript enables all strictness options from the brief. CSS Modules are the sole
component styling mechanism.

## Direct dependency register

Only dependencies justified by the current designs are selected now.

| Dependency | Scope and reason |
|---|---|
| `papo` | All IRC/IRCv3 parsing, state, typed actions, CAP/SASL, history, and transports. Use default `tls-ring` natively, `websocket` where needed, and `precis` because Ergo compares nicks with PRECIS by default. |
| `serde`, `serde_json` | Rust-owned JSON IPC and durable data shapes. |
| `thiserror` | Typed error boundaries. |
| `tracing` | Local diagnostics and performance spans. |
| `tokio` | Papo already uses it on native and wasm; native engine task coordination also uses it. |
| `tokio-util` | Cancellation tokens for structured connection-task shutdown. |
| `wasm-bindgen`, `wasm-bindgen-futures`, `web-sys` | Narrow worker bridge and browser APIs; versions remain compatible with papo. |
| `solid-js` | Fine-grained DOM reactivity. |
| `@tanstack/solid-virtual` | Bounded message/member DOM. |

`ts-rs`, Vite, `vite-plugin-solid`, Biome, Vitest, Solid Testing Library, jsdom, Playwright,
`wasm-bindgen-test`, `cargo-nextest`, `proptest`, `divan`, `dhat`, size-limit, twiggy, wasm-opt,
Lighthouse CI, and memlab are build/test dependencies and do not ship as app runtime choices.

Milestone 1 does not add `uuid`, `indexmap`, `zeroize`, `url`, `@tauri-apps/api`, or Tauri. Local
monotonic `u64` identifiers are sufficient; explicit vectors own presentation order; credentials
use `papo::Secret`; remote-icon URL handling is deferred; and Tauri dependencies arrive with
milestone 7.

## Testing infrastructure

Pure domain tests do not depend on `papo-testing`. Where an exact protocol transcript is useful,
`papo_testing::wire()` runs a real papo `Client` over an in-memory scripted server on native/WASI;
it is not a browser-wasm fixture and it always enables papo's `unstable` feature.

Browser and live integration tests start real servers through the proposed exported
`papo-test-server` package/CLI. The required supported interface is one JSON line containing IRC,
`ws`, and `wss` URLs plus fixture accounts; closing stdin tears the fixture down, and an optional
`FaultProxy` enables connection faults. Exporting that package and CLI is an explicit pending papo
dependency, not assumed to exist at revision `7d5e4bf`.

If Luiz does not approve that export, this repository's flake runs nixpkgs `ergochat` and `soju`
and provides the same JSON/stdin lifecycle contract. The weblounge VM `test-ergo` remains the
hosted-mode fixture. Pull requests use Ergo; broader server coverage belongs to later capability
and compatibility work.

## Boundaries and testing

This index owns placement, dependency direction, baseline tools, and the dependency register. It
does not approve implementation or preselect dependencies reserved for later designs.

CI checks formatting, lint, strict types, generated TypeScript freshness, native domain tests,
browser worker tests, Playwright journeys, dependency policy, and the milestone-1 Ergo performance
smoke. Generated protocol/theme output must be reproducible.

## Later

- Reconsider a generic `Engine<S, C, P, N>` only after the storage, push, and notification service
  designs establish real abstraction needs.
- Add Tauri, mobile toolchains, signing, and platform packaging in milestones 7–8.
- Expand real-server compatibility coverage after the Ergo vertical slice.

## Decisions

- Use pnpm with pinned Node.js LTS.
- Generate TypeScript protocol types with `ts-rs` and encode milestone-1 IPC as JSON.
- Use papo's default `tls-ring` provider.
- Keep the future push relay in this repository, built and deployed independently.
- Gate initial CI on x86_64-linux with Chromium.

## Questions for Luiz

1. May shipping builds enable papo's `unstable` feature when milestones 5–6 need bouncer and Web
   Push APIs, or must those APIs stabilize first?
