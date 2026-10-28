use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    BufferId, BufferKind, BufferProjection, EngineToUi, LocalSendId, MessageAuthorship,
    MessageDelivery, MessageId, MessageProjection, NetworkConnectionState, NetworkId,
    NetworkProjection, name_key::NameKey,
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
}

#[derive(Clone, Debug)]
struct BufferState {
    projection: BufferProjection,
    key: Option<NameKey>,
    timeline: Vec<TimelineRecord>,
}

/// Information needed to perform an outgoing send without exposing papo targets to the UI.
#[derive(Clone, Debug)]
pub(crate) enum SendTarget {
    Channel(papo::ChannelName),
    Direct(papo::Nick),
}

/// Pending optimistic row and its send destination.
#[derive(Clone, Debug)]
pub(crate) struct PendingSend {
    pub(crate) buffer_id: BufferId,
    pub(crate) local_send_id: LocalSendId,
    pub(crate) target: SendTarget,
    pub(crate) text: String,
}

/// Mutable application identity and timeline state for one papo client.
pub(crate) struct NetworkModel {
    network: NetworkProjection,
    next_buffer_id: u64,
    next_message_id: u64,
    next_local_send_id: u64,
    next_sequence: u64,
    window_limit: usize,
    buffer_order: Vec<BufferId>,
    buffers: HashMap<BufferId, BufferState>,
    names: HashMap<NameKey, BufferId>,
    msgids: HashSet<String>,
    fallbacks: HashMap<FallbackKey, TimelineOrigin>,
}

