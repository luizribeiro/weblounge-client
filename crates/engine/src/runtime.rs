use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use std::rc::Rc;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use wasm_bindgen::{JsCast, JsValue};

use tokio::sync::{mpsc, oneshot};

use crate::{
    BufferId, CompletionCandidate, CompletionTrigger, ConnectionFailureReason, EngineMessageKey,
    EngineRequest, EngineRequestEnvelope, EngineToUi, LocalSendId, MembershipKind, MessageId,
    NetworkConnectionState, NetworkId, NoticeKind, OfflineReason, PushFailure, PushState,
    PushUnsupportedReason, TypingProjection,
    chat_list_snapshot::{
        self, ChatListSnapshot, SnapshotChanges, SnapshotPresence, SnapshotRemoval,
    },
    commands::{self, Command},
    direct_peer::DirectPeer,
    filehost,
    name_key::NameKey,
    notification_settings,
    peer_pin::{PeerPin, PinMismatch},
    push_device,
    pushed_messages::{self, PushedMessage},
    reactions::ReactionAction,
    request_error::{StateLimitOutcome, state_limit_outcome},
    saved_message::SavedMessage,
    settings,
    state::{
        ChatInput, DirectAvailability, HistoryCursor, HistoryFetch, HistoryLoad, HistoryTarget,
        NetworkModel, OwnReactionChange, OwnRedaction, PendingSend, PendingTargetState,
        ReadAdvance, SendTarget, event_millis, is_own_nick, server_time, time_millis,
    },
    timeline::{FixedOffsetCalendar, LocalCalendar},
    upload_target::{self, ConnectionIdentity, UploadContext, UploadCredential},
};

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use crate::storage::MemoryKv;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use crate::storage::WebKv;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
type RuntimeStorage = Rc<WebKv>;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
type RuntimeStorage = Arc<MemoryKv>;

const DEFAULT_WINDOW_LIMIT: usize = 500;
const HISTORY_PAGE_SIZE: usize = 100;
const RECENT_DIRECT_LIMIT: usize = 100;
const RECENT_TARGET_LIMIT: usize = 1_000;
const RECENT_DIRECT_WINDOW: Duration = Duration::from_hours(30 * 24);
/// `CHATHISTORY TARGETS` lists a conversation only when its newest line falls inside the window.
/// Lines keep landing after the query is built (queued sends flush as soon as the connection is
/// up, and peers keep talking), and any one of them would hide every line before it, so the window
/// reaches past now. The cursor still advances only to the query time.
const TARGETS_LATE_ACTIVITY: Duration = Duration::from_hours(24);
const COMPLETION_LIMIT: usize = 100;
const FOREGROUND_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const READ_RETRY_INITIAL: Duration = Duration::from_secs(1);
const READ_RETRY_MAX: Duration = Duration::from_secs(60);
const READ_RETRY_ATTEMPTS: u8 = 5;
const SNAPSHOT_WRITE_IMMEDIATE_RETRY_ATTEMPTS: u8 = 5;
const MARK_READ_DIAGNOSTIC_ID: &str = "mark-read";
const PUSH_REFRESH_INTERVAL: Duration = Duration::from_hours(24);

struct CompletionContext {
    trigger: Option<CompletionTrigger>,
    replace_start: u32,
    replace_end: u32,
    prefix: String,
    usage: Option<commands::CommandUsage>,
    replacement_prefix: String,
    replacement_suffix: String,
    auto_accept: bool,
}

impl CompletionContext {
    fn usage_only(caret: u32, usage: commands::CommandUsage) -> Self {
        Self {
            trigger: None,
            replace_start: caret,
            replace_end: caret,
            prefix: String::new(),
            usage: Some(usage),
            replacement_prefix: String::new(),
            replacement_suffix: String::new(),
            auto_accept: false,
        }
    }
}

struct RunningNetwork {
    instance: u64,
    identity: ConnectionIdentity,
    client: papo::Client,
    model: NetworkModel,
    connection_attempt: u32,
    device_online: bool,
    pending_sends: VecDeque<QueuedSend>,
    flushing_sends: bool,
    pending_reads: VecDeque<ReadAdvance>,
    flushing_reads: bool,
    hosted_reconnect: Option<HostedReconnectConfig>,
    chat_list: ChatListSync,
    push: PushRegistration,
    typing: crate::typing::OutgoingTyping,
}

impl RunningNetwork {
    fn read_markers_server_backed(&self) -> bool {
        let snapshot = self.client.snapshot();
        !snapshot.is_connected() || can_sync_read_markers(&snapshot)
    }

    fn record_direct_presence(&mut self, buffer_id: BufferId) {
        if let Some(conversation) = self.model.snapshot_conversation_for_buffer(buffer_id) {
            self.chat_list.joined.push(SnapshotPresence {
                conversation,
                joined_at_ms: time_millis(papo::time::now()),
            });
        }
    }
}

#[derive(Default)]
struct PushRegistration {
    generation: u64,
    route: Option<RegisteredPushRoute>,
    state: Option<PushState>,
}

#[derive(Clone)]
struct RegisteredPushRoute {
    route_id: String,
    endpoint: String,
    p256dh: String,
    auth: papo::Secret,
}

#[derive(Clone)]
struct PushRegisterTask {
    instance: u64,
    generation: u64,
    network_id: NetworkId,
    route: RegisteredPushRoute,
    unregister: Vec<String>,
}

#[derive(Clone)]
struct PushUnregisterTask {
    instance: u64,
    generation: u64,
    network_id: NetworkId,
    route_id: String,
    endpoint: String,
    clear_current: bool,
}

#[derive(Clone)]
struct HostedReconnectConfig {
    endpoint: String,
    nickname: String,
    autojoin: Vec<String>,
}

#[derive(Default)]
struct ChatListSync {
    fingerprint: String,
    snapshot: Option<ChatListSnapshot>,
    removed: Vec<SnapshotRemoval>,
    joined: Vec<SnapshotPresence>,
}

struct QueuedSend {
    pending: PendingSend,
    retry_if_disconnected: bool,
    await_live_target: bool,
}

enum FlushNext {
    Send(QueuedSend),
    Fail(Vec<EngineToUi>),
    Stop,
}

#[derive(Default)]
struct ReadRetryState {
    failures: u8,
    last_error: Option<String>,
}

struct ReadRetryDecision {
    retry_after: Option<Duration>,
    diagnostic: bool,
}

impl ReadRetryState {
    fn failed(&mut self, error: &papo::Error) -> ReadRetryDecision {
        self.failures = self.failures.saturating_add(1);
        let error = error.to_string();
        let diagnostic = self.last_error.as_deref() != Some(error.as_str());
        self.last_error = Some(error);
        ReadRetryDecision {
            retry_after: (self.failures < READ_RETRY_ATTEMPTS)
                .then(|| read_retry_delay(self.failures)),
            diagnostic,
        }
    }

    fn succeeded(&mut self) {
        *self = Self::default();
    }
}

fn read_retry_delay(failures: u8) -> Duration {
    let exponent = u32::from(failures.saturating_sub(1)).min(31);
    READ_RETRY_INITIAL
        .saturating_mul(2_u32.saturating_pow(exponent))
        .min(READ_RETRY_MAX)
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
    fn label(&self) -> String {
        match self {
            Self::Known(channel) => channel.to_string(),
            Self::Text(channel) => channel.clone(),
        }
    }
}

macro_rules! with_channel {
    ($target:expr, $channel:ident => $request:expr) => {
        match $target {
            ChannelTarget::Known($channel) => $request,
            ChannelTarget::Text($channel) => $request,
        }
    };
}

struct RuntimeState {
    calendar: Arc<dyn LocalCalendar>,
    next_network_id: u64,
    next_instance: u64,
    network: Option<RunningNetwork>,
    member_views: MemberViews,
    storage: RuntimeStorage,
    snapshot_writer: Arc<Mutex<SnapshotWriter>>,
    cached_snapshot: Option<Vec<u8>>,
    cached_pushed_messages: Vec<PushedMessage>,
    build_version: String,
    update_ready: bool,
    inflight_send_cancel: Option<InflightSendCancel>,
}

struct InflightSendCancel {
    instance: u64,
    cancel: oneshot::Sender<()>,
    settled: oneshot::Receiver<()>,
}

#[derive(Default)]
struct SnapshotWriter {
    generation: u64,
    active: bool,
    pending: VecDeque<SnapshotChanges>,
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
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        {
            let _ = outbound;
            unreachable!("web engines require IndexedDB storage");
        }
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        {
            let storage = Arc::new(MemoryKv::default());
            Self::with_storage(
                outbound,
                storage,
                None,
                Vec::new(),
                "weblounge dev".into(),
                Arc::new(FixedOffsetCalendar::default()),
            )
        }
    }

    pub(crate) fn with_storage(
        outbound: mpsc::UnboundedSender<EngineToUi>,
        storage: RuntimeStorage,
        cached_snapshot: Option<Vec<u8>>,
        cached_pushed_messages: Vec<PushedMessage>,
        build_version: String,
        calendar: Arc<dyn LocalCalendar>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar,
                next_network_id: 1,
                next_instance: 1,
                network: None,
                member_views: MemberViews::default(),
                storage,
                snapshot_writer: Arc::default(),
                cached_snapshot,
                cached_pushed_messages,
                build_version,
                update_ready: false,
                inflight_send_cancel: None,
            })),
            outbound,
        }
    }

    // One exhaustive dispatcher keeps protocol routing under a single owner.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn request(&self, envelope: EngineRequestEnvelope) -> Vec<EngineToUi> {
        match envelope.request {
            EngineRequest::Ping => vec![EngineToUi::Pong { id: envelope.id }],
            EngineRequest::Diagnostic { message } => Self::diagnostic(envelope.id, message),
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
                        password: papo::Secret::new(sasl.password.into_inner()),
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
                hosted_connect_config(label, endpoint, nickname, oauth_token, autojoin),
            ),
            EngineRequest::PrepareHosted {
                label,
                endpoint,
                nickname,
                autojoin,
            } => self.prepare_hosted(envelope.id, label, endpoint, nickname, autojoin),
            EngineRequest::ReconnectHosted {
                network_id,
                oauth_token,
            } => self.reconnect_hosted(envelope.id, network_id, oauth_token),
            EngineRequest::HostedTokenUnavailable { network_id } => {
                self.hosted_token_unavailable(envelope.id, network_id)
            }
            EngineRequest::ExpireHostedAuthentication { network_id } => {
                self.expire_hosted_authentication(envelope.id, network_id)
            }
            EngineRequest::Disconnect { network_id, reason } => {
                self.disconnect(envelope.id, network_id, reason)
            }
            EngineRequest::Reconnect { network_id } => self.reconnect(envelope.id, network_id),
            EngineRequest::SetDeviceOnline { network_id, online } => {
                self.set_device_online(envelope.id, network_id, online)
            }
            EngineRequest::SetUpdateReady { ready } => self.set_update_ready(envelope.id, ready),
            EngineRequest::LoadSettings => self.load_settings(envelope.id),
            EngineRequest::ChangeSetting { change } => self.change_setting(envelope.id, change),
            EngineRequest::LoadNotificationPromptDismissal => {
                self.load_notification_prompt_dismissal(envelope.id)
            }
            EngineRequest::DismissNotificationPrompt => {
                self.dismiss_notification_prompt(envelope.id)
            }
            EngineRequest::ResolveUpload {
                network_id,
                approval,
            } => self.resolve_upload(envelope.id, network_id, approval),
            EngineRequest::ForgetUploadApprovals => self.forget_upload_approvals(envelope.id),
            EngineRequest::LoadPushDevice { relay } => self.load_push_device(envelope.id, relay),
            EngineRequest::LoadPushedMessages { network_id } => {
                self.load_pushed_messages(envelope.id, network_id)
            }
            EngineRequest::StorePushDevice { credentials } => {
                self.store_push_device(envelope.id, credentials)
            }
            EngineRequest::ClearPushDevice { relay } => self.clear_push_device(envelope.id, relay),
            EngineRequest::EnsurePush {
                network_id,
                route,
                unregister,
            } => self.ensure_push(envelope.id, network_id, route, unregister),
            EngineRequest::AnnouncePushRoute { network_id } => {
                self.announce_push_route(envelope.id, network_id)
            }
            EngineRequest::UnregisterPushRoute {
                network_id,
                route_id,
                endpoint,
            } => self.unregister_push_route(envelope.id, network_id, route_id, endpoint),
            EngineRequest::SendMessage { buffer_id, text } => {
                self.send_input(envelope.id, buffer_id, text, &crate::MessageKind::Text)
            }
            EngineRequest::RetryMessage {
                buffer_id,
                local_send_id,
            } => self.retry_message(envelope.id, buffer_id, local_send_id),
            EngineRequest::ToggleReaction {
                buffer_id,
                message_id,
                reaction,
            } => self.toggle_reaction(envelope.id, buffer_id, message_id, reaction),
            EngineRequest::RedactMessage {
                buffer_id,
                message_id,
            } => self.redact_message(envelope.id, buffer_id, message_id),
            EngineRequest::SubmitInput {
                buffer_id,
                input,
                reply_to,
            } => self.submit_input(envelope.id, buffer_id, &input, reply_to),
            EngineRequest::CompleteInput {
                buffer_id,
                input,
                cursor,
                explicit,
            } => {
                self.composer_changed(buffer_id, &input);
                self.complete_input(envelope.id, buffer_id, input, cursor, explicit)
            }
            EngineRequest::MarkRead { buffer_id, through } => {
                self.mark_read(envelope.id, buffer_id, through)
            }
            EngineRequest::MarkAllRead => self.mark_all_read(envelope.id),
            EngineRequest::LoadHistory {
                buffer_id,
                direction,
            } => self.load_history(envelope.id, buffer_id, direction),
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
            EngineRequest::OpenDirect {
                network_id,
                nick,
                focus,
            } => self.open_direct(envelope.id, network_id, nick, focus),
            EngineRequest::TrustDirectIdentity { buffer_id } => {
                self.trust_direct_identity(envelope.id, buffer_id)
            }
            EngineRequest::DeferDirectIdentity { buffer_id } => {
                self.defer_direct_identity(envelope.id, buffer_id)
            }
        }
    }

    fn diagnostic(command_id: String, message: String) -> Vec<EngineToUi> {
        vec![
            EngineToUi::Diagnostic {
                command_id: command_id.clone(),
                message,
            },
            EngineToUi::CommandResult { id: command_id },
        ]
    }

    fn set_update_ready(&self, command_id: String, ready: bool) -> Vec<EngineToUi> {
        lock(&self.state).update_ready = ready;
        vec![EngineToUi::CommandResult { id: command_id }]
    }

    fn load_settings(&self, command_id: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let events = match settings::load(storage.as_ref()).await {
                Ok(loaded) => {
                    let mut events: Vec<_> = loaded
                        .invalid_fields
                        .into_iter()
                        .map(|field| EngineToUi::Diagnostic {
                            command_id: command_id.clone(),
                            message: format!(
                                "invalid stored setting `{field}` reset to its default"
                            ),
                        })
                        .collect();
                    events.push(EngineToUi::SettingsLoaded {
                        command_id: command_id.clone(),
                        settings: loaded.settings,
                    });
                    events.push(EngineToUi::CommandResult { id: command_id });
                    events
                }
                Err(_) => rejected_command(command_id, EngineMessageKey::StorageUnavailable),
            };
            send_events(&outbound, events);
        });
        Vec::new()
    }

    fn change_setting(
        &self,
        command_id: String,
        change: settings::SettingChange,
    ) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let events = match settings::change(storage.as_ref(), change).await {
                Ok(settings) => vec![
                    EngineToUi::SettingsChanged { settings },
                    EngineToUi::CommandResult { id: command_id },
                ],
                Err(_) => rejected_command(command_id, EngineMessageKey::StorageUnavailable),
            };
            send_events(&outbound, events);
        });
        Vec::new()
    }

    fn load_notification_prompt_dismissal(&self, command_id: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let events = match notification_settings::prompt_dismissed(storage.as_ref()).await {
                Ok(dismissed) => vec![
                    EngineToUi::NotificationPromptDismissalLoaded {
                        command_id: command_id.clone(),
                        dismissed,
                    },
                    EngineToUi::CommandResult { id: command_id },
                ],
                Err(_) => rejected_command(command_id, EngineMessageKey::StorageUnavailable),
            };
            send_events(&outbound, events);
        });
        Vec::new()
    }

    fn dismiss_notification_prompt(&self, command_id: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let event = match notification_settings::dismiss_prompt(storage.as_ref()).await {
                Ok(()) => EngineToUi::CommandResult { id: command_id },
                Err(_) => command_rejection(command_id, EngineMessageKey::StorageUnavailable),
            };
            let _ = outbound.send(event);
        });
        Vec::new()
    }

    fn resolve_upload(
        &self,
        command_id: String,
        network_id: NetworkId,
        approval: Option<crate::UploadApproval>,
    ) -> Vec<EngineToUi> {
        let (storage, context) = {
            let state = lock(&self.state);
            let Some(running) = state
                .network
                .as_ref()
                .filter(|running| running.model.id() == network_id)
            else {
                return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
            };
            let context = UploadContext {
                identity: running.identity.clone(),
                filehost: filehost::upload_endpoint(&running.client.snapshot()),
                online: running.model.is_online(),
                now_ms: time_millis(papo::time::now()),
            };
            (state.storage.clone(), context)
        };
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let resolution = upload_target::resolve(storage.as_ref(), context, approval).await;
            send_events(
                &outbound,
                vec![
                    EngineToUi::UploadResolved {
                        command_id: command_id.clone(),
                        resolution,
                    },
                    EngineToUi::CommandResult { id: command_id },
                ],
            );
        });
        Vec::new()
    }

    fn forget_upload_approvals(&self, command_id: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let event = match crate::upload_approvals::forget_all(storage.as_ref()).await {
                Ok(()) => EngineToUi::CommandResult { id: command_id },
                Err(_) => command_rejection(command_id, EngineMessageKey::StorageUnavailable),
            };
            let _ = outbound.send(event);
        });
        Vec::new()
    }

    fn load_push_device(&self, command_id: String, relay: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let events = match push_device::read(storage.as_ref(), &relay).await {
                Ok(credentials) => vec![
                    EngineToUi::PushDeviceLoaded {
                        command_id: command_id.clone(),
                        credentials,
                    },
                    EngineToUi::CommandResult { id: command_id },
                ],
                Err(_) => rejected_command(command_id, EngineMessageKey::StorageUnavailable),
            };
            send_events(&outbound, events);
        });
        Vec::new()
    }

    fn load_pushed_messages(&self, command_id: String, network_id: NetworkId) -> Vec<EngineToUi> {
        let shared_state = Arc::clone(&self.state);
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let Ok(messages) = pushed_messages::read(storage.as_ref()).await else {
                let _ = outbound.send(command_rejection(
                    command_id,
                    EngineMessageKey::StorageUnavailable,
                ));
                return;
            };
            let mut state = lock(&shared_state);
            let Some(running) = state
                .network
                .as_mut()
                .filter(|running| running.model.id() == network_id)
            else {
                drop(state);
                let _ = outbound.send(command_rejection(
                    command_id,
                    EngineMessageKey::NetworkNotFound,
                ));
                return;
            };
            let snapshot = running.client.snapshot();
            let mut events = running.model.restore_pushed_messages(messages, &snapshot);
            for advance in running.model.pending_read_advances() {
                queue_read_advance(&mut running.pending_reads, advance);
            }
            let read_flush = start_read_flush(running);
            let history_fetches = if running.model.is_online() {
                running.model.connected_history()
            } else {
                Vec::new()
            };
            if !history_fetches.is_empty() {
                events.push(running.model.buffers_event());
            }
            let client = running.client.clone();
            let instance = running.instance;
            events.push(EngineToUi::CommandResult { id: command_id });
            let events = finish_timeline_turn(state, events);
            send_events(&outbound, events);
            update_chat_list(&shared_state, &outbound, instance);
            if let Some((client, instance)) = read_flush {
                spawn_read_flush(
                    Arc::clone(&shared_state),
                    outbound.clone(),
                    client,
                    instance,
                );
            }
            for fetch in history_fetches {
                spawn_history_fetch(
                    Arc::clone(&shared_state),
                    outbound.clone(),
                    client.clone(),
                    instance,
                    fetch,
                    None,
                );
            }
        });
        Vec::new()
    }

    fn store_push_device(
        &self,
        command_id: String,
        credentials: crate::PushDeviceCredentials,
    ) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let event = match push_device::write(storage.as_ref(), &credentials).await {
                Ok(()) => EngineToUi::CommandResult { id: command_id },
                Err(_) => command_rejection(command_id, EngineMessageKey::StorageUnavailable),
            };
            let _ = outbound.send(event);
        });
        Vec::new()
    }

    fn clear_push_device(&self, command_id: String, relay: String) -> Vec<EngineToUi> {
        let storage = lock(&self.state).storage.clone();
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let event = match push_device::clear(storage.as_ref(), &relay).await {
                Ok(()) => EngineToUi::CommandResult { id: command_id },
                Err(_) => command_rejection(command_id, EngineMessageKey::StorageUnavailable),
            };
            let _ = outbound.send(event);
        });
        Vec::new()
    }

    fn ensure_push(
        &self,
        command_id: String,
        network_id: NetworkId,
        route: crate::PushRoute,
        unregister: Vec<String>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let snapshot = running.client.snapshot();
        if let Some(reason) = push_unsupported_reason(&snapshot) {
            let push_state = PushState::Unsupported { reason };
            running.push.state = Some(push_state.clone());
            return vec![
                EngineToUi::PushStateChanged {
                    network_id,
                    state: push_state,
                },
                EngineToUi::CommandResult { id: command_id },
            ];
        }
        running.push.generation = running.push.generation.saturating_add(1);
        let generation = running.push.generation;
        let registered = RegisteredPushRoute {
            route_id: route.route_id,
            endpoint: route.endpoint,
            p256dh: route.p256dh,
            auth: papo::Secret::new(route.auth.into_inner()),
        };
        running.push.route = Some(registered.clone());
        let task = PushRegisterTask {
            instance: running.instance,
            generation,
            network_id,
            route: registered,
            unregister,
        };
        let client = running.client.clone();
        drop(state);
        spawn_push_register(
            Arc::clone(&self.state),
            self.outbound.clone(),
            client,
            task,
            Some(command_id),
        );
        Vec::new()
    }

    fn announce_push_route(&self, command_id: String, network_id: NetworkId) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state
            .network
            .as_ref()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let snapshot = running.client.snapshot();
        let announced = snapshot
            .is_connected()
            .then(|| push_route_event(running, &snapshot))
            .flatten();
        announced
            .into_iter()
            .chain([EngineToUi::CommandResult { id: command_id }])
            .collect()
    }

    fn unregister_push_route(
        &self,
        command_id: String,
        network_id: NetworkId,
        route_id: String,
        endpoint: String,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let clear_current = running
            .push
            .route
            .as_ref()
            .is_some_and(|current| current.route_id == route_id);
        if clear_current {
            running.push.generation = running.push.generation.saturating_add(1);
        }
        let task = PushUnregisterTask {
            instance: running.instance,
            generation: running.push.generation,
            network_id,
            route_id,
            endpoint,
            clear_current,
        };
        let client = running.client.clone();
        drop(state);
        spawn_push_unregister(
            Arc::clone(&self.state),
            self.outbound.clone(),
            client,
            task,
            command_id,
        );
        Vec::new()
    }

    fn submit_input(
        &self,
        id: String,
        buffer_id: BufferId,
        input: &str,
        reply_to: Option<MessageId>,
    ) -> Vec<EngineToUi> {
        let chantypes = lock(&self.state).network.as_ref().map_or_else(
            || "#&".to_owned(),
            |running| running.client.snapshot().isupport().chantypes().to_owned(),
        );
        let parsed = commands::parse_with_registry(commands::registry(), input, &chantypes);
        let projected_join = match &parsed {
            Ok(Command::Join { channels, .. }) => self.projected_channels(&channels.0),
            _ => None,
        };
        if let Some(channels) = projected_join
            .as_ref()
            .filter(|channels| channels.iter().all(|(_, focusable)| *focusable))
        {
            if let Some(name) = commands::explicit_command_name(input)
                && let Some(running) = lock(&self.state).network.as_mut()
            {
                running.model.remember_command(name);
            }
            return focus_projected_channels(&id, channels);
        }
        if parsed.as_ref().is_ok_and(server_command)
            && projected_join.is_none()
            && !lock(&self.state)
                .network
                .as_ref()
                .is_some_and(|running| running.model.is_online())
        {
            return rejected_command(id, EngineMessageKey::Offline);
        }
        if parsed.is_ok()
            && let Some(name) = commands::explicit_command_name(input)
            && let Some(running) = lock(&self.state).network.as_mut()
        {
            running.model.remember_command(name);
        }
        self.run_command(id, buffer_id, parsed, reply_to)
    }

    fn run_command(
        &self,
        id: String,
        buffer_id: BufferId,
        parsed: Result<Command, commands::InputError>,
        reply_to: Option<MessageId>,
    ) -> Vec<EngineToUi> {
        match parsed {
            Ok(Command::Say { text }) => match reply_to {
                Some(parent) => self.send_reply(id, buffer_id, parent, text.0),
                None => self.send_input(id, buffer_id, text.0, &crate::MessageKind::Text),
            },
            Ok(Command::Me { text }) => {
                self.send_input(id, buffer_id, text.0, &crate::MessageKind::Action)
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
            Ok(Command::Kick { nick, reason }) => {
                self.kick(id, buffer_id, nick.0, reason.map(|reason| reason.0))
            }
            Ok(Command::Op { nicks }) => {
                self.set_member_modes(id, buffer_id, nicks.0, MemberMode::Op)
            }
            Ok(Command::Deop { nicks }) => {
                self.set_member_modes(id, buffer_id, nicks.0, MemberMode::Deop)
            }
            Ok(Command::Voice { nicks }) => {
                self.set_member_modes(id, buffer_id, nicks.0, MemberMode::Voice)
            }
            Ok(Command::Devoice { nicks }) => {
                self.set_member_modes(id, buffer_id, nicks.0, MemberMode::Devoice)
            }
            Ok(Command::Ban { nick }) => self.ban(id, buffer_id, nick.0),
            Ok(Command::Unban { nick }) => self.unban(id, buffer_id, nick.0),
            Ok(Command::Invite { nick, channel }) => self.invite(id, buffer_id, nick.0, channel.0),
            Ok(Command::Mode {
                channel,
                modes: None,
            }) => self.show_modes(id, buffer_id, channel.0),
            Ok(Command::Mode {
                channel,
                modes: Some(modes),
            }) => self.set_modes(id, buffer_id, channel.0, &modes.0),
            Ok(Command::Kickban { nick, reason }) => {
                self.kickban(id, buffer_id, nick.0, reason.map(|reason| reason.0))
            }
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
                    rejected_command(id, EngineMessageKey::NetworkNotFound)
                }
            }
            Ok(Command::Help { command }) => vec![
                EngineToUi::CommandHelpRequested {
                    command: command.map(|command| command.0),
                },
                EngineToUi::CommandResult { id },
            ],
            Ok(Command::Version {}) => self.show_version(id, buffer_id),
            Ok(Command::File {}) => rejected_command(id, EngineMessageKey::ComposerFileNeedsPicker),
            Ok(Command::Identify { password }) => self.identify(id, &password.0),
            Err(error) => rejected_command(id, error.message_key()),
        }
    }

    fn composer_changed(&self, buffer_id: BufferId, input: &str) {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return;
        };
        if !running.client.snapshot().supports(papo::Feature::Typing) {
            _ = running.typing.done(buffer_id);
            return;
        }
        let target = running.model.send_target(buffer_id);
        let (typing, pause) = running.typing.changed(buffer_id, input);
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        if let (Some(target), Some(typing)) = (target, typing) {
            spawn_typing(client, target, typing);
        }
        if let Some(pause) = pause {
            spawn_typing_pause(Arc::clone(&self.state), instance, pause);
        }
    }

    fn show_version(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let text = if state.update_ready {
            format!("{} · update ready — restart the app", state.build_version)
        } else {
            state.build_version.clone()
        };
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if running
            .model
            .append_notice(buffer_id, text, NoticeKind::Info)
            .is_none()
        {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        }
        finish_timeline_turn(state, vec![EngineToUi::CommandResult { id: command_id }])
    }

    fn identify(&self, command_id: String, password: &str) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
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
        focus: bool,
    ) -> Vec<EngineToUi> {
        let state = lock(&self.state);
        let Some(running) = state
            .network
            .as_ref()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let client = running.client.clone();
        let instance = running.instance;
        drop(state);
        self.capture_direct(command_id, client, instance, nick, None, focus);
        Vec::new()
    }

    fn defer_direct_identity(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(event) = running.model.defer_direct_identity(buffer_id) else {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        };
        vec![event, EngineToUi::CommandResult { id: command_id }]
    }

    fn trust_direct_identity(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(event) = running.model.trust_direct_identity(buffer_id) else {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        };
        vec![event, EngineToUi::CommandResult { id: command_id }]
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
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(channel) = running.model.channel_for_buffer(buffer_id) else {
            return rejected_command(command_id, EngineMessageKey::ChannelRequired);
        };
        let snapshot = running.client.snapshot();
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
            return rejected_command(command_id, EngineMessageKey::ChannelNotFound);
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
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let snapshot = running.client.snapshot();
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
            None => Vec::new(),
            Some(CompletionTrigger::Command) => {
                command_candidates(&context.prefix, &running.model, &snapshot)
            }
            Some(CompletionTrigger::Person) => person_candidates(
                &running.model,
                buffer_id,
                &context.prefix,
                if context.auto_accept {
                    NickMatch::Exact
                } else {
                    NickMatch::Prefix
                },
                &snapshot,
            ),
            Some(CompletionTrigger::Channel) => {
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
                usage: context.usage,
                replacement_prefix: context.replacement_prefix,
                replacement_suffix: context.replacement_suffix,
                auto_accept: context.auto_accept && candidates.len() == 1,
                candidates,
            },
            EngineToUi::CommandResult { id: command_id },
        ]
    }

    fn connect(&self, command_id: String, config: ConnectConfig) -> Vec<EngineToUi> {
        if !valid_endpoint(&config.endpoint, config.allow_insecure) {
            return rejected_command(command_id, EngineMessageKey::InvalidEndpoint);
        }

        let identity = config.identity();
        let authentication_kind = identity.kind();
        let snapshot_fingerprint = chat_list_snapshot::fingerprint(&config.label, &config.endpoint);
        let mut state = lock(&self.state);
        if let Some(running) = state.network.as_mut() {
            if authentication_kind != running.identity.kind() {
                return rejected_command(command_id, EngineMessageKey::NetworkAlreadyConnected);
            }
            return attach_shell(running, command_id);
        }
        let id = NetworkId(state.next_network_id);
        state.next_network_id += 1;
        let instance = state.next_instance;
        state.next_instance += 1;
        let hosted_reconnect =
            (authentication_kind == AuthenticationKind::HostedOAuth).then(|| {
                HostedReconnectConfig {
                    endpoint: config.endpoint.clone(),
                    nickname: config.nickname.clone(),
                    autojoin: config.autojoin.clone(),
                }
            });
        let mut model = NetworkModel::with_calendar(
            id,
            config.label.clone(),
            config.nickname.clone(),
            DEFAULT_WINDOW_LIMIT,
            Arc::clone(&state.calendar),
        );
        model.set_tls(endpoint_is_tls(&config.endpoint));
        let (client, events, driver) = build_client(config);
        let cached_snapshot = state
            .cached_snapshot
            .take()
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &snapshot_fingerprint));
        if let Some(snapshot) = cached_snapshot.as_ref() {
            model.restore_chat_list(snapshot.clone(), &client.snapshot());
        }
        let pushed = std::mem::take(&mut state.cached_pushed_messages);
        let restored_push = !model
            .restore_pushed_messages(pushed, &client.snapshot())
            .is_empty();
        let mut output = vec![model.network_event(), model.buffers_event()];
        if restored_push {
            output.extend(model.take_timeline_changes(true));
            output.push(EngineToUi::PushedMessagesLoaded { network_id: id });
        }
        output.push(EngineToUi::CommandResult { id: command_id });
        state.network = Some(RunningNetwork {
            instance,
            identity,
            client: client.clone(),
            model,
            connection_attempt: 1,
            device_online: true,
            pending_sends: VecDeque::new(),
            flushing_sends: false,
            pending_reads: VecDeque::new(),
            flushing_reads: false,
            hosted_reconnect,
            chat_list: ChatListSync {
                fingerprint: snapshot_fingerprint.clone(),
                snapshot: Some(
                    cached_snapshot
                        .unwrap_or_else(|| ChatListSnapshot::new(snapshot_fingerprint, Vec::new())),
                ),
                ..ChatListSync::default()
            },
            push: PushRegistration::default(),
            typing: crate::typing::OutgoingTyping::default(),
        });
        let output = finish_timeline_turn(state, output);
        if restored_push {
            update_chat_list(&self.state, &self.outbound, instance);
        }

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

    fn prepare_hosted(
        &self,
        command_id: String,
        label: String,
        endpoint: String,
        nickname: String,
        autojoin: Vec<String>,
    ) -> Vec<EngineToUi> {
        if !valid_endpoint(&endpoint, false) {
            return rejected_command(command_id, EngineMessageKey::InvalidEndpoint);
        }

        let snapshot_fingerprint = chat_list_snapshot::fingerprint(&label, &endpoint);
        let mut state = lock(&self.state);
        if let Some(running) = state.network.as_mut() {
            if running.identity.kind() != AuthenticationKind::HostedOAuth {
                return rejected_command(command_id, EngineMessageKey::NetworkAlreadyConnected);
            }
            return attach_shell(running, command_id);
        }
        let id = NetworkId(state.next_network_id);
        state.next_network_id += 1;
        let instance = state.next_instance;
        state.next_instance += 1;
        let (client, _events, _driver) =
            build_pending_hosted_client(&endpoint, &nickname, autojoin.clone());
        let mut model = NetworkModel::with_calendar(
            id,
            label,
            nickname.clone(),
            DEFAULT_WINDOW_LIMIT,
            Arc::clone(&state.calendar),
        );
        model.set_tls(endpoint_is_tls(&endpoint));
        let cached_snapshot = state
            .cached_snapshot
            .take()
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &snapshot_fingerprint));
        if let Some(snapshot) = cached_snapshot.as_ref() {
            model.restore_chat_list(snapshot.clone(), &client.snapshot());
        }
        let pushed = std::mem::take(&mut state.cached_pushed_messages);
        let restored_push = !model
            .restore_pushed_messages(pushed, &client.snapshot())
            .is_empty();
        let mut output = vec![model.network_event(), model.buffers_event()];
        if restored_push {
            output.extend(model.take_timeline_changes(true));
            output.push(EngineToUi::PushedMessagesLoaded { network_id: id });
        }
        output.push(EngineToUi::CommandResult { id: command_id });
        state.network = Some(RunningNetwork {
            instance,
            identity: ConnectionIdentity::hosted(endpoint.clone()),
            client,
            model,
            connection_attempt: 1,
            device_online: true,
            pending_sends: VecDeque::new(),
            flushing_sends: false,
            pending_reads: VecDeque::new(),
            flushing_reads: false,
            hosted_reconnect: Some(HostedReconnectConfig {
                endpoint,
                nickname,
                autojoin,
            }),
            chat_list: ChatListSync {
                fingerprint: snapshot_fingerprint.clone(),
                snapshot: Some(
                    cached_snapshot
                        .unwrap_or_else(|| ChatListSnapshot::new(snapshot_fingerprint, Vec::new())),
                ),
                ..ChatListSync::default()
            },
            push: PushRegistration::default(),
            typing: crate::typing::OutgoingTyping::default(),
        });
        let output = finish_timeline_turn(state, output);
        if restored_push {
            update_chat_list(&self.state, &self.outbound, instance);
        }
        output
    }

    fn reconnect_hosted(
        &self,
        command_id: String,
        network_id: NetworkId,
        oauth_token: crate::RedactedSecret,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(mut running) = state.network.take() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(config) = running.hosted_reconnect.clone() else {
            state.network = Some(running);
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if running.model.id() != network_id {
            state.network = Some(running);
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        }
        let instance = state.next_instance;
        state.next_instance += 1;
        let previous = running.client;
        let (client, events, driver) = build_client(ConnectConfig {
            label: String::new(),
            endpoint: config.endpoint,
            nickname: config.nickname,
            authentication: ConnectionAuthentication::HostedOAuth {
                token: papo::Secret::new(oauth_token.into_inner()),
            },
            autojoin: config.autojoin,
            allow_insecure: false,
        });
        running.instance = instance;
        running.client = client.clone();
        running.connection_attempt = 1;
        running.flushing_sends = false;
        running.flushing_reads = false;
        running.typing = crate::typing::OutgoingTyping::default();
        state.network = Some(running);
        drop(state);

        spawn_task(async move {
            let _ = previous.quit().await;
        });
        spawn_task(async move {
            let _ = driver.await;
        });
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            drain_events(state, outbound, client, events, instance).await;
        });
        vec![EngineToUi::CommandResult { id: command_id }]
    }

    fn disconnect(
        &self,
        command_id: String,
        network_id: NetworkId,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(mut running) = state.network.take() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if running.model.id() != network_id {
            state.network = Some(running);
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        }
        let event = running.model.set_connection(
            NetworkConnectionState::Offline {
                reason: OfflineReason::Requested,
            },
            None,
        );
        let push_endpoint = running.push.route.map(|route| route.endpoint);
        let client = running.client;
        drop(state);
        spawn_task(async move {
            if let Some(endpoint) = push_endpoint {
                let _ = client.webpush().unregister(endpoint).await;
            }
            let _ = client.quit().reason(reason.unwrap_or_default()).await;
        });
        vec![event, EngineToUi::CommandResult { id: command_id }]
    }

    fn reconnect(&self, command_id: String, network_id: NetworkId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let client = running.client.clone();
        let instance = running.instance;
        let hosted = running.identity.kind() == AuthenticationKind::HostedOAuth;
        let online = running.model.is_online();
        let state_event = (!online).then(|| {
            let next = next_connection_state(
                running.model.connection(),
                ConnectionTransition::ManualRetry,
                papo::time::now(),
            );
            running.model.set_connection(next, None)
        });
        drop(state);
        let outbound = self.outbound.clone();
        let runtime_state = Arc::clone(&self.state);
        spawn_task(async move {
            let result = if online {
                if !answers_probe(&client).await {
                    cancel_inflight_send(&runtime_state, instance).await;
                }
                Ok(())
            } else if hosted {
                cancel_inflight_send(&runtime_state, instance).await;
                let _ = outbound.send(EngineToUi::HostedTokenRequired { network_id });
                Ok(())
            } else {
                cancel_inflight_send(&runtime_state, instance).await;
                reconnect(&runtime_state, &outbound, &client, instance).await
            };
            let event = if result.is_ok() {
                EngineToUi::CommandResult { id: command_id }
            } else {
                command_rejection(command_id, EngineMessageKey::ConnectionFailed)
            };
            let _ = outbound.send(event);
        });
        state_event.into_iter().collect()
    }

    fn set_device_online(
        &self,
        command_id: String,
        network_id: NetworkId,
        online: bool,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.model.id() == network_id)
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        running.device_online = online;
        if online {
            if running.identity.kind() == AuthenticationKind::HostedOAuth {
                return vec![
                    EngineToUi::HostedTokenRequired { network_id },
                    EngineToUi::CommandResult { id: command_id },
                ];
            }
            let client = running.client.clone();
            let instance = running.instance;
            drop(state);
            let outbound = self.outbound.clone();
            let state = Arc::clone(&self.state);
            spawn_task(async move {
                let event = if reconnect(&state, &outbound, &client, instance)
                    .await
                    .is_ok()
                {
                    EngineToUi::CommandResult { id: command_id }
                } else {
                    command_rejection(command_id, EngineMessageKey::ConnectionFailed)
                };
                let _ = outbound.send(event);
            });
            Vec::new()
        } else {
            let next = next_connection_state(
                running.model.connection(),
                ConnectionTransition::DeviceOffline,
                papo::time::now(),
            );
            vec![
                running.model.set_connection(next, None),
                EngineToUi::CommandResult { id: command_id },
            ]
        }
    }

    fn expire_hosted_authentication(
        &self,
        command_id: String,
        network_id: NetworkId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(mut running) = state.network.take() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if running.model.id() != network_id
            || running.identity.kind() != AuthenticationKind::HostedOAuth
        {
            state.network = Some(running);
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        }
        let next = next_connection_state(
            running.model.connection(),
            ConnectionTransition::AuthenticationExpired,
            papo::time::now(),
        );
        let event = running.model.set_connection(next, None);
        let push_endpoint = running.push.route.map(|route| route.endpoint);
        let client = running.client;
        let storage = state.storage.clone();
        cancel_snapshot_writes(&state.snapshot_writer);
        drop(state);
        spawn_task(async move {
            if let Some(endpoint) = push_endpoint {
                let _ = client.webpush().unregister(endpoint).await;
            }
            let _ = client.quit().await;
            let _ = chat_list_snapshot::clear(storage.as_ref()).await;
        });
        vec![
            event,
            EngineToUi::notice(EngineMessageKey::HostedAuthFailed),
            EngineToUi::CommandResult { id: command_id },
        ]
    }

    fn hosted_token_unavailable(
        &self,
        command_id: String,
        network_id: NetworkId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut().filter(|running| {
            running.model.id() == network_id
                && running.identity.kind() == AuthenticationKind::HostedOAuth
        }) else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let event = running.model.set_connection(
            NetworkConnectionState::Failed {
                reason: ConnectionFailureReason::Transport,
                message_key: EngineMessageKey::ConnectionFailed,
            },
            None,
        );
        vec![event, EngineToUi::CommandResult { id: command_id }]
    }

    fn unlabelled_peer(&self, buffer_id: BufferId) -> Option<String> {
        let state = lock(&self.state);
        let running = state
            .network
            .as_ref()
            .filter(|running| running.device_online && running.model.is_online())?;
        let nick = running.model.direct_peer(buffer_id)?;
        crate::services::sends_unlabelled(&running.client.snapshot(), nick.as_str())
            .then(|| nick.to_string())
    }

    fn send_input(
        &self,
        command_id: String,
        buffer_id: crate::BufferId,
        text: String,
        kind: &crate::MessageKind,
    ) -> Vec<EngineToUi> {
        if *kind == crate::MessageKind::Text
            && let Some(nick) = self.unlabelled_peer(buffer_id)
        {
            return self.message_direct(command_id, nick, text, false);
        }
        self.queue_send(command_id, buffer_id, |model, state| {
            match kind {
                crate::MessageKind::Text => model.begin_send(buffer_id, text, state),
                crate::MessageKind::Action => model.begin_action(buffer_id, text, state),
                crate::MessageKind::IrcNotice(_)
                | crate::MessageKind::Notice(_)
                | crate::MessageKind::Redacted(_) => None,
            }
            .ok_or_else(|| model.send_rejection_key(buffer_id))
        })
    }

    fn send_reply(
        &self,
        command_id: String,
        buffer_id: crate::BufferId,
        parent_id: MessageId,
        text: String,
    ) -> Vec<EngineToUi> {
        self.queue_send(command_id, buffer_id, |model, state| {
            model.begin_reply(buffer_id, parent_id, text, state)
        })
    }

    fn queue_send(
        &self,
        command_id: String,
        buffer_id: crate::BufferId,
        begin: impl FnOnce(
            &mut NetworkModel,
            &papo::State,
        ) -> Result<(PendingSend, Vec<EngineToUi>), EngineMessageKey>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let await_live_target = running.model.awaits_live_target(buffer_id);
        let (pending, mut output) = match begin(&mut running.model, &running.client.snapshot()) {
            Ok(started) => started,
            Err(key) => return rejected_command(command_id, key),
        };
        let typing_done = running.typing.done(buffer_id);
        let typing_target = running.model.send_target(buffer_id);
        let direct_resolution = await_live_target
            .then(|| running.model.begin_buffer_direct_resolution(buffer_id))
            .flatten();
        let retry_if_disconnected =
            await_live_target || !running.device_online || running.model.is_online();
        running.pending_sends.push_back(QueuedSend {
            pending,
            retry_if_disconnected,
            await_live_target,
        });
        let should_flush = running.device_online && !running.flushing_sends;
        if should_flush {
            running.flushing_sends = true;
        }
        let client = running.client.clone();
        let instance = running.instance;
        output.push(EngineToUi::CommandResult { id: command_id });
        let output = finish_timeline_turn(state, output);

        if let (Some(target), Some(typing)) = (typing_target, typing_done) {
            spawn_typing(client.clone(), target, typing);
        }

        if let Some(nick) = direct_resolution {
            spawn_cached_direct_resolution(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client.clone(),
                instance,
                buffer_id,
                nick,
            );
        }

        if should_flush {
            spawn_send_flush(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client,
                instance,
            );
        }
        output
    }

    fn retry_message(
        &self,
        command_id: String,
        buffer_id: BufferId,
        local_send_id: LocalSendId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(pending) = running.model.retry_send(buffer_id, local_send_id) else {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        };
        let client = running.client.clone();
        let instance = running.instance;
        let output = finish_timeline_turn(state, Vec::new());
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            finish_send(&state, &outbound, &client, instance, &pending).await;
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
        output
    }

    fn toggle_reaction(
        &self,
        command_id: String,
        buffer_id: BufferId,
        message_id: MessageId,
        reaction: String,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if !can_react(&running.client.snapshot()) {
            return rejected_command(command_id, EngineMessageKey::CommandRefused);
        }
        let Some(change) = running
            .model
            .toggle_own_reaction(buffer_id, message_id, reaction)
        else {
            return vec![EngineToUi::CommandResult { id: command_id }];
        };
        let client = running.client.clone();
        let instance = running.instance;
        let output = finish_timeline_turn(state, Vec::new());
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let result = send_reaction(&client, &change).await;
            let mut state = lock(&state);
            if let Some(running) = state
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            {
                match result {
                    // TODO(papo-0.1 reaction-confirm): stamp with the echo's server time
                    // once papo resolves reactions to `Confirmed { msgid, server_time }`.
                    Ok(()) => running
                        .model
                        .confirm_own_reaction(&change, time_millis(papo::time::now())),
                    Err(_) => running.model.fail_own_reaction(&change),
                }
                send_events(&outbound, finish_timeline_turn(state, Vec::new()));
            }
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
        output
    }

    fn redact_message(
        &self,
        command_id: String,
        buffer_id: BufferId,
        message_id: MessageId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if !running.model.can_redact() {
            return rejected_command(command_id, EngineMessageKey::CommandRefused);
        }
        let Some(redaction) = running.model.begin_own_redaction(buffer_id, message_id) else {
            return rejected_command(command_id, EngineMessageKey::CommandRefused);
        };
        let client = running.client.clone();
        let instance = running.instance;
        let output = finish_timeline_turn(state, Vec::new());
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let deleted = send_redaction(&client, &redaction).await.is_ok();
            let mut state = lock(&state);
            if let Some(running) = state
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            {
                let mut events = Vec::new();
                // TODO(papo-0.1 reaction-confirm): papo resolves `redact` with `()` once its
                // labeled response arrives, so that stands in for the server's confirming REDACT.
                if deleted {
                    events.extend(running.model.confirm_own_redaction(&redaction));
                } else {
                    running.model.fail_own_redaction(&redaction);
                    events.push(EngineToUi::error_notice(EngineMessageKey::RedactFailed));
                }
                send_events(&outbound, finish_timeline_turn(state, events));
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
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if targets
            .iter()
            .any(|target| !valid_channel_input(&client.snapshot(), &target.channel))
        {
            return rejected_command(command_id, EngineMessageKey::CommandRefused);
        }
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            for target in targets {
                let channel_name = target.channel.clone();
                let Some((output, focused)) =
                    sync_joined_channel(&state, &client, instance, &command_id, &channel_name)
                else {
                    return;
                };
                send_events(&outbound, output);
                if focused {
                    continue;
                }
                with_running_model(&state, instance, |model| model.request_join(&channel_name));
                let result = match target.key {
                    Some(key) => {
                        client
                            .join(target.channel)
                            .key(papo::Secret::new(key))
                            .await
                    }
                    None => client.join(target.channel).await,
                };
                if let Err(error) = result {
                    with_running_model(&state, instance, |model| {
                        model.forget_join_request(&channel_name);
                    });
                    let Some((output, focused)) =
                        sync_joined_channel(&state, &client, instance, &command_id, &channel_name)
                    else {
                        return;
                    };
                    send_events(&outbound, output);
                    if focused {
                        continue;
                    }
                    send_events(&outbound, join_request_events(command_id, &error));
                    return;
                }
                let Some((output, _)) =
                    sync_joined_channel(&state, &client, instance, &command_id, &channel_name)
                else {
                    return;
                };
                send_events(&outbound, output);
            }
            let _ = outbound.send(EngineToUi::CommandResult { id: command_id });
        });
        Vec::new()
    }

    fn projected_channels(&self, channels: &[String]) -> Option<Vec<(BufferId, bool)>> {
        let state = lock(&self.state);
        let model = &state.network.as_ref()?.model;
        channels
            .iter()
            .map(|channel| model.projected_channel_for_join(channel))
            .collect()
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
            self.open_direct(command_id, network_id, nick, true)
        } else {
            rejected_command(command_id, EngineMessageKey::NetworkNotFound)
        }
    }

    fn notice(&self, command_id: String, target: String, text: String) -> Vec<EngineToUi> {
        let Some(client) = lock(&self.state)
            .network
            .as_ref()
            .map(|running| running.client.clone())
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let snapshot = client.snapshot();
        if snapshot.isupport().is_channel(&target) {
            spawn_request(self.outbound.clone(), command_id, async move {
                client.notice(target, text).await
            });
        } else {
            spawn_request(self.outbound.clone(), command_id, async move {
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
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
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
        mut text: Option<String>,
        focus: bool,
    ) {
        let state = Arc::clone(&self.state);
        let outbound = self.outbound.clone();
        spawn_task(async move {
            let snapshot = client.snapshot();
            let nick = crate::services::canonical(&snapshot, nick);
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
            let direct = match (known, known_nick) {
                (Some(DirectAvailability::Guarded(direct)), _) => direct,
                (_, Some(nick)) => DirectPeer::resolve(&client, &nick),
                (_, None) => {
                    let _ = outbound.send(command_rejection(
                        command_id,
                        EngineMessageKey::DirectUnavailable,
                    ));
                    return;
                }
            };
            let nick = direct.nick().clone();
            let direct = DirectAvailability::Guarded(direct);
            let unlabelled = crate::services::take_unlabelled(&client.snapshot(), &nick, &mut text);
            let (pending, rejection, output) = {
                let mut state = lock(&state);
                let Some(running) = state
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                else {
                    return;
                };
                let snapshot = running.client.snapshot();
                let (buffer_id, mut output) =
                    open_direct_with_live_state(&mut running.model, nick, direct, &snapshot);
                running.record_direct_presence(buffer_id);
                request_buffer_focus(&mut output, focus, &command_id, buffer_id);
                let mut rejection = None;
                let pending = text.and_then(|text| {
                    let Some((pending, events)) =
                        running
                            .model
                            .begin_send(buffer_id, text, &running.client.snapshot())
                    else {
                        rejection = Some(running.model.send_rejection_key(buffer_id));
                        return None;
                    };
                    output.extend(events);
                    Some(pending)
                });
                (pending, rejection, finish_timeline_turn(state, output))
            };
            for event in output {
                let _ = outbound.send(event);
            }
            update_chat_list(&state, &outbound, instance);
            if let Some(pending) = pending {
                finish_send(&state, &outbound, &client, instance, &pending).await;
            }
            let rejection = crate::services::send(&client, unlabelled, rejection).await;
            let _ = outbound.send(terminal_command(command_id, rejection));
        });
    }

    fn part(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        self.channel_request(
            command_id,
            buffer_id,
            requested,
            None,
            |channel, client| async move {
                Ok(with_channel!(&channel, name => client.part(name).reason(reason.unwrap_or_default()).await)?)
            },
        )
    }

    fn kick(
        &self,
        command_id: String,
        buffer_id: BufferId,
        nick: String,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        self.channel_request(
            command_id,
            buffer_id,
            None,
            Some(nick.clone()),
            |channel, client| async move {
                require_member(&client, &channel, &nick)?;
                Ok(with_channel!(&channel, name => client.kick(name, nick).reason(reason.unwrap_or_default()).await)?)
            },
        )
    }

    fn ban(&self, command_id: String, buffer_id: BufferId, word: String) -> Vec<EngineToUi> {
        self.channel_request(
            command_id,
            buffer_id,
            None,
            None,
            |channel, client| async move {
                let mask = crate::ban_mask::ban_mask(&client.snapshot(), &word);
                let request = with_channel!(&channel, name => client.set_modes(name));
                modes_settled(&request.ban(mask).await?)
            },
        )
    }

    fn unban(&self, command_id: String, buffer_id: BufferId, word: String) -> Vec<EngineToUi> {
        self.channel_request(
            command_id,
            buffer_id,
            None,
            None,
            |channel, client| async move {
                let known = match &channel {
                    ChannelTarget::Known(name) => Some(name),
                    ChannelTarget::Text(_) => None,
                };
                let masks = crate::ban_mask::unban_masks(&client.snapshot(), known, &word);
                let request = with_channel!(&channel, name => client.set_modes(name));
                let request = masks.into_iter().fold(request, papo::SetModes::unban);
                modes_settled(&request.await?)
            },
        )
    }

    fn kickban(
        &self,
        command_id: String,
        buffer_id: BufferId,
        nick: String,
        reason: Option<String>,
    ) -> Vec<EngineToUi> {
        self.channel_request(
            command_id,
            buffer_id,
            None,
            Some(nick.clone()),
            |channel, client| async move {
                require_member(&client, &channel, &nick)?;
                let mask = crate::ban_mask::ban_mask(&client.snapshot(), &nick);
                let request = with_channel!(&channel, name => client.kickban(name));
                let outcome = request
                    .nick(nick)
                    .ban(mask)
                    .reason(reason.unwrap_or_default())
                    .await?;
                Ok(outcome.kick?)
            },
        )
    }

    fn invite(
        &self,
        command_id: String,
        buffer_id: BufferId,
        nick: String,
        requested: Option<String>,
    ) -> Vec<EngineToUi> {
        let outbound = self.outbound.clone();
        self.channel_request(
            command_id,
            buffer_id,
            requested,
            Some(nick.clone()),
            |channel, client| async move {
                with_channel!(&channel, name => client.invite(&nick, name).await)?;
                let _ = outbound.send(EngineToUi::Notice {
                    key: "notice.invite_sent".into(),
                    values: std::collections::BTreeMap::from([
                        ("nick".into(), nick),
                        ("target".into(), channel.label()),
                    ]),
                    tone: crate::NoticeTone::Neutral,
                    action: None,
                });
                Ok(())
            },
        )
    }

    fn show_modes(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
    ) -> Vec<EngineToUi> {
        let outbound = self.outbound.clone();
        self.channel_request(
            command_id,
            buffer_id,
            requested,
            None,
            |channel, client| async move {
                let target = channel.label();
                if crate::name_key::known_channel(&client.snapshot(), target.as_str()).is_none() {
                    return Err(ChannelFailure::Refused(papo::Refusal::NotOnChannel));
                }
                let mut modes = cached_channel_modes(&client, &target);
                if modes.is_none() {
                    // TODO(papo-0.1): papo has no typed channel-mode query; the PING after the
                    // raw MODE returns once the server's 324 has updated papo's channel state.
                    client
                        .send_raw(papo::Line::new("MODE").with_params([target.clone()]))
                        .await?;
                    client.ping().await?;
                    modes = cached_channel_modes(&client, &target);
                }
                let (key, values) = modes.map_or_else(
                    || ("notice.channel_modes_none", BTreeMap::new()),
                    |modes| {
                        (
                            "notice.channel_modes",
                            BTreeMap::from([("modes".into(), modes)]),
                        )
                    },
                );
                let mut values = values;
                values.insert("target".into(), target);
                let _ = outbound.send(EngineToUi::Notice {
                    key: key.into(),
                    values,
                    tone: crate::NoticeTone::Neutral,
                    action: None,
                });
                Ok(())
            },
        )
    }

    fn set_modes(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        text: &str,
    ) -> Vec<EngineToUi> {
        let parsed = lock(&self.state).network.as_ref().map(|running| {
            let semantics =
                crate::mode_string::mode_semantics(running.client.snapshot().isupport());
            crate::mode_string::parse_mode_string(&semantics, text)
        });
        let changes = match parsed {
            Some(Ok(changes)) => changes,
            Some(Err(key)) => return rejected_command(command_id, key),
            None => return rejected_command(command_id, EngineMessageKey::NetworkNotFound),
        };
        let mut members = changes
            .iter()
            .filter(|change| change.member_mode)
            .filter_map(|change| change.argument.clone());
        let single = members.next().filter(|_| members.next().is_none());
        self.channel_request(
            command_id,
            buffer_id,
            requested,
            single,
            |channel, client| async move {
                let mut request = with_channel!(&channel, name => client.set_modes(name));
                for change in changes {
                    request = apply_mode_change(&client, &channel, request, change)?;
                }
                modes_settled(&request.await?)
            },
        )
    }

    fn set_member_modes(
        &self,
        command_id: String,
        buffer_id: BufferId,
        nicks: Vec<String>,
        mode: MemberMode,
    ) -> Vec<EngineToUi> {
        let single = (nicks.len() == 1).then(|| nicks[0].clone());
        self.channel_request(
            command_id,
            buffer_id,
            None,
            single,
            |channel, client| async move {
                let mut request = with_channel!(&channel, name => client.set_modes(name));
                for nick in nicks {
                    request = mode.apply(&client, &channel, request, nick)?;
                }
                modes_settled(&request.await?)
            },
        )
    }

    fn channel_request<Output, Request>(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<String>,
        nick: Option<String>,
        request: impl FnOnce(ChannelTarget, papo::Client) -> Request,
    ) -> Vec<EngineToUi>
    where
        Output: Send + 'static,
        Request: std::future::Future<Output = Result<Output, ChannelFailure>> + Send + 'static,
    {
        let state = lock(&self.state);
        let Some(running) = state.network.as_ref() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let channel = match channel_target(running, buffer_id, requested) {
            Ok(channel) => channel,
            Err(key) => return rejected_command(command_id, key),
        };
        let client = running.client.clone();
        drop(state);
        let names = RefusalNames {
            target: channel.label(),
            nick,
        };
        spawn_channel_request(
            self.outbound.clone(),
            command_id,
            names,
            request(channel, client),
        );
        Vec::new()
    }

    fn close(&self, command_id: String, buffer_id: BufferId) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if running.model.joined_channel_for_buffer(buffer_id).is_some() {
            drop(state);
            return self.part(command_id, buffer_id, None, None);
        }
        let Some(conversation) = running.model.snapshot_conversation_for_buffer(buffer_id) else {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        };
        let advance = running.model.prepare_latest_mark_read(buffer_id);
        let peer = running.model.direct_peer(buffer_id);
        let Some(event) = running.model.close_direct(buffer_id) else {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        };
        if let Some(peer) = peer {
            running.model.release_launch_watch(&peer);
        }
        let mut output = advance
            .map(|advance| record_read_advances(running, [advance]))
            .unwrap_or_default();
        let flush = start_read_flush(running);
        running.chat_list.removed.push(SnapshotRemoval {
            conversation,
            removed_at_ms: time_millis(papo::time::now()),
        });
        let instance = running.instance;
        output.extend([event, EngineToUi::CommandResult { id: command_id }]);
        let output = finish_timeline_turn(state, output);
        update_chat_list(&self.state, &self.outbound, instance);
        if let Some((client, instance)) = flush {
            spawn_read_flush(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client,
                instance,
            );
        }
        output
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
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let channel = match channel_target(running, buffer_id, requested) {
            Ok(channel) => channel,
            Err(key) => return rejected_command(command_id, key),
        };
        let client = running.client.clone();
        drop(state);
        spawn_join_request(self.outbound.clone(), command_id, async move {
            with_channel!(&channel, name => client.part(name).reason(reason.unwrap_or_default()).await)?;
            with_channel!(&channel, name => client.join(name).await)
        });
        Vec::new()
    }

    fn set_nick(&self, command_id: String, nick: String) -> Vec<EngineToUi> {
        let Some(client) = lock(&self.state)
            .network
            .as_ref()
            .map(|running| running.client.clone())
        else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if !valid_nick_input(&client.snapshot(), &nick) {
            return rejected_command(command_id, EngineMessageKey::CommandRefused);
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
        self.channel_request(
            command_id,
            buffer_id,
            requested,
            None,
            |channel, client| async move {
                Ok(with_channel!(&channel, name => client.set_topic(name, text).await)?)
            },
        )
    }

    fn show_topic(
        &self,
        command_id: String,
        buffer_id: BufferId,
        requested: Option<&str>,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let snapshot = running.client.snapshot();
        let channel = requested
            .and_then(|name| crate::name_key::known_channel(&snapshot, name))
            .or_else(|| {
                running
                    .model
                    .channel_for_buffer(buffer_id)
                    .and_then(|name| crate::name_key::known_channel(&snapshot, name))
            });
        let Some(channel) = channel else {
            return rejected_command(command_id, EngineMessageKey::ChannelRequired);
        };
        let Some(buffer_id) = running.model.buffer_id_for_channel(channel.name()) else {
            return rejected_command(command_id, EngineMessageKey::ChannelRequired);
        };
        if running
            .model
            .show_topic_card(buffer_id, channel, time_millis(papo::time::now()))
            .is_none()
        {
            return rejected_command(command_id, EngineMessageKey::BufferNotSendable);
        }
        finish_timeline_turn(state, vec![EngineToUi::CommandResult { id: command_id }])
    }

    fn mark_read(
        &self,
        command_id: String,
        buffer_id: BufferId,
        through: MessageId,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let Some(advance) = running.model.request_mark_read(buffer_id, through) else {
            engine_log(EngineMessageKey::ReadMarkerInvalid.as_str());
            return vec![
                EngineToUi::Diagnostic {
                    command_id: command_id.clone(),
                    message: EngineMessageKey::ReadMarkerInvalid.as_str().into(),
                },
                EngineToUi::CommandResult { id: command_id },
            ];
        };
        let mut output = record_read_advances(running, [advance]);
        let flush = start_read_flush(running);
        let instance = running.instance;
        output.push(EngineToUi::CommandResult { id: command_id });
        drop(state);
        update_chat_list(&self.state, &self.outbound, instance);
        if let Some((client, instance)) = flush {
            spawn_read_flush(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client,
                instance,
            );
        }
        output
    }

    fn mark_all_read(&self, command_id: String) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        let advances = running.model.request_mark_all_read();
        let mut output = record_read_advances(running, advances);
        let flush = start_read_flush(running);
        let instance = running.instance;
        output.push(EngineToUi::CommandResult { id: command_id });
        drop(state);
        update_chat_list(&self.state, &self.outbound, instance);
        if let Some((client, instance)) = flush {
            spawn_read_flush(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client,
                instance,
            );
        }
        output
    }

    fn fill_shown_gap(&self, running: &mut RunningNetwork, buffer_id: BufferId) {
        if !can_fetch_history(&running.client.snapshot()) {
            return;
        }
        if let Some(fetch) = running.model.begin_gap_fill(buffer_id) {
            spawn_gap_fill(
                Arc::clone(&self.state),
                self.outbound.clone(),
                running.client.clone(),
                running.instance,
                fetch,
            );
        }
    }

    fn load_history(
        &self,
        command_id: String,
        buffer_id: BufferId,
        direction: crate::HistoryDirection,
    ) -> Vec<EngineToUi> {
        let mut state = lock(&self.state);
        let Some(running) = state.network.as_mut() else {
            return rejected_command(command_id, EngineMessageKey::NetworkNotFound);
        };
        if !running.model.is_online() {
            if direction == crate::HistoryDirection::Latest {
                running.model.queue_latest_history(buffer_id);
            }
            return vec![EngineToUi::CommandResult { id: command_id }];
        }
        if direction == crate::HistoryDirection::Gap {
            self.fill_shown_gap(running, buffer_id);
            return vec![EngineToUi::CommandResult { id: command_id }];
        }
        let Some(fetch) = running.model.request_history(buffer_id, direction) else {
            let result = EngineToUi::CommandResult { id: command_id };
            if direction == crate::HistoryDirection::Latest
                && let Some(at_start) = running.model.settled_history_at_start(buffer_id)
            {
                let settled = EngineToUi::HistoryStateChanged {
                    buffer_id,
                    loading: false,
                    at_start,
                };
                return vec![settled, result];
            }
            return vec![result];
        };
        let sync = running.model.buffer_updated(buffer_id);
        let direct_resolution = running.model.begin_buffer_direct_resolution(buffer_id);
        let marker_nick = direct_history_target(&fetch)
            .filter(|nick| running.model.direct_with_stubs_needs_marker(nick))
            .cloned();
        let client = running.client.clone();
        let instance = running.instance;
        spawn_history_fetch(
            Arc::clone(&self.state),
            self.outbound.clone(),
            client.clone(),
            instance,
            fetch,
            marker_nick,
        );
        if let Some(nick) = direct_resolution {
            spawn_cached_direct_resolution(
                Arc::clone(&self.state),
                self.outbound.clone(),
                client,
                instance,
                buffer_id,
                nick,
            );
        }
        sync.into_iter()
            .chain([
                EngineToUi::HistoryStateChanged {
                    buffer_id,
                    loading: true,
                    at_start: false,
                },
                EngineToUi::CommandResult { id: command_id },
            ])
            .collect()
    }
}

/// Another tab sharing this engine starts with no rows, so it receives the running network's
/// retained timelines along with the buffer list.
fn attach_shell(running: &mut RunningNetwork, command_id: String) -> Vec<EngineToUi> {
    let model = &mut running.model;
    let mut output = vec![
        model.network_event(),
        model.buffers_event(),
        EngineToUi::RecentDirectsReady {
            network_id: model.id(),
        },
    ];
    output.extend(model.take_timeline_changes(true));
    output.extend(typing_snapshot_events(model, &running.client.snapshot()));
    if let Some(state) = running.push.state.clone() {
        output.push(EngineToUi::PushStateChanged {
            network_id: model.id(),
            state,
        });
    }
    output.push(EngineToUi::CommandResult { id: command_id });
    output
}

fn server_command(command: &Command) -> bool {
    !matches!(
        command,
        Command::Say { .. }
            | Command::Me { .. }
            | Command::Help { .. }
            | Command::Version { .. }
            | Command::File { .. }
            | Command::Quit { .. }
    )
}

fn record_read_advances(
    running: &mut RunningNetwork,
    advances: impl IntoIterator<Item = ReadAdvance>,
) -> Vec<EngineToUi> {
    let server_backed = running.read_markers_server_backed();
    let mut output = Vec::new();
    for advance in advances {
        output.extend(
            running
                .model
                .advance_read(advance.buffer_id, advance.time, server_backed),
        );
        if server_backed {
            queue_read_advance(&mut running.pending_reads, advance);
        }
    }
    output
}

fn queue_read_advance(pending: &mut VecDeque<ReadAdvance>, advance: ReadAdvance) {
    if let Some(existing) = pending
        .iter_mut()
        .find(|existing| existing.buffer_id == advance.buffer_id)
    {
        if advance.time > existing.time {
            *existing = advance;
        }
        return;
    }
    pending.push_back(advance);
}

fn start_read_flush(running: &mut RunningNetwork) -> Option<(papo::Client, u64)> {
    let snapshot = running.client.snapshot();
    if snapshot.is_connected() && !can_sync_read_markers(&snapshot) {
        running.pending_reads.clear();
        running.model.clear_pending_reads();
        return None;
    }
    if !running.device_online
        || !running.client.snapshot().is_connected()
        || running.pending_reads.is_empty()
        || running.flushing_reads
    {
        return None;
    }
    running.flushing_reads = true;
    Some((running.client.clone(), running.instance))
}

fn spawn_read_flush(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
) {
    spawn_task(async move {
        loop {
            let advance = {
                let mut state = lock(&state);
                let Some(running) = state
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                else {
                    return;
                };
                if !running.device_online || !running.client.snapshot().is_connected() {
                    running.flushing_reads = false;
                    return;
                }
                let Some(advance) = running.pending_reads.pop_front() else {
                    running.flushing_reads = false;
                    return;
                };
                advance
            };
            let Some(target) = lock(&state)
                .network
                .as_ref()
                .filter(|running| running.instance == instance)
                .and_then(|running| {
                    running
                        .model
                        .read_target(advance.buffer_id, &client.snapshot())
                })
            else {
                engine_log(EngineMessageKey::StateInconsistent.as_str());
                let _ = outbound.send(EngineToUi::Diagnostic {
                    command_id: MARK_READ_DIAGNOSTIC_ID.into(),
                    message: EngineMessageKey::StateInconsistent.as_str().into(),
                });
                continue;
            };
            let Some(time) = server_time(advance.time) else {
                continue;
            };
            let mut retry = ReadRetryState::default();
            loop {
                let result = match target.clone() {
                    HistoryTarget::Channel(channel) => {
                        client.mark_read(channel).up_to_time(time).await
                    }
                    HistoryTarget::Direct(nick) => client.mark_read(nick).up_to_time(time).await,
                };
                match result {
                    Ok(_) => {
                        retry.succeeded();
                        break;
                    }
                    Err(papo::Error::Disconnected(_)) => {
                        restart_read_flush_after_disconnect(&state, &outbound, instance, advance);
                        return;
                    }
                    Err(error @ papo::Error::StateLimit(_)) => {
                        _ = state_limit_events(&error, false, None, "mark_read");
                        break;
                    }
                    Err(error) if permanent_mark_read_error(&error) => {
                        report_mark_read_failure(&outbound, &error);
                        break;
                    }
                    Err(error) => {
                        let decision = retry.failed(&error);
                        if decision.diagnostic {
                            report_mark_read_failure(&outbound, &error);
                        }
                        let Some(retry_after) = decision.retry_after else {
                            break;
                        };
                        delay(retry_after).await;
                    }
                }
            }
        }
    });
}

fn restart_read_flush_after_disconnect(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
    advance: ReadAdvance,
) {
    let restart = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        queue_read_advance(&mut running.pending_reads, advance);
        running.flushing_reads = false;
        start_read_flush(running)
    };
    if let Some((client, instance)) = restart {
        spawn_read_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
}

fn permanent_mark_read_error(error: &papo::Error) -> bool {
    match error {
        papo::Error::InvalidInput(_) | papo::Error::Unsupported(_) | papo::Error::TargetGone => {
            true
        }
        papo::Error::Server(error) => !matches!(
            error.refusal(),
            papo::Refusal::InternalError
                | papo::Refusal::RateLimited
                | papo::Refusal::TemporarilyUnavailable
                | papo::Refusal::TryAgain
        ),
        _ => false,
    }
}

fn report_mark_read_failure(outbound: &mpsc::UnboundedSender<EngineToUi>, error: &papo::Error) {
    engine_log(&format!(
        "{}: {error}",
        EngineMessageKey::MarkReadFailed.as_str()
    ));
    let _ = outbound.send(EngineToUi::Diagnostic {
        command_id: MARK_READ_DIAGNOSTIC_ID.into(),
        message: EngineMessageKey::MarkReadFailed.as_str().into(),
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

/// A socket that went dead while the device slept still looks live until papo notices. papo ends
/// one that stays silent past the deadline and redials it at once, and that disconnect brings the
/// usual recovery.
async fn answers_probe(client: &papo::Client) -> bool {
    client
        .check_connection(FOREGROUND_PROBE_TIMEOUT)
        .await
        .is_ok()
}

/// papo leaves a live connection alone, so a retry that finds one resumes it instead: no
/// `Connected` event will come to bring the network back online and flush what waited for it.
async fn reconnect(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
) -> Result<(), papo::Error> {
    match client.reconnect().await {
        Err(papo::Error::AlreadyConnected) => {
            if answers_probe(client).await {
                resume_live_connection(state, outbound, instance);
            }
            Ok(())
        }
        result => result,
    }
}

fn resume_live_connection(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
) {
    let mut guard = lock(state);
    let Some(running) = guard
        .network
        .as_mut()
        .filter(|running| running.instance == instance && running.device_online)
    else {
        return;
    };
    if !running.client.snapshot().is_connected() {
        return;
    }
    let mut output = Vec::new();
    if *running.model.connection() != NetworkConnectionState::Online {
        output.push(
            running
                .model
                .set_connection(NetworkConnectionState::Online, None),
        );
    }
    let flush_sends = !running.pending_sends.is_empty() && !running.flushing_sends;
    running.flushing_sends |= flush_sends;
    let read_flush = start_read_flush(running);
    let client = running.client.clone();
    drop(guard);
    send_events(outbound, output);
    spawn_event_flushes(state, outbound, &client, instance, flush_sends, read_flush);
}

/// A DM peer's account is trusted only as far as the connection that reported it.
fn endpoint_is_tls(endpoint: &str) -> bool {
    endpoint.parse::<papo::Endpoint>().is_ok_and(|endpoint| {
        matches!(
            endpoint.kind(),
            papo::EndpointKind::Tls | papo::EndpointKind::SecureWebSocket
        )
    })
}

/// The cached chat list names its conversations before the server sends its name rules, so
/// papo's default rules build those names until the server's own rules rebuild them.
fn client_builder(endpoint: &str, nickname: &str, autojoin: Vec<String>) -> papo::Builder {
    let builder = crate::client_builder(endpoint, nickname)
        .casemapping(papo::Casemapping::default())
        .reconnect(
            papo::Reconnect::exponential()
                .max_delay(Duration::from_secs(30))
                .refused_delay(Duration::from_secs(30)),
        );
    if autojoin.is_empty() {
        builder
    } else {
        builder.autojoin(autojoin)
    }
}

fn build_client(config: ConnectConfig) -> (papo::Client, papo::Events, papo::Driver) {
    let sasl = config.authentication.into_sasl();
    client_builder(&config.endpoint, &config.nickname, config.autojoin)
        .sasl(sasl)
        .allow_insecure_auth(config.allow_insecure)
        .build()
}

fn build_pending_hosted_client(
    endpoint: &str,
    nickname: &str,
    autojoin: Vec<String>,
) -> (papo::Client, papo::Events, papo::Driver) {
    client_builder(endpoint, nickname, autojoin).build()
}

fn hosted_connect_config(
    label: String,
    endpoint: String,
    nickname: String,
    oauth_token: crate::RedactedSecret,
    autojoin: Vec<String>,
) -> ConnectConfig {
    ConnectConfig {
        label,
        endpoint,
        nickname,
        authentication: ConnectionAuthentication::HostedOAuth {
            token: papo::Secret::new(oauth_token.into_inner()),
        },
        autojoin,
        allow_insecure: false,
    }
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

impl ConnectConfig {
    fn identity(&self) -> ConnectionIdentity {
        let credential = match &self.authentication {
            ConnectionAuthentication::SaslPlain { account, password } => UploadCredential::Basic {
                account: account.clone(),
                password: password.clone(),
            },
            ConnectionAuthentication::HostedOAuth { .. } => UploadCredential::HostBearer,
        };
        ConnectionIdentity {
            endpoint: self.endpoint.clone(),
            credential,
        }
    }
}

impl ConnectionAuthentication {
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

impl ConnectionIdentity {
    const fn kind(&self) -> AuthenticationKind {
        match self.credential {
            UploadCredential::Basic { .. } => AuthenticationKind::SaslPlain,
            UploadCredential::HostBearer => AuthenticationKind::HostedOAuth,
        }
    }
}

#[derive(Debug)]
enum SendError {
    Protocol,
    DirectTargetGone,
    PeerPinMismatch(PinMismatch, PeerPin),
    Offline,
    Interrupted,
}

impl SendError {
    const fn message_key(&self) -> EngineMessageKey {
        match self {
            Self::Protocol | Self::Offline | Self::Interrupted => EngineMessageKey::SendFailed,
            Self::DirectTargetGone => EngineMessageKey::DirectTargetGone,
            Self::PeerPinMismatch(..) => EngineMessageKey::DirectIdentityMismatch,
        }
    }
}

async fn send(
    client: &papo::Client,
    pending: &PendingSend,
) -> Result<papo::SendOutcome, SendError> {
    if let SendTarget::Direct { nick, pin, tls } = &pending.target {
        check_direct_recipient(client, nick, pin.as_ref(), *tls)?;
    }
    if let Some(reply) = &pending.reply {
        let parent = reply
            .saved
            .restore(client)
            .map_err(|error| classify_send_error(&error))?;
        return client
            .reply(parent, pending.text.clone())
            .await
            .map_err(|error| classify_send_error(&error));
    }
    let action = pending.kind == crate::MessageKind::Action;
    match pending.target.clone() {
        SendTarget::Channel(channel) => if action {
            client.action(channel, pending.text.clone()).await
        } else {
            client.privmsg(channel, pending.text.clone()).await
        }
        .map_err(|error| classify_send_error(&error)),
        SendTarget::Direct { nick, .. } => if action {
            client.action(nick, pending.text.clone()).await
        } else {
            client.privmsg(nick, pending.text.clone()).await
        }
        .map_err(|error| classify_send_error(&error)),
    }
}

/// A line to a DM peer goes to whoever holds the nick, so it waits until that holder is the
/// pinned peer as far as papo can tell.
fn check_direct_recipient(
    client: &papo::Client,
    nick: &papo::Nick,
    pin: Option<&PeerPin>,
    tls: bool,
) -> Result<(), SendError> {
    let Some(pin) = pin else {
        return Ok(());
    };
    let state = client.snapshot();
    pin.check_recipient(&state, nick, tls)
        .map_err(|reason| SendError::PeerPinMismatch(reason, PeerPin::of_holder(&state, nick, tls)))
}

/// Papo resolves a reaction after its labeled echo only when echoes are negotiated.
fn can_react(state: &papo::State) -> bool {
    [
        papo::Feature::Reactions,
        papo::Feature::EchoMessages,
        papo::Feature::LabeledResponse,
    ]
    .into_iter()
    .all(|feature| state.supports(feature))
}

/// Offline connections offer no change, since none could be confirmed.
fn project_own_change_actions(model: &mut NetworkModel, online: Option<&papo::State>) {
    model.set_own_change_actions(
        online.is_some_and(can_react),
        online.is_some_and(|state| state.supports(papo::Feature::Replies)),
        online.is_some_and(can_redact),
    );
}

/// Papo matches a history reply to its request through a labeled batch, and refuses the request
/// up front on a server that can't label or batch one.
fn can_fetch_history(state: &papo::State) -> bool {
    [
        papo::Feature::History,
        papo::Feature::LabeledResponse,
        papo::Feature::Batches,
    ]
    .into_iter()
    .all(|feature| state.supports(feature))
}

/// Papo reads and moves a read marker only through a labeled response.
fn can_sync_read_markers(state: &papo::State) -> bool {
    state.supports(papo::Feature::ReadMarkers) && state.supports(papo::Feature::LabeledResponse)
}

/// Papo resolves a redaction only after its labeled response.
fn can_redact(state: &papo::State) -> bool {
    state.supports(papo::Feature::Redaction) && state.supports(papo::Feature::LabeledResponse)
}

/// Restores a row's saved reference once its DM peer, if any, is still the pinned one.
fn message_reference(
    client: &papo::Client,
    target: &SendTarget,
    saved: &SavedMessage,
) -> Result<papo::MessageRef, SendError> {
    if let SendTarget::Direct { nick, pin, tls } = target {
        check_direct_recipient(client, nick, pin.as_ref(), *tls)?;
    }
    saved
        .restore(client)
        .map_err(|error| classify_send_error(&error))
}

async fn send_redaction(client: &papo::Client, redaction: &OwnRedaction) -> Result<(), SendError> {
    let message = message_reference(client, &redaction.target, &redaction.saved)?;
    client
        .redact(message, "")
        .await
        .map(|_| ())
        .map_err(|error| classify_send_error(&error))
}

async fn send_reaction(client: &papo::Client, change: &OwnReactionChange) -> Result<(), SendError> {
    let target = change.target.as_ref().ok_or(SendError::DirectTargetGone)?;
    let message = message_reference(client, target, &change.saved)?;
    let text = change.text.clone();
    match change.action {
        ReactionAction::Added => client.react(message, text).await,
        ReactionAction::Removed => client.unreact(message, text).await,
    }
    .map(|_| ())
    .map_err(|error| classify_send_error(&error))
}

fn spawn_typing(client: papo::Client, target: SendTarget, typing: papo::Typing) {
    spawn_task(async move {
        send_typing(&client, target, typing).await;
    });
}

async fn send_typing(client: &papo::Client, target: SendTarget, typing: papo::Typing) {
    match target {
        SendTarget::Channel(channel) => {
            _ = client.set_typing(channel, typing).await;
        }
        SendTarget::Direct { nick, .. } => {
            _ = client.set_typing(nick, typing).await;
        }
    }
}

fn spawn_typing_pause(state: Arc<Mutex<RuntimeState>>, instance: u64, pause: crate::typing::Pause) {
    spawn_task(async move {
        delay(crate::typing::PAUSE_AFTER).await;
        let command = {
            let mut state = lock(&state);
            let Some(running) = state
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            else {
                return;
            };
            let typing = running.typing.expire_scheduled(pause);
            typing.map(|typing| {
                (
                    running.client.clone(),
                    running.model.send_target(pause.buffer_id),
                    typing,
                )
            })
        };
        if let Some((client, Some(target), typing)) = command {
            send_typing(&client, target, typing).await;
        }
    });
}

fn classify_send_error(error: &papo::Error) -> SendError {
    match error {
        papo::Error::Disconnected(_) => SendError::Offline,
        papo::Error::Interrupted(_) => SendError::Interrupted,
        papo::Error::TargetGone => SendError::DirectTargetGone,
        papo::Error::Server(refused) if refused.refusal() == papo::Refusal::NoSuchNick => {
            SendError::DirectTargetGone
        }

        _ => SendError::Protocol,
    }
}

fn spawn_send_flush(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
) {
    spawn_task(async move {
        flush_pending_sends(&state, &outbound, &client, instance).await;
    });
}

async fn flush_pending_sends(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
) {
    loop {
        let queued = match take_next_send_turn(state, instance) {
            FlushNext::Send(queued) => queued,
            FlushNext::Fail(events) => {
                send_events(outbound, events);
                continue;
            }
            FlushNext::Stop => return,
        };
        let (cancel, cancel_requested) = oneshot::channel();
        let (settled, settled_confirmation) = oneshot::channel();
        let _settled_guard = SendAttemptGuard(Some(settled));
        {
            let mut state = lock(state);
            let Some(running) = state
                .network
                .as_ref()
                .filter(|running| running.instance == instance)
            else {
                return;
            };
            if !running.flushing_sends {
                return;
            }
            state.inflight_send_cancel = Some(InflightSendCancel {
                instance,
                cancel,
                settled: settled_confirmation,
            });
        }
        let result = tokio::select! {
            result = send(client, &queued.pending) => result,
            _ = cancel_requested => Err(SendError::Interrupted),
        };
        let mut retry_now = false;
        let (events, own_read_advance) = {
            let mut state = lock(state);
            if state
                .inflight_send_cancel
                .as_ref()
                .is_some_and(|current| current.instance == instance)
            {
                state.inflight_send_cancel = None;
            }
            let Some(running) = state
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            else {
                return;
            };
            let (events, advance) = match result {
                Ok(sent) => confirm_send_with_read(&mut running.model, &queued.pending, &sent),
                Err(SendError::Offline) if queued.retry_if_disconnected => {
                    running.pending_sends.push_front(queued);
                    retry_now = running.device_online
                        && running.model.is_online()
                        && client.snapshot().is_connected();
                    if !retry_now {
                        running.flushing_sends = false;
                        return;
                    }
                    (None, None)
                }
                Err(SendError::Interrupted) => {
                    (Some(running.model.interrupt_send(&queued.pending)), None)
                }
                Err(error) => (
                    Some(
                        running
                            .model
                            .fail_send(&queued.pending, error.message_key()),
                    ),
                    None,
                ),
            };
            let events = finish_timeline_turn(state, events.unwrap_or_default());
            ((!events.is_empty()).then_some(events), advance)
        };
        if retry_now {
            continue;
        }
        send_optional_events(outbound, events);
        if let Some(advance) = own_read_advance {
            record_read_advances_and_flush(state, outbound.clone(), instance, vec![advance]);
        }
    }
}

fn take_next_send_turn(state: &Arc<Mutex<RuntimeState>>, instance: u64) -> FlushNext {
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return FlushNext::Stop;
    };
    match take_next_send(running) {
        FlushNext::Fail(events) => FlushNext::Fail(finish_timeline_turn(state, events)),
        next => next,
    }
}

struct SendAttemptGuard(Option<oneshot::Sender<()>>);

impl Drop for SendAttemptGuard {
    fn drop(&mut self) {
        if let Some(settled) = self.0.take() {
            _ = settled.send(());
        }
    }
}

async fn cancel_inflight_send(state: &Arc<Mutex<RuntimeState>>, instance: u64) {
    let cancel = {
        let mut state = lock(state);
        match state.inflight_send_cancel.take() {
            Some(current) if current.instance == instance => {
                Some((current.cancel, current.settled))
            }
            Some(other) => {
                state.inflight_send_cancel = Some(other);
                None
            }
            None => None,
        }
    };
    if let Some((cancel, settled)) = cancel {
        _ = cancel.send(());
        _ = settled.await;
    }
}

fn take_next_send(running: &mut RunningNetwork) -> FlushNext {
    if !running.device_online {
        running.flushing_sends = false;
        return FlushNext::Stop;
    }
    let Some(queued) = running.pending_sends.front_mut() else {
        running.flushing_sends = false;
        return FlushNext::Stop;
    };
    if !queued.await_live_target {
        return pop_send(running);
    }
    match running.model.prepare_live_send(&mut queued.pending) {
        PendingTargetState::Waiting => {
            running.flushing_sends = false;
            FlushNext::Stop
        }
        PendingTargetState::Ready => {
            queued.await_live_target = false;
            pop_send(running)
        }
        PendingTargetState::Gone => match running.pending_sends.pop_front() {
            Some(queued) => {
                let mut events = running
                    .model
                    .fail_send(&queued.pending, EngineMessageKey::CachedTargetGone);
                events.push(EngineToUi::notice(EngineMessageKey::CachedTargetGone));
                FlushNext::Fail(events)
            }
            None => stop_send_flush(running),
        },
    }
}

fn pop_send(running: &mut RunningNetwork) -> FlushNext {
    match running.pending_sends.pop_front() {
        Some(queued) => FlushNext::Send(queued),
        None => stop_send_flush(running),
    }
}

fn stop_send_flush(running: &mut RunningNetwork) -> FlushNext {
    running.flushing_sends = false;
    FlushNext::Stop
}

async fn finish_send(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    pending: &PendingSend,
) {
    let result = send(client, pending).await;
    let (events, own_read_advance) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let (events, advance) = match result {
            Ok(sent) => confirm_send_with_read(&mut running.model, pending, &sent),
            Err(SendError::PeerPinMismatch(reason, current)) => {
                let mut events = running
                    .model
                    .record_direct_mismatch(pending.buffer_id, reason, current)
                    .into_iter()
                    .collect::<Vec<_>>();
                events.extend(
                    running
                        .model
                        .fail_send(pending, EngineMessageKey::DirectIdentityMismatch),
                );
                (Some(events), None)
            }
            Err(error) => (
                Some(running.model.fail_send(pending, error.message_key())),
                None,
            ),
        };
        let events = finish_timeline_turn(state, events.unwrap_or_default());
        ((!events.is_empty()).then_some(events), advance)
    };
    send_optional_events(outbound, events);
    if let Some(advance) = own_read_advance {
        record_read_advances_and_flush(state, outbound.clone(), instance, vec![advance]);
    }
}

fn confirm_send_with_read(
    model: &mut NetworkModel,
    pending: &PendingSend,
    sent: &papo::SendOutcome,
) -> (Option<Vec<EngineToUi>>, Option<ReadAdvance>) {
    let message_id = model.pending_message_id(pending);
    let events = model.confirm_send(pending, sent);
    let advance = message_id.and_then(|id| model.prepare_mark_read(pending.buffer_id, id));
    (events, advance)
}

fn finish_timeline_turn(
    mut state: MutexGuard<'_, RuntimeState>,
    mut events: Vec<EngineToUi>,
) -> Vec<EngineToUi> {
    if let Some(running) = state.network.as_mut() {
        events.extend(running.model.take_timeline_changes(false));
    }
    events
}

fn send_optional_events(
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    events: Option<Vec<EngineToUi>>,
) {
    for event in events.into_iter().flatten() {
        let _ = outbound.send(event);
    }
}

fn receive_chat(
    model: &mut NetworkModel,
    input: ChatInput<'_>,
    history: bool,
    state: &papo::State,
    direct: Option<DirectPeer>,
) -> (Vec<EngineToUi>, Vec<ReadAdvance>) {
    model.receive_chat_with_advance(input, history, state, direct)
}

fn completion_context(
    input: &str,
    cursor: u32,
    explicit: bool,
    chantypes: &str,
    registry: &commands::CommandRegistry,
) -> Option<CompletionContext> {
    let before = input.get(..byte_offset(input, cursor))?;
    let position = commands::CommandPosition::locate(before, chantypes, registry);
    let usage = position.as_ref().and_then(commands::CommandPosition::usage);
    match trigger_context(before, explicit, chantypes, position.as_ref()) {
        Some(context) => Some(CompletionContext { usage, ..context }),
        None => usage.map(|usage| CompletionContext::usage_only(utf16_len(before), usage)),
    }
}

fn trigger_context(
    before: &str,
    explicit: bool,
    chantypes: &str,
    position: Option<&commands::CommandPosition<'_>>,
) -> Option<CompletionContext> {
    if !explicit && let Some(context) = terminated_mention_context(before) {
        return Some(context);
    }
    let replace_end = utf16_len(before);
    let word_start = word_start(before);
    let word = before.get(word_start..)?;
    if before.starts_with('/') && !before.contains(char::is_whitespace) {
        return Some(CompletionContext {
            trigger: Some(CompletionTrigger::Command),
            replace_start: 0,
            replace_end,
            prefix: word.trim_start_matches('/').to_owned(),
            usage: None,
            replacement_prefix: "/".into(),
            replacement_suffix: " ".into(),
            auto_accept: false,
        });
    }
    if let Some(context) = position
        .and_then(|position| command_argument_context(position, before, word_start, replace_end))
    {
        return Some(context);
    }
    let (trigger, prefix, replacement_suffix) = match word.chars().next() {
        Some('@') => (
            CompletionTrigger::Person,
            word.get(1..)?.to_owned(),
            mention_suffix(word_start),
        ),
        Some(first) if chantypes.contains(first) => {
            (CompletionTrigger::Channel, word.to_owned(), "")
        }
        _ if explicit => (
            CompletionTrigger::Person,
            word.to_owned(),
            mention_suffix(word_start),
        ),
        _ => return None,
    };
    Some(CompletionContext {
        trigger: Some(trigger),
        replace_start: utf16_len(before.get(..word_start)?),
        replace_end,
        prefix,
        usage: None,
        replacement_prefix: String::new(),
        replacement_suffix: replacement_suffix.into(),
        auto_accept: false,
    })
}

fn word_start(before: &str) -> usize {
    before.rfind(char::is_whitespace).map_or(0, |index| {
        index + before[index..].chars().next().map_or(0, char::len_utf8)
    })
}

fn mention_suffix(word_start: usize) -> &'static str {
    if word_start == 0 { ": " } else { "" }
}

const TYPED_MENTION_PUNCTUATION: [char; 7] = [',', ':', ';', '.', '!', '?', ')'];

fn ends_typed_mention(character: char) -> bool {
    character.is_whitespace() || TYPED_MENTION_PUNCTUATION.contains(&character)
}

fn terminated_mention_context(before: &str) -> Option<CompletionContext> {
    let terminator = before
        .chars()
        .next_back()
        .filter(|character| ends_typed_mention(*character))?;
    let mention = before.get(..before.len() - terminator.len_utf8())?;
    let start = word_start(mention);
    let nick = mention
        .get(start..)?
        .strip_prefix('@')
        .filter(|nick| !nick.is_empty())?;
    let replacement_suffix = if terminator.is_whitespace() {
        format!("{}{terminator}", mention_suffix(start).trim_end())
    } else {
        terminator.to_string()
    };
    Some(CompletionContext {
        trigger: Some(CompletionTrigger::Person),
        replace_start: utf16_len(mention.get(..start)?),
        replace_end: utf16_len(before),
        prefix: nick.to_owned(),
        usage: None,
        replacement_prefix: String::new(),
        replacement_suffix,
        auto_accept: true,
    })
}

/// After a listed nick, Enter submits the list instead of picking yet another member.
fn nick_list_started(before_word: &str) -> bool {
    before_word.split_whitespace().nth(1).is_some()
}

fn command_argument_context(
    position: &commands::CommandPosition<'_>,
    before: &str,
    word_start: usize,
    replace_end: u32,
) -> Option<CompletionContext> {
    let word = before.get(word_start..)?;
    let (trigger, prefix) = match position.current_argument()?.kind {
        commands::CommandArgumentKind::Channel | commands::CommandArgumentKind::ChannelList => {
            (CompletionTrigger::Channel, word.to_owned())
        }
        commands::CommandArgumentKind::NickList
            if word.is_empty() && nick_list_started(before.get(..word_start)?) =>
        {
            return None;
        }
        commands::CommandArgumentKind::Nick
        | commands::CommandArgumentKind::NickList
        | commands::CommandArgumentKind::Target => (
            CompletionTrigger::Person,
            word.strip_prefix('@').unwrap_or(word).to_owned(),
        ),
        _ => return None,
    };
    Some(CompletionContext {
        trigger: Some(trigger),
        replace_start: utf16_len(before.get(..word_start)?),
        replace_end,
        prefix,
        usage: None,
        replacement_prefix: String::new(),
        replacement_suffix: " ".into(),
        auto_accept: false,
    })
}

fn command_candidates(
    prefix: &str,
    model: &NetworkModel,
    state: &papo::State,
) -> Vec<CompletionCandidate> {
    let slash = commands::registry()
        .specs()
        .iter()
        .filter(|spec| spec.surfaces.contains(&commands::CommandSurface::Slash));
    if slash
        .clone()
        .any(|spec| spec.name.eq_ignore_ascii_case(prefix))
    {
        return Vec::new();
    }
    let mut specs = slash
        .filter(|spec| {
            spec.name
                .get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        })
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
            commands::CommandRequirement::Feature(name) => {
                papo::Feature::from_name(name).is_some_and(|feature| state.supports(feature))
            }
        })
}

#[derive(Clone, Copy)]
enum NickMatch {
    Prefix,
    Exact,
}

impl NickMatch {
    fn accepts(self, folded_nick: &str, folded_typed: &str) -> bool {
        match self {
            Self::Prefix => folded_nick.starts_with(folded_typed),
            Self::Exact => folded_nick == folded_typed,
        }
    }
}

fn person_candidates(
    model: &NetworkModel,
    buffer_id: BufferId,
    prefix: &str,
    nick_match: NickMatch,
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
    let casemapping = crate::name_key::casemapping(state);
    let folded_prefix = casemapping.fold(prefix);
    nicks.extend(
        members
            .iter()
            .filter(|member| casemapping.fold(&member.nick).starts_with(&*folded_prefix))
            .map(|member| member.nick.clone()),
    );
    let mut seen = std::collections::HashSet::new();
    nicks
        .into_iter()
        .filter(|nick| nick_match.accepts(&casemapping.fold(nick), &folded_prefix))
        .filter(|nick| !is_own_nick(state, nick))
        .filter(|nick| seen.insert(casemapping.fold(nick).into_owned()))
        .take(COMPLETION_LIMIT)
        .map(|nick| {
            let member = members
                .iter()
                .find(|member| casemapping.fold(&member.nick) == casemapping.fold(&nick));
            let user = crate::name_key::known_user(state, nick.as_str());
            CompletionCandidate::Person {
                nick_color_index: crate::state::nick_color_index(casemapping, &nick),
                away: member.map_or_else(
                    || {
                        user.is_some_and(|user| {
                            matches!(user.away(), papo::AwayStatus::Away { .. })
                        })
                    },
                    |member| member.away,
                ),
                bot: member.map_or_else(|| user.and_then(papo::User::is_bot), |member| member.bot),
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
    let casemapping = crate::name_key::casemapping(state);
    let folded_prefix = casemapping.fold(prefix);
    let mut names = model.channel_names();
    names.sort_by_key(|name| {
        let joined = state
            .channel(name.as_str())
            .is_ok_and(|joined| joined.is_some());
        (!joined, casemapping.fold(name).into_owned())
    });
    names
        .into_iter()
        .filter(|name| casemapping.fold(name).starts_with(&*folded_prefix))
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

/// A read marker's time, which the model compares on the device clock's scale.
fn read_marker_time(marker: papo::ReadMarker) -> Option<SystemTime> {
    match marker {
        papo::ReadMarker::ReadUntil(time) => Some(time.to_system_time()),
        _ => None,
    }
}

/// A line sent only to a channel's ops is shown among the channel's lines, like every other line
/// of that channel.
fn unrestricted(event: papo::Event) -> papo::Event {
    use papo::Event;
    use papo::event::{Restricted, RestrictedLine as Line};
    match event {
        Event::Restricted(Restricted {
            line: Line::Message(line),
            ..
        }) => Event::Message(line),
        Event::Restricted(Restricted {
            line: Line::Notice(line),
            ..
        }) => Event::Notice(line),
        Event::Restricted(Restricted {
            line: Line::Incomplete(line),
            ..
        }) => Event::Incomplete(line),
        Event::Restricted(Restricted {
            line: Line::ServerNotice(line),
            ..
        }) => Event::ServerNotice(line),
        Event::Restricted(Restricted {
            line: Line::CtcpQuery(line),
            ..
        }) => Event::CtcpQuery(line),
        Event::Restricted(Restricted {
            line: Line::CtcpReply(line),
            ..
        }) => Event::CtcpReply(line),
        Event::Restricted(Restricted {
            line: Line::TagMsg(line),
            ..
        }) => Event::TagMsg(line),
        Event::Restricted(Restricted {
            line: Line::Reacted(line),
            ..
        }) => Event::Reacted(line),
        Event::Restricted(Restricted {
            line: Line::Redacted(line),
            ..
        }) => Event::Redacted(line),
        Event::Restricted(Restricted {
            line: Line::TypingChanged(line),
            ..
        }) => Event::TypingChanged(line),
        Event::Restricted(Restricted {
            line: Line::Other(line),
            ..
        }) => Event::Other(line),
        event => event,
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
    while let Some((event, event_state)) = events.next().await {
        let event = unrestricted(event);
        if let papo::Event::History(page) = event {
            process_history(&state, &outbound, &client, instance, page);
            continue;
        }
        let restore_directs = matches!(event, papo::Event::Connected(_));
        let online_direct = match &event {
            papo::Event::MonitorOnline(online) => Some(online.subject.nick()),
            _ => None,
        };
        let direct_resolution = event_direct_resolution(&event);
        let schedule_members = lock(&member_changes).record(&event, &event_state);
        let history_fetches =
            process_event_at(&state, &outbound, &client, instance, event, &event_state);
        if let Some(nick) = direct_resolution {
            spawn_direct_resolution(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
                &nick,
            );
        }
        if let Some(nick) = online_direct {
            spawn_online_direct_resolution(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
                nick,
            );
        }
        for fetch in history_fetches {
            let marker_nick = direct_history_target(&fetch)
                .filter(|nick| {
                    lock(&state)
                        .network
                        .as_ref()
                        .filter(|running| running.instance == instance)
                        .is_some_and(|running| running.model.direct_with_stubs_needs_marker(nick))
                })
                .cloned();
            spawn_history_fetch(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
                fetch,
                marker_nick,
            );
        }
        if restore_directs {
            spawn_target_reconciliation(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                instance,
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
    process_event_stream_end(&state, &outbound, instance);
}

/// papo ends the event stream without a `Disconnected` event when its driver stops, so the
/// connection this instance still shows is over and nothing will reconnect it.
fn process_event_stream_end(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
) {
    let mut guard = lock(state);
    let Some(running) = guard
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return;
    };
    let mut output = Vec::new();
    release_connection(running, &mut output);
    if !matches!(
        running.model.connection(),
        NetworkConnectionState::Offline { .. } | NetworkConnectionState::Failed { .. }
    ) {
        output.push(running.model.set_connection(
            NetworkConnectionState::Failed {
                reason: ConnectionFailureReason::Protocol,
                message_key: EngineMessageKey::ConnectionFailed,
            },
            None,
        ));
        output.push(EngineToUi::notice(EngineMessageKey::ConnectionFailed));
    }
    let output = finish_timeline_turn(guard, output);
    send_events(outbound, output);
    update_chat_list(state, outbound, instance);
}

/// The peer of a private line someone else sent, whose DM can now reach them.
fn event_direct_resolution(event: &papo::Event) -> Option<papo::Nick> {
    match event {
        papo::Event::Message(message)
            if message.actor_party != papo::Party::Me
                && matches!(message.conversation(), papo::Conversation::Private(_)) =>
        {
            Some(message.actor.nick())
        }
        papo::Event::Notice(notice)
            if notice.actor_party != papo::Party::Me
                && matches!(notice.conversation(), papo::Conversation::Private(_)) =>
        {
            Some(notice.actor.nick())
        }
        _ => None,
    }
}

fn spawn_online_direct_resolution(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    nick: papo::Nick,
) {
    let resolution = lock(&state)
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
        .and_then(|running| running.model.begin_online_direct_resolution(&nick));
    let Some((buffer_id, previous)) = resolution else {
        return;
    };
    spawn_task(async move {
        let direct = DirectPeer::resolve(&client, &nick);
        drop(previous);
        apply_direct_resolution(&state, &outbound, instance, buffer_id, direct);
    });
}

fn spawn_cached_direct_resolution(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    buffer_id: BufferId,
    nick: papo::Nick,
) {
    spawn_task(async move {
        let direct = DirectPeer::resolve(&client, &nick);
        apply_direct_resolution(&state, &outbound, instance, buffer_id, direct);
    });
}

fn spawn_direct_resolution(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    nick: &papo::Nick,
) {
    let buffer_id = lock(&state)
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
        .and_then(|running| running.model.begin_direct_resolution(nick));
    let Some(buffer_id) = buffer_id else {
        return;
    };
    let nick = nick.clone();
    spawn_task(async move {
        let availability = DirectAvailability::Guarded(DirectPeer::resolve(&client, &nick));
        let mut state = lock(&state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let presence = resolve_direct(running, buffer_id, availability);
        drop(state);
        send_events(&outbound, presence);
    });
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
    let snapshot = client.snapshot();
    let buffers = channels
        .into_iter()
        .filter_map(|channel| {
            let buffer_id = running.model.buffer_id_for_channel(&channel)?;
            let total = crate::name_key::known_channel(&snapshot, &channel)
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

fn direct_history_target(fetch: &HistoryFetch) -> Option<&papo::Nick> {
    match fetch {
        HistoryFetch::Latest(HistoryTarget::Direct(nick))
        | HistoryFetch::After {
            target: HistoryTarget::Direct(nick),
            ..
        } => Some(nick),
        HistoryFetch::Latest(HistoryTarget::Channel(_))
        | HistoryFetch::Before { .. }
        | HistoryFetch::After {
            target: HistoryTarget::Channel(_),
            ..
        } => None,
    }
}

fn spawn_history_fetch(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    fetch: HistoryFetch,
    marker_nick: Option<papo::Nick>,
) {
    spawn_task(async move {
        if let Some(nick) = marker_nick {
            fetch_and_apply_read_marker(
                &state,
                &outbound,
                &client,
                instance,
                HistoryTarget::Direct(nick),
            )
            .await;
        }
        fetch_history_page(&state, &outbound, &client, instance, fetch).await;
    });
}

fn spawn_history_page(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    fetch: HistoryFetch,
) {
    spawn_task(async move {
        fetch_history_page(&state, &outbound, &client, instance, fetch).await;
    });
}

async fn fetch_history_page(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    fetch: HistoryFetch,
) {
    if let Ok(page) = fetch_history(client, fetch.clone()).await {
        process_history(state, outbound, client, instance, page);
        return;
    }
    let (buffer_id, retry, timeline, history_failed) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let gap_buffer_id = running.model.fail_pending_history_gaps(&fetch);
        let history_buffer_id = running.model.fail_history(&fetch);
        let buffer_id = history_buffer_id.or(gap_buffer_id);
        let retry = history_buffer_id.and_then(|id| running.model.retry_pushed_history(id));
        let timeline = running.model.take_timeline_changes(false);
        (buffer_id, retry, timeline, history_buffer_id.is_some())
    };
    if let Some(buffer_id) = buffer_id {
        let sync = lock(state)
            .network
            .as_ref()
            .filter(|running| running.instance == instance)
            .and_then(|running| running.model.buffer_updated(buffer_id));
        let mut events = sync.into_iter().collect::<Vec<_>>();
        if history_failed {
            events.push(EngineToUi::HistoryStateChanged {
                buffer_id,
                loading: retry.is_some(),
                at_start: false,
            });
        }
        events.extend(timeline);
        send_events(outbound, events);
    } else {
        send_events(outbound, timeline);
    }
    if let Some(retry) = retry {
        spawn_history_fetch(
            Arc::clone(state),
            outbound.clone(),
            client.clone(),
            instance,
            retry,
            None,
        );
    }
}

fn spawn_read_marker_fetch(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    target: HistoryTarget,
) {
    if !can_sync_read_markers(&client.snapshot()) {
        return;
    }
    spawn_task(async move {
        fetch_and_apply_read_marker(&state, &outbound, &client, instance, target).await;
    });
}

async fn fetch_and_apply_read_marker(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    target: HistoryTarget,
) {
    if !can_sync_read_markers(&client.snapshot()) {
        return;
    }
    let read_until = match target.clone() {
        HistoryTarget::Channel(channel) => client.fetch_read_marker(channel).await,
        HistoryTarget::Direct(nick) => client.fetch_read_marker(nick).await,
    };
    let Ok(read_until) = read_until else {
        return;
    };
    let (events, read_flush) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let (mut events, advance) = running.model.apply_server_read_marker_with_advance(
            &target.name_key(),
            read_marker_time(read_until),
        );
        events.extend(record_read_advances(running, advance));
        (events, start_read_flush(running))
    };
    send_events(outbound, events);
    if let Some((client, instance)) = read_flush {
        spawn_read_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
    update_chat_list(state, outbound, instance);
}

async fn fetch_history(
    client: &papo::Client,
    fetch: HistoryFetch,
) -> Result<papo::event::HistoryPage, papo::Error> {
    match fetch {
        HistoryFetch::Latest(HistoryTarget::Channel(channel)) => {
            client
                .history(channel)
                .latest()
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        HistoryFetch::Latest(HistoryTarget::Direct(nick)) => {
            client.history(nick).latest().limit(HISTORY_PAGE_SIZE).await
        }
        HistoryFetch::Before {
            target: HistoryTarget::Channel(channel),
            oldest,
        } => {
            client
                .history(channel)
                .before(oldest)
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        HistoryFetch::Before {
            target: HistoryTarget::Direct(nick),
            oldest,
        } => {
            client
                .history(nick)
                .before(oldest)
                .limit(HISTORY_PAGE_SIZE)
                .await
        }
        HistoryFetch::After {
            target: HistoryTarget::Channel(channel),
            newest,
        } => {
            match newest.reference() {
                Some(newest) => client.history(channel).latest_after(newest),
                None => client.history(channel).latest(),
            }
            .limit(HISTORY_PAGE_SIZE)
            .await
        }
        HistoryFetch::After {
            target: HistoryTarget::Direct(nick),
            newest,
        } => {
            match newest.reference() {
                Some(newest) => client.history(nick).latest_after(newest),
                None => client.history(nick).latest(),
            }
            .limit(HISTORY_PAGE_SIZE)
            .await
        }
    }
}

fn spawn_target_reconciliation(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
) {
    spawn_task(async move {
        let Some(network_id) = running_network_id(&state, instance) else {
            return;
        };
        let until = papo::time::now();
        let since = lock(&state)
            .network
            .as_ref()
            .filter(|running| running.instance == instance)
            .and_then(|running| running.model.cursor())
            .unwrap_or_else(|| {
                until
                    .checked_sub(RECENT_DIRECT_WINDOW)
                    .unwrap_or(SystemTime::UNIX_EPOCH)
            });
        let recent = match (
            server_time(since),
            server_time(until + TARGETS_LATE_ACTIVITY),
        ) {
            (Some(since), Some(until)) => client.recent_conversations(since, until).await.ok(),
            _ => None,
        };
        if let Some(recent) = recent {
            let complete = recent.len() < RECENT_TARGET_LIMIT;
            let recent = recent
                .into_iter()
                .filter_map(|recent| {
                    Some((
                        NameKey::from_conversation(&recent.conversation)?,
                        recent.latest_server_time.to_system_time(),
                    ))
                })
                .collect();
            restore_target_rows(
                &state, &outbound, &client, instance, recent, complete, until,
            );
        } else {
            fallback_target_reconciliation(&state, &outbound, &client, instance, network_id);
        }
        monitor_shown_direct_peers(&state, &client, instance);
    });
}

/// Presence for a DM peer who shares no channel only arrives through `MONITOR`, so the peers of
/// the shown DMs go out in one batch once the launch's history requests are queued.
fn monitor_shown_direct_peers(
    state: &Arc<Mutex<RuntimeState>>,
    client: &papo::Client,
    instance: u64,
) {
    let mut peers = lock(state)
        .network
        .as_ref()
        .filter(|running| running.instance == instance)
        .map(|running| running.model.shown_direct_peers())
        .unwrap_or_default();
    peers.truncate(launch_monitor_budget(
        client.snapshot().isupport().monitor(),
    ));
    let watches = peers
        .into_iter()
        .map(|peer| {
            let watch = client.watch(peer.as_str());
            (peer, watch)
        })
        .collect();
    if let Some(running) = lock(state)
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    {
        running.model.hold_launch_watches(watches);
    }
}

/// The watches open DMs hold take their own `MONITOR` entries, so the launch batch takes at most
/// half the server's list.
const fn launch_monitor_budget(limit: Option<papo::isupport::LimitValue>) -> usize {
    match limit {
        Some(papo::isupport::LimitValue::Limited(limit)) => limit / 2,
        Some(papo::isupport::LimitValue::Unlimited) => usize::MAX,
        None => 0,
    }
}

fn fallback_target_reconciliation(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    network_id: NetworkId,
) {
    let history_available = can_fetch_history(&client.snapshot());
    let (fetches, buffers) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let fetches = running.model.fallback_target_history(history_available);
        let buffers = (!fetches.is_empty()).then(|| running.model.buffers_event());
        (fetches, buffers)
    };
    send_events(outbound, buffers.into_iter().collect());
    send_recent_directs_ready(state, outbound, instance, network_id, false);
    for fetch in fetches {
        let marker_nick = direct_history_target(&fetch).cloned();
        spawn_history_fetch(
            Arc::clone(state),
            outbound.clone(),
            client.clone(),
            instance,
            fetch,
            marker_nick,
        );
    }
}

fn restore_target_rows(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    recent: Vec<(NameKey, SystemTime)>,
    complete: bool,
    upper_bound: SystemTime,
) {
    let snapshot = client.snapshot();
    let target_count = recent.len();
    let mut channel_fetches = Vec::new();
    let mut directs = recent
        .into_iter()
        .filter_map(|(conversation, latest_server_time)| match conversation {
            NameKey::Direct(nick) if !is_own_nick(&snapshot, nick.as_str()) => {
                Some((nick, latest_server_time))
            }
            NameKey::Channel(channel) => {
                let fetch = lock(state)
                    .network
                    .as_mut()
                    .filter(|running| running.instance == instance)
                    .and_then(|running| {
                        running.model.restore_channel(&channel, latest_server_time)
                    });
                channel_fetches.extend(fetch);
                None
            }
            NameKey::Direct(_) => None,
        })
        .collect::<Vec<_>>();
    directs.sort_by(|(first_nick, first_time), (second_nick, second_time)| {
        second_time
            .cmp(first_time)
            .then_with(|| first_nick.key().cmp(second_nick.key()))
    });
    let mut seen = HashSet::new();
    directs.retain(|(nick, _)| seen.insert(nick.key().to_owned()));
    let covered_through = target_sync_boundary(complete, target_count, directs.len(), upper_bound);
    directs.truncate(RECENT_DIRECT_LIMIT);
    let Some((mut output, direct_fetches)) = restore_direct_target_rows(state, instance, directs)
    else {
        return;
    };
    channel_fetches.extend(direct_fetches);
    let changed_direct_targets = channel_fetches
        .iter()
        .filter_map(direct_history_target)
        .cloned()
        .map(HistoryTarget::Direct)
        .collect::<Vec<_>>();
    let mut runtime = lock(state);
    let Some(running) = runtime
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return;
    };
    let network_id = running.model.id();
    let mut seen_marker_targets = HashSet::new();
    let marker_targets = running
        .model
        .direct_marker_targets()
        .into_iter()
        .chain(changed_direct_targets)
        .filter(|target| match target {
            HistoryTarget::Direct(nick) => seen_marker_targets.insert(nick.key().to_owned()),
            HistoryTarget::Channel(_) => false,
        })
        .collect::<Vec<_>>();
    running.model.finish_target_sync(covered_through);
    output.push(running.model.buffers_event());
    drop(runtime);
    drop(snapshot);
    send_events(outbound, output);
    send_recent_directs_ready(state, outbound, instance, network_id, true);
    for target in marker_targets {
        spawn_read_marker_fetch(
            Arc::clone(state),
            outbound.clone(),
            client.clone(),
            instance,
            target,
        );
    }
    for fetch in channel_fetches {
        spawn_history_page(
            Arc::clone(state),
            outbound.clone(),
            client.clone(),
            instance,
            fetch,
        );
    }
}

fn restore_direct_target_rows(
    state: &Arc<Mutex<RuntimeState>>,
    instance: u64,
    directs: Vec<(papo::Nick, SystemTime)>,
) -> Option<(Vec<EngineToUi>, Vec<HistoryFetch>)> {
    let mut output = Vec::new();
    let mut fetches = Vec::new();
    for (nick, latest) in directs {
        let restored =
            lock(state)
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
                .and_then(|running| {
                    let latest_ms = time_millis(latest);
                    (!running.chat_list.snapshot.as_ref().is_some_and(|snapshot| {
                        snapshot.direct_closed_since(nick.key(), latest_ms)
                    }))
                    .then(|| running.model.restore_direct(&nick, latest))
                });
        let (fetch, _buffer_id, added) = restored?;
        if let Some(buffer) = added {
            output.push(EngineToUi::BufferAdded { buffer });
        }
        fetches.extend(fetch);
    }
    Some((output, fetches))
}

fn target_sync_boundary(
    complete: bool,
    target_count: usize,
    direct_count: usize,
    upper_bound: SystemTime,
) -> Option<SystemTime> {
    (complete && target_count < RECENT_TARGET_LIMIT && direct_count <= RECENT_DIRECT_LIMIT)
        .then_some(upper_bound)
}

fn with_running_model(
    state: &Arc<Mutex<RuntimeState>>,
    instance: u64,
    update: impl FnOnce(&mut NetworkModel),
) {
    if let Some(running) = lock(state)
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    {
        update(&mut running.model);
    }
}

fn running_network_id(state: &Arc<Mutex<RuntimeState>>, instance: u64) -> Option<NetworkId> {
    lock(state)
        .network
        .as_ref()
        .filter(|running| running.instance == instance)
        .map(|running| running.model.id())
}

fn send_recent_directs_ready(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
    network_id: NetworkId,
    mark_vanished: bool,
) {
    let (client, vanished) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let vanished = if mark_vanished {
            running.model.mark_vanished_restored_rows()
        } else {
            Vec::new()
        };
        if !running.pending_sends.is_empty() && !running.flushing_sends {
            running.flushing_sends = true;
            (Some(running.client.clone()), vanished)
        } else {
            (None, vanished)
        }
    };
    send_events(outbound, vanished);
    let _ = outbound.send(EngineToUi::RecentDirectsReady { network_id });
    if let Some(client) = client {
        spawn_send_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
    update_chat_list(state, outbound, instance);
}

/// papo can learn a peer is online while resolving it, without emitting a presence event.
fn resolve_direct(
    running: &mut RunningNetwork,
    buffer_id: BufferId,
    availability: DirectAvailability,
) -> Vec<EngineToUi> {
    let snapshot = running.client.snapshot();
    running
        .model
        .resolve_direct(buffer_id, availability, &snapshot);
    running.model.sync_direct_peers(&snapshot)
}

fn apply_direct_resolution(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
    buffer_id: BufferId,
    direct: DirectPeer,
) {
    let availability = DirectAvailability::Guarded(direct);
    let (client, presence) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let presence = resolve_direct(running, buffer_id, availability);
        let client = (!running.pending_sends.is_empty() && !running.flushing_sends).then(|| {
            running.flushing_sends = true;
            running.client.clone()
        });
        (client, presence)
    };
    send_events(outbound, presence);
    if let Some(client) = client {
        spawn_send_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
}

#[cfg(test)]
fn process_event(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    event: papo::Event,
) -> Vec<HistoryFetch> {
    process_event_at(state, outbound, client, instance, event, &client.snapshot())
}

/// `event_state` is papo's state right after the event, which facts about the event itself
/// (who left, who joined) must be read from; later events may already have changed `snapshot`.
fn process_event_at(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    event: papo::Event,
    event_state: &papo::State,
) -> Vec<HistoryFetch> {
    let snapshot = client.snapshot();
    let shared_state = Arc::clone(state);
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return Vec::new();
    };
    let mut output = Vec::new();
    let peer_facts_may_change = crate::direct_peer::may_change(&event);
    let membership_grew = crate::members::channels_gaining_members(&event, &snapshot);
    let departed = crate::peer_pin::departures(&event, event_state);
    running
        .model
        .observe_peers(&event, time_millis(papo::time::now()));
    let effects = process_papo_event(running, &snapshot, event, None, &mut output);
    running.model.note_peer_departures(&departed);
    for channel in &membership_grew {
        running.model.remember_members(&snapshot, channel);
    }
    if peer_facts_may_change || output.iter().any(crate::direct_peer::reveals_buffers) {
        output.extend(running.model.sync_direct_peers(&snapshot));
    }
    away_check::start_away_checks(running, &shared_state, outbound);
    if effects.clear_hosted_authentication {
        output.extend(running.model.take_timeline_changes(false));
        state.network = None;
        drop(state);
    } else {
        output = finish_timeline_turn(state, output);
    }
    send_events(outbound, output);
    update_chat_list(&shared_state, outbound, instance);
    spawn_event_flushes(
        &shared_state,
        outbound,
        client,
        instance,
        effects.flush_sends,
        effects.read_flush,
    );
    effects.history_fetches
}

#[derive(Default)]
struct EventEffects {
    history_fetches: Vec<HistoryFetch>,
    clear_hosted_authentication: bool,
    flush_sends: bool,
    read_flush: Option<(papo::Client, u64)>,
}

fn process_papo_event(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    event: papo::Event,
    direct: Option<DirectPeer>,
    output: &mut Vec<EngineToUi>,
) -> EventEffects {
    let mut effects = EventEffects::default();
    let live_server_time = live_cursor_time(&event);
    effects.history_fetches = match event {
        papo::Event::Connecting(connecting) => {
            process_connecting(running, &connecting, output);
            Vec::new()
        }
        papo::Event::Connected(connected) => {
            let history_fetches = process_connected(running, snapshot, &connected, output);
            if !running.pending_sends.is_empty() && !running.flushing_sends {
                running.flushing_sends = true;
                effects.flush_sends = true;
            }
            effects.read_flush = start_read_flush(running);
            history_fetches
        }
        papo::Event::Lagged(lagged) => {
            process_lagged(&mut running.model, snapshot, &lagged, output)
                .into_iter()
                .map(HistoryFetch::Latest)
                .collect()
        }
        papo::Event::Warning(warning) => {
            process_warning(&warning, output);
            Vec::new()
        }
        papo::Event::CasemappingChanged(_) => {
            running.model.rebuild_name_keys(snapshot);
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
            process_nick_change(&mut running.model, snapshot, &changed, output);
            Vec::new()
        }
        papo::Event::ModeChanged(changed) => process_mode_change(&mut running.model, &changed),
        papo::Event::Invited(invited) => process_invite(&mut running.model, &invited),
        papo::Event::AccountChanged(changed) => {
            process_account_event(running, snapshot, &changed, output);
            Vec::new()
        }
        papo::Event::Message(message) => {
            effects.read_flush = live_chat(running, snapshot, (&message).into(), direct, output);
            Vec::new()
        }
        papo::Event::Notice(notice) => {
            effects.read_flush = live_chat(running, snapshot, (&notice).into(), direct, output);
            Vec::new()
        }
        papo::Event::ServerNotice(notice) => {
            effects.read_flush = process_live_server_notice(running, snapshot, &notice, output);
            Vec::new()
        }
        papo::Event::Reacted(reaction) => {
            let _ = running.model.receive_reaction(&reaction);
            Vec::new()
        }
        papo::Event::Redacted(redacted) => receive_redaction(&mut running.model, &redacted, output),
        papo::Event::FeaturesChanged(_) => {
            project_own_change_actions(&mut running.model, Some(snapshot));
            output.push(running.model.network_event());
            Vec::new()
        }
        papo::Event::TypingChanged(changed) => {
            if changed.actor_party != papo::Party::Me
                && let Some(event) = NameKey::from_conversation(changed.conversation())
                    .and_then(|key| typing_changed_event(&running.model, snapshot, &key))
            {
                output.push(event);
            }
            Vec::new()
        }
        papo::Event::ReadMarkerChanged(marker) => {
            process_read_marker(running, &marker, output, &mut effects);
            Vec::new()
        }
        papo::Event::Joined(joined) => {
            process_join_event(running, snapshot, &joined, output, &mut effects)
        }
        papo::Event::Parted(parted) => process_part_event(running, snapshot, &parted, output),
        event @ (papo::Event::Kicked(_)
        | papo::Event::Quit(_)
        | papo::Event::TopicChanged(_)
        | papo::Event::ChannelSynced(_)) => {
            process_channel_line(&mut running.model, snapshot, event, output);
            Vec::new()
        }
        papo::Event::Disconnected(disconnected) => {
            process_disconnected(running, &disconnected, output, &mut effects)
        }
        event => process_server_buffer_event(&mut running.model, event),
    };
    running.model.observe_live_server_time(live_server_time);
    effects
}

fn process_server_buffer_event(model: &mut NetworkModel, event: papo::Event) -> Vec<HistoryFetch> {
    if let papo::Event::Motd(motd) = event {
        model.hold_motd(Some(motd.lines));
    }
    Vec::new()
}

fn receive_redaction(
    model: &mut NetworkModel,
    redacted: &papo::event::Redacted,
    output: &mut Vec<EngineToUi>,
) -> Vec<HistoryFetch> {
    output.extend(model.receive_redaction(redacted));
    Vec::new()
}

fn process_disconnected(
    running: &mut RunningNetwork,
    disconnected: &papo::event::Disconnected,
    output: &mut Vec<EngineToUi>,
    effects: &mut EventEffects,
) -> Vec<HistoryFetch> {
    effects.clear_hosted_authentication = process_disconnected_event(running, disconnected, output);
    Vec::new()
}

fn process_account_event(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    changed: &papo::event::AccountChanged,
    output: &mut Vec<EngineToUi>,
) {
    process_account_change(&mut running.model, changed, output);
    if changed.actor_party == papo::Party::Me {
        connected_push_action(running, snapshot, output);
    }
}

fn live_chat(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    input: ChatInput<'_>,
    direct: Option<DirectPeer>,
    output: &mut Vec<EngineToUi>,
) -> Option<(papo::Client, u64)> {
    let (received, advances) = receive_chat(&mut running.model, input, false, snapshot, direct);
    output.extend(received);
    output.extend(record_read_advances(running, advances));
    start_read_flush(running)
}

fn process_live_server_notice(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    notice: &papo::event::ServerNotice,
    output: &mut Vec<EngineToUi>,
) -> Option<(papo::Client, u64)> {
    let (received, advances) = running
        .model
        .receive_server_notice_with_advance(notice, false, snapshot);
    output.extend(received);
    output.extend(record_read_advances(running, advances));
    start_read_flush(running)
}

fn live_cursor_time(event: &papo::Event) -> Option<SystemTime> {
    // An account tag can emit this fact before the message from the same line.
    if matches!(event, papo::Event::AccountChanged(_)) {
        return None;
    }
    event.server_time().map(papo::ServerTime::to_system_time)
}

fn typing_snapshot_events(model: &NetworkModel, state: &papo::State) -> Vec<EngineToUi> {
    model
        .conversation_buffers()
        .filter_map(|(_, key)| typing_snapshot_event(model, state, &key))
        .collect()
}

fn open_direct_with_live_state(
    model: &mut NetworkModel,
    nick: papo::Nick,
    direct: DirectAvailability,
    state: &papo::State,
) -> (BufferId, Vec<EngineToUi>) {
    let key = NameKey::Direct(nick.clone());
    let (buffer_id, mut output) = model.open_direct(nick, direct, state);
    output.extend(typing_snapshot_event(model, state, &key));
    output.extend(model.sync_direct_peers(state));
    (buffer_id, output)
}

fn typing_snapshot_event(
    model: &NetworkModel,
    state: &papo::State,
    key: &NameKey,
) -> Option<EngineToUi> {
    let event = typing_changed_event(model, state, key)?;
    let EngineToUi::TypingChanged { typers, .. } = &event else {
        unreachable!("typing_changed_event returned another event kind")
    };
    (!typers.is_empty()).then_some(event)
}

fn typing_changed_event(
    model: &NetworkModel,
    state: &papo::State,
    key: &NameKey,
) -> Option<EngineToUi> {
    Some(EngineToUi::TypingChanged {
        buffer_id: model.buffer_id_for_name(key)?,
        typers: typing_projection(state, key),
    })
}

fn typing_projection(state: &papo::State, key: &NameKey) -> Vec<TypingProjection> {
    let casemapping = crate::name_key::casemapping(state);
    let typers = match key {
        NameKey::Channel(channel) => state.typing(channel),
        NameKey::Direct(nick) => state.typing(nick),
    };
    typers
        .map(|typer| TypingProjection {
            nick: typer.nick().to_string(),
            nick_color_index: crate::state::nick_color_index(casemapping, typer.nick().as_str()),
            paused: typer.is_paused(),
        })
        .collect()
}

fn spawn_event_flushes(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    flush_sends: bool,
    read_flush: Option<(papo::Client, u64)>,
) {
    if flush_sends {
        spawn_send_flush(
            Arc::clone(state),
            outbound.clone(),
            client.clone(),
            instance,
        );
    }
    if let Some((client, instance)) = read_flush {
        spawn_read_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
}

fn stop_client(client: papo::Client) {
    spawn_task(async move {
        let _ = client.quit().await;
    });
}

fn process_disconnected_event(
    running: &mut RunningNetwork,
    disconnected: &papo::event::Disconnected,
    output: &mut Vec<EngineToUi>,
) -> bool {
    let clear_authentication = process_disconnect(running, disconnected, output);
    let refresh_token = running.identity.kind() == AuthenticationKind::HostedOAuth
        && !clear_authentication
        && !matches!(disconnected.cause, papo::DisconnectCause::Requested { .. });
    if refresh_token {
        output.push(EngineToUi::HostedTokenRequired {
            network_id: running.model.id(),
        });
        stop_client(running.client.clone());
    }
    clear_authentication
}

fn process_warning(warning: &papo::event::Warning, output: &mut Vec<EngineToUi>) {
    match warning {
        papo::event::Warning::ChannelRecreated { .. } => {
            output.push(EngineToUi::notice(EngineMessageKey::ChannelRecreated));
        }
        papo::event::Warning::StateLimitReached { kind, .. } => {
            output.extend(
                state_limit_events(
                    &papo::Error::StateLimit(*kind),
                    false,
                    None,
                    "papo_state_warning",
                )
                .unwrap_or_default(),
            );
        }
        _ => {}
    }
}

fn process_connecting(
    running: &mut RunningNetwork,
    connecting: &papo::event::Connecting,
    output: &mut Vec<EngineToUi>,
) {
    running.connection_attempt = u32::try_from(connecting.attempt).unwrap_or(u32::MAX);
    running.model.hold_motd(None);
    let state = if running.device_online {
        next_connection_state(
            running.model.connection(),
            connecting_transition(connecting),
            papo::time::now(),
        )
    } else {
        NetworkConnectionState::Offline {
            reason: OfflineReason::DeviceOffline,
        }
    };
    output.push(running.model.set_connection(state, None));
}

fn process_connected(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    connected: &papo::event::Connected,
    output: &mut Vec<EngineToUi>,
) -> Vec<HistoryFetch> {
    running.model.rebuild_name_keys(snapshot);
    running
        .model
        .set_filehost_origin(filehost::origin(snapshot));
    running.model.set_account(
        snapshot
            .account()
            .name()
            .map(|account| account.key().to_owned()),
    );
    project_own_change_actions(&mut running.model, Some(snapshot));
    running.model.show_connection(
        connected_line(&running.identity.endpoint),
        time_millis(papo::time::now()),
    );
    running
        .model
        .finish_disconnect_gap(time_millis(papo::time::now()), can_fetch_history(snapshot));
    let next = next_connection_state(
        running.model.connection(),
        ConnectionTransition::Connected,
        papo::time::now(),
    );
    output.push(
        running
            .model
            .set_connection(next, Some(connected.nick.to_string())),
    );
    running.model.begin_target_sync(papo::time::now());
    output.extend(running.model.sync_channels(snapshot));
    for advance in running.model.pending_read_advances() {
        queue_read_advance(&mut running.pending_reads, advance);
    }
    let history_fetches = running.model.connected_history();
    if !history_fetches.is_empty() {
        output.push(running.model.buffers_event());
    }
    connected_push_action(running, snapshot, output);
    history_fetches
}

fn connected_line(endpoint: &str) -> Option<crate::timeline::LineEvent> {
    let endpoint = endpoint.parse::<papo::Endpoint>().ok()?;
    Some(crate::timeline::LineEvent::Connected {
        server: endpoint.host().to_owned(),
        secure: matches!(
            endpoint.kind(),
            papo::EndpointKind::Tls | papo::EndpointKind::SecureWebSocket
        ),
    })
}

fn connected_push_action(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    output: &mut Vec<EngineToUi>,
) {
    let event = push_route_event(running, snapshot);
    running.push.state = match &event {
        Some(EngineToUi::PushStateChanged { state, .. }) => Some(state.clone()),
        _ => None,
    };
    output.extend(event);
}

fn push_route_event(running: &RunningNetwork, snapshot: &papo::State) -> Option<EngineToUi> {
    let network_id = running.model.id();
    if let Some(reason) = push_unsupported_reason(snapshot) {
        return Some(EngineToUi::PushStateChanged {
            network_id,
            state: PushState::Unsupported { reason },
        });
    }
    let vapid = snapshot.isupport().vapid()?;
    Some(EngineToUi::PushRouteRequired {
        network_id,
        vapid: vapid.to_owned(),
        previous_route_id: running
            .push
            .route
            .as_ref()
            .map(|route| route.route_id.clone()),
    })
}

fn process_disconnect(
    running: &mut RunningNetwork,
    disconnected: &papo::event::Disconnected,
    output: &mut Vec<EngineToUi>,
) -> bool {
    release_connection(running, output);
    let hosted_authentication_failed =
        running.identity.kind() == AuthenticationKind::HostedOAuth && is_sasl_failure(disconnected);
    output.push(running.model.set_connection(
        next_connection_state(
            running.model.connection(),
            ConnectionTransition::Disconnected {
                event: disconnected.clone(),
                attempt: running.connection_attempt,
                hosted_authentication_failed,
                device_online: running.device_online,
            },
            papo::time::now(),
        ),
        None,
    ));
    output.extend(connection_failure_notice(
        disconnected,
        hosted_authentication_failed,
    ));
    hosted_authentication_failed
}

/// What a lost connection takes with it: typing, the actions only a live server confirms, the
/// peers' handles, in-flight history and reads, and sends that may not outlive it.
fn release_connection(running: &mut RunningNetwork, output: &mut Vec<EngineToUi>) {
    running.typing = crate::typing::OutgoingTyping::default();
    project_own_change_actions(&mut running.model, None);
    output.extend(running.model.conversation_buffers().map(|(buffer_id, _)| {
        EngineToUi::TypingChanged {
            buffer_id,
            typers: Vec::new(),
        }
    }));
    running
        .model
        .begin_disconnect_gap(time_millis(papo::time::now()));
    running.model.restart_inflight_history();
    running.model.invalidate_direct_handles();
    running.flushing_reads = false;
    let mut retained = VecDeque::new();
    for queued in running.pending_sends.drain(..) {
        if queued.retry_if_disconnected {
            retained.push_back(queued);
        } else {
            output.extend(
                running
                    .model
                    .fail_send(&queued.pending, EngineMessageKey::SendFailed),
            );
        }
    }
    running.pending_sends = retained;
}

fn process_lagged(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    lagged: &papo::event::Lagged,
    output: &mut Vec<EngineToUi>,
) -> Vec<HistoryTarget> {
    output.push(EngineToUi::Diagnostic {
        command_id: "papo.event_queue".into(),
        message: format!("{} papo events dropped", lagged.dropped),
    });
    model.rebuild_name_keys(snapshot);
    for gap in &lagged.gaps {
        let Some(first) = gap.first_server_time.or(gap.last_server_time) else {
            continue;
        };
        let last = gap.last_server_time.unwrap_or(first);
        if let Some(key) = NameKey::from_conversation(&gap.conversation) {
            model.note_lagged_gap(&key, first.as_millis(), last.as_millis());
        }
    }
    output.extend(model.sync_channels(snapshot));
    output.push(model.buffers_event());
    model.history_targets()
}

fn process_nick_change(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    changed: &papo::event::NickChanged,
    output: &mut Vec<EngineToUi>,
) {
    if changed.actor_party == papo::Party::Me {
        output.push(model.set_nickname(changed.new.to_string()));
    }
    model.receive_nick_change(changed, snapshot);
}

fn process_account_change(
    model: &mut NetworkModel,
    changed: &papo::event::AccountChanged,
    output: &mut Vec<EngineToUi>,
) {
    output.extend(model.update_direct_account(&changed.actor.nick(), &changed.account));
}

fn process_read_marker(
    running: &mut RunningNetwork,
    marker: &papo::event::ReadMarkerChanged,
    output: &mut Vec<EngineToUi>,
    effects: &mut EventEffects,
) {
    let Some(key) = NameKey::from_conversation(&marker.conversation) else {
        return;
    };
    let (events, advance) = running
        .model
        .apply_server_read_marker_with_advance(&key, read_marker_time(marker.marker));
    output.extend(events);
    output.extend(record_read_advances(running, advance));
    effects.read_flush = start_read_flush(running);
}

enum ConnectionTransition {
    Connecting {
        registering: bool,
    },
    Connected,
    Disconnected {
        event: papo::event::Disconnected,
        attempt: u32,
        hosted_authentication_failed: bool,
        device_online: bool,
    },
    DeviceOffline,
    AuthenticationExpired,
    ManualRetry,
}

fn next_connection_state(
    current: &NetworkConnectionState,
    transition: ConnectionTransition,
    now: std::time::SystemTime,
) -> NetworkConnectionState {
    match transition {
        ConnectionTransition::Connecting { registering } => {
            if registering {
                NetworkConnectionState::Registering
            } else {
                NetworkConnectionState::Connecting
            }
        }
        ConnectionTransition::Connected => NetworkConnectionState::Online,
        ConnectionTransition::Disconnected {
            event,
            attempt,
            hosted_authentication_failed,
            device_online,
        } => disconnected_state(
            &event,
            attempt,
            hosted_authentication_failed,
            device_online,
            now,
        ),
        ConnectionTransition::DeviceOffline => NetworkConnectionState::Offline {
            reason: OfflineReason::DeviceOffline,
        },
        ConnectionTransition::AuthenticationExpired => NetworkConnectionState::Failed {
            reason: ConnectionFailureReason::Authentication,
            message_key: EngineMessageKey::HostedAuthFailed,
        },
        ConnectionTransition::ManualRetry => match current {
            NetworkConnectionState::Failed { .. }
            | NetworkConnectionState::Offline { .. }
            | NetworkConnectionState::Reconnecting { .. } => NetworkConnectionState::Connecting,
            _ => current.clone(),
        },
    }
}

fn connecting_transition(connecting: &papo::event::Connecting) -> ConnectionTransition {
    ConnectionTransition::Connecting {
        registering: !matches!(
            connecting.phase,
            papo::event::ConnectPhase::Transport | papo::event::ConnectPhase::Tls
        ),
    }
}

fn disconnected_state(
    disconnected: &papo::event::Disconnected,
    attempt: u32,
    hosted_authentication_failed: bool,
    device_online: bool,
    now: std::time::SystemTime,
) -> NetworkConnectionState {
    if !device_online {
        return NetworkConnectionState::Offline {
            reason: OfflineReason::DeviceOffline,
        };
    }
    if let Some(reconnect_in) = disconnected.reconnect_in {
        return NetworkConnectionState::Reconnecting {
            attempt,
            next_retry_at_ms: time_millis(now + reconnect_in),
        };
    }
    if matches!(disconnected.cause, papo::DisconnectCause::Requested { .. }) {
        return NetworkConnectionState::Offline {
            reason: OfflineReason::Requested,
        };
    }
    let reason = if hosted_authentication_failed || is_sasl_failure(disconnected) {
        ConnectionFailureReason::Authentication
    } else if matches!(disconnected.cause, papo::DisconnectCause::Connect(_)) {
        ConnectionFailureReason::Transport
    } else {
        ConnectionFailureReason::Protocol
    };
    NetworkConnectionState::Failed {
        reason,
        message_key: if hosted_authentication_failed {
            EngineMessageKey::HostedAuthFailed
        } else {
            EngineMessageKey::ConnectionFailed
        },
    }
}

fn connection_failure_notice(
    disconnected: &papo::event::Disconnected,
    hosted_authentication_failed: bool,
) -> Option<EngineToUi> {
    (disconnected.reconnect_in.is_none()
        && !matches!(disconnected.cause, papo::DisconnectCause::Requested { .. }))
    .then(|| {
        EngineToUi::notice(if hosted_authentication_failed {
            EngineMessageKey::HostedAuthFailed
        } else {
            EngineMessageKey::ConnectionFailed
        })
    })
}

fn is_sasl_failure(disconnected: &papo::event::Disconnected) -> bool {
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
) -> Vec<HistoryTarget> {
    if parted.actor_party == papo::Party::Me {
        if let Some(event) = model.remove_channel(&parted.channel.name()) {
            output.push(event);
        }
    } else {
        let _ = model.receive_membership_event(
            &parted.channel.name(),
            MembershipKind::Parted,
            parted.actor.nick().to_string(),
            parted.reason.clone(),
            parted.msgid.as_ref().map(ToString::to_string),
            parted.server_time.map(papo::ServerTime::as_millis),
            time_millis(parted.received_at),
        );
    }
    output.extend(model.sync_channels(snapshot));
    Vec::new()
}

fn request_buffer_focus(
    output: &mut Vec<EngineToUi>,
    focus: bool,
    command_id: &str,
    buffer_id: BufferId,
) {
    if focus {
        output.push(EngineToUi::FocusBufferRequested {
            command_id: command_id.to_owned(),
            buffer_id,
        });
    }
}

fn process_part_event(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    parted: &papo::event::Parted,
    output: &mut Vec<EngineToUi>,
) -> Vec<HistoryFetch> {
    if parted.actor_party == papo::Party::Me
        && let Some(conversation) = running
            .model
            .snapshot_conversation_for_channel(&parted.channel.name())
    {
        running.chat_list.removed.push(SnapshotRemoval {
            conversation,
            removed_at_ms: event_millis(parted.server_time, parted.received_at),
        });
    }
    process_part(&mut running.model, snapshot, parted, output)
        .into_iter()
        .map(HistoryFetch::Latest)
        .collect()
}

fn process_join_event(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    joined: &papo::event::Joined,
    output: &mut Vec<EngineToUi>,
    effects: &mut EventEffects,
) -> Vec<HistoryFetch> {
    let targets = process_join(running, snapshot, joined, output);
    effects.read_flush = start_read_flush(running);
    if joined.actor_party == papo::Party::Me
        && let Some(conversation) = running
            .model
            .snapshot_conversation_for_channel(&joined.channel.name())
    {
        running.chat_list.joined.push(SnapshotPresence {
            conversation,
            joined_at_ms: event_millis(joined.server_time, joined.received_at),
        });
    }
    targets.into_iter().map(HistoryFetch::Latest).collect()
}

fn process_channel_line(
    model: &mut NetworkModel,
    snapshot: &papo::State,
    event: papo::Event,
    output: &mut Vec<EngineToUi>,
) {
    match event {
        papo::Event::Kicked(kicked) => {
            output.extend(model.receive_kick(&kicked, true).into_iter().flatten());
        }
        papo::Event::Quit(quit) => process_quit(model, &quit),
        papo::Event::TopicChanged(changed) => {
            model.receive_topic_change(&changed);
            output.extend(model.sync_channels(snapshot));
        }
        papo::Event::ChannelSynced(synced) => {
            output.extend(model.sync_channels(snapshot));
            if let Some(channel) = crate::name_key::known_channel(snapshot, &synced.channel) {
                model.show_pending_topic_card(channel);
            }
        }
        _ => {}
    }
}

fn process_quit(model: &mut NetworkModel, quit: &papo::event::Quit) {
    for channel in &quit.channels {
        let _ = model.receive_membership_event(
            &channel.name(),
            MembershipKind::Quit,
            quit.actor.nick().to_string(),
            quit.reason.clone(),
            quit.msgid.as_ref().map(ToString::to_string),
            quit.server_time.map(papo::ServerTime::as_millis),
            time_millis(quit.received_at),
        );
    }
}

fn process_join(
    running: &mut RunningNetwork,
    snapshot: &papo::State,
    joined: &papo::event::Joined,
    output: &mut Vec<EngineToUi>,
) -> Vec<HistoryTarget> {
    output.extend(running.model.sync_channels(snapshot));
    if joined.actor_party == papo::Party::Me {
        running.model.anchor_topic_card(joined);
        if let Some(papo::ReadMarker::ReadUntil(read_until)) =
            snapshot.read_marker(joined.channel.name())
        {
            let (events, advance) = running.model.apply_server_read_marker_with_advance(
                &NameKey::Channel(joined.channel.name()),
                Some(read_until.to_system_time()),
            );
            output.extend(events);
            output.extend(record_read_advances(running, advance));
        }
        let target = running.model.request_latest_channel(&joined.channel.name());
        if let Some(buffer_id) = running.model.buffer_id_for_channel(&joined.channel.name())
            && target.is_some()
            && let Some(event) = running.model.buffer_updated(buffer_id)
        {
            output.push(event);
        }
        target.into_iter().collect()
    } else {
        let _ = running.model.receive_membership_event(
            &joined.channel.name(),
            MembershipKind::Joined,
            joined.actor.nick().to_string(),
            None,
            joined.msgid.as_ref().map(ToString::to_string),
            joined.server_time.map(papo::ServerTime::as_millis),
            time_millis(joined.received_at),
        );
        Vec::new()
    }
}

fn process_history(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    client: &papo::Client,
    instance: u64,
    page: papo::event::HistoryPage,
) {
    let shared_state = Arc::clone(state);
    let Some(conversation) = NameKey::from_conversation(&page.conversation) else {
        return;
    };
    let (item_count, end) = (page.items.len(), page.exhausted);
    let bounds = history_page_bounds(&page);
    let mut state = lock(state);
    let Some(running) = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)
    else {
        return;
    };
    let load = running.model.history_load(&conversation);
    let mut output = receive_history_items(running, client, page.items);
    let read_flush = start_read_flush(running);
    let finished = finish_history_page(
        &mut running.model,
        load,
        &conversation,
        bounds,
        item_count,
        end,
    );
    output.extend(finished);
    let gap_fill = catch_up_gap_fill(&mut running.model, load, &conversation);
    publish_history_turn(state, &shared_state, outbound, instance, output, read_flush);
    if let Some(fetch) = gap_fill {
        spawn_gap_fill(
            shared_state,
            outbound.clone(),
            client.clone(),
            instance,
            fetch,
        );
    }
}

fn publish_history_turn(
    guard: MutexGuard<'_, RuntimeState>,
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
    output: Vec<EngineToUi>,
    read_flush: Option<(papo::Client, u64)>,
) {
    send_events(outbound, finish_timeline_turn(guard, output));
    update_chat_list(state, outbound, instance);
    if let Some((client, instance)) = read_flush {
        spawn_read_flush(Arc::clone(state), outbound.clone(), client, instance);
    }
}

fn receive_history_items(
    running: &mut RunningNetwork,
    client: &papo::Client,
    items: Vec<papo::Event>,
) -> Vec<EngineToUi> {
    let snapshot = client.snapshot();
    let mut output = Vec::new();
    let mut read_advances = Vec::new();
    for item in items {
        match unrestricted(item) {
            papo::Event::Message(message) => {
                let (received, advance) =
                    receive_chat(&mut running.model, (&message).into(), true, &snapshot, None);
                read_advances.extend(advance);
                output.extend(received);
            }
            papo::Event::Notice(notice) => {
                let (received, advance) =
                    receive_chat(&mut running.model, (&notice).into(), true, &snapshot, None);
                read_advances.extend(advance);
                output.extend(received);
            }
            papo::Event::ServerNotice(notice) => {
                let (received, advances) = running
                    .model
                    .receive_server_notice_with_advance(&notice, true, &snapshot);
                read_advances.extend(advances);
                output.extend(received);
            }
            papo::Event::Reacted(reaction) => _ = running.model.receive_reaction(&reaction),
            papo::Event::Redacted(redacted) => {
                output.extend(running.model.receive_redaction(&redacted));
            }
            other => receive_history_system_event(&mut running.model, other, &snapshot),
        }
    }
    output.extend(record_read_advances(running, read_advances));
    output
}

fn receive_history_system_event(model: &mut NetworkModel, event: papo::Event, state: &papo::State) {
    match event {
        papo::Event::Joined(joined) if joined.actor_party != papo::Party::Me => {
            let _ = model.receive_membership_event(
                &joined.channel.name(),
                MembershipKind::Joined,
                joined.actor.nick().to_string(),
                None,
                joined.msgid.as_ref().map(ToString::to_string),
                joined.server_time.map(papo::ServerTime::as_millis),
                time_millis(joined.received_at),
            );
        }
        papo::Event::Parted(parted) if parted.actor_party != papo::Party::Me => {
            let _ = model.receive_membership_event(
                &parted.channel.name(),
                MembershipKind::Parted,
                parted.actor.nick().to_string(),
                parted.reason.clone(),
                parted.msgid.as_ref().map(ToString::to_string),
                parted.server_time.map(papo::ServerTime::as_millis),
                time_millis(parted.received_at),
            );
        }
        papo::Event::Quit(quit) => process_quit(model, &quit),
        papo::Event::NickChanged(changed) => history_nick(model, &changed, state),
        papo::Event::ModeChanged(changed) => _ = model.receive_mode_change(&changed),
        papo::Event::Invited(invited) => _ = model.receive_invite(&invited),
        papo::Event::Kicked(kicked) if kicked.subject_party != papo::Party::Me => {
            _ = model.receive_kick(&kicked, false);
        }
        papo::Event::TopicChanged(changed) => model.receive_topic_change(&changed),
        _ => {}
    }
}

fn history_nick(model: &mut NetworkModel, changed: &papo::event::NickChanged, state: &papo::State) {
    if changed.actor_party != papo::Party::Me {
        model.receive_nick_change(changed, state);
    }
}

fn process_invite(model: &mut NetworkModel, invited: &papo::event::Invited) -> Vec<HistoryFetch> {
    let _ = model.receive_invite(invited);
    Vec::new()
}

fn process_mode_change(
    model: &mut NetworkModel,
    changed: &papo::event::ModeChanged,
) -> Vec<HistoryFetch> {
    let _ = model.receive_mode_change(changed);
    Vec::new()
}

fn finish_history_page(
    model: &mut NetworkModel,
    load: Option<HistoryLoad>,
    conversation: &NameKey,
    bounds: HistoryPageBounds,
    item_count: usize,
    end: bool,
) -> Vec<EngineToUi> {
    model.finish_lagged_gap(conversation, bounds.oldest_time_ms);
    let Some(completion) = load.and_then(|_| {
        model.finish_history(
            conversation,
            bounds.oldest,
            bounds.oldest_time_ms,
            bounds.newest,
            item_count,
            end,
        )
    }) else {
        return Vec::new();
    };
    model
        .buffer_updated(completion.buffer_id)
        .into_iter()
        .chain(
            completion
                .at_start
                .map(|at_start| EngineToUi::HistoryStateChanged {
                    buffer_id: completion.buffer_id,
                    loading: false,
                    at_start,
                }),
        )
        .collect()
}

fn record_read_advances_and_flush(
    state: &Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
    advances: Vec<ReadAdvance>,
) {
    let (events, flush) = {
        let mut state = lock(state);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let events = record_read_advances(running, advances);
        let flush = start_read_flush(running);
        (events, flush)
    };
    send_events(&outbound, events);
    update_chat_list(state, &outbound, instance);
    if let Some((client, instance)) = flush {
        spawn_read_flush(Arc::clone(state), outbound, client, instance);
    }
}

fn update_chat_list(
    state: &Arc<Mutex<RuntimeState>>,
    _outbound: &mpsc::UnboundedSender<EngineToUi>,
    instance: u64,
) {
    let (changes, storage, writer) = {
        let mut state = lock(state);
        let storage = state.storage.clone();
        let writer = Arc::clone(&state.snapshot_writer);
        let Some(running) = state
            .network
            .as_mut()
            .filter(|running| running.instance == instance)
        else {
            return;
        };
        let previous = running
            .chat_list
            .snapshot
            .get_or_insert_with(|| {
                ChatListSnapshot::new(running.chat_list.fingerprint.clone(), Vec::new())
            })
            .clone();
        let removed = std::mem::take(&mut running.chat_list.removed);
        let joined = std::mem::take(&mut running.chat_list.joined);
        let snapshot = running.model.merge_chat_list_snapshot_with_changes(
            running.chat_list.fingerprint.clone(),
            &previous,
            &removed,
            &joined,
        );
        let changes = SnapshotChanges::between(&previous, &snapshot, removed, joined);
        running.chat_list.snapshot = Some(snapshot);
        (changes, storage, writer)
    };
    if let Some(changes) = changes {
        schedule_snapshot_write(storage, writer, changes);
    }
}

fn schedule_snapshot_write(
    storage: RuntimeStorage,
    writer: Arc<Mutex<SnapshotWriter>>,
    changes: SnapshotChanges,
) {
    let generation = {
        let mut writer = lock(&writer);
        writer.pending.push_back(changes);
        if writer.active {
            return;
        }
        writer.active = true;
        writer.generation
    };
    spawn_snapshot_writer(storage, writer, generation);
}

fn cancel_snapshot_writes(writer: &Arc<Mutex<SnapshotWriter>>) {
    let mut writer = lock(writer);
    writer.generation = writer.generation.wrapping_add(1);
    writer.active = false;
    writer.pending.clear();
}

async fn write_snapshot_intervals(
    storage: RuntimeStorage,
    writer: Arc<Mutex<SnapshotWriter>>,
    generation: u64,
) {
    let mut failures = 0_u8;
    loop {
        let changes = {
            let mut writer = lock(&writer);
            if writer.generation != generation {
                return;
            }
            let Some(changes) = writer.pending.pop_front() else {
                writer.active = false;
                return;
            };
            changes
        };
        match chat_list_snapshot::write_changes(storage.as_ref(), &changes).await {
            Ok(()) => failures = 0,
            Err(error) => {
                failures = failures.saturating_add(1);
                engine_log(&format!(
                    "{}: {error}",
                    EngineMessageKey::StorageUnavailable.as_str()
                ));
                let retry_later = {
                    let mut writer = lock(&writer);
                    if writer.generation != generation {
                        return;
                    }
                    writer.pending.push_front(changes);
                    failures > SNAPSHOT_WRITE_IMMEDIATE_RETRY_ATTEMPTS
                };
                if retry_later {
                    delay(read_retry_delay(
                        failures.saturating_sub(SNAPSHOT_WRITE_IMMEDIATE_RETRY_ATTEMPTS),
                    ))
                    .await;
                }
            }
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
async fn delay(duration: Duration) {
    tokio::time::sleep(duration).await;
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
async fn delay(duration: Duration) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        let timeout = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("setTimeout"))
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok());
        if let Some(timeout) = timeout {
            let milliseconds = duration.as_secs_f64() * 1_000.0;
            let _ = timeout.call2(&JsValue::NULL, &resolve, &JsValue::from_f64(milliseconds));
        } else {
            let _ = resolve.call0(&JsValue::NULL);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

fn spawn_snapshot_writer(
    storage: RuntimeStorage,
    writer: Arc<Mutex<SnapshotWriter>>,
    generation: u64,
) {
    spawn_task(async move {
        write_snapshot_intervals(storage, writer, generation).await;
    });
}

struct HistoryPageBounds {
    oldest: Option<papo::HistoryReference>,
    oldest_time_ms: Option<i64>,
    newest: Option<HistoryCursor>,
}

fn history_page_bounds(page: &papo::event::HistoryPage) -> HistoryPageBounds {
    let oldest = page
        .items
        .iter()
        .filter_map(|event| {
            let time = event
                .server_time()
                .map(papo::ServerTime::to_system_time)
                .or_else(|| event.received_at())?;
            let reference = event
                .msgid()
                .cloned()
                .map(papo::HistoryReference::from)
                .or_else(|| event.server_time().map(papo::HistoryReference::from))?;
            Some((time, reference))
        })
        .min_by_key(|(time, _)| *time)
        .map(|(time, reference)| (reference, time_millis(time)));
    let newest = page
        .items
        .iter()
        .filter_map(|event| {
            event.server_time().map(|time| {
                HistoryCursor::new(event.msgid().map(ToString::to_string), time.as_millis())
            })
        })
        .fold(None, |newest: Option<HistoryCursor>, cursor| {
            if newest
                .as_ref()
                .is_none_or(|current| cursor.server_time() >= current.server_time())
            {
                Some(cursor)
            } else {
                newest
            }
        });
    HistoryPageBounds {
        oldest: oldest.as_ref().map(|(reference, _)| reference.clone()),
        oldest_time_ms: oldest.map(|(_, time)| time),
        newest,
    }
}

fn valid_endpoint(endpoint: &str, allow_insecure: bool) -> bool {
    let Ok(endpoint) = endpoint.parse::<papo::Endpoint>() else {
        return false;
    };
    matches!(endpoint.kind(), papo::EndpointKind::SecureWebSocket)
        || (allow_insecure && matches!(endpoint.kind(), papo::EndpointKind::WebSocket))
}

fn channel_target(
    running: &RunningNetwork,
    buffer_id: BufferId,
    requested: Option<String>,
) -> Result<ChannelTarget, EngineMessageKey> {
    requested.map(ChannelTarget::Text).map_or_else(
        || {
            running
                .model
                .channel_for_buffer(buffer_id)
                .map(ChannelTarget::Known)
                .ok_or(EngineMessageKey::ChannelRequired)
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

fn push_unsupported_reason(state: &papo::State) -> Option<PushUnsupportedReason> {
    if !state.supports(papo::Feature::WebPush) {
        Some(PushUnsupportedReason::NoWebPush)
    } else if state.account().name().is_none() {
        Some(PushUnsupportedReason::NoAccount)
    } else if state.isupport().vapid().is_none() {
        Some(PushUnsupportedReason::NoVapid)
    } else {
        None
    }
}

fn push_failure(error: &papo::Error) -> PushFailure {
    match error {
        papo::Error::Server(error) => match error.refusal() {
            papo::Refusal::WebPushForbidden => PushFailure::WebPushForbidden,
            papo::Refusal::WebPushRegistrationLimit => PushFailure::RegistrationLimit,
            papo::Refusal::InvalidWebPushParameters => PushFailure::InvalidParameters,
            papo::Refusal::InternalError => PushFailure::Internal,
            _ => PushFailure::Other,
        },
        papo::Error::InvalidInput(_) => PushFailure::InvalidParameters,
        papo::Error::TooManyPendingRequests | papo::Error::StateLimit(_) => {
            PushFailure::RequestLimit
        }
        papo::Error::Disconnected(_)
        | papo::Error::Interrupted(_)
        | papo::Error::Timeout
        | papo::Error::NotVerified
        | papo::Error::Connect(_) => PushFailure::Connection,
        _ => PushFailure::Other,
    }
}

fn rejected_command(command_id: String, message_key: EngineMessageKey) -> Vec<EngineToUi> {
    vec![command_rejection(command_id, message_key)]
}

fn command_rejection(command_id: String, message_key: EngineMessageKey) -> EngineToUi {
    EngineToUi::CommandRejected {
        id: command_id,
        message_key,
        values: None,
    }
}

fn terminal_command(command_id: String, rejection: Option<EngineMessageKey>) -> EngineToUi {
    match rejection {
        Some(message_key) => command_rejection(command_id, message_key),
        None => EngineToUi::CommandResult { id: command_id },
    }
}

fn join_error_key(error: &papo::Error) -> EngineMessageKey {
    if matches!(
        error,
        papo::Error::Server(error) if error.refusal() == papo::Refusal::BannedFromChannel
    ) {
        EngineMessageKey::JoinBanned
    } else if matches!(error, papo::Error::Server(_)) {
        EngineMessageKey::JoinRefused
    } else {
        EngineMessageKey::CommandRefused
    }
}

fn join_request_events(command_id: String, error: &papo::Error) -> Vec<EngineToUi> {
    let mut output = if matches!(
        error,
        papo::Error::Server(error) if error.refusal() == papo::Refusal::TooManyChannels
    ) {
        vec![EngineToUi::error_notice(
            EngineMessageKey::ChannelLimitReached,
        )]
    } else if let Some(output) = state_limit_events(error, true, None, "join") {
        output
    } else {
        return rejected_command(command_id, join_error_key(error));
    };
    output.push(EngineToUi::CommandResult { id: command_id });
    output
}

fn state_limit_events(
    error: &papo::Error,
    user_initiated: bool,
    channel: Option<(&mut NetworkModel, BufferId)>,
    context: &str,
) -> Option<Vec<EngineToUi>> {
    let papo::Error::StateLimit(limit) = error else {
        return None;
    };
    Some(match state_limit_outcome(*limit, user_initiated) {
        StateLimitOutcome::SharedNotice(key) => vec![EngineToUi::error_notice(key)],
        StateLimitOutcome::ChannelNotice(text) => {
            if let Some((model, buffer_id)) = channel {
                let _ = model.append_notice(buffer_id, text.into(), NoticeKind::Info);
                Vec::new()
            } else {
                log_state_limit(context, *limit);
                Vec::new()
            }
        }
        StateLimitOutcome::Log => {
            log_state_limit(context, *limit);
            Vec::new()
        }
    })
}

fn log_state_limit(context: &str, limit: papo::StateLimit) {
    engine_log(&format!("{context}: papo state limit reached: {limit:?}"));
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[allow(clippy::print_stderr)]
fn engine_log(message: &str) {
    eprintln!("[weblounge engine] {message}");
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn engine_log(message: &str) {
    let console = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("console")).ok();
    let warn = console.as_ref().and_then(|console| {
        js_sys::Reflect::get(console, &JsValue::from_str("warn"))
            .ok()
            .and_then(|warn| warn.dyn_into::<js_sys::Function>().ok())
    });
    if let (Some(console), Some(warn)) = (console, warn) {
        let _ = warn.call1(&console, &JsValue::from_str(message));
    }
}

fn sync_joined_channel(
    state: &Arc<Mutex<RuntimeState>>,
    client: &papo::Client,
    instance: u64,
    command_id: &str,
    channel_name: &str,
) -> Option<(Vec<EngineToUi>, bool)> {
    let snapshot = client.snapshot();
    let channel = crate::name_key::known_channel(&snapshot, channel_name)
        .map(|channel| channel.name().clone());
    let mut state = lock(state);
    let running = state
        .network
        .as_mut()
        .filter(|running| running.instance == instance)?;
    let Some(channel) = channel else {
        return Some((Vec::new(), false));
    };
    let mut output = running.model.sync_channels(&snapshot);
    let buffer_id = running.model.buffer_id_for_channel(&channel)?;
    output.push(EngineToUi::FocusBufferRequested {
        command_id: command_id.into(),
        buffer_id,
    });
    Some((output, true))
}

fn send_events(outbound: &mpsc::UnboundedSender<EngineToUi>, events: Vec<EngineToUi>) {
    for event in events {
        let _ = outbound.send(event);
    }
}

fn focus_projected_channels(command_id: &str, channels: &[(BufferId, bool)]) -> Vec<EngineToUi> {
    let mut output = channels
        .iter()
        .map(|(buffer_id, _)| EngineToUi::FocusBufferRequested {
            command_id: command_id.into(),
            buffer_id: *buffer_id,
        })
        .collect::<Vec<_>>();
    output.push(EngineToUi::CommandResult {
        id: command_id.into(),
    });
    output
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
            Err(_) => command_rejection(command_id, EngineMessageKey::CommandRefused),
        };
        let _ = outbound.send(event);
    });
}

fn spawn_push_register(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    task: PushRegisterTask,
    command_id: Option<String>,
) {
    spawn_task(async move {
        for endpoint in &task.unregister {
            let _ = client.webpush().unregister(endpoint).await;
        }
        let result = client
            .webpush()
            .register(
                task.route.endpoint.clone(),
                papo::PushKeys::new(task.route.p256dh.clone(), task.route.auth.clone()),
            )
            .await;
        let push_state = match result {
            Ok(outcome) if outcome.persistence_required() => PushState::RegisteredButNoDelivery {
                route_id: task.route.route_id.clone(),
            },
            Ok(_) => PushState::Registered {
                route_id: task.route.route_id.clone(),
            },
            Err(error) => PushState::Failed {
                route_id: task.route.route_id.clone(),
                reason: push_failure(&error),
            },
        };
        let current = {
            let mut state = lock(&state);
            state
                .network
                .as_mut()
                .filter(|running| {
                    running.instance == task.instance
                        && running.push.generation == task.generation
                        && running
                            .push
                            .route
                            .as_ref()
                            .is_some_and(|route| route.route_id == task.route.route_id)
                })
                .map(|running| {
                    running.push.state = Some(push_state.clone());
                })
                .is_some()
        };
        let _ = outbound.send(EngineToUi::PushStateChanged {
            network_id: task.network_id,
            state: push_state.clone(),
        });
        if current
            && matches!(
                push_state,
                PushState::Registered { .. } | PushState::RegisteredButNoDelivery { .. }
            )
        {
            spawn_push_refresh(state, outbound.clone(), client, task);
        }
        if let Some(id) = command_id {
            let _ = outbound.send(EngineToUi::CommandResult { id });
        }
    });
}

fn spawn_push_refresh(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    mut task: PushRegisterTask,
) {
    spawn_task(async move {
        delay(PUSH_REFRESH_INTERVAL).await;
        let current = lock(&state).network.as_ref().is_some_and(|running| {
            running.instance == task.instance
                && running.push.generation == task.generation
                && running
                    .push
                    .route
                    .as_ref()
                    .is_some_and(|route| route.route_id == task.route.route_id)
        });
        if current && client.snapshot().is_connected() {
            task.unregister.clear();
            spawn_push_register(state, outbound, client, task, None);
        }
    });
}

fn spawn_push_unregister(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    task: PushUnregisterTask,
    command_id: String,
) {
    spawn_task(async move {
        let result = client.webpush().unregister(task.endpoint).await;
        let rejection = result
            .as_ref()
            .err()
            .map(|_| EngineMessageKey::CommandRefused);
        let event = {
            let mut state = lock(&state);
            state
                .network
                .as_mut()
                .filter(|running| {
                    task.clear_current
                        && running.instance == task.instance
                        && running.push.generation == task.generation
                        && running
                            .push
                            .route
                            .as_ref()
                            .is_some_and(|current| current.route_id == task.route_id)
                })
                .and_then(|running| match &result {
                    Ok(()) => {
                        running.push.route = None;
                        running.push.state = None;
                        None
                    }
                    Err(error) => {
                        let push_state = PushState::Failed {
                            route_id: task.route_id.clone(),
                            reason: push_failure(error),
                        };
                        running.push.state = Some(push_state.clone());
                        Some(EngineToUi::PushStateChanged {
                            network_id: task.network_id,
                            state: push_state,
                        })
                    }
                })
        };
        if let Some(event) = event {
            let _ = outbound.send(event);
        }
        let _ = outbound.send(terminal_command(command_id, rejection));
    });
}

#[derive(Clone, Copy)]
enum MemberMode {
    Op,
    Deop,
    Voice,
    Devoice,
    Dehalfop,
    Grant(char),
}

impl MemberMode {
    fn apply(
        self,
        client: &papo::Client,
        channel: &ChannelTarget,
        request: papo::SetModes,
        nick: String,
    ) -> Result<papo::SetModes, ChannelFailure> {
        require_member(client, channel, &nick)?;
        Ok(match self {
            Self::Op => request.op(nick),
            Self::Deop => request.deop(nick),
            Self::Voice => request.voice(nick),
            Self::Devoice => request.devoice(nick),
            Self::Dehalfop => request.remove_with('h', nick),
            Self::Grant(mode) => request.add_with(mode, nick),
        })
    }
}

fn cached_channel_modes(client: &papo::Client, channel: &str) -> Option<String> {
    let state = client.snapshot();
    let joined = crate::name_key::known_channel(&state, channel)?;
    joined
        .modes()
        .next()
        .is_some()
        .then(|| crate::mode_string::describe_channel_modes(joined))
}

fn apply_mode_change(
    client: &papo::Client,
    channel: &ChannelTarget,
    request: papo::SetModes,
    change: crate::mode_string::TypedModeChange,
) -> Result<papo::SetModes, ChannelFailure> {
    let crate::mode_string::TypedModeChange {
        set,
        mode,
        member_mode,
        argument,
    } = change;
    if member_mode {
        let member = match (mode, set) {
            ('o', false) => MemberMode::Deop,
            ('v', false) => MemberMode::Devoice,
            ('h', false) => MemberMode::Dehalfop,
            (_, true) => MemberMode::Grant(mode),
            // TODO(papo-0.1): papo removes only o, h and v by name; `SetModes` has no generic
            // prefix removal for owner or admin modes such as `-q` and `-a`.
            (_, false) => return Err(ChannelFailure::Rejected(EngineMessageKey::CommandRefused)),
        };
        return member.apply(client, channel, request, argument.unwrap_or_default());
    }
    Ok(match (mode, set, argument) {
        ('k', true, Some(key)) => request.key(papo::Secret::new(key)),
        ('k', false, key) => {
            request.remove_key(papo::Secret::new(key.unwrap_or_else(|| "*".into())))
        }
        (_, true, Some(argument)) => request.add_with(mode, argument),
        (_, false, Some(argument)) => request.remove_with(mode, argument),
        (_, true, None) => request.add(mode),
        (_, false, None) => request.remove(mode),
    })
}

fn require_member(
    client: &papo::Client,
    channel: &ChannelTarget,
    nick: &str,
) -> Result<(), ChannelFailure> {
    if let ChannelTarget::Known(name) = channel
        && crate::name_key::known_channel(&client.snapshot(), name)
            .is_some_and(|joined| joined.member(nick).ok().flatten().is_none())
    {
        return Err(ChannelFailure::Rejected(EngineMessageKey::NickNotInChannel));
    }
    Ok(())
}

enum ChannelFailure {
    Request(papo::Error),
    Refused(papo::Refusal),
    Rejected(EngineMessageKey),
}

impl From<papo::Error> for ChannelFailure {
    fn from(error: papo::Error) -> Self {
        Self::Request(error)
    }
}

fn modes_settled(outcome: &papo::ModesOutcome) -> Result<(), ChannelFailure> {
    if !outcome.applied.is_empty() {
        return Ok(());
    }
    Err(match (outcome.refused.first(), outcome.failed.first()) {
        (Some((_, refusal)), _) => ChannelFailure::Refused(*refusal),
        (None, Some((_, error))) => ChannelFailure::Request(error.clone()),
        (None, None) => ChannelFailure::Rejected(EngineMessageKey::CommandRefused),
    })
}

struct RefusalNames {
    target: String,
    nick: Option<String>,
}

fn spawn_channel_request<T: Send + 'static>(
    outbound: mpsc::UnboundedSender<EngineToUi>,
    command_id: String,
    names: RefusalNames,
    request: impl std::future::Future<Output = Result<T, ChannelFailure>> + Send + 'static,
) {
    spawn_task(async move {
        let event = match request.await {
            Ok(_) => EngineToUi::CommandResult { id: command_id },
            Err(failure) => channel_request_rejection(command_id, names, failure),
        };
        let _ = outbound.send(event);
    });
}

fn channel_request_rejection(
    command_id: String,
    names: RefusalNames,
    failure: ChannelFailure,
) -> EngineToUi {
    let about_nick = names.nick.is_some();
    let message_key = match failure {
        ChannelFailure::Request(papo::Error::Server(error)) => {
            channel_refusal_key(error.refusal(), about_nick)
        }
        ChannelFailure::Request(papo::Error::TargetGone) if about_nick => {
            Some(EngineMessageKey::NickNotFound)
        }
        ChannelFailure::Request(_) => None,
        ChannelFailure::Refused(refusal) => channel_refusal_key(refusal, about_nick),
        ChannelFailure::Rejected(key) => Some(key),
    };
    let Some(message_key) = message_key else {
        return command_rejection(command_id, EngineMessageKey::CommandRefused);
    };
    let mut values = BTreeMap::from([("target".into(), names.target)]);
    if let Some(nick) = names.nick {
        values.insert("nick".into(), nick);
    }
    EngineToUi::CommandRejected {
        id: command_id,
        message_key,
        values: Some(values),
    }
}

fn channel_refusal_key(refusal: papo::Refusal, about_nick: bool) -> Option<EngineMessageKey> {
    match refusal {
        papo::Refusal::NoSuchChannel | papo::Refusal::NotOnChannel => {
            Some(EngineMessageKey::NotInChannel)
        }
        papo::Refusal::ChannelOperatorPrivilegesNeeded => {
            Some(EngineMessageKey::ChannelOperatorRequired)
        }
        papo::Refusal::NoSuchNick if about_nick => Some(EngineMessageKey::NickNotFound),
        papo::Refusal::UserNotInChannel if about_nick => Some(EngineMessageKey::NickNotInChannel),
        papo::Refusal::UserOnChannel if about_nick => Some(EngineMessageKey::NickAlreadyInChannel),
        papo::Refusal::UnknownMode | papo::Refusal::UnknownUserMode => {
            Some(EngineMessageKey::ModeUnknown)
        }
        _ => None,
    }
}

fn spawn_join_request<T: Send + 'static>(
    outbound: mpsc::UnboundedSender<EngineToUi>,
    command_id: String,
    request: impl std::future::Future<Output = Result<T, papo::Error>> + Send + 'static,
) {
    spawn_task(async move {
        let events = match request.await {
            Ok(_) => vec![EngineToUi::CommandResult { id: command_id }],
            Err(error) => join_request_events(command_id, &error),
        };
        send_events(&outbound, events);
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

mod away_check;
mod gap_fill;

use gap_fill::{catch_up_gap_fill, spawn_gap_fill};

#[cfg(test)]
mod tests {
    use crate::{
        direct_peer::DirectPeer,
        name_key::NameKey,
        peer_pin::{PeerPin, PinMismatch},
        test_events::NextEvent,
    };
    mod away_check;
    mod direct_routing;
    mod gap_fill;
    mod history_integrity;
    mod mentions;
    mod redaction;
    mod server_buffer;

    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::{Duration, UNIX_EPOCH},
    };

    use papo_testing::{ConnectedBuilder, Wire, wire};
    use tokio::sync::mpsc;

    use super::{
        AuthenticationKind, ChatListSync, ConnectionAuthentication, ConnectionIdentity,
        ConnectionTransition, HistoryPageBounds, HostedReconnectConfig, MemberViews, NickMatch,
        PUSH_REFRESH_INTERVAL, PushRegistration, QueuedSend, READ_RETRY_INITIAL, READ_RETRY_MAX,
        ReadRetryState, RunningNetwork, Runtime, RuntimeState,
        SNAPSHOT_WRITE_IMMEDIATE_RETRY_ATTEMPTS, attach_shell, completion_context,
        connection_failure_notice, drain_events, fetch_history, finish_history_page,
        flush_pending_sends, join_request_events, launch_monitor_budget, lock,
        monitor_shown_direct_peers, next_connection_state, permanent_mark_read_error,
        person_candidates, process_event, process_history, queue_read_advance, read_retry_delay,
        record_read_advances, restore_target_rows, schedule_snapshot_write, spawn_history_fetch,
        spawn_online_direct_resolution, spawn_read_marker_fetch, spawn_target_reconciliation,
        start_read_flush, state_limit_events, target_sync_boundary, update_chat_list, utf16_len,
    };
    use crate::{
        BufferId, BufferKind, CompletionCandidate, CompletionTrigger, ConnectionFailureReason,
        EngineMessageKey, EngineRequest, EngineRequestEnvelope, EngineToUi, MessageDelivery,
        MessageId, NetworkConnectionState, NetworkId, NetworkProjection, PushState,
        SaslCredentials,
        chat_list_snapshot::{
            ChatListSnapshot, SnapshotChanges, SnapshotConversation, SnapshotCursor, SnapshotRow,
            read,
        },
        commands::{self, CommandPermission, CommandRequirement, CommandSpec, ConfirmPolicy},
        pushed_messages::PushedMessage,
        read_model::{MessageStub, ServerTimeMs},
        state::{
            DirectAvailability, HistoryCursor, HistoryFetch, HistoryTarget, NetworkModel,
            PendingSend, ReadAdvance, SendTarget,
        },
        storage::{KvBackend, MemoryKv, Operation, Space},
        timeline::FixedOffsetCalendar,
    };

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

    fn cached_direct_snapshot() -> ChatListSnapshot {
        ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "alice".into(),
                last_activity_ms: Some(100),
                preview: Some("alice: cached".into()),
                newest: Some(SnapshotCursor {
                    msgid: Some("cached".into()),
                    server_time_ms: 100,
                }),
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                stubs: snapshot_stubs(1, 1, 100),
                redacted_stubs: Vec::new(),
                gap_until: None,
                peer_pin: None,
                peer_bot: false,
            }],
        )
    }

    fn pushed_channel_message(msgid: &str, text: &str) -> PushedMessage {
        serde_json::from_value(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": msgid,
            "time": "2026-11-03T12:34:56.789Z",
            "text": text,
            "kind": "message",
        }))
        .expect("pushed message")
    }

    fn event_timeline_messages(event: &EngineToUi) -> Vec<&crate::MessageProjection> {
        let EngineToUi::TimelineChanged { upserted, .. } = event else {
            return Vec::new();
        };
        upserted
            .iter()
            .filter_map(|item| match &item.body {
                crate::timeline::ItemBody::Message(message) => Some(message),
                crate::timeline::ItemBody::System(_) | crate::timeline::ItemBody::Gap(_) => None,
            })
            .collect()
    }

    fn changed_messages(events: &[EngineToUi]) -> Vec<(BufferId, crate::MessageProjection)> {
        events
            .iter()
            .flat_map(|event| {
                let buffer_id = match event {
                    EngineToUi::TimelineChanged { buffer_id, .. } => Some(*buffer_id),
                    _ => None,
                };
                event_timeline_messages(event)
                    .into_iter()
                    .filter_map(move |message| Some((buffer_id?, message.clone())))
            })
            .collect()
    }

    #[test]
    fn wasm_reachable_runtime_uses_the_platform_delay() {
        let production = include_str!("runtime.rs")
            .rsplit_once("\n#[cfg(test)]\nmod tests")
            .map_or(include_str!("runtime.rs"), |(production, _)| production);
        let native_delay = r#"#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
async fn delay(duration: Duration) {
    tokio::time::sleep(duration).await;
}"#;
        let wasm_reachable = production.replacen(native_delay, "", 1);

        assert!(production.contains(native_delay));
        assert!(!wasm_reachable.contains("tokio::time"));
    }

    #[test]
    fn target_boundary_uses_the_query_upper_bound_only_for_complete_results() {
        let upper_bound = UNIX_EPOCH + Duration::from_secs(200);

        assert_eq!(
            target_sync_boundary(true, 2, 1, upper_bound),
            Some(upper_bound)
        );
        assert_eq!(target_sync_boundary(true, 1_000, 1, upper_bound), None);
        assert_eq!(target_sync_boundary(true, 101, 101, upper_bound), None);
        assert_eq!(
            target_sync_boundary(true, 0, 0, upper_bound),
            Some(upper_bound)
        );
    }

    #[tokio::test]
    async fn pushed_ready_buffer_refresh_does_not_create_a_gap() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["draft/chathistory", "message-tags", "server-time"])
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;

        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_channel(&channel)
            .expect("joined channel has a buffer");
        model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("initial history starts");
        wire.server("@time=1970-01-01T00:00:00.100Z;msgid=authoritative-edge :alice!a@host PRIVMSG #room :authoritative history")
            .await;
        let history = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        let papo::Event::Message(history) = history else {
            panic!("history message expected")
        };
        model.receive(&history, true, &client.snapshot(), None);
        let newest = HistoryCursor::new(Some("authoritative-edge".into()), 100);
        model
            .finish_history(
                &NameKey::Channel(channel.clone()),
                Some(papo::HistoryReference::from(papo::MessageId::from(
                    "authoritative-edge",
                ))),
                Some(100),
                None,
                1,
                false,
            )
            .expect("initial history finishes");
        let pushed = pushed_channel_message("pushed-edge", "provisional while suspended");
        model.restore_pushed_messages(vec![pushed], &client.snapshot());
        let pushed_buffer_id = changed_messages(&model.take_timeline_changes(false))
            .first()
            .map(|(buffer_id, _)| *buffer_id)
            .expect("pushed message is restored");
        assert_eq!(pushed_buffer_id, buffer_id);

        let fetch = model
            .request_history(buffer_id, crate::HistoryDirection::Latest)
            .expect("provisional edge requests authority");
        assert!(
            matches!(
                &fetch,
                HistoryFetch::After {
                    target: HistoryTarget::Channel(target),
                    newest: cursor,
                } if target == &channel && cursor == &newest
            ),
            "{fetch:?}"
        );
        let conversation = NameKey::Channel(channel);
        let load = model.history_load(&conversation);
        _ = finish_history_page(
            &mut model,
            load,
            &conversation,
            HistoryPageBounds {
                oldest: Some(papo::HistoryReference::from(papo::MessageId::from(
                    "pushed-edge",
                ))),
                oldest_time_ms: Some(200),
                newest: Some(HistoryCursor::new(Some("pushed-edge".into()), 200)),
            },
            1,
            true,
        );

        assert!(
            !changed_messages(&model.take_timeline_changes(false))
                .iter()
                .any(|(_, message)| {
                    message.text == "Some messages were skipped while reconnecting."
                })
        );
        assert_eq!(
            model.chat_list_snapshot("network".into()).rows[0].gap_until,
            None
        );
    }

    fn runtime_state(network: RunningNetwork) -> RuntimeState {
        RuntimeState {
            calendar: Arc::new(FixedOffsetCalendar::default()),
            next_network_id: 2,
            next_instance: 2,
            member_views: MemberViews::default(),
            storage: Arc::default(),
            snapshot_writer: Arc::default(),
            cached_snapshot: None,
            cached_pushed_messages: Vec::new(),
            build_version: "weblounge test".into(),
            update_ready: false,
            inflight_send_cancel: None,
            network: Some(network),
        }
    }

    fn set_harness_device_online(state: &Arc<Mutex<RuntimeState>>, online: bool) {
        let mut state = lock(state);
        let running = state.network.as_mut().expect("network remains active");
        running.device_online = online;
        if !online {
            running.model.set_connection(
                NetworkConnectionState::Offline {
                    reason: crate::OfflineReason::DeviceOffline,
                },
                None,
            );
        }
    }

    #[tokio::test]
    async fn snapshot_writer_keeps_changes_queued_before_its_task_runs() {
        let storage = Arc::new(MemoryKv::default());
        let writer = Arc::default();
        let empty = ChatListSnapshot::new("network".into(), Vec::new());
        let first = ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#room".into(),
                },
                title: "#room".into(),
                last_activity_ms: None,
                stubs: Vec::new(),
                redacted_stubs: Vec::new(),
                gap_until: None,
                preview: None,
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
                peer_bot: false,
            }],
        );
        let second = ChatListSnapshot::new(
            "network".into(),
            vec![
                first.rows[0].clone(),
                SnapshotRow {
                    conversation: SnapshotConversation::Direct {
                        key: "alice".into(),
                    },
                    title: "Alice".into(),
                    last_activity_ms: Some(100),
                    stubs: Vec::new(),
                    redacted_stubs: Vec::new(),
                    gap_until: None,
                    preview: Some("hello".into()),
                    newest: None,
                    read_at_ms: None,
                    raw_read_at_ms: None,
                    pending_read_at_ms: None,
                    peer_pin: None,
                    peer_bot: false,
                },
            ],
        );
        schedule_snapshot_write(
            Arc::clone(&storage),
            Arc::clone(&writer),
            SnapshotChanges::between(&empty, &first, Vec::new(), Vec::new())
                .expect("first row changed"),
        );
        schedule_snapshot_write(
            Arc::clone(&storage),
            Arc::clone(&writer),
            SnapshotChanges::between(&first, &second, Vec::new(), Vec::new())
                .expect("second row changed"),
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let stored = read(storage.as_ref())
                    .await
                    .expect("read")
                    .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
                if stored == Some(second.clone()) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both queued rows persist");
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_writer_retries_without_a_readiness_gate() {
        let storage = Arc::new(MemoryKv::default());
        let writer = Arc::default();
        let empty = ChatListSnapshot::new("network".into(), Vec::new());
        let snapshot = ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(100),
                preview: Some("hello".into()),
                newest: None,
                read_at_ms: Some(100),
                raw_read_at_ms: Some(100),
                pending_read_at_ms: Some(100),
                stubs: Vec::new(),
                redacted_stubs: Vec::new(),
                gap_until: None,
                peer_pin: None,
                peer_bot: false,
            }],
        );
        storage.fail_next_commit();
        schedule_snapshot_write(
            Arc::clone(&storage),
            Arc::clone(&writer),
            SnapshotChanges::between(&empty, &snapshot, Vec::new(), Vec::new())
                .expect("mark changed"),
        );

        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        let stored = read(storage.as_ref())
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
        assert_eq!(stored, Some(snapshot));
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_writer_keeps_a_failed_delta_until_storage_recovers() {
        let storage = Arc::new(MemoryKv::default());
        let writer = Arc::default();
        let before = ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "Alice".into(),
                last_activity_ms: Some(100),
                preview: Some("hours stale".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                stubs: Vec::new(),
                redacted_stubs: Vec::new(),
                gap_until: None,
                peer_pin: None,
                peer_bot: false,
            }],
        );
        crate::chat_list_snapshot::write(storage.as_ref(), &before)
            .await
            .expect("seed stale snapshot");
        let mut lost = before.clone();
        lost.rows[0].last_activity_ms = Some(200);
        lost.rows[0].preview = Some("current after recovery".into());
        for _ in 0..=SNAPSHOT_WRITE_IMMEDIATE_RETRY_ATTEMPTS {
            storage.fail_next_commit();
        }
        schedule_snapshot_write(
            Arc::clone(&storage),
            Arc::clone(&writer),
            SnapshotChanges::between(&before, &lost, Vec::new(), Vec::new())
                .expect("first row changed"),
        );
        tokio::task::yield_now().await;

        let mut later = lost.clone();
        later.rows.push(SnapshotRow {
            conversation: SnapshotConversation::Channel {
                key: "#later".into(),
            },
            title: "#later".into(),
            last_activity_ms: Some(300),
            preview: Some("later change".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            stubs: Vec::new(),
            redacted_stubs: Vec::new(),
            gap_until: None,
            peer_pin: None,
            peer_bot: false,
        });
        schedule_snapshot_write(
            Arc::clone(&storage),
            Arc::clone(&writer),
            SnapshotChanges::between(&lost, &later, Vec::new(), Vec::new())
                .expect("later row changed"),
        );

        tokio::time::advance(READ_RETRY_INITIAL).await;
        tokio::task::yield_now().await;
        let stored = read(storage.as_ref())
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
        assert_eq!(stored, Some(later));
    }

    #[test]
    fn connection_state_table_covers_resilient_transitions() {
        let now = std::time::UNIX_EPOCH + Duration::from_secs(100);
        let failed_auth = crate::NetworkConnectionState::Failed {
            reason: crate::ConnectionFailureReason::Authentication,
            message_key: EngineMessageKey::HostedAuthFailed,
        };
        let cases = [
            (
                "transport starts connecting",
                crate::NetworkConnectionState::Offline {
                    reason: crate::OfflineReason::Requested,
                },
                ConnectionTransition::Connecting { registering: false },
                crate::NetworkConnectionState::Connecting,
            ),
            (
                "registration follows transport",
                crate::NetworkConnectionState::Connecting,
                ConnectionTransition::Connecting { registering: true },
                crate::NetworkConnectionState::Registering,
            ),
            (
                "registration becomes online",
                crate::NetworkConnectionState::Registering,
                ConnectionTransition::Connected,
                crate::NetworkConnectionState::Online,
            ),
            (
                "ping timeout schedules papo retry",
                crate::NetworkConnectionState::Online,
                ConnectionTransition::Disconnected {
                    event: disconnected(
                        papo::DisconnectCause::PingTimeout,
                        Some(Duration::from_secs(2)),
                    ),
                    attempt: 3,
                    hosted_authentication_failed: false,
                    device_online: true,
                },
                crate::NetworkConnectionState::Reconnecting {
                    attempt: 3,
                    next_retry_at_ms: 102_000,
                },
            ),
            (
                "device loss becomes offline",
                crate::NetworkConnectionState::Online,
                ConnectionTransition::DeviceOffline,
                crate::NetworkConnectionState::Offline {
                    reason: crate::OfflineReason::DeviceOffline,
                },
            ),
            (
                "device recovery retries immediately",
                crate::NetworkConnectionState::Offline {
                    reason: crate::OfflineReason::DeviceOffline,
                },
                ConnectionTransition::ManualRetry,
                crate::NetworkConnectionState::Connecting,
            ),
            (
                "authentication expiry requires sign-in",
                crate::NetworkConnectionState::Online,
                ConnectionTransition::AuthenticationExpired,
                failed_auth.clone(),
            ),
            (
                "manual retry leaves failure",
                failed_auth,
                ConnectionTransition::ManualRetry,
                crate::NetworkConnectionState::Connecting,
            ),
        ];

        for (name, current, transition, expected) in cases {
            assert_eq!(
                next_connection_state(&current, transition, now),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn unexpected_disconnects_emit_a_human_notice() {
        let disconnected = disconnected(papo::DisconnectCause::PingTimeout, None);
        assert!(matches!(
            connection_failure_notice(&disconnected, false),
            Some(EngineToUi::Notice { key, .. })
                if key == EngineMessageKey::ConnectionFailed.as_str()
        ));
    }

    #[test]
    fn reconnecting_disconnects_do_not_emit_a_failure_notice() {
        let disconnected = disconnected(
            papo::DisconnectCause::PingTimeout,
            Some(Duration::from_secs(1)),
        );

        assert_eq!(connection_failure_notice(&disconnected, false), None);
    }

    #[test]
    fn unsupported_browser_scheme_is_a_human_connection_rejection() {
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);

        assert_eq!(
            runtime.request(EngineRequestEnvelope {
                id: "unsupported-scheme".into(),
                request: EngineRequest::Connect {
                    label: "Test".into(),
                    endpoint: "irc://offline.test".into(),
                    nickname: "weblounge".into(),
                    sasl: SaslCredentials {
                        account: "weblounge".into(),
                        password: "secret".into(),
                    },
                    autojoin: Vec::new(),
                    allow_insecure: false,
                },
            }),
            [EngineToUi::CommandRejected {
                id: "unsupported-scheme".into(),
                message_key: EngineMessageKey::InvalidEndpoint,
                values: None,
            }]
        );
    }

    #[tokio::test]
    async fn hosted_authentication_uses_papos_redacting_oauth_bearer() {
        let sasl = ConnectionAuthentication::HostedOAuth {
            token: papo::Secret::new("oauth-token-7391"),
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
    fn hosted_profile_projects_restored_chats_once_before_a_token_exists() {
        let endpoint = "wss://beta.weblounge.org/socket";
        let snapshot = ChatListSnapshot::new(
            crate::chat_list_snapshot::fingerprint("weblounge", endpoint),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Channel {
                    key: "#lounge".into(),
                },
                title: "#lounge".into(),
                last_activity_ms: None,
                stubs: snapshot_stubs(1, 0, 1),
                redacted_stubs: Vec::new(),
                gap_until: None,
                preview: Some("cached before credentials".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
                peer_bot: false,
            }],
        );
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::with_storage(
            outbound,
            Arc::new(MemoryKv::default()),
            Some(snapshot.encode().expect("snapshot encodes")),
            Vec::new(),
            "weblounge test".into(),
            Arc::new(FixedOffsetCalendar::default()),
        );

        let output = runtime.request(EngineRequestEnvelope {
            id: "prepare".into(),
            request: EngineRequest::PrepareHosted {
                label: "weblounge".into(),
                endpoint: endpoint.into(),
                nickname: "*".into(),
                autojoin: vec!["#lounge".into()],
            },
        });

        assert!(matches!(
            output.as_slice(),
            [
                EngineToUi::NetworkStateChanged { .. },
                EngineToUi::BuffersChanged { buffers, .. },
                EngineToUi::CommandResult { id },
            ] if id == "prepare" && buffers.iter().any(|buffer| buffer.title == "#lounge")
        ));
        let state = lock(&runtime.state);
        let running = state.network.as_ref().expect("hosted profile is retained");
        assert_eq!(running.identity.kind(), AuthenticationKind::HostedOAuth);
        assert!(running.hosted_reconnect.is_some());
    }

    #[tokio::test]
    async fn hosted_profile_restores_pushed_messages_before_a_token_exists() {
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Lounge",
            "nickname": "weblounge",
            "sender": "mel",
            "target": "#lounge",
            "msgid": "push-before-connect",
            "time": "2026-11-03T12:34:56.789Z",
            "text": "visible before history",
            "kind": "message",
        }))
        .expect("pushed message");
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let storage = Arc::new(MemoryKv::default());
        let runtime = Runtime::with_storage(
            outbound,
            Arc::clone(&storage),
            None,
            vec![pushed],
            "weblounge test".into(),
            Arc::new(FixedOffsetCalendar::default()),
        );

        let output = runtime.request(EngineRequestEnvelope {
            id: "prepare".into(),
            request: EngineRequest::PrepareHosted {
                label: "Lounge".into(),
                endpoint: "wss://beta.weblounge.org/socket".into(),
                nickname: "weblounge".into(),
                autojoin: vec!["#lounge".into()],
            },
        });

        assert!(changed_messages(&output).iter().any(|(_, message)| {
            message.text == "visible before history"
                && message.server_ids == ["push-before-connect"]
        }));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::PushedMessagesLoaded {
                network_id: NetworkId(1)
            }
        )));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let stored = read(storage.as_ref())
                    .await
                    .expect("read snapshot")
                    .and_then(|bytes| {
                        ChatListSnapshot::decode(
                            &bytes,
                            &crate::chat_list_snapshot::fingerprint(
                                "Lounge",
                                "wss://beta.weblounge.org/socket",
                            ),
                        )
                    });
                if stored.as_ref().is_some_and(|snapshot| {
                    snapshot.rows.iter().any(|row| {
                        row.title == "#lounge"
                            && row.preview.as_deref() == Some("mel: visible before history")
                    })
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restored pushed row is persisted");
    }

    #[tokio::test]
    async fn running_network_loads_new_service_worker_messages() {
        let storage = Arc::new(MemoryKv::default());
        storage
            .commit(
                Space::Cache,
                vec![Operation::Put {
                    key: b"pushed-message\0Test\0warm-push".to_vec(),
                    value: br##"{"schema":1,"network_label":"Test","nickname":"weblounge","sender":"mel","target":"#lounge","msgid":"warm-push","time":"2026-11-03T12:34:56.789Z","text":"loaded into the open app","kind":"message"}"##.to_vec(),
                }],
            )
            .await
            .expect("seed pushed message");
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client);
        {
            let mut state = lock(&state);
            state.storage = Arc::clone(&storage);
            state
                .network
                .as_mut()
                .expect("network remains active")
                .chat_list
                .fingerprint = "network".into();
        }
        let runtime = Runtime { state, outbound };
        mark_runtime_online(&runtime);

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "load-push".into(),
                    request: EngineRequest::LoadPushedMessages {
                        network_id: NetworkId(1),
                    },
                })
                .is_empty()
        );
        let events = tokio::time::timeout(Duration::from_secs(1), async {
            let mut events = Vec::new();
            let mut command_complete = false;
            let mut timeline_complete = false;
            loop {
                let event = receiver.recv().await.expect("runtime event");
                command_complete |= matches!(
                    &event,
                    EngineToUi::CommandResult { id } if id == "load-push"
                );
                timeline_complete |= matches!(event, EngineToUi::TimelineChanged { .. });
                events.push(event);
                if command_complete && timeline_complete {
                    break events;
                }
            }
        })
        .await
        .expect("push load completes");

        assert!(
            changed_messages(&events)
                .iter()
                .any(|(_, message)| message.text == "loaded into the open app")
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, EngineToUi::BuffersChanged { .. }))
                .count(),
            2,
            "restoration and its pushed-history spawn both publish buffer state"
        );
        assert!(events.iter().any(|event| matches!(
            event,
            EngineToUi::TimelineChanged { upserted, .. }
                if matches!(
                    upserted.as_slice(),
                    [item] if matches!(
                        &item.body,
                        crate::timeline::ItemBody::Message(message)
                            if message.text == "loaded into the open app"
                    )
                )
        )));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let stored = read(storage.as_ref())
                    .await
                    .expect("read snapshot")
                    .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
                if stored.as_ref().is_some_and(|snapshot| {
                    snapshot.rows.iter().any(|row| {
                        row.title == "#lounge"
                            && row.preview.as_deref() == Some("mel: loaded into the open app")
                    })
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pushed chat-list row is persisted");
    }

    #[tokio::test]
    async fn restored_push_reconciles_before_a_late_marker_repairs_the_server() {
        let storage = Arc::new(MemoryKv::default());
        storage
            .commit(
                Space::Cache,
                vec![Operation::Put {
                    key: b"pushed-message\0Test\0warm-push".to_vec(),
                    value: br##"{"schema":1,"network_label":"Test","nickname":"weblounge","sender":"mel","target":"#room","msgid":"warm-push","time":"2026-11-03T12:34:56.789Z","text":"loaded into the open app","kind":"message"}"##.to_vec(),
                }],
            )
            .await
            .expect("seed pushed message");
        let caps = [
            "batch",
            "draft/chathistory",
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
        let (state, outbound, mut receiver) = harness(client.clone());
        lock(&state).storage = storage;
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };
        mark_runtime_online(&runtime);

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "load-push".into(),
                    request: EngineRequest::LoadPushedMessages {
                        network_id: NetworkId(1),
                    },
                })
                .is_empty()
        );
        let latest = next_sent_containing(&mut wire, "CHATHISTORY LATEST #room").await;
        send_history_page(
            &mut wire,
            request_label(&latest),
            &["time=2026-11-03T12:34:56.790Z;msgid=warm-push :mel!u@host PRIVMSG #room :loaded into the open app"],
        )
        .await;
        let output = tokio::time::timeout(Duration::from_secs(1), async {
            let mut output = Vec::new();
            loop {
                let event = receiver.recv().await.expect("runtime event");
                output.push(event);
                if changed_messages(&output)
                    .iter()
                    .any(|(_, message)| message.server_time_ms == Some(1_793_709_296_790))
                {
                    break output;
                }
            }
        })
        .await
        .expect("push load completes");

        assert!(
            changed_messages(&output)
                .iter()
                .any(|(_, message)| message.text == "loaded into the open app")
        );
        assert_eq!(
            output
                .iter()
                .filter(|event| matches!(event, EngineToUi::BuffersChanged { .. }))
                .count(),
            2,
            "restoration and its history fetch both publish buffer state"
        );

        wire.server(":offline.test MARKREAD #room timestamp=2026-11-03T12:34:56.789Z")
            .await;
        let marker = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ReadMarkerChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, marker);

        let repair = wire.next_sent().await;
        assert!(repair.ends_with("MARKREAD #room timestamp=2026-11-03T12:34:56.790Z"));
        let label = request_label(&repair);
        wire.server(format!(
            "@label={label} :offline.test MARKREAD #room timestamp=2026-11-03T12:34:56.790Z"
        ))
        .await;
        assert_read_flush_settles_without_another_request(&state, &mut wire).await;
    }

    #[tokio::test]
    async fn loading_a_late_push_flushes_its_reconciled_read_carry() {
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
        let (state, outbound, _receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        wire.server("@time=2026-11-03T12:34:56.790Z;msgid=late-push :alice!u@host PRIVMSG #room :loaded late")
            .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        wire.server(":offline.test MARKREAD #room timestamp=2026-11-03T12:34:56.789Z")
            .await;
        let marker = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ReadMarkerChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, marker);
        let storage = Arc::new(MemoryKv::default());
        storage
            .commit(
                Space::Cache,
                vec![Operation::Put {
                    key: b"pushed-message\0Test\0late-push".to_vec(),
                    value: br##"{"schema":1,"network_label":"Test","nickname":"weblounge","sender":"alice","target":"#room","msgid":"late-push","time":"2026-11-03T12:34:56.789Z","text":"loaded late","kind":"message"}"##.to_vec(),
                }],
            )
            .await
            .expect("seed pushed message");
        lock(&state).storage = storage;

        _ = Runtime {
            state: Arc::clone(&state),
            outbound,
        }
        .request(EngineRequestEnvelope {
            id: "load-late-push".into(),
            request: EngineRequest::LoadPushedMessages {
                network_id: NetworkId(1),
            },
        });

        let repair = wire.next_sent().await;
        assert!(repair.ends_with("MARKREAD #room timestamp=2026-11-03T12:34:56.790Z"));
    }

    #[tokio::test]
    async fn post_registration_sasl_failure_warning_keeps_the_network_online() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        mark_runtime_online(&runtime);

        wire.server(":offline.test 904 weblounge :SASL authentication failed")
            .await;
        let warning = next_matching(&mut events, |event| {
            matches!(
                event,
                papo::Event::Warning(papo::event::Warning::AuthenticationFailed { .. })
            )
        })
        .await;
        process_runtime_event(&runtime, warning);

        assert_eq!(
            lock(&runtime.state)
                .network
                .as_ref()
                .expect("network remains running")
                .model
                .connection(),
            &crate::NetworkConnectionState::Online
        );
        assert!(collect(&mut receiver).is_empty());
    }

    #[test]
    fn completion_context_recognizes_triggers_and_command_arguments() {
        let registry = commands::built_in_registry();
        for (input, explicit, trigger, prefix, start, hint, before, after) in [
            (
                "/jo",
                false,
                CompletionTrigger::Command,
                "jo",
                0,
                None,
                "/",
                " ",
            ),
            (
                "@an",
                false,
                CompletionTrigger::Person,
                "an",
                0,
                None,
                "",
                ": ",
            ),
            (
                "hello @an",
                false,
                CompletionTrigger::Person,
                "an",
                6,
                None,
                "",
                "",
            ),
            (
                "#we",
                false,
                CompletionTrigger::Channel,
                "#we",
                0,
                None,
                "",
                "",
            ),
            (
                "/msg ",
                false,
                CompletionTrigger::Person,
                "",
                5,
                Some("msg"),
                "",
                " ",
            ),
            (
                "/join ",
                false,
                CompletionTrigger::Channel,
                "",
                6,
                Some("join"),
                "",
                " ",
            ),
            (
                "an",
                true,
                CompletionTrigger::Person,
                "an",
                0,
                None,
                "",
                ": ",
            ),
            (
                "hello an",
                true,
                CompletionTrigger::Person,
                "an",
                6,
                None,
                "",
                "",
            ),
        ] {
            let context = completion_context(input, utf16_len(input), explicit, "#&", &registry)
                .expect("context");
            assert_eq!(context.trigger, Some(trigger));
            assert_eq!(context.prefix, prefix);
            assert_eq!(context.replace_start, start);
            assert_eq!(context.usage.map(|usage| usage.name).as_deref(), hint);
            assert_eq!(context.replacement_prefix, before);
            assert_eq!(context.replacement_suffix, after);
        }
        assert!(completion_context("mail@an", 7, false, "#&", &registry).is_none());
        assert!(completion_context("hello /jo", 9, false, "#&", &registry).is_none());
        assert!(completion_context("hello al", 8, true, "#&", &registry).is_some());
    }

    #[test]
    fn kick_completes_a_nick_as_its_first_argument() {
        let registry = commands::built_in_registry();
        let context = completion_context("/kick me", 8, false, "#&", &registry).expect("context");
        assert_eq!(context.trigger, Some(CompletionTrigger::Person));
        assert_eq!(context.prefix, "me");
        assert_eq!(context.replace_start, 6);
        assert_eq!(
            context
                .usage
                .map(|usage| (usage.name, usage.active_argument)),
            Some(("kick".to_owned(), 0))
        );
    }

    #[test]
    fn a_reason_after_a_defaulted_channel_offers_no_channels() {
        let registry = commands::built_in_registry();
        let reason = completion_context("/part see", 9, false, "#&", &registry).expect("context");
        assert_eq!(reason.trigger, None);
        assert_eq!(reason.usage.map(|usage| usage.active_argument), Some(1));
        let channel = completion_context("/part #de", 9, false, "#&", &registry).expect("context");
        assert_eq!(channel.trigger, Some(CompletionTrigger::Channel));
        assert_eq!(channel.prefix, "#de");
    }

    #[test]
    fn a_command_argument_without_candidates_still_reports_its_usage() {
        let registry = commands::built_in_registry();
        let input = "/kick mel link spam";
        let reason =
            completion_context(input, utf16_len(input), false, "#&", &registry).expect("context");
        assert_eq!(reason.trigger, None);
        assert_eq!((reason.replace_start, reason.replace_end), (19, 19));
        assert_eq!(
            reason
                .usage
                .map(|usage| (usage.name, usage.active_argument)),
            Some(("kick".to_owned(), 1))
        );

        let mention =
            completion_context("/me waves at @al", 16, false, "#&", &registry).expect("context");
        assert_eq!(mention.trigger, Some(CompletionTrigger::Person));
        assert_eq!(mention.usage.map(|usage| usage.name).as_deref(), Some("me"));

        assert!(completion_context("/whois mel", 10, false, "#&", &registry).is_none());
        assert!(completion_context("/close ", 7, false, "#&", &registry).is_none());
    }

    #[test]
    fn command_usage_follows_the_caret_in_utf16_offsets() {
        let registry = commands::built_in_registry();
        let channels =
            completion_context("/join #dev sekrit", 7, false, "#&", &registry).expect("context");
        assert_eq!(channels.usage.map(|usage| usage.active_argument), Some(0));

        let input = "/topic 😀 x";
        let caret = utf16_len(input);
        let topic = completion_context(input, caret, false, "#&", &registry).expect("context");
        assert_eq!(caret, 11);
        assert_eq!((topic.trigger, topic.replace_start), (None, caret));
        assert_eq!(topic.usage.map(|usage| usage.active_argument), Some(1));

        let input = "/kick 😀 ";
        let kick =
            completion_context(input, utf16_len(input), false, "#&", &registry).expect("context");
        assert_eq!(kick.replace_end, 9);
        assert_eq!(kick.usage.map(|usage| usage.active_argument), Some(1));
    }

    #[test]
    fn a_nick_list_offers_no_member_until_the_next_nick_is_typed() {
        let registry = commands::built_in_registry();
        let first = completion_context("/op ", 4, false, "#&", &registry).expect("context");
        assert_eq!(first.trigger, Some(CompletionTrigger::Person));
        let next = completion_context("/op mel ", 8, false, "#&", &registry).expect("context");
        assert_eq!(next.trigger, None);
        assert_eq!(next.usage.map(|usage| usage.name), Some("op".to_owned()));
    }

    #[test]
    fn member_mode_commands_complete_every_nick() {
        let registry = commands::built_in_registry();
        for (input, prefix, start) in [("/op me", "me", 4), ("/op mel ir", "ir", 8)] {
            let cursor = u32::try_from(input.len()).expect("short input");
            let context =
                completion_context(input, cursor, false, "#&", &registry).expect("context");
            assert_eq!(context.trigger, Some(CompletionTrigger::Person), "{input}");
            assert_eq!(context.prefix, prefix, "{input}");
            assert_eq!(context.replace_start, start, "{input}");
            assert_eq!(
                context
                    .usage
                    .map(|usage| (usage.name, usage.active_argument)),
                Some(("op".to_owned(), 0)),
                "{input}"
            );
        }
    }

    #[test]
    fn completion_context_ignores_a_first_word_ending_in_a_command_alias() {
        let registry = commands::built_in_registry();
        for word_ending_in_an_alias in ["im ", "im al", "Im ", "ij ", "xmsg al"] {
            assert!(
                completion_context(
                    word_ending_in_an_alias,
                    utf16_len(word_ending_in_an_alias),
                    false,
                    "#&",
                    &registry
                )
                .is_none(),
                "{word_ending_in_an_alias:?}"
            );
        }
    }

    #[test]
    fn completion_context_accepts_a_terminated_typed_mention() {
        let registry = commands::built_in_registry();
        for (input, prefix, start, suffix) in [
            ("@ana ", "ana", 0, ": "),
            ("@ana\n", "ana", 0, ":\n"),
            ("@ana,", "ana", 0, ","),
            ("@ana:", "ana", 0, ":"),
            ("hello @ana ", "ana", 6, " "),
            ("thanks @ana!", "ana", 7, "!"),
            ("(cc @ana)", "ana", 4, ")"),
            ("ping @ana-x;", "ana-x", 5, ";"),
            ("/me waves at @ana.", "ana", 13, "."),
            ("hi @ána?", "ána", 3, "?"),
        ] {
            let context = completion_context(input, utf16_len(input), false, "#&", &registry)
                .expect("context");
            assert!(context.auto_accept, "{input}");
            assert_eq!(context.trigger, Some(CompletionTrigger::Person), "{input}");
            assert_eq!(context.prefix, prefix, "{input}");
            assert_eq!(context.replace_start, start, "{input}");
            assert_eq!(context.replace_end, utf16_len(input), "{input}");
            assert_eq!(context.replacement_prefix, "", "{input}");
            assert_eq!(context.replacement_suffix, suffix, "{input}");
        }
        for input in ["@ ", "mail@ana ", "@ana", "hello ana ", "@ana-"] {
            assert!(
                completion_context(input, utf16_len(input), false, "#&", &registry)
                    .is_none_or(|context| !context.auto_accept),
                "{input}"
            );
        }
    }

    #[test]
    fn tab_after_a_typed_mention_suggests_instead_of_accepting() {
        let registry = commands::built_in_registry();
        let tab = completion_context("@ana ", 5, true, "#&", &registry).expect("context");
        assert!(!tab.auto_accept);
    }

    #[test]
    fn a_typed_mention_is_read_up_to_the_caret() {
        let registry = commands::built_in_registry();
        let caret = completion_context("@ana hi", 5, false, "#&", &registry).expect("context");
        assert_eq!(caret.replace_end, 5);
        assert!(caret.auto_accept);
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
            menu_label: None,
            requirements: vec![CommandRequirement::Feature("Reactions".into())],
            permission: CommandPermission::Anyone,
            surfaces: Vec::new(),
            confirm: ConfirmPolicy::None,
            completion_priority: commands::CompletionPriority::Other,
            confirmation_prompt: None,
            confirmation_action: None,
            secret_arguments: false,
        };
        assert!(!super::command_requirements_met(&spec, &client.snapshot()));
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
        let snapshot = client.snapshot();
        let rules = snapshot.name_rules().expect("seeded name rules");
        assert_eq!(rules.check_nick("alice"), papo::NameCheck::Unknown);
        assert!(matches!(
            rules.check_nick("bad nick"),
            papo::NameCheck::Invalid(_)
        ));
        drop(snapshot);
        assert!(super::valid_nick_input(&client.snapshot(), "alice"));
        assert!(!super::valid_nick_input(&client.snapshot(), "bad nick"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert_eq!(
            client
                .snapshot()
                .name_rules()
                .expect("registered name rules")
                .check_nick("alice"),
            papo::NameCheck::Valid
        );
        assert!(super::valid_nick_input(&client.snapshot(), "alice"));
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
            running.model.sync_channels(&client.snapshot());
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

    #[tokio::test]
    async fn resolving_a_direct_publishes_the_presence_papo_already_knows() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 100).await;
        let alice = known_nick(&client, "alice");
        let direct = DirectPeer::resolve(&client, &alice);
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        wire.server(":offline.test 730 weblounge :alice!~alice@cloak.example")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::MonitorOnline(_))
        })
        .await;
        wire.server(":alice!~alice@cloak.example AWAY").await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::AwayChanged(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let alice = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(
                direct.nick().clone(),
                DirectAvailability::Pending,
                &client.snapshot(),
            )
            .0;

        super::apply_direct_resolution(&state, &outbound, 1, alice, direct);

        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == alice
                    && buffer.peer_presence == Some(crate::PeerPresence::Online)
        )));
    }

    #[tokio::test]
    async fn monitor_presence_reaches_the_ui_as_a_direct_buffer_update() {
        let (client, mut events, mut wire, nick) =
            crate::direct_peer::test_support::monitoring_alice().await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let alice = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(nick, DirectAvailability::Pending, &client.snapshot())
            .0;
        let presence_updates = |receiver: &mut mpsc::UnboundedReceiver<EngineToUi>| {
            collect(receiver)
                .into_iter()
                .filter_map(|event| match event {
                    EngineToUi::BufferUpdated { buffer } if buffer.id == alice => {
                        Some(buffer.peer_presence)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };

        for (line, presence) in [
            (
                ":offline.test 730 weblounge :alice!~alice@cloak.example",
                vec![Some(crate::PeerPresence::Away)],
            ),
            (
                ":alice!~alice@cloak.example AWAY",
                vec![Some(crate::PeerPresence::Online)],
            ),
            (
                ":offline.test 731 weblounge :alice",
                vec![Some(crate::PeerPresence::Offline)],
            ),
        ] {
            wire.server(line).await;
            let event = next_matching(&mut events, crate::direct_peer::may_change).await;
            process_event(&state, &outbound, &client, 1, event);
            assert_eq!(presence_updates(&mut receiver), presence, "after {line}");
        }
    }

    #[tokio::test]
    async fn a_channel_who_reply_marks_a_shared_direct_peer_away() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["away-notify"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        for line in [
            ":weblounge!u@h JOIN #room",
            ":offline.test 353 weblounge = #room :weblounge alice",
            ":offline.test 366 weblounge #room :End of NAMES",
        ] {
            wire.server(line).await;
        }
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let nick = crate::name_key::known_user(&client.snapshot(), "alice")
            .map(|user| user.nick().clone())
            .expect("alice shares #room");
        let alice = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(nick, DirectAvailability::Pending, &client.snapshot())
            .0;

        for line in [
            ":offline.test 352 weblounge #room ~alice cloak.example offline.test alice G :0 Alice",
            ":offline.test 315 weblounge #room :End of WHO list",
        ] {
            wire.server(line).await;
        }
        let refreshed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::MembersRefreshed(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, refreshed);

        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == alice && buffer.peer_presence == Some(crate::PeerPresence::Away)
        )));
    }

    #[tokio::test]
    async fn a_bot_tagged_direct_message_marks_the_direct_as_a_bot() {
        let (client, mut events, mut wire, nick) =
            crate::direct_peer::test_support::monitoring_alice().await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let alice = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(nick, DirectAvailability::Pending, &client.snapshot())
            .0;

        for line in [
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            "@bot;msgid=beep;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :beep",
        ] {
            wire.server(line).await;
            let event = next_matching(&mut events, crate::direct_peer::may_change).await;
            process_event(&state, &outbound, &client, 1, event);
        }

        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::BufferUpdated { buffer } if buffer.id == alice && buffer.peer_bot
        )));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn channel_typing_projects_multiple_users_transitions_and_expiry() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        wire.register(&["message-tags"]).await;
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

        for line in [
            "@+typing=active :alice!u@host TAGMSG #room",
            "@+typing=paused :alice!u@host TAGMSG #room",
            "@+typing=active :bob!u@host TAGMSG #room",
        ] {
            wire.server(line).await;
            let changed = next_matching(&mut events, |event| {
                matches!(event, papo::Event::TypingChanged(_))
            })
            .await;
            process_event(&state, &outbound, &client, 1, changed);
        }
        let projected = collect(&mut receiver);
        assert!(projected.iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. }
                if typers.len() == 2
                    && typers[0].nick == "alice"
                    && typers[0].paused
                    && typers[1].nick == "bob"
                    && !typers[1].paused
        )));

        wire.server(":bob!u@host PRIVMSG #room :finished").await;
        let cleared = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, cleared);
        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. }
                if typers.len() == 1 && typers[0].nick == "alice"
        )));

        wire.server("@+typing=active :carol!u@host TAGMSG #room")
            .await;
        let active = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, active);
        _ = collect(&mut receiver);
        tokio::time::advance(Duration::from_secs(6)).await;
        let expired = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(changed)
                if changed.reason == papo::event::TypingReason::TimedOut)
        })
        .await;
        process_event(&state, &outbound, &client, 1, expired);
        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. }
                if typers.len() == 1 && typers[0].nick == "alice"
        )));
    }

    #[tokio::test]
    async fn direct_typing_uses_the_existing_buffer_and_ignores_own_state() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        wire.server(":alice!u@host PRIVMSG weblounge :hello").await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        _ = collect(&mut receiver);

        wire.server("@+typing=active :alice!u@host TAGMSG weblounge")
            .await;
        let active = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, active);
        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. }
                if typers.len() == 1 && typers[0].nick == "alice"
        )));

        wire.server("@+typing=active :weblounge!u@host TAGMSG alice")
            .await;
        let own = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, own);
        assert!(collect(&mut receiver).is_empty());

        wire.server("@+typing=done :alice!u@host TAGMSG weblounge")
            .await;
        let done = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, done);
        assert!(collect(&mut receiver).iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. } if typers.is_empty()
        )));
    }

    #[tokio::test]
    async fn direct_open_projects_typing_received_before_the_buffer_exists() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "WebLounge"));
        wire.register(&["account-tag", "message-tags", "server-time"])
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 100).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .set_connection(crate::NetworkConnectionState::Online, None);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        wire.server(
            "@account=alice-account;time=2026-11-06T12:34:56.789Z;+typing=active :Alice!u@host TAGMSG weblounge",
        )
        .await;
        let active = next_matching(&mut events, |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
        process_event(&state, &runtime.outbound, &client, 1, active);
        assert!(collect(&mut receiver).is_empty());

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "open-alice".into(),
                    request: EngineRequest::OpenDirect {
                        network_id: NetworkId(1),
                        nick: "alice".into(),
                        focus: true,
                    },
                })
                .is_empty()
        );
        assert_eq!(wire.next_sent().await, "MONITOR + alice");

        let mut output = Vec::new();
        loop {
            let event = receiver.recv().await.expect("direct capture completes");
            let complete = matches!(event, EngineToUi::CommandResult { .. });
            output.push(event);
            if complete {
                break;
            }
        }
        assert!(output.iter().any(|event| matches!(event,
            EngineToUi::TypingChanged { typers, .. }
                if typers.len() == 1 && typers[0].nick == "Alice" && !typers[0].paused
        )));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn composer_typing_is_throttled_paused_and_done_before_send() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, _receiver) = harness(client.clone());
        wire.server(":alice!u@host PRIVMSG #room :hello").await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        let buffer_id = lock(&state)
            .network
            .as_ref()
            .expect("network remains running")
            .model
            .buffer_id_for_channel(&known_channel(&client, "#room"))
            .expect("channel buffer exists");
        let runtime = Runtime { state, outbound };

        for (id, input) in [("first", "h"), ("second", "he")] {
            assert!(matches!(
                runtime.request(EngineRequestEnvelope {
                    id: id.into(),
                    request: EngineRequest::CompleteInput {
                        buffer_id,
                        input: input.into(),
                        cursor: u32::try_from(input.len()).expect("test input fits u32"),
                        explicit: false,
                    },
                })[..],
                [EngineToUi::CommandResult { .. }]
            ));
        }
        assert_eq!(wire.next_sent().await, "@+typing=active TAGMSG #room");
        tokio::time::advance(crate::typing::PAUSE_AFTER).await;
        assert_eq!(wire.next_sent().await, "@+typing=paused TAGMSG #room");

        _ = runtime.request(EngineRequestEnvelope {
            id: "resume".into(),
            request: EngineRequest::CompleteInput {
                buffer_id,
                input: "hel".into(),
                cursor: 3,
                explicit: false,
            },
        });
        assert_eq!(wire.next_sent().await, "@+typing=active TAGMSG #room");

        _ = runtime.request(EngineRequestEnvelope {
            id: "send".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "hello".into(),
                reply_to: None,
            },
        });
        assert_eq!(wire.next_sent().await, "@+typing=done TAGMSG #room");
        assert_eq!(wire.next_sent().await, "PRIVMSG #room hello");
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
                    reply_to: None,
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

    #[test]
    fn file_is_refused_because_only_the_composer_can_open_the_picker() {
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let submit = |input: &str| {
            runtime.request(EngineRequestEnvelope {
                id: "file-1".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: BufferId(1),
                    input: input.into(),
                    reply_to: None,
                },
            })
        };

        assert_eq!(
            submit("/file "),
            super::rejected_command("file-1".into(), EngineMessageKey::ComposerFileNeedsPicker)
        );
        assert_eq!(
            submit("/FILE holiday.png"),
            super::rejected_command(
                "file-1".into(),
                EngineMessageKey::ComposerUnexpectedArgument
            )
        );
    }

    #[tokio::test]
    async fn version_posts_the_build_and_waiting_update_as_a_local_notice() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
            }))),
            outbound,
        };

        assert_version_notice(
            &runtime.request(EngineRequestEnvelope {
                id: "version-1".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: BufferId(1),
                    input: "/version".into(),
                    reply_to: None,
                },
            }),
            "weblounge test",
        );
        _ = runtime.request(EngineRequestEnvelope {
            id: "update-ready".into(),
            request: EngineRequest::SetUpdateReady { ready: true },
        });
        assert_version_notice(
            &runtime.request(EngineRequestEnvelope {
                id: "version-2".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: BufferId(1),
                    input: "/version".into(),
                    reply_to: None,
                },
            }),
            "weblounge test · update ready — restart the app",
        );
    }

    fn assert_version_notice(events: &[EngineToUi], text: &str) {
        let messages = changed_messages(events);
        assert!(matches!(
            events.first(),
            Some(EngineToUi::CommandResult { .. })
        ));
        assert!(matches!(
            messages.as_slice(),
            [(_, message)]
                if matches!(&message.kind, crate::MessageKind::Notice(crate::NoticeKind::Info))
                    && message.text == text
                    && message.author.is_empty()
        ));
    }

    #[tokio::test]
    async fn query_focuses_new_and_existing_direct_buffers_once() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join", "away-notify"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room * :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":mel!m@host JOIN #room mel :Mel").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":mel!m@host AWAY").await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::AwayChanged(_))
        })
        .await;
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
            }))),
            outbound,
        };
        mark_runtime_online(&runtime);

        let immediate = runtime.request(EngineRequestEnvelope {
            id: "open-mel".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/query mel".into(),
                reply_to: None,
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
        assert!(
            matches!(output.as_slice(), [
            EngineToUi::BufferAdded { buffer },
            EngineToUi::BuffersChanged { .. },
            EngineToUi::DraftKeyChanged { .. },
            EngineToUi::BufferUpdated { buffer: present },
            EngineToUi::FocusBufferRequested { buffer_id, .. },
            EngineToUi::CommandResult { .. },
        ] if buffer.kind == BufferKind::Direct
            && buffer.title == "mel"
            && buffer.id == *buffer_id
            && present.peer_presence == Some(crate::PeerPresence::Online)),
            "{output:?}"
        );

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "open-mel-again".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id: BufferId(1),
                        input: "/query mel".into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        let focus = receiver.recv().await.expect("existing direct is focused");
        let result = receiver.recv().await.expect("query completes");
        assert!(
            matches!(focus, EngineToUi::FocusBufferRequested { command_id, .. }
            if command_id == "open-mel-again")
        );
        assert_eq!(
            result,
            EngineToUi::CommandResult {
                id: "open-mel-again".into()
            }
        );
    }

    async fn online_runtime_with_monitor() -> (
        Runtime,
        mpsc::UnboundedReceiver<EngineToUi>,
        Wire,
        papo::Events,
    ) {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 1).await;
        let (state, outbound, receiver) = harness(client);
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .set_connection(crate::NetworkConnectionState::Online, None);
        (Runtime { state, outbound }, receiver, wire, events)
    }

    async fn open_alice(
        runtime: &Runtime,
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
        wire: &mut Wire,
        focus: bool,
    ) -> Vec<EngineToUi> {
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "open-alice".into(),
                    request: EngineRequest::OpenDirect {
                        network_id: NetworkId(1),
                        nick: "alice".into(),
                        focus,
                    },
                })
                .is_empty()
        );
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        let mut output = Vec::new();
        loop {
            let event = receiver.recv().await.expect("open output");
            let complete = matches!(event, EngineToUi::CommandResult { .. });
            output.push(event);
            if complete {
                return output;
            }
        }
    }

    fn added_buffer(output: &[EngineToUi]) -> Option<BufferId> {
        output.iter().find_map(|event| match event {
            EngineToUi::BufferAdded { buffer } => Some(buffer.id),
            _ => None,
        })
    }

    fn requests_focus(output: &[EngineToUi]) -> bool {
        output
            .iter()
            .any(|event| matches!(event, EngineToUi::FocusBufferRequested { .. }))
    }

    #[tokio::test]
    async fn open_direct_requests_focus_only_when_asked() {
        let (runtime, mut receiver, mut wire, _events) = online_runtime_with_monitor().await;

        let output = open_alice(&runtime, &mut receiver, &mut wire, false).await;

        assert!(added_buffer(&output).is_some(), "{output:?}");
        assert!(!requests_focus(&output), "{output:?}");
    }

    #[tokio::test]
    async fn closing_a_direct_buffer_releases_its_monitor_entry() {
        let (runtime, mut receiver, mut wire, _events) = online_runtime_with_monitor().await;
        let opened = open_alice(&runtime, &mut receiver, &mut wire, true).await;
        assert!(requests_focus(&opened), "{opened:?}");
        let buffer_id = added_buffer(&opened).expect("alice's buffer is added");

        let output = runtime.request(EngineRequestEnvelope {
            id: "close-alice".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/close".into(),
                reply_to: None,
            },
        });
        assert!(matches!(
            output.last(),
            Some(EngineToUi::CommandResult { .. })
        ));
        assert_eq!(wire.next_sent().await, "MONITOR - alice");
    }

    #[tokio::test]
    async fn closing_an_unresolved_direct_drops_its_peer_from_the_monitor_batch() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 100).await;
        let nick = known_nick(&client, "alice");
        let (state, outbound, _receiver) = harness(client.clone());
        let alice = {
            let mut runtime = lock(&state);
            let model = &mut runtime
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            model.set_connection(crate::NetworkConnectionState::Online, None);
            model
                .open_direct(nick, DirectAvailability::Pending, &client.snapshot())
                .0
        };
        monitor_shown_direct_peers(&state, &client, 1);
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        runtime.request(EngineRequestEnvelope {
            id: "close-alice".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: alice,
                input: "/close".into(),
                reply_to: None,
            },
        });

        assert_eq!(wire.next_sent().await, "MONITOR - alice");
    }

    #[tokio::test]
    async fn monitored_peer_return_refreshes_its_direct_handle() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 100).await;

        let direct = DirectPeer::resolve(&client, &known_nick(&client, "alice"));
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        let nick = direct.nick().clone();
        let (state, outbound, _receiver) = harness(client.clone());
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(
                nick.clone(),
                DirectAvailability::Guarded(direct),
                &client.snapshot(),
            );
        let held = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .begin_online_direct_resolution(&nick)
            .expect("reconnect resolution starts")
            .1;

        wire.server(":offline.test 731 weblounge :alice").await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::MonitorOffline(_))
        })
        .await;
        wire.server(":offline.test 730 weblounge :alice!~alice@cloak.example")
            .await;
        let online = next_matching(&mut events, |event| {
            matches!(event, papo::Event::MonitorOnline(_))
        })
        .await;
        let papo::Event::MonitorOnline(online) = online else {
            panic!("monitor online expected")
        };
        spawn_online_direct_resolution(
            Arc::clone(&state),
            outbound,
            client,
            1,
            online.subject.nick(),
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let current = lock(&state)
                    .network
                    .as_ref()
                    .expect("network remains active")
                    .model
                    .direct(&nick);
                if matches!(current, Some(DirectAvailability::Guarded(ref refreshed)) if *refreshed.nick() == nick)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("returned peer is resolved");
        drop(held);
    }

    const ERGO_CAPS: [&str; 3] = ["batch", "echo-message", "labeled-response"];

    struct DirectSends {
        runtime: Runtime,
        wire: papo_testing::Wire,
        receiver: mpsc::UnboundedReceiver<EngineToUi>,
        _events: papo::Events,
    }

    impl DirectSends {
        async fn connect(caps: &[&str], isupport: &str) -> Self {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            wire.register(caps).await;
            _ = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            wire.server(format!(
                ":offline.test 005 weblounge MONITOR=100 {isupport} :supported"
            ))
            .await;
            _ = next_matching(&mut events, |event| {
                matches!(event, papo::Event::FeaturesChanged { .. })
            })
            .await;
            let (state, outbound, receiver) = harness(client);
            lock(&state)
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .set_connection(crate::NetworkConnectionState::Online, None);
            Self {
                runtime: Runtime { state, outbound },
                wire,
                receiver,
                _events: events,
            }
        }

        /// Submits `input`, answering papo's identity lookups of `nick`, and returns the
        /// `PRIVMSG` it wrote with whether a guarded send queued its local echo.
        async fn submit(&mut self, buffer_id: BufferId, input: &str, nick: &str) -> (String, bool) {
            self.runtime.request(EngineRequestEnvelope {
                id: "message".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id,
                    input: input.into(),
                    reply_to: None,
                },
            });
            loop {
                let sent = self.wire.next_sent().await;
                if sent.contains("PRIVMSG") {
                    let local_echo = !changed_messages(&collect(&mut self.receiver)).is_empty();
                    return (sent, local_echo);
                }
                if sent.starts_with("MONITOR") {
                    self.wire
                        .server(format!(":offline.test 730 weblounge {nick}"))
                        .await;
                } else if sent.contains("WHO") {
                    answer_who(&mut self.wire, &sent, nick).await;
                }
            }
        }

        fn direct_buffer(&self, nick: &str) -> BufferId {
            let EngineToUi::BuffersChanged { buffers, .. } = lock(&self.runtime.state)
                .network
                .as_ref()
                .expect("network remains active")
                .model
                .buffers_event()
            else {
                panic!("buffer projections")
            };
            buffers
                .iter()
                .find(|buffer| buffer.title == nick)
                .expect("direct buffer")
                .id
        }
    }

    async fn sent_direct_privmsg(nick: &str, caps: &[&str], isupport: &str) -> (String, bool) {
        DirectSends::connect(caps, isupport)
            .await
            .submit(BufferId(1), &format!("/msg {nick} REGISTER #room"), nick)
            .await
    }

    async fn answer_who(wire: &mut papo_testing::Wire, request: &str, nick: &str) {
        let rows = [
            format!(":offline.test 354 weblounge {nick} 0"),
            format!(":offline.test 315 weblounge {nick} :End of WHO list"),
        ];
        if !request.starts_with("@label=") {
            for row in rows {
                wire.server(row).await;
            }
            return;
        }
        let label = request_label(request);
        wire.server(format!(
            "@label={label} :offline.test BATCH +who labeled-response"
        ))
        .await;
        for row in rows {
            wire.server(format!("@batch=who {row}")).await;
        }
        wire.server(":offline.test BATCH -who").await;
    }

    #[tokio::test]
    async fn a_message_to_an_ergo_service_goes_out_unlabelled() {
        assert_eq!(
            sent_direct_privmsg("ChanServ", &ERGO_CAPS, "SAFERATE").await,
            ("PRIVMSG ChanServ :REGISTER #room".to_owned(), false)
        );
    }

    #[tokio::test]
    async fn an_ergo_service_typed_in_lower_case_resolves_as_ergo_spells_it() {
        let mut sends = DirectSends::connect(&ERGO_CAPS, "SAFERATE").await;

        assert_eq!(
            sends
                .submit(BufferId(1), "/msg chanserv REGISTER #room", "ChanServ")
                .await,
            ("PRIVMSG ChanServ :REGISTER #room".to_owned(), false)
        );
        assert_eq!(sends.direct_buffer("ChanServ"), BufferId(2));
    }

    #[tokio::test]
    async fn typing_in_an_ergo_service_direct_goes_out_unlabelled() {
        let mut sends = DirectSends::connect(&ERGO_CAPS, "SAFERATE").await;
        _ = sends
            .submit(BufferId(1), "/msg ChanServ REGISTER #room", "ChanServ")
            .await;
        let chanserv = sends.direct_buffer("ChanServ");

        assert_eq!(
            sends.submit(chanserv, "INFO #room", "ChanServ").await,
            ("PRIVMSG ChanServ :INFO #room".to_owned(), false)
        );
    }

    #[tokio::test]
    async fn typing_in_an_ergo_service_direct_while_offline_queues_the_line() {
        let mut sends = DirectSends::connect(&ERGO_CAPS, "SAFERATE").await;
        _ = sends
            .submit(BufferId(1), "/msg ChanServ REGISTER #room", "ChanServ")
            .await;
        let chanserv = sends.direct_buffer("ChanServ");
        let mut state = lock(&sends.runtime.state);
        state
            .network
            .as_mut()
            .expect("network remains active")
            .device_online = false;
        drop(state);

        sends.runtime.request(EngineRequestEnvelope {
            id: "offline".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: chanserv,
                input: "INFO #room".into(),
                reply_to: None,
            },
        });

        let state = lock(&sends.runtime.state);
        let running = state.network.as_ref().expect("network remains active");
        assert_eq!(running.pending_sends.len(), 1);
    }

    #[tokio::test]
    async fn messages_off_ergo_or_to_people_keep_the_guarded_send() {
        for (nick, caps, isupport) in [
            ("alice", &ERGO_CAPS[..], "SAFERATE"),
            ("ChanServ", &ERGO_CAPS[..], "WHOX"),
            ("ChanServ", &["batch", "labeled-response"][..], "SAFERATE"),
        ] {
            let (sent, local_echo) = sent_direct_privmsg(nick, caps, isupport).await;

            assert!(local_echo, "{nick} {isupport}: {sent}");
            assert!(
                sent.ends_with(&format!("PRIVMSG {nick} :REGISTER #room")),
                "{sent}"
            );
        }
    }

    #[tokio::test]
    async fn a_full_monitor_list_still_sends_the_direct() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 1).await;
        crate::direct_peer::test_support::keep_watching(client.watch("bob"));
        assert_eq!(wire.next_sent().await, "MONITOR + bob");
        let (state, outbound, mut receiver) = harness(client);
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .set_connection(crate::NetworkConnectionState::Online, None);
        let runtime = Runtime { state, outbound };

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "message-alice".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id: BufferId(1),
                        input: "/msg alice hello".into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        let mut output = Vec::new();
        while !output
            .iter()
            .any(|event| matches!(event, EngineToUi::BufferAdded { .. }))
        {
            output.push(receiver.recv().await.expect("direct output"));
        }
        assert!(
            output
                .iter()
                .any(|event| matches!(event, EngineToUi::BufferAdded { buffer }
                if buffer.kind == BufferKind::Direct && buffer.title == "alice"))
        );
        assert_eq!(
            next_sent_containing(&mut wire, "PRIVMSG alice").await,
            "PRIVMSG alice hello"
        );
    }

    #[tokio::test]
    async fn second_tab_connect_attaches_without_replacing_the_running_client() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::test_plain(),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: None,
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
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
            [
                EngineToUi::NetworkStateChanged { .. },
                EngineToUi::BuffersChanged { .. },
                EngineToUi::RecentDirectsReady { .. },
                EngineToUi::TimelineChanged { reset: true, .. },
                EngineToUi::CommandResult { id },
            ] if id == "connect-again"
        ));
        let hosted = runtime.request(EngineRequestEnvelope {
            id: "hosted".into(),
            request: EngineRequest::ConnectHosted {
                label: "weblounge".into(),
                endpoint: "wss://beta.weblounge.org/socket".into(),
                nickname: "weblounge".into(),
                oauth_token: "token".into(),
                autojoin: Vec::new(),
            },
        });
        assert!(matches!(
            hosted.as_slice(),
            [EngineToUi::CommandRejected {
                id, message_key, ..
            }]
                if id == "hosted" && *message_key == EngineMessageKey::NetworkAlreadyConnected
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
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::hosted("wss://127.0.0.1/socket".into()),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: Some(HostedReconnectConfig {
                        endpoint: "wss://127.0.0.1/socket".into(),
                        nickname: "*".into(),
                        autojoin: vec!["#lounge".into()],
                    }),
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
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
                EngineToUi::RecentDirectsReady { .. },
                EngineToUi::TimelineChanged { reset: true, .. },
                EngineToUi::CommandResult { id },
            ] if id == "second-tab"
        ));

        assert_hosted_token_unavailable(&runtime);

        let reconnected = runtime.request(EngineRequestEnvelope {
            id: "fresh-token".into(),
            request: EngineRequest::ReconnectHosted {
                network_id: NetworkId(1),
                oauth_token: "fresh-token".into(),
            },
        });
        assert!(matches!(
            reconnected.as_slice(),
            [EngineToUi::CommandResult { id }] if id == "fresh-token"
        ));
        assert_eq!(
            lock(&runtime.state)
                .network
                .as_ref()
                .map(|running| (running.instance, running.model.id())),
            Some((2, NetworkId(1)))
        );

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
            ] if key == EngineMessageKey::HostedAuthFailed.as_str() && id == "expired"
        ));
        assert!(lock(&runtime.state).network.is_none());
    }

    fn assert_hosted_token_unavailable(runtime: &Runtime) {
        let unavailable = runtime.request(EngineRequestEnvelope {
            id: "token-unavailable".into(),
            request: EngineRequest::HostedTokenUnavailable {
                network_id: NetworkId(1),
            },
        });
        assert!(matches!(
            unavailable.as_slice(),
            [
                EngineToUi::NetworkStateChanged {
                    network: NetworkProjection {
                        state: NetworkConnectionState::Failed {
                            reason: ConnectionFailureReason::Transport,
                            ..
                        },
                        ..
                    },
                },
                EngineToUi::CommandResult { id },
            ] if id == "token-unavailable"
        ));
        assert!(lock(&runtime.state).network.is_some());
    }

    #[tokio::test]
    async fn completion_results_are_computed_by_the_engine_projection() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
            }))),
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

        for typed in ["/join", "/kick"] {
            let exact = runtime.request(EngineRequestEnvelope {
                id: format!("complete-exact:{typed}"),
                request: EngineRequest::CompleteInput {
                    buffer_id: BufferId(1),
                    input: typed.into(),
                    cursor: utf16_len(typed),
                    explicit: false,
                },
            });
            assert!(
                command_candidate_names(&exact).is_empty(),
                "{typed} is complete, so Enter runs it instead of picking a longer command"
            );
        }

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
                reply_to: None,
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

    #[tokio::test]
    async fn person_completion_excludes_an_uppercase_own_nick() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "Luiz"));
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        wire.server(":Luiz!u@host JOIN #new").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;

        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "Luiz".into(), 50);
        let state = client.snapshot();
        model.sync_channels(&state);
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(known_channel(&client, "#new")))
            .expect("joined buffer exists");

        assert!(person_candidates(&model, buffer_id, "lu", NickMatch::Prefix, &state).is_empty());
    }

    #[tokio::test]
    async fn terminated_mention_completion_holds_only_the_exact_casemapped_nick() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@h JOIN #room").await;
        wire.server(":offline.test 353 weblounge = #room :weblounge ana Ana[m] anabel")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        let (state, outbound, _receiver) = harness(client.clone());
        let buffer_id = {
            let mut runtime = lock(&state);
            let running = runtime.network.as_mut().expect("network remains running");
            running.model.sync_channels(&client.snapshot());
            running
                .model
                .buffer_id_for_channel(&known_channel(&client, "#room"))
                .expect("room buffer")
        };
        let runtime = Runtime { state, outbound };
        let complete = |input: &str| {
            let output = runtime.request(EngineRequestEnvelope {
                id: format!("complete:{input}"),
                request: EngineRequest::CompleteInput {
                    buffer_id,
                    input: input.into(),
                    cursor: utf16_len(input),
                    explicit: false,
                },
            });
            let Some(EngineToUi::CompletionResult {
                auto_accept,
                candidates,
                ..
            }) = output.into_iter().next()
            else {
                panic!("completion result is first");
            };
            let nicks = candidates
                .into_iter()
                .filter_map(|candidate| match candidate {
                    CompletionCandidate::Person { nick, .. } => Some(nick),
                    _ => None,
                })
                .collect::<Vec<_>>();
            (auto_accept, nicks)
        };

        assert_eq!(complete("@ANA "), (true, vec!["ana".to_owned()]));
        assert_eq!(complete("@ANA{M} "), (true, vec!["Ana[m]".to_owned()]));
        assert_eq!(complete("hi @anabel,"), (true, vec!["anabel".to_owned()]));
        assert_eq!(complete("/msg @ana "), (true, vec!["ana".to_owned()]));
        assert_eq!(complete("@anab "), (false, Vec::new()));
        assert_eq!(complete("@weblounge "), (false, Vec::new()));
        let (auto_accept, prefixed) = complete("@ana");
        assert!(!auto_accept);
        assert_eq!(prefixed.len(), 3);
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

    fn assert_empty_completion(events: &[EngineToUi]) {
        assert!(matches!(
            events.first(),
            Some(EngineToUi::CompletionResult { candidates, .. }) if candidates.is_empty()
        ));
    }

    fn assert_no_output(events: &[EngineToUi]) {
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn submit_join_and_msg_use_typed_papo_commands() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
            }))),
            outbound,
        };
        mark_runtime_online(&runtime);

        _ = runtime.submit_input("join".into(), BufferId(1), "/join #new secret", None);
        assert_eq!(wire.next_sent().await, "JOIN #new secret");
        wire.server(":weblounge!u@host JOIN #new").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let buffer_id = {
            let mut state = lock(&runtime.state);
            let running = state.network.as_mut().expect("network remains running");
            running.model.sync_channels(&running.client.snapshot());
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
        assert_empty_completion(&completion);
        runtime.request(EngineRequestEnvelope {
            id: "topic".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/topic new topic".into(),
                reply_to: None,
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
                reply_to: None,
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
        assert_no_output(&runtime.request(EngineRequestEnvelope {
            id: "msg".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/msg alice hello".into(),
                reply_to: None,
            },
        }));
        assert_eq!(wire.next_sent().await, "PRIVMSG alice hello");
        assert_unfocused_direct(&collect(&mut receiver), "alice");
    }

    #[tokio::test]
    async fn own_part_removes_the_channel_buffer() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@host JOIN #projects/weblounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let buffer_id = model
            .buffer_id_for_channel(&known_channel(&client, "#projects/weblounge"))
            .expect("joined buffer exists");
        let snapshot = model.chat_list_snapshot("network".into());
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync {
                    fingerprint: "network".into(),
                    snapshot: Some(snapshot.clone()),
                    ..ChatListSync::default()
                },
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model,
            }))),
            outbound,
        };
        mark_runtime_online(&runtime);
        let storage = Arc::clone(&lock(&runtime.state).storage);
        crate::chat_list_snapshot::write(storage.as_ref(), &snapshot)
            .await
            .expect("seed cache");

        runtime.request(EngineRequestEnvelope {
            id: "part".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/part later".into(),
                reply_to: None,
            },
        });
        assert_eq!(wire.next_sent().await, "PART #projects/weblounge later");
        wire.server(":weblounge!u@host PART #projects/weblounge :later")
            .await;
        let parted =
            next_matching(&mut events, |event| matches!(event, papo::Event::Parted(_))).await;
        process_runtime_event(&runtime, parted);
        assert!(collect(&mut receiver).iter().any(
            |event| matches!(event, EngineToUi::BufferRemoved { buffer_id: removed } if *removed == buffer_id)
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let stored = read(storage.as_ref())
                    .await
                    .expect("read")
                    .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
                if stored.is_some_and(|snapshot| snapshot.rows.is_empty()) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("part removes the snapshot row");

        let stale_close = runtime.request(EngineRequestEnvelope {
            id: "close-after-part".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/close".into(),
                reply_to: None,
            },
        });
        assert!(matches!(
            stale_close.as_slice(),
            [EngineToUi::CommandRejected { .. }]
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wire.next_sent())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn channel_command_refusals_name_the_channel() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        let room = [("target", "#room")];
        let kicked = [("target", "#room"), ("nick", "mel")];

        for (input, sent, refusal, message_key, values) in [
            (
                "/part",
                "PART #room",
                "442 weblounge #room :You're not on that channel",
                EngineMessageKey::NotInChannel,
                &room[..],
            ),
            (
                "/topic updated topic",
                "TOPIC #room :updated topic",
                "403 weblounge #room :No such channel",
                EngineMessageKey::NotInChannel,
                &room,
            ),
            (
                "/topic op-only topic",
                "TOPIC #room :op-only topic",
                "482 weblounge #room :You're not a channel operator",
                EngineMessageKey::ChannelOperatorRequired,
                &room,
            ),
            (
                "/kick mel",
                "KICK #room mel",
                "482 weblounge #room :You're not a channel operator",
                EngineMessageKey::ChannelOperatorRequired,
                &kicked,
            ),
            (
                "/kick mel",
                "KICK #room mel",
                "401 weblounge mel :No such nick",
                EngineMessageKey::NickNotFound,
                &kicked,
            ),
            (
                "/kick mel",
                "KICK #room mel",
                "441 weblounge mel #room :They aren't on that channel",
                EngineMessageKey::NickNotInChannel,
                &kicked,
            ),
        ] {
            let result = refused_channel_command(
                &runtime,
                &mut receiver,
                &mut wire,
                buffer_id,
                input,
                &[sent],
                refusal,
            )
            .await;
            assert_eq!(
                result,
                EngineToUi::CommandRejected {
                    id: input.into(),
                    message_key,
                    values: Some(
                        values
                            .iter()
                            .map(|(key, value)| ((*key).into(), (*value).into()))
                            .collect()
                    ),
                },
                "{input} answered by {refusal}"
            );
        }
    }

    async fn refused_channel_command(
        runtime: &Runtime,
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
        wire: &mut Wire,
        buffer_id: BufferId,
        input: &str,
        sent: &[&str],
        refusal: &str,
    ) -> EngineToUi {
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: input.into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id,
                        input: input.into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        for line in sent {
            assert_eq!(wire.next_sent().await, *line);
        }
        wire.server(format!(":irc.test {refusal}")).await;
        if let Some(token) = sent.last().and_then(|line| line.strip_prefix("PING ")) {
            wire.server(format!(":irc.test PONG irc.test :{token}"))
                .await;
        }
        next_output(receiver).await
    }

    async fn next_output(receiver: &mut mpsc::UnboundedReceiver<EngineToUi>) -> EngineToUi {
        tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("channel command resolves")
            .expect("runtime remains subscribed")
    }

    async fn confirm_mode_request(wire: &mut Wire, request: &str) {
        assert_eq!(wire.next_sent().await, request);
        let ping = wire.next_sent().await;
        let token = ping
            .strip_prefix("PING ")
            .expect("papo delimits MODE with PING");
        wire.server(format!(":weblounge!u@host {request}")).await;
        wire.server(format!(":irc.test PONG irc.test :{token}"))
            .await;
    }

    async fn joined_room_runtime_with(
        members: &[&str],
    ) -> (Runtime, mpsc::UnboundedReceiver<EngineToUi>, Wire, BufferId) {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        wire.server(":offline.test 005 weblounge MODES=2 CHANMODES=beI,k,l,imnst :are supported")
            .await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        for source in std::iter::once(&"weblounge!u@host").chain(members) {
            wire.server(format!(":{source} JOIN #room")).await;
            _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        }
        let (outbound, receiver) = mpsc::unbounded_channel();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let buffer_id = model
            .buffer_id_for_channel(&known_channel(&client, "#room"))
            .expect("joined buffer exists");
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model,
            }))),
            outbound,
        };
        mark_runtime_online(&runtime);
        (runtime, receiver, wire, buffer_id)
    }

    #[tokio::test]
    async fn kick_sends_the_reason_from_the_focused_channel_only() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        let kick = runtime.request(EngineRequestEnvelope {
            id: "kick".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/kick mel link spam".into(),
                reply_to: None,
            },
        });
        assert!(kick.is_empty());
        assert_eq!(wire.next_sent().await, "KICK #room mel :link spam");
        wire.server(":weblounge!u@host KICK #room mel :link spam")
            .await;
        let result = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("kick resolves")
            .expect("runtime remains subscribed");
        assert_eq!(result, EngineToUi::CommandResult { id: "kick".into() });

        let outside_channel = runtime.request(EngineRequestEnvelope {
            id: "kick-outside".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/kick mel".into(),
                reply_to: None,
            },
        });
        assert!(matches!(
            outside_channel.as_slice(),
            [EngineToUi::CommandRejected {
                message_key: EngineMessageKey::ChannelRequired,
                ..
            }]
        ));
    }

    #[tokio::test]
    async fn member_modes_go_out_one_member_at_a_time() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host", "iris!i@iris.host", "ana!a@ana.host"])
                .await;
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "op".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id,
                        input: "/op mel iris,ana".into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        for sent in [
            "MODE #room +o mel",
            "MODE #room +o iris",
            "MODE #room +o ana",
        ] {
            confirm_mode_request(&mut wire, sent).await;
        }
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult { id: "op".into() }
        );

        for (input, sent) in [
            (
                "/deop mel iris",
                &["MODE #room -o mel", "MODE #room -o iris"][..],
            ),
            ("/voice mel", &["MODE #room +v mel"]),
            ("/devoice mel", &["MODE #room -v mel"]),
        ] {
            assert!(
                runtime
                    .request(EngineRequestEnvelope {
                        id: input.into(),
                        request: EngineRequest::SubmitInput {
                            buffer_id,
                            input: input.into(),
                            reply_to: None,
                        },
                    })
                    .is_empty()
            );
            for sent in sent {
                confirm_mode_request(&mut wire, sent).await;
            }
            assert_eq!(
                next_output(&mut receiver).await,
                EngineToUi::CommandResult { id: input.into() }
            );
        }
    }

    #[tokio::test]
    async fn kick_refuses_someone_who_is_not_in_the_channel() {
        let (runtime, mut receiver, _wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        submit(&runtime, buffer_id, "/kick iris");
        assert_eq!(
            rejection_key_and_nick(next_output(&mut receiver).await),
            (EngineMessageKey::NickNotInChannel, Some("iris".into()))
        );
    }

    #[tokio::test]
    async fn member_mode_refusals_name_the_member() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "op-stranger".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id,
                        input: "/op iris".into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        assert_eq!(
            rejection_key_and_nick(next_output(&mut receiver).await),
            (EngineMessageKey::NickNotInChannel, Some("iris".into()))
        );

        let refused = refused_channel_command(
            &runtime,
            &mut receiver,
            &mut wire,
            buffer_id,
            "/op mel",
            &["MODE #room +o mel", "PING papo-mode-0"],
            "482 weblounge #room :You're not a channel operator",
        )
        .await;
        assert_eq!(
            rejection_key_and_nick(refused),
            (
                EngineMessageKey::ChannelOperatorRequired,
                Some("mel".into())
            )
        );
    }

    fn rejection_key_and_nick(output: EngineToUi) -> (EngineMessageKey, Option<String>) {
        let EngineToUi::CommandRejected {
            message_key,
            values,
            ..
        } = output
        else {
            panic!("expected a rejection, got {output:?}");
        };
        (
            message_key,
            values.and_then(|values| values.get("nick").cloned()),
        )
    }

    #[tokio::test]
    async fn ban_derives_a_host_mask_from_a_nick() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        for (input, sent) in [
            ("/ban mel", "MODE #room +b *!*@mel.host"),
            ("/ban ghost", "MODE #room +b ghost!*@*"),
            ("/ban *!*@spam.example", "MODE #room +b *!*@spam.example"),
        ] {
            submit(&runtime, buffer_id, input);
            confirm_mode_request(&mut wire, sent).await;
            assert_eq!(
                next_output(&mut receiver).await,
                EngineToUi::CommandResult { id: input.into() }
            );
        }
    }

    #[tokio::test]
    async fn unban_removes_every_fetched_ban_matching_the_member() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        submit(&runtime, buffer_id, "/unban mel");
        confirm_mode_request(&mut wire, "MODE #room -b *!*@mel.host").await;
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult {
                id: "/unban mel".into()
            }
        );

        let client = lock(&runtime.state)
            .network
            .as_ref()
            .expect("network runs")
            .client
            .clone();
        let fetch =
            tokio::spawn(async move { client.list_modes("#room", papo::ListMode::Ban).await });
        assert_eq!(wire.next_sent().await, "MODE #room b");
        for mask in ["mel!*@*", "*!*@*.host", "*!*@elsewhere"] {
            wire.server(format!(":irc.test 367 weblounge #room {mask} op 0"))
                .await;
        }
        wire.server(":irc.test 368 weblounge #room :End of ban list")
            .await;
        fetch.await.expect("fetch joins").expect("ban list arrives");

        submit(&runtime, buffer_id, "/ub mel");
        confirm_mode_request(&mut wire, "MODE #room -bb mel!*@* *!*@*.host").await;
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult {
                id: "/ub mel".into()
            }
        );
    }

    #[tokio::test]
    async fn kickban_refuses_someone_who_is_not_in_the_channel_before_banning() {
        let (runtime, mut receiver, _wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        submit(&runtime, buffer_id, "/kb iris");
        assert_eq!(
            rejection_key_and_nick(next_output(&mut receiver).await),
            (EngineMessageKey::NickNotInChannel, Some("iris".into()))
        );
    }

    #[tokio::test]
    async fn kickban_bans_the_member_host_before_kicking() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        submit(&runtime, buffer_id, "/kb mel spam");
        confirm_mode_request(&mut wire, "MODE #room +b *!*@mel.host").await;
        assert_eq!(wire.next_sent().await, "KICK #room mel spam");
        wire.server(":weblounge!u@host KICK #room mel spam").await;
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult {
                id: "/kb mel spam".into()
            }
        );
    }

    #[tokio::test]
    async fn invite_confirms_and_names_a_member_already_there() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        submit(&runtime, buffer_id, "/invite mel #ops");
        assert_eq!(wire.next_sent().await, "INVITE mel #ops");
        wire.server(":irc.test 341 weblounge mel #ops").await;
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::Notice {
                key: "notice.invite_sent".into(),
                values: std::collections::BTreeMap::from([
                    ("nick".into(), "mel".into()),
                    ("target".into(), "#ops".into()),
                ]),
                tone: crate::NoticeTone::Neutral,
                action: None,
            }
        );
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult {
                id: "/invite mel #ops".into()
            }
        );

        let refused = refused_channel_command(
            &runtime,
            &mut receiver,
            &mut wire,
            buffer_id,
            "/invite mel",
            &["INVITE mel #room"],
            "443 weblounge mel #room :is already on channel",
        )
        .await;
        assert_eq!(
            rejection_key_and_nick(refused),
            (EngineMessageKey::NickAlreadyInChannel, Some("mel".into()))
        );
    }

    #[tokio::test]
    async fn mode_sets_typed_changes_and_shows_the_channel_modes() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        let notice = |key: &str, values: &[(&str, &str)]| EngineToUi::Notice {
            key: key.into(),
            values: values
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
            tone: crate::NoticeTone::Neutral,
            action: None,
        };

        submit(&runtime, buffer_id, "/mode");
        assert_eq!(wire.next_sent().await, "MODE #room");
        let ping = wire.next_sent().await;
        let token = ping
            .strip_prefix("PING ")
            .expect("papo pings after the query");
        wire.server(":irc.test 324 weblounge #room +nt").await;
        wire.server(format!(":irc.test PONG irc.test :{token}"))
            .await;
        assert_eq!(
            next_output(&mut receiver).await,
            notice(
                "notice.channel_modes",
                &[("modes", "+nt"), ("target", "#room")]
            )
        );
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult { id: "/mode".into() }
        );

        for (input, sent) in [
            ("/mode +m", &["MODE #room +m"][..]),
            (
                "/mode +ol mel 50",
                &["MODE #room +o mel", "MODE #room +l 50"],
            ),
            ("/mode -k", &["MODE #room -k *"]),
        ] {
            submit(&runtime, buffer_id, input);
            for sent in sent {
                confirm_mode_request(&mut wire, sent).await;
            }
            assert_eq!(
                next_output(&mut receiver).await,
                EngineToUi::CommandResult { id: input.into() }
            );
        }

        submit(&runtime, buffer_id, "/mode");
        assert_eq!(
            next_output(&mut receiver).await,
            notice(
                "notice.channel_modes",
                &[("modes", "+lmnt 50"), ("target", "#room")]
            )
        );
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandResult { id: "/mode".into() }
        );
    }

    #[tokio::test]
    async fn mode_refusals_explain_themselves() {
        let (runtime, mut receiver, mut wire, buffer_id) =
            joined_room_runtime_with(&["mel!m@mel.host"]).await;
        assert!(matches!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "unknown".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id,
                        input: "/mode +Z".into(),
                        reply_to: None,
                    },
                })
                .as_slice(),
            [EngineToUi::CommandRejected {
                message_key: EngineMessageKey::ModeUnknown,
                ..
            }]
        ));
        submit(&runtime, buffer_id, "/mode #elsewhere");
        assert_eq!(
            next_output(&mut receiver).await,
            EngineToUi::CommandRejected {
                id: "/mode #elsewhere".into(),
                message_key: EngineMessageKey::NotInChannel,
                values: Some(std::collections::BTreeMap::from([(
                    "target".into(),
                    "#elsewhere".into()
                )])),
            }
        );
        submit(&runtime, buffer_id, "/mode -q mel");
        assert_eq!(
            rejection_key_and_nick(next_output(&mut receiver).await),
            (EngineMessageKey::CommandRefused, Some("mel".into()))
        );
        let refused = refused_channel_command(
            &runtime,
            &mut receiver,
            &mut wire,
            buffer_id,
            "/mode +s",
            &["MODE #room +s", "PING papo-mode-0"],
            "472 weblounge s :is an unknown mode char to me",
        )
        .await;
        assert_eq!(
            rejection_key_and_nick(refused),
            (EngineMessageKey::ModeUnknown, None)
        );
    }

    fn submit(runtime: &Runtime, buffer_id: BufferId, input: &str) {
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: input.into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id,
                        input: input.into(),
                        reply_to: None,
                    },
                })
                .is_empty(),
            "{input} resolves asynchronously"
        );
    }

    #[tokio::test]
    async fn own_kick_keeps_a_read_only_buffer_until_rejoin() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let buffer_id = model
            .buffer_id_for_channel(&known_channel(&client, "#room"))
            .expect("joined buffer exists");
        let runtime = Runtime {
            state: Arc::new(Mutex::new(runtime_state(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model,
            }))),
            outbound,
        };
        mark_runtime_online(&runtime);

        wire.server(":operator!o@host KICK #room weblounge :too loud")
            .await;
        let kicked =
            next_matching(&mut events, |event| matches!(event, papo::Event::Kicked(_))).await;
        process_runtime_event(&runtime, kicked);
        let output = collect(&mut receiver);
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::TimelineChanged { buffer_id: id, upserted, .. }
                if *id == buffer_id && upserted.iter().any(|item| matches!(
                    &item.body,
                    crate::timeline::ItemBody::System(system)
                        if matches!(
                            &system.line,
                            crate::timeline::SystemLine::Event {
                                event: crate::timeline::LineEvent::Kick { actor, reason, .. }
                            } if matches!(actor, crate::timeline::Actor::User(person) if person.nick == "operator")
                                && reason.as_deref() == Some("too loud")
                        )
                ))
        )));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == buffer_id
                    && buffer.channel_status == Some(crate::ChannelStatus::Kicked)
        )));
        let blocked = runtime.request(EngineRequestEnvelope {
            id: "blocked-send".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "still here".into(),
                reply_to: None,
            },
        });
        assert!(
            matches!(blocked.as_slice(), [EngineToUi::CommandRejected { message_key, .. }]
            if *message_key == EngineMessageKey::ChannelRejoinRequired)
        );

        runtime.request(EngineRequestEnvelope {
            id: "rejoin".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/join #room".into(),
                reply_to: None,
            },
        });
        assert_eq!(wire.next_sent().await, "JOIN #room");
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        process_runtime_event(&runtime, joined);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer| buffer.id == buffer_id
                    && buffer.channel_status == Some(crate::ChannelStatus::Joined))
        )));
        runtime.request(EngineRequestEnvelope {
            id: "send-after-rejoin".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "back".into(),
                reply_to: None,
            },
        });
        assert_eq!(wire.next_sent().await, "PRIVMSG #room back");
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
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::test_plain(),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: None,
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };
        mark_runtime_online(&runtime);

        let output = runtime.request(EngineRequestEnvelope {
            id: "identify".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/identify hunter2".into(),
                reply_to: None,
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
        wire.server(":alice!a@host NICK bob").await;
        let changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::NickChanged(_))
        })
        .await;
        let papo::Event::NickChanged(changed) = changed else {
            panic!("nick change expected")
        };
        let pending = PendingSend {
            buffer_id: BufferId(2),
            local_send_id: crate::LocalSendId(1),
            target: SendTarget::Direct {
                nick: changed.new,
                pin: None,
                tls: false,
            },
            text: "still you".into(),
            kind: crate::MessageKind::Text,
            reply: None,
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

    #[tokio::test(start_paused = true)]
    async fn close_direct_marks_read_and_persists_until_new_peer_activity() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags", "server-time"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let cached = cached_direct_snapshot();
        restore_and_store_snapshot(&state, &cached).await;
        {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running.chat_list.fingerprint = "network".into();
            running
                .model
                .set_connection(NetworkConnectionState::Online, None);
        }
        wire.server(
            "@time=2026-11-10T12:00:00.000Z;msgid=live :alice!a@host PRIVMSG weblounge :close me",
        )
        .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        let buffer_id = lock(&state)
            .network
            .as_ref()
            .and_then(|running| {
                running.model.buffer_id_for_name(&NameKey::Direct(
                    client.snapshot().name_rules()?.nick("alice"),
                ))
            })
            .expect("alice buffer");
        _ = collect(&mut receiver);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "close-alice".into(),
            request: EngineRequest::SubmitInput {
                buffer_id,
                input: "/close".into(),
                reply_to: None,
            },
        });
        assert!(
            output.iter().any(|event| matches!(
                event,
                EngineToUi::BufferUpdated { buffer }
                    if buffer.id == buffer_id && buffer.unread == 0 && buffer.mentions == 0
            )),
            "close output: {output:#?}"
        );
        tokio::time::advance(Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        let storage = lock(&state).storage.clone();
        let closed = read(storage.as_ref())
            .await
            .expect("read snapshot")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"))
            .expect("closed snapshot");
        assert!(closed.rows.is_empty());
        assert!(closed.direct_closed_since("alice", 100));

        wire.server(
            "@time=2099-11-10T12:00:00.000Z;msgid=reopen :alice!a@host PRIVMSG weblounge :new peer message",
        )
        .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BufferAdded { buffer }
                if buffer.id == buffer_id && buffer.unread > 0
        )));
        tokio::time::advance(Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        let reopened = read(storage.as_ref())
            .await
            .expect("read snapshot")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"))
            .expect("reopened snapshot");
        assert_eq!(
            reopened.rows[0].conversation,
            SnapshotConversation::Direct {
                key: "alice".into(),
            }
        );
    }

    #[tokio::test]
    async fn rejected_close_does_not_mark_read_or_stall_later_flushes() {
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
        let (state, outbound, _receiver) = harness(client.clone());
        restore_cached_room(&state);
        let unavailable_id = {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running.model.rebuild_name_keys(&client.snapshot());
            running.model.restore_pushed_messages(
                vec![pushed_channel_message("gone-unread", "still unread")],
                &client.snapshot(),
            );
            _ = running.model.mark_vanished_restored_rows();
            _ = running.model.take_timeline_changes(false);
            running
                .model
                .buffer_id_for_channel(&known_channel(&client, "#room"))
                .expect("unavailable channel remains projected")
        };
        let (direct_id, direct_message_id) = restore_pushed_direct(&state, &client);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };

        let rejected = runtime.request(EngineRequestEnvelope {
            id: "close-unavailable".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: unavailable_id,
                input: "/close".into(),
                reply_to: None,
            },
        });

        assert!(
            matches!(
                rejected.as_slice(),
                [EngineToUi::CommandRejected {
                    id,
                    message_key: EngineMessageKey::BufferNotSendable,
                    values: None,
                }] if id == "close-unavailable"
            ),
            "close output: {rejected:#?}"
        );
        {
            let state = lock(&state);
            let running = state.network.as_ref().expect("network remains active");
            assert!(!running.flushing_reads);
            assert!(running.pending_reads.is_empty());
            assert_eq!(running.model.pending_read_time(unavailable_id), None);
            assert!(matches!(
                running.model.unread_fact_count(unavailable_id),
                Some(count) if count > 0
            ));
        }
        tokio::task::yield_now().await;
        assert!(
            tokio::time::timeout(Duration::ZERO, wire.next_sent())
                .await
                .is_err()
        );

        stamp_server_clock(&mut wire, "2026-11-03T12:34:57.000Z").await;
        let marked = runtime.request(EngineRequestEnvelope {
            id: "mark-direct".into(),
            request: EngineRequest::MarkRead {
                buffer_id: direct_id,
                through: direct_message_id,
            },
        });
        assert!(marked.iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == direct_id && buffer.unread == 0
        )));
        let request = wire.next_sent().await;
        assert!(
            request.ends_with("MARKREAD alice timestamp=2026-11-03T12:34:56.788Z"),
            "unexpected request: {request}"
        );
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
        let direct = DirectPeer::resolve(&client, &known_nick(&client, "alice"));
        let nick = direct.nick().clone();
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (buffer_id, _) = model.open_direct(
            nick,
            DirectAvailability::Guarded(direct),
            &client.snapshot(),
        );
        let (pending, _) = model
            .begin_send(buffer_id, "hi".into(), &client.snapshot())
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
        let timeline = model.take_timeline_changes(false);
        if !close_first {
            model.close_direct(buffer_id).expect("direct closes");
        }

        assert!(matches!(
            model.buffers_event(),
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().all(|buffer| buffer.id != buffer_id)
        ));
        assert!(!confirmation.is_empty());
        assert!(
            changed_messages(&timeline)
                .iter()
                .any(|(_, message)| { message.delivery == MessageDelivery::Confirmed })
        );
    }

    #[tokio::test]
    async fn pinned_direct_mismatch_sends_nothing_and_blocks_the_thread() {
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
        let nick = known_nick(&client, "alice");
        let direct = DirectPeer::resolve(&client, &nick);
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (buffer_id, _) = model.open_direct(
            nick.clone(),
            DirectAvailability::Guarded(direct.clone()),
            &client.snapshot(),
        );
        let (pending, _) = model
            .begin_send(buffer_id, "not for you".into(), &client.snapshot())
            .expect("direct is sendable");
        model.close_direct(buffer_id).expect("direct closes");

        wire.server(":alice!a@host QUIT :gone").await;
        let quit = next_matching(&mut events, |event| matches!(event, papo::Event::Quit(_))).await;
        model.note_peer_departures(&crate::peer_pin::departures(&quit, &client.snapshot()));
        wire.server(":alice!other@host JOIN #room alice-two :Other Alice")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let Err(super::SendError::PeerPinMismatch(reason, current)) =
            super::send(&client, &pending).await
        else {
            panic!("reused nick must fail its pin check")
        };
        assert!(matches!(
            model.record_direct_mismatch(buffer_id, reason, current),
            Some(EngineToUi::BufferUpdated { buffer })
                if buffer.direct_identity == Some(crate::DirectIdentityState::CannotVerify)
        ));
        assert!(
            model
                .begin_send(buffer_id, "still blocked".into(), &client.snapshot())
                .is_none()
        );
        let failures = model.fail_send(&pending, EngineMessageKey::DirectIdentityMismatch);
        assert!(matches!(
            failures.as_slice(),
            [
                EngineToUi::MessageFailed { buffer_id: failed, .. },
                EngineToUi::Notice {
                    key,
                    values,
                    tone: crate::NoticeTone::Error,
                    action: Some(crate::NoticeAction { label, run }),
                },
            ] if *failed == buffer_id
                && key == "notice.message_not_delivered"
                && values.get("network_id").is_some_and(|value| value == "1")
                && values.get("target").is_some_and(|value| value == "alice")
                && label == "action.open"
                && run == "buffer.open-direct"
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wire.next_sent())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn submit_join_adds_a_new_buffer_before_focusing_it_once() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        mark_runtime_online(&runtime);

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "join-new".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id: BufferId(1),
                        input: "/join #new".into(),
                        reply_to: None,
                    },
                })
                .is_empty()
        );
        assert_eq!(wire.next_sent().await, "JOIN #new");
        wire.server(":weblounge!u@host JOIN #new").await;
        wire.server(":offline.test 366 weblounge #new :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        let output = command_output(&mut receiver).await;

        assert!(matches!(output.as_slice(), [
            EngineToUi::BufferAdded { buffer },
            EngineToUi::BuffersChanged { .. },
            EngineToUi::FocusBufferRequested { buffer_id, .. },
            EngineToUi::CommandResult { .. },
        ] if buffer.title == "#new" && buffer.id == *buffer_id));
    }

    #[tokio::test]
    async fn submit_join_focuses_an_existing_channel_while_reconnecting() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .sync_channels(&client.snapshot());
        let runtime = Runtime { state, outbound };

        let output = runtime.request(EngineRequestEnvelope {
            id: "join-existing".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #room".into(),
                reply_to: None,
            },
        });
        let [focus, result] = output.as_slice() else {
            panic!("existing channel focus completes locally")
        };
        assert!(
            matches!(focus, EngineToUi::FocusBufferRequested { command_id, .. }
            if command_id == "join-existing")
        );
        assert_eq!(
            result,
            &EngineToUi::CommandResult {
                id: "join-existing".into()
            }
        );
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn submit_join_reactivates_a_vanished_cached_channel() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        {
            let mut state = lock(&state);
            let model = &mut state.network.as_mut().expect("network").model;
            model.restore_cached_chat_list(ChatListSnapshot::new(
                "network".into(),
                vec![SnapshotRow {
                    conversation: SnapshotConversation::Channel {
                        key: "#room".into(),
                    },
                    title: "#room".into(),
                    last_activity_ms: None,
                    stubs: Vec::new(),
                    redacted_stubs: Vec::new(),
                    gap_until: None,
                    preview: None,
                    newest: None,
                    read_at_ms: None,
                    raw_read_at_ms: None,
                    pending_read_at_ms: None,
                    peer_pin: None,
                    peer_bot: false,
                }],
            ));
            _ = model.mark_vanished_restored_rows();
        }
        let runtime = Runtime { state, outbound };

        assert_no_output(&runtime.request(EngineRequestEnvelope {
            id: "join-cached".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #room".into(),
                reply_to: None,
            },
        }));
        assert_eq!(wire.next_sent().await, "JOIN #room");
        wire.server(":weblounge!u@host JOIN #room").await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        let output = command_output(&mut receiver).await;

        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer|
                    buffer.title == "#room" && buffer.available != Some(false))
        )));
    }

    #[tokio::test]
    async fn submit_join_preserves_each_channel_key_on_the_wire() {
        let (client, mut events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge").allow_insecure_auth(true),
        );
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        let (outbound, _receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::test_plain(),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: None,
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };
        mark_runtime_online(&runtime);

        let output = runtime.request(EngineRequestEnvelope {
            id: "join-pairs".into(),
            request: EngineRequest::SubmitInput {
                buffer_id: BufferId(1),
                input: "/join #a,#b key1,key2".into(),
                reply_to: None,
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

    #[test]
    fn join_state_limits_use_the_shared_notice_terminal_path() {
        let output = join_request_events(
            "join-limit".into(),
            &papo::Error::StateLimit(papo::StateLimit::Channels),
        );

        assert!(matches!(
            output.as_slice(),
            [
                EngineToUi::Notice { key, tone: crate::NoticeTone::Error, .. },
                EngineToUi::CommandResult { id }
            ] if key == EngineMessageKey::ChannelLimitReached.as_str() && id == "join-limit"
        ));
    }

    #[tokio::test]
    async fn list_mode_state_limits_append_a_notice_to_the_channel() {
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
        model.sync_channels(&client.snapshot());
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_channel(&channel)
            .expect("joined channel is projected");

        let output = state_limit_events(
            &papo::Error::StateLimit(papo::StateLimit::ListEntries),
            true,
            Some((&mut model, buffer_id)),
            "list_mode_add",
        )
        .expect("state limit is classified");

        assert!(output.is_empty());
        assert!(
            changed_messages(&model.take_timeline_changes(false))
                .iter()
                .any(|(actual, message)| {
                    *actual == buffer_id
                        && matches!(
                            &message.kind,
                            crate::MessageKind::Notice(crate::NoticeKind::Info)
                        )
                        && message.text == "No entry was added because this channel's list is full."
                })
        );
    }

    #[tokio::test]
    async fn banned_join_numeric_becomes_a_typed_notice() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::test_plain(),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: None,
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };
        mark_runtime_online(&runtime);

        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "banned-join".into(),
                    request: EngineRequest::SubmitInput {
                        buffer_id: BufferId(1),
                        input: "/join #banned".into(),
                        reply_to: None,
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
                message_key: EngineMessageKey::JoinBanned,
                values: None,
            }
        );
    }

    #[tokio::test]
    async fn server_specific_join_refusals_do_not_leave_a_channel_buffer() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        while !matches!(events.next_event().await, Some(papo::Event::Connected(_))) {}
        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime {
            state: Arc::new(Mutex::new(RuntimeState {
                calendar: Arc::new(FixedOffsetCalendar::default()),
                next_network_id: 2,
                next_instance: 2,
                member_views: MemberViews::default(),
                storage: Arc::default(),
                snapshot_writer: Arc::default(),
                cached_snapshot: None,
                cached_pushed_messages: Vec::new(),
                build_version: "weblounge test".into(),
                update_ready: false,
                inflight_send_cancel: None,
                network: Some(RunningNetwork {
                    instance: 1,
                    identity: ConnectionIdentity::test_plain(),
                    connection_attempt: 1,
                    device_online: true,
                    pending_sends: VecDeque::new(),
                    flushing_sends: false,
                    pending_reads: VecDeque::new(),
                    flushing_reads: false,
                    hosted_reconnect: None,
                    chat_list: ChatListSync::default(),
                    push: PushRegistration::default(),
                    typing: crate::typing::OutgoingTyping::default(),
                    client,
                    model: NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50),
                }),
            })),
            outbound,
        };
        mark_runtime_online(&runtime);

        for (numeric, channel) in [(448, "#forbidden"), (479, "#invalid")] {
            let id = format!("join-{numeric}");
            assert!(
                runtime
                    .request(EngineRequestEnvelope {
                        id: id.clone(),
                        request: EngineRequest::SubmitInput {
                            buffer_id: BufferId(1),
                            input: format!("/join {channel}"),
                            reply_to: None,
                        },
                    })
                    .is_empty()
            );
            assert_eq!(wire.next_sent().await, format!("JOIN {channel}"));
            wire.server(format!(
                ":irc.test {numeric} weblounge {channel} :Channel unavailable"
            ))
            .await;

            let result = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
                .await
                .expect("join rejection resolves")
                .expect("runtime remains subscribed");
            assert_eq!(
                result,
                EngineToUi::CommandRejected {
                    id,
                    message_key: EngineMessageKey::JoinRefused,
                    values: None,
                }
            );
            let channel = known_channel(
                &lock(&runtime.state)
                    .network
                    .as_ref()
                    .expect("network remains running")
                    .client,
                channel,
            );
            assert!(
                lock(&runtime.state)
                    .network
                    .as_ref()
                    .expect("network remains running")
                    .model
                    .buffer_id_for_channel(&channel)
                    .is_none()
            );
        }
    }

    async fn next_matching(
        events: &mut papo::Events,
        predicate: impl Fn(&papo::Event) -> bool,
    ) -> papo::Event {
        loop {
            let event = events
                .next_event()
                .await
                .expect("papo event stream remains open");
            if predicate(&event) {
                return event;
            }
        }
    }

    async fn assert_read_flush_settles_without_another_request(
        state: &Arc<Mutex<RuntimeState>>,
        wire: &mut Wire,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while lock(state)
                .network
                .as_ref()
                .is_some_and(|running| running.flushing_reads)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("read flush settles");
        assert!(
            tokio::time::timeout(Duration::ZERO, wire.next_sent())
                .await
                .is_err()
        );
    }

    async fn process_next_message(
        events: &mut papo::Events,
        state: &Arc<Mutex<RuntimeState>>,
        outbound: &mpsc::UnboundedSender<EngineToUi>,
        client: &papo::Client,
    ) {
        let message = next_matching(events, |event| matches!(event, papo::Event::Message(_))).await;
        process_event(state, outbound, client, 1, message);
    }

    fn restore_pushed_direct(
        state: &Arc<Mutex<RuntimeState>>,
        client: &papo::Client,
    ) -> (BufferId, MessageId) {
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "account": "alice",
            "target": "weblounge",
            "msgid": "pushed-direct",
            "time": "2026-11-03T12:34:56.788Z",
            "text": "arrived while closed",
            "kind": "message",
        }))
        .expect("pushed message");
        let mut state = lock(state);
        let model = &mut state
            .network
            .as_mut()
            .expect("network remains active")
            .model;
        model.restore_pushed_messages(vec![pushed], &client.snapshot());
        changed_messages(&model.take_timeline_changes(false))
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("pushed message is restored")
    }

    struct MarkReadWireHarness {
        _client: papo::Client,
        _events: papo::Events,
        _state: Arc<Mutex<RuntimeState>>,
        _outbound: mpsc::UnboundedSender<EngineToUi>,
        receiver: mpsc::UnboundedReceiver<EngineToUi>,
        wire: Wire,
    }

    async fn mark_read_wire_harness() -> MarkReadWireHarness {
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
        process_next_message(&mut events, &state, &outbound, &client).await;
        let appended = collect(&mut receiver);
        let (buffer_id, message_id) = changed_messages(&appended)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("live message is projected");
        let output = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        }
        .request(EngineRequestEnvelope {
            id: "mark-retry".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });
        assert!(
            output
                .iter()
                .all(|event| !matches!(event, EngineToUi::Notice { .. }))
        );
        MarkReadWireHarness {
            _client: client,
            _events: events,
            _state: state,
            _outbound: outbound,
            receiver,
            wire,
        }
    }

    async fn fail_mark_read(wire: &mut Wire, request: &str, code: &str) {
        let label = request_label(request);
        wire.server(format!(
            "@label={label} :offline.test FAIL MARKREAD {code} #room :Mark read failed"
        ))
        .await;
    }

    fn known_channel(client: &papo::Client, name: &str) -> papo::ChannelName {
        client
            .snapshot()
            .name_rules()
            .expect("registered test client has name rules")
            .channel(name)
    }

    /// papo marks read only up to a time the server has reached, which a stamped line tells it.
    async fn stamp_server_clock(wire: &mut Wire, time: &str) {
        wire.server(format!(
            "@time={time} :offline.test NOTICE weblounge :clock"
        ))
        .await;
    }

    #[test]
    fn a_dm_to_a_nick_nobody_holds_reports_the_peer_gone() {
        let refused = papo_testing::ErrorBuilder::numeric(
            401,
            vec![
                "weblounge".into(),
                "alice".into(),
                "No such nick/channel".into(),
            ],
        )
        .build();

        assert!(matches!(
            super::classify_send_error(&refused),
            super::SendError::DirectTargetGone
        ));
    }

    #[tokio::test]
    async fn coming_back_online_to_a_live_connection_resumes_it() {
        let (client, events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound.clone(),
            client.clone(),
            events,
            1,
        ));
        wire.register(&[]).await;
        while !matches!(
            receiver.recv().await,
            Some(EngineToUi::NetworkStateChanged { ref network })
                if network.state == NetworkConnectionState::Online
        ) {}
        let runtime = Runtime { state, outbound };
        let device = |online| EngineRequestEnvelope {
            id: format!("online-{online}"),
            request: EngineRequest::SetDeviceOnline {
                network_id: NetworkId(1),
                online,
            },
        };
        _ = runtime.request(device(false));

        assert!(runtime.request(device(true)).is_empty());
        let ping = wire.next_sent().await;
        let token = ping
            .strip_prefix("PING ")
            .expect("the resume probes the socket");
        wire.server(format!(":offline.test PONG offline.test :{token}"))
            .await;

        while !matches!(
            receiver.recv().await,
            Some(EngineToUi::NetworkStateChanged { ref network })
                if network.state == NetworkConnectionState::Online
        ) {}
        assert!(client.snapshot().is_connected());
        drain.abort();
    }

    #[tokio::test]
    async fn a_foreground_probe_that_goes_unanswered_redials_the_connection() {
        let (client, events, mut wire) = wire(
            papo::Client::builder("irc://offline.test", "weblounge")
                .reconnect(papo::Reconnect::exponential()),
        );
        let (state, outbound, mut receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound.clone(),
            client,
            events,
            1,
        ));
        wire.register(&[]).await;
        while !matches!(
            receiver.recv().await,
            Some(EngineToUi::NetworkStateChanged { ref network })
                if network.state == NetworkConnectionState::Online
        ) {}
        let runtime = Runtime { state, outbound };

        _ = runtime.request(EngineRequestEnvelope {
            id: "foreground".into(),
            request: EngineRequest::Reconnect {
                network_id: NetworkId(1),
            },
        });

        assert!(
            wire.next_sent().await.starts_with("PING "),
            "the foreground probes the socket"
        );
        tokio::time::timeout(super::FOREGROUND_PROBE_TIMEOUT * 2, async {
            while wire.next_sent_or_closed().await.is_some() {}
        })
        .await
        .expect("papo ends a socket that stays silent past the probe deadline");
        wire.close().await;
        assert_eq!(wire.next_sent().await, "CAP LS 302", "papo redials it");
        drain.abort();
    }

    #[tokio::test]
    async fn a_stopped_driver_ends_the_connection_it_was_running() {
        let (client, events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound,
            client.clone(),
            events,
            1,
        ));
        wire.register(&[]).await;
        while !matches!(
            receiver.recv().await,
            Some(EngineToUi::NetworkStateChanged { ref network })
                if network.state == NetworkConnectionState::Online
        ) {}

        drop(wire);
        drain.await.expect("event stream ends");

        let output = collect(&mut receiver);
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::NetworkStateChanged { network } if network.state
                == NetworkConnectionState::Failed {
                    reason: crate::ConnectionFailureReason::Protocol,
                    message_key: EngineMessageKey::ConnectionFailed,
                }
        )));
        assert!(!client.snapshot().is_connected());
    }

    fn known_nick(client: &papo::Client, name: &str) -> papo::Nick {
        client
            .snapshot()
            .name_rules()
            .expect("registered test client has name rules")
            .nick(name)
    }

    fn disconnected(
        cause: papo::DisconnectCause,
        reconnect_in: Option<Duration>,
    ) -> papo::event::Disconnected {
        match papo_testing::ErrorBuilder::disconnected(cause, 1, reconnect_in).build() {
            papo::Error::Disconnected(disconnected) => disconnected,
            other => panic!("disconnect fixture built {other:?}"),
        }
    }

    fn wire_time(time: std::time::SystemTime) -> String {
        papo::ServerTime::from_stored_millis(crate::state::time_millis(time))
            .expect("test times are server times")
            .to_string()
    }

    fn parse_wire_time(text: &str) -> Option<std::time::SystemTime> {
        papo::ServerTime::from_stored(text)
            .ok()
            .map(papo::ServerTime::to_system_time)
    }

    async fn begin_send(
        model: &mut NetworkModel,
        client: &papo::Client,
        wire: &mut Wire,
        buffer_id: BufferId,
        text: &str,
        expected_line: &str,
    ) -> (PendingSend, papo::SendOutcome) {
        let (pending, immediate) = model
            .begin_send(buffer_id, text.into(), &client.snapshot())
            .expect("buffer is sendable");
        let timeline = model.take_timeline_changes(false);
        assert!(
            changed_messages(&timeline)
                .first()
                .is_some_and(|(_, message)| message.text == text)
        );
        assert!(
            immediate
                .iter()
                .any(|event| matches!(event, EngineToUi::BufferUpdated { .. }))
        );
        let sender = client.clone();
        let send_pending = pending.clone();
        let send_task = tokio::spawn(async move { super::send(&sender, &send_pending).await });
        assert_eq!(wire.next_sent().await, expected_line);
        let sent = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        (pending, sent)
    }

    async fn apply_test_mode(wire: &mut Wire, events: &mut papo::Events, change: &str) {
        wire.server(format!(":weblounge!u@host MODE #room {change}"))
            .await;
        _ = next_matching(events, |event| matches!(event, papo::Event::ModeChanged(_))).await;
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
                reply_to: None,
            },
        });
        assert!(shown.iter().any(|event| matches!(
            event,
            EngineToUi::TimelineChanged { upserted, .. } if upserted.iter().any(|item| matches!(
                &item.body,
                crate::timeline::ItemBody::System(system) if system.line
                    == crate::timeline::SystemLine::Event {
                        event: crate::timeline::LineEvent::TopicCard {
                            topic: "new topic".into(),
                            setter: Some("weblounge".into()),
                            set_at_ms: None,
                        },
                    }
            ))
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

    fn mark_runtime_online(runtime: &Runtime) {
        lock(&runtime.state)
            .network
            .as_mut()
            .expect("network remains running")
            .model
            .set_connection(crate::NetworkConnectionState::Online, None);
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
            calendar: Arc::new(FixedOffsetCalendar::default()),
            next_network_id: 2,
            next_instance: 2,
            member_views: MemberViews::default(),
            storage: Arc::default(),
            snapshot_writer: Arc::default(),
            cached_snapshot: None,
            cached_pushed_messages: Vec::new(),
            build_version: "weblounge test".into(),
            update_ready: false,
            inflight_send_cancel: None,
            network: Some(RunningNetwork {
                instance: 1,
                identity: ConnectionIdentity::test_plain(),
                connection_attempt: 1,
                device_online: true,
                pending_sends: VecDeque::new(),
                flushing_sends: false,
                pending_reads: VecDeque::new(),
                flushing_reads: false,
                hosted_reconnect: None,
                chat_list: ChatListSync::default(),
                push: PushRegistration::default(),
                typing: crate::typing::OutgoingTyping::default(),
                client,
                model,
            }),
        }));
        let (outbound, receiver) = mpsc::unbounded_channel();
        (state, outbound, receiver)
    }

    fn restore_cached_room(state: &Arc<Mutex<RuntimeState>>) {
        let mut state = lock(state);
        let running = state.network.as_mut().expect("network remains active");
        running.model.restore_cached_chat_list(
            ChatListSnapshot::new(
                "network".into(),
                vec![SnapshotRow {
                    conversation: SnapshotConversation::Channel {
                        key: "#room".into(),
                    },
                    title: "#room".into(),
                    last_activity_ms: Some(100),
                    stubs: snapshot_stubs(1, 0, 100),
                    redacted_stubs: Vec::new(),
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
                    peer_bot: false,
                }],
            )
            .with_cursor_ms(Some(100)),
        );
        running
            .model
            .set_connection(NetworkConnectionState::Online, None);
        running.chat_list.fingerprint = "network".into();
    }

    fn complete_alice_chat_list(
        state: &Arc<Mutex<RuntimeState>>,
        client: &papo::Client,
    ) -> HistoryTarget {
        let nick = client
            .snapshot()
            .name_rules()
            .expect("registration established name rules")
            .nick("alice");
        let conversation = NameKey::Direct(nick.clone());
        let mut state = lock(state);
        let running = state.network.as_mut().expect("network remains active");
        running
            .model
            .set_connection(NetworkConnectionState::Online, None);
        let buffer_id = running
            .model
            .buffer_id_for_target(&SendTarget::Direct {
                nick: nick.clone(),
                pin: None,
                tls: false,
            })
            .expect("direct buffer exists");
        assert!(
            running
                .model
                .request_history(buffer_id, crate::HistoryDirection::Older)
                .is_some()
        );
        assert!(
            running
                .model
                .finish_history(&conversation, None, None, None, 1, true)
                .is_some()
        );
        running.chat_list.fingerprint = "network".into();
        HistoryTarget::Direct(nick)
    }

    async fn stored_snapshot_counts(state: &Arc<Mutex<RuntimeState>>) -> (usize, usize) {
        let storage = lock(state).storage.clone();
        let snapshot = read(storage.as_ref())
            .await
            .expect("read snapshot")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"))
            .expect("stored snapshot");
        let row = snapshot
            .rows
            .iter()
            .find(|row| {
                row.conversation
                    == SnapshotConversation::Direct {
                        key: "alice".into(),
                    }
            })
            .expect("alice snapshot row");
        (
            row.stubs.len(),
            row.stubs.iter().filter(|stub| stub.mention).count(),
        )
    }

    async fn assert_stored_snapshot_contains(
        state: &Arc<Mutex<RuntimeState>>,
        expected: &SnapshotRow,
    ) {
        let storage = lock(state).storage.clone();
        let snapshot = read(storage.as_ref())
            .await
            .expect("read snapshot")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"))
            .expect("stored snapshot");
        assert!(
            snapshot.rows.contains(expected),
            "stored rows: {:#?}",
            snapshot.rows
        );
    }

    async fn restore_and_store_snapshot(
        state: &Arc<Mutex<RuntimeState>>,
        snapshot: &ChatListSnapshot,
    ) {
        let storage = {
            let mut state = lock(state);
            let running = state.network.as_mut().expect("network remains active");
            running.model.restore_cached_chat_list(snapshot.clone());
            running.chat_list.snapshot = Some(snapshot.clone());
            Arc::clone(&state.storage)
        };
        crate::chat_list_snapshot::write(storage.as_ref(), snapshot)
            .await
            .expect("seed cache");
    }

    async fn enable_test_monitor(
        events: &mut papo::Events,
        wire: &mut papo_testing::Wire,
        limit: usize,
    ) {
        wire.server(format!(
            ":offline.test 005 weblounge MONITOR={limit} :supported"
        ))
        .await;
        _ = next_matching(events, |event| {
            matches!(event, papo::Event::FeaturesChanged { .. })
        })
        .await;
    }

    async fn command_output(receiver: &mut mpsc::UnboundedReceiver<EngineToUi>) -> Vec<EngineToUi> {
        let mut output = Vec::new();
        loop {
            let event = receiver.recv().await.expect("command completes");
            let complete = matches!(event, EngineToUi::CommandResult { .. });
            output.push(event);
            if complete {
                return output;
            }
        }
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
    ) -> (BufferId, Vec<crate::MessageProjection>) {
        let messages = changed_messages(&collect(receiver));
        let buffer_id = messages
            .first()
            .map(|(buffer_id, _)| *buffer_id)
            .expect("requested history is prepended");
        (
            buffer_id,
            messages.into_iter().map(|(_, message)| message).collect(),
        )
    }

    fn assert_history(messages: &[crate::MessageProjection], texts: &[&str], timestamped: &[bool]) {
        assert_eq!(
            messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            texts
        );
        assert_eq!(
            messages
                .iter()
                .map(|message| message.server_time_ms.is_some())
                .collect::<Vec<_>>(),
            timestamped
        );
    }

    async fn register_for_history(wire: &mut papo_testing::Wire) {
        register_with_caps(wire, HISTORY_CAPS).await;
    }

    async fn register_with_caps(wire: &mut papo_testing::Wire, caps: &str) {
        assert_eq!(wire.next_sent().await, "CAP LS 302");
        assert_eq!(wire.next_sent().await, "NICK weblounge");
        assert!(wire.next_sent().await.starts_with("USER "));
        wire.server(format!(":offline.test CAP * LS :{caps}")).await;
        let requested = wire
            .next_sent()
            .await
            .strip_prefix("CAP REQ :")
            .expect("capabilities are requested")
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

    fn push_wire() -> (papo::Client, papo::Events, papo_testing::Wire) {
        wire(
            papo::Client::builder("irc://offline.test", "weblounge")
                .enable(papo::Feature::WebPush)
                .allow_insecure_auth(true),
        )
    }

    async fn register_push_connection(
        wire: &mut papo_testing::Wire,
        vapid: Option<&str>,
        account: bool,
    ) {
        register_connection(
            wire,
            &["batch", "draft/webpush", "labeled-response"],
            &vapid_token(vapid),
            account,
        )
        .await;
    }

    fn vapid_token(vapid: Option<&str>) -> String {
        vapid.map_or_else(String::new, |key| format!(" VAPID={key}"))
    }

    async fn register_connection(
        wire: &mut papo_testing::Wire,
        caps: &[&str],
        extra_isupport: &str,
        account: bool,
    ) {
        assert_eq!(wire.next_sent().await, "CAP LS 302");
        assert_eq!(wire.next_sent().await, "NICK weblounge");
        assert!(wire.next_sent().await.starts_with("USER "));
        wire.server(format!(":offline.test CAP * LS :{}", caps.join(" ")))
            .await;
        let negotiation = wire.next_sent().await;
        if let Some(requested) = negotiation.strip_prefix("CAP REQ :") {
            wire.server(format!(":offline.test CAP * ACK :{requested}"))
                .await;
            assert_eq!(wire.next_sent().await, "CAP END");
        } else {
            assert_eq!(negotiation, "CAP END");
        }
        wire.server(format!(
            ":offline.test 005 weblounge CASEMAPPING=rfc1459 CHANTYPES=#{extra_isupport} :supported"
        ))
        .await;
        if account {
            wire.server(
                ":offline.test 900 weblounge weblounge!u@host account :You are now logged in as account",
            )
            .await;
        }
        wire.server(":offline.test 001 weblounge :Welcome").await;
        wire.server(":offline.test 376 weblounge :End of MOTD")
            .await;
    }

    fn push_request(command_id: &str, route_id: &str) -> EngineRequestEnvelope {
        EngineRequestEnvelope {
            id: command_id.into(),
            request: EngineRequest::EnsurePush {
                network_id: NetworkId(1),
                route: crate::PushRoute {
                    route_id: route_id.into(),
                    endpoint: format!("https://push.example.test/v1/r/{route_id}"),
                    p256dh: "AQIDBAUGBwgJCgsMDQ4P_w".into(),
                    auth: "-vv8_f7_".into(),
                },
                unregister: Vec::new(),
            },
        }
    }

    fn request_without_label(request: &str) -> &str {
        request
            .split_once(' ')
            .map(|(_, request)| request)
            .expect("request has a label")
    }

    async fn send_push_success(
        wire: &mut papo_testing::Wire,
        request: &str,
        persistence_required: bool,
    ) {
        let label = request_label(request);
        let reply = format!("push{label}");
        let response = request_without_label(request);
        wire.server(format!(
            "@label={label} :offline.test BATCH +{reply} labeled-response"
        ))
        .await;
        wire.server(format!("@batch={reply} :offline.test {response}"))
            .await;
        if persistence_required {
            wire.server(format!(
                "@batch={reply} :offline.test WARN WEBPUSH PERSISTENCE_REQUIRED :Always-on is required"
            ))
            .await;
        }
        wire.server(format!(":offline.test BATCH -{reply}")).await;
    }

    async fn send_recent_targets(
        wire: &mut papo_testing::Wire,
        label: &str,
        targets: &[(&str, &str)],
    ) {
        let reply = format!("reply{label}");
        let batch = format!("targets{label}");
        wire.server(format!(
            "@label={label} :offline.test BATCH +{reply} labeled-response"
        ))
        .await;
        wire.server(format!(
            "@batch={reply} :offline.test BATCH +{batch} draft/chathistory-targets"
        ))
        .await;
        for (target, time) in targets {
            wire.server(format!(
                "@batch={batch} :offline.test CHATHISTORY TARGETS {target} {time}"
            ))
            .await;
        }
        wire.server(format!("@batch={reply} :offline.test BATCH -{batch}"))
            .await;
        wire.server(format!(":offline.test BATCH -{reply}")).await;
    }

    fn request_label(request: &str) -> &str {
        request
            .strip_prefix("@label=")
            .and_then(|line| line.split_once(' '))
            .map(|(label, _)| label)
            .expect("catch-up request has a label")
    }

    fn retained_channel(model: &NetworkModel, expected: &str) -> papo::ChannelName {
        model
            .history_targets()
            .into_iter()
            .find_map(|target| match target {
                HistoryTarget::Channel(channel) if channel.as_str() == expected => Some(channel),
                HistoryTarget::Channel(_) | HistoryTarget::Direct(_) => None,
            })
            .expect("retained channel target")
    }

    async fn send_history_page(wire: &mut papo_testing::Wire, label: &str, items: &[&str]) {
        send_history_page_with_end(wire, label, items, false).await;
    }

    async fn send_history_page_with_end(
        wire: &mut papo_testing::Wire,
        label: &str,
        items: &[&str],
        end: bool,
    ) {
        send_history_page_for(wire, label, "#room", items, end).await;
    }

    async fn send_history_page_for(
        wire: &mut papo_testing::Wire,
        label: &str,
        conversation: &str,
        items: &[&str],
        end: bool,
    ) {
        let reply = format!("reply{label}");
        let history = format!("history{label}");
        wire.server(format!(
            "@label={label} :offline.test BATCH +{reply} labeled-response"
        ))
        .await;
        let end_tag = if end { ";draft/chathistory-end" } else { "" };
        wire.server(format!(
            "@batch={reply}{end_tag} :offline.test BATCH +{history} chathistory {conversation}"
        ))
        .await;
        for item in items {
            wire.server(format!("@batch={history};{item}")).await;
        }
        wire.server(format!("@batch={reply} :offline.test BATCH -{history}"))
            .await;
        wire.server(format!(":offline.test BATCH -{reply}")).await;
    }

    /// Ergo tags a single-batch reply's `BATCH` with the label instead of wrapping it in
    /// `labeled-response`. Items are whole lines so they can nest `draft/multiline`; `{batch}`
    /// stands for the page's reference.
    async fn send_ergo_history_page(wire: &mut papo_testing::Wire, request: &str, items: &[&str]) {
        let label = request_label(request);
        let batch = format!("history{label}");
        wire.server(format!(
            "@label={label} :offline.test BATCH +{batch} chathistory #room"
        ))
        .await;
        for item in items {
            wire.server(item.replace("{batch}", &batch)).await;
        }
        wire.server(format!(":offline.test BATCH -{batch}")).await;
    }

    async fn next_sent_containing(wire: &mut papo_testing::Wire, needle: &str) -> String {
        loop {
            let line = wire.next_sent().await;
            if line.contains(needle) {
                return line;
            }
        }
    }

    async fn fetch_requested_page(
        client: &papo::Client,
        wire: &mut papo_testing::Wire,
        fetch: crate::state::HistoryFetch,
        expected_suffix: &str,
        items: &[&str],
    ) -> papo::event::HistoryPage {
        fetch_requested_page_with_end(client, wire, fetch, expected_suffix, items, false).await
    }

    async fn fetch_requested_page_with_end(
        client: &papo::Client,
        wire: &mut papo_testing::Wire,
        fetch: crate::state::HistoryFetch,
        expected_suffix: &str,
        items: &[&str],
        end: bool,
    ) -> papo::event::HistoryPage {
        let fetch_client = client.clone();
        let task = tokio::spawn(async move { fetch_history(&fetch_client, fetch).await });
        let request = wire.next_sent().await;
        assert!(request.ends_with(expected_suffix));
        let label = request_label(&request);
        send_history_page_with_end(wire, label, items, end).await;
        task.await
            .expect("history task completes")
            .expect("history request succeeds")
    }

    fn same_time_history_items(range: std::ops::Range<usize>) -> Vec<String> {
        range
            .map(|index| {
                format!(
                    "time=2026-10-27T12:00:00.000Z;msgid=m{index} :alice!a@host PRIVMSG #room :line {index}"
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn channel_history_senders_do_not_allocate_monitor_entries() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        register_for_history(&mut wire).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 100).await;
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, _receiver) = harness(client.clone());
        let fetch_request = process_event(&state, &outbound, &client, 1, joined)
            .pop()
            .expect("joined channel requests history");
        let fetch_client = client.clone();
        let fetch = tokio::spawn(async move { fetch_history(&fetch_client, fetch_request).await });
        let request = wire.next_sent().await;
        let label = request_label(&request);
        let items = (0..50)
            .map(|index| {
                format!(
                    "time=2026-10-27T12:00:00.000Z;msgid=m{index} :user{index}!u@host PRIVMSG #room :line {index}"
                )
            })
            .collect::<Vec<_>>();
        let item_refs = items.iter().map(String::as_str).collect::<Vec<_>>();
        send_history_page(&mut wire, label, &item_refs).await;
        let page = fetch
            .await
            .expect("history task completes")
            .expect("history request succeeds");

        process_history(&state, &outbound, &client, 1, page);
        // wait-ok: measures a fixed window in which MONITOR traffic must remain absent.
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wire.next_sent())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn read_markers_sync_only_where_papo_can_correlate_the_reply() {
        for (caps, expected) in [
            (
                "draft/read-marker labeled-response batch server-time message-tags",
                true,
            ),
            ("draft/read-marker batch server-time message-tags", false),
            ("labeled-response batch server-time message-tags", false),
        ] {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            register_with_caps(&mut wire, caps).await;
            _ = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;

            assert_eq!(
                super::can_sync_read_markers(&client.snapshot()),
                expected,
                "{caps}"
            );
        }
    }

    #[tokio::test]
    async fn history_is_fetched_only_where_papo_can_correlate_the_reply() {
        for (caps, expected) in [
            (HISTORY_CAPS, true),
            ("draft/chathistory batch server-time message-tags", false),
            (
                "draft/chathistory labeled-response server-time message-tags",
                false,
            ),
            ("labeled-response batch server-time message-tags", false),
        ] {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            register_with_caps(&mut wire, caps).await;
            _ = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;

            assert_eq!(
                super::can_fetch_history(&client.snapshot()),
                expected,
                "{caps}"
            );
        }
    }

    #[tokio::test]
    async fn connected_restores_recent_directs_from_history_targets_in_activity_order() {
        let (client, events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound,
            client,
            events,
            1,
        ));

        register_for_history(&mut wire).await;
        let request = wire.next_sent().await;
        assert!(request.contains(" CHATHISTORY TARGETS timestamp="));
        assert!(request.ends_with(" 100"));
        let label = request_label(&request);
        send_recent_targets(
            &mut wire,
            label,
            &[
                ("#ignored", "2026-10-30T12:00:03.000Z"),
                ("Bob", "2026-10-30T12:00:01.000Z"),
                ("alice", "2026-10-30T12:00:01.000Z"),
                ("carol", "2026-10-30T12:00:02.000Z"),
            ],
        )
        .await;

        let ordered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let EngineToUi::BuffersChanged { buffers, .. } =
                    receiver.recv().await.expect("runtime remains active")
                {
                    let titles = buffers
                        .iter()
                        .map(|buffer| buffer.title.as_str())
                        .collect::<Vec<_>>();
                    if titles.len() == 4 {
                        break titles.into_iter().map(str::to_owned).collect::<Vec<_>>();
                    }
                }
            }
        })
        .await
        .expect("recent direct buffers arrive");
        assert_eq!(ordered, ["Test", "carol", "alice", "Bob"]);

        let mut latest_targets = Vec::new();
        while latest_targets.len() < 3 {
            let request = tokio::time::timeout(Duration::from_secs(1), wire.next_sent())
                .await
                .expect("direct latest history starts without waiting for presence lookup");
            if request.contains(" CHATHISTORY LATEST ") {
                let target = request
                    .split_whitespace()
                    .nth(3)
                    .expect("latest history target is present")
                    .to_owned();
                latest_targets.push(target);
                let label = request_label(&request);
                send_history_page(&mut wire, label, &[]).await;
            }
        }
        latest_targets.sort();
        assert_eq!(latest_targets, ["Bob", "alice", "carol"]);
        assert!(matches!(
            receiver.recv().await,
            Some(EngineToUi::RecentDirectsReady {
                network_id: NetworkId(1)
            })
        ));

        drain.abort();
    }

    #[tokio::test]
    async fn target_window_includes_lines_stamped_after_the_query() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_for_history(&mut wire).await;
        let (state, outbound, _receiver) = harness(client.clone());

        spawn_target_reconciliation(Arc::clone(&state), outbound, client.clone(), 1);
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        let own_flush_stamp = papo::time::now();

        let end = targets
            .split_whitespace()
            .nth(4)
            .and_then(|bound| bound.strip_prefix("timestamp="))
            .and_then(parse_wire_time)
            .expect("TARGETS end bound");
        assert!(end > own_flush_stamp, "{targets}");

        send_recent_targets(&mut wire, request_label(&targets), &[]).await;
        let cursor = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let cursor = lock(&state)
                    .network
                    .as_ref()
                    .and_then(|running| running.model.cursor());
                if let Some(cursor) = cursor {
                    break cursor;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("an empty complete TARGETS page settles the cursor");
        assert!(cursor <= own_flush_stamp);
    }

    #[tokio::test]
    async fn target_refusal_falls_back_to_cached_latest_history() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_for_history(&mut wire).await;
        let (state, outbound, _receiver) = harness(client.clone());
        restore_cached_room(&state);

        spawn_target_reconciliation(Arc::clone(&state), outbound, client.clone(), 1);
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        wire.server(format!(
            "@label={} :offline.test FAIL CHATHISTORY INVALID_PARAMS * :targets refused",
            request_label(&targets)
        ))
        .await;
        let latest = next_sent_containing(&mut wire, " CHATHISTORY LATEST #room ").await;
        send_history_page(&mut wire, request_label(&latest), &[]).await;
    }

    #[tokio::test]
    async fn reconciliation_monitors_every_shown_direct_peer_in_one_batch() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_for_history(&mut wire).await;
        enable_test_monitor(&mut events, &mut wire, 100).await;
        let (state, outbound, _receiver) = harness(client.clone());

        spawn_target_reconciliation(Arc::clone(&state), outbound, client, 1);
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        send_recent_targets(
            &mut wire,
            request_label(&targets),
            &[
                ("#room", "2026-10-30T12:00:03.000Z"),
                ("alice", "2026-10-30T12:00:02.000Z"),
                ("Bob", "2026-10-30T12:00:01.000Z"),
            ],
        )
        .await;

        let monitor = loop {
            let line = wire.next_sent().await;
            if line.contains(" CHATHISTORY LATEST ") {
                send_history_page(&mut wire, request_label(&line), &[]).await;
            } else if line.starts_with("MONITOR ") {
                break line;
            }
        };
        assert_eq!(monitor, "MONITOR + alice,Bob");
    }

    #[tokio::test]
    async fn the_launch_monitor_batch_leaves_half_the_list_for_direct_handles() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        enable_test_monitor(&mut events, &mut wire, 4).await;
        let (state, _outbound, _receiver) = harness(client.clone());
        for nick in ["alice", "bob", "carol"] {
            wire.server(format!(":{nick}!u@h PRIVMSG weblounge :hi"))
                .await;
            let papo::Event::Message(message) = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Message(_))
            })
            .await
            else {
                panic!("message expected")
            };
            lock(&state)
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .open_direct(
                    message.actor.nick().clone(),
                    DirectAvailability::Pending,
                    &client.snapshot(),
                );
        }

        monitor_shown_direct_peers(&state, &client, 1);

        let sent = wire.next_sent().await;
        assert!(
            sent.starts_with("MONITOR + ") && sent.split(',').count() == 2,
            "{sent}"
        );
        assert_eq!(launch_monitor_budget(None), 0);
    }

    #[tokio::test]
    async fn unsupported_targets_leave_cached_rows_complete() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_with_caps(&mut wire, "batch labeled-response").await;
        let (state, outbound, mut receiver) = harness(client.clone());
        restore_cached_room(&state);

        spawn_target_reconciliation(Arc::clone(&state), outbound, client, 1);
        loop {
            if matches!(
                receiver.recv().await,
                Some(EngineToUi::RecentDirectsReady { .. })
            ) {
                break;
            }
        }

        let state = lock(&state);
        let running = state.network.as_ref().expect("network remains active");
        assert!(running.model.cursor().is_some());
    }

    #[tokio::test]
    async fn restored_target_rows_hold_the_boundary_until_delta_completion() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_for_history(&mut wire).await;
        let (state, outbound, _receiver) = harness(client.clone());
        restore_cached_room(&state);
        let channel =
            papo_testing::channel(crate::name_key::casemapping(&client.snapshot()), "#room");

        restore_target_rows(
            &state,
            &outbound,
            &client,
            1,
            vec![(
                NameKey::Channel(channel),
                UNIX_EPOCH + Duration::from_millis(300),
            )],
            true,
            UNIX_EPOCH + Duration::from_millis(300),
        );

        let after = next_sent_containing(&mut wire, " CHATHISTORY LATEST #room ").await;
        assert_eq!(
            lock(&state)
                .network
                .as_ref()
                .expect("network remains active")
                .model
                .cursor(),
            Some(UNIX_EPOCH + Duration::from_millis(100))
        );
        send_history_page(&mut wire, request_label(&after), &[]).await;
    }

    #[tokio::test]
    async fn unchanged_direct_with_stubs_fetches_marker_and_clears_covered_push() {
        let caps = [
            "batch",
            "draft/chathistory",
            "draft/read-marker",
            "labeled-response",
            "message-tags",
            "server-time",
        ];
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        {
            let mut state = lock(&state);
            state
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .restore_cached_chat_list(ChatListSnapshot::new(
                    "network".into(),
                    vec![SnapshotRow {
                        conversation: SnapshotConversation::Direct {
                            key: "alice".into(),
                        },
                        title: "alice".into(),
                        last_activity_ms: Some(100),
                        stubs: snapshot_stubs(3, 3, 100),
                        redacted_stubs: Vec::new(),
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
                        peer_bot: false,
                    }],
                ));
        }
        restore_target_rows(
            &state,
            &outbound,
            &client,
            1,
            Vec::new(),
            true,
            UNIX_EPOCH + Duration::from_millis(100),
        );

        let request = wire.next_sent().await;
        assert!(request.ends_with("MARKREAD alice"));
        {
            let state = lock(&state);
            let model = &state
                .network
                .as_ref()
                .expect("network remains active")
                .model;
            let EngineToUi::BuffersChanged { buffers, .. } = model.buffers_event() else {
                panic!("buffer projection event expected")
            };
            assert_eq!(
                buffers
                    .iter()
                    .find(|buffer| buffer.title == "alice")
                    .map(|buffer| (buffer.unread, buffer.mentions)),
                Some((3, 3))
            );
        }

        let label = request_label(&request);
        let marker = wire_time(UNIX_EPOCH + Duration::from_millis(100));
        wire.server(format!(
            "@label={label} :offline.test MARKREAD alice timestamp={marker}"
        ))
        .await;
        loop {
            let Some(event) = receiver.recv().await else {
                panic!("engine event stream remains open")
            };
            if let EngineToUi::BufferUpdated { buffer } = event
                && buffer.title == "alice"
                && buffer.read_at_ms == Some(100)
            {
                assert_eq!((buffer.unread, buffer.mentions), (0, 0));
                break;
            }
        }
    }

    async fn send_account_tagged_live_direct(
        wire: &mut Wire,
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
        cursor: std::time::SystemTime,
    ) -> String {
        let cursor_text = wire_time(cursor);
        wire.server(format!(
            "@account=alice;msgid=alice-live;time={cursor_text} :Alice!a@host PRIVMSG weblounge :first live direct"
        ))
        .await;
        let alice_buffer = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(EngineToUi::BufferAdded { buffer }) = receiver.recv().await
                    && buffer.title == "Alice"
                {
                    break buffer.id;
                }
            }
        })
        .await
        .expect("live direct creates its buffer before advancing the cursor");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if matches!(
                    receiver.recv().await,
                    Some(EngineToUi::BufferUpdated { buffer })
                        if buffer.id == alice_buffer
                            && buffer.unread == 1
                            && buffer.mentions == 1
                ) {
                    break;
                }
            }
        })
        .await
        .expect("first live direct remains after its seeded mark");
        cursor_text
    }

    #[tokio::test]
    async fn same_millisecond_direct_stays_unread_when_it_creates_its_row() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags", "server-time"]).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let message_time = UNIX_EPOCH + Duration::from_millis(1_000);
        {
            let mut state = lock(&state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            let earlier = message_time - Duration::from_millis(1);
            model.begin_target_sync(earlier);
            model.finish_target_sync(Some(earlier));
            model.set_connection(NetworkConnectionState::Online, None);
        }
        let time = wire_time(message_time);

        wire.server(format!(
            "@msgid=channel-live;time={time} :Bob!b@host PRIVMSG #room :channel live"
        ))
        .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        wire.server(format!(
            "@msgid=direct-live;time={time} :Alice!a@host PRIVMSG weblounge :direct live"
        ))
        .await;
        process_next_message(&mut events, &state, &outbound, &client).await;

        let output = collect(&mut receiver);
        let direct = output
            .iter()
            .find_map(|event| match event {
                EngineToUi::BufferAdded { buffer } if buffer.title == "Alice" => Some(buffer.id),
                _ => None,
            })
            .expect("direct message creates its row");
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == direct && buffer.unread == 1 && buffer.mentions == 1
        )));
    }

    #[tokio::test]
    async fn second_connected_catches_up_a_ready_direct_after_its_newest_msgid() {
        let (client, events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound,
            client.clone(),
            events,
            1,
        ));

        register_for_history(&mut wire).await;
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        send_recent_targets(
            &mut wire,
            request_label(&targets),
            &[("Bob", "2026-10-30T12:00:01.000Z")],
        )
        .await;
        let latest = next_sent_containing(&mut wire, " CHATHISTORY LATEST Bob ").await;
        send_history_page_for(
            &mut wire,
            request_label(&latest),
            "Bob",
            &["time=2026-10-30T12:00:01.000Z;msgid=dm-1 :Bob!b@host PRIVMSG weblounge :before disconnect"],
            false,
        )
        .await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if matches!(
                    receiver.recv().await,
                    Some(EngineToUi::HistoryStateChanged { loading: false, .. })
                ) {
                    break;
                }
            }
        })
        .await
        .expect("direct latest history becomes ready");

        let settled_cursor = lock(&state)
            .network
            .as_ref()
            .expect("network remains active")
            .model
            .cursor()
            .expect("initial target sync settles the cursor");
        let live_cursor_text = wire_time(settled_cursor + Duration::from_millis(1));
        let live_cursor = parse_wire_time(&live_cursor_text).expect("formatted live cursor parses");
        assert!(live_cursor > settled_cursor);
        wire.server(format!(
            "@time={live_cursor_text} :offline.test NOTICE weblounge :live cursor"
        ))
        .await;
        let advanced_cursor = loop {
            let cursor = lock(&state)
                .network
                .as_ref()
                .expect("network remains active")
                .model
                .cursor();
            if cursor.is_some_and(|cursor| cursor >= live_cursor) {
                break cursor;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(advanced_cursor, Some(live_cursor));

        let direct_cursor_text = send_account_tagged_live_direct(
            &mut wire,
            &mut receiver,
            live_cursor + Duration::from_millis(1),
        )
        .await;

        wire.close().await;
        while client.snapshot().is_connected() {
            tokio::task::yield_now().await;
        }
        client.reconnect().await.expect("manual reconnect starts");
        register_for_history(&mut wire).await;
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        assert!(targets.contains(&format!("timestamp={direct_cursor_text}")));
        send_recent_targets(
            &mut wire,
            request_label(&targets),
            &[("Bob", "2026-10-30T12:00:02.000Z")],
        )
        .await;
        let after = tokio::time::timeout(
            Duration::from_secs(1),
            next_sent_containing(&mut wire, " CHATHISTORY LATEST Bob "),
        )
        .await
        .expect("ready direct catch-up starts on the second connection");
        assert!(after.ends_with("CHATHISTORY LATEST Bob msgid=dm-1 100"));

        drain.abort();
    }

    #[tokio::test]
    async fn hosted_fresh_client_waits_for_targets_before_catching_up_a_ready_channel() {
        let (first, mut first_events, mut first_wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        register_for_history(&mut first_wire).await;
        let connected = next_matching(&mut first_events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, _receiver) = harness(first.clone());
        process_event(&state, &outbound, &first, 1, connected);
        assert!(first_wire.next_sent().await.ends_with("JOIN #room"));
        first_wire.server(":weblounge!u@host JOIN #room").await;
        let joined = next_matching(&mut first_events, |event| {
            matches!(event, papo::Event::Joined(_))
        })
        .await;
        let latest = process_event(&state, &outbound, &first, 1, joined)
            .pop()
            .expect("joined channel requests latest history");
        let first_fetch = first.clone();
        let latest_task = tokio::spawn(async move { fetch_history(&first_fetch, latest).await });
        let request = next_sent_containing(&mut first_wire, " CHATHISTORY LATEST #room ").await;
        send_history_page(
            &mut first_wire,
            request_label(&request),
            &["time=2026-10-30T12:00:01.000Z;msgid=channel-1 :alice!a@host PRIVMSG #room :before reconnect"],
        )
        .await;
        let page = latest_task
            .await
            .expect("latest task completes")
            .expect("latest history succeeds");
        process_history(&state, &outbound, &first, 1, page);

        let (fresh, mut fresh_events, mut fresh_wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        register_for_history(&mut fresh_wire).await;
        let connected = next_matching(&mut fresh_events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(process_event(&state, &outbound, &fresh, 1, connected).is_empty());
        let after = {
            let mut state = lock(&state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            let channel = retained_channel(model, "#room");
            model
                .restore_channel(&channel, UNIX_EPOCH + Duration::from_secs(2_000_000_000))
                .expect("TARGETS starts the retained channel delta")
        };
        let fresh_fetch = fresh.clone();
        let after_task = tokio::spawn(async move { fetch_history(&fresh_fetch, after).await });
        let request = next_sent_containing(&mut fresh_wire, " CHATHISTORY LATEST #room ").await;
        assert!(request.ends_with("CHATHISTORY LATEST #room msgid=channel-1 100"));
        after_task.abort();
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
        let fetch_request = targets[0].clone();
        let fetch = tokio::spawn(async move { fetch_history(&fetch_client, fetch_request).await });
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

        let (buffer_id, prepended) = take_prepended(&mut receiver);
        assert_history(&prepended, &["older", "middle"], &[true, true]);

        let older_fetch = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id, crate::HistoryDirection::Older)
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
        process_history(&state, &outbound, &client, 1, page);
        let (_, prepended) = take_prepended(&mut receiver);
        assert_history(&prepended, &["first", "second"], &[true, true]);

        let final_fetch = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id, crate::HistoryDirection::Older)
            .expect("the server boundary has not been reached yet");
        let page = fetch_requested_page(
            &client,
            &mut wire,
            final_fetch,
            "CHATHISTORY BEFORE #room msgid=first 100",
            &[],
        )
        .await;
        process_history(&state, &outbound, &client, 1, page);

        assert!(
            lock(&state)
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .request_history(buffer_id, crate::HistoryDirection::Older)
                .is_none()
        );
    }

    #[tokio::test]
    async fn pages_more_than_one_thousand_same_time_messages_exactly_once() {
        const MESSAGE_COUNT: usize = 1_025;
        const PAGE_SIZE: usize = 100;

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
        let (state, outbound, mut event_rx) = harness(client.clone());
        let fetch_request = process_event(&state, &outbound, &client, 1, joined)
            .pop()
            .expect("joined channel requests history");
        _ = collect(&mut event_rx);

        let latest_start = MESSAGE_COUNT - PAGE_SIZE;
        let latest_items = same_time_history_items(latest_start..MESSAGE_COUNT);
        let latest_refs = latest_items.iter().map(String::as_str).collect::<Vec<_>>();
        let page = fetch_requested_page(
            &client,
            &mut wire,
            fetch_request,
            "CHATHISTORY LATEST #room * 100",
            &latest_refs,
        )
        .await;
        process_history(&state, &outbound, &client, 1, page);
        let (buffer_id, latest) = take_prepended(&mut event_rx);
        let mut collected_messages = latest;

        let mut page_end = latest_start;
        while page_end > 0 {
            let page_start = page_end.saturating_sub(PAGE_SIZE);
            let fetch = lock(&state)
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .request_history(buffer_id, crate::HistoryDirection::Older)
                .expect("an older page remains requestable");
            let items = same_time_history_items(page_start..page_end);
            let item_refs = items.iter().map(String::as_str).collect::<Vec<_>>();
            let page = fetch_requested_page_with_end(
                &client,
                &mut wire,
                fetch,
                &format!("CHATHISTORY BEFORE #room msgid=m{page_end} 100"),
                &item_refs,
                page_start == 0,
            )
            .await;
            process_history(&state, &outbound, &client, 1, page);
            let (_, older) = take_prepended(&mut event_rx);
            collected_messages.splice(0..0, older);
            page_end = page_start;
        }

        let final_fetch = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id, crate::HistoryDirection::Older)
            .expect("only an empty older page is terminal");
        let page = fetch_requested_page(
            &client,
            &mut wire,
            final_fetch,
            "CHATHISTORY BEFORE #room msgid=m0 100",
            &[],
        )
        .await;
        process_history(&state, &outbound, &client, 1, page);

        assert_eq!(collected_messages.len(), MESSAGE_COUNT);
        assert_eq!(
            collected_messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            (0..MESSAGE_COUNT)
                .map(|index| format!("line {index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            collected_messages
                .iter()
                .flat_map(|message| message.server_ids.iter())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            MESSAGE_COUNT
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
        let fetch_request = targets[0].clone();
        let fetch = tokio::spawn(async move { fetch_history(&fetch_client, fetch_request).await });
        let request = wire.next_sent().await;
        let label = request_label(&request);
        send_history_page(&mut wire, label, &[]).await;
        let page = fetch
            .await
            .expect("history task completes")
            .expect("empty history is successful");
        process_history(&state, &outbound, &client, 1, page);

        assert!(matches!(
            collect(&mut receiver).as_slice(),
            [
                EngineToUi::BufferUpdated { buffer },
                EngineToUi::HistoryStateChanged {
                    loading: false,
                    at_start: true,
                    ..
                }
            ] if buffer.sync_state == crate::BufferSyncState::Synced
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
    async fn own_live_message_advances_the_server_read_marker() {
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
        let (state, outbound, _receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);

        wire.server(
            "@time=2026-10-27T12:00:00.000Z;msgid=own :weblounge!u@host PRIVMSG #room :from phone",
        )
        .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);

        let request = wire.next_sent().await;
        assert!(request.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"));
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"
        ))
        .await;
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
        let (buffer_id, message_id) = changed_messages(&appended)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
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
            EngineToUi::BufferUpdated { buffer }
                if buffer.unread == 0 && buffer.mentions == 0
        )));

        let invalid = runtime.request(EngineRequestEnvelope {
            id: "mark-invalid".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: MessageId(u64::MAX),
            },
        });
        assert!(invalid.iter().any(|event| matches!(
            event,
            EngineToUi::Diagnostic { message, .. }
                if message == EngineMessageKey::ReadMarkerInvalid.as_str()
        )));
        assert!(invalid.iter().all(|event| !matches!(
            event,
            EngineToUi::Notice { key, .. }
                if key == EngineMessageKey::ReadMarkerInvalid.as_str()
                    || key == EngineMessageKey::MarkReadFailed.as_str()
        )));
    }

    #[tokio::test]
    async fn mark_read_while_offline_syncs_after_connecting() {
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
        let (buffer_id, message_id) = changed_messages(&appended)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("live message is projected");
        set_harness_device_online(&state, false);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };

        let output = runtime.request(EngineRequestEnvelope {
            id: "mark-offline".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });

        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.unread == 0 && buffer.mentions == 0
        )));
        assert_eq!(
            lock(&state)
                .network
                .as_ref()
                .expect("network remains active")
                .pending_reads
                .len(),
            1
        );
        set_harness_device_online(&state, true);
        process_event(
            &state,
            &outbound,
            &client,
            1,
            papo::Event::Connected(
                ConnectedBuilder::new(
                    client
                        .snapshot()
                        .name_rules()
                        .expect("registered test client has name rules")
                        .nick("weblounge"),
                )
                .reconnected(true)
                .build(),
            ),
        );

        let request = wire.next_sent().await;
        let label = request_label(&request);
        assert!(request.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"));
        wire.server(format!(
            "@label={label} :offline.test MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"
        ))
        .await;
    }

    #[tokio::test]
    async fn queued_mark_read_resolves_the_replacement_clients_target() {
        let caps = [
            "draft/read-marker",
            "labeled-response",
            "message-tags",
            "server-time",
        ];
        let (first, mut first_events, mut first_wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        first_wire.register(&caps).await;
        _ = next_matching(&mut first_events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        first_wire.server(":weblounge!u@host JOIN #room").await;
        let joined = next_matching(&mut first_events, |event| {
            matches!(event, papo::Event::Joined(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(first.clone());
        process_event(&state, &outbound, &first, 1, joined);
        _ = collect(&mut receiver);
        first_wire
            .server("@time=2026-10-27T12:00:00.000Z;msgid=one :alice!a@host PRIVMSG #room :hello")
            .await;
        process_next_message(&mut first_events, &state, &outbound, &first).await;
        let appended = collect(&mut receiver);
        let (buffer_id, message_id) = changed_messages(&appended)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("live message is projected");
        set_harness_device_online(&state, false);
        _ = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        }
        .request(EngineRequestEnvelope {
            id: "mark-before-replacement".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });
        {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            assert_eq!(
                running.model.pending_read_time(buffer_id),
                Some(UNIX_EPOCH + Duration::from_hours(498_084))
            );
            running.pending_reads.clear();
        }

        let (replacement, mut replacement_events, mut replacement_wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        replacement_wire.register(&caps).await;
        let connected = next_matching(&mut replacement_events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running.client = replacement.clone();
            running.instance = 2;
            running.device_online = true;
            running.flushing_reads = false;
        }
        _ = collect(&mut receiver);
        stamp_server_clock(&mut replacement_wire, "2026-10-27T12:00:01.000Z").await;
        process_event(&state, &outbound, &replacement, 2, connected);

        let request = loop {
            tokio::select! {
                request = replacement_wire.next_sent() => break request,
                event = receiver.recv() => {
                    assert!(!matches!(
                        event,
                        Some(EngineToUi::Diagnostic { message, .. })
                            if message == EngineMessageKey::MarkReadFailed.as_str()
                    ));
                }
            }
        };
        assert!(request.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"));
    }

    #[tokio::test]
    async fn restored_push_marks_immediately_then_repairs_a_millisecond_straddle() {
        let caps = [
            "account-tag",
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
        let (state, outbound, mut receiver) = harness(client.clone());
        let (buffer_id, message_id) = restore_pushed_direct(&state, &client);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };
        stamp_server_clock(&mut wire, "2026-11-03T12:34:57.000Z").await;

        let output = runtime.request(EngineRequestEnvelope {
            id: "mark-pushed".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });

        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == buffer_id && buffer.unread == 0 && buffer.mentions == 0
        )));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::CommandResult { id } if id == "mark-pushed"
        )));
        assert_eq!(
            lock(&state)
                .network
                .as_ref()
                .expect("network remains active")
                .pending_reads
                .len(),
            1
        );
        let request = wire.next_sent().await;
        assert!(
            request.ends_with("MARKREAD alice timestamp=2026-11-03T12:34:56.788Z"),
            "unexpected request: {request}"
        );
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test MARKREAD alice timestamp=2026-11-03T12:34:56.788Z"
        ))
        .await;
        wire.server("@account=alice;msgid=unrelated;time=2026-11-03T12:35:00.000Z :alice!a@host PRIVMSG weblounge :new and unread")
            .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.id == buffer_id && buffer.unread == 1 && buffer.mentions == 1
        )));
        assert!(
            tokio::time::timeout(Duration::ZERO, wire.next_sent())
                .await
                .is_err()
        );
        wire.server("@account=alice;msgid=pushed-direct;time=2026-11-03T12:34:56.789Z :alice!a@host PRIVMSG weblounge :arrived while closed")
            .await;
        process_next_message(&mut events, &state, &outbound, &client).await;

        _ = collect(&mut receiver);
        let request = wire.next_sent().await;
        assert!(
            request.ends_with("MARKREAD alice timestamp=2026-11-03T12:34:56.789Z"),
            "unexpected request: {request}"
        );
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test MARKREAD alice timestamp=2026-11-03T12:34:56.789Z"
        ))
        .await;
    }

    #[tokio::test]
    async fn direct_marker_settles_before_launch_history_can_raise_its_badge() {
        let caps = [
            "batch",
            "draft/chathistory",
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
        let nick = client
            .snapshot()
            .name_rules()
            .expect("registered client has name rules")
            .nick("alice");
        let (state, outbound, _receiver) = harness(client.clone());
        let fetch = {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running
                .model
                .restore_cached_chat_list(ChatListSnapshot::new(
                    "network".into(),
                    vec![SnapshotRow {
                        conversation: SnapshotConversation::Direct {
                            key: "alice".into(),
                        },
                        title: "Alice".into(),
                        last_activity_ms: Some(100),
                        stubs: snapshot_stubs(1, 1, 100),
                        redacted_stubs: Vec::new(),
                        gap_until: None,
                        preview: Some("cached unread".into()),
                        newest: Some(SnapshotCursor {
                            msgid: Some("cached".into()),
                            server_time_ms: 100,
                        }),
                        read_at_ms: Some(50),
                        raw_read_at_ms: Some(50),
                        pending_read_at_ms: None,
                        peer_pin: None,
                        peer_bot: false,
                    }],
                ));
            running
                .model
                .restore_direct(&nick, UNIX_EPOCH + Duration::from_millis(200))
                .0
                .expect("newer target schedules catch-up")
        };

        spawn_history_fetch(Arc::clone(&state), outbound, client, 1, fetch, Some(nick));

        let marker = wire.next_sent().await;
        assert!(
            marker.ends_with("MARKREAD alice"),
            "unexpected request: {marker}"
        );
        assert!(
            tokio::time::timeout(Duration::ZERO, wire.next_sent())
                .await
                .is_err(),
            "history must wait until the marker projection settles"
        );
    }

    #[test]
    fn queued_read_advances_keep_only_the_latest_position() {
        let mut pending = VecDeque::new();
        let advance = ReadAdvance {
            buffer_id: BufferId(1),
            time: UNIX_EPOCH + Duration::from_secs(20),
        };
        queue_read_advance(&mut pending, advance.clone());
        queue_read_advance(
            &mut pending,
            ReadAdvance {
                time: UNIX_EPOCH + Duration::from_secs(10),
                ..advance.clone()
            },
        );
        queue_read_advance(
            &mut pending,
            ReadAdvance {
                time: UNIX_EPOCH + Duration::from_secs(30),
                ..advance
            },
        );

        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().map(|advance| advance.time),
            Some(UNIX_EPOCH + Duration::from_secs(30))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn read_marker_persists_while_another_snapshot_row_is_unresolved() {
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
        let (state, outbound, mut receiver) = harness(client.clone());
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .chat_list
            .fingerprint = "network".into();
        wire.server(
            "@time=2026-10-27T12:00:00.000Z;msgid=one :alice!a@host PRIVMSG weblounge :restored direct",
        )
        .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer }
                if buffer.unread == 1 && buffer.mentions == 1
        )));

        let unresolved = SnapshotRow {
            conversation: SnapshotConversation::Channel {
                key: "#slow".into(),
            },
            title: "#slow cached".into(),
            last_activity_ms: Some(1_700_000_000_000),
            stubs: snapshot_stubs(4, 0, 1_700_000_000_000),
            redacted_stubs: Vec::new(),
            gap_until: None,
            preview: Some("cached slow preview".into()),
            newest: None,
            read_at_ms: None,
            raw_read_at_ms: None,
            pending_read_at_ms: None,
            peer_pin: None,
            peer_bot: false,
        };
        let snapshot = ChatListSnapshot::new("network".into(), vec![unresolved.clone()]);
        restore_and_store_snapshot(&state, &snapshot).await;

        let target = complete_alice_chat_list(&state, &client);
        update_chat_list(&state, &outbound, 1);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        assert_eq!(stored_snapshot_counts(&state).await, (1, 1));

        spawn_read_marker_fetch(Arc::clone(&state), outbound, client, 1, target);
        let request = wire.next_sent().await;
        let label = request_label(&request);
        assert!(request.ends_with("MARKREAD alice"));
        wire.server(format!(
            "@label={label} :offline.test MARKREAD alice timestamp=2026-10-27T12:00:00.000Z"
        ))
        .await;

        let cleared = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(EngineToUi::BufferUpdated { buffer }) = receiver.recv().await
                    && buffer.unread == 0
                    && buffer.mentions == 0
                {
                    break;
                }
            }
        })
        .await;
        assert!(cleared.is_ok());
        tokio::time::advance(Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        assert_eq!(stored_snapshot_counts(&state).await, (0, 0));

        assert_stored_snapshot_contains(&state, &unresolved).await;
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
        wire.server(
            "@time=2026-10-27T12:00:00.377742688Z;msgid=one :alice!a@host PRIVMSG #room :hello",
        )
        .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        let appended = collect(&mut receiver);
        let (buffer_id, message_id) = changed_messages(&appended)
            .first()
            .map(|(buffer_id, message)| (*buffer_id, message.id))
            .expect("live message is projected");
        let runtime = Runtime { state, outbound };

        let output = runtime.request(EngineRequestEnvelope {
            id: "mark-server".into(),
            request: EngineRequest::MarkRead {
                buffer_id,
                through: message_id,
            },
        });
        assert!(output.iter().any(
            |event| matches!(event, EngineToUi::BufferUpdated { buffer } if buffer.unread == 0)
        ));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::CommandResult { id } if id == "mark-server"
        )));
        let request = wire.next_sent().await;
        assert!(request.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.377Z"));
        let label = request_label(&request).to_owned();
        wire.server(format!(
            "@label={label} :offline.test MARKREAD #room timestamp=2026-10-27T12:00:00.377Z"
        ))
        .await;
    }

    #[tokio::test]
    async fn join_marker_repairs_a_push_reconciled_before_join() {
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
        let (state, outbound, _receiver) = harness(client.clone());
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .restore_pushed_messages(
                vec![pushed_channel_message("join-push", "before join")],
                &client.snapshot(),
            );
        wire.server("@time=2026-11-03T12:34:56.790Z;msgid=join-push :alice!u@host PRIVMSG #room :before join")
            .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        wire.server(":offline.test MARKREAD #room timestamp=2026-11-03T12:34:56.789Z")
            .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;

        process_event(&state, &outbound, &client, 1, joined);

        let repair = wire.next_sent().await;
        assert!(repair.ends_with("MARKREAD #room timestamp=2026-11-03T12:34:56.790Z"));
    }

    #[tokio::test]
    async fn reconciled_carry_without_server_support_stays_local() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags", "server-time"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, _receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .restore_pushed_messages(
                vec![pushed_channel_message("local-push", "local carry")],
                &client.snapshot(),
            );
        wire.server("@time=2026-11-03T12:34:56.790Z;msgid=local-push :alice!u@host PRIVMSG #room :local carry")
            .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        let conversation = NameKey::Channel(known_channel(&client, "#room"));
        let flush = {
            let mut state_guard = lock(&state);
            let running = state_guard
                .network
                .as_mut()
                .expect("network remains active");
            let (_, advance) = running.model.apply_server_read_marker_with_advance(
                &conversation,
                Some(UNIX_EPOCH + Duration::from_millis(1_793_709_296_789)),
            );
            _ = record_read_advances(running, advance);
            start_read_flush(running)
        };

        assert!(flush.is_none());
        assert!(
            tokio::time::timeout(Duration::ZERO, wire.next_sent())
                .await
                .is_err()
        );
    }

    #[test]
    fn read_retry_backoff_doubles_caps_and_resets_after_success() {
        assert_eq!(read_retry_delay(1), Duration::from_secs(1));
        assert_eq!(read_retry_delay(2), Duration::from_secs(2));
        assert_eq!(read_retry_delay(6), Duration::from_secs(32));
        assert_eq!(read_retry_delay(7), READ_RETRY_MAX);
        assert_eq!(read_retry_delay(u8::MAX), READ_RETRY_MAX);

        let error = papo::Error::Server(papo::ServerError::standard(
            "MARKREAD",
            "INTERNAL_ERROR",
            "try again",
        ));
        let mut retry = ReadRetryState::default();
        let first = retry.failed(&error);
        assert_eq!(first.retry_after, Some(READ_RETRY_INITIAL));
        assert!(first.diagnostic);
        let second = retry.failed(&error);
        assert_eq!(second.retry_after, Some(Duration::from_secs(2)));
        assert!(!second.diagnostic);
        let distinct = retry.failed(&papo::Error::Timeout);
        assert_eq!(distinct.retry_after, Some(Duration::from_secs(4)));
        assert!(distinct.diagnostic);

        retry.succeeded();
        let after_success = retry.failed(&error);
        assert_eq!(after_success.retry_after, Some(READ_RETRY_INITIAL));
        assert!(after_success.diagnostic);
        for _ in 1..super::READ_RETRY_ATTEMPTS {
            _ = retry.failed(&error);
        }
        assert!(retry.failed(&error).retry_after.is_none());
    }

    #[test]
    fn permanent_mark_read_errors_are_classified() {
        let cases = [
            (
                "invalid parameters",
                papo::Error::Server(papo::ServerError::standard(
                    "MARKREAD",
                    "INVALID_PARAMS",
                    "bad marker",
                )),
                true,
            ),
            (
                "other refusal",
                papo::Error::Server(papo::ServerError::standard(
                    "MARKREAD",
                    "FORBIDDEN",
                    "not allowed",
                )),
                true,
            ),
            ("target gone", papo::Error::TargetGone, true),
            (
                "invalid input",
                papo::Error::InvalidInput(papo::InvalidInput::EmptyText),
                true,
            ),
            (
                "server internal error",
                papo_testing::ErrorBuilder::standard(
                    "MARKREAD",
                    "INTERNAL_ERROR",
                    Vec::new(),
                    "try again",
                )
                .build(),
                false,
            ),
            ("timeout", papo::Error::Timeout, false),
        ];

        for (name, error, expected) in cases {
            assert_eq!(permanent_mark_read_error(&error), expected, "{name}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn permanent_mark_read_failure_is_diagnostic_without_retry_or_notice() {
        let mut harness = mark_read_wire_harness().await;
        let request = harness.wire.next_sent().await;
        fail_mark_read(&mut harness.wire, &request, "INVALID_PARAMS").await;

        let emitted = harness.receiver.recv().await.expect("failure diagnostic");
        assert!(matches!(
            &emitted,
            EngineToUi::Diagnostic { message, .. }
                if message == EngineMessageKey::MarkReadFailed.as_str()
        ));
        assert!(!matches!(emitted, EngineToUi::Notice { .. }));
        tokio::time::advance(READ_RETRY_MAX).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, harness.wire.next_sent())
                .await
                .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn transient_mark_read_failure_retries_five_times_with_one_diagnostic() {
        let mut harness = mark_read_wire_harness().await;
        let request = harness.wire.next_sent().await;
        fail_mark_read(&mut harness.wire, &request, "INTERNAL_ERROR").await;
        let first = harness.receiver.recv().await.expect("failure diagnostic");
        assert!(matches!(
            first,
            EngineToUi::Diagnostic { message, .. }
                if message == EngineMessageKey::MarkReadFailed.as_str()
        ));

        for delay_seconds in [1, 2, 4, 8] {
            tokio::time::advance(Duration::from_secs(delay_seconds)).await;
            let retry = harness.wire.next_sent().await;
            assert!(retry.ends_with("MARKREAD #room timestamp=2026-10-27T12:00:00.000Z"));
            fail_mark_read(&mut harness.wire, &retry, "INTERNAL_ERROR").await;
            tokio::task::yield_now().await;
        }

        assert!(collect(&mut harness.receiver).iter().all(|event| !matches!(
            event,
            EngineToUi::Diagnostic { message, .. }
                if message == EngineMessageKey::MarkReadFailed.as_str()
        )));
        tokio::time::advance(READ_RETRY_MAX).await;
        assert!(
            tokio::time::timeout(Duration::ZERO, harness.wire.next_sent())
                .await
                .is_err()
        );
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
            papo::Event::ReadMarkerChanged(marker) => {
                NameKey::from_conversation(&marker.conversation).expect("a channel marker")
            }
            _ => unreachable!("matching event is a read marker"),
        };
        process_event(&state, &outbound, &client, 1, newer);
        assert!(collect(&mut receiver).iter().any(
            |event| matches!(event, EngineToUi::BufferUpdated { buffer } if buffer.unread == 0)
        ));

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
    async fn join_applies_a_marker_pushed_before_the_channel_buffer_exists() {
        let caps = ["draft/read-marker", "message-tags", "server-time"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());

        wire.server(":offline.test MARKREAD #room timestamp=2026-10-27T12:00:00.000Z")
            .await;
        let marker = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ReadMarkerChanged(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, marker);
        _ = collect(&mut receiver);

        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        process_event(&state, &outbound, &client, 1, joined);

        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BufferUpdated { buffer } if buffer.id == BufferId(2)
        )));
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
    async fn connected_projects_the_advertised_filehost_origin() {
        for (isupport, expected) in [
            (
                " draft/FILEHOST=https://Files.Example.test:8443/upload",
                Some("https://files.example.test:8443"),
            ),
            (
                " soju.im/FILEHOST=https://files.example.test/upload",
                Some("https://files.example.test"),
            ),
            ("", None),
        ] {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            register_connection(&mut wire, &[], isupport, false).await;
            let connected = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            let (state, outbound, mut receiver) = harness(client.clone());
            process_event(&state, &outbound, &client, 1, connected);

            assert!(
                collect(&mut receiver).iter().any(|event| matches!(
                    event,
                    EngineToUi::NetworkStateChanged { network }
                        if network.state == crate::NetworkConnectionState::Online
                            && network.filehost_origin.as_deref() == expected
                )),
                "{isupport:?} should project {expected:?}"
            );
        }
    }

    #[tokio::test]
    async fn connected_projects_the_logged_in_account() {
        for (logged_in, expected) in [(true, Some("account")), (false, None)] {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            register_connection(&mut wire, &[], "", logged_in).await;
            let connected = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            let (state, outbound, mut receiver) = harness(client.clone());
            process_event(&state, &outbound, &client, 1, connected);

            assert!(
                collect(&mut receiver).iter().any(|event| matches!(
                    event,
                    EngineToUi::NetworkStateChanged { network }
                        if network.state == crate::NetworkConnectionState::Online
                            && network.account.as_deref() == expected
                )),
                "logged in {logged_in} should project {expected:?}"
            );
        }
    }

    #[tokio::test]
    async fn resolve_upload_answers_the_advertised_endpoint_with_basic() {
        for (isupport, expected) in [
            (
                " draft/FILEHOST=https://files.example.org/upload",
                crate::UploadResolution::Ready {
                    endpoint: "https://files.example.org/upload".into(),
                    authorization: crate::UploadAuthorization::Basic {
                        header: "Basic d2VibG91bmdlOndlYmxvdW5nZS10ZXN0".into(),
                    },
                },
            ),
            (
                " soju.im/FILEHOST=https://files.elsewhere.test/upload",
                crate::UploadResolution::ApprovalRequired {
                    host: "files.elsewhere.test".into(),
                },
            ),
            ("", crate::UploadResolution::Unavailable),
        ] {
            let (client, mut events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge"));
            register_connection(&mut wire, &[], isupport, false).await;
            let connected = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            let (state, outbound, mut receiver) = harness(client.clone());
            let runtime = Runtime { state, outbound };
            process_runtime_event(&runtime, connected);
            collect(&mut receiver);

            assert!(
                runtime
                    .request(EngineRequestEnvelope {
                        id: "upload".into(),
                        request: EngineRequest::ResolveUpload {
                            network_id: NetworkId(1),
                            approval: None,
                        },
                    })
                    .is_empty()
            );
            let resolved = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
                .await
                .expect("resolution completes")
                .expect("runtime event");
            assert_eq!(
                resolved,
                EngineToUi::UploadResolved {
                    command_id: "upload".into(),
                    resolution: expected,
                },
                "{isupport:?}"
            );
        }
    }

    #[tokio::test]
    async fn resolve_upload_refuses_before_the_network_is_online() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "upload".into(),
                    request: EngineRequest::ResolveUpload {
                        network_id: NetworkId(1),
                        approval: None,
                    },
                })
                .is_empty()
        );
        let resolved = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("resolution completes")
            .expect("runtime event");
        assert_eq!(
            resolved,
            EngineToUi::UploadResolved {
                command_id: "upload".into(),
                resolution: crate::UploadResolution::Offline,
            }
        );
    }

    #[tokio::test]
    async fn forget_upload_approvals_completes_the_request() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: "forget".into(),
                    request: EngineRequest::ForgetUploadApprovals,
                })
                .is_empty()
        );
        let result = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("forget completes")
            .expect("runtime event");
        assert_eq!(
            result,
            EngineToUi::CommandResult {
                id: "forget".into()
            }
        );
    }

    #[test]
    fn plain_connections_keep_their_endpoint_and_credential_for_uploads() {
        let config = super::ConnectConfig {
            label: "Example".into(),
            endpoint: "wss://irc.example.org/socket".into(),
            nickname: "luiz".into(),
            authentication: ConnectionAuthentication::SaslPlain {
                account: "luiz".into(),
                password: papo::Secret::new("hunter2"),
            },
            autojoin: Vec::new(),
            allow_insecure: false,
        };
        let identity = config.identity();
        assert_eq!(identity.endpoint, "wss://irc.example.org/socket");
        assert!(matches!(
            identity.credential,
            super::UploadCredential::Basic { ref account, ref password }
                if account == "luiz" && password.expose() == "hunter2"
        ));
        assert_eq!(identity.kind(), AuthenticationKind::SaslPlain);
        assert_eq!(
            ConnectionIdentity::hosted("wss://beta.example.org/socket".into()).kind(),
            AuthenticationKind::HostedOAuth
        );
    }

    #[tokio::test]
    async fn resolve_upload_rejects_an_unknown_network() {
        let (client, _events, _wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        let (state, outbound, _receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        assert_eq!(
            runtime.request(EngineRequestEnvelope {
                id: "upload".into(),
                request: EngineRequest::ResolveUpload {
                    network_id: NetworkId(9),
                    approval: None,
                },
            }),
            super::rejected_command("upload".into(), EngineMessageKey::NetworkNotFound)
        );
    }

    #[tokio::test]
    async fn push_registration_uses_ergo_replies_and_typed_outcomes() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::PushRouteRequired {
                vapid,
                previous_route_id: None,
                ..
            } if vapid == "home-vapid"
        )));
        let attached = {
            let mut state = lock(&runtime.state);
            attach_shell(state.network.as_mut().expect("network"), "attach".into())
        };
        assert!(
            !attached
                .iter()
                .any(|event| matches!(event, EngineToUi::PushRouteRequired { .. }))
        );

        assert_no_output(&runtime.request(push_request("register", "route-1")));
        let request = wire.next_sent().await;
        assert_eq!(
            request_without_label(&request),
            "WEBPUSH REGISTER https://push.example.test/v1/r/route-1 p256dh=AQIDBAUGBwgJCgsMDQ4P_w;auth=-vv8_f7_"
        );
        send_push_success(&mut wire, &request, false).await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::Registered { route_id },
                        ..
                    } if route_id == "route-1"
                ))
        );

        let mut persistence = push_request("persistence", "route-2");
        let EngineRequest::EnsurePush { unregister, .. } = &mut persistence.request else {
            unreachable!("push helper creates ensure request");
        };
        unregister.push("https://push.example.test/v1/r/route-1".into());
        assert_no_output(&runtime.request(persistence));
        let unregister = wire.next_sent().await;
        assert_eq!(
            request_without_label(&unregister),
            "WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        );
        let label = request_label(&unregister);
        wire.server(format!(
            "@label={label} :offline.test WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        ))
        .await;
        let request = wire.next_sent().await;
        send_push_success(&mut wire, &request, true).await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::RegisteredButNoDelivery { route_id },
                        ..
                    } if route_id == "route-2"
                ))
        );
        assert!(
            lock(&runtime.state)
                .network
                .as_ref()
                .and_then(|running| running.push.route.as_ref())
                .is_some_and(|route| route.route_id == "route-2")
        );
    }

    fn announce_request(network_id: u64) -> EngineRequestEnvelope {
        EngineRequestEnvelope {
            id: "announce".into(),
            request: EngineRequest::AnnouncePushRoute {
                network_id: NetworkId(network_id),
            },
        }
    }

    #[tokio::test]
    async fn announcing_a_push_route_repeats_the_requirement_for_a_new_owner() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        _ = collect(&mut receiver);
        assert_no_output(&runtime.request(push_request("register", "route-1")));
        let request = wire.next_sent().await;
        send_push_success(&mut wire, &request, false).await;
        _ = command_output(&mut receiver).await;

        assert_eq!(
            runtime.request(announce_request(1)),
            vec![
                EngineToUi::PushRouteRequired {
                    network_id: NetworkId(1),
                    vapid: "home-vapid".into(),
                    previous_route_id: Some("route-1".into()),
                },
                EngineToUi::CommandResult {
                    id: "announce".into()
                },
            ]
        );
        assert!(matches!(
            lock(&runtime.state)
                .network
                .as_ref()
                .and_then(|running| running.push.state.clone()),
            Some(PushState::Registered { route_id }) if route_id == "route-1"
        ));
        assert_eq!(
            runtime.request(announce_request(9)),
            super::rejected_command("announce".into(), EngineMessageKey::NetworkNotFound)
        );
    }

    #[tokio::test]
    async fn announcing_a_push_route_reports_why_a_home_cannot_register() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, None, true).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        _ = collect(&mut receiver);

        assert_eq!(
            runtime.request(announce_request(1)),
            vec![
                EngineToUi::PushStateChanged {
                    network_id: NetworkId(1),
                    state: PushState::Unsupported {
                        reason: crate::PushUnsupportedReason::NoVapid,
                    },
                },
                EngineToUi::CommandResult {
                    id: "announce".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn announcing_a_push_route_waits_for_the_connection() {
        let (client, _events, _wire) = push_wire();
        let (state, outbound, _receiver) = harness(client);
        let runtime = Runtime { state, outbound };

        assert_eq!(
            runtime.request(announce_request(1)),
            vec![EngineToUi::CommandResult {
                id: "announce".into()
            }]
        );
    }

    #[tokio::test]
    async fn exact_push_unregistration_preserves_the_current_route() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        _ = collect(&mut receiver);

        assert_no_output(&runtime.request(push_request("register", "route-current")));
        let register = wire.next_sent().await;
        send_push_success(&mut wire, &register, false).await;
        _ = command_output(&mut receiver).await;

        assert_no_output(&runtime.request(EngineRequestEnvelope {
            id: "unregister-stale".into(),
            request: EngineRequest::UnregisterPushRoute {
                network_id: NetworkId(1),
                route_id: "route-stale".into(),
                endpoint: "https://push.example.test/v1/r/route-stale".into(),
            },
        }));
        let unregister = wire.next_sent().await;
        assert_eq!(
            request_without_label(&unregister),
            "WEBPUSH UNREGISTER https://push.example.test/v1/r/route-stale"
        );
        let label = request_label(&unregister);
        wire.server(format!(
            "@label={label} :offline.test WEBPUSH UNREGISTER https://push.example.test/v1/r/route-stale"
        ))
        .await;

        assert!(matches!(
            command_output(&mut receiver).await.as_slice(),
            [EngineToUi::CommandResult { id }] if id == "unregister-stale"
        ));
        assert!(
            lock(&runtime.state)
                .network
                .as_ref()
                .and_then(|running| running.push.route.as_ref())
                .is_some_and(|route| route.route_id == "route-current")
        );
    }

    #[test]
    fn active_push_registration_refresh_interval_is_daily() {
        assert_eq!(PUSH_REFRESH_INTERVAL, Duration::from_hours(24));
    }

    #[tokio::test]
    async fn push_registration_maps_ergo_refusals_to_typed_failures() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };

        assert_no_output(&runtime.request(push_request("limit", "route-1")));
        let request = wire.next_sent().await;
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test FAIL WEBPUSH MAX_REGISTRATIONS :Too many registrations"
        ))
        .await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::Failed {
                            route_id,
                            reason: crate::PushFailure::RegistrationLimit,
                        },
                        ..
                    } if route_id == "route-1"
                ))
        );

        assert_no_output(&runtime.request(push_request("forbidden", "route-2")));
        let request = wire.next_sent().await;
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test FAIL WEBPUSH FORBIDDEN :Web Push is forbidden"
        ))
        .await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::Failed {
                            route_id,
                            reason: crate::PushFailure::WebPushForbidden,
                        },
                        ..
                    } if route_id == "route-2"
                ))
        );

        assert_no_output(&runtime.request(push_request("probe-failed", "route-3")));
        let request = wire.next_sent().await;
        let label = request_label(&request);
        wire.server(format!(
            "@label={label} :offline.test FAIL WEBPUSH INVALID_PARAMS REGISTER https://push.example.test/v1/r/route-3 :Test push message failed to send"
        ))
        .await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::Failed {
                            route_id,
                            reason: crate::PushFailure::InvalidParameters,
                        },
                        ..
                    } if route_id == "route-3"
                ))
        );
    }

    #[tokio::test]
    async fn superseded_push_registration_still_reports_its_route_scoped_result() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };

        assert_no_output(&runtime.request(push_request("first", "route-1")));
        let first = wire.next_sent().await;
        assert_no_output(&runtime.request(push_request("second", "route-2")));
        let second = wire.next_sent().await;
        send_push_success(&mut wire, &second, false).await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: PushState::Registered { route_id },
                        ..
                    } if route_id == "route-2"
                ))
        );

        let label = request_label(&first);
        wire.server(format!(
            "@label={label} :offline.test FAIL WEBPUSH INVALID_PARAMS REGISTER https://push.example.test/v1/r/route-1 :Test push message failed to send"
        ))
        .await;
        assert!(
            command_output(&mut receiver)
                .await
                .iter()
                .any(|event| matches!(
                    event,
                    EngineToUi::PushStateChanged {
                        state: PushState::Failed { route_id, .. },
                        ..
                    } if route_id == "route-1"
                ))
        );
        assert!(
            lock(&runtime.state)
                .network
                .as_ref()
                .and_then(|running| running.push.route.as_ref())
                .is_some_and(|route| route.route_id == "route-2")
        );
    }

    #[tokio::test]
    async fn push_registration_reports_each_missing_prerequisite_without_a_route() {
        for (caps, vapid, account, expected) in [
            (
                &[][..],
                None,
                false,
                crate::PushUnsupportedReason::NoWebPush,
            ),
            (
                &["batch", "draft/webpush", "labeled-response"][..],
                Some("home-vapid"),
                false,
                crate::PushUnsupportedReason::NoAccount,
            ),
            (
                &["batch", "draft/webpush", "labeled-response"][..],
                None,
                true,
                crate::PushUnsupportedReason::NoVapid,
            ),
        ] {
            let builder = papo::Client::builder("irc://offline.test", "weblounge")
                .enable(papo::Feature::WebPush);
            let (client, mut events, mut wire) = wire(builder);
            register_connection(&mut wire, caps, &vapid_token(vapid), account).await;
            _ = next_matching(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            let (state, outbound, _receiver) = harness(client);
            let runtime = Runtime { state, outbound };

            assert!(matches!(
                runtime.request(push_request("unsupported", "unused"))
                    .as_slice(),
                [
                    EngineToUi::PushStateChanged {
                        state: crate::PushState::Unsupported { reason },
                        ..
                    },
                    EngineToUi::CommandResult { .. }
                ] if *reason == expected
            ));
            assert!(
                lock(&runtime.state)
                    .network
                    .as_ref()
                    .is_some_and(|running| running.push.route.is_none())
            );
        }
    }

    #[tokio::test]
    async fn late_account_confirmation_rechecks_push_registration() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), false).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::PushStateChanged {
                state: PushState::Unsupported {
                    reason: crate::PushUnsupportedReason::NoAccount,
                },
                ..
            }
        )));

        wire.server(":weblounge!u@host ACCOUNT account").await;
        let account_changed = next_matching(&mut events, |event| {
            matches!(event, papo::Event::AccountChanged(changed) if changed.actor_party == papo::Party::Me)
        })
        .await;
        process_runtime_event(&runtime, account_changed);

        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::PushRouteRequired { vapid, .. } if vapid == "home-vapid"
        )));
    }

    #[tokio::test]
    async fn every_connect_requests_one_page_owned_push_ensure() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let runtime = Runtime { state, outbound };
        process_runtime_event(&runtime, connected);
        _ = collect(&mut receiver);
        assert_no_output(&runtime.request(push_request("register", "route-1")));
        let request = wire.next_sent().await;
        send_push_success(&mut wire, &request, false).await;
        _ = command_output(&mut receiver).await;

        wire.close().await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        client.reconnect().await.expect("manual reconnect starts");
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        let reconnected = next_matching(
            &mut events,
            |event| matches!(event, papo::Event::Connected(connected) if connected.reconnected),
        )
        .await;
        process_runtime_event(&runtime, reconnected);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::PushRouteRequired {
                vapid,
                previous_route_id,
                ..
            } if vapid == "home-vapid" && previous_route_id.as_deref() == Some("route-1")
        )));
        assert_no_output(&runtime.request(push_request("refresh", "route-1")));
        let refresh = wire.next_sent().await;
        send_push_success(&mut wire, &refresh, false).await;
        loop {
            let event = receiver.recv().await.expect("push refresh completes");
            if matches!(
                event,
                EngineToUi::PushStateChanged {
                    state: crate::PushState::Registered { .. },
                    ..
                }
            ) {
                break;
            }
        }

        wire.close().await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        client.reconnect().await.expect("manual reconnect starts");
        register_push_connection(&mut wire, Some("new-home-vapid"), true).await;
        let reconnected = next_matching(
            &mut events,
            |event| matches!(event, papo::Event::Connected(connected) if connected.reconnected),
        )
        .await;
        process_runtime_event(&runtime, reconnected);

        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::PushRouteRequired {
                vapid,
                previous_route_id,
                ..
            } if vapid == "new-home-vapid" && previous_route_id.as_deref() == Some("route-1")
        )));
        assert!(
            lock(&runtime.state)
                .network
                .as_ref()
                .is_some_and(|running| {
                    running
                        .push
                        .route
                        .as_ref()
                        .is_some_and(|route| route.route_id == "route-1")
                })
        );
    }

    #[tokio::test]
    async fn hosted_sign_out_unregisters_push_before_quitting() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        lock(&runtime.state)
            .network
            .as_mut()
            .expect("network remains running")
            .identity = ConnectionIdentity::hosted(String::new());
        assert_no_output(&runtime.request(push_request("register", "route-1")));
        let register = wire.next_sent().await;
        send_push_success(&mut wire, &register, false).await;
        _ = command_output(&mut receiver).await;

        let output = runtime.request(EngineRequestEnvelope {
            id: "sign-out".into(),
            request: EngineRequest::ExpireHostedAuthentication {
                network_id: NetworkId(1),
            },
        });
        assert!(matches!(
            output.last(),
            Some(EngineToUi::CommandResult { id }) if id == "sign-out"
        ));
        let unregister = wire.next_sent().await;
        assert_eq!(
            request_without_label(&unregister),
            "WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        );
        let label = request_label(&unregister);
        wire.server(format!(
            "@label={label} :offline.test WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        ))
        .await;
        assert_eq!(wire.next_sent().await, "QUIT");
    }

    #[tokio::test]
    async fn network_removal_unregisters_push_before_quitting() {
        let (client, mut events, mut wire) = push_wire();
        register_push_connection(&mut wire, Some("home-vapid"), true).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client);
        let runtime = Runtime { state, outbound };
        assert_no_output(&runtime.request(push_request("register", "route-1")));
        let register = wire.next_sent().await;
        send_push_success(&mut wire, &register, false).await;
        _ = command_output(&mut receiver).await;

        let output = runtime.request(EngineRequestEnvelope {
            id: "remove".into(),
            request: EngineRequest::Disconnect {
                network_id: NetworkId(1),
                reason: None,
            },
        });
        assert!(matches!(
            output.last(),
            Some(EngineToUi::CommandResult { id }) if id == "remove"
        ));
        let unregister = wire.next_sent().await;
        assert_eq!(
            request_without_label(&unregister),
            "WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        );
        let label = request_label(&unregister);
        wire.server(format!(
            "@label={label} :offline.test WEBPUSH UNREGISTER https://push.example.test/v1/r/route-1"
        ))
        .await;
        assert_eq!(wire.next_sent().await, "QUIT");
    }

    #[tokio::test]
    async fn offline_messages_flush_in_submission_order_after_connected() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, joined);
        let buffer_id = collect(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::BufferAdded { buffer } => Some(buffer.id),
                _ => None,
            })
            .expect("join adds the room buffer");
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound: outbound.clone(),
        };

        for (id, text) in [("first", "queued one"), ("second", "queued two")] {
            let output = runtime.request(EngineRequestEnvelope {
                id: id.into(),
                request: EngineRequest::SendMessage {
                    buffer_id,
                    text: text.into(),
                },
            });
            assert!(
                changed_messages(&output)
                    .iter()
                    .any(|(_, message)| { message.delivery == crate::MessageDelivery::Optimistic })
            );
            assert!(output.iter().any(|event| matches!(
                event,
                EngineToUi::CommandResult { id: result_id } if result_id == id
            )));
        }

        process_event(&state, &outbound, &client, 1, connected);
        assert_eq!(wire.next_sent().await, "PRIVMSG #room :queued one");
        assert_eq!(wire.next_sent().await, "PRIVMSG #room :queued two");
    }

    #[tokio::test]
    async fn confirmed_own_send_persists_when_the_read_mark_is_already_ahead() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, connected);
        process_event(&state, &outbound, &client, 1, joined);
        let channel = known_channel(&client, "#room");
        let buffer_id = {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            let buffer_id = running
                .model
                .buffer_id_for_target(&SendTarget::Channel(channel.clone()))
                .expect("join projects the room");
            running
                .model
                .finish_history(&NameKey::Channel(channel), None, None, None, 0, true);
            running.model.advance_read(
                buffer_id,
                papo::time::now() + Duration::from_secs(60),
                false,
            );
            running.chat_list.fingerprint = "network".into();
            buffer_id
        };
        update_chat_list(&state, &outbound, 1);
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        runtime.request(EngineRequestEnvelope {
            id: "send".into(),
            request: EngineRequest::SendMessage {
                buffer_id,
                text: "own snapshot edge".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "PRIVMSG #room :own snapshot edge");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let event = receiver.recv().await.expect("runtime event");
                if event_timeline_messages(&event).iter().any(|message| {
                    message.delivery == MessageDelivery::Confirmed
                        && message.text == "own snapshot edge"
                }) {
                    break;
                }
            }
        })
        .await
        .expect("send confirms");

        let storage = lock(&state).storage.clone();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let snapshot = read(storage.as_ref())
                    .await
                    .expect("read snapshot")
                    .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"));
                if snapshot.and_then(|snapshot| snapshot.rows[0].preview.clone())
                    == Some("weblounge: own snapshot edge".into())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("confirmed own preview persists");
    }

    #[tokio::test]
    async fn confirmed_own_send_replaces_a_loading_cached_direct_row() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        for line in [
            ":weblounge!u@host JOIN #room account :WebLounge",
            ":alice!a@host JOIN #room alice :Alice",
        ] {
            wire.server(line).await;
            _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        }
        let direct = DirectPeer::resolve(&client, &known_nick(&client, "alice"));
        let cached = ChatListSnapshot::new(
            "network".into(),
            vec![SnapshotRow {
                conversation: SnapshotConversation::Direct {
                    key: "alice".into(),
                },
                title: "alice".into(),
                last_activity_ms: Some(100),
                stubs: Vec::new(),
                redacted_stubs: Vec::new(),
                gap_until: None,
                preview: Some("stale cached".into()),
                newest: None,
                read_at_ms: None,
                raw_read_at_ms: None,
                pending_read_at_ms: None,
                peer_pin: None,
                peer_bot: false,
            }],
        );
        let (state, outbound, _receiver) = harness(client.clone());
        restore_and_store_snapshot(&state, &cached).await;
        let buffer_id = {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running
                .model
                .set_connection(NetworkConnectionState::Online, None);
            running.chat_list.fingerprint = "network".into();
            let buffer_id = match running.model.buffers_event() {
                EngineToUi::BuffersChanged { buffers, .. } => buffers[1].id,
                _ => unreachable!("buffer list event"),
            };
            let snapshot = client.snapshot();
            running
                .model
                .resolve_direct(buffer_id, DirectAvailability::Guarded(direct), &snapshot);
            assert!(
                running
                    .model
                    .request_history(buffer_id, crate::HistoryDirection::Latest)
                    .is_some()
            );
            buffer_id
        };
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        runtime.request(EngineRequestEnvelope {
            id: "send".into(),
            request: EngineRequest::SendMessage {
                buffer_id,
                text: "new own direct".into(),
            },
        });
        assert_eq!(wire.next_sent().await, "PRIVMSG alice :new own direct");

        let storage = lock(&state).storage.clone();
        let persisted = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(snapshot) = read(storage.as_ref())
                    .await
                    .expect("read snapshot")
                    .and_then(|bytes| ChatListSnapshot::decode(&bytes, "network"))
                    .filter(|snapshot| {
                        snapshot.rows[0].preview.as_deref() == Some("You: new own direct")
                    })
                {
                    break snapshot;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("confirmed own direct persists");
        assert!(persisted.rows[0].last_activity_ms > Some(100));
    }

    #[tokio::test]
    async fn cached_target_failure_emits_legacy_event_and_patch_in_one_flush() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        restore_cached_room(&state);
        let channel =
            papo_testing::channel(crate::name_key::casemapping(&client.snapshot()), "#room");
        {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            let buffer_id = running
                .model
                .buffer_id_for_target(&SendTarget::Channel(channel))
                .expect("cached channel exists");
            let (pending, _) = running
                .model
                .begin_send(buffer_id, "cannot deliver".into(), &client.snapshot())
                .expect("cached channel accepts an optimistic send");
            _ = running.model.take_timeline_changes(false);
            _ = running.model.mark_vanished_restored_rows();
            running.pending_sends.push_back(QueuedSend {
                pending,
                retry_if_disconnected: true,
                await_live_target: true,
            });
            running.flushing_sends = true;
        }

        flush_pending_sends(&state, &outbound, &client, 1).await;

        let output = collect(&mut receiver);
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::MessageFailed {
                message_key: EngineMessageKey::CachedTargetGone,
                ..
            }
        )));
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::TimelineChanged { upserted, .. }
                if matches!(
                    upserted.as_slice(),
                    [item] if matches!(
                        &item.body,
                        crate::timeline::ItemBody::Message(message)
                            if message.delivery == MessageDelivery::Failed
                    )
                )
        )));
    }

    #[tokio::test]
    async fn command_mutation_drains_patch_before_releasing_model_lock() {
        let (client, _events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        let (state, outbound, _receiver) = harness(client.clone());
        restore_cached_room(&state);
        set_harness_device_online(&state, false);
        let channel =
            papo_testing::channel(crate::name_key::casemapping(&client.snapshot()), "#room");
        let buffer_id = lock(&state)
            .network
            .as_ref()
            .expect("network remains active")
            .model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("cached channel exists");
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        let output = runtime.send_input(
            "send".into(),
            buffer_id,
            "queued offline".into(),
            &crate::MessageKind::Text,
        );

        assert!(
            changed_messages(&output)
                .iter()
                .any(|(_, message)| message.delivery == MessageDelivery::Optimistic)
        );
        assert!(
            output
                .iter()
                .any(|event| matches!(event, EngineToUi::TimelineChanged { .. }))
        );
        let mut state = lock(&state);
        let remaining = state
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .take_timeline_changes(false);
        assert!(remaining.is_empty());
    }

    #[tokio::test]
    async fn hosted_replacement_fails_an_inflight_send_before_requesting_a_token() {
        let caps = ["echo-message", "labeled-response", "message-tags"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, connected);
        process_event(&state, &outbound, &client, 1, joined);
        let buffer_id = collect(&mut receiver)
            .into_iter()
            .find_map(|event| match event {
                EngineToUi::BufferAdded { buffer } => Some(buffer.id),
                _ => None,
            })
            .expect("join adds the room buffer");
        {
            let mut state = lock(&state);
            let running = state.network.as_mut().expect("network remains active");
            running.identity = ConnectionIdentity::hosted(String::new());
            running.hosted_reconnect = Some(HostedReconnectConfig {
                endpoint: "wss://beta.weblounge.org/socket".into(),
                nickname: "weblounge".into(),
                autojoin: vec!["#room".into()],
            });
        }
        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };

        runtime.request(EngineRequestEnvelope {
            id: "send".into(),
            request: EngineRequest::SendMessage {
                buffer_id,
                text: "stuck before foreground".into(),
            },
        });
        assert_eq!(
            next_sent_containing(&mut wire, "PRIVMSG #room").await,
            "@label=0 PRIVMSG #room :stuck before foreground"
        );
        lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .set_connection(
                NetworkConnectionState::Failed {
                    reason: ConnectionFailureReason::Transport,
                    message_key: EngineMessageKey::ConnectionFailed,
                },
                None,
            );

        let reconnecting = runtime.request(EngineRequestEnvelope {
            id: "foreground".into(),
            request: EngineRequest::Reconnect {
                network_id: NetworkId(1),
            },
        });
        assert!(matches!(
            reconnecting.as_slice(),
            [EngineToUi::NetworkStateChanged { .. }]
        ));
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !output.iter().any(
                |event| matches!(event, EngineToUi::CommandResult { id } if id == "foreground"),
            ) {
                output.push(receiver.recv().await.expect("runtime remains active"));
            }
        })
        .await
        .expect("hosted replacement settles");

        let failed = output
            .iter()
            .position(|event| matches!(event, EngineToUi::MessageFailed { .. }))
            .expect("the interrupted send becomes retryable");
        let token = output
            .iter()
            .position(|event| {
                matches!(
                    event,
                    EngineToUi::HostedTokenRequired {
                        network_id: NetworkId(1)
                    }
                )
            })
            .expect("hosted replacement requests a fresh token");
        assert!(
            failed < token,
            "the old send must settle before client replacement"
        );
    }

    #[tokio::test]
    async fn direct_send_during_reconnect_waits_for_a_fresh_handle() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["extended-join"]).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room account :WebLounge")
            .await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room alice :Alice").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let direct = DirectPeer::resolve(&client, &known_nick(&client, "alice"));

        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, connected);
        let buffer_id = {
            let mut state = lock(&state);
            state
                .network
                .as_mut()
                .expect("network remains active")
                .model
                .open_direct(
                    direct.nick().clone(),
                    DirectAvailability::Guarded(direct),
                    &client.snapshot(),
                )
                .0
        };
        _ = collect(&mut receiver);

        wire.close().await;
        let disconnected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, disconnected);
        client.reconnect().await.expect("manual reconnect starts");

        let runtime = Runtime {
            state: Arc::clone(&state),
            outbound,
        };
        let output = runtime.request(EngineRequestEnvelope {
            id: "reconnecting-direct".into(),
            request: EngineRequest::SendMessage {
                buffer_id,
                text: "do not leave this pending".into(),
            },
        });
        assert!(
            changed_messages(&output)
                .iter()
                .any(|(_, message)| { message.delivery == crate::MessageDelivery::Optimistic })
        );
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::CommandResult { id } if id == "reconnecting-direct"
        )));
        let state = lock(&state);
        let running = state.network.as_ref().expect("network remains active");
        assert_eq!(running.pending_sends.len(), 1);
        assert!(running.pending_sends[0].await_live_target);
    }

    #[tokio::test]
    async fn offline_server_commands_are_rejected_with_a_specific_reason() {
        let (client, _events, _wire) = wire(papo::Client::builder(
            "irc://offline-commands.test",
            "weblounge",
        ));
        let (state, outbound, _receiver) = harness(client);
        let runtime = Runtime { state, outbound };

        assert_eq!(
            runtime.request(EngineRequestEnvelope {
                id: "join".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: BufferId(1),
                    input: "/join #room".into(),
                    reply_to: None,
                },
            }),
            [EngineToUi::CommandRejected {
                id: "join".into(),
                message_key: EngineMessageKey::Offline,
                values: None,
            }]
        );
    }

    #[tokio::test]
    async fn casemapping_and_channel_renames_rebuild_keys_while_nicks_start_threads() {
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
        assert!(!collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BuffersChanged { buffers, .. }
                if buffers.iter().any(|buffer| buffer.id == direct_id && buffer.title == "alicia")
        )));
        wire.server(":alicia!a@host PRIVMSG weblounge :new nick, new thread")
            .await;
        let message = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await;
        process_event(&state, &outbound, &client, 1, message);
        assert!(collect(&mut receiver).iter().any(|event| matches!(
            event,
            EngineToUi::BufferAdded { buffer }
                if buffer.id != direct_id && buffer.title == "alicia"
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
        let snapshot = client.snapshot();
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

        assert!(
            matches!(targets.as_slice(), [HistoryFetch::Latest(HistoryTarget::Channel(channel))] if channel == "#room")
        );
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
            [EngineToUi::Notice { key, .. }]
                if key == EngineMessageKey::ChannelRecreated.as_str()
        ));
    }

    #[tokio::test]
    async fn engine_catchup_pages_and_deduplicates_live_overlap() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        register_for_history(&mut wire).await;
        let connected = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        process_event(&state, &outbound, &client, 1, connected);
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        wire.server(":weblounge!u@host JOIN #room").await;
        let joined =
            next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let latest = process_event(&state, &outbound, &client, 1, joined)
            .pop()
            .expect("joined channel requests latest history");
        let latest_client = client.clone();
        let latest_task = tokio::spawn(async move { fetch_history(&latest_client, latest).await });
        let latest_request = next_sent_containing(&mut wire, " CHATHISTORY LATEST #room ").await;
        send_history_page(&mut wire, request_label(&latest_request), &[]).await;
        let latest_page = latest_task
            .await
            .expect("latest task completes")
            .expect("latest history succeeds");
        process_history(&state, &outbound, &client, 1, latest_page);
        _ = collect(&mut receiver);

        wire.server(
            "@time=2026-10-15T12:00:00.000Z;msgid=live-1 :alice!a@host PRIVMSG #room :before disconnect",
        )
        .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
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
        assert!(process_event(&state, &outbound, &client, 1, connected).is_empty());
        let after = {
            let mut state = lock(&state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            let channel = retained_channel(model, "#room");
            model
                .restore_channel(&channel, UNIX_EPOCH + Duration::from_secs(2_000_000_000))
                .expect("TARGETS schedules channel catch-up")
        };
        _ = collect(&mut receiver);
        assert!(wire.next_sent().await.ends_with("JOIN #room"));
        let catchup_client = client.clone();
        let catchup_task = tokio::spawn(async move { fetch_history(&catchup_client, after).await });
        let request = next_sent_containing(&mut wire, " CHATHISTORY LATEST #room ").await;
        let label = request_label(&request);
        assert!(request.contains("CHATHISTORY LATEST #room msgid=live-1"));
        wire.server(
            "@time=2026-10-15T12:00:02.000Z;msgid=live-2 :alice!a@host PRIVMSG #room :newer live arrival",
        )
        .await;
        process_next_message(&mut events, &state, &outbound, &client).await;
        send_history_page(
            &mut wire,
            label,
            &[
                "time=2026-10-15T12:00:00.000Z;msgid=live-1 :alice!a@host PRIVMSG #room :before disconnect",
                "time=2026-10-15T12:00:01.000Z;msgid=missed-1 :alice!a@host PRIVMSG #room :missed while away",
            ],
        )
        .await;
        let page = catchup_task
            .await
            .expect("catch-up task completes")
            .expect("catch-up page succeeds");
        process_history(&state, &outbound, &client, 1, page);
        _ = collect(&mut receiver);
        let mut merged = channel_timeline_texts(&state, &client);
        merged.retain(|text| {
            matches!(
                text.as_str(),
                "before disconnect" | "missed while away" | "newer live arrival"
            )
        });

        assert_eq!(
            merged,
            [
                "before disconnect",
                "missed while away",
                "newer live arrival"
            ]
        );
    }

    #[tokio::test]
    async fn transcript_rows_omit_prefixes_while_members_preserve_them() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":offline.test 005 weblounge PREFIX=(qov)~@+ CHANMODES=b,k,l,imnst :supported")
            .await;
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":offline.test 353 weblounge = #room :weblounge alice")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        assert_eq!(wire.next_sent().await, "MODE #room");
        assert_eq!(wire.next_sent().await, "WHO #room");
        apply_test_mode(&mut wire, &mut events, "+q weblounge").await;
        apply_test_mode(&mut wire, &mut events, "+o alice").await;

        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let snapshot = client.snapshot();
        let channel = known_channel(&client, "#room");
        model.sync_channels(&snapshot);
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel.clone()))
            .expect("joined channel is projected");
        let EngineToUi::MembersChanged { members, .. } =
            crate::members::project(&snapshot, &channel, buffer_id, "test", 0, 0, "")
                .expect("member window")
        else {
            panic!("member window expected")
        };
        assert!(
            members
                .iter()
                .any(|member| { member.nick == "weblounge" && member.mode_symbol == Some('~') })
        );
        assert!(
            members
                .iter()
                .any(|member| member.nick == "alice" && member.mode_symbol == Some('@'))
        );

        let (pending, sent) = begin_send(
            &mut model,
            &client,
            &mut wire,
            buffer_id,
            "operator send",
            "PRIVMSG #room :operator send",
        )
        .await;
        let confirmed = model
            .confirm_send(&pending, &sent)
            .expect("optimistic row exists");
        assert!(!confirmed.is_empty());
        assert!(
            changed_messages(&model.take_timeline_changes(false))
                .iter()
                .any(|(_, message)| message.text == "operator send")
        );

        wire.server(":alice!a@host PRIVMSG #room :historical line")
            .await;
        let papo::Event::Message(history) = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await
        else {
            panic!("history message expected");
        };
        model.receive(&history, true, &client.snapshot(), None);
        let historical = model.take_timeline_changes(false);

        wire.server(":alice!a@host PRIVMSG #room :live line").await;
        let papo::Event::Message(live) = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await
        else {
            panic!("live message expected");
        };
        model.receive(&live, false, &client.snapshot(), None);
        let live = model.take_timeline_changes(false);
        for (events, text) in [(historical, "historical line"), (live, "live line")] {
            assert!(
                changed_messages(&events)
                    .first()
                    .is_some_and(|(_, message)| message.text == text)
            );
        }
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
        model.sync_channels(&client.snapshot());
        let channel = model
            .history_targets()
            .into_iter()
            .find_map(|target| match target {
                HistoryTarget::Channel(channel) if channel == "#room" => Some(channel),
                _ => None,
            })
            .expect("joined channel is projected");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("projected channel has a stable id");
        wire.server(":alice!a@host PRIVMSG #room :unread before own send")
            .await;
        let papo::Event::Message(peer) = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Message(_))
        })
        .await
        else {
            panic!("peer message expected");
        };
        model.receive(&peer, false, &client.snapshot(), None);
        let (pending, _) = model
            .begin_action(buffer_id, "waves".into(), &client.snapshot())
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
        let confirmation = model.take_timeline_changes(false);
        let confirmed = changed_messages(&confirmation)
            .into_iter()
            .find_map(|(_, message)| {
                (message.server_ids.is_empty() && message.server_time_ms.is_none())
                    .then_some(message.id)
            })
            .expect("confirmation has no server metadata");
        let advance = model
            .prepare_mark_read(buffer_id, confirmed)
            .expect("a committed local row is a valid local read target");
        assert!(confirmation_events.iter().any(
            |event| matches!(event, EngineToUi::BufferUpdated { buffer } if buffer.unread == 1)
        ));
        assert!(
            model
                .advance_read(buffer_id, advance.time, false)
                .iter()
                .any(|event| matches!(event, EngineToUi::BufferUpdated { buffer } if buffer.unread == 0))
        );
    }

    #[tokio::test]
    async fn action_echo_confirmation_keeps_semantic_text() {
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
        model.sync_channels(&client.snapshot());
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("joined channel is projected");
        let (pending, _) = model
            .begin_action(buffer_id, "hides".into(), &client.snapshot())
            .expect("channel is sendable");
        let sender = client.clone();
        let send_task = tokio::spawn(async move {
            super::send(&sender, &pending)
                .await
                .map(|sent| (pending, sent))
        });
        assert_eq!(
            wire.next_sent().await,
            "@label=0 PRIVMSG #room :\u{1}ACTION hides\u{1}"
        );
        wire.server(
            "@label=0;msgid=action :weblounge!u@host PRIVMSG #room :\u{1}ACTION hides\u{1}",
        )
        .await;
        let (pending, sent) = send_task
            .await
            .expect("send task completes")
            .expect("send succeeds");

        let confirmation = model
            .confirm_send(&pending, &sent)
            .expect("optimistic row exists");
        let timeline = model.take_timeline_changes(false);
        assert!(!confirmation.is_empty());
        assert!(changed_messages(&timeline).iter().any(|(_, message)| {
            message.kind == crate::MessageKind::Action
                && message.text == "hides"
                && message.server_ids == ["action"]
        }));
    }

    #[tokio::test]
    async fn queued_sends_keep_send_order_when_an_earlier_one_confirms_later() {
        let caps = [
            "echo-message",
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
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("joined channel is projected");
        let queued = ["first queued", "second queued", "third queued"].map(|text| {
            model
                .begin_send(buffer_id, text.into(), &client.snapshot())
                .expect("channel is sendable")
                .0
        });
        let server_day = crate::timeline::LocalDay(47_482);

        for (label, pending) in queued.iter().enumerate() {
            let sender = client.clone();
            let send_pending = pending.clone();
            let send_task = tokio::spawn(async move { super::send(&sender, &send_pending).await });
            assert_eq!(
                wire.next_sent().await,
                format!("@label={label} PRIVMSG #room :{}", pending.text)
            );
            wire.server(format!(
                "@label={label};msgid=m{label};time=2100-01-01T00:00:0{label}.000Z :weblounge!u@host PRIVMSG #room :{}",
                pending.text
            ))
            .await;
            let sent = send_task
                .await
                .expect("send task completes")
                .expect("send succeeds");
            model
                .confirm_send(pending, &sent)
                .expect("optimistic row exists");

            let delivery = |index: usize| {
                if index <= label {
                    MessageDelivery::Confirmed
                } else {
                    MessageDelivery::Optimistic
                }
            };
            let expected = queued
                .iter()
                .enumerate()
                .map(|(index, queued)| (queued.text.clone(), delivery(index), server_day))
                .collect::<Vec<_>>();
            assert_eq!(timeline_rows(&mut model, buffer_id), expected);
        }
    }

    fn timeline_rows(
        model: &mut NetworkModel,
        buffer_id: BufferId,
    ) -> Vec<(String, MessageDelivery, crate::timeline::LocalDay)> {
        model
            .take_timeline_changes(true)
            .into_iter()
            .filter_map(|event| match event {
                EngineToUi::TimelineChanged {
                    buffer_id: changed,
                    upserted,
                    ..
                } if changed == buffer_id => Some(upserted),
                _ => None,
            })
            .flatten()
            .filter_map(|item| match item.body {
                crate::timeline::ItemBody::Message(message) => {
                    Some((message.text, message.delivery, item.day))
                }
                crate::timeline::ItemBody::System(_) | crate::timeline::ItemBody::Gap(_) => None,
            })
            .collect()
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
        model.sync_channels(&client.snapshot());
        let channel = known_channel(&client, "#room");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("joined channel is projected");
        let text = "deployment update ".repeat(40);
        let (pending, _) = model
            .begin_send(buffer_id, text.clone(), &client.snapshot())
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
        let timeline = model.take_timeline_changes(false);
        assert!(!confirmation_events.is_empty());
        assert!(changed_messages(&timeline).iter().any(|(_, message)| {
            message.server_ids == ["whole"] && message.text == text && !message.text.contains('\n')
        }));
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
        model.sync_channels(&client.snapshot());
        let channel = model
            .history_targets()
            .into_iter()
            .find_map(|target| match target {
                HistoryTarget::Channel(channel) if channel == "#room" => Some(channel),
                _ => None,
            })
            .expect("joined channel is projected");
        let buffer_id = model
            .buffer_id_for_target(&SendTarget::Channel(channel))
            .expect("projected channel has a stable id");
        let text = "a".repeat(600);
        let (pending, _) = model
            .begin_send(buffer_id, text, &client.snapshot())
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
        let timeline = model.take_timeline_changes(false);
        let messages = changed_messages(&timeline);
        assert!(!confirmation_events.is_empty());
        assert!(
            messages.iter().any(|(_, message)| {
                message.server_ids == ["first"] && message.text == first_text
            })
        );
        assert!(messages.iter().any(|(_, message)| {
            message.server_ids == ["second"] && message.text == second_text
        }));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), events.next())
                .await
                .is_err(),
            "correlated own echoes must be consumed into Sent"
        );
    }

    struct ReplayHarness {
        client: papo::Client,
        wire: papo_testing::Wire,
        state: Arc<Mutex<RuntimeState>>,
        outbound: mpsc::UnboundedSender<EngineToUi>,
        receiver: mpsc::UnboundedReceiver<EngineToUi>,
        drain: tokio::task::JoinHandle<()>,
    }

    impl ReplayHarness {
        async fn joined(caps: &str) -> Self {
            let (client, events, mut wire) =
                wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
            let (state, outbound, receiver) = harness(client.clone());
            let drain = tokio::spawn(drain_events(
                Arc::clone(&state),
                outbound.clone(),
                client.clone(),
                events,
                1,
            ));
            register_with_caps(&mut wire, caps).await;
            next_sent_containing(&mut wire, "JOIN #room").await;
            wire.server(":weblounge!u@host JOIN #room").await;
            Self {
                client,
                wire,
                state,
                outbound,
                receiver,
                drain,
            }
        }

        /// The requested page finishes the history state before the following live line.
        async fn page_output(&mut self, sentinel: &str) -> Vec<EngineToUi> {
            self.wire
                .server(format!(
                    "@time=2026-10-27T13:00:00.000Z;msgid={sentinel} :louro!l@host PRIVMSG #room :{sentinel}"
                ))
                .await;
            let mut output = Vec::new();
            let (mut finished, mut live) = (false, false);
            tokio::time::timeout(Duration::from_secs(1), async {
                while !(finished && live) {
                    let event = self.receiver.recv().await.expect("runtime remains active");
                    finished |= matches!(
                        event,
                        EngineToUi::HistoryStateChanged { loading: false, .. }
                    );
                    live |= timeline_texts(std::slice::from_ref(&event))
                        .iter()
                        .any(|text| text == sentinel);
                    output.push(event);
                }
            })
            .await
            .expect("the page and the sentinel arrive");
            output
        }

        async fn timeline_output(&mut self, expected: &[&str]) -> Vec<EngineToUi> {
            let mut output = Vec::new();
            tokio::time::timeout(Duration::from_secs(1), async {
                while !expected
                    .iter()
                    .all(|expected| timeline_texts(&output).iter().any(|text| text == expected))
                {
                    output.push(self.receiver.recv().await.expect("runtime remains active"));
                }
            })
            .await
            .expect("the expected timeline rows arrive");
            output
        }
    }

    fn timeline_texts(events: &[EngineToUi]) -> Vec<String> {
        events
            .iter()
            .flat_map(event_timeline_messages)
            .map(|message| message.text.clone())
            .collect()
    }

    fn room_timeline_texts(harness: &ReplayHarness) -> Vec<String> {
        channel_timeline_texts(&harness.state, &harness.client)
    }

    fn channel_timeline_texts(
        state: &Arc<Mutex<RuntimeState>>,
        client: &papo::Client,
    ) -> Vec<String> {
        let state = lock(state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        let channel = known_channel(client, "#room");
        let buffer_id = model
            .buffer_id_for_channel(&channel)
            .expect("channel buffer");
        snapshot_messages(model, buffer_id)
            .into_iter()
            .map(|message| message.text)
            .collect()
    }

    fn timeline_messages(events: &[EngineToUi]) -> Vec<&crate::MessageProjection> {
        events.iter().flat_map(event_timeline_messages).collect()
    }

    fn projected_reaction<'a>(
        events: &'a [EngineToUi],
        text: &str,
    ) -> Option<&'a crate::ReactionProjection> {
        events
            .iter()
            .flat_map(event_timeline_messages)
            .filter(|message| message.text == text)
            .find_map(|message| {
                message
                    .reactions
                    .as_deref()?
                    .iter()
                    .find(|reaction| reaction.text == "👍")
            })
    }

    const HISTORY_CAPS: &str = "draft/chathistory labeled-response batch server-time message-tags";

    fn is_irc_notice(message: &crate::MessageProjection) -> bool {
        matches!(message.kind, crate::MessageKind::IrcNotice(_))
    }

    fn irc_notice_source(message: &crate::MessageProjection) -> Option<crate::NoticeSource> {
        match message.kind {
            crate::MessageKind::IrcNotice(source) => Some(source),
            _ => None,
        }
    }

    fn snapshot_messages(
        model: &NetworkModel,
        buffer_id: BufferId,
    ) -> Vec<crate::MessageProjection> {
        model.projected_messages(buffer_id)
    }

    #[tokio::test]
    async fn live_notices_use_chat_routing_semantics_and_server_buffer_routing() {
        let mut harness =
            ReplayHarness::joined(&format!("{HISTORY_CAPS} account-tag ergo.chat/nope")).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(&mut harness.wire, &latest, &[]).await;
        _ = harness.page_output("notice-live-ready").await;
        harness
            .wire
            .server(":offline.test 005 weblounge MONITOR=100 :supported")
            .await;

        harness
            .wire
            .server("@msgid=channel-notice :alice!a@host NOTICE #room :channel notice")
            .await;
        harness
            .wire
            .server("@msgid=highlight-notice :alice!a@host NOTICE #room :hello weblounge")
            .await;
        harness
            .wire
            .server("@account=bob;msgid=direct-notice :Bob!b@host NOTICE weblounge :direct notice")
            .await;
        _ = harness
            .timeline_output(&["channel notice", "hello weblounge", "direct notice"])
            .await;
        _ = next_sent_containing(&mut harness.wire, "MONITOR + Bob").await;
        harness
            .wire
            .server(":offline.test NOTICE weblounge :server notice")
            .await;
        harness
            .wire
            .server(":NickServ!NickServ@localhost NOTICE weblounge :service notice")
            .await;

        _ = harness
            .timeline_output(&["server notice", "service notice"])
            .await;
        _ = next_sent_containing(&mut harness.wire, "MONITOR + NickServ").await;
        let state = lock(&harness.state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        let EngineToUi::BuffersChanged { buffers, .. } = model.buffers_event() else {
            panic!("buffer projections")
        };
        let channel = buffers
            .iter()
            .find(|buffer| buffer.title == "#room")
            .expect("channel buffer");
        let direct = buffers
            .iter()
            .find(|buffer| buffer.title == "Bob")
            .expect("direct buffer");
        let nickserv = buffers
            .iter()
            .find(|buffer| buffer.title == "NickServ")
            .expect("NickServ direct buffer");
        let server = buffers
            .iter()
            .find(|buffer| buffer.id == BufferId(1))
            .expect("server buffer");
        let channel_messages = snapshot_messages(model, channel.id);
        let direct_messages = snapshot_messages(model, direct.id);
        let nickserv_messages = snapshot_messages(model, nickserv.id);
        let server_messages = snapshot_messages(model, server.id);
        assert!(
            channel_messages
                .iter()
                .all(|message| { message.text == "notice-live-ready" || is_irc_notice(message) })
        );
        assert_eq!((channel.unread, channel.mentions), (2, 1));
        assert_eq!((direct.unread, direct.mentions), (1, 1));
        assert!(direct_messages.iter().all(is_irc_notice));
        assert_eq!((nickserv.unread, nickserv.mentions), (1, 1));
        assert!(nickserv_messages.iter().all(is_irc_notice));
        assert_eq!(
            server_messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            ["server notice"]
        );
        assert!(server_messages.iter().all(is_irc_notice));
        assert_eq!((server.unread, server.mentions), (0, 0));
        drop(state);
        harness.drain.abort();
    }

    #[tokio::test]
    async fn history_projects_channel_notices_with_their_notice_semantic() {
        let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &[
                "@batch={batch};time=2026-10-27T12:00:01.000Z;msgid=history-text :alice!a@host PRIVMSG #room :history text",
                "@batch={batch};time=2026-10-27T12:00:02.000Z;msgid=history-notice :alice!a@host NOTICE #room :history notice",
            ],
        )
        .await;

        let output = harness.page_output("notice-history-ready").await;
        let notice = timeline_messages(&output)
            .into_iter()
            .find(|message| message.text == "history notice")
            .expect("history notice is projected");
        assert!(is_irc_notice(notice));
        harness.drain.abort();
    }

    #[tokio::test]
    async fn server_notices_and_wallops_route_with_typed_sources() {
        let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(&mut harness.wire, &latest, &[]).await;
        _ = harness.page_output("notice-server-ready").await;

        harness
            .wire
            .server(":NickServ!service@services.test NOTICE $* :service broadcast")
            .await;
        harness
            .wire
            .server(":offline.test WALLOPS :network maintenance")
            .await;
        _ = harness
            .timeline_output(&["service broadcast", "network maintenance"])
            .await;

        let state = lock(&harness.state);
        let model = &state.network.as_ref().expect("active network").model;
        let messages = snapshot_messages(model, BufferId(1));
        assert_eq!(
            messages
                .iter()
                .filter_map(irc_notice_source)
                .collect::<Vec<_>>(),
            [crate::NoticeSource::Service, crate::NoticeSource::Server]
        );
        drop(state);
        harness.drain.abort();
    }

    #[tokio::test]
    async fn pushed_notice_reconciles_with_authoritative_notice_by_msgid() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["message-tags", "server-time"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, mut receiver) = harness(client.clone());
        let pushed = serde_json::from_value::<PushedMessage>(serde_json::json!({
            "schema": 1,
            "network_label": "Test",
            "nickname": "weblounge",
            "sender": "alice",
            "target": "#room",
            "msgid": "pushed-notice",
            "time": "2026-11-03T12:34:56.788Z",
            "text": "notice while closed",
            "kind": "notice",
        }))
        .expect("pushed notice");
        let restored = {
            let mut state = lock(&state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            model.restore_pushed_messages(vec![pushed], &client.snapshot());
            model.take_timeline_changes(false)
        };
        let provisional = timeline_messages(&restored)
            .into_iter()
            .find(|message| message.text == "notice while closed")
            .expect("pushed notice is visible");
        assert!(is_irc_notice(provisional));

        wire.server("@msgid=pushed-notice;time=2026-11-03T12:34:56.789Z :alice!a@host NOTICE #room :notice while closed")
            .await;
        let notice =
            next_matching(&mut events, |event| matches!(event, papo::Event::Notice(_))).await;
        process_event(&state, &outbound, &client, 1, notice);
        let output = collect(&mut receiver);
        assert!(
            timeline_messages(&output)
                .iter()
                .any(|message| message.text == "notice while closed" && is_irc_notice(message))
        );
        let state = lock(&state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        let EngineToUi::BuffersChanged { buffers, .. } = model.buffers_event() else {
            panic!("buffer projections")
        };
        let room_id = buffers
            .iter()
            .find(|buffer| buffer.title == "#room")
            .expect("room buffer")
            .id;
        let room = model
            .projected_messages(room_id)
            .into_iter()
            .filter(|message| message.text == "notice while closed")
            .collect::<Vec<_>>();
        assert_eq!(room.len(), 1);
        assert!(is_irc_notice(&room[0]));
    }

    #[tokio::test]
    async fn live_reaction_updates_its_loaded_message() {
        let mut harness = ReplayHarness::joined(&format!("{HISTORY_CAPS} draft/react")).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(&mut harness.wire, &latest, &[]).await;
        _ = harness.page_output("initial-sentinel").await;
        harness
            .wire
            .server("@time=2026-10-27T13:01:00.000Z;msgid=live-target :alice!a@host PRIVMSG #room :live target")
            .await;
        harness
            .wire
            .server("@time=2026-10-27T13:02:00.000Z;msgid=live-reaction;+draft/react=👍;+draft/reply=live-target :alice!a@host TAGMSG #room")
            .await;

        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), async {
            while projected_reaction(&output, "live target").is_none() {
                output.push(
                    harness
                        .receiver
                        .recv()
                        .await
                        .expect("runtime remains active"),
                );
            }
        })
        .await
        .expect("live reaction updates its row");
        assert!(
            !projected_reaction(&output, "live target")
                .expect("live reaction")
                .mine
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn own_history_reaction_remains_mine_after_reconnect() {
        let mut harness =
            ReplayHarness::joined(&format!("{HISTORY_CAPS} account-tag draft/react")).await;
        harness
            .wire
            .server(":offline.test 900 weblounge weblounge!u@host account :logged in")
            .await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &[
                "@batch={batch};account=alice;time=2026-10-27T12:00:00.000Z;msgid=target :alice!a@host PRIVMSG #room :reacted message",
                "@batch={batch};account=account;time=2026-10-27T12:01:00.000Z;msgid=own-reaction;+draft/react=👍;+draft/reply=target :weblounge!u@host TAGMSG #room",
            ],
        )
        .await;

        let output = harness.page_output("reconnect-sentinel").await;
        assert!(
            projected_reaction(&output, "reacted message")
                .expect("history reaction")
                .mine
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn hosted_fresh_client_marks_account_owned_history_reaction_as_mine() {
        let mut harness =
            ReplayHarness::joined(&format!("{HISTORY_CAPS} account-tag draft/react")).await;
        harness
            .wire
            .server(":offline.test 900 weblounge weblounge!u@host account :logged in")
            .await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &[
                "@batch={batch};account=alice;time=2026-10-27T12:00:00.000Z;msgid=target :alice!a@host PRIVMSG #room :hosted message",
                "@batch={batch};account=account;time=2026-10-27T12:01:00.000Z;msgid=hosted-reaction;+draft/react=👍;+draft/reply=target :phone!u@host TAGMSG #room",
            ],
        )
        .await;

        let output = harness.page_output("hosted-sentinel").await;
        assert!(
            projected_reaction(&output, "hosted message")
                .expect("history reaction")
                .mine
        );
        harness.drain.abort();
    }

    const REACTION_CAPS: &str = "message-tags echo-message server-time labeled-response batch";

    impl ReplayHarness {
        async fn live_room_message(&mut self, msgid: &str, text: &str) -> (BufferId, MessageId) {
            self.wire
                .server(format!(
                    "@time=2026-10-27T13:01:00.000Z;msgid={msgid} :alice!a@host PRIVMSG #room :{text}"
                ))
                .await;
            _ = self.timeline_output(&[text]).await;
            let state = lock(&self.state);
            let model = &state
                .network
                .as_ref()
                .expect("network remains active")
                .model;
            let buffer_id = model
                .buffer_id_for_channel(&known_channel(&self.client, "#room"))
                .expect("channel buffer");
            let message_id = model
                .projected_messages(buffer_id)
                .into_iter()
                .find(|message| message.text == text)
                .expect("live message")
                .id;
            (buffer_id, message_id)
        }

        fn toggle_reaction(&self, buffer_id: BufferId, message_id: MessageId) -> Vec<EngineToUi> {
            Runtime {
                state: Arc::clone(&self.state),
                outbound: self.outbound.clone(),
            }
            .request(EngineRequestEnvelope {
                id: "react".into(),
                request: EngineRequest::ToggleReaction {
                    buffer_id,
                    message_id,
                    reaction: "👍".into(),
                },
            })
        }

        async fn reaction_until(
            &mut self,
            text: &str,
            accept: impl Fn(Option<&crate::ReactionProjection>) -> bool,
        ) -> Option<crate::ReactionProjection> {
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let event = self.receiver.recv().await.expect("runtime remains active");
                    let events = [event];
                    if timeline_messages(&events)
                        .iter()
                        .any(|message| message.text == text)
                    {
                        let reaction = projected_reaction(&events, text);
                        if accept(reaction) {
                            return reaction.cloned();
                        }
                    }
                }
            })
            .await
            .expect("the reaction projection arrives")
        }
    }

    // TODO(papo-0.1 reaction-confirm): the labeled echo only resolves papo's future today, so
    // this proves confirmation from that resolution; once papo returns
    // `Confirmed { msgid, server_time }`, assert the echoed msgid versions the own fact.
    #[tokio::test]
    async fn own_reaction_sends_through_papo_and_confirms_on_echo() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, message_id) = harness.live_room_message("target", "react here").await;

        let output = harness.toggle_reaction(buffer_id, message_id);

        let sending = projected_reaction(&output, "react here").expect("optimistic reaction");
        assert!(sending.mine);
        assert_eq!(
            sending.own_delivery,
            Some(crate::OwnChangeDelivery::Sending)
        );
        let sent = next_sent_containing(&mut harness.wire, "TAGMSG #room").await;
        assert!(sent.contains("+draft/react=👍"), "{sent}");
        assert!(sent.contains("reply=target"), "{sent}");

        harness
            .wire
            .server(format!("@label={};time=2026-10-27T13:02:00.000Z;msgid=own-react;+draft/react=👍;+draft/reply=target :weblounge!u@host TAGMSG #room", line_label(&sent)))
            .await;
        let confirmed = harness
            .reaction_until("react here", |reaction| {
                reaction.is_some_and(|reaction| reaction.own_delivery.is_none())
            })
            .await
            .expect("confirmed reaction");
        assert!(confirmed.mine);
        harness.drain.abort();
    }

    // TODO(papo-0.1 reaction-confirm): the labeled echo only resolves papo's future today, so
    // this proves confirmation from that resolution; once papo returns
    // `Confirmed { msgid, server_time }`, assert the echoed msgid versions the own fact.
    #[tokio::test]
    async fn own_unreaction_removes_the_chip_after_its_echo() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, message_id) = harness.live_room_message("target", "unreact here").await;
        harness
            .wire
            .server("@time=2026-10-27T13:02:00.000Z;msgid=own-react;+draft/react=👍;+draft/reply=target :weblounge!u@host TAGMSG #room")
            .await;
        _ = harness
            .reaction_until("unreact here", |reaction| reaction.is_some())
            .await;

        let output = harness.toggle_reaction(buffer_id, message_id);

        assert!(projected_reaction(&output, "unreact here").is_none());
        let sent = next_sent_containing(&mut harness.wire, "TAGMSG #room").await;
        assert!(sent.contains("+draft/unreact=👍"), "{sent}");
        harness
            .wire
            .server(format!("@label={};time=2026-10-27T13:03:00.000Z;msgid=own-unreact;+draft/unreact=👍;+draft/reply=target :weblounge!u@host TAGMSG #room", line_label(&sent)))
            .await;
        _ = harness.live_room_message("after", "after unreact").await;

        let again = harness.toggle_reaction(buffer_id, message_id);

        assert!(projected_reaction(&again, "unreact here").is_some());
        let resent = next_sent_containing(&mut harness.wire, "TAGMSG #room").await;
        assert!(resent.contains("+draft/react=👍"), "{resent}");
        harness.drain.abort();
    }

    #[tokio::test]
    async fn a_received_reply_quotes_its_loaded_parent_without_the_nick_prefix() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, parent_id) = harness
            .live_room_message("parent", "who has the keys?")
            .await;
        let parent_color = lock(&harness.state)
            .network
            .as_ref()
            .expect("network remains active")
            .model
            .projected_messages(buffer_id)
            .into_iter()
            .find(|message| message.id == parent_id)
            .expect("the parent row")
            .nick_color_index;
        harness
            .wire
            .server("@time=2026-10-27T13:02:00.000Z;msgid=reply;+draft/reply=parent :bob!b@host PRIVMSG #room :alice: I do")
            .await;

        let output = harness.timeline_output(&["I do"]).await;

        let reply = timeline_messages(&output)
            .into_iter()
            .find(|message| message.text == "I do")
            .expect("the reply row");
        assert_eq!(
            reply.reply,
            Some(crate::ReplyParent::Loaded {
                message_id: parent_id,
                author: "alice".into(),
                nick_color_index: parent_color,
                text: "who has the keys?".into(),
            })
        );
        harness.drain.abort();
    }

    impl ReplayHarness {
        fn reply(&self, buffer_id: BufferId, parent_id: MessageId, input: &str) -> Vec<EngineToUi> {
            Runtime {
                state: Arc::clone(&self.state),
                outbound: self.outbound.clone(),
            }
            .request(EngineRequestEnvelope {
                id: "reply".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id,
                    input: input.into(),
                    reply_to: Some(parent_id),
                },
            })
        }

        async fn confirmed(&mut self, text: &str) -> crate::MessageProjection {
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let event = self.receiver.recv().await.expect("runtime remains active");
                    if let Some(message) =
                        event_timeline_messages(&event).into_iter().find(|message| {
                            message.text == text && message.delivery == MessageDelivery::Confirmed
                        })
                    {
                        return message.clone();
                    }
                }
            })
            .await
            .expect("the confirmed row arrives")
        }
    }

    #[tokio::test]
    async fn a_channel_reply_names_its_parent_on_the_wire_and_quotes_it_once_echoed() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, parent_id) = harness
            .live_room_message("parent", "who has the keys?")
            .await;

        harness.reply(buffer_id, parent_id, "I do");

        let sent = next_sent_containing(&mut harness.wire, "PRIVMSG #room").await;
        let (tags, line) = sent.split_once(' ').expect("a tagged line");
        assert!(
            tags.trim_start_matches('@')
                .split(';')
                .any(|tag| tag == "+reply=parent"),
            "{sent}"
        );
        assert_eq!(line, "PRIVMSG #room :alice: I do");
        let label = line_label(&sent);
        harness
            .wire
            .server(format!(
                "@label={label};msgid=mine;time=2026-10-27T13:02:00.000Z :weblounge!u@host PRIVMSG #room :alice: I do"
            ))
            .await;

        let reply = harness.confirmed("I do").await;
        assert!(matches!(
            reply.reply,
            Some(crate::ReplyParent::Loaded { message_id, .. }) if message_id == parent_id
        ));
        harness.drain.abort();
    }

    #[tokio::test]
    async fn a_reply_to_a_row_that_has_left_the_timeline_is_refused() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, _) = harness.live_room_message("parent", "ship it?").await;

        let refused = harness.reply(buffer_id, MessageId(9_999), "yes");

        assert_eq!(
            rejection_key_and_nick(refused.into_iter().next().expect("a rejection")).0,
            EngineMessageKey::ReplyParentGone
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn a_reply_to_an_unloaded_parent_keeps_its_text_and_says_so() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        harness
            .wire
            .server("@time=2026-10-27T13:02:00.000Z;msgid=reply;+draft/reply=gone :bob!b@host PRIVMSG #room :alice: I do")
            .await;

        let output = harness.timeline_output(&["alice: I do"]).await;

        let reply = timeline_messages(&output)
            .into_iter()
            .find(|message| message.text == "alice: I do")
            .expect("the reply row");
        assert_eq!(reply.reply, Some(crate::ReplyParent::Unavailable));
        harness.drain.abort();
    }

    async fn next_can_react(harness: &mut ReplayHarness) -> bool {
        next_online_network(harness).await.can_react
    }

    async fn next_online_network(harness: &mut ReplayHarness) -> crate::NetworkProjection {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let EngineToUi::NetworkStateChanged { network } = harness
                    .receiver
                    .recv()
                    .await
                    .expect("runtime remains active")
                    && network.state == crate::NetworkConnectionState::Online
                {
                    return network;
                }
            }
        })
        .await
        .expect("the network projection arrives")
    }

    #[tokio::test]
    async fn network_projects_reaction_sending_from_current_features() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        assert!(next_can_react(&mut harness).await);

        harness
            .wire
            .server(":offline.test 005 weblounge CLIENTTAGDENY=draft/react :supported")
            .await;

        assert!(!next_can_react(&mut harness).await);
        harness.drain.abort();
    }

    #[tokio::test]
    async fn network_projects_replies_only_with_message_tags() {
        let mut tagged = ReplayHarness::joined("message-tags").await;
        let network = next_online_network(&mut tagged).await;
        assert!(network.can_reply && !network.can_react);
        tagged.drain.abort();

        let mut plain = ReplayHarness::joined("server-time").await;
        assert!(!next_online_network(&mut plain).await.can_reply);
        plain.drain.abort();
    }

    #[tokio::test]
    async fn network_without_labeled_echoes_cannot_send_reactions() {
        let mut harness = ReplayHarness::joined("message-tags echo-message server-time").await;

        assert!(!next_can_react(&mut harness).await);
        harness.drain.abort();
    }

    fn line_label(line: &str) -> &str {
        line.split([';', ' '])
            .find_map(|tag| tag.trim_start_matches('@').strip_prefix("label="))
            .expect("labeled request")
    }

    #[tokio::test]
    async fn refused_own_reaction_fails_and_retries() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let (buffer_id, message_id) = harness.live_room_message("target", "refused here").await;

        _ = harness.toggle_reaction(buffer_id, message_id);
        let sent = next_sent_containing(&mut harness.wire, "TAGMSG #room").await;
        harness
            .wire
            .server(format!(
                "@label={} :offline.test FAIL TAGMSG INVALID_TARGET #room :refused",
                line_label(&sent)
            ))
            .await;

        let failed = harness
            .reaction_until("refused here", |reaction| {
                reaction.is_some_and(|reaction| {
                    reaction.own_delivery == Some(crate::OwnChangeDelivery::Failed)
                })
            })
            .await
            .expect("failed reaction");
        assert!(failed.mine);
        let retried = harness.toggle_reaction(buffer_id, message_id);
        assert_eq!(
            projected_reaction(&retried, "refused here").and_then(|reaction| reaction.own_delivery),
            Some(crate::OwnChangeDelivery::Sending)
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn own_reaction_in_an_unsendable_direct_fails_visibly() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        let text = "react to my DM";
        harness
            .wire
            .server(format!(
                "@time=2026-10-27T13:01:00.000Z;msgid=dm-target :alice!a@host PRIVMSG weblounge :{text}"
            ))
            .await;
        _ = harness.timeline_output(&[text]).await;
        let (buffer_id, message_id) = {
            let mut state = lock(&harness.state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            let alice = harness
                .client
                .snapshot()
                .name_rules()
                .expect("registered test client has name rules")
                .nick("alice");
            let buffer_id = model
                .buffer_id_for_name(&NameKey::Direct(alice))
                .expect("direct buffer");
            _ = model.record_direct_mismatch(
                buffer_id,
                PinMismatch::CannotVerify,
                PeerPin::default(),
            );
            let message_id = model
                .projected_messages(buffer_id)
                .into_iter()
                .find(|message| message.text == text)
                .expect("direct message")
                .id;
            (buffer_id, message_id)
        };

        let output = harness.toggle_reaction(buffer_id, message_id);

        assert_eq!(
            projected_reaction(&output, text).and_then(|reaction| reaction.own_delivery),
            Some(crate::OwnChangeDelivery::Sending)
        );
        let failed = harness
            .reaction_until(text, |reaction| {
                reaction.is_some_and(|reaction| {
                    reaction.own_delivery == Some(crate::OwnChangeDelivery::Failed)
                })
            })
            .await
            .expect("failed reaction");
        assert!(failed.mine);
        harness.drain.abort();
    }

    #[tokio::test]
    async fn own_reaction_is_refused_without_the_reaction_capability() {
        let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
        harness
            .wire
            .server(":offline.test 005 weblounge CLIENTTAGDENY=draft/react :supported")
            .await;
        let (buffer_id, message_id) = harness.live_room_message("target", "denied here").await;

        let output = harness.toggle_reaction(buffer_id, message_id);

        assert!(matches!(
            output.as_slice(),
            [EngineToUi::CommandRejected { .. }]
        ));
        harness.drain.abort();
    }

    #[tokio::test]
    async fn latest_ergo_page_prepends_once() {
        let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &[
                "@batch={batch};time=2026-10-27T12:00:01.000Z;msgid=m1 :louro!l@host PRIVMSG #room :latest one",
                "@batch={batch};time=2026-10-27T12:00:02.000Z;msgid=ml :louro!l@host BATCH +ml draft/multiline #room",
                "@batch=ml :louro!l@host PRIVMSG #room :long first",
                "@batch=ml :louro!l@host PRIVMSG #room :long second",
                "@batch={batch} :louro!l@host BATCH -ml",
            ],
        )
        .await;

        let output = harness.page_output("sentinel").await;
        assert_eq!(
            timeline_texts(&output),
            ["latest one", "long first\nlong second", "sentinel"]
        );
        assert_eq!(
            room_timeline_texts(&harness),
            ["latest one", "long first\nlong second", "sentinel"]
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn older_ergo_page_prepends_once() {
        let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &["@batch={batch};time=2026-10-27T12:00:01.000Z;msgid=m1 :louro!l@host PRIVMSG #room :latest one"],
        )
        .await;
        _ = harness.page_output("first-sentinel").await;
        let fetch = {
            let mut state = lock(&harness.state);
            let model = &mut state
                .network
                .as_mut()
                .expect("network remains active")
                .model;
            let channel = known_channel(&harness.client, "#room");
            let buffer_id = model
                .buffer_id_for_channel(&channel)
                .expect("channel buffer");
            model
                .request_history(buffer_id, crate::HistoryDirection::Older)
                .expect("an older page is requestable")
        };
        spawn_history_fetch(
            Arc::clone(&harness.state),
            harness.outbound.clone(),
            harness.client.clone(),
            1,
            fetch,
            None,
        );
        let before =
            next_sent_containing(&mut harness.wire, "CHATHISTORY BEFORE #room msgid=m1").await;
        send_ergo_history_page(
            &mut harness.wire,
            &before,
            &["@batch={batch};time=2026-10-20T12:00:00.000Z;msgid=old :louro!l@host PRIVMSG #room :a week old"],
        )
        .await;

        let output = harness.page_output("second-sentinel").await;
        assert_eq!(timeline_texts(&output), ["a week old", "second-sentinel"]);
        assert_eq!(
            room_timeline_texts(&harness),
            [
                "a week old",
                "latest one",
                "first-sentinel",
                "second-sentinel"
            ]
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn unrequested_playback_merges_with_chathistory_support() {
        let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(&mut harness.wire, &latest, &[]).await;
        _ = harness.page_output("initial-sentinel").await;

        harness
            .wire
            .server(":offline.test BATCH +playback chathistory #room")
            .await;
        harness
            .wire
            .server("@batch=playback;time=2026-10-27T12:00:00.000Z;msgid=r1 :louro!l@host PRIVMSG #room :server playback")
            .await;
        harness.wire.server(":offline.test BATCH -playback").await;
        harness
            .wire
            .server("@time=2026-10-27T13:00:00.000Z;msgid=live :louro!l@host PRIVMSG #room :live after playback")
            .await;

        let output = harness
            .timeline_output(&["server playback", "live after playback"])
            .await;
        assert_eq!(
            timeline_texts(&output),
            ["server playback", "live after playback"]
        );
        assert_eq!(
            room_timeline_texts(&harness),
            ["server playback", "initial-sentinel", "live after playback"]
        );
        harness.drain.abort();
    }

    #[tokio::test]
    async fn a_requested_history_row_is_a_bot_by_its_own_tag() {
        let mut harness = ReplayHarness::joined(
            "draft/chathistory labeled-response batch server-time message-tags account-tag",
        )
        .await;
        harness
            .wire
            .server(":offline.test 005 weblounge BOT=B :are supported")
            .await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(
            &mut harness.wire,
            &latest,
            &[
                "@batch={batch};bot;account=warm;time=2026-10-27T12:00:00.000Z;msgid=h1 :warm!w@host PRIVMSG #room :tagged bot",
                "@batch={batch};account=human;time=2026-10-27T12:00:01.000Z;msgid=h2 :human!h@host PRIVMSG #room :untagged",
            ],
        )
        .await;

        let output = harness.page_output("bot-sentinel").await;
        let bot = |text: &str| {
            timeline_messages(&output)
                .into_iter()
                .find(|message| message.text == text)
                .expect("history row")
                .bot
        };
        assert_eq!(bot("tagged bot"), Some(true));
        assert_eq!(bot("untagged"), None);
        harness.drain.abort();
    }

    #[tokio::test]
    async fn live_and_replayed_actor_bot_facts_match_without_guessing_unknown() {
        let mut harness = ReplayHarness::joined(
            "draft/chathistory labeled-response batch server-time message-tags account-tag draft/oper-tag",
        )
        .await;
        let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
        send_ergo_history_page(&mut harness.wire, &latest, &[]).await;
        _ = harness.page_output("initial-sentinel").await;

        harness
            .wire
            .server(":offline.test BATCH +playback chathistory #room")
            .await;
        harness
            .wire
            .server("@batch=playback;account=service;bot;draft/oper=network-admin;time=2026-10-27T12:00:00.000Z;msgid=replay-bot :service!s@host PRIVMSG #room :replayed bot")
            .await;
        harness.wire.server(":offline.test BATCH -playback").await;
        harness
            .wire
            .server("@account=service;bot;draft/oper=network-admin;time=2026-10-27T13:00:00.000Z;msgid=live-bot :service!s@host PRIVMSG #room :live bot")
            .await;
        harness
            .wire
            .server("@time=2026-10-27T13:01:00.000Z;msgid=unknown :person!p@host PRIVMSG #room :unknown bot")
            .await;

        let output = harness
            .timeline_output(&["replayed bot", "live bot", "unknown bot"])
            .await;
        let projected = timeline_messages(&output);
        for text in ["replayed bot", "live bot"] {
            assert_eq!(
                projected
                    .iter()
                    .find(|message| message.text == text)
                    .expect("bot row")
                    .bot,
                Some(true)
            );
        }
        assert_eq!(
            projected
                .iter()
                .find(|message| message.text == "unknown bot")
                .expect("unknown row")
                .bot,
            None
        );
        harness.drain.abort();
    }

    async fn settings_events(
        runtime: &Runtime,
        receiver: &mut mpsc::UnboundedReceiver<EngineToUi>,
        id: &str,
        request: EngineRequest,
    ) -> Vec<EngineToUi> {
        assert!(
            runtime
                .request(EngineRequestEnvelope {
                    id: id.into(),
                    request,
                })
                .is_empty()
        );
        let mut events = Vec::new();
        loop {
            let event = receiver.recv().await.expect("settings event");
            let terminal = matches!(
                &event,
                EngineToUi::CommandResult { id: done } | EngineToUi::CommandRejected { id: done, .. }
                    if done == id
            );
            events.push(event);
            if terminal {
                return events;
            }
        }
    }

    #[tokio::test]
    async fn a_setting_change_is_broadcast_and_then_loads_from_storage() {
        use crate::settings::{AppSetting, Density, SettingChange, Settings};

        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let change = SettingChange::App(AppSetting::MessageDensity(Density::Compact));
        let mut expected = Settings::default();
        expected.app.message_density = Density::Compact;

        assert_eq!(
            settings_events(
                &runtime,
                &mut receiver,
                "change",
                EngineRequest::ChangeSetting { change }
            )
            .await,
            vec![
                EngineToUi::SettingsChanged { settings: expected },
                EngineToUi::CommandResult {
                    id: "change".into()
                },
            ]
        );
        assert_eq!(
            settings_events(&runtime, &mut receiver, "load", EngineRequest::LoadSettings).await,
            vec![
                EngineToUi::SettingsLoaded {
                    command_id: "load".into(),
                    settings: expected,
                },
                EngineToUi::CommandResult { id: "load".into() },
            ]
        );
    }

    #[tokio::test]
    async fn an_invalid_stored_setting_is_diagnosed_and_loads_as_its_default() {
        use crate::settings::Settings;

        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let storage = lock(&runtime.state).storage.clone();
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: b"settings/app".to_vec(),
                    value: br#"{"version":1,"fields":{"theme":"neon"}}"#.to_vec(),
                }],
            )
            .await
            .expect("seed settings");

        let events =
            settings_events(&runtime, &mut receiver, "load", EngineRequest::LoadSettings).await;

        assert!(matches!(
            &events[..],
            [
                EngineToUi::Diagnostic { command_id, message },
                EngineToUi::SettingsLoaded { settings, .. },
                EngineToUi::CommandResult { .. },
            ] if command_id == "load" && message.contains("theme") && *settings == Settings::default()
        ));
    }

    #[tokio::test]
    async fn a_newer_settings_record_rejects_changes_without_broadcasting() {
        use crate::settings::{AppSetting, Density, SettingChange};

        let (outbound, mut receiver) = mpsc::unbounded_channel();
        let runtime = Runtime::new(outbound);
        let storage = lock(&runtime.state).storage.clone();
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: b"settings/app".to_vec(),
                    value: br#"{"version":2,"fields":{}}"#.to_vec(),
                }],
            )
            .await
            .expect("seed settings");
        let change = SettingChange::App(AppSetting::MessageDensity(Density::Compact));

        assert_eq!(
            settings_events(
                &runtime,
                &mut receiver,
                "change",
                EngineRequest::ChangeSetting { change }
            )
            .await,
            vec![EngineToUi::CommandRejected {
                id: "change".into(),
                message_key: EngineMessageKey::StorageUnavailable,
                values: None,
            }]
        );
    }

    #[tokio::test]
    async fn an_unshared_peer_who_messages_shows_online_before_its_monitor_reply() {
        let mut harness = ReplayHarness::joined(
            "away-notify extended-monitor account-tag message-tags server-time batch labeled-response",
        )
        .await;
        harness
            .wire
            .server(":offline.test 005 weblounge MONITOR=100 WHOX :supported")
            .await;
        harness
            .wire
            .server("@account=alice;msgid=m1;time=2026-11-23T15:36:18.810Z :alice!~u@cloak.irc PRIVMSG weblounge :hello")
            .await;
        assert_eq!(
            next_sent_containing(&mut harness.wire, "MONITOR").await,
            "MONITOR + alice"
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(
                harness.receiver.recv().await.expect("runtime remains active"),
                EngineToUi::BufferUpdated { buffer }
                    if buffer.title == "alice"
                        && buffer.peer_presence == Some(crate::PeerPresence::Online)
            ) {}
        })
        .await
        .expect("alice shows online without waiting for the 730");
        harness.drain.abort();
    }
}
