use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    BufferId, BufferKind, BufferProjection, BufferSyncState, ChannelStatus, DirectIdentityState,
    EngineMessageKey, EngineToUi, LocalSendId, MembershipKind, MessageAuthorship, MessageDelivery,
    MessageId, MessageKind, MessageProjection, NetworkConnectionState, NetworkId,
    NetworkProjection, NoticeAction, NoticeKind, NoticeTone,
    chat_list_snapshot::{
        ChatListSnapshot, SnapshotConversation, SnapshotCursor, SnapshotRow, truncate_preview,
    },
    name_key::NameKey,
    pushed_messages::{PushedMessage, PushedMessageKind},
    reactions::{ReactionAction, ReactionActor, ReactionIndex, ReactionUpdate, ReactionVersion},
    read_model::{
        MessageStub, ReadFacts, ServerTimeMs, has_unread_gap, mention_count, unread_count,
    },
    timeline::{
        Actor, ChatRecord, FoldEvent, FoldedBody, ItemBody, LineEvent, LocalCalendar, OrderKey,
        Person, RecordBody, RunClause, RunClauses, Subject, SystemLine, SystemProjection,
        TimelineItem, TimelineRecord, diff, fold,
    },
};

#[cfg(test)]
use crate::timeline::FixedOffsetCalendar;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TimelineOrigin {
    Live,
    History,
    Push,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FallbackKey {
    destination: IncomingDestination,
    server_time_ms: Option<i64>,
    actor: String,
    text: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum IncomingDestination {
    Conversation(NameKey),
    Server,
}

impl IncomingDestination {
    fn conversation(&self) -> Option<&NameKey> {
        match self {
            Self::Conversation(conversation) => Some(conversation),
            Self::Server => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ChatInput<'a> {
    Message(&'a papo::Message),
    Notice(&'a papo::event::Notice),
}

impl<'a> From<&'a papo::Message> for ChatInput<'a> {
    fn from(message: &'a papo::Message) -> Self {
        Self::Message(message)
    }
}

impl<'a> From<&'a papo::event::Notice> for ChatInput<'a> {
    fn from(notice: &'a papo::event::Notice) -> Self {
        Self::Notice(notice)
    }
}

impl ChatInput<'_> {
    fn conversation(&self) -> &papo::Conversation {
        match self {
            Self::Message(message) => message.conversation(),
            Self::Notice(notice) => &notice.conversation,
        }
    }

    fn actor(&self) -> &papo::UserSource {
        match self {
            Self::Message(message) => &message.actor,
            Self::Notice(notice) => &notice.actor,
        }
    }

    pub(crate) const fn authorship(&self) -> papo::Authorship {
        match self {
            Self::Message(message) => message.authorship,
            Self::Notice(notice) => notice.authorship,
        }
    }

    fn text(&self) -> &str {
        match self {
            Self::Message(message) => &message.text,
            Self::Notice(notice) => &notice.text,
        }
    }

    fn kind(&self) -> MessageKind {
        match self {
            Self::Message(message) => match message.kind {
                papo::MessageKind::Action => MessageKind::Action,
                _ => MessageKind::Text,
            },
            Self::Notice(_) => MessageKind::IrcNotice,
        }
    }

    fn msgid(&self) -> Option<String> {
        match self {
            Self::Message(message) => message.msgid().map(ToString::to_string),
            Self::Notice(notice) => notice.msgid.as_ref().map(ToString::to_string),
        }
    }

    const fn server_time(&self) -> Option<SystemTime> {
        match self {
            Self::Message(message) => message.server_time,
            Self::Notice(notice) => notice.server_time,
        }
    }

    const fn received_at(&self) -> SystemTime {
        match self {
            Self::Message(message) => message.received_at,
            Self::Notice(notice) => notice.received_at,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct DirectKey(String);

impl DirectKey {
    fn from_nick(nick: &papo::Nick) -> Self {
        Self(nick.key().to_owned())
    }

    fn draft_name(&self) -> String {
        format!("nick={}", self.0)
    }
}

#[derive(Clone, Debug)]
struct DirectMismatch {
    reason: papo::PeerKeyMismatch,
    current: papo::PeerKey,
    deferred: bool,
}

#[derive(Clone, Debug)]
struct ChatMetadata {
    counts_as_mention: bool,
    send_text: Option<String>,
    dedup: DedupReferences,
    provisional_identity: Option<ProvisionalIdentity>,
}

#[derive(Clone, Debug)]
struct ProvisionalIdentity {
    author_key: String,
    account_key: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct DedupReferences {
    msgids: Vec<String>,
    fallback: Option<FallbackKey>,
}

#[derive(Clone, Copy, Debug)]
struct MsgidReference {
    count: usize,
    location: Option<(BufferId, MessageId)>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum SystemDedupReference {
    Msgid(BufferId, String),
    Fallback {
        buffer_id: BufferId,
        server_time_ms: i64,
        kind: &'static str,
        nick: String,
        subject: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StateError {
    MissingBuffer(BufferId),
}

#[derive(Clone, Debug)]
struct BufferState {
    projection: BufferProjection,
    restored_from_snapshot: bool,
    provisional_activity_ms: Option<i64>,
    provisional_preview: Option<String>,
    key: Option<NameKey>,
    direct_key: Option<DirectKey>,
    timeline: Vec<TimelineRecord>,
    chat_metadata: HashMap<MessageId, ChatMetadata>,
    system_server_times: HashMap<MessageId, Option<i64>>,
    system_dedup: HashMap<MessageId, SystemDedupReference>,
    emitted_timeline: Vec<TimelineItem>,
    direct: Option<DirectAvailability>,
    direct_pin: Option<papo::PeerKey>,
    direct_mismatch: Option<DirectMismatch>,
    read_facts: ReadFacts,
    history: HistoryState,
    newest: Option<HistoryCursor>,
    pushed_history_pending: bool,
    pushed_history_retry_available: bool,
}

#[derive(Debug)]
struct PendingTargetSync {
    through: SystemTime,
    unresolved: HashSet<NameKey>,
    failed: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum DirectAvailability {
    Pending,
    Resolving,
    Guarded(papo::DirectRef),
    MonitorFull,
    Failed,
}

#[derive(Clone, Debug)]
enum HistoryState {
    Unrequested,
    QueuedLatest,
    LoadingLatest,
    Ready {
        oldest: Option<papo::HistoryReference>,
        at_start: bool,
    },
    LoadingOlder {
        oldest: papo::HistoryReference,
    },
    Refreshing {
        oldest: Option<papo::HistoryReference>,
        at_start: bool,
    },
    RefreshCapped,
}

impl HistoryState {
    const fn sync_state(&self) -> BufferSyncState {
        match self {
            Self::LoadingLatest | Self::Refreshing { .. } => BufferSyncState::Syncing,
            Self::Ready { .. } | Self::LoadingOlder { .. } | Self::RefreshCapped => {
                BufferSyncState::Synced
            }
            Self::Unrequested | Self::QueuedLatest => BufferSyncState::Pending,
        }
    }
}

fn set_history_state(buffer: &mut BufferState, history: HistoryState) {
    buffer.history = history;
    buffer.projection.sync_state = history_sync_state(buffer);
}

fn history_sync_state(buffer: &BufferState) -> BufferSyncState {
    if buffer.pushed_history_pending {
        match buffer.history {
            HistoryState::LoadingLatest | HistoryState::Refreshing { .. } => {
                BufferSyncState::Syncing
            }
            _ => BufferSyncState::Pending,
        }
    } else {
        buffer.history.sync_state()
    }
}

#[derive(Clone, Debug)]
pub(crate) enum HistoryFetch {
    Latest(HistoryTarget),
    Before {
        target: HistoryTarget,
        oldest: papo::HistoryReference,
    },
    After {
        target: HistoryTarget,
        newest: HistoryCursor,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryCursor {
    msgid: Option<papo::MessageId>,
    server_time: SystemTime,
}

impl HistoryCursor {
    pub(crate) fn new(msgid: Option<String>, server_time_ms: i64) -> Self {
        Self {
            msgid: msgid.map(papo::MessageId::from),
            server_time: system_time_from_millis(server_time_ms),
        }
    }

    pub(crate) fn reference(&self) -> papo::HistoryReference {
        self.msgid.as_ref().map_or_else(
            || papo::HistoryReference::from(self.server_time),
            papo::HistoryReference::from,
        )
    }

    pub(crate) const fn server_time(&self) -> SystemTime {
        self.server_time
    }

    fn snapshot(&self) -> SnapshotCursor {
        SnapshotCursor {
            msgid: self.msgid.as_ref().map(ToString::to_string),
            server_time_ms: time_millis(self.server_time),
        }
    }
}

pub(crate) struct HistoryCompletion {
    pub(crate) buffer_id: BufferId,
    pub(crate) at_start: Option<bool>,
    pub(crate) gap: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HistoryLoad {
    Latest,
    Older,
    Refresh,
}

#[derive(Clone, Debug)]
pub(crate) enum HistoryTarget {
    Channel(papo::ChannelName),
    Direct(papo::Nick),
}

impl HistoryTarget {
    fn from_key(key: NameKey) -> Self {
        match key {
            NameKey::Channel(channel) => Self::Channel(channel),
            NameKey::Direct(nick) => Self::Direct(nick),
        }
    }

    fn name_key(&self) -> NameKey {
        match self {
            Self::Channel(channel) => NameKey::Channel(channel.clone()),
            Self::Direct(nick) => NameKey::Direct(nick.clone()),
        }
    }

    pub(crate) fn conversation(&self) -> papo::Conversation {
        match self {
            Self::Channel(channel) => papo::Conversation::Channel(channel.clone()),
            Self::Direct(nick) => papo::Conversation::Private(nick.clone()),
        }
    }
}

/// Information needed to perform an outgoing send without exposing papo targets to the UI.
#[derive(Clone, Debug)]
pub(crate) enum SendTarget {
    Channel(papo::ChannelName),
    Direct {
        nick: papo::Nick,
        recipient: Option<papo::DirectRef>,
        pin: Option<papo::PeerKey>,
    },
}

impl SendTarget {
    fn from_buffer(
        key: NameKey,
        direct: Option<&DirectAvailability>,
        pin: Option<&papo::PeerKey>,
        mismatched: bool,
    ) -> Option<Self> {
        match key {
            NameKey::Channel(channel) => Some(Self::Channel(channel)),
            NameKey::Direct(nick) if !mismatched => match direct? {
                DirectAvailability::Guarded(recipient) => Some(Self::Direct {
                    nick,
                    recipient: Some(recipient.clone()),
                    pin: pin.cloned(),
                }),
                DirectAvailability::MonitorFull => Some(Self::Direct {
                    nick,
                    recipient: None,
                    pin: pin.cloned(),
                }),
                DirectAvailability::Pending
                | DirectAvailability::Resolving
                | DirectAvailability::Failed => None,
            },
            NameKey::Direct(_) => None,
        }
    }

    fn title(&self) -> String {
        match self {
            Self::Channel(channel) => channel.to_string(),
            Self::Direct { nick, .. } => nick.to_string(),
        }
    }

    #[cfg(test)]
    fn name_key(&self) -> NameKey {
        match self {
            Self::Channel(channel) => NameKey::Channel(channel.clone()),
            Self::Direct { nick, .. } => NameKey::Direct(nick.clone()),
        }
    }
}

/// Pending optimistic row and its send destination.
#[derive(Clone, Debug)]
pub(crate) struct PendingSend {
    pub(crate) buffer_id: BufferId,
    pub(crate) local_send_id: LocalSendId,
    pub(crate) target: SendTarget,
    pub(crate) text: String,
    pub(crate) kind: MessageKind,
}

pub(crate) enum PendingTargetState {
    Waiting,
    Ready,
    Gone,
}

/// A validated read advance ready for local or server-backed application.
#[derive(Clone, Debug)]
pub(crate) struct ReadAdvance {
    pub(crate) buffer_id: BufferId,
    pub(crate) time: SystemTime,
}

/// Mutable application identity and timeline state for one papo client.
pub(crate) struct NetworkModel {
    calendar: Arc<dyn LocalCalendar>,
    network: NetworkProjection,
    server_buffer_id: BufferId,
    casemapping: papo::Casemapping,
    next_buffer_id: u64,
    next_message_id: u64,
    next_local_send_id: u64,
    next_sequence: u64,
    window_limit: usize,
    buffer_order: Vec<BufferId>,
    buffers: HashMap<BufferId, BufferState>,
    names: HashMap<NameKey, BufferId>,
    directs: HashMap<DirectKey, BufferId>,
    msgids: HashMap<String, MsgidReference>,
    system_dedup: HashSet<SystemDedupReference>,
    reactions: ReactionIndex,
    fallbacks: HashMap<FallbackKey, (TimelineOrigin, usize)>,
    dirty_timelines: HashSet<BufferId>,
    reconcilable_failed_sends: HashSet<LocalSendId>,
    recent_commands: VecDeque<String>,
    cursor: Option<SystemTime>,
    seed_cursor: Option<SystemTime>,
    pending_live_cursor: Option<SystemTime>,
    cursor_settled: bool,
    targets_synced: bool,
    pending_target_sync: Option<PendingTargetSync>,
    #[cfg(test)]
    name_rebuilds: usize,
}

impl NetworkModel {
    #[cfg(test)]
    pub(crate) fn new(id: NetworkId, label: String, nickname: String, window_limit: usize) -> Self {
        Self::with_calendar(
            id,
            label,
            nickname,
            window_limit,
            Arc::new(FixedOffsetCalendar::default()),
        )
    }

    pub(crate) fn with_calendar(
        id: NetworkId,
        label: String,
        nickname: String,
        window_limit: usize,
        calendar: Arc<dyn LocalCalendar>,
    ) -> Self {
        let server_id = BufferId(1);
        let casemapping = papo::Casemapping::default();
        let server = BufferState {
            projection: BufferProjection {
                id: server_id,
                network_id: id,
                kind: BufferKind::Server,
                sync_state: BufferSyncState::Synced,
                channel_status: None,
                available: None,
                title: label.clone(),
                nick_color_index: None,
                direct_identity: None,
                draft_key: draft_key(&label, &label, casemapping),
                topic: None,
                member_count: None,
                unread: 0,
                mentions: 0,
                read_at_ms: None,
                last_message: None,
                last_activity_ms: None,
                preview: None,
            },
            restored_from_snapshot: false,
            provisional_activity_ms: None,
            provisional_preview: None,
            key: None,
            direct_key: None,
            timeline: Vec::new(),
            chat_metadata: HashMap::new(),
            system_server_times: HashMap::new(),
            system_dedup: HashMap::new(),
            emitted_timeline: Vec::new(),
            direct: None,
            direct_pin: None,
            direct_mismatch: None,
            read_facts: ReadFacts::default(),
            history: HistoryState::Ready {
                oldest: None,
                at_start: true,
            },
            newest: None,
            pushed_history_pending: false,
            pushed_history_retry_available: false,
        };
        Self {
            calendar,
            network: NetworkProjection {
                id,
                label,
                nickname,
                state: NetworkConnectionState::Connecting,
            },
            server_buffer_id: server_id,
            casemapping,
            next_buffer_id: 2,
            next_message_id: 1,
            next_local_send_id: 1,
            next_sequence: 1,
            window_limit,
            buffer_order: vec![server_id],
            buffers: HashMap::from([(server_id, server)]),
            names: HashMap::new(),
            directs: HashMap::new(),
            msgids: HashMap::new(),
            system_dedup: HashSet::new(),
            reactions: ReactionIndex::with_preload_limit(window_limit),
            fallbacks: HashMap::new(),
            dirty_timelines: HashSet::new(),
            reconcilable_failed_sends: HashSet::new(),
            recent_commands: VecDeque::new(),
            cursor: None,
            seed_cursor: None,
            pending_live_cursor: None,
            cursor_settled: false,
            targets_synced: false,
            pending_target_sync: None,
            #[cfg(test)]
            name_rebuilds: 0,
        }
    }

    pub(crate) const fn id(&self) -> NetworkId {
        self.network.id
    }

    const fn server_buffer_id(&self) -> BufferId {
        self.server_buffer_id
    }

    pub(crate) fn is_online(&self) -> bool {
        self.network.state == NetworkConnectionState::Online
    }

    pub(crate) const fn connection(&self) -> &NetworkConnectionState {
        &self.network.state
    }

    pub(crate) fn remember_command(&mut self, name: String) {
        self.recent_commands.retain(|recent| recent != &name);
        self.recent_commands.push_front(name);
        self.recent_commands.truncate(20);
    }

    pub(crate) fn command_recency(&self, name: &str) -> Option<usize> {
        self.recent_commands
            .iter()
            .position(|recent| recent == name)
    }

    pub(crate) fn network_event(&self) -> EngineToUi {
        EngineToUi::NetworkStateChanged {
            network: self.network.clone(),
        }
    }

    pub(crate) fn set_nickname(&mut self, nickname: String) -> EngineToUi {
        self.network.nickname = nickname;
        self.network_event()
    }

    pub(crate) fn buffers_event(&self) -> EngineToUi {
        EngineToUi::BuffersChanged {
            network_id: self.network.id,
            buffers: self
                .buffer_order
                .iter()
                .filter_map(|id| self.buffers.get(id))
                .map(|buffer| buffer.projection.clone())
                .collect(),
        }
    }

    pub(crate) fn restore_chat_list(&mut self, snapshot: ChatListSnapshot) {
        let cursor = snapshot.cursor_ms.map(system_time_from_millis);
        for row in snapshot.rows {
            let key = match row.conversation {
                SnapshotConversation::Channel { key } => {
                    NameKey::Channel(self.casemapping.channel(key))
                }
                SnapshotConversation::Direct { key } => NameKey::Direct(self.casemapping.nick(key)),
            };
            let kind = match key {
                NameKey::Channel(_) => BufferKind::Channel,
                NameKey::Direct(_) => BufferKind::Direct,
            };
            let projection = self.add_buffer(key, kind, None, None, None);
            if let Some(buffer) = self.buffers.get_mut(&projection.id) {
                buffer.restored_from_snapshot = true;
                buffer.projection.title = row.title;
                buffer.provisional_preview = row.preview;
                buffer.provisional_activity_ms = row.last_activity_ms;
                buffer.newest = row
                    .newest
                    .map(|cursor| HistoryCursor::new(cursor.msgid, cursor.server_time_ms))
                    .or_else(|| {
                        row.last_activity_ms
                            .map(|time| HistoryCursor::new(None, time))
                    });
                buffer.read_facts.merge_snapshot_marks(
                    row.raw_read_at_ms.map(ServerTimeMs::new),
                    row.read_at_ms.map(ServerTimeMs::new),
                );
                if let Some(pending) = row.pending_read_at_ms {
                    buffer.read_facts.merge_pending(ServerTimeMs::new(pending));
                }
                for stub in row.stubs {
                    self.next_message_id = self
                        .next_message_id
                        .max(next_message_id_after_stub(&stub.msgid));
                    buffer.read_facts.merge_stub(stub);
                }
                if let Some(gap_until) = row.gap_until {
                    buffer.read_facts.merge_gap_until(gap_until);
                }
                if buffer.projection.kind == BufferKind::Channel {
                    buffer.projection.channel_status = None;
                }
                buffer.direct_pin = row.peer_pin.and_then(|pin| pin.parse().ok());
                buffer.projection.direct_identity = direct_identity(buffer);
                derive_read_projection(buffer);
            }
        }
        self.cursor = cursor;
        self.sort_buffer_order();
    }

    pub(crate) const fn cursor(&self) -> Option<SystemTime> {
        self.cursor
    }

    fn seed_mark_ms(&self) -> Option<i64> {
        self.cursor
            .max(self.seed_cursor)
            .map(time_millis)
            .map(|cursor| cursor.saturating_sub(1))
    }

    pub(crate) fn begin_target_sync(&mut self, now: SystemTime) {
        self.targets_synced = false;
        self.pending_target_sync = None;
        self.seed_cursor = Some(self.cursor.unwrap_or(now));
        self.pending_live_cursor = None;
        self.cursor_settled = false;
    }

    pub(crate) fn finish_target_sync(&mut self, until: Option<SystemTime>) {
        self.targets_synced = true;
        let Some(until) = until else {
            self.pending_live_cursor = None;
            return;
        };
        let unresolved = self
            .buffers
            .values()
            .filter(|buffer| {
                matches!(
                    buffer.history,
                    HistoryState::LoadingLatest | HistoryState::Refreshing { .. }
                )
            })
            .filter_map(|buffer| buffer.key.clone())
            .collect::<HashSet<_>>();
        if unresolved.is_empty() {
            self.settle_cursor(until);
        } else {
            self.pending_target_sync = Some(PendingTargetSync {
                through: until,
                unresolved,
                failed: false,
            });
        }
    }

    fn settle_target_history(&mut self, key: &NameKey, succeeded: bool) {
        let Some(sync) = self.pending_target_sync.as_mut() else {
            return;
        };
        if !sync.unresolved.remove(key) {
            return;
        }
        sync.failed |= !succeeded;
        if !sync.unresolved.is_empty() {
            return;
        }
        let sync = self
            .pending_target_sync
            .take()
            .expect("pending target sync");
        if sync.failed {
            self.pending_live_cursor = None;
        } else {
            self.settle_cursor(sync.through);
        }
    }

    fn settle_cursor(&mut self, through: SystemTime) {
        let through = self
            .pending_live_cursor
            .take()
            .map_or(through, |live| through.max(live));
        self.cursor = Some(self.cursor.map_or(through, |current| current.max(through)));
        self.seed_cursor = None;
        self.cursor_settled = true;
    }

    pub(crate) fn observe_live_server_time(&mut self, time: Option<SystemTime>) {
        let Some(time) = time.filter(|_| self.is_online()) else {
            return;
        };
        if self.cursor_settled {
            self.cursor = Some(self.cursor.map_or(time, |current| current.max(time)));
        } else {
            self.pending_live_cursor = Some(
                self.pending_live_cursor
                    .map_or(time, |current| current.max(time)),
            );
        }
    }

    pub(crate) fn mark_vanished_restored_rows(&mut self) -> Vec<EngineToUi> {
        let mut events = Vec::new();
        for buffer in self.buffers.values_mut() {
            if buffer.restored_from_snapshot
                && buffer.projection.kind == BufferKind::Channel
                && buffer.projection.channel_status != Some(ChannelStatus::Joined)
                && buffer.projection.available != Some(false)
            {
                buffer.projection.available = Some(false);
                events.push(EngineToUi::BufferUpdated {
                    buffer: buffer.projection.clone(),
                });
            }
        }
        events
    }

    pub(crate) fn awaits_live_target(&self, buffer_id: BufferId) -> bool {
        self.buffers.get(&buffer_id).is_some_and(|buffer| {
            (buffer.restored_from_snapshot
                && buffer.projection.kind == BufferKind::Channel
                && buffer.projection.channel_status != Some(ChannelStatus::Joined))
                || (buffer.restored_from_snapshot
                    && buffer.projection.kind == BufferKind::Direct
                    && buffer.direct.is_none())
                || matches!(
                    &buffer.direct,
                    Some(DirectAvailability::Pending | DirectAvailability::Resolving)
                )
        })
    }

    #[cfg(test)]
    pub(crate) fn chat_list_snapshot(&self, fingerprint: String) -> ChatListSnapshot {
        let rows = self
            .buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter(|buffer| {
                buffer.projection.kind != BufferKind::Server
                    && buffer.projection.available != Some(false)
                    && !buffer.restored_from_snapshot
            })
            .filter_map(snapshot_row)
            .collect();
        ChatListSnapshot::new(fingerprint, rows).with_cursor_ms(self.cursor.map(time_millis))
    }

    pub(crate) fn merge_chat_list_snapshot(
        &self,
        fingerprint: String,
        previous: &ChatListSnapshot,
    ) -> ChatListSnapshot {
        let rows = self
            .buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter(|buffer| {
                buffer.projection.kind != BufferKind::Server
                    && buffer.projection.available != Some(false)
            })
            .filter_map(|buffer| {
                if buffer.pushed_history_pending
                    || matches!(
                        buffer.history,
                        HistoryState::Ready { .. }
                            | HistoryState::LoadingOlder { .. }
                            | HistoryState::RefreshCapped
                    )
                {
                    return snapshot_row(buffer);
                }
                let conversation = snapshot_conversation(buffer)?;
                let mut row = previous
                    .rows
                    .iter()
                    .find(|row| row.conversation == conversation)
                    .cloned()?;
                copy_read_facts_to_snapshot(buffer, &mut row);
                if let Some(message) = latest_real_message(buffer).filter(|message| {
                    row.last_activity_ms
                        .is_none_or(|cached| message_time(message) > cached)
                }) {
                    row.last_activity_ms = Some(message_time(message));
                    row.preview = Some(snapshot_preview(&buffer.projection, message));
                }
                Some(row)
            })
            .collect();
        ChatListSnapshot::new(fingerprint, rows).with_cursor_ms(self.cursor.map(time_millis))
    }

    #[cfg(test)]
    fn ordered_buffers(&self) -> Vec<BufferProjection> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .map(|buffer| buffer.projection.clone())
            .collect()
    }

    pub(crate) fn set_connection(
        &mut self,
        state: NetworkConnectionState,
        nickname: Option<String>,
    ) -> EngineToUi {
        self.network.state = state;
        if let Some(nickname) = nickname {
            self.network.nickname = nickname;
        }
        self.network_event()
    }

    pub(crate) fn sync_channels(&mut self, state: &papo::State) -> Vec<EngineToUi> {
        let mut channels = state
            .channels()
            .map(|channel| (channel.name().clone(), channel.topic().map(str::to_owned)))
            .collect::<Vec<_>>();
        channels.sort_by_key(|(channel, _)| channel.to_string());
        let mut events = Vec::new();
        let mut changed = false;
        for (channel, topic) in channels {
            let key = NameKey::Channel(channel);
            if let Some(id) = self.names.get(&key).copied() {
                if let Some(buffer) = self.buffers.get_mut(&id) {
                    let title = key.title();
                    if buffer.projection.topic != topic
                        || buffer.projection.channel_status != Some(ChannelStatus::Joined)
                        || buffer.projection.available == Some(false)
                        || buffer.projection.title != title
                    {
                        buffer.projection.topic = topic;
                        buffer.projection.channel_status = Some(ChannelStatus::Joined);
                        buffer.projection.title = title;
                        buffer.projection.available = None;
                        changed = true;
                    }
                }
            } else {
                let buffer = self.add_buffer(key, BufferKind::Channel, None, None, topic);
                events.push(EngineToUi::BufferAdded { buffer });
            }
        }
        if !events.is_empty() || changed {
            events.push(self.buffers_event());
        }
        events
    }

    pub(crate) fn rebuild_name_keys(&mut self, state: &papo::State) {
        let Some(rules) = state.name_rules() else {
            return;
        };
        #[cfg(test)]
        {
            self.name_rebuilds += 1;
        }
        self.casemapping = state.casemapping();
        self.names.clear();
        self.directs.clear();
        let network_label = self.network.label.clone();
        for (id, buffer) in &mut self.buffers {
            let key = match buffer.projection.kind {
                BufferKind::Channel => Some(NameKey::Channel(
                    rules.channel(buffer.projection.title.clone()),
                )),
                BufferKind::Direct => {
                    Some(NameKey::Direct(rules.nick(buffer.projection.title.clone())))
                }
                BufferKind::Server => None,
            };
            buffer.key.clone_from(&key);
            if let Some(NameKey::Direct(nick)) = &key {
                let direct_key = DirectKey::from_nick(nick);
                buffer.projection.draft_key =
                    direct_draft_key(&network_label, &direct_key, self.casemapping);
                buffer.direct_key = Some(direct_key.clone());
                self.directs.insert(direct_key, *id);
            } else {
                buffer.projection.draft_key =
                    draft_key(&network_label, &buffer.projection.title, self.casemapping);
            }
            if let Some(key) = key {
                self.names.insert(key, *id);
            }
        }
        self.sort_buffer_order();
    }

    #[cfg(test)]
    pub(crate) const fn name_rebuild_count(&self) -> usize {
        self.name_rebuilds
    }

    pub(crate) fn rename_channel(
        &mut self,
        old: &papo::ChannelName,
        new: papo::ChannelName,
    ) -> Option<EngineToUi> {
        let id = self.names.remove(&NameKey::Channel(old.clone()))?;
        let buffer = self.buffers.get_mut(&id)?;
        let key = NameKey::Channel(new);
        buffer.projection.title = key.title();
        buffer.projection.draft_key = draft_key(
            &self.network.label,
            &buffer.projection.title,
            self.casemapping,
        );
        buffer.key = Some(key.clone());
        self.names.insert(key, id);
        self.sort_buffer_order();
        Some(self.buffers_event())
    }

    pub(crate) fn note_direct_rename(
        &mut self,
        old: &papo::Nick,
        new: &papo::Nick,
        current: Option<&papo::PeerKey>,
    ) -> Vec<EngineToUi> {
        let Some(id) = self.names.get(&NameKey::Direct(old.clone())).copied() else {
            return Vec::new();
        };
        let Some(buffer) = self.buffers.get(&id) else {
            return Vec::new();
        };
        let Some(stored) = buffer.direct_pin.as_ref() else {
            return Vec::new();
        };
        if !current.is_some_and(|current| {
            matches!(
                stored.check(current),
                papo::PeerKeyCheck::Match | papo::PeerKeyCheck::Upgrade(_)
            )
        }) {
            return Vec::new();
        }
        let _ = self.append_notice(id, format!("{old} is now {new}"), NoticeKind::Info);
        Vec::new()
    }

    #[cfg(test)]
    pub(crate) fn receive(
        &mut self,
        message: &papo::Message,
        history: bool,
        state: &papo::State,
        direct: Option<papo::DirectRef>,
    ) -> Vec<EngineToUi> {
        let (mut events, read_advances) =
            self.receive_chat_with_advance(message.into(), history, state, direct);
        for advance in read_advances {
            events.extend(self.advance_read(advance.buffer_id, advance.time, false));
        }
        events
    }

    pub(crate) fn receive_chat_with_advance(
        &mut self,
        input: ChatInput<'_>,
        history: bool,
        state: &papo::State,
        direct: Option<papo::DirectRef>,
    ) -> (Vec<EngineToUi>, Vec<ReadAdvance>) {
        let Some(conversation) = NameKey::from_conversation(input.conversation()) else {
            return (
                vec![EngineToUi::notice(
                    EngineMessageKey::UnsupportedConversation,
                )],
                Vec::new(),
            );
        };
        let destination = IncomingDestination::Conversation(conversation.clone());
        let origin = if history {
            TimelineOrigin::History
        } else {
            TimelineOrigin::Live
        };
        let direct_key = match &conversation {
            NameKey::Direct(nick) => Some(DirectKey::from_nick(nick)),
            NameKey::Channel(_) => None,
        };
        let actor = input.actor();
        let authorship = input.authorship();
        let incoming = Incoming {
            direct: direct.map(DirectAvailability::Guarded),
            direct_key,
            peer_key: (authorship != papo::Authorship::Own)
                .then(|| actor.peer_key().cloned())
                .flatten(),
            legacy_account_key: actor
                .account()
                .name()
                .map(|account| account.key().to_owned()),
            provisional_identity: None,
            destination,
            author: actor.nick().to_string(),
            text: input.text().to_owned(),
            kind: input.kind(),
            bot: actor.is_bot(),
            authorship: map_authorship(authorship),
            msgid: input.msgid(),
            server_time_ms: input.server_time().map(time_millis),
            received_at_ms: time_millis(input.received_at()),
            origin,
        };
        let received = self.receive_incoming_result(incoming, state);
        let own_advance = (authorship == papo::Authorship::Own)
            .then(|| {
                received
                    .message
                    .and_then(|(buffer_id, id)| self.prepare_mark_read(buffer_id, id))
            })
            .flatten();
        (
            received.events,
            own_advance.into_iter().chain(received.carry_read).collect(),
        )
    }

    pub(crate) fn receive_server_notice_with_advance(
        &mut self,
        notice: &papo::event::ServerNotice,
        history: bool,
        state: &papo::State,
    ) -> (Vec<EngineToUi>, Vec<ReadAdvance>) {
        let destination = match &notice.to {
            papo::event::Audience::Channel(channel) => {
                IncomingDestination::Conversation(NameKey::Channel(channel.clone()))
            }
            papo::event::Audience::Me | papo::event::Audience::Broadcast(_) => {
                IncomingDestination::Server
            }
            _ => return (Vec::new(), Vec::new()),
        };
        let incoming = Incoming {
            direct: None,
            direct_key: None,
            peer_key: None,
            legacy_account_key: None,
            provisional_identity: None,
            destination,
            author: notice.actor.to_string(),
            text: notice.text.clone(),
            kind: MessageKind::IrcNotice,
            bot: notice.actor.user().and_then(papo::UserSource::is_bot),
            authorship: map_authorship(notice.authorship),
            msgid: notice.msgid.as_ref().map(ToString::to_string),
            server_time_ms: notice.server_time.map(time_millis),
            received_at_ms: time_millis(notice.received_at),
            origin: if history {
                TimelineOrigin::History
            } else {
                TimelineOrigin::Live
            },
        };
        let received = self.receive_incoming_result(incoming, state);
        let own_advance = (notice.authorship == papo::Authorship::Own)
            .then(|| {
                received
                    .message
                    .and_then(|(buffer_id, id)| self.prepare_mark_read(buffer_id, id))
            })
            .flatten();
        (
            received.events,
            own_advance.into_iter().chain(received.carry_read).collect(),
        )
    }

    pub(crate) fn receive_reaction(&mut self, reaction: &papo::event::Reacted) -> Option<()> {
        let target = reaction.reacts_to.to_string();
        let loaded = self
            .msgids
            .get(&target)
            .and_then(|reference| reference.location);
        let buffer_id = loaded
            .map(|(buffer_id, _)| buffer_id)
            .or_else(|| self.buffer_id_for_conversation(reaction.conversation()))?;
        let actor = ReactionActor {
            key: reaction_actor_key(&reaction.actor),
            nick: reaction.actor.nick().to_string(),
            mine: reaction.authorship == papo::Authorship::Own,
        };
        let action = match reaction.action {
            papo::event::ReactionAction::Added => ReactionAction::Added,
            papo::event::ReactionAction::Removed => ReactionAction::Removed,
            _ => return None,
        };
        let version = ReactionVersion::new(
            time_millis(reaction.server_time.unwrap_or(reaction.received_at)),
            reaction
                .msgid()
                .map(ToString::to_string)
                .unwrap_or_default(),
        );
        if !self.reactions.apply(
            buffer_id,
            &target,
            &reaction.reaction,
            ReactionUpdate::new(actor, action, version),
            loaded.is_some(),
        ) {
            return None;
        }
        let reactions = nonempty_reactions(self.reactions.summaries(&target));
        let (_, message_id) = loaded?;
        let record = self
            .buffers
            .get_mut(&buffer_id)?
            .timeline
            .iter_mut()
            .find(|record| record.id == message_id)?;
        let message = chat_projection_mut(record)?;
        message.reactions.clone_from(&reactions);
        self.dirty_timelines.insert(buffer_id);
        Some(())
    }

    pub(crate) fn restore_pushed_messages(
        &mut self,
        mut messages: Vec<PushedMessage>,
        state: &papo::State,
    ) -> Vec<EngineToUi> {
        messages.sort_by_key(|message| papo_proto::time::parse(&message.time).map(time_millis));
        let mut events = Vec::new();
        for message in messages {
            if message.network_label != self.network.label {
                continue;
            }
            let Some(server_time_ms) = papo_proto::time::parse(&message.time).map(time_millis)
            else {
                continue;
            };
            let direct = self.casemapping.nick(message.target.clone())
                == self.casemapping.nick(message.nickname);
            let (conversation, direct_key, availability) = if direct {
                let nick = state.name_rules().map_or_else(
                    || self.casemapping.nick(message.sender.clone()),
                    |rules| rules.nick(message.sender.clone()),
                );
                (
                    NameKey::Direct(nick.clone()),
                    Some(DirectKey::from_nick(&nick)),
                    Some(DirectAvailability::Pending),
                )
            } else {
                (
                    NameKey::Channel(state.name_rules().map_or_else(
                        || self.casemapping.channel(message.target.clone()),
                        |rules| rules.channel(message.target.clone()),
                    )),
                    None,
                    None,
                )
            };
            let conversation_key = conversation.clone();
            let received = self.receive_incoming_result(
                Incoming {
                    destination: IncomingDestination::Conversation(conversation),
                    direct: availability,
                    direct_key,
                    peer_key: None,
                    legacy_account_key: None,
                    provisional_identity: Some(ProvisionalIdentity {
                        author_key: self.casemapping.fold(&message.sender).into_owned(),
                        account_key: message
                            .account
                            .as_deref()
                            .map(|account| self.casemapping.fold(account).into_owned()),
                    }),
                    author: message.sender,
                    text: message.text,
                    kind: match message.kind {
                        PushedMessageKind::Message => MessageKind::Text,
                        PushedMessageKind::Notice => MessageKind::IrcNotice,
                        PushedMessageKind::Action => MessageKind::Action,
                    },
                    bot: None,
                    authorship: MessageAuthorship::Other,
                    msgid: Some(message.msgid),
                    server_time_ms: Some(server_time_ms),
                    received_at_ms: server_time_ms,
                    origin: TimelineOrigin::Push,
                },
                state,
            );
            let restored = !received.events.is_empty();
            events.extend(received.events);
            if let Some(advance) = received.carry_read {
                events.extend(self.advance_read(advance.buffer_id, advance.time, true));
            }
            if restored && let Some(event) = self.mark_pushed_history_pending(&conversation_key) {
                events.push(event);
            }
        }
        events
    }

    fn mark_pushed_history_pending(&mut self, key: &NameKey) -> Option<EngineToUi> {
        let buffer_id = self.names.get(key).copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let has_provisional = buffer
            .chat_metadata
            .values()
            .any(|metadata| metadata.provisional_identity.is_some());
        if !has_provisional {
            return None;
        }
        buffer.pushed_history_pending = true;
        buffer.pushed_history_retry_available = true;
        buffer.projection.sync_state = history_sync_state(buffer);
        Some(EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        })
    }

    pub(crate) fn begin_send(
        &mut self,
        buffer_id: BufferId,
        text: String,
        state: &papo::State,
    ) -> Option<(PendingSend, Vec<EngineToUi>)> {
        self.begin_send_kind(buffer_id, text, MessageKind::Text, state)
    }

    pub(crate) fn begin_action(
        &mut self,
        buffer_id: BufferId,
        text: String,
        state: &papo::State,
    ) -> Option<(PendingSend, Vec<EngineToUi>)> {
        self.begin_send_kind(buffer_id, text, MessageKind::Action, state)
    }

    pub(crate) fn append_notice(
        &mut self,
        buffer_id: BufferId,
        text: String,
        notice: NoticeKind,
    ) -> Option<()> {
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: String::new(),
            text: collapse_blank_lines(text),
            kind: MessageKind::Notice(notice),
            bot: Some(false),
            authorship: MessageAuthorship::Own,
            nick_color_index: 0,
            highlighted: false,
            unverified_sender: None,
            reactions: None,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms: time_millis(papo::time::now()),
        };
        self.insert(buffer_id, message.clone(), None, DedupReferences::default())
            .ok()?;
        Some(())
    }

    pub(crate) fn append_history_gap(&mut self, buffer_id: BufferId) -> Option<()> {
        let received_at_ms = self.buffers.get(&buffer_id)?.newest.as_ref().map_or_else(
            || time_millis(papo::time::now()),
            |cursor| time_millis(cursor.server_time),
        );
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: String::new(),
            text: "Some messages were skipped while reconnecting.".into(),
            kind: MessageKind::Notice(NoticeKind::Info),
            bot: Some(false),
            authorship: MessageAuthorship::Own,
            nick_color_index: 0,
            highlighted: false,
            unverified_sender: None,
            reactions: None,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms,
        };
        self.insert(buffer_id, message.clone(), None, DedupReferences::default())
            .ok()?;
        Some(())
    }

    fn begin_send_kind(
        &mut self,
        buffer_id: BufferId,
        text: String,
        kind: MessageKind,
        state: &papo::State,
    ) -> Option<(PendingSend, Vec<EngineToUi>)> {
        let buffer = self.buffers.get(&buffer_id)?;
        if buffer.projection.available == Some(false)
            || buffer.projection.channel_status == Some(ChannelStatus::Kicked)
        {
            return None;
        }
        let restored = buffer.restored_from_snapshot;
        let key = buffer.key.clone()?;
        let direct = buffer.direct.clone();
        let pin = buffer.direct_pin.clone();
        let mismatched = buffer.direct_mismatch.is_some();
        let awaits_live_target = (restored
            && buffer.projection.kind == BufferKind::Channel
            && buffer.projection.channel_status != Some(ChannelStatus::Joined))
            || (restored && buffer.projection.kind == BufferKind::Direct && direct.is_none())
            || matches!(
                &direct,
                Some(DirectAvailability::Pending | DirectAvailability::Resolving)
            );
        let target =
            SendTarget::from_buffer(key.clone(), direct.as_ref(), pin.as_ref(), mismatched)
                .or_else(|| {
                    if awaits_live_target && !mismatched {
                        match key.clone() {
                            NameKey::Direct(nick) => Some(SendTarget::Direct {
                                nick,
                                recipient: None,
                                pin: None,
                            }),
                            NameKey::Channel(_) => None,
                        }
                    } else {
                        None
                    }
                })?;
        if matches!(
            &target,
            SendTarget::Direct {
                recipient: None,
                ..
            }
        ) && !awaits_live_target
        {
            return None;
        }
        let local_send_id = LocalSendId(self.next_local_send_id);
        self.next_local_send_id += 1;
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: self.network.nickname.clone(),
            text: collapse_blank_lines(text.clone()),
            kind: kind.clone(),
            bot: state.user(state.nick()).and_then(papo::User::is_bot),
            authorship: MessageAuthorship::Own,
            nick_color_index: nick_color_index(state.casemapping(), &self.network.nickname),
            highlighted: false,
            unverified_sender: None,
            reactions: None,
            delivery: MessageDelivery::Optimistic,
            local_send_id: Some(local_send_id),
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms: time_millis(papo::time::now()),
        };
        let order_changed = self
            .insert(
                buffer_id,
                message.clone(),
                Some(text.clone()),
                DedupReferences::default(),
            )
            .ok()?;
        let mut events = vec![EngineToUi::BufferUpdated {
            buffer: self.buffers[&buffer_id].projection.clone(),
        }];
        if order_changed {
            events.push(self.buffers_event());
        }
        Some((
            PendingSend {
                buffer_id,
                local_send_id,
                target,
                text,
                kind,
            },
            events,
        ))
    }

    pub(crate) fn prepare_live_send(&self, pending: &mut PendingSend) -> PendingTargetState {
        let Some(buffer) = self.buffers.get(&pending.buffer_id) else {
            return PendingTargetState::Gone;
        };
        if buffer.projection.available == Some(false) {
            return PendingTargetState::Gone;
        }
        if buffer.restored_from_snapshot
            && buffer.projection.kind == BufferKind::Channel
            && buffer.projection.channel_status != Some(ChannelStatus::Joined)
        {
            return PendingTargetState::Waiting;
        }
        match (&buffer.key, &buffer.direct) {
            (Some(NameKey::Channel(channel)), _) => {
                pending.target = SendTarget::Channel(channel.clone());
                PendingTargetState::Ready
            }
            (Some(NameKey::Direct(nick)), Some(DirectAvailability::Guarded(recipient))) => {
                pending.target = SendTarget::Direct {
                    nick: nick.clone(),
                    recipient: Some(recipient.clone()),
                    pin: buffer.direct_pin.clone(),
                };
                PendingTargetState::Ready
            }
            (
                Some(NameKey::Direct(_)),
                Some(DirectAvailability::Pending | DirectAvailability::Resolving),
            ) => PendingTargetState::Waiting,
            _ => PendingTargetState::Gone,
        }
    }

    #[cfg(test)]
    pub(crate) fn receive_membership(
        &mut self,
        channel: &papo::ChannelName,
        kind: MembershipKind,
        nick: String,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
    ) -> Option<()> {
        self.receive_membership_event(
            channel,
            kind,
            nick,
            None,
            None,
            server_time_ms,
            received_at_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn receive_membership_event(
        &mut self,
        channel: &papo::ChannelName,
        kind: MembershipKind,
        nick: String,
        reason: Option<String>,
        msgid: Option<String>,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
    ) -> Option<()> {
        let buffer_id = *self.names.get(&NameKey::Channel(channel.clone()))?;
        let who_msgid = msgid.clone();
        let dedup = system_dedup_reference(
            buffer_id,
            msgid,
            server_time_ms,
            membership_kind_name(kind),
            nick.clone(),
            None,
        );
        if dedup
            .as_ref()
            .is_some_and(|reference| !self.system_dedup.insert(reference.clone()))
        {
            return None;
        }
        let who = crate::timeline::Who {
            nick,
            own: false,
            msgid: who_msgid,
        };
        let event = match kind {
            MembershipKind::Joined => FoldEvent::Joined(who),
            MembershipKind::Parted => FoldEvent::Parted(who, reason),
            MembershipKind::Quit => FoldEvent::Quit(who, reason, None),
        };
        let id = self.allocate_message_id();
        let order = self.allocate_order(server_time_ms, received_at_ms);
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.timeline.push(TimelineRecord {
            id,
            order,
            day: self.calendar.day(order.primary_ms()),
            body: RecordBody::Fold(event),
        });
        buffer.timeline.sort_by_key(|record| record.order);
        buffer.system_server_times.insert(id, server_time_ms);
        if let Some(dedup) = dedup {
            buffer.system_dedup.insert(id, dedup);
        }
        self.dirty_timelines.insert(buffer_id);
        Some(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn receive_kick(
        &mut self,
        channel: &papo::ChannelName,
        actor: String,
        subject: String,
        subject_own: bool,
        reason: Option<String>,
        msgid: Option<String>,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
        update_status: bool,
    ) -> Option<Vec<EngineToUi>> {
        let buffer_id = *self.names.get(&NameKey::Channel(channel.clone()))?;
        let dedup = system_dedup_reference(
            buffer_id,
            msgid,
            server_time_ms,
            "kick",
            actor.clone(),
            Some(subject.clone()),
        );
        if dedup
            .as_ref()
            .is_some_and(|reference| !self.system_dedup.insert(reference.clone()))
        {
            return None;
        }
        let id = self.allocate_message_id();
        let order = self.allocate_order(server_time_ms, received_at_ms);
        let line = LineEvent::Kick {
            actor: Actor::User(person(self.casemapping, actor, false)),
            subject: if subject_own {
                Subject::You
            } else {
                Subject::Other(person(self.casemapping, subject, false))
            },
            reason,
        };
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if subject_own && update_status {
            buffer.projection.channel_status = Some(ChannelStatus::Kicked);
        }
        buffer.timeline.push(TimelineRecord {
            id,
            order,
            day: self.calendar.day(order.primary_ms()),
            body: RecordBody::Line(line),
        });
        buffer.timeline.sort_by_key(|record| record.order);
        buffer.system_server_times.insert(id, server_time_ms);
        if let Some(dedup) = dedup {
            buffer.system_dedup.insert(id, dedup);
        }
        self.dirty_timelines.insert(buffer_id);
        Some(
            (subject_own && update_status)
                .then(|| EngineToUi::BufferUpdated {
                    buffer: buffer.projection.clone(),
                })
                .into_iter()
                .collect(),
        )
    }

    pub(crate) fn confirm_send(
        &mut self,
        pending: &PendingSend,
        sent: &papo::Sent,
    ) -> Option<Vec<EngineToUi>> {
        self.reconcilable_failed_sends
            .remove(&pending.local_send_id);
        let buffer = self.buffers.get_mut(&pending.buffer_id)?;
        let index = buffer.timeline.iter().position(|record| {
            chat_projection(record)
                .is_some_and(|message| message.local_send_id == Some(pending.local_send_id))
        })?;
        let record = buffer.timeline.remove(index);
        let original = chat_projection(&record)?.clone();
        buffer.chat_metadata.remove(&record.id);
        let (lines, server_time) = match sent.outcome() {
            papo::SentOutcome::Confirmed {
                lines, server_time, ..
            } if !lines.is_empty() => (Some(lines), server_time.map(time_millis)),
            _ => (None, None),
        };
        let messages = if let Some(lines) = lines {
            lines
                .iter()
                .enumerate()
                .map(|(index, (msgid, text))| {
                    let mut message = original.clone();
                    if index != 0 {
                        message.id = self.allocate_message_id();
                    }
                    message.text = collapse_blank_lines(confirmed_text(&message.kind, text));
                    message.server_ids = vec![msgid.to_string()];
                    message.server_time_ms = server_time;
                    message.delivery = MessageDelivery::Confirmed;
                    message.local_send_id = None;
                    message
                })
                .collect::<Vec<_>>()
        } else {
            let mut message = original;
            message.delivery = MessageDelivery::Confirmed;
            message.local_send_id = None;
            vec![message]
        };
        let mut order_changed = false;
        for message in &messages {
            for msgid in &message.server_ids {
                let reference = self.msgids.entry(msgid.clone()).or_insert(MsgidReference {
                    count: 0,
                    location: None,
                });
                reference.count += 1;
                reference.location = Some((pending.buffer_id, message.id));
            }
            order_changed |= self
                .insert(
                    pending.buffer_id,
                    message.clone(),
                    None,
                    DedupReferences {
                        msgids: message.server_ids.clone(),
                        fallback: None,
                    },
                )
                .ok()?;
        }
        let mut events = Vec::new();
        if order_changed {
            events.push(self.buffers_event());
        }
        events.push(EngineToUi::BufferUpdated {
            buffer: self.buffers[&pending.buffer_id].projection.clone(),
        });
        Some(events)
    }

    pub(crate) fn pending_message_id(&self, pending: &PendingSend) -> Option<MessageId> {
        self.buffers
            .get(&pending.buffer_id)?
            .timeline
            .iter()
            .find_map(|record| {
                chat_projection(record)
                    .is_some_and(|message| message.local_send_id == Some(pending.local_send_id))
                    .then_some(record.id)
            })
    }

    pub(crate) fn fail_send(
        &mut self,
        pending: &PendingSend,
        message_key: EngineMessageKey,
    ) -> Vec<EngineToUi> {
        self.reconcilable_failed_sends
            .remove(&pending.local_send_id);
        if let Some(message) = self.buffers.get_mut(&pending.buffer_id).and_then(|buffer| {
            buffer
                .timeline
                .iter_mut()
                .filter_map(chat_projection_mut)
                .find(|message| message.local_send_id == Some(pending.local_send_id))
        }) {
            message.delivery = MessageDelivery::Failed;
            self.dirty_timelines.insert(pending.buffer_id);
        }
        let target = pending.target.title();
        let mut events = vec![EngineToUi::MessageFailed {
            network_id: self.network.id,
            buffer_id: pending.buffer_id,
            target: target.clone(),
            local_send_id: pending.local_send_id,
            message_key,
        }];
        let hidden_direct = !self.buffer_order.contains(&pending.buffer_id)
            && self
                .buffers
                .get(&pending.buffer_id)
                .is_some_and(|buffer| buffer.projection.kind == BufferKind::Direct);
        if hidden_direct {
            events.push(EngineToUi::Notice {
                key: "notice.message_not_delivered".into(),
                values: BTreeMap::from([
                    ("network_id".into(), self.network.id.0.to_string()),
                    ("target".into(), target),
                ]),
                tone: NoticeTone::Error,
                action: Some(NoticeAction {
                    label: "action.open".into(),
                    run: "buffer.open-direct".into(),
                }),
            });
        }
        events
    }

    pub(crate) fn interrupt_send(&mut self, pending: &PendingSend) -> Vec<EngineToUi> {
        let events = self.fail_send(pending, EngineMessageKey::SendFailed);
        self.reconcilable_failed_sends.insert(pending.local_send_id);
        events
    }

    pub(crate) fn retry_send(
        &mut self,
        buffer_id: BufferId,
        local_send_id: LocalSendId,
    ) -> Option<PendingSend> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let target = SendTarget::from_buffer(
            buffer.key.clone()?,
            buffer.direct.as_ref(),
            buffer.direct_pin.as_ref(),
            buffer.direct_mismatch.is_some(),
        )?;
        let message_id = buffer.timeline.iter().find_map(|record| {
            let message = chat_projection(record)?;
            (message.local_send_id == Some(local_send_id)
                && message.delivery == MessageDelivery::Failed)
                .then_some(record.id)
        })?;
        let message = buffer
            .timeline
            .iter_mut()
            .find(|record| record.id == message_id)
            .and_then(chat_projection_mut)?;
        message.delivery = MessageDelivery::Optimistic;
        let kind = message.kind.clone();
        let text = buffer.chat_metadata.get(&message_id)?.send_text.clone()?;
        let pending = PendingSend {
            buffer_id,
            local_send_id,
            target,
            text,
            kind,
        };
        self.dirty_timelines.insert(buffer_id);
        self.reconcilable_failed_sends.remove(&local_send_id);
        Some(pending)
    }

    pub(crate) fn history_targets(&self) -> Vec<HistoryTarget> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter_map(|buffer| buffer.key.clone().map(HistoryTarget::from_key))
            .collect()
    }

    pub(crate) fn buffer_updated(&self, buffer_id: BufferId) -> Option<EngineToUi> {
        Some(EngineToUi::BufferUpdated {
            buffer: self.buffers.get(&buffer_id)?.projection.clone(),
        })
    }

    #[cfg(test)]
    pub(crate) fn projected_messages(&self, buffer_id: BufferId) -> Vec<MessageProjection> {
        self.buffers
            .get(&buffer_id)
            .into_iter()
            .flat_map(|buffer| buffer.timeline.iter())
            .filter_map(chat_projection)
            .cloned()
            .collect()
    }

    pub(crate) fn request_history(
        &mut self,
        buffer_id: BufferId,
        direction: crate::HistoryDirection,
    ) -> Option<HistoryFetch> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let target = HistoryTarget::from_key(buffer.key.clone()?);
        if direction == crate::HistoryDirection::Latest && buffer.pushed_history_pending {
            return begin_pushed_history(buffer, target);
        }
        match (direction, &buffer.history) {
            (
                crate::HistoryDirection::Latest,
                HistoryState::Unrequested
                | HistoryState::QueuedLatest
                | HistoryState::RefreshCapped,
            ) => {
                set_history_state(buffer, HistoryState::LoadingLatest);
                Some(HistoryFetch::Latest(target))
            }
            (
                crate::HistoryDirection::Older,
                HistoryState::Ready {
                    oldest: Some(oldest),
                    at_start: false,
                },
            ) => {
                let oldest = oldest.clone();
                set_history_state(
                    buffer,
                    HistoryState::LoadingOlder {
                        oldest: oldest.clone(),
                    },
                );
                Some(HistoryFetch::Before { target, oldest })
            }
            _ => None,
        }
    }

    pub(crate) fn queue_latest_history(&mut self, buffer_id: BufferId) -> bool {
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return false;
        };
        if !matches!(buffer.history, HistoryState::Unrequested) {
            return false;
        }
        set_history_state(buffer, HistoryState::QueuedLatest);
        true
    }

    pub(crate) fn connected_history(&mut self) -> Vec<HistoryFetch> {
        let queued = self
            .buffer_order
            .iter()
            .filter_map(|id| {
                let buffer = self.buffers.get(id)?;
                (matches!(buffer.history, HistoryState::QueuedLatest)
                    || buffer.pushed_history_pending)
                    .then(|| buffer.key.clone().map(HistoryTarget::from_key))
                    .flatten()
                    .map(|target| (*id, target))
            })
            .collect::<Vec<_>>();
        queued
            .into_iter()
            .filter_map(|(buffer_id, target)| {
                let buffer = self.buffers.get_mut(&buffer_id)?;
                if buffer.pushed_history_pending {
                    begin_pushed_history(buffer, target)
                } else {
                    set_history_state(buffer, HistoryState::LoadingLatest);
                    Some(HistoryFetch::Latest(target))
                }
            })
            .collect::<Vec<_>>()
    }

    pub(crate) fn restart_inflight_history(&mut self) {
        for buffer in self.buffers.values_mut() {
            let next = match &buffer.history {
                HistoryState::LoadingLatest => Some(HistoryState::QueuedLatest),
                HistoryState::LoadingOlder { oldest } => Some(HistoryState::Ready {
                    oldest: Some(oldest.clone()),
                    at_start: false,
                }),
                HistoryState::Refreshing { oldest, at_start } => Some(HistoryState::Ready {
                    oldest: oldest.clone(),
                    at_start: *at_start,
                }),
                HistoryState::Unrequested
                | HistoryState::QueuedLatest
                | HistoryState::Ready { .. }
                | HistoryState::RefreshCapped => None,
            };
            if let Some(next) = next {
                set_history_state(buffer, next);
            }
        }
    }

    pub(crate) fn retry_pushed_history(&mut self, buffer_id: BufferId) -> Option<HistoryFetch> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if !buffer.pushed_history_pending || !buffer.pushed_history_retry_available {
            return None;
        }
        buffer.pushed_history_retry_available = false;
        begin_pushed_history(buffer, HistoryTarget::from_key(buffer.key.clone()?))
    }

    pub(crate) fn fallback_target_history(&mut self, history_available: bool) -> Vec<HistoryFetch> {
        self.finish_target_sync(None);
        if !history_available {
            return Vec::new();
        }
        let planned = self
            .buffer_order
            .iter()
            .filter_map(|buffer_id| {
                let buffer = self.buffers.get(buffer_id)?;
                let target = buffer.key.clone().map(HistoryTarget::from_key)?;
                let fetch = match &buffer.history {
                    HistoryState::Unrequested | HistoryState::QueuedLatest => {
                        Some(HistoryFetch::Latest(target))
                    }
                    HistoryState::Ready { .. } => match buffer.newest.clone() {
                        Some(newest) => Some(HistoryFetch::After { target, newest }),
                        None => Some(HistoryFetch::Latest(target)),
                    },
                    HistoryState::RefreshCapped => Some(HistoryFetch::Latest(target)),
                    HistoryState::LoadingLatest
                    | HistoryState::LoadingOlder { .. }
                    | HistoryState::Refreshing { .. } => None,
                }?;
                Some((*buffer_id, fetch, buffer.restored_from_snapshot))
            })
            .collect::<Vec<_>>();
        for (buffer_id, fetch, keep_cached) in &planned {
            let Some(buffer) = self.buffers.get_mut(buffer_id) else {
                continue;
            };
            if *keep_cached && matches!(fetch, HistoryFetch::Latest(_)) {
                set_history_state(buffer, HistoryState::LoadingLatest);
            } else {
                begin_target_fetch(buffer, fetch);
            }
        }
        planned.into_iter().map(|(_, fetch, _)| fetch).collect()
    }

    pub(crate) fn request_latest_channel(
        &mut self,
        channel: &papo::ChannelName,
    ) -> Option<HistoryTarget> {
        let buffer_id = self
            .names
            .get(&NameKey::Channel(channel.clone()))
            .copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if buffer.restored_from_snapshot || !matches!(buffer.history, HistoryState::Unrequested) {
            return None;
        }
        let target = HistoryTarget::from_key(buffer.key.clone()?);
        set_history_state(buffer, HistoryState::LoadingLatest);
        Some(target)
    }

    pub(crate) fn history_load(&self, conversation: &papo::Conversation) -> Option<HistoryLoad> {
        let key = NameKey::from_conversation(conversation)?;
        let buffer = self.buffers.get(self.names.get(&key)?)?;
        match buffer.history {
            HistoryState::LoadingLatest => Some(HistoryLoad::Latest),
            HistoryState::LoadingOlder { .. } => Some(HistoryLoad::Older),
            HistoryState::Refreshing { .. } => Some(HistoryLoad::Refresh),
            HistoryState::Unrequested
            | HistoryState::QueuedLatest
            | HistoryState::Ready { .. }
            | HistoryState::RefreshCapped => None,
        }
    }

    pub(crate) fn finish_history(
        &mut self,
        conversation: &papo::Conversation,
        oldest: Option<papo::HistoryReference>,
        oldest_time_ms: Option<i64>,
        newest: Option<HistoryCursor>,
        item_count: usize,
        end: bool,
    ) -> Option<HistoryCompletion> {
        let key = NameKey::from_conversation(conversation)?;
        let buffer_id = self.names.get(&key).copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let reconciles_push = buffer.pushed_history_pending
            && matches!(
                buffer.history,
                HistoryState::LoadingLatest | HistoryState::Refreshing { .. }
            );
        let mut gap = false;
        let at_start = match buffer.history.clone() {
            HistoryState::LoadingOlder { oldest: previous } => {
                let oldest = oldest.or(Some(previous));
                buffer.history = HistoryState::Ready {
                    oldest,
                    at_start: item_count == 0,
                };
                Some(item_count == 0)
            }
            HistoryState::LoadingLatest => {
                buffer.history = HistoryState::Ready {
                    oldest,
                    at_start: item_count == 0,
                };
                Some(item_count == 0)
            }
            HistoryState::Refreshing { oldest, at_start } => {
                advance_cursor(buffer, newest);
                buffer.history = if end {
                    HistoryState::Ready { oldest, at_start }
                } else {
                    HistoryState::RefreshCapped
                };
                gap = !end;
                None
            }
            HistoryState::Unrequested
            | HistoryState::QueuedLatest
            | HistoryState::Ready { .. }
            | HistoryState::RefreshCapped => return None,
        };
        if reconciles_push
            && !buffer
                .chat_metadata
                .values()
                .any(|metadata| metadata.provisional_identity.is_some())
        {
            buffer.pushed_history_pending = false;
            buffer.pushed_history_retry_available = false;
        }
        if gap && let Some(oldest_time_ms) = oldest_time_ms {
            buffer
                .read_facts
                .merge_gap_until(ServerTimeMs::new(oldest_time_ms));
        }
        buffer.projection.sync_state = history_sync_state(buffer);
        derive_read_projection(buffer);
        let completion = HistoryCompletion {
            buffer_id,
            at_start,
            gap,
        };
        self.settle_target_history(&key, true);
        Some(completion)
    }

    pub(crate) fn fail_history(&mut self, fetch: &HistoryFetch) -> Option<BufferId> {
        let target = match fetch {
            HistoryFetch::Latest(target)
            | HistoryFetch::Before { target, .. }
            | HistoryFetch::After { target, .. } => target,
        };
        let buffer_id = self.names.get(&target.name_key()).copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let history = match &buffer.history {
            HistoryState::LoadingLatest => HistoryState::Unrequested,
            HistoryState::Refreshing { oldest, at_start } => HistoryState::Ready {
                oldest: oldest.clone(),
                at_start: *at_start,
            },
            HistoryState::LoadingOlder { oldest } => HistoryState::Ready {
                oldest: Some(oldest.clone()),
                at_start: false,
            },
            HistoryState::Unrequested
            | HistoryState::QueuedLatest
            | HistoryState::Ready { .. }
            | HistoryState::RefreshCapped => return None,
        };
        set_history_state(buffer, history);
        self.settle_target_history(&target.name_key(), false);
        Some(buffer_id)
    }

    pub(crate) fn channel_for_buffer(&self, buffer_id: BufferId) -> Option<papo::ChannelName> {
        match self.buffers.get(&buffer_id)?.key.clone()? {
            NameKey::Channel(channel) => Some(channel),
            NameKey::Direct(_) => None,
        }
    }

    pub(crate) fn buffer_id_for_channel(&self, channel: &papo::ChannelName) -> Option<BufferId> {
        self.names.get(&NameKey::Channel(channel.clone())).copied()
    }

    pub(crate) fn projected_channel_for_join(&self, channel: &str) -> Option<(BufferId, bool)> {
        let folded = self.casemapping.fold(channel);
        self.buffers.iter().find_map(|(buffer_id, buffer)| {
            (buffer.projection.kind == BufferKind::Channel
                && self.casemapping.fold(&buffer.projection.title) == folded)
                .then_some((
                    *buffer_id,
                    buffer.projection.channel_status == Some(ChannelStatus::Joined)
                        && buffer.projection.available != Some(false),
                ))
        })
    }

    pub(crate) fn snapshot_conversation_for_channel(
        &self,
        channel: &papo::ChannelName,
    ) -> Option<SnapshotConversation> {
        let buffer_id = self.buffer_id_for_channel(channel)?;
        snapshot_conversation(self.buffers.get(&buffer_id)?)
    }

    #[cfg(test)]
    pub(crate) fn pending_read_time(&self, buffer_id: BufferId) -> Option<SystemTime> {
        self.buffers
            .get(&buffer_id)?
            .read_facts
            .pending()
            .map(|time| system_time_from_millis(time.value()))
    }

    pub(crate) fn buffer_id_for_conversation(
        &self,
        conversation: &papo::Conversation,
    ) -> Option<BufferId> {
        self.names
            .get(&NameKey::from_conversation(conversation)?)
            .copied()
    }

    pub(crate) fn conversation_buffers(
        &self,
    ) -> impl Iterator<Item = (BufferId, papo::Conversation)> + '_ {
        self.buffers.iter().filter_map(|(buffer_id, buffer)| {
            let conversation = match buffer.key.as_ref()? {
                NameKey::Channel(channel) => papo::Conversation::Channel(channel.clone()),
                NameKey::Direct(nick) => papo::Conversation::Private(nick.clone()),
            };
            Some((*buffer_id, conversation))
        })
    }

    pub(crate) fn typing_target(&self, buffer_id: BufferId) -> Option<SendTarget> {
        let buffer = self.buffers.get(&buffer_id)?;
        SendTarget::from_buffer(
            buffer.key.clone()?,
            buffer.direct.as_ref(),
            buffer.direct_pin.as_ref(),
            buffer.direct_mismatch.is_some(),
        )
    }

    pub(crate) fn remove_channel(&mut self, channel: &papo::ChannelName) -> Option<EngineToUi> {
        let key = NameKey::Channel(channel.clone());
        let buffer_id = self.names.remove(&key)?;
        self.buffer_order.retain(|id| *id != buffer_id);
        let buffer = self.buffers.remove(&buffer_id)?;
        for metadata in buffer.chat_metadata.into_values() {
            self.release_dedup(metadata.dedup);
        }
        for reference in buffer.system_dedup.into_values() {
            self.system_dedup.remove(&reference);
        }
        self.reactions.clear_buffer(buffer_id);
        Some(EngineToUi::BufferRemoved { buffer_id })
    }

    pub(crate) fn set_member_count(
        &mut self,
        buffer_id: BufferId,
        count: u32,
    ) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        (buffer.projection.member_count != Some(count)).then(|| {
            buffer.projection.member_count = Some(count);
            EngineToUi::BufferUpdated {
                buffer: buffer.projection.clone(),
            }
        })
    }

    pub(crate) fn close_direct(&mut self, buffer_id: BufferId) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        (buffer.projection.kind == BufferKind::Direct).then_some(())?;
        buffer.direct = Some(DirectAvailability::Pending);
        for record in &mut buffer.timeline {
            if let Some(message) = chat_projection_mut(record) {
                message.reactions = None;
            }
        }
        self.dirty_timelines.insert(buffer_id);
        self.reactions.clear_buffer(buffer_id);
        self.buffer_order.retain(|id| *id != buffer_id);
        Some(self.buffers_event())
    }

    pub(crate) fn invalidate_direct_handles(&mut self) {
        for buffer in self.buffers.values_mut() {
            if buffer.projection.kind == BufferKind::Direct {
                buffer.direct = Some(DirectAvailability::Pending);
                if buffer
                    .direct_pin
                    .as_ref()
                    .is_some_and(|pin| !pin.is_verified())
                {
                    buffer.direct_pin = None;
                    buffer.direct_mismatch = None;
                    buffer.projection.direct_identity = Some(DirectIdentityState::Unverified);
                }
            }
        }
    }

    pub(crate) fn update_direct_account(
        &mut self,
        nick: &papo::Nick,
        account: &papo::Account,
    ) -> Vec<EngineToUi> {
        let Some(buffer_id) = self.names.get(&NameKey::Direct(nick.clone())).copied() else {
            return Vec::new();
        };
        let Some(account) = account.name() else {
            return Vec::new();
        };
        let current = self.buffers[&buffer_id].projection.draft_key.clone();
        let previous = draft_key(
            &self.network.label,
            &format!("account={}", account.key()),
            self.casemapping,
        );
        (previous != current)
            .then_some(EngineToUi::DraftKeyChanged { previous, current })
            .into_iter()
            .collect()
    }

    pub(crate) fn recent_speakers(
        &self,
        buffer_id: BufferId,
        prefix: &str,
        state: &papo::State,
    ) -> Vec<String> {
        let folded_prefix = state.casemapping().fold(prefix);
        let mut seen = std::collections::HashSet::new();
        self.buffers
            .get(&buffer_id)
            .into_iter()
            .flat_map(|buffer| buffer.timeline.iter().rev())
            .filter_map(chat_projection)
            .map(|message| message.author.clone())
            .filter(|nick| !is_own_nick(state, nick))
            .filter(|value| state.casemapping().fold(value).starts_with(&*folded_prefix))
            .filter(|value| seen.insert(state.casemapping().fold(value).into_owned()))
            .collect()
    }

    pub(crate) fn channel_names(&self) -> Vec<String> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter(|buffer| buffer.projection.kind == BufferKind::Channel)
            .map(|buffer| buffer.projection.title.clone())
            .collect()
    }

    pub(crate) fn open_direct(
        &mut self,
        nick: papo::Nick,
        direct: DirectAvailability,
        state: &papo::State,
    ) -> (BufferId, Vec<EngineToUi>) {
        let legacy_account = state
            .user(&nick)
            .and_then(|user| user.account().name())
            .map(|account| account.key().to_owned());
        let direct_key = DirectKey::from_nick(&nick);
        let (buffer_id, added) =
            self.ensure_buffer(NameKey::Direct(nick), Some(direct_key), Some(direct));
        let newly_added = added.is_some();
        self.capture_direct_pin(buffer_id);
        let mut events = Vec::new();
        if let Some(buffer) = added.or_else(|| self.reveal_buffer(buffer_id)) {
            events.push(EngineToUi::BufferAdded { buffer });
            events.push(self.buffers_event());
        }
        if newly_added && let Some(account) = legacy_account {
            events.push(self.legacy_draft_migration(buffer_id, &account));
        }
        (buffer_id, events)
    }

    pub(crate) fn restore_direct(
        &mut self,
        nick: &papo::Nick,
        latest: SystemTime,
    ) -> (
        Option<HistoryFetch>,
        Option<BufferId>,
        Option<BufferProjection>,
    ) {
        let key = NameKey::Direct(nick.clone());
        let should_resolve = !matches!(
            self.direct(nick),
            Some(DirectAvailability::Guarded(_) | DirectAvailability::Resolving)
        );
        let direct_key = DirectKey::from_nick(nick);
        let (buffer_id, added) = self.ensure_buffer(key, Some(direct_key.clone()), None);
        let fetch = self.buffers.get(&buffer_id).and_then(|buffer| {
            let target = HistoryTarget::Direct(nick.clone());
            match &buffer.history {
                HistoryState::Unrequested | HistoryState::QueuedLatest
                    if buffer.restored_from_snapshot
                        && buffer
                            .newest
                            .as_ref()
                            .is_some_and(|cursor| latest <= cursor.server_time) =>
                {
                    None
                }
                HistoryState::Unrequested | HistoryState::QueuedLatest
                    if buffer.restored_from_snapshot =>
                {
                    match cached_refresh_cursor(buffer) {
                        Some(newest) => Some(HistoryFetch::After { target, newest }),
                        None => Some(HistoryFetch::Latest(target)),
                    }
                }
                HistoryState::Unrequested | HistoryState::QueuedLatest => {
                    Some(HistoryFetch::Latest(target))
                }
                HistoryState::Ready { .. }
                    if buffer
                        .newest
                        .as_ref()
                        .is_some_and(|cursor| latest > cursor.server_time) =>
                {
                    Some(HistoryFetch::After {
                        target,
                        newest: buffer.newest.clone()?,
                    })
                }
                HistoryState::Ready { .. } if buffer.newest.is_none() => {
                    Some(HistoryFetch::Latest(target))
                }
                _ => None,
            }
        });
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            buffer.provisional_activity_ms = Some(buffer.provisional_activity_ms.map_or_else(
                || time_millis(latest),
                |current| current.max(time_millis(latest)),
            ));
            if let Some(fetch) = &fetch {
                begin_target_fetch(buffer, fetch);
            }
            if should_resolve {
                buffer.direct = Some(DirectAvailability::Pending);
            }
            derive_chat_projection(buffer);
        }
        self.sort_buffer_order();
        (fetch, should_resolve.then_some(buffer_id), added)
    }

    pub(crate) fn direct_marker_targets(&self) -> Vec<HistoryTarget> {
        self.buffer_order
            .iter()
            .filter_map(|buffer_id| self.buffers.get(buffer_id))
            .filter(|buffer| !buffer.read_facts.stubs().is_empty())
            .filter_map(|buffer| match buffer.key.clone()? {
                NameKey::Direct(nick) => Some(HistoryTarget::Direct(nick)),
                NameKey::Channel(_) => None,
            })
            .collect()
    }

    pub(crate) fn direct_with_stubs_needs_marker(&self, nick: &papo::Nick) -> bool {
        self.names
            .get(&NameKey::Direct(nick.clone()))
            .and_then(|buffer_id| self.buffers.get(buffer_id))
            .is_some_and(|buffer| !buffer.read_facts.stubs().is_empty())
    }

    pub(crate) fn restore_channel(
        &mut self,
        channel: &papo::ChannelName,
        latest: SystemTime,
    ) -> Option<HistoryFetch> {
        let buffer_id = self
            .names
            .get(&NameKey::Channel(channel.clone()))
            .copied()?;
        let buffer = self.buffers.get(&buffer_id)?;
        let target = HistoryTarget::Channel(channel.clone());
        let fetch = match &buffer.history {
            HistoryState::Unrequested
                if buffer.restored_from_snapshot
                    && buffer
                        .newest
                        .as_ref()
                        .is_some_and(|cursor| latest <= cursor.server_time) =>
            {
                None
            }
            HistoryState::Unrequested if buffer.restored_from_snapshot => {
                match cached_refresh_cursor(buffer) {
                    Some(newest) => Some(HistoryFetch::After { target, newest }),
                    None => Some(HistoryFetch::Latest(target)),
                }
            }
            HistoryState::Ready { .. }
                if buffer
                    .newest
                    .as_ref()
                    .is_some_and(|cursor| latest > cursor.server_time) =>
            {
                Some(HistoryFetch::After {
                    target,
                    newest: buffer.newest.clone()?,
                })
            }
            HistoryState::Ready { .. } if buffer.newest.is_none() => {
                Some(HistoryFetch::Latest(target))
            }
            _ => None,
        };
        if let Some(fetch) = &fetch {
            let buffer = self.buffers.get_mut(&buffer_id)?;
            buffer.provisional_activity_ms = Some(time_millis(latest));
            begin_target_fetch(buffer, fetch);
        }
        fetch
    }

    pub(crate) fn direct(&self, nick: &papo::Nick) -> Option<DirectAvailability> {
        let buffer_id = self.names.get(&NameKey::Direct(nick.clone()))?;
        self.buffers.get(buffer_id)?.direct.clone()
    }

    pub(crate) fn send_rejection_key(&self, buffer_id: BufferId) -> EngineMessageKey {
        let buffer = self.buffers.get(&buffer_id);
        if buffer
            .is_some_and(|buffer| buffer.projection.channel_status == Some(ChannelStatus::Kicked))
        {
            EngineMessageKey::ChannelRejoinRequired
        } else if buffer
            .and_then(|buffer| buffer.direct.as_ref())
            .is_some_and(|direct| matches!(direct, DirectAvailability::MonitorFull))
        {
            EngineMessageKey::DirectMonitorFull
        } else {
            EngineMessageKey::BufferNotSendable
        }
    }

    pub(crate) fn begin_direct_resolution(&mut self, nick: &papo::Nick) -> Option<BufferId> {
        let buffer_id = self.names.get(&NameKey::Direct(nick.clone())).copied()?;
        let direct = self
            .buffers
            .get_mut(&buffer_id)
            .and_then(|buffer| buffer.direct.as_mut())?;
        if matches!(direct, DirectAvailability::Pending) {
            *direct = DirectAvailability::Resolving;
            Some(buffer_id)
        } else {
            None
        }
    }

    pub(crate) fn begin_buffer_direct_resolution(
        &mut self,
        buffer_id: BufferId,
    ) -> Option<papo::Nick> {
        let buffer = self.buffers.get(&buffer_id)?;
        let NameKey::Direct(nick) = buffer.key.as_ref()? else {
            return None;
        };
        let nick = nick.clone();
        self.begin_direct_resolution(&nick).map(|_| nick)
    }

    pub(crate) fn begin_online_direct_resolution(
        &mut self,
        nick: &papo::Nick,
    ) -> Option<(BufferId, Option<papo::DirectRef>)> {
        let buffer_id = self.names.get(&NameKey::Direct(nick.clone())).copied()?;
        let direct = self
            .buffers
            .get_mut(&buffer_id)
            .and_then(|buffer| buffer.direct.as_mut())?;
        let previous = match std::mem::replace(direct, DirectAvailability::Resolving) {
            DirectAvailability::Guarded(direct) => Some(direct),
            DirectAvailability::Pending
            | DirectAvailability::Resolving
            | DirectAvailability::Failed => None,
            current @ DirectAvailability::MonitorFull => {
                *direct = current;
                return None;
            }
        };
        Some((buffer_id, previous))
    }

    pub(crate) fn resolve_direct(&mut self, buffer_id: BufferId, availability: DirectAvailability) {
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            buffer.direct = Some(availability);
        }
        self.capture_direct_pin(buffer_id);
    }

    fn capture_direct_pin(&mut self, buffer_id: BufferId) {
        let current = self.buffers.get(&buffer_id).and_then(|buffer| {
            let DirectAvailability::Guarded(direct) = buffer.direct.as_ref()? else {
                return None;
            };
            Some(direct.peer_key().clone())
        });
        if let Some(current) = current {
            self.apply_direct_peer_key(buffer_id, current);
        }
    }

    fn apply_direct_peer_key(&mut self, buffer_id: BufferId, current: papo::PeerKey) -> bool {
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return false;
        };
        match buffer
            .direct_pin
            .as_ref()
            .map(|stored| stored.check(&current))
        {
            None => {
                buffer.direct_pin = Some(current);
                buffer.direct_mismatch = None;
            }
            Some(papo::PeerKeyCheck::Match) => buffer.direct_mismatch = None,
            Some(papo::PeerKeyCheck::Upgrade(upgraded)) => {
                buffer.direct_pin = Some(upgraded);
                buffer.direct_mismatch = None;
            }
            Some(papo::PeerKeyCheck::Mismatch(reason)) => {
                buffer.direct_mismatch = Some(DirectMismatch {
                    reason,
                    current,
                    deferred: false,
                });
            }
        }
        buffer.projection.direct_identity = direct_identity(buffer);
        buffer.direct_mismatch.is_none()
            && buffer
                .direct_pin
                .as_ref()
                .is_some_and(papo::PeerKey::is_verified)
    }

    pub(crate) fn record_direct_mismatch(
        &mut self,
        buffer_id: BufferId,
        mismatch: &papo::PeerPinMismatch,
    ) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.direct_mismatch = Some(DirectMismatch {
            reason: mismatch.reason(),
            current: mismatch.current_key().clone(),
            deferred: false,
        });
        buffer.projection.direct_identity = direct_identity(buffer);
        Some(EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        })
    }

    pub(crate) fn defer_direct_identity(&mut self, buffer_id: BufferId) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.direct_mismatch.as_mut()?.deferred = true;
        buffer.projection.direct_identity = direct_identity(buffer);
        Some(EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        })
    }

    pub(crate) fn direct_trust_target(&self, buffer_id: BufferId) -> Option<papo::Nick> {
        let buffer = self.buffers.get(&buffer_id)?;
        buffer.direct_mismatch.as_ref()?;
        let Some(NameKey::Direct(nick)) = buffer.key.as_ref() else {
            return None;
        };
        Some(nick.clone())
    }

    pub(crate) fn trust_direct_identity(
        &mut self,
        buffer_id: BufferId,
        direct: papo::DirectRef,
    ) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let mismatch = buffer.direct_mismatch.take()?;
        let current = direct.peer_key().clone();
        buffer.direct_pin = match mismatch.current.check(&current) {
            papo::PeerKeyCheck::Match => Some(current),
            papo::PeerKeyCheck::Upgrade(upgraded) => Some(upgraded),
            papo::PeerKeyCheck::Mismatch(reason) => {
                buffer.direct_mismatch = Some(DirectMismatch {
                    reason,
                    current,
                    deferred: false,
                });
                buffer.projection.direct_identity = direct_identity(buffer);
                return Some(EngineToUi::BufferUpdated {
                    buffer: buffer.projection.clone(),
                });
            }
        };
        buffer.direct = Some(DirectAvailability::Guarded(direct));
        buffer.projection.direct_identity = direct_identity(buffer);
        Some(EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        })
    }

    pub(crate) fn request_mark_read(
        &self,
        buffer_id: BufferId,
        through: MessageId,
    ) -> Option<ReadAdvance> {
        let buffer = self.buffers.get(&buffer_id)?;
        if !buffer
            .timeline
            .iter()
            .filter_map(chat_projection)
            .any(|message| message.id == through && is_committed(message))
        {
            return None;
        }
        read_advance(buffer_id, buffer, through, true)
    }

    pub(crate) fn prepare_mark_read(
        &self,
        buffer_id: BufferId,
        through: MessageId,
    ) -> Option<ReadAdvance> {
        let buffer = self.buffers.get(&buffer_id)?;
        read_advance(buffer_id, buffer, through, false)
    }

    pub(crate) fn request_mark_all_read(&self) -> Vec<ReadAdvance> {
        let targets = self
            .buffer_order
            .iter()
            .filter_map(|id| {
                let buffer = self.buffers.get(id)?;
                let through = buffer
                    .timeline
                    .iter()
                    .rev()
                    .filter_map(chat_projection)
                    .find(|message| is_committed(message))?
                    .id;
                Some((*id, through))
            })
            .collect::<Vec<_>>();
        targets
            .into_iter()
            .filter_map(|(buffer_id, through)| self.request_mark_read(buffer_id, through))
            .collect()
    }

    pub(crate) fn advance_read(
        &mut self,
        buffer_id: BufferId,
        time: SystemTime,
        server_backed: bool,
    ) -> Vec<EngineToUi> {
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return inconsistent_state_notice();
        };
        let previous_mark = buffer.read_facts.mark();
        buffer
            .read_facts
            .merge_mark(ServerTimeMs::new(time_millis(time)));
        if server_backed && let Some(mark) = buffer.read_facts.mark() {
            buffer.read_facts.merge_pending(mark);
        }
        if buffer.read_facts.mark() == previous_mark {
            return Vec::new();
        }
        derive_read_projection(buffer);
        vec![EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        }]
    }

    #[cfg(test)]
    pub(crate) fn apply_server_read_marker(
        &mut self,
        conversation: &papo::Conversation,
        read_until: Option<SystemTime>,
    ) -> Vec<EngineToUi> {
        self.apply_server_read_marker_with_advance(conversation, read_until)
            .0
    }

    pub(crate) fn apply_server_read_marker_with_advance(
        &mut self,
        conversation: &papo::Conversation,
        read_until: Option<SystemTime>,
    ) -> (Vec<EngineToUi>, Option<ReadAdvance>) {
        let Some(time) = read_until else {
            return (Vec::new(), None);
        };
        let Some(key) = NameKey::from_conversation(conversation) else {
            return (Vec::new(), None);
        };
        let Some(buffer_id) = self.names.get(&key).copied() else {
            return (Vec::new(), None);
        };
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return (inconsistent_state_notice(), None);
        };
        let reported = ServerTimeMs::new(time_millis(time));
        let previous_mark = buffer.read_facts.mark();
        let base = previous_mark.map_or(reported, |mark| mark.max(reported));
        buffer.read_facts.acknowledge(reported);
        let carried = buffer.read_facts.mark();
        let advance = carried.filter(|mark| *mark > base).map(|mark| ReadAdvance {
            buffer_id,
            time: system_time_from_millis(mark.value()),
        });
        if buffer.read_facts.mark() == previous_mark {
            return (Vec::new(), advance);
        }
        derive_read_projection(buffer);
        (
            vec![EngineToUi::BufferUpdated {
                buffer: buffer.projection.clone(),
            }],
            advance,
        )
    }

    pub(crate) fn pending_read_advances(&self) -> Vec<ReadAdvance> {
        self.buffer_order
            .iter()
            .filter_map(|buffer_id| {
                let pending = self.buffers.get(buffer_id)?.read_facts.pending()?;
                Some(ReadAdvance {
                    buffer_id: *buffer_id,
                    time: system_time_from_millis(pending.value()),
                })
            })
            .collect()
    }

    pub(crate) fn clear_pending_reads(&mut self) {
        for buffer in self.buffers.values_mut() {
            buffer.read_facts.clear_pending();
        }
    }

    pub(crate) fn read_target(
        &self,
        buffer_id: BufferId,
        state: &papo::State,
    ) -> Option<HistoryTarget> {
        let buffer = self.buffers.get(&buffer_id)?;
        let rules = state.name_rules()?;
        match buffer.projection.kind {
            BufferKind::Channel => Some(HistoryTarget::Channel(
                rules.channel(buffer.projection.title.clone()),
            )),
            BufferKind::Direct => Some(HistoryTarget::Direct(
                rules.nick(buffer.projection.title.clone()),
            )),
            BufferKind::Server => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn buffer_id_for_target(&self, target: &SendTarget) -> Option<BufferId> {
        let key = target.name_key();
        self.names.get(&key).copied()
    }

    #[cfg(test)]
    fn receive_incoming(&mut self, incoming: Incoming, state: &papo::State) -> Vec<EngineToUi> {
        let received = self.receive_incoming_result(incoming, state);
        let mut events = received.events;
        if let Some(advance) = received.carry_read {
            events.extend(self.advance_read(advance.buffer_id, advance.time, false));
        }
        events
    }

    fn receive_incoming_result(
        &mut self,
        incoming: Incoming,
        state: &papo::State,
    ) -> IncomingResult {
        if let Some(received) = self.reconcile_pushed_message(&incoming, state) {
            return received;
        }
        if let Some(received) = self.reconcile_late_pushed_message(&incoming) {
            return received;
        }
        if let Some((events, buffer_id, message_id)) =
            self.reconcile_failed_own_message(&incoming, state)
        {
            return IncomingResult {
                events,
                carry_read: None,
                message: Some((buffer_id, message_id)),
            };
        }
        let Some(dedup) = self.deduplicate_incoming(&incoming) else {
            return IncomingResult::default();
        };

        let (buffer_id, initially_added) = match &incoming.destination {
            IncomingDestination::Conversation(conversation) => self.ensure_buffer(
                conversation.clone(),
                incoming.direct_key.clone(),
                incoming.direct.clone(),
            ),
            IncomingDestination::Server => (self.server_buffer_id(), None),
        };
        let verified_sender = incoming
            .peer_key
            .as_ref()
            .is_some_and(|current| self.apply_direct_peer_key(buffer_id, current.clone()));
        let added = initially_added
            .map(|_| self.buffers[&buffer_id].projection.clone())
            .or_else(|| {
                (incoming.authorship != MessageAuthorship::Own)
                    .then(|| self.reveal_buffer(buffer_id))
                    .flatten()
            });
        let cursor = incoming
            .server_time_ms
            .map(|server_time| HistoryCursor::new(incoming.msgid.clone(), server_time));
        let message_id = self.allocate_message_id();
        for msgid in &dedup.msgids {
            self.reactions.mark_loaded(msgid);
            if let Some(reference) = self.msgids.get_mut(msgid) {
                reference.location = Some((buffer_id, message_id));
            }
        }
        let message = self.project_incoming(message_id, &incoming, state, verified_sender, false);
        let Ok(order_changed) = self.insert(buffer_id, message.clone(), None, dedup) else {
            return IncomingResult {
                events: inconsistent_state_notice(),
                carry_read: None,
                message: None,
            };
        };
        if let Some(provisional_identity) = incoming.provisional_identity.clone()
            && let Some(buffer) = self.buffers.get_mut(&buffer_id)
            && let Some(metadata) = buffer.chat_metadata.get_mut(&message.id)
        {
            metadata.provisional_identity = Some(provisional_identity);
        }
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            advance_incoming_cursor(buffer, &incoming, cursor);
        }
        let added = {
            let Some(buffer) = self.buffers.get(&buffer_id) else {
                return IncomingResult {
                    events: inconsistent_state_notice(),
                    carry_read: None,
                    message: None,
                };
            };
            added.map(|_| buffer.projection.clone())
        };
        let mut events = Vec::new();
        let buffer_added = added.is_some();
        if let Some(buffer) = added {
            events.push(EngineToUi::BufferAdded { buffer });
        }
        if buffer_added || order_changed {
            events.push(self.buffers_event());
        }
        events.push(EngineToUi::BufferUpdated {
            buffer: self.buffers[&buffer_id].projection.clone(),
        });
        if let Some(account) = incoming.legacy_account_key {
            events.push(self.legacy_draft_migration(buffer_id, &account));
        }
        IncomingResult {
            events,
            carry_read: None,
            message: Some((buffer_id, message_id)),
        }
    }

    fn reconcile_failed_own_message(
        &mut self,
        incoming: &Incoming,
        state: &papo::State,
    ) -> Option<(Vec<EngineToUi>, BufferId, MessageId)> {
        if incoming.authorship != MessageAuthorship::Own || incoming.origin == TimelineOrigin::Push
        {
            return None;
        }
        let buffer_id = self
            .names
            .get(incoming.destination.conversation()?)
            .copied()?;
        let text = collapse_blank_lines(incoming.text.clone());
        let (index, message_id, local_send_id) = self.buffers[&buffer_id]
            .timeline
            .iter()
            .enumerate()
            .find_map(|(index, record)| {
                let message = chat_projection(record)?;
                if message.delivery == MessageDelivery::Failed
                    && message.authorship == MessageAuthorship::Own
                    && message.kind == incoming.kind
                    && message.text == text
                    && message
                        .local_send_id
                        .is_some_and(|id| self.reconcilable_failed_sends.contains(&id))
                {
                    Some((index, message.id, message.local_send_id?))
                } else {
                    None
                }
            })?;
        let dedup = self.deduplicate_incoming(incoming)?;
        self.reconcilable_failed_sends.remove(&local_send_id);
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let removed = buffer.timeline.remove(index);
        buffer.chat_metadata.remove(&removed.id);
        for msgid in &dedup.msgids {
            self.reactions.mark_loaded(msgid);
            if let Some(reference) = self.msgids.get_mut(msgid) {
                reference.location = Some((buffer_id, message_id));
            }
        }
        let verified_sender = incoming
            .peer_key
            .as_ref()
            .is_some_and(|current| self.apply_direct_peer_key(buffer_id, current.clone()));
        let mut message =
            self.project_incoming(message_id, incoming, state, verified_sender, false);
        message.delivery = MessageDelivery::Confirmed;
        let order_changed = self.insert(buffer_id, message.clone(), None, dedup).ok()?;
        let cursor = incoming
            .server_time_ms
            .map(|server_time| HistoryCursor::new(incoming.msgid.clone(), server_time));
        let buffer = self.buffers.get_mut(&buffer_id)?;
        advance_incoming_cursor(buffer, incoming, cursor);
        let mut events = vec![EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        }];
        if order_changed {
            events.push(self.buffers_event());
        }
        Some((events, buffer_id, message_id))
    }

    fn reconcile_pushed_message(
        &mut self,
        incoming: &Incoming,
        state: &papo::State,
    ) -> Option<IncomingResult> {
        if incoming.origin == TimelineOrigin::Push {
            return None;
        }
        let msgid = incoming.msgid.as_deref()?;
        let (buffer_id, message_id, provisional) =
            self.buffers.iter().find_map(|(id, buffer)| {
                buffer.timeline.iter().find_map(|record| {
                    let message = chat_projection(record)?;
                    (message.server_ids.iter().any(|current| current == msgid))
                        .then(|| {
                            Some((
                                *id,
                                message.id,
                                buffer
                                    .chat_metadata
                                    .get(&record.id)?
                                    .provisional_identity
                                    .clone()?,
                            ))
                        })
                        .flatten()
                })
            })?;
        let verified_sender = incoming
            .peer_key
            .as_ref()
            .is_some_and(|current| self.apply_direct_peer_key(buffer_id, current.clone()));
        let identity_disagrees = provisional.author_key != self.casemapping.fold(&incoming.author)
            || provisional
                .account_key
                .as_ref()
                .zip(incoming.legacy_account_key.as_ref())
                .is_some_and(|(pushed, authoritative)| pushed != authoritative);
        let mut message = self.project_incoming(
            message_id,
            incoming,
            state,
            verified_sender,
            identity_disagrees,
        );
        message.server_ids = vec![msgid.to_owned()];
        let authoritative_time = message_time(&message);
        let carry_read = {
            let buffer = self.buffers.get_mut(&buffer_id)?;
            let record = buffer
                .timeline
                .iter_mut()
                .find(|record| record.id == message_id)?;
            let pushed_time = ServerTimeMs::new(message_time(chat_projection(record)?));
            let previous_mark = buffer.read_facts.mark();
            record.order = message_order(&message, record.order.2);
            chat_projection_mut(record)?.clone_from(&message);
            let counts_as_mention = message.authorship != MessageAuthorship::Own
                && (buffer.projection.kind == BufferKind::Direct || message.highlighted);
            let metadata = buffer.chat_metadata.get_mut(&message_id)?;
            metadata.counts_as_mention = counts_as_mention;
            metadata.provisional_identity = None;
            buffer.read_facts.replace_stub(MessageStub {
                msgid: msgid.to_owned(),
                time: ServerTimeMs::new(message_time(&message)),
                provisional_time: Some(pushed_time),
                mention: counts_as_mention,
            });
            let carry_read = buffer.read_facts.mark() > previous_mark;
            buffer.timeline.sort_by_key(|record| record.order);
            derive_read_projection(buffer);
            carry_read
        };
        self.dirty_timelines.insert(buffer_id);
        let mut events = vec![EngineToUi::BufferUpdated {
            buffer: self.buffers[&buffer_id].projection.clone(),
        }];
        if let Some(account) = &incoming.legacy_account_key {
            events.push(self.legacy_draft_migration(buffer_id, account));
        }
        let carry_read = carry_read.then_some(ReadAdvance {
            buffer_id,
            time: system_time_from_millis(authoritative_time),
        });
        Some(IncomingResult {
            events,
            carry_read,
            message: Some((buffer_id, message_id)),
        })
    }

    fn reconcile_late_pushed_message(&mut self, incoming: &Incoming) -> Option<IncomingResult> {
        if incoming.origin != TimelineOrigin::Push {
            return None;
        }
        let msgid = incoming.msgid.as_deref()?;
        let (buffer_id, message_id) = self.msgids.get(msgid)?.location?;
        let pushed_time = ServerTimeMs::new(incoming.server_time_ms?);
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let record = buffer
            .timeline
            .iter()
            .find(|record| record.id == message_id)?;
        let authoritative_time = message_time(chat_projection(record)?);
        let metadata = buffer.chat_metadata.get(&message_id)?;
        if metadata.provisional_identity.is_some() {
            return Some(IncomingResult::default());
        }
        let counts_as_mention = metadata.counts_as_mention;
        let previous_mark = buffer.read_facts.mark();
        buffer.read_facts.merge_stub(MessageStub {
            msgid: msgid.to_owned(),
            time: ServerTimeMs::new(authoritative_time),
            provisional_time: Some(pushed_time),
            mention: counts_as_mention,
        });
        let carry_read = (buffer.read_facts.mark() > previous_mark).then_some(ReadAdvance {
            buffer_id,
            time: system_time_from_millis(authoritative_time),
        });
        Some(IncomingResult {
            events: Vec::new(),
            carry_read,
            message: None,
        })
    }

    fn project_incoming(
        &self,
        id: MessageId,
        incoming: &Incoming,
        state: &papo::State,
        verified_sender: bool,
        identity_disagrees: bool,
    ) -> MessageProjection {
        MessageProjection {
            id,
            author: incoming.author.clone(),
            text: collapse_blank_lines(incoming.text.clone()),
            kind: incoming.kind.clone(),
            bot: incoming.bot,
            authorship: incoming.authorship,
            nick_color_index: nick_color_index(state.casemapping(), &incoming.author),
            highlighted: incoming.authorship != MessageAuthorship::Own
                && matches_highlight_rules(&incoming.text, state),
            unverified_sender: (incoming.direct_key.is_some()
                && incoming.authorship != MessageAuthorship::Own
                && incoming.provisional_identity.is_none()
                && (!verified_sender || identity_disagrees))
                .then_some(true),
            reactions: incoming
                .msgid
                .as_deref()
                .map(|msgid| self.reactions.summaries(msgid))
                .and_then(nonempty_reactions),
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: incoming.msgid.clone().into_iter().collect(),
            server_time_ms: incoming.server_time_ms,
            received_at_ms: incoming.received_at_ms,
        }
    }

    fn deduplicate_incoming(&mut self, incoming: &Incoming) -> Option<DedupReferences> {
        if let Some(msgid) = &incoming.msgid {
            if self.msgids.contains_key(msgid) {
                return None;
            }
            self.msgids.insert(
                msgid.clone(),
                MsgidReference {
                    count: 1,
                    location: None,
                },
            );
            return Some(DedupReferences {
                msgids: vec![msgid.clone()],
                fallback: None,
            });
        }
        let fingerprint = FallbackKey {
            destination: incoming.destination.clone(),
            server_time_ms: incoming.server_time_ms,
            actor: incoming.author.clone(),
            text: incoming.text.clone(),
        };
        if let Some((previous, count)) = self.fallbacks.get_mut(&fingerprint) {
            if *previous != incoming.origin {
                return None;
            }
            *count += 1;
        } else {
            self.fallbacks
                .insert(fingerprint.clone(), (incoming.origin, 1));
        }
        Some(DedupReferences {
            msgids: Vec::new(),
            fallback: Some(fingerprint),
        })
    }

    fn ensure_buffer(
        &mut self,
        key: NameKey,
        direct_key: Option<DirectKey>,
        direct: Option<DirectAvailability>,
    ) -> (BufferId, Option<BufferProjection>) {
        let direct_id = direct_key
            .as_ref()
            .and_then(|direct_key| self.directs.get(direct_key).copied());
        if let Some(id) = direct_id.or_else(|| self.names.get(&key).copied()) {
            if let Some(buffer) = self.buffers.get_mut(&id) {
                buffer.projection.available = None;
            }
            if matches!(key, NameKey::Direct(_)) {
                self.names.insert(key.clone(), id);
                self.update_direct_name(id, key);
                if let Some(direct_key) = direct_key {
                    self.set_direct_key(id, &direct_key);
                }
            }
            if let Some(direct) = direct
                && let Some(buffer) = self.buffers.get_mut(&id)
            {
                buffer.direct = Some(direct);
            }
            return (id, None);
        }
        let kind = match key {
            NameKey::Channel(_) => BufferKind::Channel,
            NameKey::Direct(_) => BufferKind::Direct,
        };
        let projection = self.add_buffer(key, kind, direct_key, direct, None);
        (projection.id, Some(projection))
    }

    fn reveal_buffer(&mut self, buffer_id: BufferId) -> Option<BufferProjection> {
        if self.buffer_order.contains(&buffer_id) {
            return None;
        }
        let projection = self.buffers.get(&buffer_id)?.projection.clone();
        self.buffer_order.push(buffer_id);
        Some(projection)
    }

    fn add_buffer(
        &mut self,
        key: NameKey,
        kind: BufferKind,
        direct_key: Option<DirectKey>,
        direct: Option<DirectAvailability>,
        topic: Option<String>,
    ) -> BufferProjection {
        let id = BufferId(self.next_buffer_id);
        self.next_buffer_id += 1;
        let seed_mark_ms = self.seed_mark_ms();
        let direct_key = match (&key, direct_key) {
            (NameKey::Direct(nick), None) => Some(DirectKey::from_nick(nick)),
            (_, direct_key) => direct_key,
        };
        let projected_draft_key = direct_key.as_ref().map_or_else(
            || draft_key(&self.network.label, &key.title(), self.casemapping),
            |direct_key| direct_draft_key(&self.network.label, direct_key, self.casemapping),
        );
        let projection = BufferProjection {
            id,
            network_id: self.network.id,
            kind,
            sync_state: BufferSyncState::Pending,
            channel_status: (kind == BufferKind::Channel).then_some(ChannelStatus::Joined),
            available: None,
            title: key.title(),
            nick_color_index: (kind == BufferKind::Direct)
                .then(|| nick_color_index(self.casemapping, &key.title())),
            direct_identity: (kind == BufferKind::Direct)
                .then_some(DirectIdentityState::Unverified),
            draft_key: projected_draft_key,
            topic,
            member_count: (kind == BufferKind::Channel).then_some(0),
            unread: 0,
            mentions: 0,
            read_at_ms: seed_mark_ms,
            last_message: None,
            last_activity_ms: None,
            preview: None,
        };
        let mut read_facts = ReadFacts::default();
        if let Some(seed_mark_ms) = seed_mark_ms {
            read_facts.merge_mark(ServerTimeMs::new(seed_mark_ms));
        }
        self.buffers.insert(
            id,
            BufferState {
                projection: projection.clone(),
                restored_from_snapshot: false,
                provisional_activity_ms: None,
                provisional_preview: None,
                key: Some(key.clone()),
                direct_key: direct_key.clone(),
                timeline: Vec::new(),
                chat_metadata: HashMap::new(),
                system_server_times: HashMap::new(),
                system_dedup: HashMap::new(),
                emitted_timeline: Vec::new(),
                direct: (kind == BufferKind::Direct)
                    .then(|| direct.unwrap_or(DirectAvailability::Pending)),
                direct_pin: None,
                direct_mismatch: None,
                read_facts,
                history: HistoryState::Unrequested,
                newest: None,
                pushed_history_pending: false,
                pushed_history_retry_available: false,
            },
        );
        if let Some(direct_key) = direct_key {
            self.directs.insert(direct_key, id);
        }
        self.names.insert(key, id);
        self.buffer_order.push(id);
        self.sort_buffer_order();
        projection
    }

    fn set_direct_key(&mut self, buffer_id: BufferId, direct_key: &DirectKey) {
        self.directs.retain(|_, id| *id != buffer_id);
        self.directs.insert(direct_key.clone(), buffer_id);
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            buffer.direct_key = Some(direct_key.clone());
            buffer.projection.draft_key =
                direct_draft_key(&self.network.label, direct_key, self.casemapping);
        }
    }

    fn legacy_draft_migration(&self, buffer_id: BufferId, account_key: &str) -> EngineToUi {
        EngineToUi::DraftKeyChanged {
            previous: draft_key(
                &self.network.label,
                &format!("account={account_key}"),
                self.casemapping,
            ),
            current: self.buffers[&buffer_id].projection.draft_key.clone(),
        }
    }

    fn update_direct_name(&mut self, buffer_id: BufferId, key: NameKey) {
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return;
        };
        buffer.projection.title = key.title();
        buffer.projection.nick_color_index =
            Some(nick_color_index(self.casemapping, &buffer.projection.title));
        buffer.key = Some(key);
    }

    fn sort_buffer_order(&mut self) -> bool {
        let previous = self.buffer_order.clone();
        let buffers = &self.buffers;
        let casemapping = self.casemapping;
        self.buffer_order.sort_by(|first, second| {
            match (buffers.get(first), buffers.get(second)) {
                (Some(first), Some(second)) => compare_buffers(first, second, casemapping),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            }
        });
        self.buffer_order != previous
    }

    fn allocate_message_id(&mut self) -> MessageId {
        let id = MessageId(self.next_message_id);
        self.next_message_id += 1;
        id
    }

    fn allocate_order(&mut self, server_time_ms: Option<i64>, received_at_ms: i64) -> OrderKey {
        let order = OrderKey::new(
            server_time_ms.unwrap_or(received_at_ms),
            received_at_ms,
            self.next_sequence,
        );
        self.next_sequence += 1;
        order
    }

    fn insert(
        &mut self,
        buffer_id: BufferId,
        projection: MessageProjection,
        send_text: Option<String>,
        dedup: DedupReferences,
    ) -> Result<bool, StateError> {
        let Some(buffer) = self.buffers.get(&buffer_id) else {
            self.release_dedup(dedup);
            return Err(StateError::MissingBuffer(buffer_id));
        };
        let counts_as_mention = projection.authorship != MessageAuthorship::Own
            && (buffer.projection.kind == BufferKind::Direct || projection.highlighted);
        let stub = (buffer.projection.kind != BufferKind::Server)
            .then(|| message_stub(&projection, counts_as_mention))
            .flatten();
        let id = projection.id;
        let order =
            self.allocate_order(message_primary_time(&projection), projection.received_at_ms);
        let record = TimelineRecord {
            id,
            order,
            day: self.calendar.day(order.primary_ms()),
            body: RecordBody::Chat(ChatRecord { projection }),
        };
        let metadata = ChatMetadata {
            counts_as_mention,
            send_text,
            dedup,
            provisional_identity: None,
        };
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return Err(StateError::MissingBuffer(buffer_id));
        };
        buffer.timeline.push(record);
        buffer.timeline.sort_by_key(|record| record.order);
        buffer.chat_metadata.insert(id, metadata);
        self.dirty_timelines.insert(buffer_id);
        if let Some(stub) = stub {
            buffer.read_facts.merge_stub(stub);
        }
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            derive_read_projection(buffer);
        }
        Ok(self.sort_buffer_order())
    }

    pub(crate) fn take_timeline_changes(&mut self, reset: bool) -> Vec<EngineToUi> {
        let mut buffer_ids = if reset {
            self.buffer_order.clone()
        } else {
            self.dirty_timelines.drain().collect::<Vec<_>>()
        };
        buffer_ids.sort_unstable_by_key(|id| id.0);
        let mut output = Vec::new();
        let mut released = Vec::new();
        let mut released_system = Vec::new();
        for buffer_id in buffer_ids {
            let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
                continue;
            };
            let Ok(desired) = project_timeline(buffer, self.casemapping) else {
                output.push(EngineToUi::error_notice(
                    EngineMessageKey::StateInconsistent,
                ));
                continue;
            };
            let Ok(timeline_diff) = diff(&buffer.emitted_timeline, &desired) else {
                output.push(EngineToUi::error_notice(
                    EngineMessageKey::StateInconsistent,
                ));
                continue;
            };
            let mut change = timeline_diff.change;
            if reset {
                change.reset = true;
                change.upserted.clone_from(&timeline_diff.items);
                change.removed.clear();
            }
            buffer.emitted_timeline = timeline_diff.items;
            if reset || !change.upserted.is_empty() || !change.removed.is_empty() {
                output.push(EngineToUi::TimelineChanged {
                    buffer_id,
                    reset: change.reset,
                    upserted: change.upserted,
                    removed: change.removed,
                });
            }
            let (dedup, system_dedup, evicted) = evict_over_budget(buffer, self.window_limit);
            buffer
                .emitted_timeline
                .retain(|item| !evicted.contains(&item.id));
            released.extend(dedup);
            released_system.extend(system_dedup);
        }
        for dedup in released {
            self.release_dedup(dedup);
        }
        for key in released_system {
            self.system_dedup.remove(&key);
        }
        output
    }

    fn release_dedup(&mut self, dedup: DedupReferences) {
        for msgid in dedup.msgids {
            let remove = self.msgids.get_mut(&msgid).is_some_and(|reference| {
                reference.count -= 1;
                reference.count == 0
            });
            if remove {
                self.msgids.remove(&msgid);
                self.reactions.remove_target(&msgid);
            }
        }
        if let Some(fallback) = dedup.fallback {
            let remove = self.fallbacks.get_mut(&fallback).is_some_and(|(_, count)| {
                *count -= 1;
                *count == 0
            });
            if remove {
                self.fallbacks.remove(&fallback);
            }
        }
    }
}

