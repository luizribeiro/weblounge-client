use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::sync::mpsc;

use crate::{
    BufferId, EngineRequest, EngineRequestEnvelope, EngineToUi, MembershipKind, MessageId,
    NetworkConnectionState, NetworkId,
    commands::{self, Command},
    direct_target::DirectSendError,
    state::{NetworkModel, PendingSend, ReadAdvance, SendTarget, time_millis},
};

const DEFAULT_WINDOW_LIMIT: usize = 500;
const HISTORY_PAGE_SIZE: usize = 100;

struct RunningNetwork {
    instance: u64,
    client: papo::Client,
    model: NetworkModel,
}

struct JoinTarget {
    channel: String,
    key: Option<String>,
}

struct RuntimeState {
    next_network_id: u64,
    next_instance: u64,
    network: Option<RunningNetwork>,
    member_views: MemberViews,
}

#[derive(Clone)]
struct MemberView {
    buffer_id: BufferId,
    offset: u32,
    filter: String,
}

#[derive(Default)]
struct MemberViews {
    views: HashMap<String, MemberView>,
    versions: HashMap<BufferId, u64>,
}

impl MemberViews {
    fn remember(&mut self, view_id: &str, view: MemberView) -> u64 {
        let version = self.versions.get(&view.buffer_id).copied().unwrap_or(0);
        self.views.insert(view_id.to_owned(), view);
        version
    }

    fn changed(&mut self, buffer_id: BufferId) -> (u64, Vec<(String, MemberView)>) {
        let version = self.versions.entry(buffer_id).or_default();
        *version = version.saturating_add(1);
        let views = self
            .views
            .iter()
            .filter(|(_, view)| view.buffer_id == buffer_id)
            .map(|(id, view)| (id.clone(), view.clone()))
            .collect();
        (*version, views)
    }
}

/// Owns live papo clients independently of any attached UI tab.
pub(crate) struct Runtime {
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
}

