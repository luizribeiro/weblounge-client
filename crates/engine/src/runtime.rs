use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::sync::mpsc;

use crate::{
    BufferId, CompletionCandidate, CompletionTrigger, EngineRequest, EngineRequestEnvelope,
    EngineToUi, MembershipKind, MessageId, NetworkConnectionState, NetworkId,
    commands::{self, Command},
    state::{HistoryFetch, NetworkModel, PendingSend, ReadAdvance, SendTarget, time_millis},
};

const DEFAULT_WINDOW_LIMIT: usize = 500;
const HISTORY_PAGE_SIZE: usize = 100;
const COMPLETION_LIMIT: usize = 100;

struct CompletionContext {
    trigger: CompletionTrigger,
    replace_start: u32,
    replace_end: u32,
    prefix: String,
    argument_hint: Option<String>,
}

struct RunningNetwork {
    instance: u64,
    authentication_kind: AuthenticationKind,
    client: papo::Client,
    model: NetworkModel,
}

struct JoinTarget {
    channel: String,
    key: Option<String>,
}

enum ChannelTarget {
    Known(papo::ChannelName),
    Text(String),
}

impl ChannelTarget {
    async fn part(&self, client: &papo::Client, reason: String) -> Result<(), papo::Error> {
        match self {
            Self::Known(channel) => client.part(channel, reason).await,
            Self::Text(channel) => client.part(channel, reason).await,
        }
    }

    async fn join(&self, client: &papo::Client) -> Result<(), papo::Error> {
        match self {
            Self::Known(channel) => client.join(channel).await,
            Self::Text(channel) => client.join(channel).await,
        }
    }

