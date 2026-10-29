use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    BufferId, BufferKind, BufferProjection, EngineToUi, LocalSendId, MembershipKind,
    MembershipProjection, MessageAuthorship, MessageDelivery, MessageId, MessageKind,
    MessageProjection, NetworkConnectionState, NetworkId, NetworkProjection, name_key::NameKey,
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

#[derive(Clone, Debug)]
struct TimelineRecord {
    projection: MessageProjection,
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
    timeline: Vec<TimelineRecord>,
    memberships: Vec<MembershipProjection>,
    last_membership: Option<MessageId>,
    direct: Option<papo::DirectRef>,
    read_at_ms: Option<i64>,
    history_requested: bool,
}

/// Information needed to perform an outgoing send without exposing papo targets to the UI.
#[derive(Clone, Debug)]
pub(crate) enum SendTarget {
    Channel(papo::ChannelName),
    Direct {
        nick: papo::Nick,
        recipient: papo::DirectRef,
    },
}

impl SendTarget {
    fn from_buffer(key: NameKey, direct: Option<papo::DirectRef>) -> Option<Self> {
        match key {
            NameKey::Channel(channel) => Some(Self::Channel(channel)),
            NameKey::Direct(nick) => Some(Self::Direct {
                nick,
                recipient: direct?,
            }),
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
    directs: HashMap<papo::Nick, papo::DirectRef>,
    msgids: HashMap<String, usize>,
    fallbacks: HashMap<FallbackKey, (TimelineOrigin, usize)>,
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
                title: label.clone(),
                draft_key: draft_key(&label, &label, casemapping),
                topic: None,
                member_count: None,
                unread: 0,
                mentions: 0,
                read_through: None,
                last_message: None,
            },
            key: None,
            timeline: Vec::new(),
            memberships: Vec::new(),
            last_membership: None,
            direct: None,
            read_at_ms: None,
            history_requested: true,
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
            #[cfg(test)]
            name_rebuilds: 0,
        }
    }

    pub(crate) const fn id(&self) -> NetworkId {
        self.network.id
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
                if let Some(buffer) = self.buffers.get_mut(&id)
                    && buffer.projection.topic != topic
                {
                    buffer.projection.topic = topic;
                    changed = true;
                }
            } else {
                let buffer = self.add_buffer(key, BufferKind::Channel, None, topic);
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
            buffer.projection.draft_key =
                draft_key(&network_label, &buffer.projection.title, self.casemapping);
            if let Some(key) = key {
                self.names.insert(key, *id);
            }
        }
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
        Some(self.buffers_event())
    }

    pub(crate) fn rename_direct(
        &mut self,
        old: &papo::Nick,
        new: papo::Nick,
    ) -> Option<EngineToUi> {
        if let Some(direct) = self.directs.remove(old) {
            self.directs.insert(new.clone(), direct);
        }
        let id = self.names.remove(&NameKey::Direct(old.clone()))?;
        let buffer = self.buffers.get_mut(&id)?;
        let key = NameKey::Direct(new);
        buffer.projection.title = key.title();
        buffer.projection.draft_key = draft_key(
            &self.network.label,
            &buffer.projection.title,
            self.casemapping,
        );
        buffer.key = Some(key.clone());
        self.names.insert(key, id);
        Some(self.buffers_event())
    }

    pub(crate) fn receive(
        &mut self,
        message: &papo::Message,
        history: bool,
        state: &papo::State,
        direct: Option<papo::DirectRef>,
    ) -> Vec<EngineToUi> {
        if let Some(direct) = direct.as_ref() {
            self.directs
                .insert(message.actor.nick().clone(), direct.clone());
        }
        let Some(conversation) = NameKey::from_conversation(&message.conversation) else {
            return vec![EngineToUi::Notice {
                message_key: "engine.unsupported_conversation".into(),
            }];
        };
        let origin = if history {
            TimelineOrigin::History
        } else {
            TimelineOrigin::Live
        };
        let mode_symbol = match &message.conversation {
            papo::Conversation::Channel(channel) => state
                .channel(channel)
                .and_then(|channel| channel.member(message.actor.nick()))
                .and_then(|member| member.prefixes().first())
                .map(|prefix| prefix.symbol()),
            _ => None,
        };
        let incoming = Incoming {
            direct,
            conversation,
            author: message.actor.nick().to_string(),
            text: message.text.clone(),
            kind: match message.kind {
                papo::MessageKind::Action => MessageKind::Action,
                _ => MessageKind::Text,
            },
            bot: message.actor.is_bot() == Some(true),
            mode_symbol,
            authorship: map_authorship(message.authorship),
            msgid: message.msgid.as_ref().map(ToString::to_string),
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
        author: String,
        source_time: Option<SystemTime>,
    ) -> Option<EngineToUi> {
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author,
            text,
            kind: MessageKind::Notice,
            bot: false,
            mode_symbol: None,
            authorship: MessageAuthorship::Own,
            nick_color_index: 0,
            mentioned: false,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: Vec::new(),
            server_time_ms: source_time.map(time_millis),
            received_at_ms: time_millis(papo::time::now()),
        };
        self.insert(buffer_id, message.clone(), DedupReferences::default())
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
        let key = buffer.key.clone()?;
        let direct = buffer.direct.clone();
        let local_send_id = LocalSendId(self.next_local_send_id);
        self.next_local_send_id += 1;
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: self.network.nickname.clone(),
            text: text.clone(),
            kind,
            bot: false,
            mode_symbol: None,
            authorship: MessageAuthorship::Own,
            nick_color_index: nick_color_index(state.casemapping(), &self.network.nickname),
            mentioned: false,
            delivery: MessageDelivery::Optimistic,
            local_send_id: Some(local_send_id),
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms: time_millis(papo::time::now()),
        };
        self.insert(buffer_id, message.clone(), DedupReferences::default())
            .ok()?;
        let target = SendTarget::from_buffer(key, direct)?;
        Some((
            PendingSend {
                buffer_id,
                local_send_id,
                target,
                text,
                kind,
            },
            vec![
                EngineToUi::MessagesAppended {
                    buffer_id,
                    messages: vec![message],
                },
                EngineToUi::BufferUpdated {
                    buffer: self.buffers[&buffer_id].projection.clone(),
                },
            ],
        ))
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
                .find(|run| run.id == previous && run.kind == kind)
            {
                if !run.nicks.contains(&nick) {
                    run.nicks.push(nick);
                }
                run.server_time_ms = server_time_ms.or(run.server_time_ms);
                run.received_at_ms = received_at_ms;
                return Some(EngineToUi::MembershipChanged {
                    buffer_id,
                    membership: run.clone(),
                });
            }
        }
        let membership = MembershipProjection {
            id: self.allocate_message_id(),
            kind,
            nicks: vec![nick],
            server_time_ms,
            received_at_ms,
        };
        let buffer = self.buffers.get_mut(&buffer_id)?;
        buffer.last_membership = Some(membership.id);
        buffer.memberships.push(membership.clone());
        let excess = buffer.memberships.len().saturating_sub(self.window_limit);
        buffer.memberships.drain(..excess);
        Some(EngineToUi::MembershipChanged {
            buffer_id,
            membership,
        })
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
        let (lines, server_time) = match &sent.outcome {
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
                    message.text.clone_from(text);
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
        for message in &messages {
            for msgid in &message.server_ids {
                *self.msgids.entry(msgid.clone()).or_default() += 1;
            }
            self.insert(
                pending.buffer_id,
                message.clone(),
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
        Some(events)
    }

    pub(crate) fn fail_send(&mut self, pending: &PendingSend, message_key: &str) -> EngineToUi {
        if let Some(record) = self.buffers.get_mut(&pending.buffer_id).and_then(|buffer| {
            buffer
                .timeline
                .iter_mut()
                .find(|record| record.projection.local_send_id == Some(pending.local_send_id))
        }) {
            record.projection.delivery = MessageDelivery::Failed;
        }
        EngineToUi::MessageFailed {
            buffer_id: pending.buffer_id,
            local_send_id: pending.local_send_id,
            message_key: message_key.into(),
        }
    }

    pub(crate) fn history_targets(&self) -> Vec<SendTarget> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter_map(|buffer| {
                SendTarget::from_buffer(buffer.key.clone()?, buffer.direct.clone())
            })
            .collect()
    }

    pub(crate) fn request_latest(&mut self, buffer_id: BufferId) -> Option<SendTarget> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if buffer.history_requested {
            return None;
        }
        let target = SendTarget::from_buffer(buffer.key.clone()?, buffer.direct.clone())?;
        buffer.history_requested = true;
        Some(target)
    }

    pub(crate) fn request_latest_channel(
        &mut self,
        channel: &papo::ChannelName,
    ) -> Option<SendTarget> {
        let buffer_id = self
            .names
            .get(&NameKey::Channel(channel.clone()))
            .copied()?;
        self.request_latest(buffer_id)
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
        let buffer = self.buffers.get(&buffer_id)?;
        (buffer.projection.kind == BufferKind::Direct).then_some(())?;
        self.names.remove(buffer.key.as_ref()?);
        self.buffers.remove(&buffer_id);
        self.buffer_order.retain(|id| *id != buffer_id);
        Some(self.buffers_event())
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
            .filter(|nick| state.casemapping().fold(nick) != state.nick().as_ref())
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
        direct: papo::DirectRef,
    ) -> (BufferId, Vec<EngineToUi>) {
        let (buffer_id, added) = self.ensure_buffer(NameKey::Direct(nick), Some(direct));
        let mut events = Vec::new();
        if let Some(buffer) = added {
            events.push(EngineToUi::BufferAdded { buffer });
            events.push(self.buffers_event());
        }
        (buffer_id, events)
    }

    pub(crate) fn direct(&self, nick: &papo::Nick) -> Option<papo::DirectRef> {
        self.directs.get(nick).cloned()
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
            target: SendTarget::from_buffer(buffer.key.clone()?, buffer.direct.clone())?,
            time: system_time_from_millis(message_time(&record.projection)),
        })
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
        let fingerprint = FallbackKey {
            conversation: incoming.conversation.clone(),
            server_time_ms: incoming.server_time_ms,
            actor: incoming.author.clone(),
            text: incoming.text.clone(),
        };
        let dedup = if let Some(msgid) = &incoming.msgid {
            if self.msgids.contains_key(msgid) {
                return Vec::new();
            }
            self.msgids.insert(msgid.clone(), 1);
            DedupReferences {
                msgids: vec![msgid.clone()],
                fallback: None,
            }
        } else {
            if let Some((previous, count)) = self.fallbacks.get_mut(&fingerprint) {
                if *previous != incoming.origin {
                    return Vec::new();
                }
                *count += 1;
            } else {
                self.fallbacks
                    .insert(fingerprint.clone(), (incoming.origin, 1));
            }
            DedupReferences {
                msgids: Vec::new(),
                fallback: Some(fingerprint),
            }
        };

        let (buffer_id, added) =
            self.ensure_buffer(incoming.conversation.clone(), incoming.direct.clone());
        let mentioned = incoming.authorship != MessageAuthorship::Own
            && mentions_own_nick(&incoming.text, state);
        let nick_color_index = nick_color_index(state.casemapping(), &incoming.author);
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: incoming.author,
            text: incoming.text,
            kind: incoming.kind,
            bot: incoming.bot,
            mode_symbol: incoming.mode_symbol,
            authorship: incoming.authorship,
            nick_color_index,
            mentioned,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: incoming.msgid.into_iter().collect(),
            server_time_ms: incoming.server_time_ms,
            received_at_ms: incoming.received_at_ms,
        };
        if self.insert(buffer_id, message.clone(), dedup).is_err() {
            return inconsistent_state_notice();
        }
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

        let mut events = Vec::new();
        if let Some(buffer) = added {
            events.push(EngineToUi::BufferAdded { buffer });
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
        events
    }

    fn ensure_buffer(
        &mut self,
        key: NameKey,
        direct: Option<papo::DirectRef>,
    ) -> (BufferId, Option<BufferProjection>) {
        if let Some(id) = self.names.get(&key).copied() {
            if direct.is_some()
                && let Some(buffer) = self.buffers.get_mut(&id)
            {
                buffer.direct = direct;
            }
            return (id, None);
        }
        let kind = match key {
            NameKey::Channel(_) => BufferKind::Channel,
            NameKey::Direct(_) => BufferKind::Direct,
        };
        let projection = self.add_buffer(key, kind, direct, None);
        (projection.id, Some(projection))
    }

    fn add_buffer(
        &mut self,
        key: NameKey,
        kind: BufferKind,
        direct: Option<papo::DirectRef>,
        topic: Option<String>,
    ) -> BufferProjection {
        let id = BufferId(self.next_buffer_id);
        self.next_buffer_id += 1;
        let projection = BufferProjection {
            id,
            network_id: self.network.id,
            kind,
            title: key.title(),
            draft_key: draft_key(&self.network.label, &key.title(), self.casemapping),
            topic,
            member_count: (kind == BufferKind::Channel).then_some(0),
            unread: 0,
            mentions: 0,
            read_through: None,
            last_message: None,
        };
        self.buffers.insert(
            id,
            BufferState {
                projection: projection.clone(),
                key: Some(key.clone()),
                timeline: Vec::new(),
                memberships: Vec::new(),
                last_membership: None,
                direct,
                read_at_ms: None,
                history_requested: false,
            },
        );
        self.names.insert(key, id);
        self.buffer_order.push(id);
        projection
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
        dedup: DedupReferences,
    ) -> Result<(), StateError> {
        if !self.buffers.contains_key(&buffer_id) {
            self.release_dedup(dedup);
            return Err(StateError::MissingBuffer(buffer_id));
        }
        let record = TimelineRecord {
            projection,
            sequence: self.next_sequence,
            dedup,
        };
        self.next_sequence += 1;
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return Err(StateError::MissingBuffer(buffer_id));
        };
        buffer.last_membership = None;
        buffer.timeline.push(record);
        buffer.timeline.sort_by_key(order_key);
        let excess = buffer.timeline.len().saturating_sub(self.window_limit);
        let evicted = buffer.timeline.drain(..excess).collect::<Vec<_>>();
        for record in evicted {
            self.release_dedup(record.dedup);
        }
        if let Some(buffer) = self.buffers.get_mut(&buffer_id) {
            derive_read_projection(buffer);
        }
        Ok(())
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