impl Runtime {
    pub(crate) fn new(outbound: mpsc::UnboundedSender<EngineToUi>) -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 1,
                next_instance: 1,
                network: None,
                member_views: MemberViews::default(),
            })),
            outbound,
        }
    }

    pub(crate) fn request(&self, envelope: EngineRequestEnvelope) -> Vec<EngineToUi> {
        match envelope.request {
            EngineRequest::Diagnostic { message } => vec![
                EngineToUi::Diagnostic {
                    command_id: envelope.id.clone(),
                    message,
                },
                EngineToUi::CommandResult { id: envelope.id },
            ],
            EngineRequest::Connect {
                label,
                endpoint,
                nickname,
                sasl,
                autojoin,
                allow_insecure,
            } => self.connect(
                envelope.id,
                ConnectConfig {
                    label,
                    endpoint,
                    nickname,
                    account: sasl.account,
                    password: sasl.password,
                    autojoin,
                    allow_insecure,
                },
            ),
            EngineRequest::Disconnect { network_id, reason } => {
                self.disconnect(envelope.id, network_id, reason)
            }
            EngineRequest::SendMessage { buffer_id, text } => {
                self.send_input(envelope.id, buffer_id, text, crate::MessageKind::Text)
            }
            EngineRequest::SubmitInput { buffer_id, input } => {
                self.submit_input(envelope.id, buffer_id, &input)
            }
            EngineRequest::CompleteInput { buffer_id, prefix } => {
                self.complete_input(envelope.id, buffer_id, prefix)
            }
            EngineRequest::MarkRead { buffer_id, through } => {
                self.mark_read(envelope.id, buffer_id, through)
            }
            EngineRequest::MarkAllRead => self.mark_all_read(envelope.id),
            EngineRequest::LoadHistory { buffer_id } => self.load_history(envelope.id, buffer_id),
            EngineRequest::RequestMembers {
                buffer_id,
                view_id,
                offset,
                filter,
            } => self.request_members(
                envelope.id,
                buffer_id,
                &view_id,
                offset,
                filter.as_deref().unwrap_or_default(),
            ),
            EngineRequest::OpenDirect { network_id, nick } => {
                self.open_direct(envelope.id, network_id, nick)
            }
        }
    }

    fn submit_input(&self, id: String, buffer_id: BufferId, input: &str) -> Vec<EngineToUi> {
        let chantypes = lock(&self.state).network.as_ref().map_or_else(
            || "#&".to_owned(),
            |running| running.client.state().isupport().chantypes().to_owned(),
        );
        match commands::parse(input, &chantypes) {
            Ok(Command::Say { text }) => {
                self.send_input(id, buffer_id, text.0, crate::MessageKind::Text)
            }
            Ok(Command::Me { text }) => {
                self.send_input(id, buffer_id, text.0, crate::MessageKind::Action)
            }
            Ok(Command::Join { channels, keys }) => {
                let keys = keys.map_or_else(Vec::new, |keys| keys.0);
                let targets = channels
                    .0
                    .into_iter()
                    .enumerate()
                    .map(|(index, channel)| JoinTarget {
                        channel,
                        key: keys.get(index).cloned(),
                    })
                    .collect();
                self.join(id, targets)
            }
            Ok(Command::Part { channel, reason }) => {
                self.part(id, buffer_id, channel.0, reason.map(|reason| reason.0))
            }
            Ok(Command::Close {}) => self.close(id, buffer_id),
            Ok(Command::Cycle { channel, reason }) => {
                self.cycle(id, buffer_id, channel.0, reason.map(|reason| reason.0))
            }
            Ok(Command::Msg { target, text }) => self.message_direct(id, target.0, text.0, false),
            Ok(Command::Query { nick, text }) => self.query(id, nick.0, text.map(|text| text.0)),
            Ok(Command::Notice { target, text }) => self.notice(id, target.0, text.0),
            Ok(Command::Nick { nick }) => self.set_nick(id, nick.0),
            Ok(Command::Topic {
                channel,
                text: Some(text),
            }) => self.set_topic(id, buffer_id, channel.0, text.0),
            Ok(Command::Topic { text: None, .. }) => vec![EngineToUi::CommandResult { id }],
            Ok(Command::Quit { reason }) => {
                let network_id = lock(&self.state)
                    .network
                    .as_ref()
                    .map(|running| running.model.id());
                if let Some(network_id) = network_id {
                    self.disconnect(id, network_id, reason.map(|reason| reason.0))
                } else {
                    rejected_command(id, "engine.network_not_found")
                }
            }
            Ok(Command::Help { command }) => vec![
                EngineToUi::CommandHelpRequested {
                    command: command.map(|command| command.0),
                },
                EngineToUi::CommandResult { id },
            ],
            Err(error) => rejected_command(id, error.message_key()),
        }
    }

    fn open_direct(
        &self,
        command_id: String,
        network_id: NetworkId,
        nick: String,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let (buffer_id, mut output) = running.model.open_direct(nick, &running.client.state());
        output.push(EngineToUi::FocusBufferRequested {
            command_id: command_id.clone(),
            buffer_id,
        });
        output.push(EngineToUi::CommandResult { id: command_id });
        output
    }

    fn request_members(
        &self,
        command_id: String,
        buffer_id: BufferId,
        view_id: &str,
        offset: u32,
        filter: &str,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let Some(channel) = running.model.channel_for_buffer(buffer_id) else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let snapshot = running.client.state();
        let version = state.member_views.remember(
            view_id,
            MemberView {
                buffer_id,
                offset,
                filter: filter.to_owned(),
            },
        );
        let Some(window) = crate::members::project(
            &snapshot, &channel, buffer_id, view_id, version, offset, filter,
        ) else {
            return rejected_command(command_id, "engine.channel_not_found");
        };
        vec![window, EngineToUi::CommandResult { id: command_id }]
    }

    fn complete_input(
        &self,
        command_id: String,
        buffer_id: BufferId,
        prefix: String,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let snapshot = running.client.state();
        let mut candidates = running
            .model
            .completion_candidates(buffer_id, &prefix, &snapshot);
        if !prefix.starts_with('/') && !snapshot.isupport().is_channel(&prefix) {
            let folded_prefix = snapshot.casemapping().fold(&prefix);
            let mut members = running
                .model
                .channel_for_buffer(buffer_id)
                .and_then(|channel| snapshot.channel(channel))
                .into_iter()
                .flat_map(papo::Channel::members)
                .map(|member| member.nick().to_string())
                .filter(|nick| snapshot.name_rules().nick(nick) != *snapshot.nick())
                .filter(|nick| {
                    snapshot
                        .casemapping()
                        .fold(nick)
                        .starts_with(&*folded_prefix)
                })
                .collect::<Vec<_>>();
            members.sort_by_key(|nick| snapshot.casemapping().fold(nick).into_owned());
            for member in members {
                if !candidates.iter().any(|candidate| {
                    snapshot.casemapping().fold(candidate) == snapshot.casemapping().fold(&member)
                }) {
                    candidates.push(member);
                }
            }
        }
        vec![
            EngineToUi::CompletionResult {
                command_id: command_id.clone(),
                buffer_id,
                prefix,
                candidates,
            },
            EngineToUi::CommandResult { id: command_id },
        ]
    }

    fn connect(&self, command_id: String, config: ConnectConfig) -> Vec<EngineToUi> {
        if !valid_endpoint(&config.endpoint, config.allow_insecure) {
            return rejected_command(command_id, "engine.invalid_endpoint");
        }

        let mut state = lock(&self.state);
        if state.network.is_some() {
            return rejected_command(command_id, "engine.network_already_connected");
        }
        let id = NetworkId(state.next_network_id);
        state.next_network_id += 1;
        let instance = state.next_instance;
        state.next_instance += 1;
        let mut builder = papo::Client::builder(&config.endpoint, &config.nickname)
            .sasl(papo::Sasl::plain(config.account, config.password))
            .allow_insecure_auth(config.allow_insecure)
            .history_on_reconnect(true);
        if !config.autojoin.is_empty() {
            builder = builder.autojoin(config.autojoin);
        }
        let (client, events, driver) = builder.build();
        let model = NetworkModel::new(id, config.label, config.nickname, DEFAULT_WINDOW_LIMIT);
        let output = vec![
            model.network_event(),
            model.buffers_event(),
            EngineToUi::CommandResult { id: command_id },
        ];
        state.network = Some(RunningNetwork {
            instance,
            client: client.clone(),
            model,
        });
        drop(state);

        spawn_task(async move {
            let _ = driver.await;
        });
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            drain_events(state, outbound, client, events, instance).await;
        });
        output
    }

    fn disconnect(
        &self,
        command_id: String,
        network_id: NetworkId,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(mut running) = state.network.take() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        if running.model.id() != network_id {
            state.network = Some(running);
            return rejected_command(command_id, "engine.network_not_found");
        }
        let event = running
            .model
            .set_connection(NetworkConnectionState::Stopped, None);
        let client = running.client;
        drop(state);
        spawn_task(async move {
            let _ = client.quit(reason.unwrap_or_default()).await;
        });
        vec![event, EngineToUi::CommandResult { id: command_id }]
    }

    fn send_input(
        &self,
        command_id: String,
        buffer_id: crate::BufferId,
        text: String,
        kind: crate::MessageKind,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let pending = match kind {
            crate::MessageKind::Text => {
                running
                    .model
                    .begin_send(buffer_id, text, &running.client.state())
            }
            crate::MessageKind::Action => {
                running
                    .model
                    .begin_action(buffer_id, text, &running.client.state())
            }
        };
        let Some((pending, output)) = pending else {
            return rejected_command(command_id, "engine.buffer_not_sendable");
        };
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);

        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let result = send(&client, &pending).await;
            let event = {
                let mut state = lock(&state);
                let Some(running) = state
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                else {
                    return;
                };
                match result {
                    Ok(sent) => running.model.confirm_send(&pending, &sent),
                    Err(error) => Some(running.model.fail_send(&pending, error.message_key())),
                }
            };
            if let Some(event) = event {
                let _ = outbound.send(event);
            }
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
        output
    }

    fn join(&self, command_id: String, targets: Vec<JoinTarget>) -> Vec<EngineToUi> {
        let Some((client, instance)) = lock(&self.state)
            .network
            .as_ref()
            .map(|running| (running.client.clone(), running.instance))
        else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            for target in targets {
                let channel = client.state().name_rules().channel(target.channel.clone());
                let result = match target.key {
                    Some(key) => client.join(target.channel).key(key).await,
                    None => client.join(target.channel).await,
                };
                if let Err(error) = result {
                    let _ = outbound.send(EngineToUi::CommandRejected {
                        id: command_id,
                        message_key: join_error_key(&error).into(),
                    });
                    return;
                }
                let output = {
                    let mut state = lock(&state);
                    let Some(running) = state
                        .network
                        .as_mut()
                        .filter(|running| running.instance == instance)
                    else {
                        return;
                    };
                    let mut output = running.model.sync_channels(&client.state());
                    if let Some(buffer_id) = running.model.buffer_id_for_channel(&channel) {
                        output.push(EngineToUi::FocusBufferRequested {
                            command_id: command_id.clone(),
                            buffer_id,
                        });
                    }
                    output
                };
                for event in output {
                    let _ = outbound.send(event);
                }
            }
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
        Vec::new()
    }

    fn query(&self, command_id: String, nick: String, text: Option<String>) -> Vec<EngineToUi> {
        if let Some(text) = text {
            return self.message_direct(command_id, nick, text, true);
        }
        let network_id = lock(&self.state)
            .network
            .as_ref()
            .map(|running| running.model.id());
        if let Some(network_id) = network_id {
            self.open_direct(command_id, network_id, nick)
        } else {
            rejected_command(command_id, "engine.network_not_found")
        }
    }

    fn notice(&self, command_id: String, target: String, text: String) -> Vec<EngineToUi> {
        let Some(client) = lock(&self.state)
            .network
            .as_ref()
            .map(|running| running.client.clone())
        else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let snapshot = client.state();
        if snapshot.isupport().is_channel(&target) {
            let channel = snapshot.name_rules().channel(target);
            spawn_request(self.outbound.clone(), command_id, async move {
                client.notice(channel, text).await
            });
        } else {
            let nick = snapshot.name_rules().nick(target);
            spawn_request(self.outbound.clone(), command_id, async move {
                client.notice(nick, text).await
            });
        }
        Vec::new()
    }

    fn message_direct(
        &self,
        command_id: String,
        nick: String,
        text: String,
        focus: bool,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let snapshot = running.client.state();
        let (buffer_id, mut output) = running.model.open_direct(nick, &snapshot);
        if focus {
            output.push(EngineToUi::FocusBufferRequested {
                command_id: command_id.clone(),
                buffer_id,
            });
        }
        drop(state);
        output.extend(self.send_input(command_id, buffer_id, text, crate::MessageKind::Text));
        output
    }

    fn part(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let channel = requested
            .map(|name| running.client.state().name_rules().channel(name))
            .or_else(|| running.model.channel_for_buffer(buffer_id));
        let Some(channel) = channel else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            client.part(channel, reason.unwrap_or_default()).await
        });
        Vec::new()
    }

    fn close(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        if running.model.channel_for_buffer(buffer_id).is_some() {
            drop(state);
            return self.part(command_id, buffer_id, None, None);
        }
        let Some(event) = running.model.close_direct(buffer_id) else {
            return rejected_command(command_id, "engine.buffer_not_sendable");
        };
        vec![event, EngineToUi::CommandResult { id: command_id }]
    }

    fn cycle(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let channel = requested
            .map(|name| running.client.state().name_rules().channel(name))
            .or_else(|| running.model.channel_for_buffer(buffer_id));
        let Some(channel) = channel else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            client
                .part(channel.clone(), reason.unwrap_or_default())
                .await?;
            client.join(channel).await
        });
        Vec::new()
    }

    fn set_nick(&self, command_id: String, nick: String) -> Vec<EngineToUi> {
        let Some(client) = lock(&self.state)
            .network
            .as_ref()
            .map(|running| running.client.clone())
        else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        spawn_request(self.outbound.clone(), command_id, async move {
            client.set_nick(nick).await
        });
        Vec::new()
    }

    fn set_topic(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        text: String,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let channel = requested
            .map(|name| running.client.state().name_rules().channel(name))
            .or_else(|| running.model.channel_for_buffer(buffer_id));
        let Some(channel) = channel else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            client.set_topic(channel, text).await
        });
        Vec::new()
    }

    fn mark_read(
        &self,
        command_id: String,
        buffer_id: BufferId,
        through: MessageId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let Some(advance) = running.model.prepare_mark_read(buffer_id, through) else {
            return rejected_command(command_id, "engine.read_marker_invalid");
        };
        if !running.client.state().supports(papo::Feature::ReadMarkers) {
            let mut output = running.model.apply_read_time(buffer_id, advance.time);
            output.push(EngineToUi::CommandResult { id: command_id });
            return output;
        }
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        spawn_read_advances(
            Arc::clone(&self.state),
            self.outbound.clone(),
            client,
            instance,
            command_id,
            vec![advance],
        );
        Vec::new()
    }

    fn mark_all_read(&self, command_id: String) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let advances = running.model.prepare_mark_all_read();
        if !running.client.state().supports(papo::Feature::ReadMarkers) {
            let mut output = advances
                .into_iter()
                .flat_map(|advance| {
                    running
                        .model
                        .apply_read_time(advance.buffer_id, advance.time)
                })
                .collect::<Vec<_>>();
            output.push(EngineToUi::CommandResult { id: command_id });
            return output;
        }
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        spawn_read_advances(
            Arc::clone(&self.state),
            self.outbound.clone(),
            client,
            instance,
            command_id,
            advances,
        );
        Vec::new()
    }

    fn load_history(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let Some(target) = running.model.request_latest(buffer_id) else {
            return vec![EngineToUi::CommandResult { id: command_id }];
        };
        spawn_history_fetch(
            Arc::clone(&self.state),
            self.outbound.clone(),
            running.client.clone(),
            running.instance,
            target,
        );
        vec![EngineToUi::CommandResult { id: command_id }]
    }
}

