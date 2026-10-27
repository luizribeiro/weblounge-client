# weblounge design index

Status: milestone 1 design set proposed for Luiz's review. No implementation is authorized by
these documents alone.

## Problem

Weblounge needs one discoverable map from the build brief to focused subsystem designs, repository
boundaries, and a reproducible toolchain. The map must keep the wasm worker and native Tauri engine
honest without multiplying product logic, and it must make every runtime dependency earn its place.

The brief and prototype remain authoritative. These documents explain an implementation approach;
when they conflict with `docs/reference/brief.md`, `docs/reference/split-view.md`, or prototype
behavior, the reference wins until Luiz resolves the conflict.

## Milestone 1 documents

| Subsystem | Document | Primary decision |
|---|---|---|
| 1. Engine state model | [01-engine-state-model.md](01-engine-state-model.md) | Stable local network/buffer/event IDs wrap typed papo events; the engine is the IRC source of truth. |
| 2. Engine ↔ UI protocol | [02-engine-ui-protocol.md](02-engine-ui-protocol.md) | Rust-defined versioned commands and atomic typed patches use one adapter contract. |
| 3. Transport and connection | [03-transport-and-connection.md](03-transport-and-connection.md) | Papo owns transport/CAP/SASL/reconnect; platform endpoint types make browser TCP unconstructable. |
| 8. Theming and tokens | [08-theming-and-tokens.md](08-theming-and-tokens.md) | Validated theme data generates CSS variables, registries, and previews; components use CSS Modules. |
| 9. Density and layout | [09-density-and-layout.md](09-density-and-layout.md) | Independent density data and a validated six-leaf binary pane tree drive both shells. |
| 10. Navigation | [10-navigation.md](10-navigation.md) | Desktop uses focused tiling with accessible placement; mobile uses independent tab stacks. |
| 17. Capability model | [17-capability-model.md](17-capability-model.md) | Typed papo features become current-generation product witnesses and concrete UI actions. |
| 21. Performance harness | [21-performance-harness.md](21-performance-harness.md) | Real papo server fixtures, app marks, CDP metrics, and absolute budgets gate regressions. |

Later subsystem documents use the two-digit numbering from brief §7 and are added before their
implementation. In particular, storage (04), history (05), Activity (06), push (07), rendering
(11), virtualization (12), composer (13), commands (14), selection (15), settings (16), onboarding
(18), packaging (19), and hosted mode (20) remain undesigned.

## Proposed repository layout

```text
.
├── Cargo.toml                    # Rust workspace only
├── flake.nix                     # pinned dev shell and CI checks
├── flake.lock
├── crates/
│   ├── engine/                   # platform-neutral domain engine
│   │   └── src/
│   │       ├── state/            # subsystem 01 reducer and projections
│   │       ├── protocol/         # subsystem 02 generated boundary source
│   │       ├── connection/       # subsystem 03 supervisors
│   │       └── capabilities/     # subsystem 17 witnesses/projections
│   ├── engine-wasm/              # wasm bindings and worker entry only
│   ├── perf-driver/              # real-server scripted traffic
│   └── push-relay/               # later standalone service; absent until design 07
├── app/
│   ├── package.json
│   ├── src/
│   │   ├── app/                  # composition root, providers, startup
│   │   ├── engine/               # EngineClient interface and adapters
│   │   ├── features/
│   │   │   ├── activity/
│   │   │   ├── chat/
│   │   │   ├── onboarding/
│   │   │   ├── settings/
│   │   │   └── sidebar/
│   │   ├── shells/
│   │   │   ├── desktop/
│   │   │   └── mobile/
│   │   ├── ui/                   # shared primitives only
│   │   ├── performance/          # bounded marks/observers/dev overlay
│   │   └── generated/            # reviewed Rust-generated protocol/types
│   ├── themes/                   # one validated JSON file per theme
│   └── public/                   # PWA/brand/static assets
├── apps/
│   └── tauri/                    # Tauri 2 desktop/mobile shell and native glue
│       ├── src-tauri/
│       ├── gen/apple/            # later iOS NSE integration
│       └── gen/android/          # later FCM service integration
├── tests/
│   ├── e2e/                      # Playwright product journeys
│   ├── performance/              # scenario/budget runner and baselines
│   └── visual/                   # theme × density screenshot matrix
└── docs/
    ├── design/
    └── reference/
```

Each Rust subsystem exposes a small public module and keeps papo-facing conversion at its edge.
`engine-wasm` contains no product rules. Tauri commands call the same `engine` crate. `app/src`
features import another feature only through its public `index.ts`; shells compose features but do
not contain engine or IRC logic.

The push relay is in this repository for shared types and review but builds/deploys independently.
Native notification-extension code remains under the Tauri app because it is signed and packaged
with that application.

## Boundary contracts

The intended dependency direction is:

```text
app features → app UI + EngineClient types
shells       → app features + navigation/layout
adapters     → generated protocol + worker/Tauri API
engine-wasm  → engine
Tauri shell  → engine
engine       → papo + platform service traits
perf-driver  → papo + papo test fixtures
```