impl NetworkModel {
    pub(crate) fn new(id: NetworkId, label: String, nickname: String, window_limit: usize) -> Self {
        let server_id = BufferId(1);
        let server = BufferState {
            projection: BufferProjection {
                id: server_id,
                network_id: id,
                kind: BufferKind::Server,
                title: label.clone(),
                unread: 0,
                mentions: 0,
            },
            key: None,
            timeline: Vec::new(),
        };
        Self {
            network: NetworkProjection {
                id,
                label,
                nickname,
                state: NetworkConnectionState::Connecting,
            },
            next_buffer_id: 2,
            next_message_id: 1,
            next_local_send_id: 1,
            next_sequence: 1,
            window_limit,
            buffer_order: vec![server_id],
            buffers: HashMap::from([(server_id, server)]),
            names: HashMap::new(),
            msgids: HashSet::new(),
            fallbacks: HashMap::new(),
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
            .map(|channel| channel.name().clone())
            .collect::<Vec<_>>();
        channels.sort_by_key(ToString::to_string);
        let mut events = Vec::new();
        for channel in channels {
            let key = NameKey::Channel(channel);
            if !self.names.contains_key(&key) {
                let buffer = self.add_buffer(key, BufferKind::Channel);
                events.push(EngineToUi::BufferAdded { buffer });
            }
        }
        if !events.is_empty() {
            events.push(self.buffers_event());
        }
        events
    }

    pub(crate) fn rebuild_name_keys(&mut self, state: &papo::State) {
        self.names.clear();
        for (id, buffer) in &mut self.buffers {
            let key = match buffer.projection.kind {
                BufferKind::Channel => Some(NameKey::Channel(
                    state.name_rules().channel(buffer.projection.title.clone()),
                )),
                BufferKind::Direct => Some(NameKey::Direct(
                    state.name_rules().nick(buffer.projection.title.clone()),
                )),
                BufferKind::Server => None,
            };
            buffer.key.clone_from(&key);
            if let Some(key) = key {
                self.names.insert(key, *id);
            }
        }
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
        buffer.key = Some(key.clone());
        self.names.insert(key, id);
        Some(self.buffers_event())
    }

    pub(crate) fn rename_direct(
        &mut self,
        old: &papo::Nick,
        new: papo::Nick,
    ) -> Option<EngineToUi> {
        let id = self.names.remove(&NameKey::Direct(old.clone()))?;
        let buffer = self.buffers.get_mut(&id)?;
        let key = NameKey::Direct(new);
        buffer.projection.title = key.title();
        buffer.key = Some(key.clone());
        self.names.insert(key, id);
        Some(self.buffers_event())
    }

    pub(crate) fn receive(
        &mut self,
        message: &papo::Message,
        history: bool,
        state: &papo::State,
    ) -> Vec<EngineToUi> {
        let origin = if history {
            TimelineOrigin::History
        } else {
            TimelineOrigin::Live
        };
        let incoming = Incoming {
            conversation: NameKey::from_conversation(&message.conversation),
            author: message.actor.nick().to_string(),
            text: message.text.clone(),
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
    ) -> Option<(PendingSend, Vec<EngineToUi>)> {
        let key = self.buffers.get(&buffer_id)?.key.clone()?;
        let local_send_id = LocalSendId(self.next_local_send_id);
        self.next_local_send_id += 1;
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: self.network.nickname.clone(),
            text: text.clone(),
            authorship: MessageAuthorship::Own,
            delivery: MessageDelivery::Optimistic,
            local_send_id: Some(local_send_id),
            server_ids: Vec::new(),
            server_time_ms: None,
            received_at_ms: time_millis(SystemTime::now()),
        };
        self.insert(buffer_id, message.clone());
        let target = match key {
            NameKey::Channel(channel) => SendTarget::Channel(channel),
            NameKey::Direct(nick) => SendTarget::Direct(nick),
        };
        Some((
            PendingSend {
                buffer_id,
                local_send_id,
                target,
                text,
            },
            vec![EngineToUi::MessagesAppended {
                buffer_id,
                messages: vec![message],
            }],
        ))
    }

    pub(crate) fn confirm_send(
        &mut self,
        pending: &PendingSend,
        sent: &papo::Sent,
    ) -> Option<EngineToUi> {
        let buffer = self.buffers.get_mut(&pending.buffer_id)?;
        let record = buffer
            .timeline
            .iter_mut()
            .find(|record| record.projection.local_send_id == Some(pending.local_send_id))?;
        record.projection.delivery = MessageDelivery::Confirmed;
        record.projection.local_send_id = None;
        record.projection.server_ids = sent.msgids.iter().map(ToString::to_string).collect();
        record.projection.server_time_ms = sent.server_time.map(time_millis);
        for msgid in &record.projection.server_ids {
            self.msgids.insert(msgid.clone());
        }
        let message = record.projection.clone();
        buffer.timeline.sort_by_key(order_key);
        Some(EngineToUi::MessageConfirmed {
            buffer_id: pending.buffer_id,
            local_send_id: pending.local_send_id,
            message,
        })
    }

    pub(crate) fn fail_send(&mut self, pending: &PendingSend) -> EngineToUi {
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
            message_key: "engine.send_failed".into(),
        }
    }

