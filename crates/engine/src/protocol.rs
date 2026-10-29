use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::CommandSpec;

macro_rules! numeric_id {
    ($name:ident, $documentation:literal) => {
        #[doc = $documentation]
        #[derive(Clone, Copy, Debug, Deserialize, Hash, PartialEq, Eq, Serialize, TS)]
        #[serde(transparent)]
        pub struct $name(#[ts(type = "number")] pub u64);
    };
}

numeric_id!(NetworkId, "Stable engine identity for one network.");
numeric_id!(BufferId, "Stable engine identity for one buffer.");
numeric_id!(MessageId, "Stable engine identity for one timeline row.");
numeric_id!(LocalSendId, "Stable identity for one optimistic send.");

/// Secret text that keeps its serialized wire value but redacts diagnostics.
#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RedactedSecret(String);

impl RedactedSecret {
    pub(crate) fn into_inner(self) -> String {
        self.0
    }
}

impl From<String> for RedactedSecret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for RedactedSecret {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl std::fmt::Debug for RedactedSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// SASL PLAIN credentials used only while constructing a papo client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct SaslCredentials {
    /// SASL account name.
    pub account: String,
    /// SASL password; never included in projections or errors.
    #[ts(type = "string")]
    pub password: RedactedSecret,
}

/// Runtime deployment configuration served by the web host.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DeploymentConfig {
    /// User-managed application mode.
    App,
    /// One preconfigured network authenticated by the deployment's OAuth issuer.
    Hosted {
        /// Network shown in the shell.
        network: HostedNetworkConfig,
        /// Public OAuth authorization-code client configuration.
        oauth: HostedOAuthConfig,
    },
}

/// Hosted network preset supplied by the deployment.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct HostedNetworkConfig {
    /// Display name for the preconfigured network.
    pub name: String,
    /// Secure browser WebSocket endpoint.
    pub endpoint: String,
    /// Channels joined after registration.
    pub autojoin: Vec<String>,
}

/// Public OAuth client preset supplied by the deployment.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct HostedOAuthConfig {
    /// RFC 8414 issuer URL.
    pub issuer: String,
    /// Public OAuth client identifier.
    pub client_id: String,
    /// Exact authorization callback URL, without a fragment.
    pub redirect_uri: String,
}

/// Connection state projected for the temporary debug shell.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NetworkConnectionState {
    /// A papo client is registering or reconnecting.
    Connecting,
    /// Registration completed.
    Online,
    /// The connection is waiting for papo's reconnect attempt.
    Reconnecting,
    /// No papo client is running.
    Stopped,
}

/// UI projection of one configured network.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct NetworkProjection {
    /// Stable network identity.
    pub id: NetworkId,
    /// User-facing network label.
    pub label: String,
    /// Current nickname.
    pub nickname: String,
    /// Current connection state.
    pub state: NetworkConnectionState,
}

/// Conversation represented by a buffer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BufferKind {
    /// Network status buffer.
    Server,
    /// IRC channel.
    Channel,
    /// Direct conversation with a nick.
    Direct,
}

/// UI projection of one engine buffer.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct BufferProjection {
    /// Stable buffer identity.
    pub id: BufferId,
    /// Owning network.
    pub network_id: NetworkId,
    /// Kind of conversation.
    pub kind: BufferKind,
    /// Current channel or nick display name.
    pub title: String,
    /// Session draft identity derived from the network and IRC-casemapped name.
    pub draft_key: String,
    /// Current channel topic, when this is a channel and the server supplied one.
    pub topic: Option<String>,
    /// Current channel member total, independent of any requested member window.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub member_count: Option<u32>,
    /// Messages after the local read position.
    #[ts(type = "number")]
    pub unread: u64,
    /// Unread messages mentioning the current nick.
    #[ts(type = "number")]
    pub mentions: u64,
    /// Latest committed row covered by the effective read marker.
    pub read_through: Option<MessageId>,
    /// Latest timeline row for conversation-list previews.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_message: Option<MessageProjection>,
}

