# 02 — Engine ↔ UI protocol

Status: proposed for milestone 1 review.

## Problem

The same SolidJS UI talks to a wasm engine in a SharedWorker (or dedicated Worker fallback) and a
native Rust engine through Tauri IPC. The boundary must be versioned, strongly typed, ordered,
recoverable after missed updates, and cheap during bursts. Transport details must not leak into
features or shells.

This protocol exposes application projections, not papo types and not the engine's entire internal
state. Commands express user intent. Atomic patch batches advance an immutable revision. Command
results report completion but do not become a second state source.

## Wire envelope

Rust is the schema source. `serde` defines the representation and `ts-rs` generates checked
TypeScript declarations in CI. Generated files are committed so protocol changes are reviewable.

```rust
pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;

pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum UiToEngine {
    Hello(Hello),
    Command(CommandEnvelope),
    Resync(ResyncRequest),
    SetVisibility(VisibilityState),
    Goodbye,
}

#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum EngineToUi {
    Welcome(Welcome),
    Snapshot(SnapshotChunk),
    Patch(PatchBatch),
    CommandResult(CommandResult),
    Fatal(FatalProtocolError),
}

pub struct Hello {
    pub version: ProtocolVersion,
    pub client_id: UiClientId,
    pub last_revision: Option<Revision>,
    pub shell: ShellKind,
}

pub struct Welcome {
    pub version: ProtocolVersion,
    pub engine_instance: EngineInstanceId,
    pub current_revision: Revision,
    pub resume: ResumeDisposition,
}

pub enum ResumeDisposition {
    PatchesFollow,
    SnapshotFollows { snapshot_id: SnapshotId },
    UpToDate,
}
```

A major mismatch returns `Fatal::IncompatibleVersion` and the web shell reloads its cached app
assets once before presenting recovery UI. A minor mismatch is accepted only when the receiver's
minor version is at least the sender's declared `minimum_peer_minor`. Additive optional fields are
minor changes; changing meaning, required fields, or union variants is major.

JSON is the canonical encoding for milestone 1 on both `postMessage` and Tauri IPC. It is easy to
inspect and makes adapter parity testable. Binary encoding is an optimization that requires a new
minor negotiation, not a platform-specific fork.

## Commands

```rust
#[repr(transparent)]
pub struct CommandId(Uuid);

pub struct CommandEnvelope {
    pub id: CommandId,
    pub expected_revision: Option<Revision>,
    pub command: Command,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Connect { network_id: NetworkId },
    Disconnect { network_id: NetworkId, reason: Option<String> },
    AddNetwork { draft: NetworkDraft },
    RemoveNetwork { network_id: NetworkId },
    SendMessage { buffer_id: BufferId, draft: OutgoingMessage },
    RetryMessage { buffer_id: BufferId, send_id: LocalSendId },
    JoinChannel { network_id: NetworkId, channel: String, key_ref: Option<SecretRef> },
    PartChannel { buffer_id: ChannelBufferId, reason: Option<String> },
    MarkRead { buffer_id: BufferId, through: EventId },
    LoadHistory { buffer_id: BufferId, direction: HistoryDirection },
    SetTyping { buffer_id: ChatBufferId, state: TypingState },
    React { buffer_id: ChatBufferId, message: MessageKey, reaction: String },
    Unreact { buffer_id: ChatBufferId, message: MessageKey, reaction: String },
    Redact { buffer_id: ChatBufferId, message: MessageKey, reason: Option<String> },
    SetSetting { change: SettingChange },
}

pub struct OutgoingMessage {
    pub text: NonEmptyString,
    pub kind: OutgoingKind,
    pub reply_to: Option<MessageKey>,
}

pub enum HistoryDirection {
    Older { before: EventId, limit: PageSize },
    Newer { after: EventId, limit: PageSize },
    Around { event: EventId, limit: PageSize },
}
```

Distinct newtypes (`ChannelBufferId`, `ChatBufferId`, `PageSize`, `NonEmptyString`) are validated at
deserialization and eliminate invalid command combinations. The generated TS surface provides
constructors that return `Result`-like validation outcomes; feature code never casts plain strings
to these brands.