fn spawn_read_advances(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    command_id: String,
    advances: Vec<ReadAdvance>,
) {
    spawn_task(async move {
        for advance in advances {
            let result = match advance.target.clone() {
                SendTarget::Channel(channel) => client.mark_read(channel, advance.time).await,
                SendTarget::Direct(target) => {
                    client.mark_read(target.nick().clone(), advance.time).await
                }
            };
            if result.is_err() {
                let _ = outbound.send(EngineToUi::CommandRejected {
                    id: command_id,
                    message_key: "engine.mark_read_failed".into(),
                });
                return;
            }
            let events = {
                let mut state = lock(&state);
                let Some(running) = state
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                else {
                    return;
                };
                running
                    .model
                    .apply_read_time(advance.buffer_id, advance.time)
            };
            for event in events {
                let _ = outbound.send(event);
            }
        }
        let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
    });
}

struct ConnectConfig {
    label: String,
    endpoint: String,
    nickname: String,
    account: String,
    password: String,
    autojoin: Vec<String>,
    allow_insecure: bool,
}

#[derive(Debug)]
enum SendError {
    Protocol,
    DirectAccountChanged,
}

impl SendError {
    const fn message_key(&self) -> &'static str {
        match self {
            Self::Protocol => "engine.send_failed",
            Self::DirectAccountChanged => "engine.direct_account_changed",
        }
    }
}

async fn send(client: &papo::Client, pending: &PendingSend) -> Result<papo::Sent, SendError> {
    let action = pending.kind == crate::MessageKind::Action;
    match pending.target.clone() {
        SendTarget::Channel(channel) => if action {
            client.action(channel, pending.text.clone()).await
        } else {
            client.privmsg(channel, pending.text.clone()).await
        }
        .map_err(|_| SendError::Protocol),
        SendTarget::Direct(target) => target
            .send(client, pending.text.clone(), action)
            .await
            .map_err(|error| match error {
                DirectSendError::AccountChanged => SendError::DirectAccountChanged,
                DirectSendError::Protocol => SendError::Protocol,
            }),
    }
}

async fn drain_events(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    mut events: papo::Events,
    instance: u64,
) {
    let member_changes = Arc::new(Mutex::new(crate::members::Changes::default()));
    while let Some(event) = events.next().await {
        let schedule_members = lock(&member_changes).record(&event, &client.state());
        let history_targets = process_event(&state, &outbound, &client, instance, event);
        for target in history_targets {
            spawn_history_fetch(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
                target,
            );
        }
        if schedule_members {
            let state = Arc::clone(&state);
            let outbound = outbound.clone();
            let client = client.clone();
            let changes = Arc::clone(&member_changes);
            spawn_task(async move {
                tokio::task::yield_now().await;
                let channels = lock(&changes).drain();
                let events = member_windows(&state, &client, instance, channels);
                for event in events {
                    let _ = outbound.send(event);
                }
            });
        }
    }
}