/// Who authored a projected message relative to this client.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageAuthorship {
    /// Authored by the current account, including another device.
    Own,
    /// Authored by another user.
    Other,
    /// Papo could not determine authorship.
    Unknown,
}

/// Delivery state of a timeline row.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageDelivery {
    /// Received from the server.
    Received,
    /// Locally inserted while papo sends it.
    Optimistic,
    /// Reconciled from `papo::Sent`.
    Confirmed,
    /// The send attempt failed and may be retried.
    Failed,
}

/// Composer suggestion family selected from the input around the caret.
#[allow(missing_docs)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CompletionTrigger {
    Command,
    Person,
    Channel,
}

/// One engine-ranked composer suggestion with presentation facts.
#[allow(missing_docs)]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CompletionCandidate {
    Command {
        name: String,
        usage: String,
        description: String,
    },
    Person {
        nick: String,
        #[ts(type = "number")]
        nick_color_index: u32,
        away: bool,
        bot: bool,
    },
    Channel {
        name: String,
    },
}

/// Semantic presentation of a chat message.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// A regular chat line.
    Text,
    /// A CTCP ACTION displayed as `/me` prose.
    Action,
    /// A local informational row generated from current engine state.
    Notice,
}

/// UI projection of one chat message.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct MessageProjection {
    /// Stable timeline identity.
    pub id: MessageId,
    /// Display nick supplied by papo.
    pub author: String,
    /// Plain chat text.
    pub text: String,
    /// Whether the message is regular text or an action.
    pub kind: MessageKind,
    /// Whether IRC metadata identifies the author as a bot.
    pub bot: bool,
    /// Highest channel membership prefix known when the message arrived.
    pub mode_symbol: Option<char>,
    /// Authorship relative to this client.
    pub authorship: MessageAuthorship,
    /// Stable palette index derived with the network's IRC name rules.
    #[ts(type = "number")]
    pub nick_color_index: u32,
    /// Whether this row mentions the current nickname.
    pub mentioned: bool,
    /// Current delivery state.
    pub delivery: MessageDelivery,
    /// Optimistic send identity, when this is a placeholder.
    pub local_send_id: Option<LocalSendId>,
    /// Every server identity returned by one papo send.
    pub server_ids: Vec<String>,
    /// Server timestamp in Unix milliseconds, when supplied.
    #[ts(type = "number | null")]
    pub server_time_ms: Option<i64>,
    /// Local receipt timestamp in Unix milliseconds.
    #[ts(type = "number")]
    pub received_at_ms: i64,
}

/// Kind of a collapsed channel membership run.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MembershipKind {
    /// One or more users joined.
    Joined,
    /// One or more users left the channel with PART.
    Parted,
    /// One or more users disconnected from IRC.
    Quit,
}

/// Consecutive membership changes collapsed by the engine.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct MembershipProjection {
    /// Stable timeline identity.
    pub id: MessageId,
    /// Membership transition shared by every nick in this run.
    pub kind: MembershipKind,
    /// Nicks in arrival order.
    pub nicks: Vec<String>,
    #[ts(type = "number | null")]
    /// Timestamp on the newest event in the run, when supplied by the server.
    pub server_time_ms: Option<i64>,
    #[ts(type = "number")]
    /// Local receipt timestamp of the newest event in the run.
    pub received_at_ms: i64,
}

/// Exclusive presentation group for one channel member.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum MemberGroup {
    Operators,
    Voiced,
    Online,
    Away,
    Bots,
}

/// One row in a bounded channel-member window.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[allow(missing_docs)]
pub struct MemberProjection {
    #[ts(type = "\"operators\" | \"voiced\" | \"online\" | \"away\" | \"bots\"")]
    pub group: MemberGroup,
    pub nick: String,
    pub mode_symbol: Option<char>,
    pub away: bool,
    pub bot: bool,
    pub account: Option<String>,
    #[ts(type = "number")]
    pub nick_color_index: u32,
    pub is_you: bool,
}

