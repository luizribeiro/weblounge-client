use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// SASL PLAIN credentials used only while constructing a papo client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct SaslCredentials {
    /// SASL account name.
    pub account: String,
    /// SASL password; never included in projections or errors.
    pub password: String,
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
    /// Messages after the local read position.
    #[ts(type = "number")]
    pub unread: u64,
    /// Unread messages mentioning the current nick.
    #[ts(type = "number")]
    pub mentions: u64,
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

/// UI projection of one chat message.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct MessageProjection {
    /// Stable timeline identity.
    pub id: MessageId,
    /// Display nick supplied by papo.
    pub author: String,
    /// Plain chat text.
    pub text: String,
    /// Authorship relative to this client.
    pub authorship: MessageAuthorship,
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

/// One command with its correlation identifier.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct CommandEnvelope {
    /// Command correlation identifier.
    pub id: String,
    /// Requested operation.
    pub command: Command,
}

/// Commands implemented by the current vertical slice.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
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
}

/// Messages accepted from a UI client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum UiToEngine {
    /// Begin or resume a UI subscription.
    Hello(Hello),
    /// Execute a command.
    Command(CommandEnvelope),
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
    /// UI and worker assets were built from different content.
    IncompatibleBuild {
        /// Worker build identifier.
        engine: String,
        /// UI build identifier.
        ui: String,
    },
    /// Diagnostic event produced by the test command.
    Diagnostic {
        /// Command that produced this event.
        command_id: String,
        /// Diagnostic text.
        message: String,
    },
    /// Stable user-facing notice emitted by an engine adapter.
    Notice {
        /// Localization key interpreted by the UI shell.
        message_key: String,
    },
    /// Successful command acknowledgement.
    CommandResult {
        /// Completed command identifier.
        id: String,
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
    /// Append received messages in established timeline order.
    MessagesAppended {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Newly visible rows.
        messages: Vec<MessageProjection>,
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
}

#[cfg(test)]
mod tests {
    use super::{EngineToUi, Hello, ShellKind, UiToEngine};

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
        let event = EngineToUi::Ready {
            engine_instance: "engine-1".into(),
            revision: 0,
        };
        let json = serde_json::to_string(&event).expect("event serializes");

        assert_eq!(
            serde_json::from_str::<EngineToUi>(&json).expect("event deserializes"),
            event
        );
    }
}
