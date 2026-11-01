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
    Direct { peer: DirectPeer },
}

pub struct DirectPeer {
    pub nick_key: String,
    pub pin: Option<String>,
}
```

Channel `BufferId`s survive proven channel renames. A DM thread instead keys by connection profile
and the peer's folded `Nick::key()`, matching the target used by Ergo CHATHISTORY. Two nicks on one
account are separate threads, and a rename starts a new thread. When a `NickChanged` event's
`peer_key()` matches the old thread's pin, the old transcript may say that the peer is now known by
the new nick, but it does not merge either thread's state.

Each DM thread stores an optional SSH-known-hosts-style identity pin. The serialized value is the
opaque result of `PeerKey::as_verified_str()`; only account keys are durable, while continuity keys
are connection-local and project as unverified after a new session. Stored values are parsed with
`str::parse::<PeerKey>()`; an `InvalidPeerKey` is treated as no pin. Pins are scoped to the
TLS-verified server host (a normalized URL host without its port) for `wss://` and `ircs://`
connections. Migrating pins when a connection profile changes host is deliberately out of scope.

For every incoming direct message, the engine obtains `UserSource::peer_key()`. Live and
CHATHISTORY messages with an account tag can therefore prove identity; `None` means unknown, never
logged out. Before presenting the thread as verified, and again before every send, the engine calls
`stored.check(&current)`. `Match` proceeds. `Upgrade(new)` replaces the pin silently, including a
continuity-to-account upgrade for one uninterrupted user. `Mismatch(DifferentAccount |
CannotVerify)` leaves the message in the existing transcript marked as unverified and makes the
thread read-only until the user decides.

The mismatch projection carries the current key and one of two reasons: “This isn't the same
{nick} — different account” or “Can't verify this is the same {nick}”. The UI presents it in an
inline banner at the top of the transcript, above the composer in both shells. “Trust new identity”
opens a fresh `Client::direct()` handle, stores its current account pin when one is available, and
clears the banner. “Not now” preserves the read-only thread and its short disabled-composer reason.
Incoming messages remain visible while the decision is pending.

Sends use `Client::direct_pinned(nick, &stored)`. A `papo::Error::PeerPinMismatch` carries the
reason and current key, sends nothing, and moves the thread to the same mismatch state. Papo's
direct handles remain connection-local protocol capabilities, not application identity. Current
channel members, user facts, DM presence, typing, and server read markers are queried from the
active papo snapshot when building UI projections. Server buffers may occupy desktop panes.

The first durable schema using this model performs a one-time migration from account-keyed DMs.
Drafts, local read markers, closed-DM retention, and chat-list snapshot rows move to nick-keyed
threads. If one account record names several nicks, only its most recently active nick is retained.
Migration never invents a pin; the next provable contact establishes one.

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

Closing a direct-message buffer hides it from the projected buffer order; it does not destroy the
buffer while optimistic sends or failed rows still refer to it. A later `Sent` confirmation updates
the hidden row without reopening the conversation. A failure updates the hidden row and emits the
typed target metadata needed for a transient failure notice. Only a new live message authored by
the other person, or an explicit open action, returns the DM to the projected order; this client's
own confirmations and messages from another signed-in device do not resurrect a closed DM.

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
Message-row highlighting is a separate projection of the user's highlight rules; the initial rule
matches the current nick as an IRC-casemapped word, and later keyword rules extend the same matcher.

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
- Key DM threads by connection profile and folded nick, with an independently stored account pin
  guarding continuity; never merge threads by account or rename.
- Keep unknown `Event::Other` records in a bounded diagnostics window.
- Derive message-window sizes from the performance harness.
- Luiz, 2026-10-27: use pure domain tests plus native `papo_testing::wire()` transcripts, with the
  repository's local Ergo reserved for real-server browser and smoke coverage.