/// Initial UI identity and revision state.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct Hello {
    /// Content-derived application build identifier.
    pub build_id: String,
    /// Identity of this UI client.
    pub client_id: String,
    /// Last revision observed by the UI, when any.
    #[ts(type = "number | null")]
    pub last_revision: Option<u64>,
    /// UI shell initiating the connection.
    pub shell: ShellKind,
}

/// UI shell variants supported by the engine protocol.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    /// Browser shell.
    Web,
}

/// One engine request with its correlation identifier.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct EngineRequestEnvelope {
    /// Request correlation identifier.
    pub id: String,
    /// Requested operation.
    pub request: EngineRequest,
}

/// Engine requests implemented by the current vertical slice.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineRequest {
    /// Round-trip diagnostic proving the worker boundary.
    Diagnostic {
        /// Opaque non-secret diagnostic text.
        message: String,
    },
    /// Build a papo client and begin draining its events immediately.
    Connect {
        /// Display label for the network.
        label: String,
        /// WebSocket endpoint accepted by papo.
        endpoint: String,
        /// Initial nickname.
        nickname: String,
        /// One-shot SASL credentials.
        sasl: SaslCredentials,
        /// Channels joined after registration.
        autojoin: Vec<String>,
        /// Explicit permission for local `ws://` test endpoints.
        allow_insecure: bool,
    },
    /// Consume one OAuth bearer token and connect the hosted network.
    ConnectHosted {
        /// Display label for the network.
        label: String,
        /// Secure WebSocket endpoint accepted by papo.
        endpoint: String,
        /// Initial nickname, replaced by the authenticated account when applicable.
        nickname: String,
        /// One-shot bearer token moved into papo's redacting secret store.
        #[ts(type = "string")]
        oauth_token: RedactedSecret,
        /// Channels joined after registration.
        autojoin: Vec<String>,
    },
    /// Clear a hosted token at its known expiry and ask every UI tab to authorize again.
    ExpireHostedAuthentication {
        /// Hosted network whose token expired.
        network_id: NetworkId,
    },
    /// Deliberately stop one network connection.
    Disconnect {
        /// Network to stop.
        network_id: NetworkId,
        /// Optional IRC quit reason.
        reason: Option<String>,
    },
    /// Send plain chat text to a channel or direct buffer.
    SendMessage {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Message body.
        text: String,
    },
    /// Parse and submit ordinary composer text or a supported slash command.
    SubmitInput {
        /// Buffer whose composer produced the input.
        buffer_id: BufferId,
        /// Nonempty composer contents.
        input: String,
    },
    /// Resolve composer completion candidates from input around the caret.
    CompleteInput {
        /// Buffer whose composer owns the completion session.
        buffer_id: BufferId,
        /// Complete composer input used to resolve trigger and argument context.
        input: String,
        /// UTF-16 caret offset, matching textarea selection APIs.
        #[ts(type = "number")]
        cursor: u32,
        /// Whether Tab explicitly requested IRC-style completion at any word.
        explicit: bool,
    },
    /// Advance one buffer's marker through a committed timeline row.
    MarkRead {
        /// Buffer being viewed.
        buffer_id: BufferId,
        /// Latest fully visible committed row.
        through: MessageId,
    },
    /// Advance every conversation through its latest committed row.
    MarkAllRead,
    /// Fetch the latest history page the first time a buffer is opened.
    LoadHistory {
        /// Conversation buffer to hydrate.
        buffer_id: BufferId,
    },
    /// Project a bounded range of one channel's current members.
    #[allow(missing_docs)]
    RequestMembers {
        buffer_id: BufferId,
        view_id: String,
        #[ts(type = "number")]
        offset: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filter: Option<String>,
    },
    /// Open or focus a direct conversation without sending a message.
    OpenDirect {
        /// Network containing the member.
        network_id: NetworkId,
        /// Current nickname selected from the member projection.
        nick: String,
    },
}

/// Messages accepted from a UI client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum UiToEngine {
    /// Begin or resume a UI subscription.
    Hello(Hello),
    /// Execute an engine request.
    Request(EngineRequestEnvelope),
}

