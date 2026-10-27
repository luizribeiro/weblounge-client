# 01 — Engine state model

Status: proposed for milestone 1 review.

## Problem

The engine is the sole source of IRC truth for every shell. It must turn papo's typed event
stream and immutable state snapshots into stable application records that survive reconnects,
history paging, process restarts, and multiple networks. The UI receives projections; it never
parses IRC, compares IRC names, derives unread state, or owns protocol state.

The model must distinguish three identities which strings alone conflate:

- the locally configured network, which survives every connection;
- the logical buffer within that network, which survives nick and channel renames;
- the occurrence of an event, which may arrive live, through history, or from local optimistic
  sending.

## Papo composition

`weblounge-engine` depends on the public `papo` crate, not `papo-core` or `papo-proto`. One
`papo::Client` and `papo::Events` pair backs each active IRC connection. The reducer consumes:

- `papo::Event::{Message, Notice, ServerNotice, History, Reacted, Redacted, TagMsg}` for timeline
  records;
- membership and identity events (`Joined`, `Parted`, `Kicked`, `Quit`, `NickChanged`,
  `ModeChanged`, `TopicChanged`, presence and metadata changes);
- connection events (`Connecting`, `Connected`, `Disconnected`, `CapsChanged`,
  `FeaturesChanged`, `CasemappingChanged`, `Lagged`, `Warning`);
- `Client::state()` snapshots after connection boundaries, `ChannelSynced`,
  `MembersRefreshed`, or `Lagged`;
- `State::{channels, channel, user, caps, features, supports, read_marker, typing, isupport}`;
- papo-owned identifiers and semantics: `Conversation`, `ChannelName`, `Nick`, `MessageId`,
  `Account`, `Away`, `Member`, `Feature`, `Capabilities`, `Tags`, and `Span`.

The engine converts borrowed or client-origin-bound papo values into its own serializable IDs and
records at the boundary. It never recreates CAP, SASL, casemapping, formatting, membership, batch,
or IRC parsing logic.

## Core types

Illustrative Rust signatures; all persisted and protocol-facing types derive `Serialize`,
`Deserialize`, and generated TypeScript bindings where appropriate.

```rust
#[repr(transparent)]
pub struct NetworkId(Uuid);

#[repr(transparent)]
pub struct BufferId(Uuid);

#[repr(transparent)]
pub struct EventId(Uuid);

#[repr(transparent)]
pub struct LocalSendId(Uuid);

pub struct EngineState {
    pub revision: Revision,
    pub networks: IndexMap<NetworkId, Network>,
    pub buffers: IndexMap<BufferId, Buffer>,
    pub windows: HashMap<BufferId, MessageWindow>,
}

pub struct Network {
    pub id: NetworkId,
    pub order: SortKey,
    pub label: String,
    pub connection: ConnectionState,
    pub identity: NetworkIdentity,
    pub capabilities: CapabilitySnapshot,
    pub server_buffer: BufferId,
    pub buffer_order: Vec<BufferId>,
    pub icon: NetworkIcon,
}

pub enum ConnectionState {
    Offline { reason: OfflineReason },
    Connecting { attempt: u32, phase: ConnectPhase },
    Online { since: Timestamp },
    Reconnecting { attempt: u32, retry_at: Timestamp, cached_since: Timestamp },
    Suspended { since: Timestamp },
}

pub struct NetworkIdentity {
    pub nick: String,
    pub account: AccountState,
    pub away: Presence,
}

pub enum AccountState {
    LoggedIn { name: String },
    LoggedOut,
}
```

`NetworkId` is generated locally when a network is configured. A soju upstream receives its own
`NetworkId`; the bouncer's opaque `papo::NetworkId` is stored as connection metadata, never used as
the application's primary key. This permits two bouncers to expose the same upstream identifier.