fn begin_target_fetch(buffer: &mut BufferState, fetch: &HistoryFetch) {
    match fetch {
        HistoryFetch::Latest(_) => {
            set_history_state(buffer, HistoryState::LoadingLatest);
        }
        HistoryFetch::After { .. } => {
            let (oldest, at_start) = match &buffer.history {
                HistoryState::Ready { oldest, at_start } => (oldest.clone(), *at_start),
                HistoryState::Unrequested | HistoryState::QueuedLatest => (None, false),
                _ => unreachable!("after fetch starts from idle history"),
            };
            set_history_state(buffer, HistoryState::Refreshing { oldest, at_start });
        }
        HistoryFetch::Before { .. } => {}
    }
}

fn begin_pushed_history(buffer: &mut BufferState, target: HistoryTarget) -> Option<HistoryFetch> {
    let (next, fetch) = match &buffer.history {
        HistoryState::Unrequested | HistoryState::QueuedLatest | HistoryState::RefreshCapped => {
            (HistoryState::LoadingLatest, HistoryFetch::Latest(target))
        }
        HistoryState::Ready { oldest, at_start } => match buffer.newest.clone() {
            Some(newest) => (
                HistoryState::Refreshing {
                    oldest: oldest.clone(),
                    at_start: *at_start,
                },
                HistoryFetch::After { target, newest },
            ),
            None => (HistoryState::LoadingLatest, HistoryFetch::Latest(target)),
        },
        HistoryState::LoadingLatest
        | HistoryState::LoadingOlder { .. }
        | HistoryState::Refreshing { .. } => return None,
    };
    set_history_state(buffer, next);
    Some(fetch)
}

