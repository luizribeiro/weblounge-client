use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::mpsc;

use crate::{
    Command, CommandEnvelope, EngineToUi, NetworkConnectionState, NetworkId,
    direct_target::DirectSendError,
    state::{NetworkModel, PendingSend, SendTarget},
};

const DEFAULT_WINDOW_LIMIT: usize = 500;

struct RunningNetwork {
    instance: u64,
    client: papo::Client,
    model: NetworkModel,
}

struct RuntimeState {
    next_network_id: u64,
    next_instance: u64,
    network: Option<RunningNetwork>,
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
            })),
            outbound,
        }
    }

    pub(crate) fn command(&self, envelope: CommandEnvelope) -> Vec<EngineToUi> {
        match envelope.command {
            Command::Diagnostic { message } => vec![
                EngineToUi::Diagnostic {
                    command_id: envelope.id.clone(),
                    message,
                },
                EngineToUi::CommandResult { id: envelope.id },
            ],
            Command::Connect {
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
            Command::Disconnect { network_id, reason } => {
                self.disconnect(envelope.id, network_id, reason)
            }
            Command::SendMessage { buffer_id, text } => {
                self.send_message(envelope.id, buffer_id, text)
            }
        }
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

    fn send_message(
        &self,
        command_id: String,
        buffer_id: crate::BufferId,
        text: String,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, "engine.network_not_found");
        };
        let Some((pending, output)) = running.model.begin_send(buffer_id, text) else {
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
    match pending.target.clone() {
        SendTarget::Channel(channel) => client
            .privmsg(channel, pending.text.clone())
            .await
            .map_err(|_| SendError::Protocol),
        SendTarget::Direct(target) => {
            target
                .send(client, pending.text.clone())
                .await
                .map_err(|error| match error {
                    DirectSendError::AccountChanged => SendError::DirectAccountChanged,
                    DirectSendError::Protocol => SendError::Protocol,
                })
        }
    }
}

async fn drain_events(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    mut events: papo::Events,
    instance: u64,
) {
    while let Some(event) = events.next().await {
        let history_targets = process_event(&state, &outbound, &client, instance, event);
        for target in history_targets {
            let state = Arc::clone(&state);
            let outbound = outbound.clone();
            let client = client.clone();
            spawn_task(async move {
                let page = match target {
                    SendTarget::Channel(channel) => client.history(channel).latest().await,
                    SendTarget::Direct(target) => {
                        client.history(target.nick().clone()).latest().await
                    }
                };
                if let Ok(page) = page {
                    process_history(&state, &outbound, &client, instance, page);
                }
            });
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
            if let Some(event) = running
                .model
                .rename_direct(changed.actor.nick(), changed.new)
            {
                output.push(event);
            }
            Vec::new()
        }
        papo::Event::Message(message) => {
            output.extend(running.model.receive(&message, false, &snapshot));
            Vec::new()
        }
        papo::Event::Joined(_) | papo::Event::ChannelSynced(_) => {
            output.extend(running.model.sync_channels(&snapshot));
            Vec::new()
        }
        papo::Event::Disconnected(disconnected) => {
            let connection = if disconnected.is_reconnecting() {
                NetworkConnectionState::Reconnecting
            } else {
                NetworkConnectionState::Stopped
            };
            output.push(running.model.set_connection(connection, None));
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
    let mut output = Vec::new();
    for item in page.items {
        if let papo::Event::Message(message) = item {
            output.extend(running.model.receive(&message, true, &snapshot));
        }
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
    use std::sync::{Arc, Mutex};

    use papo_testing::wire;
    use tokio::sync::mpsc;

    use super::{RunningNetwork, Runtime, RuntimeState, lock, process_event};
    use crate::{
        BufferId, BufferKind, Command, CommandEnvelope, EngineToUi, NetworkId, SaslCredentials,
        state::{NetworkModel, SendTarget},
    };

    #[test]
    fn rejected_commands_emit_a_typed_terminal_result() {
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let commands = [
            Command::Connect {
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
            Command::Disconnect {
                network_id: NetworkId(1),
                reason: None,
            },
            Command::SendMessage {
                buffer_id: BufferId(1),
                text: "hello".into(),
            },
        ];

        for (index, command) in commands.into_iter().enumerate() {
            let id = format!("rejected-{index}");
            let output = runtime.command(CommandEnvelope {
                id: id.clone(),
                command,
            });
            assert!(matches!(output.as_slice(), [
                EngineToUi::CommandRejected { id: result_id, .. },
            ] if result_id == &id));
        }
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

        let output = runtime.command(CommandEnvelope {
            id: "connect-again".into(),
            command: Command::Connect {
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
    async fn no_echo_send_confirms_without_server_metadata() {
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
            .begin_send(buffer_id, "hello".into())
            .expect("channel is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert_eq!(wire.next_sent().await, "PRIVMSG #room hello");
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
            .begin_send(buffer_id, text)
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
