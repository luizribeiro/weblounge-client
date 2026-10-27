# 02 — Engine ↔ UI protocol

Status: revised for milestone 1 review.

## Problem

One SolidJS UI talks to a wasm worker now and a Tauri engine later. The boundary must be strongly
typed, ordered, recoverable after missed updates, and cheap during bursts without adding protocol
negotiation for two artifacts that ship together.

Rust is the schema source. `serde` defines JSON and `ts-rs` generates committed TypeScript types.
The protocol exposes application projections, never papo types or the engine's complete state.

## Connection and build compatibility

```rust
pub struct Hello {
    pub build_id: BuildId,
    pub client_id: UiClientId,
    pub last_revision: Option<Revision>,
    pub shell: ShellKind,
}

pub enum EngineToUi {
    Ready { engine_instance: EngineInstanceId, revision: Revision },
    Snapshot(UiSnapshot),
    Patch(PatchBatch),
    CommandResult(CommandResult),
    IncompatibleBuild { engine: BuildId, ui: BuildId },
    Fatal(FatalError),
}
```

The UI and engine carry the same content-derived build ID. A mismatch means a stale SharedWorker
or cached UI: the web shell reloads assets once, then presents recovery UI if the mismatch remains.
There is no major/minor negotiation in milestone 1.

## Commands

```rust
pub struct CommandEnvelope {
    pub id: CommandId,
    pub command: Command,
}

pub enum Command {
    Connect { network_id: NetworkId },
    Disconnect { network_id: NetworkId, reason: Option<String> },
    AddNetwork { draft: NetworkDraft },
    RemoveNetwork { network_id: NetworkId },
    SendMessage { buffer_id: ChatBufferId, draft: OutgoingMessage },
    RetryMessage { send_id: LocalSendId },
    JoinChannel { network_id: NetworkId, channel: String, key_ref: Option<SecretRef> },
    OpenDirect { network_id: NetworkId, nick: String },
    PartChannel { buffer_id: ChannelBufferId, reason: Option<String> },
    MarkRead { buffer_id: BufferId, through: EventId },
    MarkAllRead,
    LoadHistory { buffer_id: BufferId, direction: HistoryDirection },
    SetTyping { buffer_id: ChatBufferId, state: TypingState },
    React { action: ReactionAction },
    Unreact { action: ReactionAction },
    Redact { action: RedactAction },
    SubmitInput { buffer_id: BufferId, input: NonEmptyString },
    CompleteInput { buffer_id: BufferId, input: String, cursor: Utf16Offset },
    SetSetting { change: SettingChange },
}
```

`SubmitInput` is the engine-owned slash-command parser/validator path required by the brief;
ordinary chat input may be normalized into `SendMessage`. `CompleteInput` returns engine-derived
nick, channel, and command candidates without moving parsing into the UI. `OpenDirect` backs the
mobile/desktop `+` action. `MarkAllRead` uses the engine's current eligible buffer set.

Newtypes such as `ChatBufferId`, `PageSize`, and `NonEmptyString` are validated during decode.
Command results acknowledge success/failure, while state changes remain authoritative only through
snapshots and patches.

## Snapshot and patches

```rust
pub struct UiSnapshot {
    pub revision: Revision,
    pub app: AppProjection,
    pub networks: Vec<NetworkProjection>,
    pub buffers: Vec<BufferProjection>,
    pub ranges: Vec<TimelineRange>,
    pub settings: SettingsProjection,
    pub unread_priority: Vec<BufferId>,
}

pub struct PatchBatch {
    pub from: Revision,
    pub to: Revision,
    pub patches: Vec<Patch>,
}

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
    MemberProjectionSet { buffer_id: ChannelBufferId, members: Vec<MemberProjection> },
    BufferActionsSet { buffer_id: BufferId, actions: BufferActions },
    MessageActionsSet { buffer_id: BufferId, actions: Vec<MessageActions> },
    UnreadPrioritySet { ids: Vec<BufferId> },
    SettingChanged { change: SettingProjectionChange },
}
```

The normalized UI store contains only summaries and requested/renderable ranges. `unread_priority`
is the engine-computed mention → DM → unread ranking consumed by command `buffer.jump-important`;
the keymap remains subsystem 14.

Patches name domain transitions rather than JSON paths. A batch applies in one Solid `batch()`.
The receiver accepts it only when `from` equals its revision; a gap or engine-instance change asks
for a fresh atomic snapshot. Milestone-1 snapshots are single envelopes.

## Batching and flow control

Projection changes coalesce for at most one visible UI frame. Repeated upserts collapse by ID,
add/remove pairs with no visible result disappear, and timeline order is retained. Command promises
resolve immediately, but subscriber notifications stay in engine emission order and join the frame
batch when an earlier projection is queued. Fatal errors bypass the frame delay.

Hidden clients stop receiving render patches. The engine retains a bounded journal and sends one
catch-up batch or snapshot on visibility. A client whose outbound queue exceeds 256 batches is
marked stale and resynchronized. Diagnostics records the event and the UI shows one non-repeating
notice; normal rendering is not interrupted.

Papo's event queue is separate. `Event::Lagged` causes the engine to re-read papo state, repair
history where supported, and publish one consistent projection. `DisconnectCause::SlowConsumer`
is surfaced as a connection failure and diagnostic, not mistaken for an IPC queue event.

## Adapter and errors

```ts
export interface EngineClient {
  start(hello: Hello): Promise<void>;
  send(command: CommandEnvelope): Promise<CommandResult>;
  requestSnapshot(reason: ResyncReason): void;
  setVisibility(state: VisibilityState): void;
  subscribe(listener: (message: EngineToUi) => void): Unsubscribe;
  close(): Promise<void>;
}
```

Worker and future Tauri adapters implement this interface without altering commands or creating
state. Each SharedWorker tab has its own subscription while sharing one engine. Dedicated-worker
fallback is independent; diagnostics plus a one-time notice explains possible duplicate
connections across tabs.

Errors remain typed: invalid input, unsupported action, offline, permission denied, server refusal,
timeout ambiguity, and internal incidents. Raw credentials and potentially secret server lines do
not cross IPC. UI localization maps stable message keys to prose.

## Boundaries

This subsystem owns JSON schema, build matching, commands, projections, atomic patches, batching,
resync, and `EngineClient`. It does not own IRC parsing, domain reduction, navigation, shortcut
chords, or localized copy.

## Testing

- Serialization goldens and generated-TypeScript freshness checks run in CI.
- Worker and future Tauri adapter contract tests replay the same envelopes.
- Projection tests verify atomic patch application, action removal, unread ranking, and gap resync.
- Multi-tab browser tests cover SharedWorker sharing, hidden-tab catch-up, the 256-batch threshold,
  build mismatch reload, and dedicated-worker notice behavior.
- Burst benchmarks measure JSON cost, coalescing, queue depth, and Solid application time.

## Out of scope

Native UI bindings, remote engines, cross-device state sync, and telemetry are later work.

## Later

- Add protocol version negotiation only if UI and engine gain independent release lifecycles.
- Add compare-and-set settings, command replay/idempotency, and chunked snapshots only when real
  multi-client measurements require them.
- Consider binary encoding only after JSON is measured as a bottleneck.

## Decisions

- Use JSON with `ts-rs` generated types.
- Keep the stale-client threshold at 256 batches until harness measurements justify changing it.
- Report dedicated-worker duplicate-connection risk in diagnostics and a one-time user notice.