```rust
pub struct Buffer {
    pub id: BufferId,
    pub network_id: NetworkId,
    pub order: SortKey,
    pub kind: BufferKind,
    pub title: String,
    pub topic: Option<Topic>,
    pub activity: BufferActivity,
    pub read: ReadState,
}

pub enum BufferKind {
    Server,
    Channel(ChannelBuffer),
    Direct(DirectBuffer),
}

pub struct ChannelBuffer {
    pub canonical_name: String,
    pub joined: JoinState,
    pub members: MemberIndex,
}

pub enum JoinState {
    NotJoined,
    Joining,
    Joined { synced: bool },
}

pub struct DirectBuffer {
    pub peer: PeerIdentity,
}

pub struct PeerIdentity {
    pub current_nick: String,
    pub account: Option<String>,
    pub presence: Presence,
}

pub enum Presence {
    Online,
    Away { message: Option<String> },
    Offline,
    Unknown,
}
```

`BufferId` is stable across display-name changes. Channel rename updates the existing record. A DM
with a stable logged-in account follows nick changes; without an account, the engine follows only
papo's proven `NickChanged` identity and never guesses that a later holder of the nick is the same
person. Server buffers always exist and may occupy desktop panes.

IRC name lookup is performed with typed papo values or the active `State::name_rules()`; the engine
does not lowercase names. The storage schema records display strings plus stable local IDs, not a
home-grown canonicalization.

## Timeline records and ordering

```rust
pub struct MessageWindow {
    pub buffer_id: BufferId,
    pub entries: Vec<TimelineEntry>,
    pub older: PageBoundary,
    pub newer: PageBoundary,
}

pub struct TimelineEntry {
    pub id: EventId,
    pub order: EventOrder,
    pub provenance: Provenance,
    pub body: TimelineBody,
}

pub struct EventOrder {
    pub server_time: Option<Timestamp>,
    pub received_at: Timestamp,
    pub tie_breaker: u64,
}

pub enum Provenance {
    Live,
    History { reason: HistoryReason },
    Local { send_id: LocalSendId },
}

pub enum TimelineBody {
    Chat(ChatMessage),
    Notice(NoticeMessage),
    Membership(MembershipEvent),
    Topic(TopicEvent),
    ServerLog(ServerLogEntry),
    Redaction(RedactionEvent),
}

pub struct ChatMessage {
    pub delivery: DeliveryState,
    pub author: Author,
    pub authorship: Authorship,
    pub kind: ChatKind,
    pub text: FormattedText,
    pub msgid: Option<String>,
    pub reply_to: Option<String>,
    pub reactions: BTreeMap<ReactionKey, ReactionSummary>,
    pub tags: Vec<Tag>,
}

pub enum DeliveryState {
    Received,
    Pending { send_id: LocalSendId },
    Failed { send_id: LocalSendId, error: SendFailure },
}

pub enum ChatKind { Message, Action }
```

`Message::spans()` and equivalent papo event span iterators become an owned, safe formatting AST;
raw IRC control codes never reach the UI. Known structured fields are copied from typed papo event
fields. Unknown tags remain ordered data for diagnostics and future extensions.

Deduplication uses `(NetworkId, msgid)` when a `msgid` exists. Otherwise it uses a conservative
fingerprint of typed event kind, conversation, actor, server time, and exact wire-derived content;
collisions retain both records rather than deleting user content. A live echo confirms the
matching optimistic entry via `papo::Sent` and replaces its local order key without producing a
second visible message.

Ordering is ascending `server_time`, then `received_at`, then a monotonic engine tie-breaker.
History pages are explicitly sorted before merge because `papo::HistoryPage` preserves server
delivery order and does not promise chronological order. Missing or invalid server time never
sorts ahead of already displayed history solely because it arrived late.

Reactions and redactions reference `(NetworkId, msgid)`. Orphan mutations are retained in a
bounded side table and applied if their target arrives during paging. They expire with the same
storage policy as the surrounding buffer.

## Membership and presence

```rust
pub struct MemberIndex {
    pub generation: u64,
    pub by_nick: HashMap<String, MemberRecord>,
}

pub struct MemberRecord {
    pub nick: String,
    pub account: Option<String>,
    pub prefixes: Vec<MemberPrefix>,
    pub presence: Presence,
    pub bot: bool,
    pub realname: Option<String>,
}
```

Membership is rebuilt from `papo::Channel::members()` after `ChannelSynced`,
`MembersRefreshed`, reconnection, or lag. Between snapshots, typed events update it incrementally.
The engine preserves papo's prefix rank order. DM presence is a projection of shared-channel state,
`MONITOR`, away/account events, and papo's `User`; contradictory or absent evidence becomes
`Unknown`, not an invented offline state.