    async fn set_topic(&self, client: &papo::Client, text: String) -> Result<(), papo::Error> {
        match self {
            Self::Known(channel) => client.set_topic(channel, text).await,
            Self::Text(channel) => client.set_topic(channel, text).await,
        }
    }
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
                    authentication: ConnectionAuthentication::SaslPlain {
                        account: sasl.account,
                        password: papo::Secret::from(sasl.password.into_inner()),
                    },
                    autojoin,
                    allow_insecure,
                },
            ),
            EngineRequest::ConnectHosted {
                label,
                endpoint,
                nickname,
                oauth_token,
                autojoin,
            } => self.connect(
                envelope.id,
                ConnectConfig {
                    label,
                    endpoint,
                    nickname,
                    authentication: ConnectionAuthentication::HostedOAuth {
                        token: papo::Secret::from(oauth_token.into_inner()),
                    },
                    autojoin,
                    allow_insecure: false,
                },
            ),
            EngineRequest::ExpireHostedAuthentication { network_id } => {
                self.expire_hosted_authentication(envelope.id, network_id)
            }
            EngineRequest::Disconnect { network_id, reason } => {
                self.disconnect(envelope.id, network_id, reason)
            }
            EngineRequest::SendMessage { buffer_id, text } => {
                self.send_input(envelope.id, buffer_id, text, crate::MessageKind::Text)
            }
            EngineRequest::SubmitInput { buffer_id, input } => {
                self.submit_input(envelope.id, buffer_id, &input)
            }
            EngineRequest::CompleteInput {
                buffer_id,
                input,
                cursor,
                explicit,
            } => self.complete_input(envelope.id, buffer_id, input, cursor, explicit),
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
        let parsed = commands::parse_with_registry(commands::registry(), input, &chantypes);
        if parsed.is_ok()
            && let Some(name) = commands::explicit_command_name(input)
            && let Some(running) = lock(&self.state).network.as_mut()
        {
            running.model.remember_command(name);
        }
        match parsed {
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
            Ok(Command::Topic {
                channel,
                text: None,
            }) => self.show_topic(id, buffer_id, channel.0.as_deref()),
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
            Ok(Command::Identify { password }) => self.identify(id, &password.0),
            Err(error) => rejected_command(id, error.message_key()),
        }
    }

    fn identify(&self, command_id: String, password: &str) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(
            self.outbound.clone(),
            command_id,
            client.send_raw(identify_line(password)),
        );
        Vec::new()
    }

    fn open_direct(
        &self,
        command_id: String,
        network_id: NetworkId,
        nick: String,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state
            .network
            .as_ref()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        self.capture_direct(command_id, client, instance, nick, None, true);
        Vec::new()
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
        input: String,
        cursor: u32,
        explicit: bool,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let snapshot = running.client.state();
        let Some(context) = completion_context(
            &input,
            cursor,
            explicit,
            snapshot.isupport().chantypes(),
            commands::registry(),
        ) else {
            return vec![EngineToUi::CommandResult { id: command_id }];
        };
        let candidates = match context.trigger {
            CompletionTrigger::Command => {
                command_candidates(&context.prefix, &running.model, &snapshot)
            }
            CompletionTrigger::Person => {
                person_candidates(&running.model, buffer_id, &context.prefix, &snapshot)
            }
            CompletionTrigger::Channel => {
                channel_candidates(&running.model, &context.prefix, &snapshot)
            }
        };
        vec![
            EngineToUi::CompletionResult {
                command_id: command_id.clone(),
                buffer_id,
                input,
                trigger: context.trigger,
                replace_start: context.replace_start,
                replace_end: context.replace_end,
                argument_hint: context.argument_hint,
                candidates,
            },
            EngineToUi::CommandResult { id: command_id },
        ]
    }

    fn connect(&self, command_id: String, config: ConnectConfig) -> Vec<EngineToUi> {
        if !valid_endpoint(&config.endpoint, config.allow_insecure) {
            return rejected_command(command_id, "engine.invalid_endpoint");
        }

        let authentication_kind = config.authentication.kind();
        let mut state = lock(&self.state);
        if let Some(running) = state.network.as_ref() {
            if authentication_kind == AuthenticationKind::HostedOAuth
                && running.authentication_kind == AuthenticationKind::HostedOAuth
            {
                return vec![
                    running.model.network_event(),
                    running.model.buffers_event(),
                    EngineToUi::CommandResult { id: command_id },
                ];
            }
            return rejected_command(command_id, "engine.network_already_connected");
        }
        let id = NetworkId(state.next_network_id);
        state.next_network_id += 1;
        let instance = state.next_instance;
        state.next_instance += 1;
        let sasl = config.authentication.into_sasl();
        let mut builder = papo::Client::builder(&config.endpoint, &config.nickname)
            .sasl(sasl)
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
            authentication_kind,
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

    fn expire_hosted_authentication(
        &self,
        command_id: String,
        network_id: NetworkId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(mut running) = state.network.take() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        if running.model.id() != network_id
            || running.authentication_kind != AuthenticationKind::HostedOAuth
        {
            state.network = Some(running);
            return rejected_command(command_id, "engine.network_not_found");
        }
        let event = running
            .model
            .set_connection(NetworkConnectionState::Stopped, None);
        let client = running.client;
        drop(state);
        spawn_task(async move {
            let _ = client.quit(String::new()).await;
        });
        vec![
            event,
            EngineToUi::notice("engine.hosted_auth_failed"),
            EngineToUi::CommandResult { id: command_id },
        ]
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
            crate::MessageKind::Notice => None,
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
            finish_send(&state, &outbound, &client, instance, &pending).await;
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
        if targets
            .iter()
            .any(|target| !valid_channel_input(&client.state(), &target.channel))
        {
            return rejected_command(command_id, "engine.command_refused");
        }
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            for target in targets {
                let channel_name = target.channel.clone();
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
                    let channel = client
                        .state()
                        .name_rules()
                        .map(|rules| rules.channel(channel_name));
                    if let Some(buffer_id) = channel
                        .as_ref()
                        .and_then(|channel| running.model.buffer_id_for_channel(channel))
                    {
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
            spawn_request(self.outbound.clone(), command_id, async move {
                client.notice(target, text).await
            });
        } else {
            spawn_request(self.outbound.clone(), command_id, async move {
                let target = client.direct(target).await?;
                client.notice(target, text).await
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
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        self.capture_direct(command_id, client, instance, nick, Some(text), focus);
        Vec::new()
    }

    fn capture_direct(
        &self,
        command_id: String,
        client: papo::Client,
        instance: u64,
        nick: String,
        text: Option<String>,
        focus: bool,
    ) {
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let snapshot = client.state();
            let known_nick = snapshot.name_rules().map(|rules| rules.nick(nick.clone()));
            let known = lock(&state)
                .network
                .as_ref()
                .filter(|running| running.instance == instance)
                .and_then(|running| {
                    known_nick
                        .as_ref()
                        .and_then(|nick| running.model.direct(nick))
                });
            let direct = match known {
                Some(direct) => direct,
                None => {
                    if let Ok(direct) = client.direct(&nick).await {
                        direct
                    } else {
                        let _ = outbound.send(EngineToUi::CommandRejected {
                            id: command_id,
                            message_key: "engine.direct_unavailable".into(),
                        });
                        return;
                    }
                }
            };
            let nick = direct.nick();
            let (pending, output) = {
                let mut state = lock(&state);
                let Some(running) = state
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                else {
                    return;
                };
                let (buffer_id, mut output) = running.model.open_direct(nick, direct);
                if focus {
                    output.push(EngineToUi::FocusBufferRequested {
                        command_id: command_id.clone(),
                        buffer_id,
                    });
                }
                let pending = text.and_then(|text| {
                    let (pending, events) =
                        running
                            .model
                            .begin_send(buffer_id, text, &running.client.state())?;
                    output.extend(events);
                    Some(pending)
                });
                (pending, output)
            };
            for event in output {
                let _ = outbound.send(event);
            }
            if let Some(pending) = pending {
                finish_send(&state, &outbound, &client, instance, &pending).await;
            }
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
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
        let channel = match channel_target(running, buffer_id, requested) {
            Ok(channel) => channel,
            Err(key) => return rejected_command(command_id, key),
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            channel.part(&client, reason.unwrap_or_default()).await
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
        let channel = match channel_target(running, buffer_id, requested) {
            Ok(channel) => channel,
            Err(key) => return rejected_command(command_id, key),
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            channel.part(&client, reason.unwrap_or_default()).await?;
            channel.join(&client).await
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
        if !valid_nick_input(&client.state(), &nick) {
            return rejected_command(command_id, "engine.command_refused");
        }
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
        let channel = match channel_target(running, buffer_id, requested) {
            Ok(channel) => channel,
            Err(key) => return rejected_command(command_id, key),
        };
        let client = running.client.clone();
        drop(state);
        spawn_request(self.outbound.clone(), command_id, async move {
            channel.set_topic(&client, text).await
        });
        Vec::new()
    }

    fn show_topic(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<&str>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let snapshot = running.client.state();
        let channel = requested
            .and_then(|name| snapshot.channel(name))
            .or_else(|| {
                running
                    .model
                    .channel_for_buffer(buffer_id)
                    .and_then(|name| snapshot.channel(name))
            });
        let Some(channel) = channel else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let Some(buffer_id) = running.model.buffer_id_for_channel(channel.name()) else {
            return rejected_command(command_id, "engine.channel_required");
        };
        let mut output = running
            .model
            .append_notice(
                buffer_id,
                channel.topic().unwrap_or_default().to_owned(),
                channel
                    .topic_set_by()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
                channel.topic_set_at(),
            )
            .into_iter()
            .collect::<Vec<_>>();
        output.push(EngineToUi::CommandResult { id: command_id });
        output
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
        let Some(fetch) = running.model.request_history(buffer_id) else {
            return vec![EngineToUi::CommandResult { id: command_id }];
        };
        spawn_history_fetch(
            Arc::clone(&self.state),
            self.outbound.clone(),
            running.client.clone(),
            running.instance,
            fetch,
        );
        vec![
            EngineToUi::HistoryStateChanged {
                buffer_id,
                loading: true,
                at_start: false,
            },
            EngineToUi::CommandResult { id: command_id },
        ]
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
                SendTarget::Direct { nick, .. } => client.mark_read(nick, advance.time).await,
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
    authentication: ConnectionAuthentication,
    autojoin: Vec<String>,
    allow_insecure: bool,
}

enum ConnectionAuthentication {
    SaslPlain {
        account: String,
        password: papo::Secret,
    },
    HostedOAuth {
        token: papo::Secret,
    },
}

impl ConnectionAuthentication {
    const fn kind(&self) -> AuthenticationKind {
        match self {
            Self::SaslPlain { .. } => AuthenticationKind::SaslPlain,
            Self::HostedOAuth { .. } => AuthenticationKind::HostedOAuth,
        }
    }

    fn into_sasl(self) -> papo::Sasl {
        match self {
            Self::SaslPlain { account, password } => papo::Sasl::plain(account, password),
            Self::HostedOAuth { token } => papo::Sasl::oauth_bearer(token),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthenticationKind {
    SaslPlain,
    HostedOAuth,
}

#[derive(Debug)]
enum SendError {
    Protocol,
    DirectTargetGone,
}

impl SendError {
    const fn message_key(&self) -> &'static str {
        match self {
            Self::Protocol => "engine.send_failed",
            Self::DirectTargetGone => "engine.direct_target_gone",
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
        SendTarget::Direct { recipient, .. } => if action {
            client.action(recipient, pending.text.clone()).await
        } else {
            client.privmsg(recipient, pending.text.clone()).await
        }
        .map_err(|error| {
            if matches!(error, papo::Error::TargetGone) {
                SendError::DirectTargetGone
            } else {
                SendError::Protocol
            }
        }),
    }
}

async fn finish_send(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    pending: &PendingSend,
) {
    let result = send(client, pending).await;
    let events = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        match result {
            Ok(sent) => running.model.confirm_send(pending, &sent),
            Err(error) => Some(vec![running.model.fail_send(pending, error.message_key())]),
        }
    };
    for event in events.into_iter().flatten() {
        let _ = outbound.send(event);
    }
}

fn completion_context(
    input: &str,
    cursor: u32,
    explicit: bool,
    chantypes: &str,
    registry: &commands::CommandRegistry,
) -> Option<CompletionContext> {
    let end = byte_offset(input, cursor);
    let before = input.get(..end)?;
    let replace_end = utf16_len(before);
    let word_start = before.rfind(char::is_whitespace).map_or(0, |index| {
        index + before[index..].chars().next().map_or(0, char::len_utf8)
    });
    let word = before.get(word_start..)?;
    if before.starts_with('/') && !before.contains(char::is_whitespace) {
        return Some(CompletionContext {
            trigger: CompletionTrigger::Command,
            replace_start: 0,
            replace_end,
            prefix: word.trim_start_matches('/').to_owned(),
            argument_hint: None,
        });
    }
    if let Some(context) = command_argument_context(before, word_start, replace_end, registry) {
        return Some(context);
    }
    let (trigger, prefix) = match word.chars().next() {
        Some('@') => (CompletionTrigger::Person, word.get(1..)?.to_owned()),
        Some(first) if chantypes.contains(first) => (CompletionTrigger::Channel, word.to_owned()),
        _ if explicit => (CompletionTrigger::Person, word.to_owned()),
        _ => return None,
    };
    Some(CompletionContext {
        trigger,
        replace_start: utf16_len(input.get(..word_start)?),
        replace_end,
        prefix,
        argument_hint: None,
    })
}

fn command_argument_context(
    before: &str,
    word_start: usize,
    replace_end: u32,
    registry: &commands::CommandRegistry,
) -> Option<CompletionContext> {
    let command_end = before.find(char::is_whitespace)?;
    let command = before.get(1..command_end)?;
    let spec = registry.specs().iter().find(|spec| {
        spec.name.eq_ignore_ascii_case(command)
            || spec
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(command))
    })?;
    let argument_index = before
        .get(command_end..word_start)?
        .split_whitespace()
        .count();
    let argument = spec.arguments.get(argument_index)?;
    let word = before.get(word_start..)?;
    let (trigger, prefix) = match argument.kind {
        commands::CommandArgumentKind::Channel | commands::CommandArgumentKind::ChannelList => {
            (CompletionTrigger::Channel, word.to_owned())
        }
        commands::CommandArgumentKind::Nick | commands::CommandArgumentKind::Target => (
            CompletionTrigger::Person,
            word.strip_prefix('@').unwrap_or(word).to_owned(),
        ),
        _ => return None,
    };
    Some(CompletionContext {
        trigger,
        replace_start: utf16_len(before.get(..word_start)?),
        replace_end,
        prefix,
        argument_hint: Some(spec.usage.clone()),
    })
}

fn command_candidates(
    prefix: &str,
    model: &NetworkModel,
    state: &papo::State,
) -> Vec<CompletionCandidate> {
    let mut specs = commands::registry()
        .specs()
        .iter()
        .filter(|spec| spec.surfaces.contains(&commands::CommandSurface::Slash))
        .filter(|spec| {
            spec.name
                .get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        })
        .filter(|spec| !spec.name.eq_ignore_ascii_case(prefix))
        .filter(|spec| command_requirements_met(spec, state))
        .collect::<Vec<_>>();
    specs.sort_by_key(|spec| {
        (
            spec.completion_priority,
            model.command_recency(&spec.name).unwrap_or(usize::MAX),
            spec.name.to_ascii_lowercase(),
        )
    });
    specs
        .into_iter()
        .map(|spec| CompletionCandidate::Command {
            name: spec.name.clone(),
            usage: spec.usage.clone(),
            description: spec.description.clone(),
        })
        .collect()
}

fn command_requirements_met(spec: &commands::CommandSpec, state: &papo::State) -> bool {
    spec.requirements
        .iter()
        .all(|requirement| match requirement {
            commands::CommandRequirement::Connected => true,
            commands::CommandRequirement::Feature(name) => papo::Feature::ALL
                .iter()
                .find(|feature| {
                    feature.__variant_name().eq_ignore_ascii_case(name)
                        || feature.name().eq_ignore_ascii_case(name)
                })
                .is_some_and(|feature| state.supports(*feature)),
        })
}

fn person_candidates(
    model: &NetworkModel,
    buffer_id: BufferId,
    prefix: &str,
    state: &papo::State,
) -> Vec<CompletionCandidate> {
    let mut nicks = model.recent_speakers(buffer_id, prefix, state);
    let members = model
        .channel_for_buffer(buffer_id)
        .and_then(|channel| {
            crate::members::project(
                state,
                &channel,
                buffer_id,
                "composer-suggestions",
                0,
                0,
                prefix,
            )
        })
        .and_then(|event| match event {
            EngineToUi::MembersChanged { members, .. } => Some(members),
            _ => None,
        })
        .unwrap_or_default();
    let folded_prefix = state.casemapping().fold(prefix);
    nicks.extend(
        members
            .iter()
            .filter(|member| {
                state
                    .casemapping()
                    .fold(&member.nick)
                    .starts_with(&*folded_prefix)
            })
            .map(|member| member.nick.clone()),
    );
    let mut seen = std::collections::HashSet::new();
    nicks
        .into_iter()
        .filter(|nick| state.casemapping().fold(nick) != state.nick().as_ref())
        .filter(|nick| seen.insert(state.casemapping().fold(nick).into_owned()))
        .take(COMPLETION_LIMIT)
        .map(|nick| {
            let member = members.iter().find(|member| {
                state.casemapping().fold(&member.nick) == state.casemapping().fold(&nick)
            });
            let user = state.user(state.casemapping().nick(&nick));
            CompletionCandidate::Person {
                nick_color_index: crate::state::nick_color_index(state.casemapping(), &nick),
                away: member.map_or_else(
                    || user.is_some_and(|user| matches!(user.away(), papo::Away::Away { .. })),
                    |member| member.away,
                ),
                bot: member.map_or_else(
                    || user.and_then(papo::User::is_bot) == Some(true),
                    |member| member.bot,
                ),
                nick,
            }
        })
        .collect()
}

fn channel_candidates(
    model: &NetworkModel,
    prefix: &str,
    state: &papo::State,
) -> Vec<CompletionCandidate> {
    let folded_prefix = state.casemapping().fold(prefix);
    let mut names = model.channel_names();
    names.sort_by_key(|name| {
        let joined = state.channel(state.casemapping().channel(name)).is_some();
        (!joined, state.casemapping().fold(name).into_owned())
    });
    names
        .into_iter()
        .filter(|name| state.casemapping().fold(name).starts_with(&*folded_prefix))
        .take(COMPLETION_LIMIT)
        .map(|name| CompletionCandidate::Channel { name })
        .collect()
}

fn byte_offset(input: &str, utf16_offset: u32) -> usize {
    let mut units = 0_u32;
    for (index, character) in input.char_indices() {
        if units >= utf16_offset {
            return index;
        }
        units = units.saturating_add(u32::try_from(character.len_utf16()).unwrap_or(u32::MAX));
    }
    input.len()
}

fn utf16_len(value: &str) -> u32 {
    u32::try_from(value.encode_utf16().count()).unwrap_or(u32::MAX)
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
        if let papo::Event::History(page) = event {
            process_history(&state, &outbound, &client, instance, page).await;
            continue;
        }
        let schedule_members = lock(&member_changes).record(&event, &client.state());
        let direct = match &event {
            papo::Event::Message(message) if message.authorship != papo::Authorship::Own => {
                client.direct_to(message).await.ok()
            }
            _ => None,
        };
        let history_targets =
            process_event_with_direct(&state, &outbound, &client, instance, event, direct);
        for target in history_targets {
            spawn_history_fetch(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
                HistoryFetch::Latest(target),
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
            let total = snapshot
                .channel(&channel)
                .map(|channel| u32::try_from(channel.members().count()).unwrap_or(u32::MAX))?;
            Some((channel, buffer_id, total))
        })
        .collect::<Vec<_>>();
    buffers
        .into_iter()
        .flat_map(|(channel, buffer_id, total)| {
            let count = state
                .network
                .as_mut()
                .and_then(|running| running.model.set_member_count(buffer_id, total));
            let (version, views) = state.member_views.changed(buffer_id);
            count
                .into_iter()
                .chain(views.into_iter().filter_map(|(view_id, view)| {
                    crate::members::project(
                        &snapshot,
                        &channel,
                        buffer_id,
                        &view_id,
                        version,
                        view.offset,
                        &view.filter,
                    )
                }))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn spawn_history_fetch(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    fetch: HistoryFetch,
) {
    spawn_task(async move {
        if let Ok(page) = fetch_history(&client, fetch.clone()).await {
            process_history(&state, &outbound, &client, instance, page).await;
            return;
        }
        let buffer_id = {
            let mut state = lock(&state);
            state
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
                .and_then(|running| running.model.fail_history(&fetch))
        };
        if let Some(buffer_id) = buffer_id {
            let _ = outbound.send(EngineToUi::HistoryStateChanged {
                buffer_id,
                loading: false,
                at_start: false,
            });
        }
    });
}

async fn fetch_history(
    client: &papo::Client,
    fetch: HistoryFetch,
) -> Result<papo::HistoryPage, papo::Error> {
    match fetch {
        HistoryFetch::Latest(SendTarget::Channel(channel)) => {
            client
                .history(channel)
                .latest()
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        HistoryFetch::Latest(SendTarget::Direct { nick, .. }) => {
            client.history(nick).latest().limit(HISTORY_PAGE_SIZE).await
        }
        HistoryFetch::Before {
            target: SendTarget::Channel(channel),
            oldest,
        } => {
            client
                .history(channel)
                .before(oldest)
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        HistoryFetch::Before {
            target: SendTarget::Direct { nick, .. },
            oldest,
        } => {
            client
                .history(nick)
                .before(oldest)
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
    }
}

#[cfg(test)]
async fn fetch_latest(
    client: &papo::Client,
    target: SendTarget,
) -> Result<papo::HistoryPage, papo::Error> {
    fetch_history(client, HistoryFetch::Latest(target)).await
}

#[cfg(test)]
fn process_event(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    event: papo::Event,
) -> Vec<SendTarget> {
    process_event_with_direct(state, outbound, client, instance, event, None)
}

fn process_event_with_direct(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    event: papo::Event,
    direct: Option<papo::DirectRef>,
) -> Vec<SendTarget> {
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
    let mut clear_hosted_authentication = false;
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
        papo::Event::Lagged(lagged) => {
            process_lagged(&mut running.model, &snapshot, &lagged, &mut output)
        }
        papo::Event::Warning(papo::event::Warning::ChannelRecreated { .. }) => {
            output.push(EngineToUi::notice("engine.channel_recreated"));
            Vec::new()
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
            output.extend(running.model.receive(&message, false, &snapshot, direct));
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
            clear_hosted_authentication = process_disconnect(running, &disconnected, &mut output);
            Vec::new()
        }
        _ => Vec::new(),
    };
    if clear_hosted_authentication {
        state.network = None;
    }
    drop(state);
    for event in output {
        let _ = outbound.send(event);
    }
    history_targets
}

fn process_disconnect(
    running: &mut RunningNetwork,
    disconnected: &papo::Disconnected,
    output: &mut Vec<EngineToUi>,
) -> bool {
    output.push(
        running
            .model
            .set_connection(disconnected_state(disconnected), None),
    );
    let hosted_authentication_failed = running.authentication_kind
        == AuthenticationKind::HostedOAuth
        && is_sasl_failure(disconnected);
    output.extend(connection_failure_notice(
        disconnected,
        hosted_authentication_failed,
    ));
    hosted_authentication_failed
}

fn process_lagged(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    lagged: &papo::event::Lagged,
    output: &mut Vec<EngineToUi>,
) -> Vec<SendTarget> {
    output.push(EngineToUi::Diagnostic {
        command_id: "papo.event_queue".into(),
        message: format!("{} papo events dropped", lagged.dropped),
    });
    model.rebuild_name_keys(snapshot);
    output.extend(model.sync_channels(snapshot));
    output.push(model.buffers_event());
    model.history_targets()
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

fn connection_failure_notice(
    disconnected: &papo::Disconnected,
    hosted_authentication_failed: bool,
) -> Option<EngineToUi> {
    (!matches!(disconnected.cause, papo::DisconnectCause::Requested { .. })).then(|| {
        EngineToUi::notice(if hosted_authentication_failed {
            "engine.hosted_auth_failed"
        } else {
            "engine.connection_failed"
        })
    })
}

fn is_sasl_failure(disconnected: &papo::Disconnected) -> bool {
    matches!(
        &disconnected.cause,
        papo::DisconnectCause::Connect(error)
            if error.kind() == papo::ConnectErrorKind::Sasl
    )
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

async fn process_history(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    page: papo::HistoryPage,
) {
    let prepend = page.reason == papo::HistoryReason::Requested;
    let requested = requested_history_boundary(&page);
    let items = guard_history_senders(client, page.items).await;
    let snapshot = client.state();
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return;
    };
    let mut output = Vec::new();
    let mut timeline = None::<(BufferId, Vec<crate::MessageProjection>)>;
    let mut unread = None;
    for (item, direct) in items {
        match item {
            papo::Event::Message(message) => {
                for event in running.model.receive(&message, true, &snapshot, direct) {
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
        output.push(history_timeline_event(prepend, buffer_id, &mut messages));
    }
    if let Some(unread) = unread {
        output.push(unread);
    }
    if let Some((conversation, oldest, end)) = requested
        && let Some((buffer_id, at_start)) =
            running.model.finish_history(&conversation, oldest, end)
    {
        output.push(EngineToUi::HistoryStateChanged {
            buffer_id,
            loading: false,
            at_start,
        });
    }
    drop(state);
    for event in output {
        let _ = outbound.send(event);
    }
}

fn requested_history_boundary(
    page: &papo::HistoryPage,
) -> Option<(papo::Conversation, Option<papo::MessageId>, bool)> {
    (page.reason == papo::HistoryReason::Requested).then(|| {
        let oldest = page
            .chat_messages()
            .min_by_key(|message| message.server_time.unwrap_or(message.received_at))
            .and_then(|message| message.msgid.clone());
        (page.conversation.clone(), oldest, page.end)
    })
}

fn history_timeline_event(
    prepend: bool,
    buffer_id: BufferId,
    messages: &mut [crate::MessageProjection],
) -> EngineToUi {
    messages.sort_by_key(|message| {
        (
            message.server_time_ms.unwrap_or(message.received_at_ms),
            message.received_at_ms,
            message.id.0,
        )
    });
    if prepend {
        EngineToUi::MessagesPrepended {
            buffer_id,
            messages: messages.to_vec(),
        }
    } else {
        EngineToUi::MessagesAppended {
            buffer_id,
            messages: messages.to_vec(),
        }
    }
}

async fn guard_history_senders(
    client: &papo::Client,
    events: Vec<papo::Event>,
) -> Vec<(papo::Event, Option<papo::DirectRef>)> {
    let mut guarded = Vec::with_capacity(events.len());
    for event in events {
        let direct = match &event {
            papo::Event::Message(message) if message.authorship != papo::Authorship::Own => {
                client.direct_to(message).await.ok()
            }
            _ => None,
        };
        guarded.push((event, direct));
    }
    guarded
}

fn valid_endpoint(endpoint: &str, allow_insecure: bool) -> bool {
    endpoint.starts_with("wss://") || (allow_insecure && endpoint.starts_with("ws://"))
}

fn channel_target(
    running: &RunningNetwork,
    buffer_id: BufferId,
    requested: Option<String>,
) -> Result<ChannelTarget, &'static str> {
    requested.map(ChannelTarget::Text).map_or_else(
        || {
            running
                .model
                .channel_for_buffer(buffer_id)
                .map(ChannelTarget::Known)
                .ok_or("engine.channel_required")
        },
        Ok,
    )
}

fn valid_nick_input(state: &papo::State, nick: &str) -> bool {
    state
        .name_rules()
        .is_none_or(|rules| valid_name_check(rules.check_nick(nick)))
}

fn valid_channel_input(state: &papo::State, channel: &str) -> bool {
    state
        .name_rules()
        .is_none_or(|rules| valid_name_check(rules.check_channel(channel)))
}

fn valid_name_check(check: papo::NameCheck) -> bool {
    !matches!(check, papo::NameCheck::Invalid(_))
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

fn identify_line(password: &str) -> papo::Line {
    papo::Line::new("PRIVMSG")
        .param("NickServ")
        .param(papo::Secret::new(format!("IDENTIFY {password}")))
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
        AuthenticationKind, ConnectionAuthentication, MemberViews, RunningNetwork, Runtime,
        RuntimeState, completion_context, connection_failure_notice, drain_events, fetch_history,
        fetch_latest, lock, process_event, process_history, utf16_len,
    };
    use crate::{
        BufferId, BufferKind, CompletionCandidate, CompletionTrigger, EngineRequest,
        EngineRequestEnvelope, EngineToUi, MessageDelivery, NetworkId, SaslCredentials,
        commands::{self, CommandPermission, CommandRequirement, CommandSpec, ConfirmPolicy},
        state::{NetworkModel, PendingSend, SendTarget},
    };

    #[test]
    fn unexpected_disconnects_emit_a_human_notice() {
        let disconnected = papo::Disconnected::new(papo::DisconnectCause::PingTimeout, None);
        assert!(matches!(
            connection_failure_notice(&disconnected, false),
            Some(EngineToUi::Notice { key, .. })
                if key == "engine.connection_failed"
        ));
    }

    #[tokio::test]
    async fn hosted_authentication_uses_papos_redacting_oauth_bearer() {
        let sasl = ConnectionAuthentication::HostedOAuth {
            token: "oauth-token-7391".into(),
        }
        .into_sasl();
        assert!(!format!("{sasl:?}").contains("oauth-token-7391"));
        let (_client, _events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "*")
                .sasl(sasl)
                .allow_insecure_auth(true),
        );

        assert_eq!(wire.next_sent().await, "CAP LS 302");
        assert_eq!(wire.next_sent().await, "NICK *");
        assert!(wire.next_sent().await.starts_with("USER "));
        wire.server(":offline.test CAP * LS :sasl=OAUTHBEARER")
            .await;
        assert_eq!(wire.next_sent().await, "CAP REQ :sasl");
        wire.server(":offline.test CAP * ACK :sasl").await;
        assert_eq!(wire.next_sent().await, "AUTHENTICATE OAUTHBEARER");
        wire.server("AUTHENTICATE +").await;
        assert_eq!(
            wire.next_sent().await,
            "AUTHENTICATE biwsAWF1dGg9QmVhcmVyIG9hdXRoLXRva2VuLTczOTEBAQ=="
        );
    }

    #[test]
    fn completion_context_recognizes_triggers_and_command_arguments() {
        let registry = commands::built_in_registry();
        for (input, trigger, prefix, start, hint) in [
            ("/jo", CompletionTrigger::Command, "jo", 0, None),
            ("@an", CompletionTrigger::Person, "an", 0, None),
            ("hello @an", CompletionTrigger::Person, "an", 6, None),
            ("#we", CompletionTrigger::Channel, "#we", 0, None),
            (
                "/msg ",
                CompletionTrigger::Person,
                "",
                5,
                Some("cmd.msg.usage"),
            ),
            (
                "/join ",
                CompletionTrigger::Channel,
                "",
                6,
                Some("cmd.join.usage"),
            ),
        ] {
            let context = completion_context(input, utf16_len(input), false, "#&", &registry)
                .expect("context");
            assert_eq!(context.trigger, trigger);
            assert_eq!(context.prefix, prefix);
            assert_eq!(context.replace_start, start);
            assert_eq!(context.argument_hint.as_deref(), hint);
        }
        assert!(completion_context("mail@an", 7, false, "#&", &registry).is_none());
        assert!(completion_context("hello /jo", 9, false, "#&", &registry).is_none());
        assert!(completion_context("hello al", 8, true, "#&", &registry).is_some());
    }

    #[tokio::test]
    async fn completion_requirements_gate_unavailable_features() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let spec = CommandSpec {
            name: "react".into(),
            aliases: Vec::new(),
            arguments: Vec::new(),
            usage: "cmd.react.usage".into(),
            description: "cmd.react.description".into(),
            requirements: vec![CommandRequirement::Feature("Reactions".into())],
            permission: CommandPermission::Anyone,
            surfaces: Vec::new(),
            confirm: ConfirmPolicy::None,
            completion_priority: commands::CompletionPriority::Other,
            confirmation_prompt: None,
            confirmation_action: None,
            secret_arguments: false,
        };
        assert!(!super::command_requirements_met(&spec, &client.state()));
    }

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
    async fn name_checks_defer_to_papo_until_server_rules_arrive() {
        let (unseeded, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        assert!(matches!(
            unseeded.set_nick("alice").await,
            Err(papo::Error::InvalidInput(
                papo::InvalidInput::NameRulesUnknown
            ))
        ));

        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge")
                .casemapping(papo::Casemapping::default()),
        );
        let snapshot = client.state();
        let rules = snapshot.name_rules().expect("seeded name rules");
        assert_eq!(rules.check_nick("alice"), papo::NameCheck::Unknown);
        assert!(matches!(
            rules.check_nick("bad nick"),
            papo::NameCheck::Invalid(_)
        ));
        drop(snapshot);
        assert!(super::valid_nick_input(&client.state(), "alice"));
        assert!(!super::valid_nick_input(&client.state(), "bad nick"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert_eq!(
            client
                .state()
                .name_rules()
                .expect("registered name rules")
                .check_nick("alice"),
            papo::NameCheck::Valid
        );
        assert!(super::valid_nick_input(&client.state(), "alice"));
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
                .buffer_id_for_channel(&known_channel(&client, "#large"))
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
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":mel!m@host JOIN #room mel :Mel").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    authentication_kind: AuthenticationKind::SaslPlain,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let immediate = runtime.request(EngineRequestEnvelope {
            id: "open-mel".into(),
            request: EngineRequest::OpenDirect {
                network_id: NetworkId(1),
                nick: "mel".into(),
            },
        });
        assert!(immediate.is_empty());
        let mut output = Vec::new();
        loop {
            let event = receiver.recv().await.expect("direct capture completes");
            let complete = matches!(event, EngineToUi::CommandResult { .. });
            output.push(event);
            if complete {
                break;
            }
        }
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
                    authentication_kind: AuthenticationKind::SaslPlain,
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
    async fn hosted_connect_is_idempotent_and_expiry_clears_the_token_owner() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("ircs://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                network: Some(RunningNetwork {
                    instance: 1,
                    authentication_kind: AuthenticationKind::HostedOAuth,
                    client,
                    model: NetworkModel::new(
                        NetworkId(1),
                        "weblounge".into(),
                        "weblounge".into(),
                        50,
                    ),
                }),
            })),
            outbound,
        };

        let duplicate = runtime.request(EngineRequestEnvelope {
            id: "second-tab".into(),
            request: EngineRequest::ConnectHosted {
                label: "weblounge".into(),
                endpoint: "wss://beta.weblounge.org/socket".into(),
                nickname: "weblounge".into(),
                oauth_token: "discarded-second-token".into(),
                autojoin: vec!["#lounge".into()],
            },
        });
        assert!(matches!(
            duplicate.as_slice(),
            [
                EngineToUi::NetworkStateChanged { .. },
                EngineToUi::BuffersChanged { .. },
                EngineToUi::CommandResult { id },
            ] if id == "second-tab"
        ));

        let expired = runtime.request(EngineRequestEnvelope {
            id: "expired".into(),
            request: EngineRequest::ExpireHostedAuthentication {
                network_id: NetworkId(1),
            },
        });
        assert!(matches!(
            expired.as_slice(),
            [
                EngineToUi::NetworkStateChanged { .. },
                EngineToUi::Notice { key, .. },
                EngineToUi::CommandResult { id },
            ] if key == "engine.hosted_auth_failed" && id == "expired"
        ));
        assert!(lock(&runtime.state).network.is_none());
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
                    authentication_kind: AuthenticationKind::SaslPlain,
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
                input: "/j".into(),
                cursor: 2,
                explicit: false,
            },
        });

        assert!(matches!(
            output.as_slice(),
            [
                EngineToUi::CompletionResult {
                    command_id,
                    input,
                    candidates,
                    ..
                },
                EngineToUi::CommandResult { id }
            ] if command_id == "complete"
                && id == "complete"
                && input == "/j"
                && matches!(candidates.as_slice(), [CompletionCandidate::Command { name, .. }]
                    if name == "join")
        ));

        let exact = runtime.request(EngineRequestEnvelope {
            id: "complete-exact".into(),
            request: EngineRequest::CompleteInput {
                buffer_id: BufferId(1),
                input: "/join".into(),
                cursor: 5,
                explicit: false,
            },
        });
        assert!(matches!(
            exact.first(),
            Some(EngineToUi::CompletionResult { candidates, .. }) if candidates.is_empty()
        ));

        let initial = runtime.request(EngineRequestEnvelope {
            id: "complete-all".into(),
            request: EngineRequest::CompleteInput {
                buffer_id: BufferId(1),
                input: "/".into(),
                cursor: 1,
                explicit: false,
            },
        });
        assert_eq!(
            command_candidate_names(&initial)[..7],
            ["join", "me", "msg", "nick", "part", "query", "topic"]
        );

        let help = runtime.request(EngineRequestEnvelope {
            id: "help".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/?".into(),
            },
        });
        assert!(matches!(
            help.as_slice(),
            [
                EngineToUi::CommandHelpRequested { command: None },
                EngineToUi::CommandResult { .. }
            ]
        ));
        let recent = runtime.request(EngineRequestEnvelope {
            id: "complete-recent".into(),
            request: EngineRequest::CompleteInput {
                buffer_id: BufferId(1),
                input: "/".into(),
                cursor: 1,
                explicit: false,
            },
        });
        assert_eq!(command_candidate_names(&recent).get(7), Some(&"help"));
    }

    fn command_candidate_names(events: &[EngineToUi]) -> Vec<&str> {
        let Some(EngineToUi::CompletionResult { candidates, .. }) = events.first() else {
            panic!("completion result is first");
        };
        candidates
            .iter()
            .filter_map(|candidate| match candidate {
                CompletionCandidate::Command { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect()
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
                    authentication_kind: AuthenticationKind::SaslPlain,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        _ = runtime.request(EngineRequestEnvelope {
            id: "join".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #new secret".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "JOIN #new secret");
        wire.server(":weblounge!u@host JOIN #new").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let buffer_id = {
            let mut state = lock(&runtime.state);
            let running = state.network.as_mut().expect("network remains running");
            running.model.sync_channels(&running.client.state());
            let target = SendTarget::Channel(known_channel(&running.client, "#new"));
            running
                .model
                .buffer_id_for_target(&target)
                .expect("joined buffer exists")
        };
        let completion = runtime.request(EngineRequestEnvelope {
            id: "complete-member".into(),
            request: EngineRequest::CompleteInput {
                buffer_id,
                input: "web".into(),
                cursor: 3,
                explicit: true,
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
        assert_topic_notice(&runtime, &mut events, buffer_id).await;
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
        wire.server(":alice!u@host JOIN #new").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let output = runtime.request(EngineRequestEnvelope {
            id: "msg".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/msg alice hello".into(),
            },
        });
        assert!(output.is_empty());
        assert_eq!(wire.next_sent().await, "PRIVMSG alice hello");
        assert_unfocused_direct(&collect(&mut receiver), "alice");

        runtime.request(EngineRequestEnvelope {
            id: "part".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/part later".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "PART #new later");
        wire.server(":lounge2!u@host PART #new :later").await;
    }

    #[test]
    fn identify_line_redacts_the_password_from_diagnostics() {
        let line = super::identify_line("unique-password");

        assert!(!format!("{line:?}").contains("unique-password"));
    }

    #[tokio::test]
    async fn identify_sends_a_secret_service_parameter() {
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
                    authentication_kind: AuthenticationKind::SaslPlain,
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "identify".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/identify hunter2".into(),
            },
        });

        assert!(output.is_empty());
        let result = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("command finishes")
            .expect("command completes");
        assert!(
            matches!(result, EngineToUi::CommandResult { .. }),
            "{result:?}"
        );
        assert_eq!(wire.next_sent().await, "PRIVMSG NickServ :IDENTIFY hunter2");
        assert!(!format!("{result:?}").contains("hunter2"));
    }

    #[tokio::test]
    async fn guarded_direct_follows_a_nick_change() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room alice-one :Alice")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let direct = client.direct("alice").await.expect("shared user is direct");

        wire.server(":alice!a@host NICK bob").await;
        let changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::NickChanged(_))
        })
        .await;
        let papo::Event::NickChanged(changed) = changed else {
            panic!("nick change expected")
        };
        assert_eq!(direct.nick(), changed.new);
        let pending = PendingSend {
            buffer_id: BufferId(2),
            local_send_id: crate::LocalSendId(1),
            target: SendTarget::Direct {
                nick: changed.new,
                recipient: direct,
            },
            text: "still you".into(),
            kind: crate::MessageKind::Text,
        };

        let sender = client.clone();
        let send = tokio::spawn(async move { super::send(&sender, &pending).await });
        assert_eq!(wire.next_sent().await, "PRIVMSG bob :still you");
        send.await
            .expect("send task completes")
            .expect("send follows user");
    }

    #[tokio::test]
    async fn direct_confirmation_before_close_stays_confirmed() {
        assert_direct_confirmation_survives_close(false).await;
    }

    #[tokio::test]
    async fn direct_confirmation_after_close_stays_confirmed() {
        assert_direct_confirmation_survives_close(true).await;
    }

    async fn assert_direct_confirmation_survives_close(close_first: bool) {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room alice-one :Alice")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let direct = client.direct("alice").await.expect("shared user is direct");
        let nick = direct.nick();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (buffer_id, _) = model.open_direct(nick, direct);
        let (pending, _) = model
            .begin_send(buffer_id, "hi".into(), &client.state())
            .expect("direct is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert_eq!(wire.next_sent().await, "PRIVMSG alice hi");
        if close_first {
            model.close_direct(buffer_id).expect("direct closes");
        }
        let (pending, sent) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        let confirmation = model
            .confirm_send(&pending, &sent)
            .expect("retained optimistic row confirms");
        if !close_first {
            model.close_direct(buffer_id).expect("direct closes");
        }

        assert!(matches!(
            model.buffers_event(),
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().all(|buffer| buffer.id != buffer_id)
        ));
        assert!(matches!(
            confirmation.as_slice(),
            [EngineToUi::MessageConfirmed { message, .. }]
                if message.delivery == MessageDelivery::Confirmed
        ));
    }

    #[tokio::test]
    async fn guarded_direct_refuses_a_reused_nick() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room alice-one :Alice")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let direct = client.direct("alice").await.expect("shared user is direct");
        let nick = client
            .state()
            .name_rules()
            .expect("registered test client has name rules")
            .nick("alice");

        wire.server(":alice!a@host QUIT :gone").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Quit(_))).await;
        wire.server(":alice!other@host JOIN #room alice-two :Other Alice")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let pending = PendingSend {
            buffer_id: BufferId(2),
            local_send_id: crate::LocalSendId(1),
            target: SendTarget::Direct {
                nick,
                recipient: direct,
            },
            text: "not for you".into(),
            kind: crate::MessageKind::Text,
        };

        assert!(matches!(
            super::send(&client, &pending).await,
            Err(super::SendError::DirectTargetGone)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wire.next_sent())
                .await
                .is_err()
        );
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
                    authentication_kind: AuthenticationKind::SaslPlain,
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
                    authentication_kind: AuthenticationKind::SaslPlain,
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

    fn known_channel(client: &papo::Client, name: &str) -> papo::ChannelName {
        client
            .state()
            .name_rules()
            .expect("registered test client has name rules")
            .channel(name)
    }

    fn assert_unfocused_direct(output: &[EngineToUi], nick: &str) {
        assert!(output.iter().any(
            |event| matches!(event, EngineToUi::BufferAdded { buffer } if buffer.title == nick)
        ));
        assert!(
            !output
                .iter()
                .any(|event| matches!(event, EngineToUi::FocusBufferRequested { .. }))
        );
    }

    async fn assert_topic_notice(
        runtime: &Runtime,
        events: &mut papo::Events,
        buffer_id: BufferId,
    ) {
        _ = next_matching(events, |event| {
            matches!(event, papo::Event::TopicChanged(_))
        })
        .await;
        let shown = runtime.request(EngineRequestEnvelope {
            id: "show-topic".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/topic".into(),
            },
        });
        assert!(shown.iter().any(|event| matches!(
            event,
            EngineToUi::MessagesAppended { messages, .. }
                if messages[0].kind == crate::MessageKind::Notice
                    && messages[0].text == "new topic"
                    && messages[0].author == "weblounge"
        )));
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
                authentication_kind: AuthenticationKind::SaslPlain,
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

    fn take_prepended(
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
    ) -> (BufferId, Vec<String>) {
        collect(receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::MessagesPrepended {
                    buffer_id,
                    messages,
                } => Some((
                    buffer_id,
                    messages.into_iter().map(|message| message.text).collect(),
                )),
                _ => None,
            })
            .expect("requested history is prepended")
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

    async fn fetch_requested_page(
        client: &papo::Client,
        wire: &mut papo_testing::Wire,
        fetch: crate::state::HistoryFetch,
        expected_suffix: &str,
        items: &[&str],
    ) -> papo::HistoryPage {
        let fetch_client = client.clone();
        let task = tokio::spawn(async move { fetch_history(&fetch_client, fetch).await });
        let request = wire.next_sent().await;
        assert!(request.ends_with(expected_suffix));
        let label = request_label(&request);
        send_history_page(wire, label, items).await;
        task.await
            .expect("history task completes")
            .expect("history request succeeds")
    }

    #[tokio::test]
    async fn history_pages_before_oldest_msgid_sort_deduplicate_and_stop_at_start() {
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
        process_history(&state, &outbound, &client, 1, page).await;

        let (buffer_id, prepended) = take_prepended(&mut receiver);
        assert_eq!(prepended, ["older", "middle"]);

        let older_fetch = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id)
            .expect("an older page is available");
        let page = fetch_requested_page(
            &client,
            &mut wire,
            older_fetch,
            "CHATHISTORY BEFORE #room msgid=older 100",
            &[
                "time=2026-10-27T11:59:58.000Z;msgid=first :alice!a@host PRIVMSG #room :first",
                "time=2026-10-27T12:00:00.000Z;msgid=older :alice!a@host PRIVMSG #room :older",
                "time=2026-10-27T11:59:59.000Z;msgid=second :alice!a@host PRIVMSG #room :second",
            ],
        )
        .await;
        process_history(&state, &outbound, &client, 1, page).await;
        let (_, prepended) = take_prepended(&mut receiver);
        assert_eq!(prepended, ["first", "second"]);

        let final_fetch = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id)
            .expect("the server boundary has not been reached yet");
        let page = fetch_requested_page(
            &client,
            &mut wire,
            final_fetch,
            "CHATHISTORY BEFORE #room msgid=first 100",
            &[],
        )
        .await;
        process_history(&state, &outbound, &client, 1, page).await;

        assert!(
            lock(&state)
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .request_history(buffer_id)
                .is_none()
        );
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
        process_history(&state, &outbound, &client, 1, page).await;

        assert!(matches!(
            collect(&mut receiver).as_slice(),
            [EngineToUi::HistoryStateChanged {
                loading: false,
                at_start: true,
                ..
            }]
        ));
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
        let (state, outbound, mut receiver) = harness(client.clone());
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
        let dropped = lagged.as_lagged().expect("matching lagged event").dropped;
        let targets = process_event(&state, &outbound, &client, 1, lagged);

        assert!(matches!(targets.as_slice(), [SendTarget::Channel(channel)] if channel == "#room"));
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::Diagnostic { command_id, message }
                if command_id == "papo.event_queue"
                    && message == &format!("{dropped} papo events dropped")
        )));
    }

    #[tokio::test]
    async fn recreated_channel_warning_becomes_a_typed_notice() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        wire.server(":offline.test 329 weblounge #room 1793098800")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;

        wire.close().await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        client.reconnect().await.expect("manual reconnect starts");
        wire.register(&[]).await;
        _ = next_matching(
            &mut events,
            |event| matches!(event, papo::Event::Connected(connected) if connected.reconnected),
        )
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        wire.server(":offline.test 329 weblounge #room 1793099900")
            .await;
        let warning = next_matching(&mut events, |event| {
            matches!(
                event,
                papo::Event::Warning(papo::event::Warning::ChannelRecreated { .. })
            )
        })
        .await;

        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, warning);
        assert!(matches!(
            collect(&mut receiver).as_slice(),
            [EngineToUi::Notice { key, .. }] if key == "engine.channel_recreated"
        ));
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
        let papo::Event::History(page) = history else {
            panic!("history page expected")
        };
        process_history(&state, &outbound, &client, 1, page).await;
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
        let confirmation_events = model
            .confirm_send(&pending, &metadata)
            .expect("optimistic row exists");

        assert!(matches!(
            confirmation_events.as_slice(),
            [EngineToUi::MessageConfirmed { message, .. }]
                if message.server_ids.is_empty() && message.server_time_ms.is_none()
        ));
    }

    #[tokio::test]
    async fn labelled_multiline_send_preserves_the_confirmed_text() {
        let caps = [
            "batch",
            "draft/multiline=max-bytes=4096,max-lines=100",
            "echo-message",
            "labeled-response",
            "message-tags",
        ];
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
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("joined channel is projected");
        let text = "deployment update ".repeat(40);
        let (pending, _) = model
            .begin_send(buffer_id, text.clone(), &client.state())
            .expect("channel is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert_eq!(
            wire.next_sent().await,
            "@label=0 BATCH +b0-0 draft/multiline #room"
        );
        let first = wire
            .next_sent()
            .await
            .strip_prefix("@batch=b0-0 PRIVMSG #room :")
            .expect("first multiline component")
            .to_owned();
        let second = wire
            .next_sent()
            .await
            .strip_prefix("@batch=b0-0;draft/multiline-concat PRIVMSG #room :")
            .expect("automatic split is concatenated")
            .to_owned();
        assert_eq!(format!("{first}{second}"), text);
        assert_eq!(wire.next_sent().await, "BATCH -b0-0");
        wire.server("@label=0;msgid=whole :weblounge!u@host BATCH +echo draft/multiline #room")
            .await;
        wire.server(&format!(
            "@batch=echo :weblounge!u@host PRIVMSG #room :{first}"
        ))
        .await;
        wire.server(&format!(
            "@batch=echo;draft/multiline-concat :weblounge!u@host PRIVMSG #room :{second}"
        ))
        .await;
        wire.server(":weblounge!u@host BATCH -echo").await;
        let (pending, metadata) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        let confirmation_events = model
            .confirm_send(&pending, &metadata)
            .expect("optimistic row exists");

        assert!(matches!(
            confirmation_events.as_slice(),
            [EngineToUi::MessageConfirmed { message, .. }]
                if message.server_ids == ["whole"]
                    && message.text == text
                    && !message.text.contains('\n')
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
        let first_text = wire
            .next_sent()
            .await
            .strip_prefix("@label=0 PRIVMSG #room ")
            .expect("first labelled line")
            .to_owned();
        let second_text = wire
            .next_sent()
            .await
            .strip_prefix("@label=0-1 PRIVMSG #room ")
            .expect("second labelled line")
            .to_owned();
        assert_eq!(format!("{first_text}{second_text}"), "a".repeat(600));
        wire.server("@label=0;msgid=first :weblounge!u@host PRIVMSG #room :first part")
            .await;
        wire.server("@label=0-1;msgid=second :weblounge!u@host PRIVMSG #room :second part")
            .await;
        let (pending, metadata) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        let confirmation_events = model
            .confirm_send(&pending, &metadata)
            .expect("optimistic row exists");

        assert!(matches!(
            confirmation_events.as_slice(),
            [
                EngineToUi::MessageConfirmed { message: first, .. },
                EngineToUi::MessagesAppended { messages, .. }
            ] if first.server_ids == ["first"]
                && first.text == first_text
                && messages.len() == 1
                && messages[0].server_ids == ["second"]
                && messages[0].text == second_text
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), events.next())
                .await
                .is_err(),
            "correlated own echoes must be consumed into Sent"
        );
    }
}