No reverse edge is allowed. In particular, the engine cannot depend on DOM/Tauri types; features
cannot import concrete adapters; and no crate other than the engine/perf driver imports papo.
Dependency rules are enforced with workspace crate edges and a TypeScript import-boundary lint,
not convention alone.

Representative composition signatures:

```rust
pub struct Engine<S, C, P, N>
where
    S: Storage,
    C: Clock,
    P: PushRegistrar,
    N: Notifier;

pub fn run_native_engine(services: NativeServices) -> NativeEngineHandle;
pub fn run_wasm_engine(services: WebServices) -> WasmEngineHandle;
```

```ts
export interface AppDependencies {
  readonly engine: EngineClient;
  readonly platform: PlatformServices;
  readonly config: DeploymentConfig;
}

export function mountApp(root: HTMLElement, dependencies: AppDependencies): Dispose;
```

The trait list is architectural; storage/push implementations wait for their own reviewed designs.

## Nix development shell

One flake pins tools for Linux and macOS and exposes `nix develop`, `nix flake check`, server
fixtures, and reproducible app builds. It follows the existing weblounge/papo Nix conventions
rather than wrapping every ordinary command in a custom task runner.

The shell includes:

- Rust stable matching papo's minimum (`1.91` initially), `rust-src`, rustfmt, clippy, and targets
  `wasm32-unknown-unknown` plus host-native targets;
- `cargo-nextest`, `cargo-deny`, `wasm-bindgen-cli`, Binaryen (`wasm-opt`), `twiggy`, and `dhat`/
  `divan` support;
- pinned Node.js LTS with Corepack and pnpm from the lockfile;
- Playwright browsers and their Nix runtime libraries;
- Biome, TypeScript, Vite, Vitest, size-limit, Lighthouse CI, and memlab through the pnpm lock;
- Tauri 2 system libraries on desktop, Android SDK/NDK/JDK tools on supported hosts, and Xcode
  commands supplied by the developer's macOS installation for Apple targets;
- pre-commit-hooks.nix checks matching CI.

The flake does not download signing keys, Apple profiles, Android keystores, push credentials, or
test account secrets. Those enter through platform credential mechanisms outside the Nix store.

## Rust and wasm toolchain

The workspace uses Rust edition 2024, resolver 3, one lockfile, `rust-version = 1.91`, warnings as
errors in CI, `unsafe_code = "deny"`, rustfmt, and clippy pedantic with documented local exceptions.
No `unwrap`/`expect` appears outside tests except an exhaustively justified process invariant.

Native engine tasks run on Tokio's Tauri-owned runtime. The browser engine compiles to
`wasm32-unknown-unknown`, runs in a worker, and uses `wasm-bindgen-futures::spawn_local`; no wasm
code runs inside Tauri. Release wasm is size-optimized and passed through `wasm-opt` after binding
generation.

Papo features are target-specific:

- browser: default features off where necessary, browser WebSocket backend, `precis`, and
  `unstable` only if Luiz approves the required bouncer/Web Push APIs;
- native: one TLS provider (`tls-ring` proposed), `websocket`, `precis`, and the same unstable
  decision;
- performance driver: native TLS/WebSocket plus fixture/test dependencies pinned to the same papo
  revision.

`papo-core` and `papo-proto` are never direct dependencies.

## TypeScript, SolidJS, and CSS toolchain

TypeScript enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`useUnknownInCatchVariables`; `any`, unchecked casts, and nonexhaustive domain switches fail lint.
Rust generates protocol declarations with `ts-rs`; a CI check fails when committed output differs.

Vite builds the web/PWA assets and supplies development HMR. `vite-plugin-solid` compiles SolidJS.
Components follow one component per file with its CSS Module and test beside it. Solid stores apply
engine patches in `batch`; props are read reactively and never destructured.

CSS Modules are the sole component styling mechanism. Theme/density generators emit custom
properties; component lint rejects raw colours and feature-internal imports. Global CSS is limited
to reset, font faces, generated tokens, platform-native shell behavior, and accessibility defaults.

## Runtime dependencies and justification

Every direct runtime dependency requires an entry here or in the later subsystem design that adds
it. Transitive dependencies are reviewed with `cargo-deny`, `pnpm audit`, bundle reports, and
licence checks.

### Rust engine

| Dependency | One-line justification |
|---|---|
| `papo` | Supplies all IRC/IRCv3 parsing, state, typed actions, CAP/SASL, history, and transports; reimplementation is forbidden. |
| `serde` | Defines the shared engine/UI and persisted-data representations once in Rust. |
| `serde_json` | Provides the inspectable common milestone-1 IPC encoding for workers and Tauri. |
| `thiserror` | Keeps public failures typed with explicit sources and no stringly error plumbing. |
| `tokio` (native only) | Drives papo and engine tasks in the native Tauri backend. |
| `uuid` | Generates stable, collision-resistant local IDs across devices, restarts, and offline creation. |
| `indexmap` | Preserves explicit network/buffer order without maintaining parallel maps and vectors. |
| `tracing` | Supplies structured local diagnostics and performance spans with no telemetry SDK. |
| `zeroize` | Clears temporary resolved credential buffers at the engine/platform boundary. |
| `url` | Validates non-IRC HTTPS/WebSocket resource URLs such as icons and deployment endpoints. |