fn advance_incoming_cursor(
    buffer: &mut BufferState,
    incoming: &Incoming,
    cursor: Option<HistoryCursor>,
) {
    if incoming.origin == TimelineOrigin::Push {
        return;
    }
    if incoming.origin == TimelineOrigin::History
        && matches!(buffer.history, HistoryState::LoadingOlder { .. })
    {
        return;
    }
    if matches!(buffer.history, HistoryState::Unrequested)
        && matches!(
            incoming.destination,
            IncomingDestination::Conversation(NameKey::Direct(_))
        )
        && incoming.origin == TimelineOrigin::Live
        && let Some(cursor) = cursor
    {
        set_history_state(
            buffer,
            HistoryState::Ready {
                oldest: Some(cursor.reference()),
                at_start: false,
            },
        );
        buffer.newest = Some(cursor);
        return;
    }
    advance_cursor(buffer, cursor);
}

fn advance_cursor(buffer: &mut BufferState, cursor: Option<HistoryCursor>) {
    let Some(cursor) = cursor else {
        return;
    };
    if buffer
        .newest
        .as_ref()
        .is_none_or(|current| cursor.server_time >= current.server_time)
    {
        buffer.newest = Some(cursor);
    }
}

fn cached_refresh_cursor(buffer: &BufferState) -> Option<HistoryCursor> {
    buffer
        .read_facts
        .mark()
        .map(|mark| HistoryCursor::new(None, mark.value()))
        .or_else(|| buffer.newest.clone())
}