/// Events emitted to a UI client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineToUi {
    /// The worker engine accepted the UI build.
    Ready {
        /// Identity stable for the worker engine lifetime.
        engine_instance: String,
        /// Current engine projection revision.
        #[ts(type = "number")]
        revision: u64,
    },
    /// Replace the runtime slash-command specifications.
    CommandSpecsChanged {
        /// Complete current runtime registry, including later user-defined commands.
        specs: Vec<CommandSpec>,
    },
    /// UI and worker assets were built from different content.
    IncompatibleBuild {
        /// Worker build identifier.
        engine: String,
        /// UI build identifier.
        ui: String,
    },
    /// Diagnostic event produced by the test command.
    Diagnostic {
        /// `EngineRequest` that produced this event.
        command_id: String,
        /// Diagnostic text.
        message: String,
    },
    /// Stable user-facing notice emitted by an engine adapter.
    Notice {
        /// Localization key interpreted by the UI shell.
        message_key: String,
    },
    /// Ask the UI to present command help from its merged action registry.
    CommandHelpRequested {
        /// Optional command or alias selected by `/help`.
        command: Option<String>,
    },
    /// Successful command acknowledgement.
    CommandResult {
        /// Completed command identifier.
        id: String,
    },
    /// A command was rejected before it changed engine state.
    CommandRejected {
        /// Rejected command identifier.
        id: String,
        /// Stable localization key describing the rejection.
        message_key: String,
    },
    /// Typed candidates for input around the composer caret.
    #[allow(missing_docs)]
    CompletionResult {
        /// `EngineRequest` that requested these candidates.
        command_id: String,
        /// Buffer whose projection supplied the candidates.
        buffer_id: BufferId,
        /// Input echoed to discard stale worker responses.
        input: String,
        #[ts(type = "number")]
        replace_start: u32,
        #[ts(type = "number")]
        replace_end: u32,
        trigger: CompletionTrigger,
        argument_hint: Option<String>,
        /// Ordered, bounded rich candidates.
        candidates: Vec<CompletionCandidate>,
    },
    /// A network's connection projection changed.
    NetworkStateChanged {
        /// Complete current network projection.
        network: NetworkProjection,
    },
    /// Replace the ordered buffer list for a network.
    BuffersChanged {
        /// Network whose order changed.
        network_id: NetworkId,
        /// Complete ordered buffer projection.
        buffers: Vec<BufferProjection>,
    },
    /// Append one newly discovered buffer.
    BufferAdded {
        /// New buffer projection.
        buffer: BufferProjection,
    },
    /// Replace one changed buffer projection.
    BufferUpdated {
        /// Complete current buffer projection.
        buffer: BufferProjection,
    },
    /// Ask the active shell to focus a buffer selected by engine-owned input semantics.
    FocusBufferRequested {
        /// `EngineRequest` whose composer should navigate.
        command_id: String,
        /// Buffer to focus.
        buffer_id: BufferId,
    },
    /// Append received messages in established timeline order.
    MessagesAppended {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Newly visible rows.
        messages: Vec<MessageProjection>,
    },
    /// Insert a requested history page before already rendered live rows.
    MessagesPrepended {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Older rows in established timeline order.
        messages: Vec<MessageProjection>,
    },
    /// Insert or replace an engine-collapsed membership run.
    MembershipChanged {
        /// Destination channel buffer.
        buffer_id: BufferId,
        /// Complete current projection for the run.
        membership: MembershipProjection,
    },
    /// Replace a requested bounded member window and current group counts.
    #[allow(missing_docs)]
    MembersChanged {
        buffer_id: BufferId,
        view_id: String,
        #[ts(type = "number")]
        version: u64,
        #[ts(type = "number")]
        window_size: u32,
        #[ts(type = "number")]
        offset: u32,
        #[ts(type = "number")]
        total: u32,
        #[ts(type = "[number, number, number, number, number]")]
        counts: [u32; 5],
        #[ts(
            type = "Array<{ group: \"operators\" | \"voiced\" | \"online\" | \"away\" | \"bots\", nick: string, mode_symbol: string | null, away: boolean, bot: boolean, account: string | null, nick_color_index: number, is_you: boolean }>"
        )]
        members: Vec<MemberProjection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filter: Option<String>,
    },
    /// Replace an optimistic row with its `papo::Sent` confirmation.
    MessageConfirmed {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Optimistic send identity.
        local_send_id: LocalSendId,
        /// Confirmed row preserving every returned msgid.
        message: MessageProjection,
    },
    /// Mark one optimistic row as failed.
    MessageFailed {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Optimistic send identity.
        local_send_id: LocalSendId,
        /// Stable localization key, never a secret-bearing error string.
        message_key: String,
    },
    /// Update unread and mention counters.
    UnreadChanged {
        /// Buffer whose counters changed.
        buffer_id: BufferId,
        /// Current unread count.
        #[ts(type = "number")]
        unread: u64,
        /// Current mention count.
        #[ts(type = "number")]
        mentions: u64,
    },
    /// The effective local or server-backed read position advanced.
    ReadMarkerMoved {
        /// Buffer whose marker moved.
        buffer_id: BufferId,
        /// Latest retained committed row covered by the marker.
        through: Option<MessageId>,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        BufferId, CompletionCandidate, EngineRequest, EngineToUi, Hello, MemberGroup,
        MemberProjection, SaslCredentials, ShellKind, UiToEngine,
    };

    #[test]
    fn hello_json_is_stable() {
        let message = UiToEngine::Hello(Hello {
            build_id: "build-1".into(),
            client_id: "tab-1".into(),
            last_revision: Some(7),
            shell: ShellKind::Web,
        });

        assert_eq!(
            serde_json::to_string(&message).expect("hello serializes"),
            r#"{"type":"hello","payload":{"build_id":"build-1","client_id":"tab-1","last_revision":7,"shell":"web"}}"#
        );
    }

    #[test]
    fn engine_event_round_trips() {
        let event = EngineToUi::MembersChanged {
            buffer_id: BufferId(2),
            view_id: "pane-1".into(),
            version: 3,
            window_size: 256,
            offset: 1,
            total: 4,
            counts: [1, 0, 2, 0, 1],
            members: vec![MemberProjection {
                group: MemberGroup::Online,
                nick: "mel".into(),
                mode_symbol: None,
                away: false,
                bot: false,
                account: Some("mel".into()),
                nick_color_index: 3,
                is_you: false,
            }],
            filter: None,
        };
        let json = serde_json::to_string(&event).expect("event serializes");

        assert_eq!(
            serde_json::from_str::<EngineToUi>(&json).expect("event deserializes"),
            event
        );
    }

    #[test]
    fn completion_candidates_keep_their_presentation_facts() {
        let candidate = CompletionCandidate::Person {
            nick: "ana".into(),
            nick_color_index: 4,
            away: true,
            bot: false,
        };

        assert_eq!(
            serde_json::to_value(candidate).expect("candidate serializes"),
            serde_json::json!({
                "type": "person",
                "nick": "ana",
                "nick_color_index": 4,
                "away": true,
                "bot": false,
            })
        );
    }

    #[test]
    fn request_debug_redacts_connection_secrets_without_changing_json() {
        let request = EngineRequest::ConnectHosted {
            label: "weblounge".into(),
            endpoint: "wss://beta.weblounge.org/socket".into(),
            nickname: "*".into(),
            oauth_token: "unique-oauth-token".into(),
            autojoin: vec!["#lounge".into()],
        };
        let credentials = SaslCredentials {
            account: "luiz".into(),
            password: "unique-sasl-password".into(),
        };

        assert!(!format!("{request:?}").contains("unique-oauth-token"));
        assert!(!format!("{credentials:?}").contains("unique-sasl-password"));
        assert_eq!(
            serde_json::to_value(request).expect("request serializes"),
            serde_json::json!({
                "type": "connect_hosted",
                "label": "weblounge",
                "endpoint": "wss://beta.weblounge.org/socket",
                "nickname": "*",
                "oauth_token": "unique-oauth-token",
                "autojoin": ["#lounge"],
            })
        );
    }
}