fn member_windows(
    state: &Arc<Mutex<RuntimeState>>,
    client: &papo::Client,
    instance: u64,
    channels: Vec<papo::ChannelName>,
) -> Vec<EngineToUi> {
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_ref()
        .filter(|running| running.instance == instance)
    else {
        return Vec::new();
    };
    let snapshot = client.state();
    let buffers = channels
        .into_iter()
        .filter_map(|channel| {
            let buffer_id = running.model.buffer_id_for_channel(&channel)?;
            Some((channel, buffer_id))
        })
        .collect::<Vec<_>>();
    buffers
        .into_iter()
        .flat_map(|(channel, buffer_id)| {
            let (version, views) = state.member_views.changed(buffer_id);
            views
                .into_iter()
                .filter_map(|(view_id, view)| {
                    crate::members::project(
                        &snapshot,
                        &channel,
                        buffer_id,
                        &view_id,
                        version,
                        view.offset,
                        &view.filter,
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn spawn_history_fetch(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    target: SendTarget,
) {
    spawn_task(async move {
        if let Ok(page) = fetch_latest(&client, target).await {
            process_history(&state, &outbound, &client, instance, page);
        }
    });
}

async fn fetch_latest(
    client: &papo::Client,
    target: SendTarget,
) -> Result<papo::HistoryPage, papo::Error> {
    match target {
        SendTarget::Channel(channel) => {
            client
                .history(channel)
                .latest()
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        SendTarget::Direct(target) => {
            client
                .history(target.nick().clone())
                .latest()
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
    }
}

fn process_event(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    event: papo::Event,
) -> Vec<SendTarget> {
    if let papo::Event::History(page) = event {
        process_history(state, outbound, client, instance, page);
        return Vec::new();
    }
    let snapshot = client.state();
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return Vec::new();
    };
    let mut output = Vec::new();
    let history_targets = match event {
        papo::Event::Connecting(_) => {
            output.push(
                running
                    .model
                    .set_connection(NetworkConnectionState::Connecting, None),
            );
            Vec::new()
        }
        papo::Event::Connected(connected) => {
            running.model.rebuild_name_keys(&snapshot);
            output.push(running.model.set_connection(
                NetworkConnectionState::Online,
                Some(connected.nick.to_string()),
            ));
            output.extend(running.model.sync_channels(&snapshot));
            Vec::new()
        }
        papo::Event::Lagged(_) => {
            running.model.rebuild_name_keys(&snapshot);
            output.extend(running.model.sync_channels(&snapshot));
            output.push(running.model.buffers_event());
            running.model.history_targets()
        }
        papo::Event::CasemappingChanged(_) => {
            running.model.rebuild_name_keys(&snapshot);
            output.push(running.model.buffers_event());
            Vec::new()
        }
        papo::Event::ChannelRenamed(renamed) => {
            if let Some(event) = running.model.rename_channel(&renamed.old, renamed.new) {
                output.push(event);
            }
            Vec::new()
        }
        papo::Event::NickChanged(changed) => {
            process_nick_change(&mut running.model, changed, &mut output);
            Vec::new()
        }
        papo::Event::Message(message) => {
            output.extend(running.model.receive(&message, false, &snapshot));
            Vec::new()
        }
        papo::Event::ReadMarkerChanged(marker) => {
            output.extend(
                running
                    .model
                    .apply_server_read_marker(&marker.conversation, marker.read_until),
            );
            Vec::new()
        }
        papo::Event::Joined(joined) => {
            process_join(&mut running.model, &snapshot, &joined, &mut output)
        }
        papo::Event::Parted(parted) => {
            process_part(&mut running.model, &snapshot, &parted, &mut output);
            Vec::new()
        }
        papo::Event::Quit(quit) => {
            process_quit(&mut running.model, &quit, &mut output);
            Vec::new()
        }
        papo::Event::ChannelSynced(_) | papo::Event::TopicChanged(_) => {
            output.extend(running.model.sync_channels(&snapshot));
            Vec::new()
        }
        papo::Event::Disconnected(disconnected) => {
            output.push(
                running
                    .model
                    .set_connection(disconnected_state(&disconnected), None),
            );
            Vec::new()
        }
        _ => Vec::new(),
    };
    drop(state);
    for event in output {
        let _ = outbound.send(event);
    }
    history_targets
}

fn process_nick_change(
    model: &mut NetworkModel,
    changed: papo::event::NickChanged,
    output: &mut Vec<EngineToUi>,
) {
    if changed.authorship == papo::Authorship::Own {
        output.push(model.set_nickname(changed.new.to_string()));
    }
    if let Some(event) = model.rename_direct(changed.actor.nick(), changed.new) {
        output.push(event);
    }
}

fn disconnected_state(disconnected: &papo::Disconnected) -> NetworkConnectionState {
    if disconnected.is_reconnecting() {
        NetworkConnectionState::Reconnecting
    } else {
        NetworkConnectionState::Stopped
    }
}

fn process_part(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    parted: &papo::event::Parted,
    output: &mut Vec<EngineToUi>,
) {
    if parted.authorship != papo::Authorship::Own
        && let Some(event) = model.receive_membership(
            &parted.channel,
            MembershipKind::Parted,
            parted.actor.nick().to_string(),
            parted.server_time.map(time_millis),
            time_millis(parted.received_at),
        )
    {
        output.push(event);
    }
    output.extend(model.sync_channels(snapshot));
}

fn process_quit(model: &mut NetworkModel, quit: &papo::event::Quit, output: &mut Vec<EngineToUi>) {
    for channel in &quit.channels {
        if let Some(event) = model.receive_membership(
            channel,
            MembershipKind::Quit,
            quit.actor.nick().to_string(),
            quit.server_time.map(time_millis),
            time_millis(quit.received_at),
        ) {
            output.push(event);
        }
    }
}

fn process_join(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    joined: &papo::event::Joined,
    output: &mut Vec<EngineToUi>,
) -> Vec<SendTarget> {
    output.extend(model.sync_channels(snapshot));
    if joined.authorship == papo::Authorship::Own {
        model
            .request_latest_channel(&joined.channel)
            .into_iter()
            .collect()
    } else {
        if let Some(event) = model.receive_membership(
            &joined.channel,
            MembershipKind::Joined,
            joined.actor.nick().to_string(),
            joined.server_time.map(time_millis),
            time_millis(joined.received_at),
        ) {
            output.push(event);
        }
        Vec::new()
    }
}

fn process_history(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    page: papo::HistoryPage,
) {
    let snapshot = client.state();
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return;
    };
    let prepend = page.reason == papo::HistoryReason::Requested;
    let mut output = Vec::new();
    let mut timeline = None::<(BufferId, Vec<crate::MessageProjection>)>;
    let mut unread = None;
    for item in page.items {
        match item {
            papo::Event::Message(message) => {
                for event in running.model.receive(&message, true, &snapshot) {
                    match event {
                        EngineToUi::MessagesAppended {
                            buffer_id,
                            messages,
                        } => timeline
                            .get_or_insert_with(|| (buffer_id, Vec::new()))
                            .1
                            .extend(messages),
                        EngineToUi::UnreadChanged { .. } => unread = Some(event),
                        _ => output.push(event),
                    }
                }
            }
            papo::Event::Joined(joined) if joined.authorship != papo::Authorship::Own => {
                if let Some(event) = running.model.receive_membership(
                    &joined.channel,
                    MembershipKind::Joined,
                    joined.actor.nick().to_string(),
                    joined.server_time.map(time_millis),
                    time_millis(joined.received_at),
                ) {
                    output.push(event);
                }
            }
            papo::Event::Parted(parted) if parted.authorship != papo::Authorship::Own => {
                if let Some(event) = running.model.receive_membership(
                    &parted.channel,
                    MembershipKind::Parted,
                    parted.actor.nick().to_string(),
                    parted.server_time.map(time_millis),
                    time_millis(parted.received_at),
                ) {
                    output.push(event);
                }
            }
            papo::Event::Quit(quit) => {
                for channel in &quit.channels {
                    if let Some(event) = running.model.receive_membership(
                        channel,
                        MembershipKind::Quit,
                        quit.actor.nick().to_string(),
                        quit.server_time.map(time_millis),
                        time_millis(quit.received_at),
                    ) {
                        output.push(event);
                    }
                }
            }
            _ => {}
        }
    }
    if let Some((buffer_id, mut messages)) = timeline {
        messages.sort_by_key(|message| {
            (
                message.server_time_ms.unwrap_or(message.received_at_ms),
                message.received_at_ms,
                message.id.0,
            )
        });
        output.push(if prepend {
            EngineToUi::MessagesPrepended {
                buffer_id,
                messages,
            }
        } else {
            EngineToUi::MessagesAppended {
                buffer_id,
                messages,
            }
        });
    }
    if let Some(unread) = unread {
        output.push(unread);
    }
    drop(state);
    for event in output {
        let _ = outbound.send(event);
    }
}

fn valid_endpoint(endpoint: &str, allow_insecure: bool) -> bool {
    endpoint.starts_with("wss://") || (allow_insecure && endpoint.starts_with("ws://"))
}

fn rejected_command(command_id: String, message_key: &str) -> Vec<EngineToUi> {
    vec![EngineToUi::CommandRejected {
        id: command_id,
        message_key: message_key.into(),
    }]
}

fn join_error_key(error: &papo::Error) -> &'static str {
    if matches!(
        error,
        papo::Error::Server(error) if error.refusal() == papo::Refusal::BannedFromChannel
    ) {
        "engine.join_banned"
    } else {
        "engine.command_refused"
    }
}

fn spawn_request<T: Send + 'static>(
    outbound: mpsc::UnboundedSender<EngineToUi>,
    command_id: String,
    request: impl std::future::Future<Output = Result<T, papo::Error>> + Send + 'static,
) {
    spawn_task(async move {
        let event = match request.await {
            Ok(_) => EngineToUi::CommandResult { id: command_id },
            Err(_) => EngineToUi::CommandRejected {
                id: command_id,
                message_key: "engine.command_refused".into(),
            },
        };
        let _ = outbound.send(event);
    });
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn spawn_task(future: impl std::future::Future<Output = ()> + 'static) {
    wasm_bindgen_futures::spawn_local(future);
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn spawn_task(future: impl std::future::Future<Output = ()> + Send + 'static) {
    tokio::spawn(future);
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use papo_testing::wire;
    use tokio::sync::mpsc;

    use super::{
        MemberViews, RunningNetwork, Runtime, RuntimeState, drain_events, fetch_latest, lock,
        process_event, process_history,
    };
    use crate::{
        BufferId, BufferKind, EngineRequest, EngineRequestEnvelope, EngineToUi, NetworkId,
        SaslCredentials,
        state::{NetworkModel, SendTarget},
    };

    #[test]
    fn member_views_keep_independent_ranges_and_advance_together() {
        let mut views = MemberViews::default();
        for (id, offset) in [("left", 640), ("right", 1_280)] {
            assert_eq!(
                views.remember(
                    id,
                    super::MemberView {
                        buffer_id: BufferId(7),
                        offset,
                        filter: String::new(),
                    },
                ),
                0
            );
        }

        let (version, changed) = views.changed(BufferId(7));
        let mut ranges = changed
            .into_iter()
            .map(|(id, view)| (id, view.offset))
            .collect::<Vec<_>>();
        ranges.sort();
        assert_eq!(version, 1);
        assert_eq!(ranges, [("left".into(), 640), ("right".into(), 1_280)]);
    }

    #[tokio::test]
    async fn live_member_deltas_refresh_each_viewed_window() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["multi-prefix"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":offline.test 005 weblounge PREFIX=(ov)@+ CHANMODES=b,k,l,imnst :supported")
            .await;
        wire.server(":weblounge!u@h JOIN #large").await;
        for start in (0..2_000).step_by(50) {
            let names = (start..start + 50)
                .map(|index| format!("u{index:04}"))
                .collect::<Vec<_>>()
                .join(" ");
            wire.server(format!(":offline.test 353 weblounge = #large :{names}"))
                .await;
        }
        wire.server(":offline.test 366 weblounge #large :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;

        let (state, outbound, mut receiver) = harness(client.clone());
        let buffer_id = {
            let mut runtime = lock(&state);
            let running = runtime.network.as_mut().expect("network remains running");
            running.model.sync_channels(&client.state());
            running
                .model
                .buffer_id_for_channel(&client.state().name_rules().channel("#large"))
                .expect("large channel buffer")
        };
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound,
            client,
            events,
            1,
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        _ = collect(&mut receiver);
        for (view_id, offset) in [("left", 700), ("right", 1_400)] {
            let output = runtime.request(EngineRequestEnvelope {
                id: format!("request-{view_id}"),
                request: EngineRequest::RequestMembers {
                    buffer_id,
                    view_id: view_id.into(),
                    offset,
                    filter: None,
                },
            });
            assert_latest_window(
                &output,
                view_id,
                offset,
                if offset == 700 { "u0700" } else { "u1400" },
            );
        }

        wire.server(":a-new!u@h JOIN #large").await;
        let joined = member_patch_burst(&mut receiver).await;
        assert_latest_window(&joined, "left", 700, "u0699");
        assert_latest_window(&joined, "right", 1_400, "u1399");

        wire.server(":weblounge!u@h MODE #large +o u1500").await;
        let mode = member_patch_burst(&mut receiver).await;
        assert_latest_window(&mode, "left", 700, "u0698");
        assert_latest_window(&mode, "right", 1_400, "u1398");

        for index in 0..500 {
            wire.server(format!(":u{index:04}!u@h QUIT :split")).await;
        }
        let split = member_patch_burst(&mut receiver).await;
        assert!(
            split.len() <= 10,
            "unbounded split patches: {}",
            split.len()
        );
        assert_latest_window(&split, "left", 700, "u1198");
        assert_latest_window(&split, "right", 1_400, "u1899");
        drain.abort();
    }

    fn assert_window(
        events: &[EngineToUi],
        view_id: &str,
        offset: u32,
        version: u64,
        first_nick: &str,
    ) {
        assert!(
            events.iter().any(|event| matches!(event,
                EngineToUi::MembersChanged {
                    view_id: id, version: current, offset: start, members, ..
                } if id == view_id && *current == version && *start == offset
                    && members.first().is_some_and(|member| member.nick == first_nick)
            )),
            "missing {view_id} window at version {version}"
        );
    }

    fn assert_latest_window(events: &[EngineToUi], view_id: &str, offset: u32, first_nick: &str) {
        let version = events
            .iter()
            .filter_map(|event| match event {
                EngineToUi::MembersChanged {
                    view_id: id,
                    version,
                    ..
                } if id == view_id => Some(*version),
                _ => None,
            })
            .max()
            .expect("view received a split window");
        assert_window(events, view_id, offset, version, first_nick);
    }

    async fn member_patch_burst(
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
    ) -> Vec<EngineToUi> {
        let mut members = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_millis(250), receiver.recv()).await {
                Ok(Some(event @ EngineToUi::MembersChanged { .. })) => members.push(event),
                Ok(None) | Err(_) if !members.is_empty() => return members,
                Ok(None) => panic!("runtime event stream closed"),
                Ok(Some(_)) | Err(_) => {}
            }
        }
    }

    #[test]
    fn rejected_commands_emit_a_typed_terminal_result() {
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let requests = [
            EngineRequest::Connect {
                label: "Test".into(),
                endpoint: "ws://insecure.test".into(),
                nickname: "weblounge".into(),
                sasl: SaslCredentials {
                    account: "weblounge".into(),
                    password: "secret".into(),
                },
                autojoin: Vec::new(),
                allow_insecure: false,
            },
            EngineRequest::Disconnect {
                network_id: NetworkId(1),
                reason: None,
            },
            EngineRequest::SendMessage {
                buffer_id: BufferId(1),
                text: "hello".into(),
            },
        ];

        for (index, request) in requests.into_iter().enumerate() {
            let id = format!("rejected-{index}");
            let output = runtime.request(EngineRequestEnvelope {
                id: id.clone(),
                request,
            });
            assert!(matches!(output.as_slice(), [
                EngineToUi::CommandRejected { id: result_id, .. },
            ] if result_id == &id));
        }
    }

    #[test]
    fn help_requests_client_side_catalog_rendering() {
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);

        assert_eq!(
            runtime.request(EngineRequestEnvelope {
                id: "help-1".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: BufferId(1),
                    input: "/help join".into(),
                },
            }),
            [
                EngineToUi::CommandHelpRequested {
                    command: Some("join".into()),
                },
                EngineToUi::CommandResult {
                    id: "help-1".into(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn open_direct_adds_and_focuses_the_engine_buffer() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "open-mel".into(),
            request: EngineRequest::OpenDirect {
                network_id: NetworkId(1),
                nick: "mel".into(),
            },
        });
        assert!(matches!(output.as_slice(), [
            EngineToUi::BufferAdded { buffer },
            EngineToUi::BuffersChanged { .. },
            EngineToUi::FocusBufferRequested { buffer_id, .. },
            EngineToUi::CommandResult { .. },
        ] if buffer.kind == BufferKind::Direct && buffer.title == "mel" && buffer.id == *buffer_id));
    }

    #[tokio::test]
    async fn second_connect_is_rejected_without_replacing_the_running_client() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(
                        NetworkId(1),
                        "Existing".into(),
                        "weblounge".into(),
                        50,
                    ),
                }),
            })),
            outbound,
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "connect-again".into(),
            request: EngineRequest::Connect {
                label: "Replacement".into(),
                endpoint: "wss://irc.example.test".into(),
                nickname: "weblounge".into(),
                sasl: SaslCredentials {
                    account: "weblounge".into(),
                    password: "secret".into(),
                },
                autojoin: Vec::new(),
                allow_insecure: false,
            },
        });

        assert!(matches!(
            output.as_slice(),
            [EngineToUi::CommandRejected { id, message_key }]
                if id == "connect-again" && message_key == "engine.network_already_connected"
        ));
        assert_eq!(
            lock(&runtime.state)
                .network
                .as_ref()
                .map(|running| running.instance),
            Some(1)
        );
    }

    #[tokio::test]
    async fn completion_results_are_computed_by_the_engine_projection() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "complete".into(),
            request: EngineRequest::CompleteInput {
                buffer_id: BufferId(1),
                prefix: "/j".into(),
            },
        });

        assert!(matches!(
            output.as_slice(),
            [
                EngineToUi::CompletionResult {
                    command_id,
                    prefix,
                    candidates,
                    ..
                },
                EngineToUi::CommandResult { id }
            ] if command_id == "complete"
                && id == "complete"
                && prefix == "/j"
                && candidates == &["/join"]
        ));
    }

    #[tokio::test]
    async fn submit_join_and_msg_use_typed_papo_commands() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let join_output = runtime.request(EngineRequestEnvelope {
            id: "join".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #new secret".into(),
            },
        });
        assert!(join_output.is_empty(), "unexpected output: {join_output:?}");
        assert_eq!(wire.next_sent().await, "JOIN #new secret");
        wire.server(":weblounge!u@host JOIN #new").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let buffer_id = {
            let mut state = lock(&runtime.state);
            let running = state.network.as_mut().expect("network remains running");
            running.model.sync_channels(&running.client.state());
            let target = SendTarget::Channel(running.client.state().name_rules().channel("#new"));
            running
                .model
                .buffer_id_for_target(&target)
                .expect("joined buffer exists")
        };
        let completion = runtime.request(EngineRequestEnvelope {
            id: "complete-member".into(),
            request: EngineRequest::CompleteInput {
                buffer_id,
                prefix: "web".into(),
            },
        });
        assert!(matches!(
            completion.first(),
            Some(EngineToUi::CompletionResult { candidates, .. })
                if candidates.is_empty()
        ));

        runtime.request(EngineRequestEnvelope {
            id: "topic".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/topic new topic".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "TOPIC #new :new topic");
        wire.server(":weblounge!u@host TOPIC #new :new topic").await;
        runtime.request(EngineRequestEnvelope {
            id: "nick".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/nick lounge2".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "NICK lounge2");
        wire.server(":weblounge!u@host NICK lounge2").await;
        let changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::NickChanged(_))
        })
        .await;
        process_runtime_event(&runtime, changed);
        assert_network_nickname(&mut receiver, "lounge2");
        runtime.request(EngineRequestEnvelope {
            id: "part".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/part later".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "PART #new later");
        wire.server(":lounge2!u@host PART #new :later").await;

        let output = runtime.request(EngineRequestEnvelope {
            id: "msg".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/msg alice hello".into(),
            },
        });
        assert!(output.iter().any(
            |event| matches!(event, EngineToUi::BufferAdded { buffer } if buffer.title == "alice")
        ));
        let focused = output
            .iter()
            .any(|event| matches!(event, EngineToUi::FocusBufferRequested { .. }));
        assert!(!focused);
        assert_eq!(wire.next_sent().await, "PRIVMSG alice hello");
    }

    #[tokio::test]
    async fn submit_join_preserves_each_channel_key_on_the_wire() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "join-pairs".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #a,#b key1,key2".into(),
            },
        });

        assert!(output.is_empty(), "unexpected output: {output:?}");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), wire.next_sent())
                .await
                .expect("first keyed join is sent"),
            "JOIN #a key1"
        );
        wire.server(":weblounge!u@host JOIN #a").await;
        tokio::time::timeout(
            Duration::from_secs(1),
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))),
        )
        .await
        .expect("first join completes");
        wire.server(":offline.test 366 weblounge #a :End of NAMES")
            .await;
        let second = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let line = wire.next_sent().await;
                if line.starts_with("JOIN ") {
                    break line;
                }
            }
        })
        .await
        .expect("second keyed join is sent");
        assert_eq!(second, "JOIN #b key2");
    }

    #[tokio::test]
    async fn banned_join_numeric_becomes_a_typed_notice() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "banned-join".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id: BufferId(1),
                        input: "/join #banned".into(),
                    },
                })
                .is_empty()
        );
        assert_eq!(wire.next_sent().await, "JOIN #banned");
        wire.server(":irc.test 474 weblounge #banned :Cannot join channel (+b)")
            .await;

        let result = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("join rejection resolves")
            .expect("runtime remains subscribed");
        assert_eq!(
            result,
            EngineToUi::CommandRejected {
                id: "banned-join".into(),
                message_key: "engine.join_banned".into(),
            }
        );
    }

    async fn next_matching(
        events: &mut papo::Events,
        predicate: impl Fn(&papo::Event) -> bool,
    ) -> papo::Event {
        loop {
            let event = events.next().await.expect("papo event stream remains open");
            if predicate(&event) {
                return event;
            }
        }
    }

    fn process_runtime_event(runtime: &Runtime, event: papo::Event) {
        let client = lock(&runtime.state)
            .network
            .as_ref()
            .expect("network remains running")
            .client
            .clone();
        process_event(&runtime.state, &runtime.outbound, &client, 1, event);
    }

    fn assert_network_nickname(receiver: &mut mpsc::UnboundedReceiver<EngineToUi>, expected: &str) {
        assert!(collect(receiver).iter().any(|event| matches!(
            event,
            EngineToUi::NetworkStateChanged { network } if network.nickname == expected
        )));
    }

    fn harness(
        client: papo::Client,
    ) -> (
        Arc<Mutex<RuntimeState>>,
        mpsc::UnboundedSender<EngineToUi>,
        mpsc::UnboundedReceiver<EngineToUi>,
    ) {
        let model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let state = Arc::new(Mutex::new(RuntimeState {
            next_network_id: 2,
            next_instance: 2,
            member_views: MemberViews::default(),
            network: Some(RunningNetwork {
                instance: 1,
                client,
                model,
            }),
        }));
        let (outbound, receiver) = mpsc::unbounded_channel();
        (state, outbound, receiver)
    }

    fn collect(receiver: &mut mpsc::UnboundedReceiver<EngineToUi>) -> Vec<EngineToUi> {
        let mut output = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            output.push(event);
        }
        output
    }

    async fn register_for_history(wire: &mut papo_testing::Wire) {
        assert_eq!(wire.next_sent().await, "CAP LS 302");
        assert_eq!(wire.next_sent().await, "NICK weblounge");
        assert!(wire.next_sent().await.starts_with("USER "));
        let caps = "draft/chathistory labeled-response batch server-time message-tags";
        wire.server(format!(":offline.test CAP * LS :{caps}")).await;
        let requested = wire
            .next_sent()
            .await
            .strip_prefix("CAP REQ :")
            .expect("history capabilities are requested")
            .to_owned();
        wire.server(format!(":offline.test CAP * ACK :{requested}"))
            .await;
        assert_eq!(wire.next_sent().await, "CAP END");
        wire.server(
            ":offline.test 005 weblounge CASEMAPPING=rfc1459 CHANTYPES=# CHATHISTORY=100 MSGREFTYPES=msgid,timestamp :supported",
        )
        .await;
        wire.server(":offline.test 001 weblounge :Welcome").await;
        wire.server(":offline.test 376 weblounge :End of MOTD")
            .await;
    }

    fn request_label(request: &str) -> &str {
        request
            .strip_prefix("@label=")
            .and_then(|line| line.split_once(' '))
            .map(|(label, _)| label)
            .expect("catch-up request has a label")
    }

    async fn send_history_page(wire: &mut papo_testing::Wire, label: &str, items: &[&str]) {
        let reply = format!("reply{label}");
        let history = format!("history{label}");
        wire.server(format!(
            "@label={label} :offline.test BATCH +{reply} labeled-response"
        ))
        .await;
        wire.server(format!(
            "@batch={reply} :offline.test BATCH +{history} chathistory #room"
        ))
        .await;
        for item in items {
            wire.server(format!("@batch={history};{item}")).await;
        }
        wire.server(format!("@batch={reply} :offline.test BATCH -{history}"))
            .await;
        wire.server(format!(":offline.test BATCH -{reply}")).await;
    }

    #[tokio::test]
    async fn latest_history_on_join_is_sorted_and_deduplicates_live_overlap() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        register_for_history(&mut wire).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let targets = process_event(&state, &outbound, &client, 1, joined);
        assert_eq!(targets.len(), 1);
        assert!(
            !collect(&mut receiver)
                .iter()
                .any(|event| matches!(event, EngineToUi::FocusBufferRequested { .. }))
        );

        wire.server(
            "@time=2026-10-27T12:00:02.000Z;msgid=live :alice!a@host PRIVMSG #room :live overlap",
        )
        .await;
        let live = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, live);
        _ = collect(&mut receiver);

        let fetch_client = client.clone();
        let target = targets[0].clone();
        let fetch = tokio::spawn(async move { fetch_latest(&fetch_client, target).await });
        let request = wire.next_sent().await;
        assert!(request.ends_with("CHATHISTORY LATEST #room * 100"));
        let label = request_label(&request);
        send_history_page(
            &mut wire,
            label,
            &[
                "time=2026-10-27T12:00:02.000Z;msgid=live :alice!a@host PRIVMSG #room :live overlap",
                "time=2026-10-27T12:00:01.000Z;msgid=middle :alice!a@host PRIVMSG #room :middle",
                "time=2026-10-27T12:00:00.000Z;msgid=older :alice!a@host PRIVMSG #room :older",
            ],
        )
        .await;
        let page = fetch
            .await
            .expect("history task completes")
            .expect("history request succeeds");
        process_history(&state, &outbound, &client, 1, page);

        let prepended = collect(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::MessagesPrepended { messages, .. } => Some(
                    messages
                        .into_iter()
                        .map(|message| message.text)
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .expect("requested history is prepended");
        assert_eq!(prepended, ["older", "middle"]);
    }

    #[tokio::test]
    async fn empty_latest_history_page_keeps_the_conversation() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        register_for_history(&mut wire).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let targets = process_event(&state, &outbound, &client, 1, joined);
        _ = collect(&mut receiver);

        let fetch_client = client.clone();
        let target = targets[0].clone();
        let fetch = tokio::spawn(async move { fetch_latest(&fetch_client, target).await });
        let request = wire.next_sent().await;
        let label = request_label(&request);
        send_history_page(&mut wire, label, &[]).await;
        let page = fetch
            .await
            .expect("history task completes")
            .expect("empty history is successful");
        process_history(&state, &outbound, &client, 1, page);

        assert!(collect(&mut receiver).is_empty());
        let buffers = lock(&state)
            .network
            .as_ref()
            .expect("network remains active")
            .model
            .buffers_event();
        assert!(matches!(
            buffers,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer| buffer.title == "#room")
        ));
    }

    #[tokio::test]
    async fn mark_read_without_server_support_advances_local_counts() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        _ = collect(&mut receiver);
        wire.server("@time=2026-10-27T12:00:00.000Z;msgid=one :alice!a@host PRIVMSG #room :hello")
            .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        let appended = collect(&mut receiver);
        let (buffer_id, message_id) = appended
            .iter()
            .find_map(|event| match event {
                EngineToUi::MessagesAppended {
                    buffer_id,
                    messages,
                } => Some((*buffer_id, messages[0].id)),
                _ => None,
            })
            .expect("live message is projected");
        let runtime = Runtime { state, outbound };

        let output = runtime.request(EngineRequestEnvelope {
            id: "mark-local".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });

        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::UnreadChanged {
                unread: 0,
                mentions: 0,
                ..
            }
        )));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::ReadMarkerMoved { through: Some(id), .. } if *id == message_id
        )));
    }

    #[tokio::test]
    async fn mark_read_with_server_support_uses_papo_request() {
        let caps = [
            "draft/read-marker",
            "labeled-response",
            "message-tags",
            "server-time",
        ];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        _ = collect(&mut receiver);
        wire.server("@time=2026-10-27T12:00:00.000Z;msgid=one :alice!a@host PRIVMSG #room :hello")
            .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        let appended = collect(&mut receiver);
        let (buffer_id, message_id) = appended
            .iter()
            .find_map(|event| match event {
                EngineToUi::MessagesAppended {
                    buffer_id,
                    messages,
                } => Some((*buffer_id, messages[0].id)),
                _ => None,
            })
            .expect("live message is projected");
        let runtime = Runtime { state, outbound };

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "mark-server".into(),
                    request: EngineRequest::MarkRead {
                        buffer_id,
                        through: message_id
                    },
                })
                .is_empty()
        );
        let request = wire.next_sent().await;
        let label = request_label(&request).to_owned();
        assert!(request.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"));
        wire.server(format!(
            "@label={label} :offline.test MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"
        ))
        .await;

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("mark response arrives")
            .expect("runtime remains open");
        assert!(matches!(
            result,
            EngineToUi::UnreadChanged { unread: 0, .. }
        ));
    }

    #[tokio::test]
    async fn another_device_read_marker_never_moves_backwards() {
        let caps = ["draft/read-marker", "message-tags", "server-time"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        _ = collect(&mut receiver);
        for (id, second) in [("one", 0), ("two", 1)] {
            wire.server(format!(
                "@time=2026-10-27T12:00:0{second}.000Z;msgid={id} :alice!a@host PRIVMSG #room :{id}"
            ))
            .await;
            let message = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Message(_))
            })
            .await;
            process_event(&state, &outbound, &client, 1, message);
        }
        _ = collect(&mut receiver);

        wire.server(":offline.test MARKREAD #room timestamp=2026-10-27T12:00:01.000Z")
            .await;
        let newer = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ReadMarkerChanged(_))
        })
        .await;
        let conversation = match &newer {
            papo::Event::ReadMarkerChanged(marker) => marker.conversation.clone(),
            _ => unreachable!("matching event is a read marker"),
        };
        process_event(&state, &outbound, &client, 1, newer);
        assert!(
            collect(&mut receiver)
                .iter()
                .any(|event| matches!(event, EngineToUi::UnreadChanged { unread: 0, .. }))
        );

        let older = std::time::UNIX_EPOCH + std::time::Duration::from_hours(498_084);
        let output = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .apply_server_read_marker(&conversation, Some(older));
        assert!(output.is_empty());
    }

    #[tokio::test]
    async fn connected_and_reconnected_refresh_network_state_from_wire() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, connected);
        assert_eq!(
            lock(&state)
                .network
                .as_ref()
                .map(|running| running.model.name_rebuild_count()),
            Some(1)
        );
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::NetworkStateChanged { network }
                if network.state == crate::NetworkConnectionState::Online
        )));

        wire.close().await;
        let disconnected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, disconnected);
        client.reconnect().await.expect("manual reconnect starts");
        wire.register(&[]).await;
        let connected = next_matching(
            &mut events,
            |event| matches!(event, papo::Event::Connected(connected) if connected.reconnected),
        )
        .await;
        process_event(&state, &outbound, &client, 1, connected);
        assert_eq!(
            lock(&state)
                .network
                .as_ref()
                .map(|running| running.model.name_rebuild_count()),
            Some(2)
        );

        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::NetworkStateChanged { network }
                if network.state == crate::NetworkConnectionState::Online
        )));
    }

    #[tokio::test]
    async fn casemapping_channel_and_nick_changes_rebuild_stable_buffers() {
        let caps = ["draft/channel-rename", "message-tags"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());

        wire.server(":weblounge!u@host JOIN #Room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        process_event(&state, &outbound, &client, 1, joined);
        let channel_id = collect(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::BufferAdded { buffer } if buffer.kind == BufferKind::Channel => {
                    Some(buffer.id)
                }
                _ => None,
            })
            .expect("join adds a channel buffer");

        wire.server(":alice!a@host TOPIC #Room :A quiet place to chat")
            .await;
        let topic = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TopicChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, topic);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer|
                    buffer.id == channel_id
                        && buffer.topic.as_deref() == Some("A quiet place to chat")
                )
        )));

        wire.server(":oper!o@host RENAME #Room #Archive :Archived")
            .await;
        let renamed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelRenamed(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, renamed);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer| buffer.id == channel_id && buffer.title == "#Archive")
        )));

        wire.server(":alice!a@host PRIVMSG weblounge :hello").await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        let direct_id = collect(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::BufferAdded { buffer } if buffer.kind == BufferKind::Direct => {
                    Some(buffer.id)
                }
                _ => None,
            })
            .expect("private line adds a direct buffer");
        wire.server(":alice!a@host NICK alicia").await;
        let changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::NickChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, changed);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer| buffer.id == direct_id && buffer.title == "alicia")
        )));

        wire.server(":offline.test 005 weblounge CASEMAPPING=ascii CHANTYPES=# :are supported")
            .await;
        let changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::CasemappingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, changed);
        assert!(
            collect(&mut receiver)
                .iter()
                .any(|event| matches!(event, EngineToUi::BuffersChanged { .. }))
        );
    }

    #[tokio::test]
    async fn lagged_resyncs_and_returns_open_history_targets() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").event_capacity(1));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, _receiver) = harness(client.clone());
        let snapshot = client.state();
        lock(&state)
            .network
            .as_mut()
            .expect("running network")
            .model
            .sync_channels(&snapshot);

        for index in 0..4 {
            wire.server(format!(
                ":alice!a@host PRIVMSG #room :queued message {index}"
            ))
            .await;
        }
        let lagged =
            next_matching(&mut events, |event| matches!(event, papo::Event::Lagged(_))).await;
        let targets = process_event(&state, &outbound, &client, 1, lagged);

        assert!(matches!(targets.as_slice(), [SendTarget::Channel(channel)] if channel == "#room"));
    }

    #[tokio::test]
    async fn catchup_history_page_merges_and_deduplicates_live_overlap() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge")
                .history_on_reconnect(true)
                .autojoin(["#room"]),
        );
        register_for_history(&mut wire).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        _ = collect(&mut receiver);

        wire.server(
            "@time=2026-10-15T12:00:00.000Z;msgid=live-1 :alice!a@host PRIVMSG #room :before disconnect",
        )
        .await;
        let live = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, live);
        _ = collect(&mut receiver);

        wire.close().await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        client.reconnect().await.expect("manual reconnect starts");
        register_for_history(&mut wire).await;
        let connected = next_matching(
            &mut events,
            |event| matches!(event, papo::Event::Connected(connected) if connected.reconnected),
        )
        .await;
        process_event(&state, &outbound, &client, 1, connected);
        _ = collect(&mut receiver);
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        let request = wire.next_sent().await;
        let label = request_label(&request);
        assert!(request.contains("CHATHISTORY AFTER #room msgid=live-1"));
        send_history_page(
            &mut wire,
            label,
            &[
                "time=2026-10-15T12:00:00.000Z;msgid=live-1 :alice!a@host PRIVMSG #room :before disconnect",
                "time=2026-10-15T12:00:01.000Z;msgid=missed-1 :alice!a@host PRIVMSG #room :missed while away",
            ],
        )
        .await;

        let final_request = wire.next_sent().await;
        let final_label = request_label(&final_request);
        assert!(final_request.contains("CHATHISTORY AFTER #room msgid=missed-1"));
        send_history_page(&mut wire, final_label, &[]).await;

        let history = next_matching(&mut events, |event| {
            matches!(event, papo::Event::History(_))
        })
        .await;
        assert!(matches!(
            &history,
            papo::Event::History(page) if page.reason == papo::HistoryReason::Catchup
        ));
        process_event(&state, &outbound, &client, 1, history);
        let appended = collect(&mut receiver)
            .into_iter()
            .filter_map(|event| match event {
                EngineToUi::MessagesAppended { messages, .. } => Some(messages),
                _ => None,
            })
            .flatten()
            .map(|message| message.text)
            .collect::<Vec<_>>();

        assert_eq!(appended, ["missed while away"]);
    }

    #[tokio::test]
    async fn no_echo_action_confirms_without_server_metadata() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.state());
        let channel = model
            .history_targets()
            .into_iter()
            .find_map(|target| match target {
                SendTarget::Channel(channel) if channel == "#room" => Some(channel),
                _ => None,
            })
            .expect("joined channel is projected");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("projected channel has a stable id");
        let (pending, _) = model
            .begin_action(buffer_id, "waves".into(), &client.state())
            .expect("channel is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert_eq!(
            wire.next_sent().await,
            "PRIVMSG #room :\u{1}ACTION waves\u{1}"
        );
        let (pending, metadata) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        let event = model
            .confirm_send(&pending, &metadata)
            .expect("optimistic row exists");

        assert!(matches!(
            event,
            EngineToUi::MessageConfirmed { message, .. }
                if message.server_ids.is_empty() && message.server_time_ms.is_none()
        ));
    }

    #[tokio::test]
    async fn labelled_split_send_preserves_every_msgid_without_an_echo_row() {
        let caps = ["echo-message", "labeled-response", "message-tags"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.state());
        let channel = model
            .history_targets()
            .into_iter()
            .find_map(|target| match target {
                SendTarget::Channel(channel) if channel == "#room" => Some(channel),
                _ => None,
            })
            .expect("joined channel is projected");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("projected channel has a stable id");
        let text = "a".repeat(600);
        let (pending, _) = model
            .begin_send(buffer_id, text, &client.state())
            .expect("channel is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert!(
            wire.next_sent()
                .await
                .starts_with("@label=0 PRIVMSG #room ")
        );
        assert!(
            wire.next_sent()
                .await
                .starts_with("@label=0-1 PRIVMSG #room ")
        );
        wire.server("@label=0;msgid=first :weblounge!u@host PRIVMSG #room :first part")
            .await;
        wire.server("@label=0-1;msgid=second :weblounge!u@host PRIVMSG #room :second part")
            .await;
        let (pending, metadata) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        let event = model
            .confirm_send(&pending, &metadata)
            .expect("optimistic row exists");

        assert!(matches!(
            event,
            EngineToUi::MessageConfirmed { message, .. }
                if message.server_ids == ["first", "second"]
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), events.next())
                .await
                .is_err(),
            "correlated own echoes must be consumed into Sent"
        );
    }
}