fn snapshot_row(buffer: &BufferState) -> Option<SnapshotRow> {
    let conversation = snapshot_conversation(buffer)?;
    Some(SnapshotRow {
        conversation,
        title: buffer.projection.title.clone(),
        last_activity_ms: chat_activity_time(buffer),
        preview: buffer.projection.preview.clone(),
        newest: buffer.newest.as_ref().map(HistoryCursor::snapshot),
        read_at_ms: buffer.read_facts.mark().map(ServerTimeMs::value),
        raw_read_at_ms: buffer.read_facts.raw_mark().map(ServerTimeMs::value),
        pending_read_at_ms: buffer.read_facts.pending().map(ServerTimeMs::value),
        stubs: buffer.read_facts.stubs().to_vec(),
        gap_until: buffer.read_facts.gap_until(),
        peer_pin: buffer
            .direct_pin
            .as_ref()
            .and_then(papo::PeerKey::as_verified_str)
            .map(str::to_owned),
    })
}

fn copy_read_facts_to_snapshot(buffer: &BufferState, row: &mut SnapshotRow) {
    row.read_at_ms = buffer.read_facts.mark().map(ServerTimeMs::value);
    row.raw_read_at_ms = buffer.read_facts.raw_mark().map(ServerTimeMs::value);
    row.pending_read_at_ms = buffer.read_facts.pending().map(ServerTimeMs::value);
    row.stubs = buffer.read_facts.stubs().to_vec();
    row.gap_until = buffer.read_facts.gap_until();
}

fn snapshot_conversation(buffer: &BufferState) -> Option<SnapshotConversation> {
    Some(match buffer.key.as_ref()? {
        NameKey::Channel(channel) => SnapshotConversation::Channel {
            key: channel.key().to_owned(),
        },
        NameKey::Direct(nick) => SnapshotConversation::Direct {
            key: nick.key().to_owned(),
        },
    })
}

fn snapshot_preview(buffer: &BufferProjection, message: &MessageProjection) -> String {
    let text = truncate_preview(&message.text);
    if buffer.kind == BufferKind::Direct && message.authorship == MessageAuthorship::Own {
        return format!("You: {text}");
    }
    if buffer.kind == BufferKind::Direct && message.author == buffer.title {
        return if message.kind == MessageKind::Action {
            format!("* {text}")
        } else {
            text
        };
    }
    if message.kind == MessageKind::Action {
        format!("* {} {text}", message.author)
    } else {
        format!("{}: {text}", message.author)
    }
}

fn collapse_blank_lines(text: String) -> String {
    if !text.contains("\n\n\n") {
        return text;
    }
    let mut collapsed = String::with_capacity(text.len());
    let mut newlines = 0;
    for character in text.chars() {
        if character == '\n' {
            newlines += 1;
            if newlines <= 2 {
                collapsed.push(character);
            }
        } else {
            newlines = 0;
            collapsed.push(character);
        }
    }
    collapsed
}

fn confirmed_text(kind: &MessageKind, text: &str) -> String {
    if kind != &MessageKind::Action {
        return text.to_owned();
    }
    let Some(action) =
        papo_proto::Ctcp::parse(text).filter(|ctcp| ctcp.command.eq_ignore_ascii_case("ACTION"))
    else {
        return text.to_owned();
    };
    action.params.unwrap_or_default().to_owned()
}