    pub(crate) fn history_targets(&self) -> Vec<SendTarget> {
        self.buffer_order
            .iter()
            .filter_map(|id| self.buffers.get(id))
            .filter_map(|buffer| match buffer.key.as_ref()? {
                NameKey::Channel(channel) => Some(SendTarget::Channel(channel.clone())),
                NameKey::Direct(nick) => Some(SendTarget::Direct(nick.clone())),
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn buffer_id_for_target(&self, target: &SendTarget) -> Option<BufferId> {
        let key = match target {
            SendTarget::Channel(channel) => NameKey::Channel(channel.clone()),
            SendTarget::Direct(nick) => NameKey::Direct(nick.clone()),
        };
        self.names.get(&key).copied()
    }

    fn receive_incoming(&mut self, incoming: Incoming, state: &papo::State) -> Vec<EngineToUi> {
        let fingerprint = FallbackKey {
            conversation: incoming.conversation.clone(),
            server_time_ms: incoming.server_time_ms,
            actor: incoming.author.clone(),
            text: incoming.text.clone(),
        };
        if let Some(msgid) = &incoming.msgid {
            if !self.msgids.insert(msgid.clone()) {
                return Vec::new();
            }
        } else if self
            .fallbacks
            .get(&fingerprint)
            .is_some_and(|previous| *previous != incoming.origin)
        {
            return Vec::new();
        } else {
            self.fallbacks.entry(fingerprint).or_insert(incoming.origin);
        }

        let (buffer_id, added) = self.ensure_buffer(incoming.conversation.clone());
        let mentioned = incoming.authorship != MessageAuthorship::Own
            && mentions_own_nick(&incoming.text, state);
        let message = MessageProjection {
            id: self.allocate_message_id(),
            author: incoming.author,
            text: incoming.text,
            authorship: incoming.authorship,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: incoming.msgid.into_iter().collect(),
            server_time_ms: incoming.server_time_ms,
            received_at_ms: incoming.received_at_ms,
        };
        self.insert(buffer_id, message.clone());
        let (unread, mentions) = {
            let buffer = self
                .buffers
                .get_mut(&buffer_id)
                .expect("newly ensured buffer must exist");
            buffer.projection.unread += u64::from(incoming.authorship != MessageAuthorship::Own);
            buffer.projection.mentions += u64::from(mentioned);
            (buffer.projection.unread, buffer.projection.mentions)
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
        events.push(EngineToUi::UnreadChanged {
            buffer_id,
            unread,
            mentions,
        });
        events
    }

    fn ensure_buffer(&mut self, key: NameKey) -> (BufferId, Option<BufferProjection>) {
        if let Some(id) = self.names.get(&key) {
            return (*id, None);
        }
        let kind = match key {
            NameKey::Channel(_) => BufferKind::Channel,
            NameKey::Direct(_) => BufferKind::Direct,
        };
        let projection = self.add_buffer(key, kind);
        (projection.id, Some(projection))
    }

    fn add_buffer(&mut self, key: NameKey, kind: BufferKind) -> BufferProjection {
        let id = BufferId(self.next_buffer_id);
        self.next_buffer_id += 1;
        let projection = BufferProjection {
            id,
            network_id: self.network.id,
            kind,
            title: key.title(),
            unread: 0,
            mentions: 0,
        };
        self.buffers.insert(
            id,
            BufferState {
                projection: projection.clone(),
                key: Some(key.clone()),
                timeline: Vec::new(),
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

    fn insert(&mut self, buffer_id: BufferId, projection: MessageProjection) {
        let record = TimelineRecord {
            projection,
            sequence: self.next_sequence,
        };
        self.next_sequence += 1;
        let buffer = self
            .buffers
            .get_mut(&buffer_id)
            .expect("engine buffer identity must remain valid");
        buffer.timeline.push(record);
        buffer.timeline.sort_by_key(order_key);
        let excess = buffer.timeline.len().saturating_sub(self.window_limit);
        buffer.timeline.drain(..excess);
    }
}

#[derive(Clone, Debug)]
struct Incoming {
    conversation: NameKey,
    author: String,
    text: String,
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
        .any(|word| state.name_rules().nick(word) == *state.nick())
}

fn order_key(record: &TimelineRecord) -> (i64, i64, u64) {
    (
        record
            .projection
            .server_time_ms
            .unwrap_or(record.projection.received_at_ms),
        record.projection.received_at_ms,
        record.sequence,
    )
}

fn time_millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use papo_testing::StateBuilder;

    use super::{Incoming, NameKey, NetworkModel, TimelineOrigin};
    use crate::{MessageAuthorship, NetworkId};

    fn incoming(
        state: &papo::State,
        text: &str,
        msgid: Option<&str>,
        server_time_ms: Option<i64>,
        received_at_ms: i64,
        origin: TimelineOrigin,
    ) -> Incoming {
        Incoming {
            conversation: NameKey::Channel(state.name_rules().channel("#room")),
            author: "alice".into(),
            text: text.into(),
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
    fn failed_send_updates_the_optimistic_timeline_row() {
        let (mut model, state) = model(10);
        let key = NameKey::Channel(state.name_rules().channel("#room"));
        let buffer = model.add_buffer(key, crate::BufferKind::Channel);
        let (pending, _) = model
            .begin_send(buffer.id, "will fail".into())
            .expect("channel is sendable");

        model.fail_send(&pending);

        let record = &model.buffers[&buffer.id].timeline[0];
        assert_eq!(record.projection.delivery, crate::MessageDelivery::Failed);
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
}