## Read state and activity counters

```rust
pub struct ReadState {
    pub marker: MarkerState,
    pub unread: u32,
    pub mentions: u32,
}

pub enum MarkerState {
    Unsupported { local_last_read: Option<EventCursor> },
    Unknown,
    Unset,
    Synced { through: Timestamp },
}
```

Server read markers come only from `papo::ReadMarker`, `ReadMarkerChanged`, and explicit
`fetch_read_marker` results. Local fallback markers are clearly separate and never presented as
cross-device state. Counts are engine-derived projections over stored message metadata, not UI
counters.

## Memory versus storage

Memory contains all network and buffer summaries, joined membership, typing state, pending sends,
capability snapshots, and a bounded window around each visible or recently used buffer. Default
window targets are 500 timeline entries per warm buffer and 100 for cold buffers; pressure-based
eviction may reduce cold windows but cannot evict pending sends or visible ranges.

Storage contains configured networks (without plaintext credentials), buffer identity/order,
timeline records, read markers, drafts, last-open navigation state, and paging cursors. Secrets
live in the platform credential service defined by the later storage design. Typing state,
connection attempts, transient members for parted channels, and raw `papo::Client`-origin-bound
handles are never persisted.

The storage subsystem owns transactions and eviction. This subsystem supplies typed records and
reduction rules; it does not choose SQLite, IndexedDB, migrations, or cache quotas.

## Boundaries

This subsystem owns:

- stable application identity, reduction of papo events, ordering, deduplication, and bounded
  in-memory state;
- network/buffer summaries, membership, presence projections, timeline records, and counts;
- the invariant that a `BufferId` belongs to exactly one existing `NetworkId`.

It must not:

- open sockets, negotiate CAP/SASL, parse lines, or send raw protocol commands;
- own pane layout, selected tabs, overlays, themes, or other shell state;
- implement persistence engines, history fetching policy, Activity ranking, or notifications;
- expose `papo-core`, `papo-proto`, DOM, Tauri, or browser types.

## Invariants

- Every network has exactly one server buffer.
- Every buffer references an existing network and appears at most once in its `buffer_order`.
- Every timeline entry belongs to exactly one buffer; cross-network message references are
  unrepresentable.
- A pending or failed delivery has a `LocalSendId`; a received delivery does not.
- A channel member index exists only on a channel buffer.
- An online connection has a nonempty capability snapshot from that connection generation.
- A reducer revision increases exactly once per committed atomic change set.

## Testing

- Pure reducer tests cover every `papo::Event` variant used, reconnection snapshots, nick/channel
  rename identity, optimistic echo confirmation, orphan reactions, redaction, and read counts.
- Property tests generate event/history interleavings and assert stable ordering, idempotent replay,
  referential integrity, and bounded windows.
- `papo-testing::wire` fixtures exercise exact typed events without a fake application protocol.
- Live tests reuse papo's Ergo, persistent Ergo, soju, InspIRCd, Solanum, and UnrealIRCd profiles;
  expected server differences come from papo's conformance data.
- Serialization round trips and golden fixtures protect storage and Engine/UI representations.
- Memory benchmarks apply a 2,000-event burst and a 20-channel soak, asserting bounded retained
  records.

## Out of scope

Storage schema/migrations, history scheduling, Activity classification, formatting component
selection, WHOIS profiles, search, file uploads, moderation, and channel browsing are later design
documents.

## Questions for Luiz / papo gaps

1. Papo exposes typed netjoin/netsplit markers and completed `HistoryPage`s, while generic batch
   lifecycle/type information is not a stable high-level API. Does the client need to preserve
   arbitrary batch identity beyond known typed semantics? If yes, should papo expose it?
2. Confirm that account identity should be the preferred stable DM identity, with conservative
   separation when neither account nor a typed nick-change chain proves continuity.
3. Should unknown `Event::Other` lines be persisted indefinitely in the server buffer, or kept in
   a bounded diagnostics window?
4. The desired maximum warm/cold message windows (500/100 proposed) should be validated by the
   performance harness before becoming product defaults.