fn derive_read_projection(buffer: &mut BufferState) {
    let mark = buffer.read_facts.mark().map(ServerTimeMs::value);
    buffer.projection.read_at_ms = mark;
    derive_chat_projection(buffer);
    let unread = unread_count(&buffer.read_facts);
    buffer.projection.unread = if has_unread_gap(&buffer.read_facts) {
        u64::try_from(unread.max(100)).unwrap_or(u64::MAX)
    } else {
        u64::try_from(unread).unwrap_or(u64::MAX)
    };
    buffer.projection.mentions =
        u64::try_from(mention_count(&buffer.read_facts, false)).unwrap_or(u64::MAX);
}

fn message_stub(message: &MessageProjection, mention: bool) -> Option<MessageStub> {
    (message.authorship != MessageAuthorship::Own && is_committed(message)).then(|| MessageStub {
        msgid: message
            .server_ids
            .first()
            .cloned()
            .unwrap_or_else(|| format!("local:{}", message.id.0)),
        time: ServerTimeMs::new(message_time(message)),
        provisional_time: None,
        mention,
    })
}

fn chat_projection(record: &TimelineRecord) -> Option<&MessageProjection> {
    match &record.body {
        RecordBody::Chat(chat) => Some(&chat.projection),
        RecordBody::Fold(_) | RecordBody::Line(_) | RecordBody::Gap(_) => None,
    }
}

fn chat_projection_mut(record: &mut TimelineRecord) -> Option<&mut MessageProjection> {
    match &mut record.body {
        RecordBody::Chat(chat) => Some(&mut chat.projection),
        RecordBody::Fold(_) | RecordBody::Line(_) | RecordBody::Gap(_) => None,
    }
}

fn person(casemapping: papo::Casemapping, nick: String, me: bool) -> Person {
    Person {
        nick_color_index: nick_color_index(casemapping, &nick),
        nick,
        me,
    }
}

fn project_timeline(
    buffer: &BufferState,
    casemapping: papo::Casemapping,
) -> Result<Vec<TimelineItem>, crate::timeline::TimelineError> {
    fold(&buffer.timeline).map(|items| {
        items
            .into_iter()
            .filter_map(|item| {
                let body = match item.body {
                    FoldedBody::Chat(chat) => ItemBody::Message(chat.projection),
                    FoldedBody::Run(run) => {
                        let mut clauses = run.events().map(|event| fold_clause(event, casemapping));
                        let first = clauses.next()?;
                        ItemBody::System(SystemProjection {
                            time_ms: item.order.primary_ms(),
                            line: SystemLine::Run {
                                clauses: RunClauses::new(first, clauses.collect()),
                            },
                        })
                    }
                    FoldedBody::Line(event) => ItemBody::System(SystemProjection {
                        time_ms: item.order.primary_ms(),
                        line: SystemLine::Event { event },
                    }),
                    FoldedBody::Gap(gap) => ItemBody::Gap(gap),
                };
                Some(TimelineItem {
                    id: item.id,
                    order: item.order,
                    day: item.day,
                    content_version: 0,
                    body,
                })
            })
            .collect()
    })
}

fn fold_clause(event: &FoldEvent, casemapping: papo::Casemapping) -> RunClause {
    let who = |who: &crate::timeline::Who| person(casemapping, who.nick.clone(), who.own);
    match event {
        FoldEvent::Joined(joined) => RunClause::Joined {
            people: vec![who(joined)],
        },
        FoldEvent::Parted(parted, reason) => RunClause::Left {
            people: vec![crate::timeline::Departure {
                person: who(parted),
                reason: reason.clone(),
            }],
        },
        FoldEvent::Quit(quit, reason, _) => RunClause::Quit {
            people: vec![crate::timeline::Departure {
                person: who(quit),
                reason: reason.clone(),
            }],
        },
        FoldEvent::Nick { old, new } => RunClause::Nick {
            changes: vec![crate::timeline::NickChange {
                old: who(old),
                new: who(new),
            }],
        },
        FoldEvent::Modes { actor, changes } => RunClause::Modes {
            actor: actor.clone(),
            changes: changes.clone(),
        },
        FoldEvent::Invited { actor, subject } => RunClause::Invited {
            actor: actor.clone(),
            people: vec![who(subject)],
        },
    }
}

fn evict_over_budget(
    buffer: &mut BufferState,
    limit: usize,
) -> (
    Vec<DedupReferences>,
    Vec<SystemDedupReference>,
    HashSet<MessageId>,
) {
    let Ok(items) = fold(&buffer.timeline) else {
        return (Vec::new(), Vec::new(), HashSet::new());
    };
    let chat_excess = items
        .iter()
        .filter(|item| matches!(item.body, FoldedBody::Chat(_)))
        .count()
        .saturating_sub(limit);
    let system_excess = items
        .iter()
        .filter(|item| !matches!(item.body, FoldedBody::Chat(_)))
        .count()
        .saturating_sub(limit);
    let mut chats_left = chat_excess;
    let mut systems_left = system_excess;
    let mut evicted_items = HashSet::new();
    let mut evicted_records = HashSet::new();
    for item in items {
        let chat = matches!(item.body, FoldedBody::Chat(_));
        let evict = if chat && chats_left > 0 {
            chats_left -= 1;
            true
        } else if !chat && systems_left > 0 {
            systems_left -= 1;
            true
        } else {
            false
        };
        if evict {
            evicted_items.insert(item.id);
            evicted_records.extend(item.record_ids().iter().copied());
        }
    }
    buffer
        .timeline
        .retain(|record| !evicted_records.contains(&record.id));
    let mut released = Vec::new();
    let mut system_dedup = Vec::new();
    for id in evicted_records {
        if let Some(metadata) = buffer.chat_metadata.remove(&id) {
            released.push(metadata.dedup);
        }
        buffer.system_server_times.remove(&id);
        if let Some(reference) = buffer.system_dedup.remove(&id) {
            system_dedup.push(reference);
        }
    }
    (released, system_dedup, evicted_items)
}

fn next_message_id_after_stub(msgid: &str) -> u64 {
    msgid
        .strip_prefix("local:")
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_add(1))
        .unwrap_or(1)
}

fn derive_chat_projection(buffer: &mut BufferState) {
    buffer.projection.last_message = latest_real_message(buffer).cloned();
    buffer.projection.preview = buffer
        .projection
        .last_message
        .as_ref()
        .map(|message| snapshot_preview(&buffer.projection, message))
        .or_else(|| buffer.provisional_preview.clone());
    buffer.projection.last_activity_ms = chat_activity_time(buffer);
}

fn latest_real_message(buffer: &BufferState) -> Option<&MessageProjection> {
    buffer
        .timeline
        .iter()
        .filter(|record| {
            chat_projection(record).is_some_and(|message| {
                is_committed(message) && !matches!(&message.kind, MessageKind::Notice(_))
            })
        })
        .max_by_key(|record| record.order)
        .and_then(chat_projection)
}

fn chat_activity_time(buffer: &BufferState) -> Option<i64> {
    if matches!(buffer.history, HistoryState::RefreshCapped) {
        return buffer
            .provisional_activity_ms
            .or_else(|| latest_real_message(buffer).map(message_time));
    }
    latest_real_message(buffer).map(message_time).or_else(|| {
        matches!(
            buffer.history,
            HistoryState::Unrequested | HistoryState::QueuedLatest | HistoryState::LoadingLatest
        )
        .then_some(buffer.provisional_activity_ms)
        .flatten()
    })
}

fn is_committed(message: &MessageProjection) -> bool {
    matches!(
        message.delivery,
        MessageDelivery::Received | MessageDelivery::Confirmed
    )
}

fn read_advance(
    buffer_id: BufferId,
    buffer: &BufferState,
    through: MessageId,
    allow_provisional: bool,
) -> Option<ReadAdvance> {
    let record = buffer.timeline.iter().find(|record| {
        chat_projection(record).is_some_and(|message| {
            message.id == through
                && is_committed(message)
                && (allow_provisional
                    || buffer
                        .chat_metadata
                        .get(&record.id)
                        .is_some_and(|metadata| metadata.provisional_identity.is_none()))
        })
    })?;
    let message = chat_projection(record)?;
    buffer.key.as_ref()?;
    Some(ReadAdvance {
        buffer_id,
        time: system_time_from_millis(message_time(message)),
    })
}

fn message_time(message: &MessageProjection) -> i64 {
    message.server_time_ms.unwrap_or(message.received_at_ms)
}

fn system_time_from_millis(milliseconds: i64) -> SystemTime {
    if milliseconds >= 0 {
        UNIX_EPOCH + Duration::from_millis(milliseconds.unsigned_abs())
    } else {
        UNIX_EPOCH - Duration::from_millis(milliseconds.unsigned_abs())
    }
}

fn inconsistent_state_notice() -> Vec<EngineToUi> {
    vec![EngineToUi::notice(EngineMessageKey::StateInconsistent)]
}

fn draft_key(network: &str, buffer: &str, casemapping: papo::Casemapping) -> String {
    let folded = casemapping.fold(buffer);
    format!(
        "{}:{network}:{}:{folded}",
        network.len(),
        casemapping.as_str()
    )
}

fn direct_draft_key(network: &str, direct: &DirectKey, casemapping: papo::Casemapping) -> String {
    draft_key(network, &direct.draft_name(), casemapping)
}

fn direct_identity(buffer: &BufferState) -> Option<DirectIdentityState> {
    if buffer.projection.kind != BufferKind::Direct {
        return None;
    }
    if let Some(mismatch) = &buffer.direct_mismatch {
        return Some(match (mismatch.reason, mismatch.deferred) {
            (papo::PeerKeyMismatch::DifferentAccount, false) => {
                DirectIdentityState::DifferentAccount
            }
            (papo::PeerKeyMismatch::CannotVerify, false) => DirectIdentityState::CannotVerify,
            (papo::PeerKeyMismatch::DifferentAccount, true) => {
                DirectIdentityState::DeferredDifferentAccount
            }
            (papo::PeerKeyMismatch::CannotVerify, true) => {
                DirectIdentityState::DeferredCannotVerify
            }
        });
    }
    Some(
        if buffer
            .direct_pin
            .as_ref()
            .is_some_and(papo::PeerKey::is_verified)
        {
            DirectIdentityState::Verified
        } else {
            DirectIdentityState::Unverified
        },
    )
}

#[derive(Clone, Debug)]
struct Incoming {
    destination: IncomingDestination,
    direct: Option<DirectAvailability>,
    direct_key: Option<DirectKey>,
    peer_key: Option<papo::PeerKey>,
    legacy_account_key: Option<String>,
    provisional_identity: Option<ProvisionalIdentity>,
    author: String,
    text: String,
    kind: MessageKind,
    bot: Option<bool>,
    authorship: MessageAuthorship,
    msgid: Option<String>,
    server_time_ms: Option<i64>,
    received_at_ms: i64,
    origin: TimelineOrigin,
}

#[derive(Default)]
struct IncomingResult {
    events: Vec<EngineToUi>,
    carry_read: Option<ReadAdvance>,
    message: Option<(BufferId, MessageId)>,
}

fn map_authorship(authorship: papo::Authorship) -> MessageAuthorship {
    match authorship {
        papo::Authorship::Own => MessageAuthorship::Own,
        papo::Authorship::Other => MessageAuthorship::Other,
        _ => MessageAuthorship::Unknown,
    }
}

fn reaction_actor_key(actor: &papo::UserSource) -> String {
    // History can omit an account tag that was present live. Existing facts retain the
    // nick-at-event across later nick changes; a subsequent reaction uses the new nick.
    format!("nick:{}", actor.nick().key())
}

fn nonempty_reactions(
    reactions: Vec<crate::ReactionProjection>,
) -> Option<Vec<crate::ReactionProjection>> {
    (!reactions.is_empty()).then_some(reactions)
}

fn matches_highlight_rules(text: &str, state: &papo::State) -> bool {
    text.split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .filter(|word| !word.is_empty())
        .any(|word| is_own_nick(state, word))
}

pub(crate) fn is_own_nick(state: &papo::State, nick: &str) -> bool {
    state.nick() == nick
}

fn compare_buffers(
    first: &BufferState,
    second: &BufferState,
    casemapping: papo::Casemapping,
) -> Ordering {
    let kind =
        buffer_kind_order(first.projection.kind).cmp(&buffer_kind_order(second.projection.kind));
    if kind != Ordering::Equal {
        return kind;
    }
    match first.projection.kind {
        BufferKind::Server => Ordering::Equal,
        BufferKind::Channel => {
            let first_title = first.projection.title.as_str();
            let second_title = second.projection.title.as_str();
            casemapping
                .fold(trim_channel_prefix(first_title))
                .cmp(&casemapping.fold(trim_channel_prefix(second_title)))
                .then_with(|| {
                    casemapping
                        .fold(first_title)
                        .cmp(&casemapping.fold(second_title))
                })
        }
        BufferKind::Direct => second
            .projection
            .last_activity_ms
            .cmp(&first.projection.last_activity_ms)
            .then_with(|| {
                casemapping
                    .fold(&first.projection.title)
                    .cmp(&casemapping.fold(&second.projection.title))
            }),
    }
}

const fn buffer_kind_order(kind: BufferKind) -> u8 {
    match kind {
        BufferKind::Server => 0,
        BufferKind::Channel => 1,
        BufferKind::Direct => 2,
    }
}

fn trim_channel_prefix(channel: &str) -> &str {
    channel
        .strip_prefix('#')
        .or_else(|| channel.strip_prefix('&'))
        .unwrap_or(channel)
}

pub(crate) fn nick_color_index(casemapping: papo::Casemapping, nick: &str) -> u32 {
    casemapping
        .fold(nick)
        .bytes()
        .fold(2_166_136_261, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
        })
}

fn message_primary_time(message: &MessageProjection) -> Option<i64> {
    (!matches!(&message.kind, MessageKind::Notice(_)))
        .then_some(message.server_time_ms)
        .flatten()
}

const fn membership_kind_name(kind: MembershipKind) -> &'static str {
    match kind {
        MembershipKind::Joined => "join",
        MembershipKind::Parted => "part",
        MembershipKind::Quit => "quit",
    }
}

fn system_dedup_reference(
    buffer_id: BufferId,
    msgid: Option<String>,
    server_time_ms: Option<i64>,
    kind: &'static str,
    nick: String,
    subject: Option<String>,
) -> Option<SystemDedupReference> {
    if let Some(msgid) = msgid {
        return Some(SystemDedupReference::Msgid(buffer_id, msgid));
    }
    Some(SystemDedupReference::Fallback {
        buffer_id,
        server_time_ms: server_time_ms?,
        kind,
        nick,
        subject,
    })
}

fn message_order(message: &MessageProjection, sequence: u64) -> OrderKey {
    OrderKey::new(
        message_primary_time(message).unwrap_or(message.received_at_ms),
        message.received_at_ms,
        sequence,
    )
}

