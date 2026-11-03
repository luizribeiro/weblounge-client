use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    BufferId, BufferKind, BufferProjection, ChannelStatus, DirectIdentityState, EngineToUi,
    LocalSendId, MembershipKind, MembershipProjection, MessageAuthorship, MessageDelivery,
    MessageId, MessageKind, MessageProjection, NetworkConnectionState, NetworkId,
    NetworkProjection, NoticeAction, NoticeKind, NoticeTone,
    chat_list_snapshot::{
        ChatListSnapshot, SnapshotBadge, SnapshotConversation, SnapshotRow, truncate_preview,
    },
    name_key::NameKey,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TimelineOrigin {
    Live,
    History,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FallbackKey {
    conversation: NameKey,
    server_time_ms: Option<i64>,
    actor: String,
    text: String,
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
struct TimelineRecord {
    projection: MessageProjection,
    counts_as_mention: bool,
    send_text: Option<String>,
    sequence: u64,
    dedup: DedupReferences,
}

#[derive(Clone, Debug, Default)]
struct DedupReferences {
    msgids: Vec<String>,
    fallback: Option<FallbackKey>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StateError {
    MissingBuffer(BufferId),
}

#[derive(Clone, Debug)]
struct BufferState {
    projection: BufferProjection,
    key: Option<NameKey>,
    direct_key: Option<DirectKey>,
    timeline: Vec<TimelineRecord>,
    memberships: Vec<MembershipProjection>,
    last_membership: Option<MessageId>,
    direct: Option<DirectAvailability>,
    direct_pin: Option<papo::PeerKey>,
    direct_mismatch: Option<DirectMismatch>,
    read_at_ms: Option<i64>,
    history: HistoryState,
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
    LoadingLatest,
    Ready {
        oldest: Option<papo::HistoryReference>,
        at_start: bool,
    },
    LoadingOlder {
        oldest: papo::HistoryReference,
    },
}

#[derive(Clone, Debug)]
pub(crate) enum HistoryFetch {
    Latest(HistoryTarget),
    Before {
        target: HistoryTarget,
        oldest: papo::HistoryReference,
    },
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
    pub(crate) target: SendTarget,
    pub(crate) time: SystemTime,
}

/// Mutable application identity and timeline state for one papo client.
pub(crate) struct NetworkModel {
    network: NetworkProjection,
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
    msgids: HashMap<String, usize>,
    fallbacks: HashMap<FallbackKey, (TimelineOrigin, usize)>,
    recent_commands: VecDeque<String>,
    cached_read_intents: HashSet<NameKey>,
    #[cfg(test)]
    name_rebuilds: usize,
}

impl NetworkModel {
    pub(crate) fn new(id: NetworkId, label: String, nickname: String, window_limit: usize) -> Self {
        let server_id = BufferId(1);
        let casemapping = papo::Casemapping::default();
        let server = BufferState {
            projection: BufferProjection {
                id: server_id,
                network_id: id,
                kind: BufferKind::Server,
                channel_status: None,
                cached: None,
                available: None,
                title: label.clone(),
                nick_color_index: None,
                direct_identity: None,
                draft_key: draft_key(&label, &label, casemapping),
                topic: None,
                member_count: None,
                unread: 0,
                mentions: 0,
                read_through: None,
                read_at_ms: None,
                last_message: None,
                last_activity_ms: None,
                cached_preview: None,
            },
            key: None,
            direct_key: None,
            timeline: Vec::new(),
            memberships: Vec::new(),
            last_membership: None,
            direct: None,
            direct_pin: None,
            direct_mismatch: None,
            read_at_ms: None,
            history: HistoryState::Ready {
                oldest: None,
                at_start: true,
            },
        };
        Self {
            network: NetworkProjection {
                id,
                label,
                nickname,
                state: NetworkConnectionState::Connecting,
            },
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
            fallbacks: HashMap::new(),
            recent_commands: VecDeque::new(),
            cached_read_intents: HashSet::new(),
            #[cfg(test)]
            name_rebuilds: 0,
        }
    }

    pub(crate) const fn id(&self) -> NetworkId {
        self.network.id
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

    pub(crate) fn snapshot_events(&self) -> Vec<EngineToUi> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id).map(|buffer| (*id, buffer)))
            .map(|(buffer_id, buffer)| EngineToUi::BufferSnapshot {
                buffer_id,
                messages: buffer
                    .timeline
                    .iter()
                    .map(|record| record.projection.clone())
                    .collect(),
                memberships: buffer.memberships.clone(),
            })
            .collect()
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
                buffer.projection.title = row.title;
                buffer.projection.cached = Some(true);
                buffer.projection.cached_preview = row.preview;
                buffer.projection.last_activity_ms = row.last_activity_ms;
                match row.badge {
                    SnapshotBadge::None => {}
                    SnapshotBadge::Unread { count } => buffer.projection.unread = count,
                    SnapshotBadge::Mentions { count, mentions } => {
                        buffer.projection.unread = count;
                        buffer.projection.mentions = mentions;
                    }
                }
                buffer.direct_pin = row.peer_pin.and_then(|pin| pin.parse().ok());
                buffer.projection.direct_identity = direct_identity(buffer);
            }
        }
        self.sort_buffer_order();
    }

    pub(crate) fn finish_cached_chat_list(&mut self) -> EngineToUi {
        EngineToUi::ChatListLive {
            network_id: self.network.id,
            buffers: self.ordered_buffers(),
        }
    }

    pub(crate) fn mark_vanished_cached_rows(&mut self) {
        for buffer in self.buffers.values_mut() {
            if buffer.projection.cached == Some(true) {
                buffer.projection.cached = None;
                buffer.projection.available = Some(false);
            }
        }
    }

    pub(crate) fn is_cached_buffer(&self, buffer_id: BufferId) -> bool {
        self.buffers
            .get(&buffer_id)
            .is_some_and(|buffer| buffer.projection.cached == Some(true))
    }

    pub(crate) fn chat_list_complete(&self) -> bool {
        self.is_online()
            && self.buffers.values().all(|buffer| {
                buffer.projection.kind == BufferKind::Server
                    || buffer.projection.available == Some(false)
                    || matches!(buffer.history, HistoryState::Ready { .. })
            })
    }

    pub(crate) fn chat_list_snapshot(&self, fingerprint: String) -> ChatListSnapshot {
        let rows = self
            .buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter(|buffer| {
                buffer.projection.kind != BufferKind::Server
                    && buffer.projection.available != Some(false)
                    && buffer.projection.cached != Some(true)
            })
            .filter_map(snapshot_row)
            .collect();
        ChatListSnapshot::new(fingerprint, rows)
    }

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
                        || buffer.projection.cached == Some(true)
                        || buffer.projection.available == Some(false)
                        || buffer.projection.title != title
                    {
                        buffer.projection.topic = topic;
                        buffer.projection.channel_status = Some(ChannelStatus::Joined);
                        buffer.projection.title = title;
                        buffer.projection.cached = None;
                        buffer.projection.available = None;
                        buffer.projection.cached_preview = None;
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
        self.append_notice(id, format!("{old} is now {new}"), NoticeKind::Info)
            .into_iter()
            .collect()
    }

    pub(crate) fn receive(
        &mut self,
        message: &papo::Message,
        history: bool,
        state: &papo::State,
        direct: Option<papo::DirectRef>,
    ) -> Vec<EngineToUi> {
        let Some(conversation) = NameKey::from_conversation(message.conversation()) else {
            return vec![EngineToUi::notice("engine.unsupported_conversation")];
        };
        let origin = if history {
            TimelineOrigin::History
        } else {
            TimelineOrigin::Live
        };
        let direct_key = match &conversation {
            NameKey::Direct(nick) => Some(DirectKey::from_nick(nick)),
            NameKey::Channel(_) => None,
        };
        let incoming = Incoming {
            direct: direct.map(DirectAvailability::Guarded),
            direct_key,
            peer_key: (message.authorship != papo::Authorship::Own)
                .then(|| message.actor.peer_key().cloned())
                .flatten(),
            legacy_account_key: message
                .actor
                .account()
                .name()
                .map(|account| account.key().to_owned()),
            conversation,
            author: message.actor.nick().to_string(),
            text: message.text.clone(),
            kind: match message.kind {
                papo::MessageKind::Action => MessageKind::Action,
                _ => MessageKind::Text,
            },
            bot: message.actor.is_bot(),
            authorship: map_authorship(message.authorship),
            msgid: message.msgid().map(ToString::to_string),
            server_time_ms: message.server_time.map(time_millis),
            received_at_ms: time_millis(message.received_at),
            origin,
        };
        self.receive_incoming(incoming, state)
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
    ) -> Option<EngineToUi> {
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
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms: time_millis(papo::time::now()),
        };
        self.insert(buffer_id, message.clone(), None, DedupReferences::default())
            .ok()?;
        Some(EngineToUi::MessagesAppended {
            buffer_id,
            messages: vec![message],
        })
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
        let cached = buffer.projection.cached == Some(true);
        let key = buffer.key.clone()?;
        let direct = buffer.direct.clone();
        let pin = buffer.direct_pin.clone();
        let mismatched = buffer.direct_mismatch.is_some();
        let target =
            SendTarget::from_buffer(key.clone(), direct.as_ref(), pin.as_ref(), mismatched)
                .or_else(|| {
                    if cached {
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
        ) && !cached
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
        let mut events = vec![
            EngineToUi::MessagesAppended {
                buffer_id,
                messages: vec![message],
            },
            EngineToUi::BufferUpdated {
                buffer: self.buffers[&buffer_id].projection.clone(),
            },
        ];
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

    pub(crate) fn prepare_cached_send(&self, pending: &mut PendingSend) -> PendingTargetState {
        let Some(buffer) = self.buffers.get(&pending.buffer_id) else {
            return PendingTargetState::Gone;
        };
        if buffer.projection.available == Some(false) {
            return PendingTargetState::Gone;
        }
        if buffer.projection.cached == Some(true) {
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

    pub(crate) fn receive_membership(
        &mut self,
        channel: &papo::ChannelName,
        kind: MembershipKind,
        nick: String,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
    ) -> Option<EngineToUi> {
        let buffer_id = *self.names.get(&NameKey::Channel(channel.clone()))?;
        let previous = self.buffers.get(&buffer_id)?.last_membership;
        if let Some(previous) = previous {
            let buffer = self.buffers.get_mut(&buffer_id)?;
            if let Some(run) = buffer
                .memberships
                .iter_mut()
                .find(|run| run.id() == previous)
                && let MembershipProjection::Change {
                    kind: run_kind,
                    nicks,
                    server_time_ms: run_server_time_ms,
                    received_at_ms: run_received_at_ms,
                    ..
                } = run
                && *run_kind == kind
            {
                if !nicks.contains(&nick) {
                    nicks.push(nick);
                }
                *run_server_time_ms = server_time_ms.or(*run_server_time_ms);
                *run_received_at_ms = received_at_ms;
                return Some(EngineToUi::MembershipChanged {
                    buffer_id,
                    membership: run.clone(),
                });
            }
        }
        let membership = MembershipProjection::Change {
            id: self.allocate_message_id(),
            kind,
            nicks: vec![nick],
            server_time_ms,
            received_at_ms,
        };
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.last_membership = Some(membership.id());
        buffer.memberships.push(membership.clone());
        let excess = buffer.memberships.len().saturating_sub(self.window_limit);
        buffer.memberships.drain(..excess);
        Some(EngineToUi::MembershipChanged {
            buffer_id,
            membership,
        })
    }

    pub(crate) fn receive_own_kick(
        &mut self,
        channel: &papo::ChannelName,
        actor: String,
        reason: Option<String>,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
    ) -> Option<Vec<EngineToUi>> {
        let buffer_id = *self.names.get(&NameKey::Channel(channel.clone()))?;
        let membership = MembershipProjection::Kicked {
            id: self.allocate_message_id(),
            actor,
            reason,
            server_time_ms,
            received_at_ms,
        };
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.projection.channel_status = Some(ChannelStatus::Kicked);
        buffer.last_membership = Some(membership.id());
        buffer.memberships.push(membership.clone());
        let excess = buffer.memberships.len().saturating_sub(self.window_limit);
        buffer.memberships.drain(..excess);
        Some(vec![
            EngineToUi::MembershipChanged {
                buffer_id,
                membership,
            },
            EngineToUi::BufferUpdated {
                buffer: buffer.projection.clone(),
            },
        ])
    }

    pub(crate) fn confirm_send(
        &mut self,
        pending: &PendingSend,
        sent: &papo::Sent,
    ) -> Option<Vec<EngineToUi>> {
        let buffer = self.buffers.get_mut(&pending.buffer_id)?;
        let index = buffer
            .timeline
            .iter()
            .position(|record| record.projection.local_send_id == Some(pending.local_send_id))?;
        let record = buffer.timeline.remove(index);
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
                    let mut message = record.projection.clone();
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
            let mut message = record.projection;
            message.delivery = MessageDelivery::Confirmed;
            message.local_send_id = None;
            vec![message]
        };
        let mut order_changed = false;
        for message in &messages {
            for msgid in &message.server_ids {
                *self.msgids.entry(msgid.clone()).or_default() += 1;
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
        let mut events = vec![EngineToUi::MessageConfirmed {
            buffer_id: pending.buffer_id,
            local_send_id: pending.local_send_id,
            message: messages[0].clone(),
        }];
        if messages.len() > 1 {
            events.push(EngineToUi::MessagesAppended {
                buffer_id: pending.buffer_id,
                messages: messages[1..].to_vec(),
            });
        }
        if order_changed {
            events.push(self.buffers_event());
        }
        let buffer = &self.buffers[&pending.buffer_id];
        events.extend([
            EngineToUi::BufferUpdated {
                buffer: buffer.projection.clone(),
            },
            EngineToUi::UnreadChanged {
                buffer_id: pending.buffer_id,
                unread: buffer.projection.unread,
                mentions: buffer.projection.mentions,
            },
            EngineToUi::ReadMarkerMoved {
                buffer_id: pending.buffer_id,
                through: buffer.projection.read_through,
            },
        ]);
        Some(events)
    }

    pub(crate) fn fail_send(
        &mut self,
        pending: &PendingSend,
        message_key: &str,
    ) -> Vec<EngineToUi> {
        if let Some(record) = self.buffers.get_mut(&pending.buffer_id).and_then(|buffer| {
            buffer
                .timeline
                .iter_mut()
                .find(|record| record.projection.local_send_id == Some(pending.local_send_id))
        }) {
            record.projection.delivery = MessageDelivery::Failed;
        }
        let target = pending.target.title();
        let mut events = vec![EngineToUi::MessageFailed {
            network_id: self.network.id,
            buffer_id: pending.buffer_id,
            target: target.clone(),
            local_send_id: pending.local_send_id,
            message_key: message_key.into(),
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

    pub(crate) fn retry_send(
        &mut self,
        buffer_id: BufferId,
        local_send_id: LocalSendId,
    ) -> Option<(PendingSend, EngineToUi)> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let target = SendTarget::from_buffer(
            buffer.key.clone()?,
            buffer.direct.as_ref(),
            buffer.direct_pin.as_ref(),
            buffer.direct_mismatch.is_some(),
        )?;
        let message = buffer.timeline.iter_mut().find(|record| {
            record.projection.local_send_id == Some(local_send_id)
                && record.projection.delivery == MessageDelivery::Failed
        })?;
        message.projection.delivery = MessageDelivery::Optimistic;
        let text = message.send_text.clone()?;
        let pending = PendingSend {
            buffer_id,
            local_send_id,
            target,
            text,
            kind: message.projection.kind.clone(),
        };
        Some((
            pending,
            EngineToUi::MessageRetrying {
                buffer_id,
                local_send_id,
            },
        ))
    }

    pub(crate) fn history_targets(&self) -> Vec<HistoryTarget> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter_map(|buffer| buffer.key.clone().map(HistoryTarget::from_key))
            .collect()
    }

    pub(crate) fn request_history(&mut self, buffer_id: BufferId) -> Option<HistoryFetch> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let target = HistoryTarget::from_key(buffer.key.clone()?);
        match &buffer.history {
            HistoryState::Unrequested => {
                buffer.history = HistoryState::LoadingLatest;
                Some(HistoryFetch::Latest(target))
            }
            HistoryState::Ready {
                oldest: Some(oldest),
                at_start: false,
            } => {
                let oldest = oldest.clone();
                buffer.history = HistoryState::LoadingOlder {
                    oldest: oldest.clone(),
                };
                Some(HistoryFetch::Before { target, oldest })
            }
            HistoryState::LoadingLatest
            | HistoryState::LoadingOlder { .. }
            | HistoryState::Ready { .. } => None,
        }
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
        if !matches!(buffer.history, HistoryState::Unrequested) {
            return None;
        }
        let target = HistoryTarget::from_key(buffer.key.clone()?);
        buffer.history = HistoryState::LoadingLatest;
        Some(target)
    }

    pub(crate) fn finish_history(
        &mut self,
        conversation: &papo::Conversation,
        oldest: Option<papo::HistoryReference>,
        empty: bool,
    ) -> Option<(BufferId, bool)> {
        let key = NameKey::from_conversation(conversation)?;
        let buffer_id = self.names.get(&key).copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        let previous = match &buffer.history {
            HistoryState::LoadingOlder { oldest } => Some(oldest.clone()),
            HistoryState::LoadingLatest => None,
            _ => return None,
        };
        let oldest = oldest.or(previous);
        let at_start = empty;
        buffer.history = HistoryState::Ready { oldest, at_start };
        Some((buffer_id, at_start))
    }

    pub(crate) fn fail_history(&mut self, fetch: &HistoryFetch) -> Option<BufferId> {
        let target = match fetch {
            HistoryFetch::Latest(target) | HistoryFetch::Before { target, .. } => target,
        };
        let buffer_id = self.names.get(&target.name_key()).copied()?;
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.history = match &buffer.history {
            HistoryState::LoadingLatest => HistoryState::Unrequested,
            HistoryState::LoadingOlder { oldest } => HistoryState::Ready {
                oldest: Some(oldest.clone()),
                at_start: false,
            },
            HistoryState::Unrequested | HistoryState::Ready { .. } => return None,
        };
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

    pub(crate) fn remove_channel(&mut self, channel: &papo::ChannelName) -> Option<EngineToUi> {
        let key = NameKey::Channel(channel.clone());
        let buffer_id = self.names.remove(&key)?;
        self.buffer_order.retain(|id| *id != buffer_id);
        self.buffers.remove(&buffer_id)?;
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
        self.buffer_order.retain(|id| *id != buffer_id);
        Some(self.buffers_event())
    }

    pub(crate) fn invalidate_direct_handles(&mut self) {
        for buffer in self.buffers.values_mut() {
            if buffer.projection.kind == BufferKind::Direct {
                buffer.direct = Some(DirectAvailability::Pending);
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
            .map(|record| record.projection.author.clone())
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
        nick: papo::Nick,
        latest: SystemTime,
        _state: &papo::State,
    ) -> (HistoryFetch, Option<BufferId>, Option<BufferProjection>) {
        let key = NameKey::Direct(nick.clone());
        let should_resolve = !matches!(
            self.direct(&nick),
            Some(DirectAvailability::Guarded(_) | DirectAvailability::Resolving)
        );
        let direct_key = DirectKey::from_nick(&nick);
        let (buffer_id, added) = self.ensure_buffer(key, Some(direct_key.clone()), None);
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            buffer.projection.last_activity_ms =
                Some(buffer.projection.last_activity_ms.map_or_else(
                    || time_millis(latest),
                    |current| current.max(time_millis(latest)),
                ));
            if matches!(buffer.history, HistoryState::Unrequested) {
                buffer.history = HistoryState::LoadingLatest;
            }
            if should_resolve {
                buffer.direct = Some(DirectAvailability::Resolving);
            }
        }
        self.sort_buffer_order();
        (
            HistoryFetch::Latest(HistoryTarget::Direct(nick)),
            should_resolve.then_some(buffer_id),
            added,
        )
    }

    pub(crate) fn direct(&self, nick: &papo::Nick) -> Option<DirectAvailability> {
        let buffer_id = self.names.get(&NameKey::Direct(nick.clone()))?;
        self.buffers.get(buffer_id)?.direct.clone()
    }

    pub(crate) fn send_rejection_key(&self, buffer_id: BufferId) -> &'static str {
        let buffer = self.buffers.get(&buffer_id);
        if buffer
            .is_some_and(|buffer| buffer.projection.channel_status == Some(ChannelStatus::Kicked))
        {
            "engine.channel_rejoin_required"
        } else if buffer
            .and_then(|buffer| buffer.direct.as_ref())
            .is_some_and(|direct| matches!(direct, DirectAvailability::MonitorFull))
        {
            "engine.direct_monitor_full"
        } else {
            "engine.buffer_not_sendable"
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

    pub(crate) fn prepare_mark_read(
        &self,
        buffer_id: BufferId,
        through: MessageId,
    ) -> Option<ReadAdvance> {
        let buffer = self.buffers.get(&buffer_id)?;
        let record = buffer
            .timeline
            .iter()
            .find(|record| record.projection.id == through && is_committed(&record.projection))?;
        Some(ReadAdvance {
            buffer_id,
            target: match buffer.key.clone()? {
                NameKey::Channel(channel) => SendTarget::Channel(channel),
                NameKey::Direct(nick) => SendTarget::Direct {
                    nick,
                    recipient: None,
                    pin: None,
                },
            },
            time: system_time_from_millis(message_time(&record.projection)),
        })
    }

    pub(crate) fn mark_cached_read(&mut self, buffer_id: BufferId) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if buffer.projection.cached != Some(true) {
            return None;
        }
        self.cached_read_intents.insert(buffer.key.clone()?);
        buffer.projection.unread = 0;
        buffer.projection.mentions = 0;
        Some(EngineToUi::BufferUpdated {
            buffer: buffer.projection.clone(),
        })
    }

    pub(crate) fn take_cached_read_advances(&mut self) -> (Vec<ReadAdvance>, Vec<EngineToUi>) {
        let mut advances = Vec::new();
        let mut events = Vec::new();
        for key in self.cached_read_intents.clone() {
            let Some(buffer_id) = self.names.get(&key).copied() else {
                continue;
            };
            let Some(buffer) = self.buffers.get(&buffer_id) else {
                continue;
            };
            if !matches!(buffer.history, HistoryState::Ready { .. }) {
                continue;
            }
            let through = buffer
                .timeline
                .iter()
                .rev()
                .find(|record| is_committed(&record.projection))
                .map(|record| record.projection.id);
            let Some(through) = through else {
                self.cached_read_intents.remove(&key);
                continue;
            };
            let Some(advance) = self.prepare_mark_read(buffer_id, through) else {
                continue;
            };
            self.cached_read_intents.remove(&key);
            events.extend(self.apply_read_time(buffer_id, advance.time));
            advances.push(advance);
        }
        (advances, events)
    }

    pub(crate) fn prepare_mark_all_read(&self) -> Vec<ReadAdvance> {
        self.buffer_order
            .iter()
            .filter_map(|id| {
                let through = self
                    .buffers
                    .get(id)?
                    .timeline
                    .iter()
                    .rev()
                    .find(|record| is_committed(&record.projection))?
                    .projection
                    .id;
                self.prepare_mark_read(*id, through)
            })
            .collect()
    }

    pub(crate) fn apply_read_time(
        &mut self,
        buffer_id: BufferId,
        time: SystemTime,
    ) -> Vec<EngineToUi> {
        let read_at_ms = time_millis(time);
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return inconsistent_state_notice();
        };
        if buffer
            .read_at_ms
            .is_some_and(|current| current >= read_at_ms)
        {
            return Vec::new();
        }
        buffer.read_at_ms = Some(read_at_ms);
        derive_read_projection(buffer);
        vec![
            EngineToUi::UnreadChanged {
                buffer_id,
                unread: buffer.projection.unread,
                mentions: buffer.projection.mentions,
            },
            EngineToUi::ReadMarkerMoved {
                buffer_id,
                through: buffer.projection.read_through,
            },
            EngineToUi::BufferUpdated {
                buffer: buffer.projection.clone(),
            },
        ]
    }

    pub(crate) fn apply_server_read_marker(
        &mut self,
        conversation: &papo::Conversation,
        read_until: Option<SystemTime>,
    ) -> Vec<EngineToUi> {
        let Some(time) = read_until else {
            return Vec::new();
        };
        let Some(key) = NameKey::from_conversation(conversation) else {
            return Vec::new();
        };
        let Some(buffer_id) = self.names.get(&key).copied() else {
            return Vec::new();
        };
        self.apply_read_time(buffer_id, time)
    }

    #[cfg(test)]
    pub(crate) fn buffer_id_for_target(&self, target: &SendTarget) -> Option<BufferId> {
        let key = target.name_key();
        self.names.get(&key).copied()
    }

    fn receive_incoming(&mut self, incoming: Incoming, state: &papo::State) -> Vec<EngineToUi> {
        let Some(dedup) = self.deduplicate_incoming(&incoming) else {
            return Vec::new();
        };

        let (buffer_id, initially_added) = self.ensure_buffer(
            incoming.conversation.clone(),
            incoming.direct_key.clone(),
            incoming.direct.clone(),
        );
        let verified_sender = incoming
            .peer_key
            .is_some_and(|current| self.apply_direct_peer_key(buffer_id, current));
        let added = initially_added
            .map(|_| self.buffers[&buffer_id].projection.clone())
            .or_else(|| {
                (incoming.authorship != MessageAuthorship::Own)
                    .then(|| self.reveal_buffer(buffer_id))
                    .flatten()
            });
        let highlighted = incoming.authorship != MessageAuthorship::Own
            && matches_highlight_rules(&incoming.text, state);
        let nick_color_index = nick_color_index(state.casemapping(), &incoming.author);
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: incoming.author,
            text: collapse_blank_lines(incoming.text),
            kind: incoming.kind,
            bot: incoming.bot,
            authorship: incoming.authorship,
            nick_color_index,
            highlighted,
            unverified_sender: (incoming.direct_key.is_some()
                && incoming.authorship != MessageAuthorship::Own
                && !verified_sender)
                .then_some(true),
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: incoming.msgid.into_iter().collect(),
            server_time_ms: incoming.server_time_ms,
            received_at_ms: incoming.received_at_ms,
        };
        let Ok(order_changed) = self.insert(buffer_id, message.clone(), None, dedup) else {
            return inconsistent_state_notice();
        };
        let (unread, mentions, added) = {
            let Some(buffer) = self.buffers.get(&buffer_id) else {
                return inconsistent_state_notice();
            };
            (
                buffer.projection.unread,
                buffer.projection.mentions,
                added.map(|_| buffer.projection.clone()),
            )
        };
        let own_message = message.authorship == MessageAuthorship::Own;

        let mut events = Vec::new();
        let buffer_added = added.is_some();
        if let Some(buffer) = added {
            events.push(EngineToUi::BufferAdded { buffer });
        }
        if buffer_added || order_changed {
            events.push(self.buffers_event());
        }
        events.push(EngineToUi::MessagesAppended {
            buffer_id,
            messages: vec![message],
        });
        events.push(EngineToUi::BufferUpdated {
            buffer: self.buffers[&buffer_id].projection.clone(),
        });
        events.push(EngineToUi::UnreadChanged {
            buffer_id,
            unread,
            mentions,
        });
        if own_message {
            events.push(EngineToUi::ReadMarkerMoved {
                buffer_id,
                through: self.buffers[&buffer_id].projection.read_through,
            });
        }
        if let Some(account) = incoming.legacy_account_key {
            events.push(self.legacy_draft_migration(buffer_id, &account));
        }
        events
    }

    fn deduplicate_incoming(&mut self, incoming: &Incoming) -> Option<DedupReferences> {
        if let Some(msgid) = &incoming.msgid {
            if self.msgids.contains_key(msgid) {
                return None;
            }
            self.msgids.insert(msgid.clone(), 1);
            return Some(DedupReferences {
                msgids: vec![msgid.clone()],
                fallback: None,
            });
        }
        let fingerprint = FallbackKey {
            conversation: incoming.conversation.clone(),
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
                buffer.projection.cached = None;
                buffer.projection.available = None;
                buffer.projection.cached_preview = None;
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
            channel_status: (kind == BufferKind::Channel).then_some(ChannelStatus::Joined),
            cached: None,
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
            read_through: None,
            read_at_ms: None,
            last_message: None,
            last_activity_ms: None,
            cached_preview: None,
        };
        self.buffers.insert(
            id,
            BufferState {
                projection: projection.clone(),
                key: Some(key.clone()),
                direct_key: direct_key.clone(),
                timeline: Vec::new(),
                memberships: Vec::new(),
                last_membership: None,
                direct: (kind == BufferKind::Direct)
                    .then(|| direct.unwrap_or(DirectAvailability::Pending)),
                direct_pin: None,
                direct_mismatch: None,
                read_at_ms: None,
                history: HistoryState::Unrequested,
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

    fn insert(
        &mut self,
        buffer_id: BufferId,
        projection: MessageProjection,
        send_text: Option<String>,
        dedup: DedupReferences,
    ) -> Result<bool, StateError> {
        let own_read_at = (projection.authorship == MessageAuthorship::Own
            && !matches!(&projection.kind, MessageKind::Notice(_))
            && is_committed(&projection))
        .then(|| message_time(&projection));
        let Some(buffer) = self.buffers.get(&buffer_id) else {
            self.release_dedup(dedup);
            return Err(StateError::MissingBuffer(buffer_id));
        };
        let counts_as_mention = projection.authorship != MessageAuthorship::Own
            && (buffer.projection.kind == BufferKind::Direct || projection.highlighted);
        let record = TimelineRecord {
            projection,
            counts_as_mention,
            send_text,
            sequence: self.next_sequence,
            dedup,
        };
        self.next_sequence += 1;
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return Err(StateError::MissingBuffer(buffer_id));
        };
        buffer.last_membership = None;
        buffer.projection.last_activity_ms = Some(buffer.projection.last_activity_ms.map_or_else(
            || message_time(&record.projection),
            |current| current.max(message_time(&record.projection)),
        ));
        buffer.timeline.push(record);
        buffer.timeline.sort_by_key(order_key);
        if let Some(read_at) = own_read_at {
            buffer.read_at_ms = Some(
                buffer
                    .read_at_ms
                    .map_or(read_at, |current| current.max(read_at)),
            );
        }
        let excess = buffer.timeline.len().saturating_sub(self.window_limit);
        let evicted = buffer.timeline.drain(..excess).collect::<Vec<_>>();
        for record in evicted {
            self.release_dedup(record.dedup);
        }
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            derive_read_projection(buffer);
        }
        Ok(self.sort_buffer_order())
    }

    fn release_dedup(&mut self, dedup: DedupReferences) {
        for msgid in dedup.msgids {
            decrement_or_remove(&mut self.msgids, &msgid);
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

fn snapshot_row(buffer: &BufferState) -> Option<SnapshotRow> {
    let conversation = match buffer.key.as_ref()? {
        NameKey::Channel(channel) => SnapshotConversation::Channel {
            key: channel.key().to_owned(),
        },
        NameKey::Direct(nick) => SnapshotConversation::Direct {
            key: nick.key().to_owned(),
        },
    };
    let badge = if buffer.projection.mentions > 0 {
        SnapshotBadge::Mentions {
            count: buffer.projection.unread,
            mentions: buffer.projection.mentions,
        }
    } else if buffer.projection.unread > 0 {
        SnapshotBadge::Unread {
            count: buffer.projection.unread,
        }
    } else {
        SnapshotBadge::None
    };
    Some(SnapshotRow {
        conversation,
        title: buffer.projection.title.clone(),
        last_activity_ms: buffer.projection.last_activity_ms,
        badge,
        preview: buffer
            .projection
            .last_message
            .as_ref()
            .map(|message| snapshot_preview(&buffer.projection, message)),
        peer_pin: buffer
            .direct_pin
            .as_ref()
            .and_then(papo::PeerKey::as_verified_str)
            .map(str::to_owned),
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
    buffer.projection.read_at_ms = buffer.read_at_ms;
    buffer.projection.last_message = buffer
        .timeline
        .iter()
        .filter(|record| !matches!(&record.projection.kind, MessageKind::Notice(_)))
        .max_by_key(|record| order_key(record))
        .map(|record| record.projection.clone());
    buffer.projection.read_through = buffer.read_at_ms.and_then(|marker| {
        buffer
            .timeline
            .iter()
            .rev()
            .find(|record| {
                is_committed(&record.projection) && message_time(&record.projection) <= marker
            })
            .map(|record| record.projection.id)
    });
    let (unread, mentions) = buffer
        .timeline
        .iter()
        .filter(|record| {
            record.projection.authorship != MessageAuthorship::Own
                && buffer
                    .read_at_ms
                    .is_none_or(|marker| message_time(&record.projection) > marker)
        })
        .fold((0, 0), |(unread, mentions), record| {
            (unread + 1, mentions + u64::from(record.counts_as_mention))
        });
    buffer.projection.unread = unread;
    buffer.projection.mentions = mentions;
}

fn is_committed(message: &MessageProjection) -> bool {
    matches!(
        message.delivery,
        MessageDelivery::Received | MessageDelivery::Confirmed
    )
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
    vec![EngineToUi::notice("engine.state_inconsistent")]
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

fn decrement_or_remove(counts: &mut HashMap<String, usize>, key: &str) {
    let remove = counts.get_mut(key).is_some_and(|count| {
        *count -= 1;
        *count == 0
    });
    if remove {
        counts.remove(key);
    }
}

#[derive(Clone, Debug)]
struct Incoming {
    conversation: NameKey,
    direct: Option<DirectAvailability>,
    direct_key: Option<DirectKey>,
    peer_key: Option<papo::PeerKey>,
    legacy_account_key: Option<String>,
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

fn map_authorship(authorship: papo::Authorship) -> MessageAuthorship {
    match authorship {
        papo::Authorship::Own => MessageAuthorship::Own,
        papo::Authorship::Other => MessageAuthorship::Other,
        _ => MessageAuthorship::Unknown,
    }
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

fn order_key(record: &TimelineRecord) -> (i64, i64, u64) {
    let primary_time = if matches!(&record.projection.kind, MessageKind::Notice(_)) {
        record.projection.received_at_ms
    } else {
        record
            .projection
            .server_time_ms
            .unwrap_or(record.projection.received_at_ms)
    };
    (
        primary_time,
        record.projection.received_at_ms,
        record.sequence,
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
    use std::time::SystemTime;

    use papo_testing::{StateBuilder, wire};

    use super::{
        DirectKey, HistoryFetch, HistoryState, Incoming, NameKey, NetworkModel, PendingTargetState,
        SendTarget, TimelineOrigin, collapse_blank_lines, derive_read_projection, draft_key,
        nick_color_index, time_millis,
    };
    use crate::{
        BufferId, BufferKind, EngineToUi, MembershipKind, MembershipProjection, MessageAuthorship,
        NetworkId,
        chat_list_snapshot::{ChatListSnapshot, SnapshotBadge, SnapshotConversation, SnapshotRow},
    };

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
            conversation: NameKey::Channel(channel_name(state, "#room")),
            direct: None,
            direct_key: None,
            peer_key: None,
            legacy_account_key: None,
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

    #[test]
    fn received_message_projection_collapses_blank_lines() {
        let (mut model, state) = model(10);

        let events = model.receive_incoming(
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

        assert!(events.iter().any(|event| matches!(
            event,
            EngineToUi::MessagesAppended { messages, .. }
                if messages[0].text == "first\n\nsecond"
        )));
        assert_eq!(timeline(&model), ["first\n\nsecond"]);
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
            .map(|record| record.projection.text.as_str())
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
            EngineToUi::MessagesAppended { buffer_id: received, .. } if *received == buffer_id
        )));
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
                .is_some_and(|record| record.projection.unverified_sender != Some(true))
        );
        assert_eq!(
            model.buffers[&buffer_id].projection.draft_key,
            nick_draft_key
        );
        assert_eq!(
            model.buffers[&buffer_id].read_at_ms,
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
            conversation: NameKey::Direct(nick_name(state, nick)),
            direct: None,
            direct_key: Some(DirectKey(state.casemapping().fold(nick).into_owned())),
            peer_key: None,
            legacy_account_key: None,
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
            model.restore_direct(
                nick_name(&state, nick),
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
                &state,
            );
        }

        assert_eq!(ordered_titles(&model), ["Test", "carol", "alice", "Bob"]);
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
                .find(|record| record.projection.text == "older")
                .and_then(|record| record.projection.server_time_ms),
            None
        );
    }

    #[test]
    fn consecutive_membership_changes_collapse_until_a_message() {
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
        let channel = channel_name(&state, "#room");
        let first = model
            .receive_membership(&channel, MembershipKind::Joined, "mel".into(), Some(2), 2)
            .expect("membership row");
        let second = model
            .receive_membership(&channel, MembershipKind::Joined, "rafa".into(), Some(3), 3)
            .expect("collapsed row");
        let (
            EngineToUi::MembershipChanged {
                membership: first, ..
            },
            EngineToUi::MembershipChanged {
                membership: second, ..
            },
        ) = (first, second)
        else {
            panic!("membership projections expected");
        };
        assert_eq!(first.id(), second.id());
        assert!(matches!(
            &second,
            MembershipProjection::Change { nicks, .. } if nicks == &["mel", "rafa"]
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
        let EngineToUi::MembershipChanged {
            membership: third, ..
        } = model
            .receive_membership(&channel, MembershipKind::Joined, "cyd".into(), Some(5), 5)
            .expect("new membership row")
        else {
            panic!("membership projection expected");
        };
        assert_ne!(second.id(), third.id());
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

        let projection = model
            .receive_incoming(message, &state)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::MessagesAppended { mut messages, .. } => messages.pop(),
                _ => None,
            })
            .expect("message projection");
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
        let event = model
            .append_notice(buffer.id, "A quiet room".into(), crate::NoticeKind::Info)
            .expect("notice row");

        assert!(matches!(
            event,
            EngineToUi::MessagesAppended { messages, .. }
                if matches!(&messages[0].kind, crate::MessageKind::Notice(crate::NoticeKind::Info))
                    && messages[0].author.is_empty()
        ));
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
                .map(|record| &record.projection.kind),
            Some(&crate::MessageKind::Notice(crate::NoticeKind::Info))
        );
        assert_eq!(model.buffers[&buffer.id].projection.unread, unread_before);
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

        let advances = model.prepare_mark_all_read();
        assert_eq!(advances.len(), 1);
        let events = model.apply_read_time(advances[0].buffer_id, advances[0].time);
        assert!(events.iter().any(|event| matches!(
            event,
            crate::EngineToUi::BufferUpdated { buffer }
                if buffer.read_at_ms == Some(time_millis(advances[0].time))
        )));
        assert!(
            events
                .iter()
                .any(|event| matches!(event, crate::EngineToUi::UnreadChanged { unread: 0, .. }))
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
    fn latest_channel_request_preserves_an_older_page_request() {
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
        let Some(HistoryFetch::Before { oldest, .. }) = model.request_history(buffer_id) else {
            panic!("older history remains requestable");
        };
        assert_eq!(
            oldest,
            papo::HistoryReference::from(papo::MessageId::from("oldest"))
        );
    }

    #[test]
    fn bounded_window_evicts_oldest_rows() {
        let (mut model, state) = model(2);
        for (index, text) in ["one", "two", "three"].into_iter().enumerate() {
            model.receive_incoming(
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

        assert_eq!(timeline(&model), ["two", "three"]);
    }

    #[test]
    fn snapshots_replay_each_buffers_retained_rows_in_order() {
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

        let snapshots = model
            .snapshot_events()
            .into_iter()
            .map(|event| match event {
                crate::EngineToUi::BufferSnapshot { messages, .. } => messages
                    .into_iter()
                    .map(|message| message.text)
                    .collect::<Vec<_>>(),
                other => panic!("unexpected snapshot event {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            snapshots,
            [vec![], vec!["two".to_owned(), "three".to_owned()]]
        );
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

        let events = model.fail_send(&pending, "engine.send_failed");

        let record = &model.buffers[&buffer.id].timeline[0];
        assert_eq!(record.projection.delivery, crate::MessageDelivery::Failed);
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
    fn optimistic_action_projects_semantic_text() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);

        let (_, events) = model
            .begin_action(buffer.id, "hides".into(), &state)
            .expect("channel is sendable");

        assert!(matches!(
            events.first(),
            Some(EngineToUi::MessagesAppended { messages, .. })
                if matches!(messages.as_slice(), [message]
                    if message.kind == crate::MessageKind::Action
                        && message.text == "hides"
                        && message.delivery == crate::MessageDelivery::Optimistic)
        ));
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
        model.fail_send(&pending, "engine.send_failed");

        let (retried, event) = model
            .retry_send(buffer.id, pending.local_send_id)
            .expect("failed send retries");

        assert_eq!(retried.text, "try\n\n\nagain");
        assert_eq!(retried.local_send_id, pending.local_send_id);
        assert_eq!(
            model.buffers[&buffer.id].timeline[0].projection.delivery,
            crate::MessageDelivery::Optimistic
        );
        assert!(matches!(
            event,
            EngineToUi::MessageRetrying {
                buffer_id,
                local_send_id,
            } if buffer_id == buffer.id && local_send_id == pending.local_send_id
        ));
    }

    #[test]
    fn optimistic_send_uses_the_platform_wall_clock() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None, None);
        let before = time_millis(papo::time::now());

        let (_, events) = model
            .begin_send(buffer.id, "timestamped".into(), &state)
            .expect("channel is sendable");
        let after = time_millis(papo::time::now());
        let crate::EngineToUi::MessagesAppended { messages, .. } = &events[0] else {
            panic!("send appends its optimistic message");
        };

        assert!(messages[0].received_at_ms >= before);
        assert!(messages[0].received_at_ms <= after);
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
        let (client, mut events, mut wire) = wire(papo::Client::builder(
            "ircs://verified.example",
            "weblounge",
        ));
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
        model.apply_read_time(buffer_id, read_at);
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
                .and_then(|record| record.projection.unverified_sender),
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
        let (client, mut events, mut wire) = wire(papo::Client::builder(
            "ircs://verified.example",
            "weblounge",
        ));
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

        assert!(matches!(
            note.as_slice(),
            [EngineToUi::MessagesAppended { buffer_id, messages }]
                if *buffer_id == old_buffer
                    && messages[0].text == "alice is now alicia"
                    && matches!(&messages[0].kind, crate::MessageKind::Notice(crate::NoticeKind::Info))
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
        let events = model.receive_incoming(second, &state);
        let buffer_id = events
            .iter()
            .find_map(|event| match event {
                EngineToUi::MessagesAppended { buffer_id, .. } => Some(*buffer_id),
                _ => None,
            })
            .expect("message buffer exists");

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
        own.conversation = key.clone();
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
        peer.conversation = key;
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
    fn own_device_lines_mark_earlier_peer_messages_read() {
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
        let buffer = &model.buffers[&id];
        assert_eq!(buffer.projection.unread, 0);
        assert_eq!(
            buffer.projection.read_through,
            Some(buffer.timeline[1].projection.id)
        );
        assert_eq!(buffer.projection.read_at_ms, buffer.read_at_ms);
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
                buffer.timeline[0].projection.highlighted, expected_highlight,
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
    fn cached_direct_send_waits_for_the_live_target_and_fails_if_it_vanishes() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(1_000),
                badge: SnapshotBadge::Unread { count: 1 },
                preview: Some("hello".into()),
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
            model.prepare_cached_send(&mut pending),
            PendingTargetState::Waiting
        ));
        model.mark_vanished_cached_rows();
        assert!(matches!(
            model.prepare_cached_send(&mut pending),
            PendingTargetState::Gone
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
                badge: SnapshotBadge::None,
                preview: None,
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
    fn cached_mark_read_clears_locally_then_advances_after_live_history() {
        let (mut model, state) = model(10);
        model.restore_chat_list(ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: Some(1_000),
                badge: SnapshotBadge::Mentions {
                    count: 2,
                    mentions: 2,
                },
                preview: Some("alice: hello".into()),
                peer_pin: None,
            }],
        ));
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer_id = *model.names.get(&key).expect("cached channel exists");

        assert!(matches!(
            model.mark_cached_read(buffer_id),
            Some(EngineToUi::BufferUpdated { buffer })
                if buffer.unread == 0 && buffer.mentions == 0
        ));
        model.receive_incoming(
            incoming(
                &state,
                "live history",
                Some("history"),
                Some(1_000),
                1_000,
                TimelineOrigin::History,
            ),
            &state,
        );
        model.buffers.get_mut(&buffer_id).expect("buffer").history = HistoryState::Ready {
            oldest: None,
            at_start: true,
        };

        let (advances, events) = model.take_cached_read_advances();
        assert_eq!(advances.len(), 1);
        assert!(events.iter().any(|event| matches!(
            event,
            EngineToUi::UnreadChanged {
                buffer_id: changed,
                unread: 0,
                mentions: 0,
            } if *changed == buffer_id
        )));
    }

    #[test]
    fn chat_list_is_writable_only_when_online_and_fully_hydrated() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let (buffer_id, _) = model.ensure_buffer(key, None, None);
        assert!(!model.chat_list_complete());

        model.set_connection(crate::NetworkConnectionState::Online, None);
        assert!(!model.chat_list_complete());
        model.buffers.get_mut(&buffer_id).expect("buffer").history = HistoryState::Ready {
            oldest: None,
            at_start: true,
        };
        assert!(model.chat_list_complete());

        model.set_connection(
            crate::NetworkConnectionState::Reconnecting {
                attempt: 1,
                next_retry_at_ms: 1,
            },
            None,
        );
        assert!(!model.chat_list_complete());
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
                if key == "engine.state_inconsistent"
        ));
    }
}