fn derive_read_projection(buffer: &mut BufferState) {
    buffer.projection.last_message = buffer
        .timeline
        .iter()
        .rev()
        .find(|record| record.projection.kind != MessageKind::Notice)
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
            (
                unread + 1,
                mentions + u64::from(record.projection.mentioned),
            )
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
    vec![EngineToUi::Notice {
        message_key: "engine.state_inconsistent".into(),
    }]
}

fn draft_key(network: &str, buffer: &str, casemapping: papo::Casemapping) -> String {
    let folded = casemapping.fold(buffer);
    format!(
        "{}:{network}:{}:{folded}",
        network.len(),
        casemapping.as_str()
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
    direct: Option<papo::DirectRef>,
    author: String,
    text: String,
    kind: MessageKind,
    bot: bool,
    mode_symbol: Option<char>,
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

fn mentions_own_nick(text: &str, state: &papo::State) -> bool {
    text.split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .filter(|word| !word.is_empty())
        .any(|word| state.casemapping().fold(word) == state.nick().as_ref())
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
    let primary_time = if record.projection.kind == MessageKind::Notice {
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
    use papo_testing::StateBuilder;

    use super::{
        Incoming, NameKey, NetworkModel, SendTarget, TimelineOrigin, draft_key, nick_color_index,
        time_millis,
    };
    use crate::{BufferKind, EngineToUi, MembershipKind, MessageAuthorship, NetworkId};

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
            author: "alice".into(),
            text: text.into(),
            kind: crate::MessageKind::Text,
            bot: false,
            mode_symbol: None,
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
        assert_eq!(first.id, second.id);
        assert_eq!(second.nicks, ["mel", "rafa"]);

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
        assert_ne!(second.id, third.id);
    }

    #[test]
    fn message_projection_keeps_action_bot_and_mode_metadata() {
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
        message.bot = true;
        message.mode_symbol = Some('@');

        let projection = model
            .receive_incoming(message, &state)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::MessagesAppended { mut messages, .. } => messages.pop(),
                _ => None,
            })
            .expect("message projection");
        assert_eq!(projection.kind, crate::MessageKind::Action);
        assert!(projection.bot);
        assert_eq!(projection.mode_symbol, Some('@'));
    }

    #[test]
    fn local_notices_do_not_replace_chat_previews_or_create_unread() {
        let (mut model, state) = model(10);
        let buffer = model.add_buffer(
            NameKey::Channel(channel_name(&state, "#room")),
            BufferKind::Channel,
            None,
            Some("A quiet room".into()),
        );

        model.receive_incoming(
            incoming(&state, "hello", Some("m1"), None, 1, TimelineOrigin::Live),
            &state,
        );
        let unread_before = model.buffers[&buffer.id].projection.unread;
        let event = model
            .append_notice(
                buffer.id,
                "A quiet room".into(),
                "mel".into(),
                Some(std::time::UNIX_EPOCH),
            )
            .expect("notice row");

        assert!(matches!(
            event,
            EngineToUi::MessagesAppended { messages, .. }
                if messages[0].kind == crate::MessageKind::Notice
                    && messages[0].author == "mel"
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
                .map(|record| record.projection.kind),
            Some(crate::MessageKind::Notice)
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
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None);
        let (pending, _) = model
            .begin_send(buffer.id, "will fail".into(), &state)
            .expect("channel is sendable");

        model.fail_send(&pending, "engine.send_failed");

        let record = &model.buffers[&buffer.id].timeline[0];
        assert_eq!(record.projection.delivery, crate::MessageDelivery::Failed);
    }

    #[test]
    fn optimistic_send_uses_the_platform_wall_clock() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(channel_name(&state, "#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel, None, None);
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
    fn closing_a_direct_buffer_removes_only_its_local_projection() {
        let (mut model, state) = model(10);
        let (buffer_id, _) = model.ensure_buffer(NameKey::Direct(nick_name(&state, "alice")), None);
        assert!(model.close_direct(buffer_id).is_some());
        assert!(!model.buffer_order.contains(&buffer_id));
        assert!(!model.buffers.contains_key(&buffer_id));
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
    fn send_targets_round_trip_through_name_keys() {
        let (_, state) = model(10);
        let channel = NameKey::Channel(channel_name(&state, "#room"));
        let target = SendTarget::from_buffer(channel.clone(), None).expect("channel target");
        assert_eq!(target.name_key(), channel);
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
            [crate::EngineToUi::Notice { message_key }]
                if message_key == "engine.state_inconsistent"
        ));
    }
}