pub(crate) fn time_millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use papo_testing::{MessageBuilder, StateBuilder, wire};

    use super::{
        DirectKey, HistoryCursor, HistoryFetch, HistoryState, HistoryTarget, Incoming,
        IncomingDestination, NameKey, NetworkModel, PendingTargetState, SendTarget, TimelineOrigin,
        chat_projection, collapse_blank_lines, derive_read_projection, draft_key, nick_color_index,
        reaction_actor_key, system_time_from_millis, time_millis,
    };
    use crate::{
        BufferId, BufferKind, BufferSyncState, EngineMessageKey, EngineToUi, MembershipKind,
        MessageAuthorship, NetworkConnectionState, NetworkId,
        chat_list_snapshot::{ChatListSnapshot, SnapshotConversation, SnapshotCursor, SnapshotRow},
        pushed_messages::PushedMessage,
        reactions::{ReactionAction, ReactionActor, ReactionUpdate, ReactionVersion},
        read_model::{MessageStub, ServerTimeMs},
        timeline::{
            FixedOffsetCalendar, ItemBody, LocalDay, RecordBody, TimelineItem,
            apply_timeline_change,
        },
    };

    fn secure_wire_builder() -> papo::Builder {
        // The in-memory connector never performs a handshake, so platform roots only add a host dependency.
        papo::Client::builder("ircs://verified.example", "weblounge")
            .tls_ca_pem(include_bytes!("../tests/data/secure-wire-ca.pem"))
    }

    #[test]
    fn history_state_derives_buffer_sync_state() {
        assert_eq!(
            HistoryState::Unrequested.sync_state(),
            BufferSyncState::Pending
        );
        assert_eq!(
            HistoryState::QueuedLatest.sync_state(),
            BufferSyncState::Pending
        );
        assert_eq!(
            HistoryState::LoadingLatest.sync_state(),
            BufferSyncState::Syncing
        );
        assert_eq!(
            HistoryState::LoadingOlder {
                oldest: papo::HistoryReference::from(papo::MessageId::from("oldest")),
            }
            .sync_state(),
            BufferSyncState::Synced
        );
        assert_eq!(
            HistoryState::Ready {
                oldest: None,
                at_start: true,
            }
            .sync_state(),
            BufferSyncState::Synced
        );
        assert_eq!(
            HistoryState::Refreshing {
                oldest: None,
                at_start: true,
            }
            .sync_state(),
            BufferSyncState::Syncing
        );
        assert_eq!(
            HistoryState::RefreshCapped.sync_state(),
            BufferSyncState::Synced
        );
    }

    #[test]
    fn history_requests_update_projected_buffer_sync_state() {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        let (buffer_id, projection) =
            model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        assert_eq!(
            projection.expect("new buffer").sync_state,
            BufferSyncState::Pending
        );

        let fetch = model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("initial request");
        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Syncing
        );
        let target = match &fetch {
            HistoryFetch::Latest(target)
            | HistoryFetch::Before { target, .. }
            | HistoryFetch::After { target, .. } => target,
        };
        let completion = model
            .finish_history(&target.conversation(), None, None, None, 0, true)
            .expect("history finishes");
        assert_eq!(completion.buffer_id, buffer_id);
        assert_eq!(completion.at_start, Some(true));
        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Synced
        );
    }

    #[test]
    fn reconnect_waits_for_targets_before_requesting_ready_history() {
        let (mut model, state) = model(10);
        model.connected_history();
        model.receive_incoming(
            incoming(
                &state,
                "before reconnect",
                Some("before-reconnect"),
                Some(100),
                100,
                TimelineOrigin::Live,
            ),
            &state,
        );
        let channel = channel_name(&state, "#room");
        let buffer_id = model.names[&NameKey::Channel(channel.clone())];
        super::set_history_state(
            model.buffers.get_mut(&buffer_id).expect("channel exists"),
            HistoryState::Ready {
                oldest: None,
                at_start: false,
            },
        );

        let fetches = model.connected_history();

        assert!(fetches.is_empty());
        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Synced
        );
    }

    #[test]
    fn message_text_keeps_at_most_one_blank_line() {
        assert_eq!(
            collapse_blank_lines("first\n\n\nsecond\n\n\n\nthird".into()),
            "first\n\nsecond\n\nthird"
        );
        assert_eq!(
            collapse_blank_lines("first\n\nsecond".into()),
            "first\n\nsecond"
        );
    }

    fn channel_name(state: &papo::State, name: &str) -> papo::ChannelName {
        papo_testing::channel(state.casemapping(), name)
    }

    fn nick_name(state: &papo::State, name: &str) -> papo::Nick {
        papo_testing::nick(state.casemapping(), name)
    }

    fn incoming(
        state: &papo::State,
        text: &str,
        msgid: Option<&str>,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
        origin: TimelineOrigin,
    ) -> Incoming {
        Incoming {
            destination: IncomingDestination::Conversation(NameKey::Channel(channel_name(
                state, "#room",
            ))),
            direct: None,
            direct_key: None,
            peer_key: None,
            legacy_account_key: None,
            provisional_identity: None,
            author: "alice".into(),
            text: text.into(),
            kind: crate::MessageKind::Text,
            bot: Some(false),
            authorship: MessageAuthorship::Other,
            msgid: msgid.map(str::to_owned),
            server_time_ms,
            received_at_ms,
            origin,
        }
    }

    fn model(limit: usize) -> (NetworkModel, papo::State) {
        (
            NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), limit),
            StateBuilder::new("weblounge").connected(true).build(),
        )
    }

    fn take_changed_messages(
        model: &mut NetworkModel,
    ) -> Vec<(BufferId, crate::MessageProjection)> {
        model
            .take_timeline_changes(false)
            .into_iter()
            .flat_map(|event| match event {
                EngineToUi::TimelineChanged {
                    buffer_id,
                    upserted,
                    ..
                } => upserted
                    .into_iter()
                    .filter_map(|item| match item.body {
                        ItemBody::Message(message) => Some((buffer_id, message)),
                        ItemBody::System(_) | ItemBody::Gap(_) => None,
                    })
                    .collect(),
                _ => Vec::new(),
            })
            .collect()
    }

    fn take_changed_items(model: &mut NetworkModel) -> Vec<TimelineItem> {
        model
            .take_timeline_changes(false)
            .into_iter()
            .flat_map(|event| match event {
                EngineToUi::TimelineChanged { upserted, .. } => upserted,
                _ => Vec::new(),
            })
            .collect()
    }

    fn apply_new_rows(rows: &mut Vec<TimelineItem>, events: &[EngineToUi]) {
        for event in events {
            if let EngineToUi::TimelineChanged {
                reset,
                upserted,
                removed,
                ..
            } = event
            {
                *rows = apply_timeline_change(
                    rows,
                    &crate::timeline::TimelineChange {
                        reset: *reset,
                        upserted: upserted.clone(),
                        removed: removed.clone(),
                    },
                )
                .expect("engine patch applies")
                .items;
            }
        }
    }

    fn finish_timeline_turn(model: &mut NetworkModel, mut old: Vec<EngineToUi>) -> Vec<EngineToUi> {
        let patches = model.take_timeline_changes(false);
        assert!(
            patches
                .iter()
                .filter(|event| matches!(event, EngineToUi::TimelineChanged { .. }))
                .count()
                <= 1
        );
        old.extend(patches);
        old
    }

    #[test]
    fn system_budget_never_evicts_chat_and_eviction_stays_silent() {
        let (mut model, state) = model(2);
        for (text, time) in [("first", 1), ("second", 2)] {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    Some(time),
                    time,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        let initial = model.take_timeline_changes(false);
        let channel = channel_name(&state, "#room");
        for index in 0..20 {
            model.receive_membership(
                &channel,
                MembershipKind::Joined,
                format!("nick-{index}"),
                Some(10 + index),
                10 + index,
            );
        }
        let flood = model.take_timeline_changes(false);
        let buffer_id = model.names[&NameKey::Channel(channel)];
        assert_eq!(
            model.buffers[&buffer_id]
                .timeline
                .iter()
                .filter_map(chat_projection)
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(
            model.buffers[&buffer_id]
                .timeline
                .iter()
                .filter(|record| !matches!(record.body, RecordBody::Chat(_)))
                .count(),
            2
        );
        let next = model.receive_incoming(
            incoming(
                &state,
                "third",
                Some("third"),
                Some(40),
                40,
                TimelineOrigin::Live,
            ),
            &state,
        );
        let next = finish_timeline_turn(&mut model, next);
        assert!(next.iter().all(|event| !matches!(event, EngineToUi::TimelineChanged { removed, .. } if !removed.is_empty())));

        let mut mirror = Vec::new();
        apply_new_rows(&mut mirror, &initial);
        apply_new_rows(&mut mirror, &flood);
        apply_new_rows(&mut mirror, &next);
        assert_eq!(mirror.len(), 2 + 20 + 1);
        assert_eq!(model.buffers[&buffer_id].emitted_timeline.len(), 4);
    }

    #[test]
    fn emitted_timeline_stays_bounded_while_chat_eviction_stays_silent() {
        let limit = 4;
        let (mut model, state) = model(limit);
        let mut ui_mirror = Vec::new();

        for index in 0..24 {
            let text = format!("message-{index}");
            model.receive_incoming(
                incoming(
                    &state,
                    &text,
                    Some(&text),
                    Some(index),
                    index,
                    TimelineOrigin::Live,
                ),
                &state,
            );
            let changes = model.take_timeline_changes(false);
            assert!(changes.iter().all(|event| !matches!(
                event,
                EngineToUi::TimelineChanged { removed, .. } if !removed.is_empty()
            )));
            apply_new_rows(&mut ui_mirror, &changes);

            let channel = channel_name(&state, "#room");
            let buffer_id = model.names[&NameKey::Channel(channel)];
            assert!(model.buffers[&buffer_id].emitted_timeline.len() <= limit);
        }

        assert_eq!(ui_mirror.len(), 24);
    }

    #[test]
    fn reset_after_eviction_keeps_engine_order() {
        let (mut model, state) = model(4);
        for index in 0..12 {
            let text = format!("message-{index}");
            model.receive_incoming(
                incoming(
                    &state,
                    &text,
                    Some(&text),
                    Some(index),
                    index,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        _ = model.take_timeline_changes(false);

        let channel = channel_name(&state, "#room");
        let buffer_id = model.names[&NameKey::Channel(channel)];
        let projected_ids = model
            .projected_messages(buffer_id)
            .into_iter()
            .map(|message| message.id)
            .collect::<Vec<_>>();
        let reset_ids = model
            .take_timeline_changes(true)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::TimelineChanged {
                    buffer_id: current,
                    reset: true,
                    upserted,
                    ..
                } if current == buffer_id => {
                    Some(upserted.into_iter().map(|item| item.id).collect::<Vec<_>>())
                }
                _ => None,
            })
            .expect("channel reset");

        assert_eq!(reset_ids, projected_ids);
    }

    #[test]
    fn reaction_actor_identity_does_not_depend_on_account_tags() {
        let state = StateBuilder::new("weblounge").connected(true).build();
        let nick = nick_name(&state, "alice");
        let live = MessageBuilder::new("#room", "live")
            .actor(nick.clone(), None, None)
            .account(papo_testing::account(state.casemapping(), "alice"))
            .build();
        let history = MessageBuilder::new("#room", "history")
            .actor(nick, None, None)
            .build();

        assert_eq!(
            reaction_actor_key(&live.actor),
            reaction_actor_key(&history.actor)
        );
    }

    #[test]
    fn reaction_targets_follow_timeline_and_buffer_lifetimes() {
        let (mut model, state) = model(1);
        model.receive_incoming(
            incoming(
                &state,
                "first",
                Some("evicted"),
                Some(1),
                1,
                TimelineOrigin::Live,
            ),
            &state,
        );
        let channel = channel_name(&state, "#room");
        let channel_id = model.names[&NameKey::Channel(channel.clone())];
        model.reactions.apply(
            channel_id,
            "evicted",
            "👍",
            ReactionUpdate::new(
                ReactionActor {
                    key: "nick:alice".into(),
                    nick: "alice".into(),
                    mine: false,
                },
                ReactionAction::Added,
                ReactionVersion::new(1, "reaction"),
            ),
            true,
        );
        model.receive_incoming(
            incoming(
                &state,
                "second",
                Some("retained"),
                Some(2),
                2,
                TimelineOrigin::Live,
            ),
            &state,
        );
        _ = model.take_timeline_changes(false);
        assert!(!model.reactions.contains_target("evicted"));

        model.reactions.apply(
            channel_id,
            "parted",
            "👍",
            ReactionUpdate::new(
                ReactionActor {
                    key: "nick:alice".into(),
                    nick: "alice".into(),
                    mine: false,
                },
                ReactionAction::Added,
                ReactionVersion::new(2, "part-reaction"),
            ),
            false,
        );
        model.remove_channel(&channel).expect("channel is removed");
        assert!(!model.reactions.contains_target("parted"));

        let direct = NameKey::Direct(nick_name(&state, "bob"));
        let (direct_id, _) = model.ensure_buffer(direct, None, None);
        model.reactions.apply(
            direct_id,
            "closed",
            "👍",
            ReactionUpdate::new(
                ReactionActor {
                    key: "nick:bob".into(),
                    nick: "bob".into(),
                    mine: false,
                },
                ReactionAction::Added,
                ReactionVersion::new(3, "close-reaction"),
            ),
            false,
        );
        model.close_direct(direct_id).expect("direct is closed");
        assert!(!model.reactions.contains_target("closed"));
    }

    fn snapshot_stubs(count: usize, mentions: usize, latest: i64) -> Vec<MessageStub> {
        (0..count)
            .map(|index| MessageStub {
                msgid: format!("snapshot-{latest}-{index}"),
                time: ServerTimeMs::new(
                    latest - i64::try_from(count - index - 1).expect("small fixture"),
                ),
                provisional_time: None,
                mention: index < mentions,
            })
            .collect()
    }

    fn pushed_channel_message() -> PushedMessage {
        serde_json::from_value(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-one",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message")
    }

    #[test]
    fn received_message_projection_collapses_blank_lines() {
        let (mut model, state) = model(10);

        model.receive_incoming(
            incoming(
                &state,
                "first\n\n\n\nsecond",
                Some("received-multiline"),
                Some(1_000),
                1_000,
                TimelineOrigin::Live,
            ),
            &state,
        );
        assert_eq!(
            take_changed_messages(&mut model)[0].1.text,
            "first\n\nsecond"
        );
        assert_eq!(timeline(&model), ["first\n\nsecond"]);
    }

    #[test]
    fn pushed_message_is_visible_then_reconciles_history_and_deduplicates_live() {
        let (mut model, state) = model(10);
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-one",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");

        model.restore_pushed_messages(vec![pushed], &state);
        assert_eq!(
            take_changed_messages(&mut model)[0].1.text,
            "arrived while closed"
        );
        let buffer_id = model.names[&NameKey::Channel(channel_name(&state, "#room"))];
        assert_eq!(
            model.buffers[&buffer_id].projection.last_activity_ms,
            Some(1_793_709_296_789)
        );
        model.receive_incoming(
            incoming(
                &state,
                "arrived while closed",
                Some("pushed-one"),
                Some(1_793_708_096_789),
                1_793_708_096_789,
                TimelineOrigin::History,
            ),
            &state,
        );
        assert_eq!(
            take_changed_messages(&mut model)[0].1.text,
            "arrived while closed"
        );
        assert_eq!(
            model.buffers[&buffer_id].projection.last_activity_ms,
            Some(1_793_708_096_789)
        );
        assert!(
            model
                .receive_incoming(
                    incoming(
                        &state,
                        "arrived while closed",
                        Some("pushed-one"),
                        Some(1_793_708_096_789),
                        1_793_708_096_789,
                        TimelineOrigin::Live,
                    ),
                    &state,
                )
                .is_empty()
        );
        assert_eq!(timeline(&model), ["arrived while closed"]);
    }

    #[tokio::test]
    async fn pushed_message_reuses_the_running_clients_name_origin() {
        let (client, mut events, mut wire) = wire(secure_wire_builder());
        wire.register(&["message-tags", "server-time"]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        let state = client.state();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 10);
        let channel = state
            .name_rules()
            .expect("connected client has name rules")
            .channel("#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-with-live-origin",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "provisional while suspended",
            "kind": "message",
        }))
        .expect("pushed message");

        model.restore_pushed_messages(vec![pushed], &state);

        let pushed_snapshot = model.merge_chat_list_snapshot(
            "network".into(),
            &ChatListSnapshot::new("network".into(), Vec::new()),
        );
        assert_eq!(
            pushed_snapshot.rows[0].preview.as_deref(),
            Some("alice: provisional while suspended")
        );

        assert_eq!(
            model.names[&NameKey::Channel(channel)],
            buffer_id,
            "push restoration must not create an originless duplicate buffer"
        );
        assert_eq!(model.buffers.len(), 2, "server and channel buffers only");
        assert_eq!(
            chat_projection(&model.buffers[&buffer_id].timeline[0])
                .expect("pushed chat record")
                .text,
            "provisional while suspended"
        );
    }

    #[test]
    fn pushed_message_reopens_a_previously_ready_history_edge() {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("initial history starts");
        model
            .finish_history(
                &papo::Conversation::Channel(channel.clone()),
                Some(papo::HistoryReference::from(papo::MessageId::from(
                    "oldest",
                ))),
                Some(100),
                Some(HistoryCursor::new(Some("oldest".into()), 100)),
                1,
                false,
            )
            .expect("initial history finishes");
        let authoritative_cursor = HistoryCursor::new(Some("authoritative".into()), 100);
        model
            .buffers
            .get_mut(&buffer_id)
            .expect("room buffer")
            .newest = Some(authoritative_cursor.clone());
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-after-ready",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "provisional while suspended",
            "kind": "message",
        }))
        .expect("pushed message");

        model.restore_pushed_messages(vec![pushed], &state);

        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Pending
        );
        assert_eq!(
            model.buffers[&buffer_id].newest,
            Some(authoritative_cursor.clone())
        );
        let fetch = model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("provisional edge requests authority");
        assert!(matches!(
            &fetch,
            HistoryFetch::After {
                target: HistoryTarget::Channel(target),
                newest,
            } if target == &channel && newest == &authoritative_cursor
        ));
        model.restart_inflight_history();
        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Pending
        );
        let resumed = model.connected_history();
        assert!(matches!(
            resumed.as_slice(),
            [HistoryFetch::After { newest, .. }] if newest == &authoritative_cursor
        ));
        let failed_buffer = model.fail_history(&resumed[0]).expect("fetch fails");
        assert_eq!(failed_buffer, buffer_id);
        let retry = model
            .retry_pushed_history(buffer_id)
            .expect("provisional fetch retries once");
        assert!(matches!(
            &retry,
            HistoryFetch::After { newest, .. } if newest == &authoritative_cursor
        ));
        model.fail_history(&retry).expect("retry fails");
        assert!(model.retry_pushed_history(buffer_id).is_none());
        assert_eq!(
            model.buffers[&buffer_id].projection.sync_state,
            BufferSyncState::Pending
        );
    }

    #[tokio::test]
    async fn pushed_direct_message_becomes_verified_when_history_arrives() {
        let (client, mut events, mut wire) = wire(secure_wire_builder());
        wire.register(&["account-tag", "message-tags", "server-time"])
            .await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "louro-pi",
            "account": "louro",
            "target": "weblounge",
            "msgid": "pushed-direct",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "push test from louro-pi",
            "kind": "message",
        }))
        .expect("pushed direct message");

        model.restore_pushed_messages(vec![pushed], &client.state());
        let restored = take_changed_messages(&mut model);
        assert!(restored[0].1.unverified_sender.is_none());

        wire.server("@account=louro;msgid=pushed-direct;time=2026-11-03T12:34:56.789Z :louro-pi!l@example.test PRIVMSG weblounge :push test from louro-pi")
            .await;
        let history = loop {
            if let Some(papo::Event::Message(message)) = events.next().await {
                break message;
            }
        };
        model.receive(&history, true, &client.state(), None);
        let updated = take_changed_messages(&mut model);
        assert!(updated.first().is_some_and(|(_, message)| {
            message.author == "louro-pi" && message.unverified_sender.is_none()
        }));
        let direct = model
            .buffers
            .values()
            .find(|buffer| buffer.projection.title == "louro-pi")
            .expect("direct buffer exists");
        assert_eq!(
            direct.projection.direct_identity,
            Some(crate::DirectIdentityState::Verified)
        );
        assert_eq!(direct.projection.read_at_ms, None);
        assert_eq!(direct.read_facts.mark(), None);
        assert_eq!(direct.timeline.len(), 1);
    }

    fn timeline(model: &NetworkModel) -> Vec<&str> {
        let id = model
            .buffers
            .values()
            .find(|buffer| buffer.projection.title == "#room")
            .map(|buffer| buffer.projection.id)
            .expect("room buffer exists");
        model.buffers[&id]
            .timeline
            .iter()
            .filter_map(chat_projection)
            .map(|message| message.text.as_str())
            .collect()
    }

    fn ordered_titles(model: &NetworkModel) -> Vec<String> {
        let EngineToUi::BuffersChanged { buffers, .. } = model.buffers_event() else {
            panic!("buffer order event")
        };
        buffers.into_iter().map(|buffer| buffer.title).collect()
    }

    fn direct_buffer_count(model: &NetworkModel) -> usize {
        model
            .buffers
            .values()
            .filter(|buffer| buffer.projection.kind == BufferKind::Direct)
            .count()
    }

    fn assert_verified_account_upgrade(
        model: &NetworkModel,
        buffer_id: BufferId,
        nick_draft_key: &str,
        read_at: SystemTime,
        received: &[EngineToUi],
    ) {
        assert!(received.iter().any(|event| matches!(
            event,
            EngineToUi::BufferAdded { buffer } if buffer.id == buffer_id
        )));
        assert_eq!(
            model.buffers[&buffer_id].projection.direct_identity,
            Some(crate::DirectIdentityState::Verified)
        );
        assert!(
            model.buffers[&buffer_id]
                .timeline
                .last()
                .and_then(chat_projection)
                .is_some_and(|message| message.unverified_sender != Some(true))
        );
        assert_eq!(
            model.buffers[&buffer_id].projection.draft_key,
            nick_draft_key
        );
        assert_eq!(
            model.buffers[&buffer_id]
                .read_facts
                .mark()
                .map(ServerTimeMs::value),
            Some(time_millis(read_at))
        );
        assert_eq!(direct_buffer_count(model), 1);
        let persisted = model.chat_list_snapshot("network".into());
        assert!(persisted.rows[0].peer_pin.is_some());
        let mut restored = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        restored.restore_chat_list(persisted);
        assert!(restored.buffers.values().any(|buffer| {
            buffer.projection.direct_identity == Some(crate::DirectIdentityState::Verified)
        }));
    }

    fn direct_incoming(
        state: &papo::State,
        nick: &str,
        text: &str,
        server_time_ms: i64,
    ) -> Incoming {
        Incoming {
            destination: IncomingDestination::Conversation(NameKey::Direct(nick_name(state, nick))),
            direct: None,
            direct_key: Some(DirectKey(state.casemapping().fold(nick).into_owned())),
            peer_key: None,
            legacy_account_key: None,
            provisional_identity: None,
            author: nick.into(),
            text: text.into(),
            kind: crate::MessageKind::Text,
            bot: Some(false),
            authorship: MessageAuthorship::Other,
            msgid: Some(format!("{nick}-{server_time_ms}")),
            server_time_ms: Some(server_time_ms),
            received_at_ms: server_time_ms,
            origin: TimelineOrigin::Live,
        }
    }

    #[test]
    fn channel_order_is_independent_of_join_arrival() {
        let orders = [
            ["#Zoo", "&alpha", "#beta", "#alpha"],
            ["#alpha", "#beta", "&alpha", "#Zoo"],
        ];
        let projected = orders.map(|order| {
            let (mut model, state) = model(10);
            for name in order {
                model.ensure_buffer(NameKey::Channel(channel_name(&state, name)), None, None);
            }
            ordered_titles(&model)
        });

        assert_eq!(projected[0], projected[1]);
        assert_eq!(projected[0], ["Test", "#alpha", "&alpha", "#beta", "#Zoo"]);
    }

    #[test]
    fn direct_order_tracks_activity_with_a_casemapped_nick_tiebreaker() {
        let (mut model, state) = model(10);
        for incoming in [
            direct_incoming(&state, "Bob", "same time", 100),
            direct_incoming(&state, "alice", "same time", 100),
            direct_incoming(&state, "carol", "newest", 200),
        ] {
            model.receive_incoming(incoming, &state);
        }
        assert_eq!(ordered_titles(&model), ["Test", "carol", "alice", "Bob"]);

        let events =
            model.receive_incoming(direct_incoming(&state, "alice", "new latest", 300), &state);
        assert!(events.iter().any(|event| {
            matches!(event, EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().map(|buffer| buffer.title.as_str()).collect::<Vec<_>>()
                    == ["Test", "alice", "carol", "Bob"])
        }));
    }

    #[test]
    fn chat_list_snapshot_round_trip_preserves_direct_order_and_activity() {
        let (mut live, state) = model(10);
        for incoming in [
            direct_incoming(&state, "Bob", "oldest", 100),
            direct_incoming(&state, "alice", "newest", 300),
            direct_incoming(&state, "carol", "middle", 200),
        ] {
            live.receive_incoming(incoming, &state);
        }
        let snapshot = live.chat_list_snapshot("network".into());
        let encoded = snapshot.encode().expect("encode snapshot");
        let decoded = ChatListSnapshot::decode(&encoded, "network").expect("decode snapshot");
        let (mut restored, _) = model(10);

        restored.restore_chat_list(decoded);

        let rows = restored
            .ordered_buffers()
            .into_iter()
            .filter(|buffer| buffer.kind == BufferKind::Direct)
            .map(|buffer| (buffer.title, buffer.last_activity_ms))
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            [
                ("alice".into(), Some(300)),
                ("carol".into(), Some(200)),
                ("Bob".into(), Some(100)),
            ]
        );
    }

    #[test]
    fn restored_direct_order_uses_target_activity_before_history_arrives() {
        let (mut model, state) = model(10);
        for (nick, seconds) in [("Bob", 100), ("alice", 100), ("carol", 200)] {
            let nick = nick_name(&state, nick);
            model.restore_direct(
                &nick,
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
            );
        }

        assert_eq!(ordered_titles(&model), ["Test", "carol", "alice", "Bob"]);
    }

    #[test]
    fn schema_five_migration_refetches_only_after_the_conversation_changes() {
        let snapshot = ChatListSnapshot::decode(
            include_bytes!("../../../fixtures/read-state/schema-5-chat-list.json"),
            "network",
        )
        .expect("schema 5 fixture migrates");
        let (mut model, state) = model(10);
        model.restore_chat_list(snapshot);
        let nick = nick_name(&state, "alice");

        let (unchanged, _, _) =
            model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(300));
        assert!(unchanged.is_none());
        let buffer_id = model.names[&NameKey::Direct(nick.clone())];
        assert_eq!(model.buffers[&buffer_id].projection.unread, 0);

        let (changed, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(400));
        assert!(matches!(
            changed,
            Some(HistoryFetch::After { ref newest, .. })
                if newest.reference()
                    == papo::HistoryReference::from(UNIX_EPOCH + Duration::from_millis(100))
        ));
        for time in [200, 300, 400] {
            model.receive_incoming(
                direct_incoming(&state, "alice", &format!("line {time}"), time),
                &state,
            );
        }
        model
            .finish_history(
                &papo::Conversation::Private(nick.clone()),
                None,
                None,
                Some(HistoryCursor::new(Some("alice-400".into()), 400)),
                3,
                true,
            )
            .expect("changed conversation rebuild finishes");
        assert_eq!(model.buffers[&buffer_id].projection.unread, 3);

        let (settled, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(400));
        assert!(settled.is_none());
    }

    #[test]
    fn unchanged_conversation_restores_its_unread_facts_without_a_fetch() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(100),
                stubs: snapshot_stubs(3, 3, 100),
                gap_until: None,
                preview: Some("cached preview".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");

        let (fetch, _, added) =
            model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(100));

        assert!(fetch.is_none());
        assert!(added.is_none());
        let buffer = &model.buffers[&model.names[&NameKey::Direct(nick.clone())]];
        assert_eq!(buffer.projection.unread, 3);
        assert_eq!(buffer.projection.preview.as_deref(), Some("cached preview"));
        assert!(matches!(buffer.history, HistoryState::Unrequested));
    }

    #[test]
    fn ready_direct_with_stubs_still_needs_its_server_marker() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(100),
                stubs: snapshot_stubs(1, 1, 100),
                gap_until: None,
                preview: Some("cached preview".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");
        let buffer_id = model.names[&NameKey::Direct(nick.clone())];
        let buffer = model.buffers.get_mut(&buffer_id).expect("direct");
        buffer.history = HistoryState::Ready {
            oldest: None,
            at_start: false,
        };

        assert!(matches!(
            model.direct_marker_targets().as_slice(),
            [HistoryTarget::Direct(target)] if target.key() == nick.key()
        ));
    }

    #[test]
    fn newer_server_marker_prunes_restored_unread_facts() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(300),
                stubs: snapshot_stubs(3, 3, 300),
                gap_until: None,
                preview: Some("newest".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("newest".into()),
                    server_time_ms: 300,
                }),
                read_at_ms: Some(100),
                raw_read_at_ms: Some(100),
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");
        let conversation = papo::Conversation::Private(nick.clone());

        model
            .apply_server_read_marker(&conversation, Some(UNIX_EPOCH + Duration::from_millis(299)));
        let buffer = &model.buffers[&model.names[&NameKey::Direct(nick)]];
        assert_eq!(buffer.projection.unread, 1);
        assert_eq!(buffer.projection.mentions, 1);
    }

    #[test]
    fn targets_refreshes_a_changed_cached_direct_after_its_newest_position() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(100),
                stubs: snapshot_stubs(1, 1, 100),
                gap_until: None,
                preview: Some("cached preview".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");

        let (fetch, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(200));

        assert!(matches!(
            fetch,
            Some(HistoryFetch::After { newest, .. })
                if newest.reference() == papo::HistoryReference::from(
                    UNIX_EPOCH + Duration::from_millis(100)
                )
        ));
        let buffer = &model.buffers[&model.names[&NameKey::Direct(nick)]];
        assert!(matches!(buffer.history, HistoryState::Refreshing { .. }));
        assert_eq!(buffer.projection.unread, 1);
    }

    #[test]
    fn target_sync_boundary_waits_for_changed_history() {
        let (mut model, state) = model(10);
        model.restore_chat_list(
            ChatListSnapshot::new(
                "network".into(),
                vec![SnapshotRow {
                    conversation: SnapshotConversation::Channel {
                        key: "#room".into(),
                    },
                    title: "#room".into(),
                    last_activity_ms: Some(100),
                    stubs: snapshot_stubs(1, 0, 100),
                    gap_until: None,
                    preview: Some("cached".into()),
                    newest: Some(SnapshotCursor {
                        msgid: Some("cached".into()),
                        server_time_ms: 100,
                    }),
                    read_at_ms: None,
                    raw_read_at_ms: None,
                    pending_read_at_ms: None,
                    peer_pin: None,
                }],
            )
            .with_cursor_ms(Some(100)),
        );
        let channel = channel_name(&state, "#room");
        let fetch = model
            .restore_channel(&channel, UNIX_EPOCH + Duration::from_millis(300))
            .expect("changed channel starts a delta");

        model.finish_target_sync(Some(UNIX_EPOCH + Duration::from_millis(300)));
        model.set_connection(NetworkConnectionState::Online, None);
        model.observe_live_server_time(Some(UNIX_EPOCH + Duration::from_millis(400)));

        assert_eq!(
            model.cursor(),
            Some(UNIX_EPOCH + Duration::from_millis(100))
        );
        assert_eq!(
            model
                .merge_chat_list_snapshot(
                    "network".into(),
                    &ChatListSnapshot::new("network".into(), Vec::new())
                )
                .cursor_ms,
            Some(100)
        );
        let HistoryFetch::After { target, .. } = fetch else {
            panic!("changed cached channel uses AFTER")
        };
        model
            .finish_history(&target.conversation(), None, None, None, 1, true)
            .expect("delta finishes");
        assert_eq!(
            model.cursor(),
            Some(UNIX_EPOCH + Duration::from_millis(400))
        );
    }

    #[test]
    fn failed_target_delta_does_not_advance_the_sync_boundary() {
        let (mut model, state) = model(10);
        model.cursor = Some(UNIX_EPOCH + Duration::from_millis(100));
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        model.buffers.get_mut(&buffer_id).expect("channel").history = HistoryState::LoadingLatest;
        model.finish_target_sync(Some(UNIX_EPOCH + Duration::from_millis(300)));
        model.set_connection(NetworkConnectionState::Online, None);
        model.observe_live_server_time(Some(UNIX_EPOCH + Duration::from_millis(400)));
        let fetch = HistoryFetch::Latest(HistoryTarget::Channel(channel));

        model.fail_history(&fetch).expect("delta fails");

        assert_eq!(
            model.cursor(),
            Some(UNIX_EPOCH + Duration::from_millis(100))
        );
        assert!(model.pending_target_sync.is_none());
    }

    #[test]
    fn target_failure_falls_back_to_cached_latest_without_stranding_the_list() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: Some(100),
                stubs: snapshot_stubs(1, 0, 100),
                gap_until: None,
                preview: Some("cached".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("cached".into()),
                    server_time_ms: 100,
                }),
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        model.set_connection(crate::NetworkConnectionState::Online, None);
        let fetches = model.fallback_target_history(true);
        let channel = channel_name(&state, "#room");
        let buffer_id = model.names[&NameKey::Channel(channel)];

        assert!(matches!(fetches.as_slice(), [HistoryFetch::Latest(_)]));
        assert!(model.buffers[&buffer_id].restored_from_snapshot);
        model
            .fail_history(&fetches[0])
            .expect("fallback latest fails");
        assert_eq!(
            model.buffers[&buffer_id].projection.preview.as_deref(),
            Some("cached")
        );
        assert_eq!(model.buffers[&buffer_id].projection.unread, 1);
    }

    #[test]
    fn unsupported_targets_keep_cached_rows_authoritative() {
        let (mut model, _) = model(10);
        model.set_connection(crate::NetworkConnectionState::Online, None);

        let fetches = model.fallback_target_history(false);

        assert!(fetches.is_empty());
    }

    #[test]
    fn targets_loads_latest_for_a_changed_cached_direct_without_a_cursor() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: None,
                stubs: Vec::new(),
                gap_until: None,
                preview: None,
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");

        let (fetch, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(200));

        assert!(matches!(fetch, Some(HistoryFetch::Latest(_))));
        let buffer = &model.buffers[&model.names[&NameKey::Direct(nick)]];
        assert!(buffer.restored_from_snapshot);
        assert!(matches!(buffer.history, HistoryState::LoadingLatest));
    }

    #[test]
    fn targets_loads_latest_for_a_changed_cached_channel_without_a_cursor() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: None,
                stubs: Vec::new(),
                gap_until: None,
                preview: None,
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let channel = channel_name(&state, "#room");

        let fetch = model.restore_channel(&channel, UNIX_EPOCH + Duration::from_millis(200));

        assert!(matches!(fetch, Some(HistoryFetch::Latest(_))));
        let buffer = &model.buffers[&model.names[&NameKey::Channel(channel)]];
        assert!(buffer.restored_from_snapshot);
        assert!(matches!(buffer.history, HistoryState::LoadingLatest));
    }

    #[test]
    fn cached_channel_latest_preserves_the_join_read_marker() {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: Some(300),
                stubs: vec![MessageStub {
                    msgid: "after".into(),
                    time: ServerTimeMs::new(300),
                    provisional_time: None,
                    mention: false,
                }],
                gap_until: None,
                preview: Some("newest".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("newest".into()),
                    server_time_ms: 300,
                }),
                read_at_ms: Some(200),
                raw_read_at_ms: Some(200),
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let buffer_id = model.names[&NameKey::Channel(channel.clone())];
        let fetch = model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("opening the cached channel requests latest history");
        assert!(matches!(
            fetch,
            HistoryFetch::Latest(HistoryTarget::Channel(_))
        ));

        for (text, msgid, time) in [
            ("before", "before", 100),
            ("through", "through", 200),
            ("after", "after", 300),
        ] {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(msgid),
                    Some(time),
                    time,
                    TimelineOrigin::History,
                ),
                &state,
            );
        }
        model
            .finish_history(
                &papo::Conversation::Channel(channel),
                None,
                None,
                None,
                3,
                true,
            )
            .expect("latest history finishes");

        let buffer = &model.buffers[&buffer_id];
        assert_eq!(buffer.projection.unread, 1);
        assert_eq!(buffer.projection.read_at_ms, Some(200));
    }

    #[test]
    fn targets_loads_latest_for_an_empty_ready_channel() {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        model.buffers.get_mut(&buffer_id).expect("channel").history = HistoryState::Ready {
            oldest: None,
            at_start: true,
        };

        let fetch = model.restore_channel(&channel, UNIX_EPOCH + Duration::from_millis(200));

        assert!(matches!(
            fetch,
            Some(HistoryFetch::Latest(HistoryTarget::Channel(_)))
        ));
        assert!(matches!(
            model.buffers[&buffer_id].history,
            HistoryState::LoadingLatest
        ));
    }

    #[test]
    fn changed_cached_direct_fetches_the_newest_page_after_its_read_position() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(200),
                stubs: snapshot_stubs(100, 100, 200),
                gap_until: None,
                preview: Some("cached preview".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("cached-newest".into()),
                    server_time_ms: 200,
                }),
                read_at_ms: Some(50),
                raw_read_at_ms: Some(50),
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let nick = nick_name(&state, "alice");
        let (fetch, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(300));
        let buffer_id = model.names[&NameKey::Direct(nick.clone())];

        assert!(matches!(
            fetch,
            Some(HistoryFetch::After { newest, .. })
                if newest.reference() == papo::HistoryReference::from(
                    UNIX_EPOCH + Duration::from_millis(50)
                )
        ));
        assert_eq!(model.buffers[&buffer_id].projection.unread, 100);

        for time in [299, 300] {
            let mut history = direct_incoming(&state, "alice", &format!("line {time}"), time);
            history.origin = TimelineOrigin::History;
            model.receive_incoming(history, &state);
        }
        let completion = model
            .finish_history(
                &papo::Conversation::Private(nick),
                None,
                Some(299),
                None,
                2,
                false,
            )
            .expect("capped refresh finishes");
        assert!(completion.gap);
        assert_eq!(
            model.buffers[&buffer_id].read_facts.gap_until(),
            Some(ServerTimeMs::new(299))
        );
        assert!(matches!(
            model.buffers[&buffer_id].history,
            HistoryState::RefreshCapped
        ));
        assert!(matches!(
            model.request_history(buffer_id, crate::HistoryDirection::Latest),
            Some(HistoryFetch::Latest(HistoryTarget::Direct(_)))
        ));
    }

    #[test]
    fn capped_refresh_shows_the_newest_page_preview_and_target_activity() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: Some(100),
                stubs: snapshot_stubs(1, 0, 100),
                gap_until: None,
                preview: Some("cached".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("cached".into()),
                    server_time_ms: 100,
                }),
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let channel = channel_name(&state, "#room");
        let fetch = model
            .restore_channel(&channel, UNIX_EPOCH + Duration::from_millis(300))
            .expect("changed channel refreshes after its cached cursor");
        assert!(matches!(fetch, HistoryFetch::After { .. }));
        model.receive_incoming(
            incoming(
                &state,
                "oldest pending page",
                Some("pending-1"),
                Some(200),
                200,
                TimelineOrigin::History,
            ),
            &state,
        );
        model
            .finish_history(
                &papo::Conversation::Channel(channel.clone()),
                None,
                None,
                None,
                100,
                false,
            )
            .expect("capped refresh finishes");

        let buffer = &model.buffers[&model.names[&NameKey::Channel(channel)]];
        assert!(matches!(buffer.history, HistoryState::RefreshCapped));
        assert_eq!(buffer.projection.last_activity_ms, Some(300));
        assert_eq!(
            buffer
                .projection
                .last_message
                .as_ref()
                .map(|message| message.text.as_str()),
            Some("oldest pending page")
        );
    }

    #[test]
    fn newer_recent_direct_target_catches_up_ready_history_after_its_cursor() {
        let (mut model, state) = model(10);
        let nick = nick_name(&state, "alice");
        model.receive_incoming(direct_incoming(&state, "alice", "before", 100), &state);
        let buffer_id = model.names[&NameKey::Direct(nick.clone())];
        model
            .buffers
            .get_mut(&buffer_id)
            .expect("direct exists")
            .history = HistoryState::Ready {
            oldest: None,
            at_start: false,
        };

        let (fetch, _, _) = model.restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(200));

        assert!(matches!(
            fetch,
            Some(HistoryFetch::After { newest, .. })
                if newest.reference()
                    == papo::HistoryReference::from(papo::MessageId::from("alice-100"))
        ));
        assert!(matches!(
            model.buffers[&buffer_id].history,
            HistoryState::Refreshing { .. }
        ));

        let mut history = direct_incoming(&state, "alice", "after", 150);
        history.origin = TimelineOrigin::History;
        model.receive_incoming(history, &state);
        model
            .finish_history(
                &papo::Conversation::Private(nick),
                None,
                None,
                None,
                1,
                true,
            )
            .expect("catch-up finishes");

        assert_eq!(
            model.buffers[&buffer_id].projection.last_activity_ms,
            Some(150)
        );
        assert_eq!(
            model.chat_list_snapshot("network".into()).rows[0].last_activity_ms,
            Some(150)
        );
    }

    #[test]
    fn msgids_deduplicate_and_server_time_orders_rows() {
        let (mut model, state) = model(10);
        model.receive_incoming(
            incoming(
                &state,
                "later",
                Some("two"),
                Some(2_000),
                20,
                TimelineOrigin::Live,
            ),
            &state,
        );
        model.receive_incoming(
            incoming(
                &state,
                "earlier",
                Some("one"),
                Some(1_000),
                30,
                TimelineOrigin::Live,
            ),
            &state,
        );
        assert!(
            model
                .receive_incoming(
                    incoming(
                        &state,
                        "duplicate",
                        Some("one"),
                        Some(3_000),
                        40,
                        TimelineOrigin::History,
                    ),
                    &state,
                )
                .is_empty()
        );

        assert_eq!(timeline(&model), ["earlier", "later"]);
        let preview = model
            .buffers
            .values()
            .find(|buffer| buffer.projection.title == "#room")
            .and_then(|buffer| buffer.projection.last_message.as_ref())
            .expect("latest message is projected for the buffer list");
        assert_eq!(preview.text, "later");
        assert_eq!(preview.author, "alice");
    }

    #[test]
    fn timeline_items_use_the_fixed_local_calendar() {
        let (mut model, state) = model(10);
        model.calendar = Arc::new(FixedOffsetCalendar::new(-5 * 60));
        for (text, time) in [("before", 17_999_999), ("after", 18_000_000)] {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    Some(time),
                    time,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }

        assert_eq!(
            take_changed_items(&mut model)
                .into_iter()
                .map(|item| item.day)
                .collect::<Vec<_>>(),
            [LocalDay(-1), LocalDay(0)],
        );
    }

    #[test]
    fn buffer_preview_chooses_message_time_independently_of_timeline_position() {
        let (mut model, state) = model(10);
        model.receive_incoming(
            incoming(
                &state,
                "older",
                Some("older"),
                Some(1_000),
                30,
                TimelineOrigin::History,
            ),
            &state,
        );
        model.receive_incoming(
            incoming(
                &state,
                "newer",
                Some("newer"),
                Some(2_000),
                20,
                TimelineOrigin::History,
            ),
            &state,
        );
        let buffer = model
            .buffers
            .values_mut()
            .find(|buffer| buffer.projection.title == "#room")
            .expect("channel buffer exists");
        buffer.timeline.reverse();

        derive_read_projection(buffer);

        assert_eq!(
            buffer
                .projection
                .last_message
                .as_ref()
                .map(|message| message.text.as_str()),
            Some("newer")
        );
    }

    #[test]
    fn history_duplicate_does_not_mutate_an_untimed_live_row() {
        let (mut model, state) = model(10);
        model.receive_incoming(
            incoming(
                &state,
                "current",
                Some("current"),
                Some(2_000),
                2_000,
                TimelineOrigin::Live,
            ),
            &state,
        );
        model.receive_incoming(
            incoming(
                &state,
                "older",
                Some("older"),
                None,
                3_000,
                TimelineOrigin::Live,
            ),
            &state,
        );

        assert!(
            model
                .receive_incoming(
                    incoming(
                        &state,
                        "older",
                        Some("older"),
                        Some(1_000),
                        4_000,
                        TimelineOrigin::History,
                    ),
                    &state,
                )
                .is_empty()
        );

        assert_eq!(timeline(&model), ["current", "older"]);
        assert_eq!(
            model
                .buffers
                .values()
                .flat_map(|buffer| &buffer.timeline)
                .filter_map(chat_projection)
                .find(|message| message.text == "older")
                .and_then(|message| message.server_time_ms),
            None
        );
    }

    #[test]
    fn consecutive_membership_changes_remain_ordered_for_app_collapse() {
        let (mut model, state) = model(10);
        model.receive_incoming(
            incoming(
                &state,
                "before",
                Some("m1"),
                Some(1),
                1,
                TimelineOrigin::Live,
            ),
            &state,
        );
        _ = take_changed_items(&mut model);
        let channel = channel_name(&state, "#room");
        model
            .receive_membership(&channel, MembershipKind::Joined, "mel".into(), Some(2), 2)
            .expect("membership row");
        let first = take_changed_items(&mut model)[0].clone();
        model
            .receive_membership(&channel, MembershipKind::Joined, "rafa".into(), Some(3), 3)
            .expect("collapsed row");
        let second = take_changed_items(&mut model)[0].clone();
        assert_ne!(first.id, second.id);
        assert!(matches!(
            (&first.body, &second.body),
            (
                ItemBody::System(crate::timeline::SystemProjection {
                    line: crate::timeline::SystemLine::Run { clauses: first },
                    ..
                }),
                ItemBody::System(crate::timeline::SystemProjection {
                    line: crate::timeline::SystemLine::Run { clauses: second },
                    ..
                })
            )
                if matches!(
                    (first.as_slice(), second.as_slice()),
                    (
                        [crate::timeline::RunClause::Joined { people: first }],
                        [crate::timeline::RunClause::Joined { people: second }]
                    ) if first[0].nick == "mel" && second[0].nick == "rafa"
                )
        ));
        model.receive_incoming(
            incoming(
                &state,
                "break",
                Some("m2"),
                Some(4),
                4,
                TimelineOrigin::Live,
            ),
            &state,
        );
        _ = take_changed_items(&mut model);
        model
            .receive_membership(&channel, MembershipKind::Joined, "cyd".into(), Some(5), 5)
            .expect("new membership row");
        let third = take_changed_items(&mut model)[0].clone();
        assert_ne!(second.id, third.id);
    }

    #[test]
    fn one_quit_msgid_is_retained_in_each_channel_with_its_reason() {
        let (mut model, state) = model(10);
        for name in ["#room", "#other"] {
            let channel = channel_name(&state, name);
            model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
            model.receive_membership_event(
                &channel,
                MembershipKind::Quit,
                "mel".into(),
                Some("gone".into()),
                Some("shared-quit".into()),
                Some(10),
                10,
            );
        }

        let items = take_changed_items(&mut model);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| matches!(
            &item.body,
            ItemBody::System(system) if matches!(
                system.line,
                crate::timeline::SystemLine::Run { ref clauses }
                    if matches!(clauses.as_slice(), [crate::timeline::RunClause::Quit { people }]
                        if people[0].reason.as_deref() == Some("gone"))
            )
        )));
    }

    #[test]
    fn live_and_history_membership_overlap_emits_one_item() {
        let (mut model, state) = model(10);
        let room = channel_name(&state, "#room");
        model.ensure_buffer(NameKey::Channel(room.clone()), None, None);
        for received_at_ms in [10, 20] {
            model.receive_membership_event(
                &room,
                MembershipKind::Joined,
                "mel".into(),
                None,
                Some("shared-join".into()),
                Some(10),
                received_at_ms,
            );
        }

        assert_eq!(take_changed_items(&mut model).len(), 1);
    }

    #[test]
    fn timed_system_fallback_deduplicates_but_untimed_events_do_not() {
        let (mut model, state) = model(10);
        let room = channel_name(&state, "#room");
        model.ensure_buffer(NameKey::Channel(room.clone()), None, None);
        for server_time_ms in [Some(10), Some(10), None, None] {
            model.receive_membership_event(
                &room,
                MembershipKind::Joined,
                "mel".into(),
                None,
                None,
                server_time_ms,
                20,
            );
        }

        assert_eq!(take_changed_items(&mut model).len(), 3);
    }

    #[test]
    fn history_kick_of_another_user_keeps_its_reason_without_changing_status() {
        let (mut model, state) = model(10);
        let room = channel_name(&state, "#room");
        model.ensure_buffer(NameKey::Channel(room.clone()), None, None);
        let buffer_id = model.names[&NameKey::Channel(room.clone())];
        model.receive_kick(
            &room,
            "operator".into(),
            "mel".into(),
            false,
            Some("too loud".into()),
            Some("kick-1".into()),
            Some(10),
            10,
            false,
        );

        let item = take_changed_items(&mut model).pop().expect("kick row");
        assert!(matches!(
            item.body,
            ItemBody::System(system) if matches!(
                system.line,
                crate::timeline::SystemLine::Event {
                    event: crate::timeline::LineEvent::Kick { ref reason, .. }
                } if reason.as_deref() == Some("too loud")
            )
        ));
        assert_ne!(
            model.buffers[&buffer_id].projection.channel_status,
            Some(crate::ChannelStatus::Kicked),
        );
    }

    #[test]
    fn message_projection_keeps_action_and_bot_metadata() {
        let (mut model, state) = model(10);
        let mut message = incoming(
            &state,
            "waves",
            Some("action"),
            Some(1),
            1,
            TimelineOrigin::Live,
        );
        message.kind = crate::MessageKind::Action;
        message.bot = Some(true);

        model.receive_incoming(message, &state);
        let projection = take_changed_messages(&mut model)
            .pop()
            .expect("message projection")
            .1;
        assert_eq!(projection.kind, crate::MessageKind::Action);
        assert_eq!(projection.bot, Some(true));
    }

    #[test]
    fn local_notices_do_not_replace_chat_previews_or_create_unread() {
        let (mut model, state) = model(10);
        let buffer = model.add_buffer(
            NameKey::Channel(channel_name(&state, "#room")),
            BufferKind::Channel,
            None,
            None,
            Some("A quiet room".into()),
        );

        model.receive_incoming(
            incoming(&state, "hello", Some("m1"), None, 1, TimelineOrigin::Live),
            &state,
        );
        let unread_before = model.buffers[&buffer.id].projection.unread;
        let activity_before = model.buffers[&buffer.id].projection.last_activity_ms;
        model
            .append_notice(buffer.id, "A quiet room".into(), crate::NoticeKind::Info)
            .expect("notice row");
        let notice = take_changed_messages(&mut model)
            .pop()
            .expect("notice projection")
            .1;
        assert!(matches!(
            notice.kind,
            crate::MessageKind::Notice(crate::NoticeKind::Info)
        ));
        assert!(notice.author.is_empty());
        assert_eq!(
            model.buffers[&buffer.id]
                .projection
                .last_message
                .as_ref()
                .map(|message| message.text.as_str()),
            Some("hello")
        );
        assert_eq!(
            model.buffers[&buffer.id]
                .timeline
                .last()
                .and_then(chat_projection)
                .map(|message| &message.kind),
            Some(&crate::MessageKind::Notice(crate::NoticeKind::Info))
        );
        assert_eq!(model.buffers[&buffer.id].projection.unread, unread_before);
        assert_eq!(
            model.buffers[&buffer.id].projection.last_activity_ms,
            activity_before
        );
        assert_eq!(
            model.chat_list_snapshot("network".into()).rows[0].last_activity_ms,
            activity_before
        );
    }

    #[test]
    fn add_buffer_stores_its_initial_topic_atomically() {
        let (mut model, state) = model(10);
        let buffer = model.add_buffer(
            NameKey::Channel(channel_name(&state, "#room")),
            BufferKind::Channel,
            None,
            None,
            Some("A quiet room".into()),
        );

        assert_eq!(buffer.topic.as_deref(), Some("A quiet room"));
        assert_eq!(
            model.buffers[&buffer.id].projection.topic.as_deref(),
            Some("A quiet room")
        );
    }

    #[test]
    fn mark_all_read_uses_each_buffers_latest_committed_row() {
        let (mut model, state) = model(10);
        for (index, text) in ["one", "two"].into_iter().enumerate() {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    Some(i64::try_from(index + 1).expect("small index") * 1_000),
                    i64::try_from(index).expect("small index"),
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }

        let advances = model.request_mark_all_read();
        let [advance] = advances.as_slice() else {
            panic!("one advance expected");
        };
        let events = model.advance_read(advance.buffer_id, advance.time, false);
        assert!(events.iter().any(|event| matches!(
            event,
            crate::EngineToUi::BufferUpdated { buffer }
                if buffer.read_at_ms == Some(time_millis(advance.time))
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            crate::EngineToUi::BufferUpdated { buffer } if buffer.unread == 0
        )));
    }

    #[test]
    fn mark_all_read_clears_a_provisional_push_locally() {
        let (mut model, state) = model(10);
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "weblounge",
            "msgid": "pushed-direct",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");
        model.restore_pushed_messages(vec![pushed], &state);

        let advances = model.request_mark_all_read();
        let [advance] = advances.as_slice() else {
            panic!("one immediate advance expected");
        };
        let events = model.advance_read(advance.buffer_id, advance.time, true);

        assert!(events.iter().any(|event| matches!(
            event,
            crate::EngineToUi::BufferUpdated { buffer }
                if buffer.unread == 0 && buffer.mentions == 0
        )));
        assert_eq!(
            model.buffers[&advance.buffer_id].read_facts.pending(),
            Some(ServerTimeMs::new(time_millis(advance.time)))
        );
    }

    #[test]
    fn authoritative_push_reconciliation_carries_an_intervening_read() {
        let (mut model, state) = model(10);
        model.receive_incoming(
            incoming(
                &state,
                "verified earlier",
                Some("verified"),
                Some(1_000),
                1_000,
                TimelineOrigin::History,
            ),
            &state,
        );
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "missing-from-history",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");
        model.restore_pushed_messages(vec![pushed], &state);
        let (buffer_id, pushed_id) = take_changed_messages(&mut model)
            .iter()
            .find(|(_, message)| message.text == "arrived while closed")
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("pushed row is restored");
        let advance = model
            .request_mark_read(buffer_id, pushed_id)
            .expect("push-only reads advance immediately");
        model.advance_read(buffer_id, advance.time, true);
        let pushed_time = time_millis(advance.time);

        model.receive_incoming(
            incoming(
                &state,
                "arrived while closed",
                Some("missing-from-history"),
                Some(pushed_time + 1),
                pushed_time + 1,
                TimelineOrigin::History,
            ),
            &state,
        );
        assert_eq!(
            model.buffers[&buffer_id].read_facts.mark(),
            Some(ServerTimeMs::new(pushed_time + 1))
        );
    }

    #[test]
    fn late_server_mark_carries_a_reconciled_push_read() {
        let (mut model, state) = model(10);
        model.restore_pushed_messages(vec![pushed_channel_message()], &state);
        let pushed_time = 1_793_709_296_789;
        model.receive_incoming(
            incoming(
                &state,
                "arrived while closed",
                Some("pushed-one"),
                Some(pushed_time + 1),
                pushed_time + 1,
                TimelineOrigin::History,
            ),
            &state,
        );
        let conversation = papo::Conversation::Channel(channel_name(&state, "#room"));

        let (_, advance) = model.apply_server_read_marker_with_advance(
            &conversation,
            Some(system_time_from_millis(pushed_time)),
        );

        let buffer_id = model.names[&NameKey::Channel(channel_name(&state, "#room"))];
        assert_eq!(
            time_millis(advance.expect("repair advance").time),
            pushed_time + 1
        );
        assert_eq!(model.buffers[&buffer_id].projection.unread, 0);
    }

    #[test]
    fn reconciled_push_carry_survives_a_snapshot_reload() {
        let (mut live, state) = model(10);
        live.restore_pushed_messages(vec![pushed_channel_message()], &state);
        let pushed_time = 1_793_709_296_789;
        live.receive_incoming(
            incoming(
                &state,
                "arrived while closed",
                Some("pushed-one"),
                Some(pushed_time + 1),
                pushed_time + 1,
                TimelineOrigin::History,
            ),
            &state,
        );
        let encoded = live
            .chat_list_snapshot("network".into())
            .encode()
            .expect("encode snapshot");
        let snapshot = ChatListSnapshot::decode(&encoded, "network").expect("decode snapshot");
        let (mut restored, restored_state) = model(10);
        restored.restore_chat_list(snapshot);
        let conversation = papo::Conversation::Channel(channel_name(&restored_state, "#room"));

        restored
            .apply_server_read_marker(&conversation, Some(system_time_from_millis(pushed_time)));

        let buffer_id = restored.names[&NameKey::Channel(channel_name(&restored_state, "#room"))];
        assert_eq!(restored.buffers[&buffer_id].projection.unread, 0);
        assert_eq!(
            restored.buffers[&buffer_id].projection.read_at_ms,
            Some(pushed_time + 1)
        );
    }

    #[test]
    fn reading_another_buffer_keeps_a_pending_push_read() {
        let (mut model, state) = model(10);
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");
        model.restore_pushed_messages(vec![pushed], &state);
        let (buffer_id, pushed_id) = take_changed_messages(&mut model)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("pushed row is restored");
        let advance = model
            .request_mark_read(buffer_id, pushed_id)
            .expect("push-only reads advance immediately");
        model.advance_read(buffer_id, advance.time, true);
        let mut elsewhere = incoming(
            &state,
            "verified elsewhere",
            Some("elsewhere"),
            Some(2_000),
            2_000,
            TimelineOrigin::History,
        );
        elsewhere.destination =
            IncomingDestination::Conversation(NameKey::Channel(channel_name(&state, "#elsewhere")));
        model.receive_incoming(elsewhere, &state);
        let elsewhere_id = take_changed_messages(&mut model)
            .first()
            .map(|(_, message)| message.id)
            .expect("other buffer row is appended");
        let elsewhere_buffer = model.names[&NameKey::Channel(channel_name(&state, "#elsewhere"))];
        assert!(
            model
                .request_mark_read(elsewhere_buffer, elsewhere_id)
                .is_some()
        );
        assert_eq!(
            model.buffers[&buffer_id].read_facts.pending(),
            Some(ServerTimeMs::new(time_millis(advance.time)))
        );
    }

    #[test]
    fn fallback_deduplicates_history_overlap_but_retains_live_collisions() {
        let (mut model, state) = model(10);
        let first = incoming(&state, "same", None, Some(1_000), 10, TimelineOrigin::Live);
        model.receive_incoming(first.clone(), &state);
        model.receive_incoming(first.clone(), &state);
        let mut history = first;
        history.origin = TimelineOrigin::History;
        history.received_at_ms = 20;
        assert!(model.receive_incoming(history, &state).is_empty());

        assert_eq!(timeline(&model), ["same", "same"]);
    }

    #[test]
    fn opening_ready_history_does_not_request_an_older_page() {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        let buffer = model.buffers.get_mut(&buffer_id).expect("buffer exists");
        buffer.history = HistoryState::Ready {
            oldest: Some(papo::HistoryReference::from(papo::MessageId::from(
                "oldest",
            ))),
            at_start: false,
        };

        assert!(model.request_latest_channel(&channel).is_none());
        assert!(
            model
                .request_history(buffer_id, crate::HistoryDirection::Latest)
                .is_none()
        );
        let Some(HistoryFetch::Before { oldest, .. }) =
            model.request_history(buffer_id, crate::HistoryDirection::Older)
        else {
            panic!("older history remains requestable");
        };
        assert_eq!(
            oldest,
            papo::HistoryReference::from(papo::MessageId::from("oldest"))
        );
    }

    #[test]
    fn unread_count_survives_timeline_eviction_and_relaunch() {
        let (mut live, state) = model(2);
        for (index, text) in ["one", "two", "three"].into_iter().enumerate() {
            live.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    None,
                    i64::try_from(index).expect("small index"),
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        _ = live.take_timeline_changes(false);

        assert_eq!(timeline(&live), ["two", "three"]);
        let buffer = live
            .buffers
            .values()
            .find(|buffer| buffer.projection.kind == BufferKind::Channel)
            .expect("channel buffer");
        assert_eq!(
            (buffer.projection.unread, buffer.projection.mentions),
            (3, 0)
        );

        let snapshot = live.chat_list_snapshot("network".into());
        let (mut relaunched, _) = model(2);
        relaunched.restore_chat_list(snapshot);
        let restored = relaunched
            .buffers
            .values()
            .find(|buffer| buffer.projection.kind == BufferKind::Channel)
            .expect("restored channel");
        assert_eq!(
            (restored.projection.unread, restored.projection.mentions),
            (3, 0)
        );
    }

    #[test]
    fn msgidless_stub_identity_remains_unique_after_relaunch() {
        let (mut live, state) = model(10);
        live.receive_incoming(
            incoming(
                &state,
                "before relaunch",
                None,
                Some(1),
                1,
                TimelineOrigin::Live,
            ),
            &state,
        );
        let snapshot = live.chat_list_snapshot("network".into());
        let (mut relaunched, _) = model(10);
        relaunched.restore_chat_list(snapshot);

        relaunched.receive_incoming(
            incoming(
                &state,
                "after relaunch",
                None,
                Some(2),
                2,
                TimelineOrigin::Live,
            ),
            &state,
        );

        let buffer = relaunched
            .buffers
            .values()
            .find(|buffer| buffer.projection.kind == BufferKind::Channel)
            .expect("restored channel");
        assert_eq!(buffer.projection.unread, 2);
    }

    #[test]
    fn reset_replays_each_buffers_retained_rows_in_order() {
        let (mut model, state) = model(2);
        for (index, text) in ["one", "two", "three"].into_iter().enumerate() {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    Some(i64::try_from(index).expect("small index")),
                    0,
                    TimelineOrigin::History,
                ),
                &state,
            );
        }
        _ = model.take_timeline_changes(false);

        let resets = model
            .take_timeline_changes(true)
            .into_iter()
            .map(|event| match event {
                crate::EngineToUi::TimelineChanged { upserted, .. } => upserted
                    .into_iter()
                    .filter_map(|item| match item.body {
                        ItemBody::Message(message) => Some(message.text),
                        ItemBody::System(_) | ItemBody::Gap(_) => None,
                    })
                    .collect::<Vec<_>>(),
                other => panic!("unexpected reset event {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(resets, [vec![], vec!["two".to_owned(), "three".to_owned()]]);
    }

    #[test]
    fn dedup_indexes_plateau_with_the_timeline_window() {
        let (mut msgid_model, state) = model(2);
        for index in 0..100 {
            let value = index.to_string();
            msgid_model.receive_incoming(
                incoming(
                    &state,
                    &value,
                    Some(&value),
                    None,
                    index,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        _ = msgid_model.take_timeline_changes(false);
        assert_eq!(msgid_model.msgids.len(), 2);

        let (mut fallback_model, state) = model(2);
        for index in 0..100 {
            fallback_model.receive_incoming(
                incoming(
                    &state,
                    &index.to_string(),
                    None,
                    Some(index),
                    index,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        _ = fallback_model.take_timeline_changes(false);
        assert_eq!(fallback_model.fallbacks.len(), 2);
    }

    #[test]
    fn failed_send_updates_the_optimistic_timeline_row() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);
        let (pending, _) = model
            .begin_send(buffer.id, "will fail".into(), &state)
            .expect("channel is sendable");

        let events = model.fail_send(&pending, EngineMessageKey::SendFailed);

        let record = &model.buffers[&buffer.id].timeline[0];
        assert_eq!(
            chat_projection(record).expect("chat record").delivery,
            crate::MessageDelivery::Failed
        );
        assert!(matches!(
            events.as_slice(),
            [EngineToUi::MessageFailed {
                network_id: NetworkId(1),
                buffer_id,
                target,
                ..
            }] if *buffer_id == buffer.id && target == "#room"
        ));
    }

    #[test]
    fn own_history_reconciles_a_matching_failed_send() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);
        let (pending, _) = model
            .begin_send(buffer.id, "accepted before disconnect".into(), &state)
            .expect("channel is sendable");
        model.interrupt_send(&pending);
        let mut authoritative = incoming(
            &state,
            "accepted before disconnect",
            Some("server-id"),
            Some(100),
            100,
            TimelineOrigin::History,
        );
        authoritative.author = "weblounge".into();
        authoritative.authorship = MessageAuthorship::Own;

        model.receive_incoming(authoritative, &state);

        let timeline = &model.buffers[&buffer.id].timeline;
        assert_eq!(timeline.len(), 1);
        assert_eq!(
            chat_projection(&timeline[0]).expect("chat record").delivery,
            crate::MessageDelivery::Confirmed
        );
        assert_eq!(
            chat_projection(&timeline[0])
                .expect("chat record")
                .server_ids,
            ["server-id"]
        );
        let changed = take_changed_messages(&mut model);
        assert_eq!(changed[0].0, buffer.id);
        assert_eq!(changed[0].1.delivery, crate::MessageDelivery::Confirmed);
    }

    #[test]
    fn optimistic_action_projects_semantic_text() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);

        model
            .begin_action(buffer.id, "hides".into(), &state)
            .expect("channel is sendable");
        let message = take_changed_messages(&mut model)
            .pop()
            .expect("optimistic action")
            .1;
        assert_eq!(message.kind, crate::MessageKind::Action);
        assert_eq!(message.text, "hides");
        assert_eq!(message.delivery, crate::MessageDelivery::Optimistic);
    }

    #[test]
    fn retrying_a_failed_send_reuses_its_row_and_payload() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);
        let (pending, _) = model
            .begin_send(buffer.id, "try\n\n\nagain".into(), &state)
            .expect("channel is sendable");
        assert_eq!(pending.text, "try\n\n\nagain");
        assert_eq!(timeline(&model), ["try\n\nagain"]);
        model.fail_send(&pending, EngineMessageKey::SendFailed);

        let retried = model
            .retry_send(buffer.id, pending.local_send_id)
            .expect("failed send retries");

        assert_eq!(retried.text, "try\n\n\nagain");
        assert_eq!(retried.local_send_id, pending.local_send_id);
        assert_eq!(
            chat_projection(&model.buffers[&buffer.id].timeline[0])
                .expect("chat record")
                .delivery,
            crate::MessageDelivery::Optimistic
        );
        assert_eq!(
            take_changed_messages(&mut model)[0].1.delivery,
            crate::MessageDelivery::Optimistic
        );
    }

    #[test]
    fn optimistic_send_uses_the_platform_wall_clock() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);
        let before = time_millis(papo::time::now());

        model
            .begin_send(buffer.id, "timestamped".into(), &state)
            .expect("channel is sendable");
        let after = time_millis(papo::time::now());
        let message = take_changed_messages(&mut model)
            .pop()
            .expect("optimistic message")
            .1;
        assert!(message.received_at_ms >= before);
        assert!(message.received_at_ms <= after);
    }

    #[test]
    fn nick_palette_index_follows_server_casemapping() {
        assert_eq!(
            nick_color_index(papo::Casemapping::Rfc1459, "Alice["),
            nick_color_index(papo::Casemapping::Rfc1459, "ALICE{")
        );
        assert_ne!(
            nick_color_index(papo::Casemapping::Ascii, "Alice["),
            nick_color_index(papo::Casemapping::Ascii, "ALICE{")
        );
    }

    #[test]
    fn direct_buffer_projects_the_peer_nick_palette_index() {
        let (mut model, state) = model(10);
        let buffer = model.add_buffer(
            NameKey::Direct(nick_name(&state, "Alice[")),
            BufferKind::Direct,
            None,
            None,
            None,
        );

        assert_eq!(
            buffer.nick_color_index,
            Some(nick_color_index(state.casemapping(), "Alice["))
        );
    }

    #[test]
    fn draft_keys_use_the_network_and_irc_casemapped_name() {
        assert_eq!(
            draft_key("Test", "#ROOM[", papo::Casemapping::Rfc1459),
            "4:Test:rfc1459:#room{"
        );
        assert_ne!(
            draft_key("Other", "#ROOM[", papo::Casemapping::Rfc1459),
            "4:Test:rfc1459:#room{"
        );
    }

    #[tokio::test]
    async fn account_discovery_keeps_the_nick_key_and_verifies_the_thread() {
        let (client, mut events, mut wire) = wire(secure_wire_builder());
        wire.register(&[
            "account-notify",
            "account-tag",
            "extended-join",
            "message-tags",
        ])
        .await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        wire.server(":alice!a@host JOIN #room * :Alice").await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}

        let before_account = client.direct("alice").await.expect("shared user is direct");
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (buffer_id, _) = model.open_direct(
            before_account.nick(),
            super::DirectAvailability::Guarded(before_account.clone()),
            &client.state(),
        );
        assert_eq!(
            model.buffers[&buffer_id].projection.direct_identity,
            Some(crate::DirectIdentityState::Unverified)
        );
        let nick_draft_key = model.buffers[&buffer_id].projection.draft_key.clone();
        let read_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        model.advance_read(buffer_id, read_at, false);
        model.close_direct(buffer_id).expect("direct closes");

        wire.server(":alice!a@host ACCOUNT alice-account").await;
        let account_changed = loop {
            if let Some(papo::Event::AccountChanged(changed)) = events.next().await {
                break changed;
            }
        };
        let identity_events =
            model.update_direct_account(account_changed.actor.nick(), &account_changed.new);
        assert_eq!(
            model.directs.get(&DirectKey("alice".into())),
            Some(&buffer_id)
        );
        assert!(identity_events.iter().any(|event| matches!(
            event,
            EngineToUi::DraftKeyChanged { previous, current }
                if previous.contains("account=alice-account") && current == &nick_draft_key
        )));
        wire.server("@account=alice-account :alice!a@host PRIVMSG weblounge :hello after account")
            .await;
        let message = loop {
            if let Some(papo::Event::Message(message)) = events.next().await {
                break message;
            }
        };
        let _after_account = client
            .direct_to(&message)
            .await
            .expect("private message proves its sender");

        let received = model.receive(&message, false, &client.state(), None);
        assert_verified_account_upgrade(&model, buffer_id, &nick_draft_key, read_at, &received);

        wire.server(":alice!a@host ACCOUNT replacement-account")
            .await;
        while !matches!(events.next().await, Some(papo::Event::AccountChanged(_))) {}
        wire.server(
            "@account=replacement-account :alice!a@host PRIVMSG weblounge :replacement sender",
        )
        .await;
        let replacement_message = loop {
            if let Some(papo::Event::Message(message)) = events.next().await {
                break message;
            }
        };
        model.receive(&replacement_message, false, &client.state(), None);
        assert_eq!(
            model.buffers[&buffer_id].projection.direct_identity,
            Some(crate::DirectIdentityState::DifferentAccount)
        );
        assert_eq!(
            model.buffers[&buffer_id]
                .timeline
                .last()
                .and_then(chat_projection)
                .and_then(|message| message.unverified_sender),
            Some(true)
        );
        let replacement = client
            .direct_to(&replacement_message)
            .await
            .expect("replacement direct opens");
        assert!(
            model
                .trust_direct_identity(buffer_id, replacement.clone())
                .is_some()
        );
        assert_eq!(
            model.buffers[&buffer_id].projection.direct_identity,
            Some(crate::DirectIdentityState::Verified)
        );
    }

    #[tokio::test]
    async fn matching_continuity_pin_adds_a_note_without_rekeying_the_thread() {
        let (client, mut events, mut wire) = wire(secure_wire_builder());
        wire.register(&["extended-join"]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        wire.server(":alice!a@host JOIN #room * :Alice").await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        let direct = client.direct("alice").await.expect("direct opens");
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (old_buffer, _) = model.open_direct(
            direct.nick(),
            super::DirectAvailability::Guarded(direct),
            &client.state(),
        );

        wire.server(":alice!a@host NICK alicia").await;
        let changed = loop {
            if let Some(papo::Event::NickChanged(changed)) = events.next().await {
                break changed;
            }
        };
        let note = model.note_direct_rename(changed.actor.nick(), &changed.new, changed.peer_key());
        assert!(note.is_empty());
        let message = take_changed_messages(&mut model)
            .pop()
            .expect("rename note")
            .1;
        assert_eq!(message.text, "alice is now alicia");
        assert!(matches!(
            message.kind,
            crate::MessageKind::Notice(crate::NoticeKind::Info)
        ));
        assert_eq!(model.buffers[&old_buffer].projection.title, "alice");
        assert!(!model.directs.contains_key(&DirectKey("alicia".into())));
    }

    #[tokio::test]
    async fn two_nicks_on_one_account_keep_separate_direct_threads() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@host JOIN #room own-account :WebLounge")
            .await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        wire.server(":alice!a@host JOIN #room alice-account :Alice")
            .await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        wire.server(":alice-phone!a@phone JOIN #room alice-account :Alice Phone")
            .await;
        while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        let desktop = client
            .direct("alice")
            .await
            .expect("desktop nick is directly addressable");
        let same_account = client
            .direct("alice-phone")
            .await
            .expect("second nick is directly addressable");
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (buffer_id, _) = model.open_direct(
            desktop.nick(),
            super::DirectAvailability::Guarded(desktop),
            &client.state(),
        );
        let (phone_buffer, added) = model.open_direct(
            same_account.nick(),
            super::DirectAvailability::Guarded(same_account),
            &client.state(),
        );
        assert_ne!(phone_buffer, buffer_id);
        assert!(!added.is_empty());
        assert_eq!(model.directs.len(), 2);
        assert!(model.buffers[&buffer_id].direct_pin.is_some());
        model.invalidate_direct_handles();
        let alice = client
            .state()
            .name_rules()
            .expect("registered test client has name rules")
            .nick("alice");
        assert!(matches!(
            model.direct(&alice),
            Some(super::DirectAvailability::Pending)
        ));
        assert!(model.buffers[&buffer_id].direct_pin.is_none());
        assert_eq!(
            model.directs.get(&DirectKey("alice".into())),
            Some(&buffer_id)
        );
        assert_eq!(
            model.directs.get(&DirectKey("alice-phone".into())),
            Some(&phone_buffer)
        );
        assert_eq!(direct_buffer_count(&model), 2);
    }

    #[test]
    fn completion_candidates_follow_command_channel_and_recent_nick_order() {
        let (mut model, state) = model(10);
        let mut first = incoming(&state, "first", Some("one"), None, 1, TimelineOrigin::Live);
        first.author = "Alice[".into();
        model.receive_incoming(first, &state);
        let mut second = incoming(&state, "second", Some("two"), None, 2, TimelineOrigin::Live);
        second.author = "bob".into();
        model.receive_incoming(second, &state);
        let buffer_id = model.names[&NameKey::Channel(channel_name(&state, "#room"))];

        assert_eq!(
            model.recent_speakers(buffer_id, "", &state),
            ["bob", "Alice["]
        );
        assert_eq!(model.channel_names(), ["#room"]);
        assert_eq!(model.recent_speakers(buffer_id, "BOB", &state), ["bob"]);
        assert_eq!(
            model.recent_speakers(buffer_id, "alice{", &state),
            ["Alice["]
        );
    }

    #[test]
    fn closing_a_direct_buffer_hides_its_retained_state() {
        let (mut model, state) = model(10);
        let key = NameKey::Direct(nick_name(&state, "alice"));
        let (buffer_id, _) = model.ensure_buffer(key.clone(), None, None);
        assert!(model.close_direct(buffer_id).is_some());
        assert!(!model.buffer_order.contains(&buffer_id));
        assert!(model.buffers.contains_key(&buffer_id));
        assert_eq!(model.names.get(&key), Some(&buffer_id));
    }

    #[test]
    fn closed_direct_reopens_only_for_peer_activity() {
        let (mut model, state) = model(10);
        let key = NameKey::Direct(nick_name(&state, "alice"));
        let (buffer_id, _) = model.ensure_buffer(key.clone(), None, None);
        model.close_direct(buffer_id).expect("direct closes");

        let mut own = incoming(
            &state,
            "from another device",
            Some("own"),
            None,
            1,
            TimelineOrigin::Live,
        );
        own.destination = IncomingDestination::Conversation(key.clone());
        own.authorship = MessageAuthorship::Own;
        model.receive_incoming(own, &state);
        assert!(!model.buffer_order.contains(&buffer_id));

        let mut peer = incoming(
            &state,
            "from alice",
            Some("peer"),
            None,
            2,
            TimelineOrigin::Live,
        );
        peer.destination = IncomingDestination::Conversation(key);
        let events = model.receive_incoming(peer, &state);
        assert!(model.buffer_order.contains(&buffer_id));
        assert!(matches!(
            events.first(),
            Some(EngineToUi::BufferAdded { buffer }) if buffer.id == buffer_id
        ));
    }

    #[test]
    fn own_device_lines_are_rows_without_unread_counts() {
        let (mut model, state) = model(10);
        let mut own = incoming(
            &state,
            "from phone",
            Some("phone-1"),
            None,
            1,
            TimelineOrigin::Live,
        );
        own.authorship = MessageAuthorship::Own;
        model.receive_incoming(own, &state);

        let id = *model
            .names
            .values()
            .next()
            .expect("directly received buffer exists");
        assert_eq!(model.buffers[&id].projection.unread, 0);
        assert_eq!(timeline(&model), ["from phone"]);
    }

    #[test]
    fn own_device_lines_mark_earlier_peer_messages_read_only_through_advance() {
        let (mut model, state) = model(10);
        model.receive_incoming(direct_incoming(&state, "alice", "unread peer", 1), &state);
        let mut own = direct_incoming(&state, "alice", "from phone", 2);
        own.authorship = MessageAuthorship::Own;
        model.receive_incoming(own, &state);

        let id = *model
            .names
            .values()
            .next()
            .expect("directly received buffer exists");
        assert_eq!(model.buffers[&id].projection.unread, 1);
        assert_eq!(model.buffers[&id].projection.read_at_ms, None);
        assert_eq!(model.buffers[&id].read_facts.mark(), None);

        let own_id = chat_projection(&model.buffers[&id].timeline[1])
            .expect("chat record")
            .id;
        let advance = model
            .prepare_mark_read(id, own_id)
            .expect("committed own message has an advance");
        model.advance_read(id, advance.time, true);

        let buffer = &model.buffers[&id];
        assert_eq!(buffer.projection.unread, 0);
        assert_eq!(
            buffer.projection.read_at_ms,
            Some(time_millis(advance.time))
        );
        assert_eq!(
            buffer.read_facts.pending(),
            Some(ServerTimeMs::new(time_millis(advance.time)))
        );
    }

    #[test]
    fn mention_requires_the_own_nick_as_a_word() {
        let (mut model, state) = model(10);
        for text in ["hello weblounge!", "hello weblounge2"] {
            model.receive_incoming(
                incoming(&state, text, Some(text), None, 1, TimelineOrigin::Live),
                &state,
            );
        }
        let id = *model.names.values().next().expect("buffer exists");

        assert_eq!(model.buffers[&id].projection.mentions, 1);
    }

    #[test]
    fn unmarked_channel_seed_makes_old_history_read_and_later_traffic_unread() {
        let (mut model, state) = model(10);
        model.begin_target_sync(UNIX_EPOCH + Duration::from_millis(250));
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("latest history starts");
        for (text, time) in [("hello seed-a", 100), ("hello weblounge", 200)] {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(text),
                    Some(time),
                    time,
                    TimelineOrigin::History,
                ),
                &state,
            );
        }
        model
            .finish_history(
                &papo::Conversation::Channel(channel),
                None,
                None,
                Some(HistoryCursor::new(Some("history-latest".into()), 200)),
                2,
                true,
            )
            .expect("latest history finishes");

        let buffer = &model.buffers[&buffer_id];
        assert_eq!(
            (buffer.projection.unread, buffer.projection.mentions),
            (0, 0)
        );
        assert_eq!(buffer.read_facts.mark(), Some(ServerTimeMs::new(249)));

        for (text, msgid, time) in [
            ("ordinary live row", "live-ordinary", 300),
            ("hello seed-a", "live-other-nick", 400),
            ("hello weblounge", "live-own-nick", 500),
        ] {
            model.receive_incoming(
                incoming(
                    &state,
                    text,
                    Some(msgid),
                    Some(time),
                    time,
                    TimelineOrigin::Live,
                ),
                &state,
            );
        }
        let buffer = &model.buffers[&buffer_id];
        assert_eq!(
            (buffer.projection.unread, buffer.projection.mentions),
            (3, 1)
        );
    }

    #[test]
    fn pushed_channel_message_remains_unread_before_reconnect_seed() {
        let (mut model, state) = model(10);
        model.restore_chat_list(
            ChatListSnapshot::new("network".into(), Vec::new()).with_cursor_ms(Some(100)),
        );
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-before-reconnect",
            "time": "1970-01-01T00:00:00.200Z",
            "text": "hello weblounge",
            "kind": "message",
        }))
        .expect("pushed message");

        model.restore_pushed_messages(vec![pushed], &state);
        let channel = channel_name(&state, "#room");
        let buffer_id = model.names[&NameKey::Channel(channel)];
        assert_eq!(
            (
                model.buffers[&buffer_id].projection.unread,
                model.buffers[&buffer_id].projection.mentions,
            ),
            (1, 1)
        );

        model.receive_incoming(
            incoming(
                &state,
                "hello weblounge",
                Some("pushed-before-reconnect"),
                Some(200),
                200,
                TimelineOrigin::History,
            ),
            &state,
        );
        assert_eq!(
            (
                model.buffers[&buffer_id].projection.unread,
                model.buffers[&buffer_id].projection.mentions,
            ),
            (1, 1)
        );
        assert_eq!(model.buffers[&buffer_id].timeline.len(), 1);

        model.advance_read(buffer_id, UNIX_EPOCH + Duration::from_millis(200), false);
        assert_eq!(
            (
                model.buffers[&buffer_id].projection.unread,
                model.buffers[&buffer_id].projection.mentions,
            ),
            (0, 0)
        );
    }

    #[test]
    fn seeded_mark_persists_and_offline_unmarked_traffic_stays_unread() {
        let (mut first, state) = model(10);
        first.begin_target_sync(UNIX_EPOCH + Duration::from_millis(250));
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = first.ensure_buffer(NameKey::Channel(channel.clone()), None, None);
        first
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("initial history starts");
        first.receive_incoming(
            incoming(
                &state,
                "old history",
                Some("old-history"),
                Some(200),
                200,
                TimelineOrigin::History,
            ),
            &state,
        );
        first
            .finish_history(
                &papo::Conversation::Channel(channel.clone()),
                None,
                None,
                Some(HistoryCursor::new(Some("old-history".into()), 200)),
                1,
                true,
            )
            .expect("initial history finishes");
        first.finish_target_sync(Some(UNIX_EPOCH + Duration::from_millis(300)));

        let snapshot = first.chat_list_snapshot("network".into());
        assert_eq!(snapshot.rows[0].read_at_ms, Some(249));
        assert_eq!(snapshot.cursor_ms, Some(300));

        let mut relaunched = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 10);
        relaunched.restore_chat_list(snapshot);
        relaunched.begin_target_sync(UNIX_EPOCH + Duration::from_millis(400));
        let buffer_id = relaunched.names[&NameKey::Channel(channel.clone())];
        relaunched
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("offline delta starts");
        relaunched.receive_incoming(
            incoming(
                &state,
                "offline traffic",
                Some("offline-traffic"),
                Some(350),
                350,
                TimelineOrigin::History,
            ),
            &state,
        );
        relaunched
            .finish_history(
                &papo::Conversation::Channel(channel),
                None,
                None,
                Some(HistoryCursor::new(Some("offline-traffic".into()), 350)),
                1,
                true,
            )
            .expect("offline delta finishes");

        let buffer = &relaunched.buffers[&buffer_id];
        assert_eq!(buffer.read_facts.mark(), Some(ServerTimeMs::new(249)));
        assert_eq!(buffer.projection.unread, 1);
    }

    #[test]
    fn mention_badges_and_row_highlights_are_distinct() {
        let cases = [
            ("direct without nick", true, "hello", 1, false),
            ("direct with nick", true, "hello weblounge", 1, true),
            ("channel with nick", false, "hello weblounge", 1, true),
            ("channel without nick", false, "hello", 0, false),
        ];
        for (name, direct, text, expected_mentions, expected_highlight) in cases {
            let (mut model, state) = model(10);
            let message = if direct {
                direct_incoming(&state, "alice", text, 1)
            } else {
                incoming(&state, text, Some(name), None, 1, TimelineOrigin::Live)
            };
            model.receive_incoming(message, &state);
            let id = *model.names.values().next().expect("buffer exists");
            let buffer = &model.buffers[&id];

            assert_eq!(buffer.projection.unread, 1, "{name}");
            assert_eq!(buffer.projection.mentions, expected_mentions, "{name}");
            assert_eq!(
                chat_projection(&buffer.timeline[0])
                    .expect("chat record")
                    .highlighted,
                expected_highlight,
                "{name}"
            );
        }
    }

    #[test]
    fn send_targets_round_trip_through_name_keys() {
        let (_, state) = model(10);
        let channel = NameKey::Channel(channel_name(&state, "#room"));
        let target =
            SendTarget::from_buffer(channel.clone(), None, None, false).expect("channel target");
        assert_eq!(target.name_key(), channel);
    }

    #[test]
    fn cached_direct_send_keeps_waiting_when_targets_reports_no_change() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(1_000),
                stubs: snapshot_stubs(1, 0, 1_000),
                gap_until: None,
                preview: Some("hello".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let buffer_id = *model
            .names
            .get(&NameKey::Direct(nick_name(&state, "alice")))
            .expect("cached direct exists");
        let (mut pending, _) = model
            .begin_send(buffer_id, "queued".into(), &state)
            .expect("cached direct accepts an optimistic send");

        assert!(matches!(
            model.prepare_live_send(&mut pending),
            PendingTargetState::Waiting
        ));
        _ = model.mark_vanished_restored_rows();
        assert!(matches!(
            model.prepare_live_send(&mut pending),
            PendingTargetState::Waiting
        ));
    }

    #[test]
    fn opened_cached_channel_still_vanishes_when_targets_omit_it() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#gone".into(),
                },
                title: "#gone".into(),
                last_activity_ms: Some(1_000),
                stubs: snapshot_stubs(1, 0, 1_000),
                gap_until: None,
                preview: Some("cached".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let buffer_id = model.names[&NameKey::Channel(channel_name(&state, "#gone"))];
        let (mut pending, _) = model
            .begin_send(buffer_id, "queued".into(), &state)
            .expect("cached channel accepts an optimistic send");

        assert!(model.queue_latest_history(buffer_id));
        assert!(matches!(
            model.connected_history().as_slice(),
            [HistoryFetch::Latest(_)]
        ));
        assert!(model.buffers[&buffer_id].restored_from_snapshot);
        assert!(matches!(
            model.prepare_live_send(&mut pending),
            PendingTargetState::Waiting
        ));

        let events = model.mark_vanished_restored_rows();

        assert_eq!(model.buffers[&buffer_id].projection.available, Some(false));
        assert!(matches!(
            events.as_slice(),
            [EngineToUi::BufferUpdated { buffer }]
                if buffer.id == buffer_id && buffer.available == Some(false)
        ));
        assert!(matches!(
            model.prepare_live_send(&mut pending),
            PendingTargetState::Gone
        ));
    }

    #[test]
    fn opened_cached_direct_becomes_live_even_without_new_traffic() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(1_000),
                stubs: snapshot_stubs(3, 3, 1_000),
                gap_until: None,
                preview: Some("stale preview".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let buffer_id = model.names[&NameKey::Direct(nick_name(&state, "alice"))];

        assert!(model.queue_latest_history(buffer_id));
        _ = model.mark_vanished_restored_rows();
        assert!(model.buffers[&buffer_id].restored_from_snapshot);

        let fetches = model.connected_history();
        assert!(matches!(
            fetches.as_slice(),
            [HistoryFetch::Latest(HistoryTarget::Direct(_))]
        ));
        let buffer = &model.buffers[&buffer_id];
        assert!(buffer.restored_from_snapshot);
        assert_eq!(buffer.projection.preview.as_deref(), Some("stale preview"));
        assert_eq!(
            (buffer.projection.unread, buffer.projection.mentions),
            (3, 3)
        );
        assert!(matches!(buffer.history, HistoryState::LoadingLatest));

        let HistoryFetch::Latest(target) = &fetches[0] else {
            panic!("cached direct requests latest history")
        };
        let completion = model
            .finish_history(&target.conversation(), None, None, None, 0, false)
            .expect("latest history completes");
        assert_eq!(completion.buffer_id, buffer_id);
        assert_eq!(completion.at_start, Some(true));
        assert!(matches!(
            model.buffers[&buffer_id].history,
            HistoryState::Ready {
                oldest: None,
                at_start: true
            }
        ));
    }

    #[test]
    fn invalid_cached_peer_pin_is_treated_as_unverified() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: None,
                stubs: Vec::new(),
                gap_until: None,
                preview: None,
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: Some("not-a-peer-key".into()),
            }],
        ));
        let buffer_id = model.names[&NameKey::Direct(nick_name(&state, "alice"))];

        assert_eq!(
            model.buffers[&buffer_id].projection.direct_identity,
            Some(crate::DirectIdentityState::Unverified)
        );
        assert!(model.buffers[&buffer_id].direct_pin.is_none());
    }

    #[test]
    fn chat_list_snapshot_merges_authoritative_rows_with_unresolved_cache() {
        let (mut model, state) = model(10);
        let unresolved = SnapshotRow {
            conversation: SnapshotConversation::Channel {
                key: "#slow".into(),
            },
            title: "#slow cached".into(),
            last_activity_ms: Some(100),
            stubs: snapshot_stubs(4, 0, 100),
            gap_until: None,
            preview: Some("cached channel preview".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
        };
        let previous = ChatListSnapshot::new(
            "network".into(),
            vec![
                unresolved.clone(),
                SnapshotRow {
                    conversation: SnapshotConversation::Direct {
                        key: "alice".into(),
                    },
                    title: "Alice cached".into(),
                    last_activity_ms: Some(200),
                    stubs: snapshot_stubs(2, 2, 200),
                    gap_until: None,
                    preview: Some("cached direct preview".into()),
                    newest: None,
                    read_at_ms: None,
                    raw_read_at_ms: None,
                    pending_read_at_ms: None,
                    peer_pin: None,
                },
            ],
        );
        model.restore_chat_list(previous.clone());

        let alice = model.names[&NameKey::Direct(nick_name(&state, "alice"))];
        let slow = model.names[&NameKey::Channel(channel_name(&state, "#slow"))];
        let alice_buffer = model.buffers.get_mut(&alice).expect("alice buffer");
        alice_buffer.projection.title = "Alice live".into();
        alice_buffer.history = HistoryState::Ready {
            oldest: None,
            at_start: true,
        };
        let slow_buffer = model.buffers.get_mut(&slow).expect("slow buffer");
        slow_buffer.projection.title = "#slow provisional".into();
        slow_buffer.history = HistoryState::LoadingLatest;
        model.ensure_buffer(NameKey::Direct(nick_name(&state, "bob")), None, None);

        let merged = model.merge_chat_list_snapshot("network".into(), &previous);

        assert_eq!(merged.rows.len(), 2);
        assert!(merged.rows.contains(&unresolved));
        assert!(merged.rows.iter().any(|row| {
            row.title == "Alice live"
                && row.stubs.len() == 2
                && row.preview.as_deref() == Some("cached direct preview")
        }));
        assert!(merged.rows.iter().all(|row| row.title != "bob"));
    }

    #[test]
    fn live_direct_restores_a_snapshot_row_dropped_by_target_reconciliation() {
        let (mut model, state) = model(10);
        let cached_direct = SnapshotRow {
            conversation: SnapshotConversation::Direct {
                key: "alice".into(),
            },
            title: "alice".into(),
            last_activity_ms: Some(200),
            stubs: snapshot_stubs(1, 1, 200),
            gap_until: None,
            preview: Some("cached direct".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
        };
        let unresolved = SnapshotRow {
            conversation: SnapshotConversation::Channel {
                key: "#slow".into(),
            },
            title: "#slow".into(),
            last_activity_ms: Some(100),
            stubs: snapshot_stubs(4, 0, 100),
            gap_until: None,
            preview: Some("cached channel".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
        };
        let cached =
            ChatListSnapshot::new("network".into(), vec![cached_direct, unresolved.clone()]);
        model.restore_chat_list(cached.clone());
        let slow = model.names[&NameKey::Channel(channel_name(&state, "#slow"))];
        model.buffers.get_mut(&slow).expect("slow buffer").history = HistoryState::LoadingLatest;

        let after_targets = ChatListSnapshot::new("network".into(), vec![unresolved.clone()]);

        model.receive_incoming(
            direct_incoming(&state, "alice", "live return", 1_000),
            &state,
        );
        let alice = model.names[&NameKey::Direct(nick_name(&state, "alice"))];
        let through = chat_projection(model.buffers[&alice].timeline.last().expect("live direct"))
            .expect("chat record")
            .id;
        let advance = model
            .request_mark_read(alice, through)
            .expect("live direct read is authoritative");
        model.advance_read(alice, advance.time, false);

        let merged = model.merge_chat_list_snapshot("network".into(), &after_targets);

        assert!(merged.rows.contains(&unresolved));
        assert!(merged.rows.iter().any(|row| {
            row.conversation
                == SnapshotConversation::Direct {
                    key: "alice".into(),
                }
                && row.stubs.is_empty()
        }));
    }

    #[test]
    fn live_direct_replaces_a_stale_cached_edge_before_local_read() {
        let (mut model, state) = model(10);
        let previous = ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "alice".into(),
                last_activity_ms: Some(2_000),
                stubs: Vec::new(),
                gap_until: None,
                preview: Some("stale cached direct".into()),
                newest: Some(SnapshotCursor {
                    msgid: None,
                    server_time_ms: 2_000,
                }),
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        );
        model.restore_chat_list(previous.clone());

        model.receive_incoming(
            direct_incoming(&state, "alice", "authoritative live direct", 1_000),
            &state,
        );
        let alice = model.names[&NameKey::Direct(nick_name(&state, "alice"))];
        let buffer = &model.buffers[&alice];
        assert_eq!(buffer.projection.unread, 1);
        assert_eq!(
            buffer.newest.as_ref().map(super::HistoryCursor::snapshot),
            Some(SnapshotCursor {
                msgid: Some("alice-1000".into()),
                server_time_ms: 1_000,
            })
        );
        let through = chat_projection(buffer.timeline.last().expect("live direct"))
            .expect("chat record")
            .id;
        let advance = model
            .request_mark_read(alice, through)
            .expect("live direct read is authoritative");
        model.advance_read(alice, advance.time, false);

        let merged = model.merge_chat_list_snapshot("network".into(), &previous);
        assert_eq!(merged.rows.len(), 1);
        assert!(merged.rows[0].stubs.is_empty());
        assert_eq!(merged.rows[0].read_at_ms, Some(1_000));
    }

    #[test]
    fn pushed_read_marker_updates_an_unrequested_cached_snapshot_row() {
        let (mut model, state) = model(10);
        let cached = SnapshotRow {
            conversation: SnapshotConversation::Channel {
                key: "#room".into(),
            },
            title: "#room".into(),
            last_activity_ms: Some(100),
            stubs: snapshot_stubs(1, 0, 100),
            gap_until: None,
            preview: Some("cached preview".into()),
            newest: Some(SnapshotCursor {
                msgid: Some("cached-newest".into()),
                server_time_ms: 100,
            }),
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
        };
        let previous = ChatListSnapshot::new("network".into(), vec![cached.clone()]);
        model.restore_chat_list(previous.clone());
        let channel = channel_name(&state, "#room");
        let buffer_id = model.names[&NameKey::Channel(channel)];

        model.advance_read(buffer_id, UNIX_EPOCH + Duration::from_millis(100), false);
        let merged = model.merge_chat_list_snapshot("network".into(), &previous);

        assert_eq!(
            merged.rows,
            vec![SnapshotRow {
                stubs: Vec::new(),
                gap_until: None,
                read_at_ms: Some(100),
                raw_read_at_ms: Some(100),
                ..cached
            }]
        );
    }

    #[test]
    fn push_read_persists_its_mark_and_pending_time_before_history() {
        let (mut model, state) = model(10);
        let cached = SnapshotRow {
            conversation: SnapshotConversation::Direct {
                key: "alice".into(),
            },
            title: "Alice cached".into(),
            last_activity_ms: Some(100),
            stubs: snapshot_stubs(1, 1, 100),
            gap_until: None,
            preview: Some("cached preview".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
        };
        let previous = ChatListSnapshot::new("network".into(), vec![cached.clone()]);
        model.restore_chat_list(previous.clone());
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "weblounge",
            "msgid": "pushed-direct",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");
        model.restore_pushed_messages(vec![pushed], &state);
        let (buffer_id, message_id) = take_changed_messages(&mut model)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("pushed row is restored");
        let advance = model
            .request_mark_read(buffer_id, message_id)
            .expect("provisional push advances immediately");
        model.advance_read(buffer_id, advance.time, true);

        let merged = model.merge_chat_list_snapshot("network".into(), &previous);
        let encoded = serde_json::to_value(&merged).expect("snapshot json");

        assert_eq!(merged.rows[0].read_at_ms, Some(time_millis(advance.time)));
        assert_eq!(
            encoded["rows"][0]["pending_read_at_ms"],
            time_millis(advance.time)
        );
        assert_eq!(
            model.buffers[&buffer_id].read_facts.pending(),
            Some(ServerTimeMs::new(time_millis(advance.time)))
        );
    }

    #[test]
    fn pushed_message_covered_by_cached_cursor_is_not_counted_twice() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "alice".into(),
                last_activity_ms: Some(1_793_709_296_789),
                stubs: vec![MessageStub {
                    msgid: "pushed-direct".into(),
                    time: ServerTimeMs::new(1_793_709_296_789),
                    provisional_time: None,
                    mention: true,
                }],
                gap_until: None,
                preview: Some("alice: arrived while closed".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("pushed-direct".into()),
                    server_time_ms: 1_793_709_296_789,
                }),
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
            }],
        ));
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "weblounge",
            "msgid": "pushed-direct",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");

        model.restore_pushed_messages(vec![pushed], &state);

        let buffer_id = model.names[&NameKey::Direct(nick_name(&state, "alice"))];
        assert_eq!(model.buffers[&buffer_id].timeline.len(), 1);
        assert_eq!(model.buffers[&buffer_id].projection.unread, 1);
        assert_eq!(model.buffers[&buffer_id].projection.mentions, 1);
    }

    #[test]
    fn inconsistent_buffer_identity_becomes_a_diagnostic() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        model.names.insert(key, crate::BufferId(u64::MAX));

        let events = model.receive_incoming(
            incoming(
                &state,
                "still alive",
                Some("broken-identity"),
                None,
                1,
                TimelineOrigin::Live,
            ),
            &state,
        );

        assert!(matches!(
            events.as_slice(),
            [crate::EngineToUi::Notice { key, .. }]
                if key == EngineMessageKey::StateInconsistent.as_str()
        ));
    }
}