`expected_revision` is required only for compare-and-set operations such as settings edits that
could overwrite a concurrent tab. Messaging and navigation-safe engine commands omit it. Every
command is idempotent by `CommandId` within a bounded replay window: repeating a completed command
returns the cached result; it does not send twice.

```rust
pub struct CommandResult {
    pub id: CommandId,
    pub outcome: CommandOutcome,
}

pub enum CommandOutcome {
    Accepted,
    Completed { at_revision: Revision },
    Rejected { error: UserError },
}
```

`Accepted` is used only for long-running work. The resulting state remains authoritative and
arrives as patches. For sends, the optimistic pending message is included in a patch before or in
the same delivery turn as `Accepted`.

## Snapshots and typed patches

The UI store is a normalized projection containing summaries and only message/member ranges that
the UI requested or may render. It does not mirror all engine history.

```rust
pub struct UiSnapshot {
    pub revision: Revision,
    pub app: AppProjection,
    pub networks: Vec<NetworkProjection>,
    pub buffers: Vec<BufferProjection>,
    pub ranges: Vec<TimelineRange>,
    pub capabilities: Vec<CapabilityProjection>,
    pub settings: SettingsProjection,
}

pub struct SnapshotChunk {
    pub snapshot_id: SnapshotId,
    pub revision: Revision,
    pub index: u32,
    pub count: NonZeroU32,
    pub payload: SnapshotPayload,
}

pub enum SnapshotPayload {
    Header(AppProjection),
    Networks(Vec<NetworkProjection>),
    Buffers(Vec<BufferProjection>),
    Timeline(TimelineRange),
    Capabilities(Vec<CapabilityProjection>),
    Settings(SettingsProjection),
}

pub struct PatchBatch {
    pub from: Revision,
    pub to: Revision,
    pub patches: Vec<Patch>,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Patch {
    NetworkUpserted { network: NetworkProjection },
    NetworkRemoved { network_id: NetworkId },
    NetworkOrderSet { ids: Vec<NetworkId> },
    BufferUpserted { buffer: BufferProjection },
    BufferRemoved { buffer_id: BufferId },
    BufferOrderSet { network_id: NetworkId, ids: Vec<BufferId> },
    TimelinePrepended { range: TimelineRange },
    TimelineAppended { range: TimelineRange },
    TimelineEntriesUpserted { buffer_id: BufferId, entries: Vec<TimelineProjection> },
    TimelineEntriesRemoved { buffer_id: BufferId, ids: Vec<EventId> },
    MemberSnapshotSet { buffer_id: ChannelBufferId, members: Vec<MemberProjection> },
    MembersChanged { buffer_id: ChannelBufferId, changes: Vec<MemberChange> },
    CapabilitiesSet { network_id: NetworkId, value: CapabilityProjection },
    SettingChanged { change: SettingProjectionChange },
}
```

There is deliberately no JSON Patch path or arbitrary key/value mutation. Every patch names a
valid domain transition and is exhaustively handled in Rust and TypeScript. A batch is applied in
one Solid `batch()` call; intermediate states are unobservable.

A receiver accepts a patch only when `batch.from === store.revision`. A gap, duplicate with a
different payload, unknown required union variant, incomplete snapshot, or engine-instance change
triggers `Resync`. Snapshot chunks are staged outside the live store, checked for completeness and
one revision, then swapped atomically. Patches after that revision may queue while chunks arrive.

## Batching and flow control

The engine reducer commits immediately, but projection changes are coalesced for at most one UI
frame (16 ms while visible). It combines repeated upserts by ID, collapses add/remove pairs that
have no observable result, and retains timeline ordering. Command results and fatal errors bypass
the frame delay.

When a page is hidden, its adapter sends `SetVisibility::Hidden`; the SharedWorker/native engine
continues protocol and storage work but retains only a bounded patch journal. On visibility, one
coalesced catch-up batch or a snapshot is sent. A client whose outbound queue exceeds 256 batches
is marked stale and receives a snapshot instead of unbounded buffering.