### Wasm bridge

| Dependency | One-line justification |
|---|---|
| `wasm-bindgen` | Exposes the narrow worker entry and browser values to generated JavaScript glue. |
| `wasm-bindgen-futures` | Polls async engine/IPC work on the browser worker event loop. |
| `web-sys` | Provides typed worker ports, Web APIs, and later IndexedDB bindings without handwritten JS shims. |

Papo already owns browser WebSocket I/O; `engine-wasm` must not add another WebSocket library.

### Web UI

| Dependency | One-line justification |
|---|---|
| `solid-js` | Provides fine-grained reactive DOM updates for high-frequency chat state without a virtual DOM. |
| `@tanstack/solid-virtual` | Bounds message/member DOM size while handling measured rich rows and scroll anchors. |
| `@tauri-apps/api` (native bundle only) | Implements the concrete EngineClient/platform adapters to Tauri commands and events. |

There is no runtime router, global state library, CSS-in-JS library, icon framework, or date library:
typed navigation is small, Solid supplies stores, SVG icons are curated assets, and `Intl` handles
dates/numbers/plurals.

### Deferred runtime decisions

SQLite/IndexedDB helpers, service-worker tooling, secure credential plugins, notifications, native
push, APNs/FCM relay libraries, image processing, and entitlement/payment SDKs are not selected by
milestone 1. Their subsystem documents must justify them before addition. Candidate names in the
brief are research inputs, not dependencies.

## Build-time and test dependencies

These do not ship in the application runtime:

- `ts-rs` generates TypeScript from Rust protocol types and checks drift;
- Vite plus `vite-plugin-solid` builds and chunks the UI;
- Biome formats/lints TS, JSON, and CSS-adjacent source where supported;
- Vitest plus Solid Testing Library and jsdom runs fast component/adapter tests;
- Playwright exercises both shells and gathers CDP performance metrics;
- wasm-bindgen-test runs browser-target Rust tests;
- cargo-nextest runs native Rust tests; divan/dhat benchmark and profile hot paths;
- size-limit, twiggy, wasm-opt, Lighthouse CI, and memlab enforce artifact/performance budgets.

## Test commands and CI layers

The exact scripts are added with implementation, but their contracts are:

```text
nix flake check                 # formatting, lint, type generation, unit checks
pnpm test                       # TS/component tests
pnpm test:e2e                   # Playwright shell journeys
cargo nextest run --workspace   # native Rust tests
wasm-bindgen-test runner        # wasm worker tests in a real browser
pnpm test:perf                  # JSON performance smoke scenarios
```

Pre-commit runs formatting, generated-file checks, focused unit tests, and cheap lint. Pre-push/CI
runs full native/wasm tests, Playwright, real-server integration, visual matrices, dependency
policy, and performance smoke. Nightly CI runs the full server/performance/soak matrix.

Tests use real papo fixtures for protocol behavior. Snapshot tests are reserved for stable data
formats and intentional visuals, not used as a substitute for semantic assertions.

## Boundaries

This index owns repository/package placement, dependency direction, baseline toolchain choices,
and the dependency-justification register. It does not approve implementation, select dependencies
reserved for later designs, override subsystem types, or replace reference specifications.

## Testing this design contract

- CI checks every direct runtime dependency against this register and rejects undocumented ones.
- Rust workspace metadata and a TypeScript import graph enforce the documented edges.
- Native and wasm builds compile the same engine domain tests with platform-specific adapters.
- Generated protocol/theme files are reproducible and committed diffs are required.
- Nix flake checks run on Linux and macOS; mobile packaging checks run on appropriate hosts.

## Out of scope

Creating the flake, workspace, package manifests, source directories, generated files, or any
implementation scaffolding is explicitly outside this design-only task. CI hosting, signing,
deployment, store submission, storage, and push need their own reviewed designs.

## Questions for Luiz

1. Approve pnpm and Node LTS for the UI lockfile, or prefer the package manager already used by
   another Luiz project?
2. Approve `ts-rs` over Specta for protocol generation; subsystem 02 records the same choice.
3. Approve `tls-ring` as the single native rustls provider, including iOS/Android, or prefer
   `tls-aws-lc` on any target?
4. Is enabling papo's `unstable` feature acceptable for bouncer/Web Push work before those APIs
   stabilize?
5. Should the Rust workspace keep the future push relay in this repository (proposed) or split it
   into an infrastructure repository when subsystem 07 is designed?
6. Which Linux/macOS architectures and evergreen browser versions must `nix flake check` gate in
   the first vertical slice?
