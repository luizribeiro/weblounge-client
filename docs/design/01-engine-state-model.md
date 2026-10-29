# 01 — Engine state model

Status: revised for milestone 1 review.

## Problem

The engine is the application's source of truth, but papo is the source of live IRC state. The
engine adds stable application identity, cached timelines, optimistic sends, unread projections,
and bounded storage windows. It must not copy member, user, presence, typing, read-marker, or
capability state that `papo::Client::state()` already owns.

## Papo composition

Each active configured network owns one `papo::Client` and `papo::Events`. The engine consumes
typed events to decide what changed, then projects current protocol facts from `Client::state()`.
It re-reads the snapshot after `Connected`, `Disconnected`, `ChannelSynced`, `MembersRefreshed`,
and `Lagged` as papo documents.

Papo remains responsible for parsing, CAP/SASL, casemapping, membership, users, presence, typing,
read markers, batches, and formatting spans. The engine uses public `papo` types and never depends
directly on `papo-core` or `papo-proto`.

## Core application state

Illustrative Rust types:

```rust
pub struct EngineState {
    pub revision: Revision,
    pub network_order: Vec<NetworkId>,
    pub networks: HashMap<NetworkId, Network>,
    pub buffers: HashMap<BufferId, Buffer>,
    pub windows: HashMap<BufferId, MessageWindow>,
    pub pending_sends: HashMap<LocalSendId, PendingSend>,
}

pub struct Network {
    pub id: NetworkId,
    pub label: String,
    pub connection: ConnectionState,
    pub server_buffer: BufferId,
    pub buffer_order: Vec<BufferId>,
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

IDs are local monotonic `u64` newtypes allocated from persisted counters. Network and buffer order
exist only in the explicit vectors; maps have no ordering role. `Online` contains the current
action projection, so online-without-current-capabilities is unrepresentable. Subsystem 03 owns
the same connection-state vocabulary and its transitions.

```rust
pub struct Buffer {
    pub id: BufferId,
    pub network_id: NetworkId,
    pub kind: BufferKind,
    pub title: String,
    pub topic: Option<Topic>,
    pub activity: BufferActivity,
    pub local_last_read: Option<EventCursor>,
}

pub enum BufferKind {
    Server,
    Channel { conversation: ConversationKey },
    Direct { peer: PeerIdentity },
}

pub struct PeerIdentity {
    pub current_nick: String,
    pub account: Option<String>,
}
```

`BufferId` survives channel and proven nick changes. DM continuity prefers account identity, then
a typed papo nick-change chain; it never assumes that a later holder of an unproven nick is the
same person. Current channel members, user facts, DM presence, typing, and server read markers are
queried from the active papo snapshot when building UI projections. Server buffers may occupy
desktop panes.

IRC lookup always uses typed papo values or `State::name_rules()`; the engine never lowercases IRC
names itself.

## Timeline and optimistic sends

```rust
pub struct MessageWindow {
    pub entries: Vec<TimelineEntry>,
    pub older: PageBoundary,
    pub newer: PageBoundary,
}

pub struct TimelineEntry {
    pub id: EventId,
    pub order: EventOrder,
    pub origin: TimelineOrigin,
    pub body: TimelineBody,
}

pub enum TimelineOrigin {
    Received,
    Optimistic(LocalSendId),
}

pub struct PendingSend {
    pub state: PendingState,
    pub buffer_id: BufferId,
    pub placeholder: EventId,
}

pub enum PendingState {
    Sending,
    Failed(SendFailure),
}

pub struct ChatMessage {
    pub author: Author,
    pub authorship: Authorship,
    pub kind: ChatKind,
    pub text: FormattedText,
    pub server_ids: Vec<String>,
    pub reply_to: Option<String>,
    pub reactions: BTreeMap<ReactionKey, ReactionSummary>,
    pub tags: Vec<Tag>,
}
```

`LocalSendId` appears once: the timeline references the pending-send record, which owns delivery
state. A successful `papo::Sent` replaces the placeholder with confirmed content and preserves all
of `Sent.msgids`; one optimistic send may represent several wire messages after
`Fallback::SplitIntoLines`. Reply, reaction, and redaction targets select a specific server ID.

Known event fields come from typed papo events. Formatting spans become an owned safe AST. Generic
batch identity is not retained in milestone 1; known batch semantics arrive through typed events.
Unknown `Event::Other` records are retained only in a bounded server-buffer diagnostics window.

Deduplication uses `(NetworkId, msgid)` where possible. Without a msgid it uses a conservative
fingerprint; collisions retain both records. Ordering is server time, receipt time, then a local
monotonic tie-breaker. History pages are sorted before merge because papo does not promise
chronological delivery order.

## Read and memory projections

The effective read position is the current papo read marker when read sync is available;
otherwise it is `Buffer.local_last_read`. Subsystem 17 supplies the per-buffer `markRead` action
or local-only status. This model does not duplicate capability support with an `Unsupported`
marker variant. Unread and mention counts are engine projections over stored message metadata.

Memory keeps summaries, pending sends, and bounded timeline windows. Window sizes are configuration
provided by the performance harness, not hard-coded product defaults. Papo retains joined member,
user, presence, typing, read-marker, and capability state once per connection.

Storage later owns configured networks, ordered buffer identities, timelines, local read positions,
drafts, and paging cursors. It never stores plaintext credentials or client-origin-bound papo
handles.

## Boundaries

This subsystem owns local IDs, buffer continuity, explicit order, timeline merge/deduplication,
optimistic-send reconciliation, counts, and bounded windows. It does not own sockets, CAP/SASL,
pane layout, persistence engines, history scheduling, Activity ranking, or notification policy.

## Testing

- Pure reducer tests cover identity, ordering, deduplication, optimistic sends with zero/one/many
  `Sent.msgids`, read counts, and bounded eviction without `papo-testing`.
- Property tests generate event/history interleavings and assert referential integrity and stable
  ordering.
- Native transcript tests use `papo_testing::wire()` around a real papo client and a scripted
  in-memory pipe; these test builds necessarily enable papo `unstable`. Unpublished `papo` and
  `papo-testing` are pinned to the same git revision.
- Browser and live tests use subsystem 21's small local nixpkgs Ergo fixture; there is no packaged
  papo test-server dependency.
- Serialization fixtures protect durable and Engine/UI representations.

## Out of scope

Storage schema, history policy, Activity classification, search, WHOIS, file uploads, moderation,
and channel browsing are later designs.

## Later

- Tune warm/cold window sizes from measured harness results.
- Add richer known batch presentation only when a typed papo API and product use require it.

## Decisions

- Do not preserve arbitrary batch identity in milestone 1.
- Identify DMs by account first, then by a typed nick-change chain, and otherwise keep identities separate.
- Keep unknown `Event::Other` records in a bounded diagnostics window.
- Derive message-window sizes from the performance harness.
- Luiz, 2026-10-27: use pure domain tests plus native `papo_testing::wire()` transcripts, with the
  repository's local Ergo reserved for real-server browser and smoke coverage.