Papo's event queue remains separately bounded. `Event::Lagged` is a correctness boundary: the
engine refreshes papo state, invalidates projections that cannot be reconstructed, schedules
history repair where supported, and emits one consistent patch or snapshot. Increasing queues is
not the recovery strategy.

## Adapter interface

```ts
export interface EngineClient {
  readonly status: Accessor<EngineClientStatus>;
  start(hello: Hello): Promise<void>;
  send(command: CommandEnvelope): Promise<CommandResult>;
  resync(reason: ResyncReason): void;
  setVisibility(state: VisibilityState): void;
  subscribe(listener: (message: EngineToUi) => void): Unsubscribe;
  close(): Promise<void>;
}

export type EngineClientStatus =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly instance: EngineInstanceId }
  | { readonly kind: "recovering"; readonly reason: ResyncReason }
  | { readonly kind: "fatal"; readonly error: FatalProtocolError };
```

`WorkerEngineClient` owns `MessagePort` coordination and SharedWorker/dedicated-Worker fallback.
`TauriEngineClient` owns command invocation and event listener teardown. Components import only the
interface from `app/src/engine`; neither adapter is reachable from features.

In a SharedWorker, every tab has a distinct `UiClientId` and projection subscription while all
share one engine instance and IRC connection. Dedicated Workers are explicitly independent; the
UI reports that another tab may create another connection rather than pretending they coordinate.

## Error model

```rust
pub enum UserError {
    InvalidInput { field: Option<FieldPath>, message_key: ErrorMessageKey },
    Unsupported { feature: ProductFeature, reason: UnsupportedReason },
    Conflict { current_revision: Revision },
    Offline { network_id: NetworkId },
    PermissionDenied,
    ServerRefused { code: String, message: String },
    TimedOut { may_have_completed: bool },
    Internal { incident_id: IncidentId },
}

pub enum FatalProtocolError {
    IncompatibleVersion { engine: ProtocolVersion, ui: ProtocolVersion },
    CorruptMessage { incident_id: IncidentId },
    EngineUnavailable { incident_id: IncidentId },
}
```

Papo errors are mapped once in the engine adapter: `InvalidInput`, `Unsupported`, typed server
refusals, timeout ambiguity, and disconnection remain distinct. Secrets, raw credentials, and raw
server lines that may contain secrets never cross in errors. User-facing prose is selected by the
UI localization layer from stable message keys.

## Boundaries

This subsystem owns schema, compatibility, command dispatch, projection patches, batching,
resynchronization, and the platform-neutral `EngineClient` contract. It must not own IRC parsing,
domain reduction, storage, shell navigation, localization prose, or transport-specific UI logic.

The worker and Tauri adapters may encode, send, receive, and reconnect IPC. They must not alter
commands, synthesize domain patches, or maintain divergent state.

## Testing

- Rust serialization goldens and generated-TypeScript freshness checks run in CI.
- Contract tests feed the same transcript through worker and Tauri test adapters and compare every
  decoded envelope.
- Reducer-to-projection tests verify atomic batches and exhaustive patch application.
- Property tests drop, duplicate, reorder, and corrupt messages, proving gaps always resync and no
  partial snapshot becomes visible.
- Multi-tab browser tests verify one SharedWorker engine, independent subscriptions, command
  deduplication, hidden-tab catch-up, and dedicated-Worker fallback messaging.
- Burst benchmarks measure encode/decode cost, coalescing, queue depth, and Solid application time
  for 2,000 messages.

## Out of scope

Native UI bindings (UniFFI), binary wire formats, remote engine access, cross-device state sync,
telemetry, and per-feature command UX are not part of milestone 1.

## Questions for Luiz / papo gaps

1. Approve JSON as the initial common encoding and `ts-rs` as the schema generator, or prefer
   Specta because of anticipated Tauri integration?
2. Is a 256-batch per-client stale threshold acceptable, subject to performance-harness tuning?
3. Should dedicated-Worker fallback explicitly warn about duplicate IRC connections when multiple
   tabs are open, or is a diagnostics-only indication sufficient?
