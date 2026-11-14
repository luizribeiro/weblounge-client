use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

use crate::commands::CommandSpec;
use crate::settings::{SettingChange, Settings};

macro_rules! engine_message_keys {
    ($($variant:ident => $key:literal),+ $(,)?) => {
        /// Localization keys that the engine may emit to the UI.
        #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
        #[allow(missing_docs)]
        pub enum EngineMessageKey {
            $(
                #[serde(rename = $key)]
                #[ts(rename = $key)]
                $variant,
            )+
        }

        impl EngineMessageKey {
            /// Every engine-owned localization key, in stable generated order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// Returns the serialized localization key.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $key),+
                }
            }
        }
    };
}

engine_message_keys! {
    ComposerEmptyInput => "composer.empty_input",
    ComposerMissingArgument => "composer.missing_argument",
    ComposerUnexpectedArgument => "composer.unexpected_argument",
    ComposerUnknownCommand => "composer.unknown_command",
    BouncerNetworkLimitReached => "engine.bouncer_network_limit_reached",
    BufferNotSendable => "engine.buffer_not_sendable",
    CachedTargetGone => "engine.cached_target_gone",
    ChannelLimitReached => "engine.channel_limit_reached",
    ChannelNotFound => "engine.channel_not_found",
    ChannelRecreated => "engine.channel_recreated",
    ChannelRejoinRequired => "engine.channel_rejoin_required",
    ChannelRequired => "engine.channel_required",
    CommandRefused => "engine.command_refused",
    ConnectionFailed => "engine.connection_failed",
    DirectIdentityMismatch => "engine.direct_identity_mismatch",
    DirectMonitorFull => "engine.direct_monitor_full",
    DirectPresenceUnavailable => "engine.direct_presence_unavailable",
    DirectTargetGone => "engine.direct_target_gone",
    DirectUnavailable => "engine.direct_unavailable",
    HostedAuthFailed => "engine.hosted_auth_failed",
    InvalidEndpoint => "engine.invalid_endpoint",
    JoinBanned => "engine.join_banned",
    JoinRefused => "engine.join_refused",
    MarkReadFailed => "engine.mark_read_failed",
    MetadataLimitReached => "engine.metadata_limit_reached",
    NetworkAlreadyConnected => "engine.network_already_connected",
    NetworkNotFound => "engine.network_not_found",
    NotInChannel => "engine.not_in_channel",
    Offline => "engine.offline",
    ReadMarkerInvalid => "engine.read_marker_invalid",
    SendFailed => "engine.send_failed",
    StateInconsistent => "engine.state_inconsistent",
    StorageUnavailable => "engine.storage_unavailable",
    UnsupportedConversation => "engine.unsupported_conversation",
}

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

/// Relay route material needed by the IRC home to encrypt Web Push messages.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct PushRoute {
    /// Stable relay route identity, separate from its delivery URL.
    pub route_id: String,
    /// Relay route URL registered with the IRC home.
    pub endpoint: String,
    /// URL-safe Base64 P-256 public key.
    pub p256dh: String,
    /// URL-safe Base64 authentication secret.
    #[ts(type = "string")]
    pub auth: RedactedSecret,
}

/// Relay credentials persisted by the engine and used only by the page-side push client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct PushDeviceCredentials {
    /// Relay origin that owns this device.
    pub relay: String,
    /// Opaque relay device identifier.
    pub device_id: String,
    /// Bearer secret for device and route operations.
    #[ts(type = "string")]
    pub secret: RedactedSecret,
}

/// The user's consent to send the connection's password to a file host on another site.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct UploadApproval {
    /// File host authority (`host` or `host:port`) the user was asked about.
    pub host: String,
    /// Whether this device remembers the approval for later uploads.
    pub remember: bool,
}

/// How the UI authorizes one upload to the network's file host.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UploadAuthorization {
    /// Send this complete `Authorization` header value.
    Basic {
        /// The `Basic …` header value built from the connection's SASL PLAIN credential.
        #[ts(type = "string")]
        header: RedactedSecret,
    },
    /// Send a fresh bearer token from the deployment's session-token endpoint.
    HostBearer,
}

/// Where and how the UI may upload an image for one network.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UploadResolution {
    /// The network advertises no file host.
    Unavailable,
    /// The network is not connected.
    Offline,
    /// The file host is on another site than the hosted login's, which never sends it a token.
    OtherSite,
    /// The file host is on another site; ask before sending the password.
    ApprovalRequired {
        /// File host authority to name in the question.
        host: String,
    },
    /// Upload to this endpoint with this authorization.
    Ready {
        /// The advertised HTTPS upload URL.
        endpoint: String,
        /// Authorization for this upload only.
        authorization: UploadAuthorization,
    },
}

/// Why a connected network cannot register Web Push.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PushUnsupportedReason {
    /// The IRC home did not negotiate a Web Push capability.
    NoWebPush,
    /// The connection has no authenticated account.
    NoAccount,
    /// The IRC home did not advertise a VAPID key.
    NoVapid,
}

/// Stable classification of a failed IRC Web Push request.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PushFailure {
    /// The IRC home rejected this account or connection for Web Push.
    WebPushForbidden,
    /// The IRC home's subscription limit was reached.
    RegistrationLimit,
    /// The client could not start another bounded IRC request.
    RequestLimit,
    /// The endpoint or encryption keys were invalid.
    InvalidParameters,
    /// The IRC home reported an internal failure.
    Internal,
    /// The request could not complete on the current connection.
    Connection,
    /// A future or server-specific refusal was returned.
    Other,
}

/// Current Web Push registration outcome for one network.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PushState {
    /// The home accepted the relay route and can deliver notifications.
    Registered {
        /// Active relay route.
        route_id: String,
    },
    /// The route exists, but the account must enable persistence before delivery works.
    RegisteredButNoDelivery {
        /// Active relay route.
        route_id: String,
    },
    /// This connection cannot register Web Push.
    Unsupported {
        /// Missing prerequisite.
        reason: PushUnsupportedReason,
    },
    /// The home or connection refused registration.
    Failed {
        /// Relay route whose registration or removal failed.
        route_id: String,
        /// Stable failure classification.
        reason: PushFailure,
    },
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
        /// Optional hosted Web Push relay configuration.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        push: Option<Box<PushDeploymentConfig>>,
        /// Optional hosted client remediation controls.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        client: Option<Box<ClientDeploymentConfig>>,
    },
}

/// Hosted client remediation controls supplied by the deployment.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct ClientDeploymentConfig {
    /// Oldest allowed build timestamp, encoded as decimal Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_build: Option<String>,
    /// Opaque generation that clears the cached web shell when changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_token: Option<String>,
}

/// Public Web Push relay configuration supplied by the deployment.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct PushDeploymentConfig {
    /// HTTPS relay origin used by the page-side client.
    pub relay: String,
    /// URL-safe Base64 uncompressed P-256 public key used for browser subscriptions.
    pub relay_vapid: String,
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
    /// Credentialed concierge endpoint used before each hosted connection attempt.
    pub session_token_endpoint: String,
}

/// Why a network is intentionally offline.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum OfflineReason {
    /// The user or authentication owner stopped the connection.
    Requested,
    /// The browser reports that the device has no network path.
    DeviceOffline,
}

/// Why papo stopped retrying a failed connection.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionFailureReason {
    /// Authentication was rejected.
    Authentication,
    /// The transport could not be established or recovered.
    Transport,
    /// An established connection ended permanently.
    Protocol,
}

/// Authoritative connection lifecycle projected by the engine.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NetworkConnectionState {
    /// The transport is being opened.
    Connecting,
    /// IRC capabilities, authentication, or registration are in progress.
    Registering,
    /// Registration completed.
    Online,
    /// The connection is waiting for papo's reconnect attempt.
    Reconnecting {
        /// One-based papo connection attempt.
        #[ts(type = "number")]
        attempt: u32,
        /// Wall-clock deadline for the scheduled retry.
        #[ts(type = "number")]
        next_retry_at_ms: i64,
    },
    /// No connection attempt is scheduled.
    Offline {
        /// Stable offline classification.
        reason: OfflineReason,
    },
    /// A permanent error needs user action.
    Failed {
        /// Stable failure classification.
        reason: ConnectionFailureReason,
        /// Localization key for the human explanation.
        message_key: EngineMessageKey,
    },
}

/// Visual severity for one transient app notice.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NoticeTone {
    /// Informational feedback that does not indicate a failed operation.
    Neutral,
    /// An operation failed and may need user attention.
    Error,
}

/// Action dispatched by a transient notice through the UI action registry.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct NoticeAction {
    /// Localization key for the action label.
    pub label: String,
    /// Stable action-registry identifier.
    pub run: String,
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
    /// Origin of the file host the network advertises, whose images display inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filehost_origin: Option<String>,
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

/// Whether one buffer is currently resolving server history into its timeline.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BufferSyncState {
    /// No history request is active and the buffer has not completed its initial load.
    Pending,
    /// Initial history or reconnect catch-up is in flight.
    Syncing,
    /// The latest requested history has been applied.
    Synced,
}

/// Which edge of a conversation history request should be fetched.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryDirection {
    /// Ensure the current live edge is known.
    Latest,
    /// Fetch the next page before the retained oldest cursor.
    Older,
}

/// Whether a channel buffer currently represents an active membership.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ChannelStatus {
    /// The current user is joined and may send.
    Joined,
    /// The current user was kicked and must rejoin before sending.
    Kicked,
}

/// Presence the network reports for a direct-message peer through `MONITOR`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PeerPresence {
    /// The peer is connected and not marked away.
    Online,
    /// The peer is connected and marked away.
    Away,
}

/// Identity state for a direct-message peer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DirectIdentityState {
    /// No durable account identity is currently available.
    Unverified,
    /// The current peer matches the stored account pin.
    Verified,
    /// The nick is now held by a different account.
    DifferentAccount,
    /// The current peer cannot be proven to match the stored pin.
    CannotVerify,
    /// The user deferred a different-account decision.
    DeferredDifferentAccount,
    /// The user deferred an unverifiable-peer decision.
    DeferredCannotVerify,
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
    /// Current per-buffer history synchronization state.
    pub sync_state: BufferSyncState,
    /// Current membership state for a channel buffer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub channel_status: Option<ChannelStatus>,
    /// Whether the configured conversation remains available after reconciliation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub available: Option<bool>,
    /// Current channel or nick display name.
    pub title: String,
    /// Stable theme palette index for a direct-message peer.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nick_color_index: Option<u32>,
    /// Current verification state for a direct-message peer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub direct_identity: Option<DirectIdentityState>,
    /// Network-reported presence of a direct-message peer; absent when the network reports none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub peer_presence: Option<PeerPresence>,
    /// Session draft identity derived from the network and durable conversation identity.
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
    /// Effective read marker as Unix milliseconds, when it is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub read_at_ms: Option<i64>,
    /// Latest timeline row for conversation-list previews.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_message: Option<MessageProjection>,
    /// Latest conversation activity in Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_activity_ms: Option<i64>,
    /// Already-formatted bounded conversation-list preview.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<String>,
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
        bot: Option<bool>,
    },
    Channel {
        name: String,
    },
}

/// Semantic presentation of a chat message.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// A regular chat line.
    Text,
    /// A CTCP ACTION displayed as `/me` prose.
    Action,
    /// An IRC NOTICE displayed as a typed notice line.
    IrcNotice(NoticeSource),
    /// A local row generated from current engine state.
    Notice(NoticeKind),
}

/// Identity class that determines an IRC notice's presentation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum NoticeSource {
    /// An ordinary IRC user.
    User,
    /// A service or operator delivering to a server-wide audience.
    Service,
    /// The IRC server itself.
    Server,
}

/// Semantic presentation of a local timeline notice.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NoticeKind {
    /// A cached channel topic and the server facts describing it.
    Topic {
        /// Nick reported as the topic setter, when known.
        setter: Option<String>,
        /// Server timestamp in Unix milliseconds, when known.
        #[ts(type = "number | null")]
        set_at: Option<i64>,
    },
    /// A neutral informational event without topic semantics.
    Info,
}

/// One user represented in a reaction summary.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct ReactionActorProjection {
    /// Display nickname supplied by papo.
    pub nick: String,
    /// Whether this actor is the current account.
    pub mine: bool,
}

/// Aggregated reaction facts for one exact reaction value.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct ReactionProjection {
    /// Exact reaction text received from IRC.
    pub text: String,
    /// Current actors in deterministic identity order.
    pub actors: Vec<ReactionActorProjection>,
    /// Whether the current account is among the actors.
    pub mine: bool,
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
    /// Semantic presentation of this timeline row.
    pub kind: MessageKind,
    /// Whether IRC metadata identifies the author as a bot.
    pub bot: Option<bool>,
    /// Authorship relative to this client.
    pub authorship: MessageAuthorship,
    /// Stable palette index derived with the network's IRC name rules.
    #[ts(type = "number")]
    pub nick_color_index: u32,
    /// Whether this row matches the user's highlight rules.
    pub highlighted: bool,
    /// Whether this direct-message row came from a sender whose identity was not verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unverified_sender: Option<bool>,
    /// Reactions ordered by when each reaction value first appeared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reactions: Option<Vec<ReactionProjection>>,
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

/// One channel membership row retained in the timeline.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MembershipProjection {
    /// Consecutive ordinary membership changes collapsed by the engine.
    Change {
        /// Stable timeline identity.
        id: MessageId,
        /// Membership transition shared by every nick in this run.
        kind: MembershipKind,
        /// Nicks in arrival order.
        nicks: Vec<String>,
        #[ts(type = "number | null")]
        /// Timestamp on the newest event in the run, when supplied by the server.
        server_time_ms: Option<i64>,
        #[ts(type = "number")]
        /// Local receipt timestamp of the newest event in the run.
        received_at_ms: i64,
    },
    /// The current user was removed and can explicitly rejoin.
    Kicked {
        /// Stable timeline identity.
        id: MessageId,
        /// Nick or server that removed the current user.
        actor: String,
        /// Optional server-supplied reason.
        reason: Option<String>,
        #[ts(type = "number | null")]
        /// Timestamp supplied by the server, when present.
        server_time_ms: Option<i64>,
        #[ts(type = "number")]
        /// Local receipt timestamp.
        received_at_ms: i64,
    },
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

/// Account fact retained from papo without guessing when the server is silent.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum AccountProjection {
    Unknown,
    LoggedOut,
    LoggedIn { name: String },
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
    pub bot: Option<bool>,
    pub account: AccountProjection,
    #[ts(type = "number")]
    pub nick_color_index: u32,
    pub is_you: bool,
}

/// One user currently composing in a conversation.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct TypingProjection {
    /// Current nickname.
    pub nick: String,
    /// Stable theme palette index for the nickname.
    #[ts(type = "number")]
    pub nick_color_index: u32,
    /// Whether input has paused while the draft remains nonempty.
    pub paused: bool,
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
    /// Check that the worker host and engine event loop are responsive.
    Ping,
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
    /// Restore a hosted profile and its cached chat list before a token is available.
    PrepareHosted {
        /// Display label for the network.
        label: String,
        /// Secure WebSocket endpoint accepted by papo.
        endpoint: String,
        /// Initial nickname, replaced by the authenticated account when applicable.
        nickname: String,
        /// Channels joined after registration.
        autojoin: Vec<String>,
    },
    /// Rebuild a hosted connection with a freshly acquired one-shot token.
    ReconnectHosted {
        /// Hosted network to reconnect.
        network_id: NetworkId,
        /// One-shot bearer token moved into papo's redacting secret store.
        #[ts(type = "string")]
        oauth_token: RedactedSecret,
    },
    /// Stop a hosted reconnect when no page can acquire a fresh token.
    HostedTokenUnavailable {
        /// Hosted network waiting for a page-owned token.
        network_id: NetworkId,
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
    /// Retry a network immediately using papo's reconnect machinery.
    Reconnect {
        /// Network to reconnect.
        network_id: NetworkId,
    },
    /// Reflect whether the browser currently has a network path.
    SetDeviceOnline {
        /// Network whose lifecycle projection should be updated.
        network_id: NetworkId,
        /// Browser connectivity hint; papo remains authoritative for the socket.
        online: bool,
    },
    /// Start a pending chat-list snapshot write before the page can be suspended.
    /// Record whether the browser has installed a newer app shell for the next launch.
    SetUpdateReady {
        /// Whether a waiting service worker is ready to activate after this session closes.
        ready: bool,
    },
    /// Read this device's settings.
    LoadSettings,
    /// Validate, persist and broadcast one settings change.
    ChangeSetting {
        /// The setting and its new value.
        change: SettingChange,
    },
    /// Read whether this device dismissed the notification permission prompt.
    LoadNotificationPromptDismissal,
    /// Permanently dismiss the notification permission prompt on this device.
    DismissNotificationPrompt,
    /// Read this relay's device credentials from durable engine storage.
    LoadPushDevice {
        /// Relay origin used as the durable namespace.
        relay: String,
    },
    /// Resolve the file host endpoint and authorization for one image upload.
    ResolveUpload {
        /// Network whose advertised file host receives the upload.
        network_id: NetworkId,
        /// The user's answer to an earlier approval question, if any.
        approval: Option<UploadApproval>,
    },
    /// Forget every remembered upload approval on this device.
    ForgetUploadApprovals,
    /// Read service-worker message records into one running network.
    LoadPushedMessages {
        /// Network whose matching cached messages should become visible.
        network_id: NetworkId,
    },
    /// Persist relay device credentials in durable engine storage.
    StorePushDevice {
        /// Complete credentials returned by the relay.
        credentials: PushDeviceCredentials,
    },
    /// Forget relay device credentials after authorization fails or sign-out completes.
    ClearPushDevice {
        /// Relay origin used as the durable namespace.
        relay: String,
    },
    /// Converge one IRC home's relay registration after a connection succeeds.
    EnsurePush {
        /// Network whose home should receive the route.
        network_id: NetworkId,
        /// Relay route and encryption keys created by the platform.
        route: PushRoute,
        /// Dead relay endpoints the home must forget before registration.
        unregister: Vec<String>,
    },
    /// Remove one exact relay route from an IRC home.
    UnregisterPushRoute {
        /// Network whose home owns the registration.
        network_id: NetworkId,
        /// Relay route identity used to protect the current registration.
        route_id: String,
        /// Exact endpoint previously registered with the home.
        endpoint: String,
    },
    /// Send plain chat text to a channel or direct buffer.
    SendMessage {
        /// Destination buffer.
        buffer_id: BufferId,
        /// Message body.
        text: String,
    },
    /// Retry one retained failed optimistic send.
    RetryMessage {
        /// Buffer containing the failed row.
        buffer_id: BufferId,
        /// Stable local send identity to retry in place.
        local_send_id: LocalSendId,
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
    /// Fetch one history edge for a conversation.
    LoadHistory {
        /// Conversation buffer to hydrate or page.
        buffer_id: BufferId,
        /// History edge requested by the UI interaction.
        direction: HistoryDirection,
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
    /// Replace a direct thread's pin with the identity currently holding its nick.
    TrustDirectIdentity {
        /// Direct-message buffer whose current peer should be trusted.
        buffer_id: BufferId,
    },
    /// Keep a mismatched direct thread read-only without making a trust decision.
    DeferDirectIdentity {
        /// Direct-message buffer whose decision should be deferred.
        buffer_id: BufferId,
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
    /// Typed worker-liveness acknowledgement.
    Pong {
        /// Correlation identifier from the ping envelope.
        id: String,
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
    /// Ask the worker host adapter for a fresh token before reconnecting.
    HostedTokenRequired {
        /// Hosted network waiting for a new connection attempt.
        network_id: NetworkId,
    },
    /// Result of reading relay device credentials from durable engine storage.
    PushDeviceLoaded {
        /// Request correlation identifier.
        command_id: String,
        /// Stored credentials, or none before this device is registered.
        credentials: Option<PushDeviceCredentials>,
    },
    /// Result of resolving an upload, sent only to the requesting UI.
    UploadResolved {
        /// Request correlation identifier.
        command_id: String,
        /// Endpoint and authorization, or why the upload cannot proceed.
        resolution: UploadResolution,
    },
    /// Result of reading this device's settings.
    SettingsLoaded {
        /// Request correlation identifier.
        command_id: String,
        /// Every resolved setting.
        settings: Settings,
    },
    /// A settings change was persisted; sent to every attached UI.
    SettingsChanged {
        /// Every resolved setting after the change.
        settings: Settings,
    },
    /// Result of reading the device-local notification prompt preference.
    NotificationPromptDismissalLoaded {
        /// Request correlation identifier.
        command_id: String,
        /// Whether this device has dismissed the prompt.
        dismissed: bool,
    },
    /// A network's Web Push registration outcome changed.
    PushStateChanged {
        /// Network whose registration changed.
        network_id: NetworkId,
        /// Complete current outcome.
        state: PushState,
    },
    /// The platform must create or replace a relay route pinned to this home.
    PushRouteRequired {
        /// Network whose route must be replaced.
        network_id: NetworkId,
        /// Newly advertised home VAPID public key.
        vapid: String,
        /// Relay route that the platform should discard after a VAPID change.
        previous_route_id: Option<String>,
    },
    /// Stable user-facing notice emitted by an engine adapter.
    Notice {
        /// Localization key interpreted by the UI shell.
        key: String,
        /// Named localization substitutions, never preformatted display text.
        values: BTreeMap<String, String>,
        /// Visual severity for the shared toast surface.
        tone: NoticeTone,
        /// Optional action dispatched by the UI registry.
        action: Option<NoticeAction>,
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
        message_key: EngineMessageKey,
        /// Typed interpolation values for the localized rejection.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        values: Option<BTreeMap<String, String>>,
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
        /// Engine-owned text placed before the selected candidate label.
        replacement_prefix: String,
        /// Engine-owned text placed after the selected candidate label.
        replacement_suffix: String,
        /// Ordered, bounded rich candidates.
        candidates: Vec<CompletionCandidate>,
    },
    /// Replace one buffer's complete transient typing projection.
    TypingChanged {
        /// Conversation buffer whose typers changed.
        buffer_id: BufferId,
        /// Current bounded typers in start order.
        typers: Vec<TypingProjection>,
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
    /// Reveal that service-worker messages are available before network history.
    PushedMessagesLoaded {
        /// Network whose cached messages are now part of its timelines.
        network_id: NetworkId,
    },
    /// Report that initial recent-direct discovery cannot add more buffers.
    RecentDirectsReady {
        /// Network whose recent direct targets have been discovered.
        network_id: NetworkId,
    },
    /// Append one newly discovered buffer.
    BufferAdded {
        /// New buffer projection.
        buffer: BufferProjection,
    },
    /// Remove one channel buffer after the server confirms this user's departure.
    BufferRemoved {
        /// Buffer that no longer represents a joined channel.
        buffer_id: BufferId,
    },
    /// Replace one changed buffer projection.
    BufferUpdated {
        /// Complete current buffer projection.
        buffer: BufferProjection,
    },
    /// A live peer message that should alert: a direct message or a mention, unread on arrival.
    NotifiableMessageReceived {
        /// Complete current projection of the message's buffer.
        buffer: BufferProjection,
        /// The message that arrived.
        message: MessageProjection,
    },
    /// Move a UI-owned draft when a direct message gains a more durable identity.
    DraftKeyChanged {
        /// Previous storage key to consume.
        previous: String,
        /// New storage key to retain.
        current: String,
    },
    /// Ask the active shell to focus a buffer selected by engine-owned input semantics.
    FocusBufferRequested {
        /// `EngineRequest` whose composer should navigate.
        command_id: String,
        /// Buffer to focus.
        buffer_id: BufferId,
    },
    /// Atomically reconcile one buffer's engine-ordered timeline.
    TimelineChanged {
        /// Buffer whose timeline changed.
        buffer_id: BufferId,
        /// Whether this patch replaces the receiver's complete mirror.
        reset: bool,
        /// New or changed items in engine order.
        upserted: Vec<crate::timeline::TimelineItem>,
        /// Items no longer present in the projection.
        removed: Vec<MessageId>,
    },
    /// Report one buffer's older-history request and terminal boundary.
    HistoryStateChanged {
        /// Conversation whose history state changed.
        buffer_id: BufferId,
        /// Whether a page request is currently in flight.
        loading: bool,
        /// Whether the server reported that no older page exists.
        at_start: bool,
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
        members: Vec<MemberProjection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        filter: Option<String>,
    },
    /// Mark one optimistic row as failed.
    MessageFailed {
        /// Network that owns the failed target.
        network_id: NetworkId,
        /// Destination buffer.
        buffer_id: BufferId,
        /// Current channel or direct-message target label.
        target: String,
        /// Optimistic send identity.
        local_send_id: LocalSendId,
        /// Stable localization key, never a secret-bearing error string.
        message_key: EngineMessageKey,
    },
}

impl EngineToUi {
    pub(crate) fn notice(key: EngineMessageKey) -> Self {
        Self::Notice {
            key: key.as_str().into(),
            values: BTreeMap::new(),
            tone: NoticeTone::Neutral,
            action: None,
        }
    }

    pub(crate) fn error_notice(key: EngineMessageKey) -> Self {
        Self::Notice {
            key: key.as_str().into(),
            values: BTreeMap::new(),
            tone: NoticeTone::Error,
            action: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AccountProjection, BufferId, CompletionCandidate, EngineRequest, EngineRequestEnvelope,
        EngineToUi, Hello, MemberGroup, MemberProjection, SaslCredentials, ShellKind, UiToEngine,
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
    fn ping_and_pong_are_typed_liveness_messages() {
        let request = EngineRequestEnvelope {
            id: "heartbeat-1".into(),
            request: EngineRequest::Ping,
        };
        assert_eq!(
            serde_json::to_string(&request).expect("ping serializes"),
            r#"{"id":"heartbeat-1","request":{"type":"ping"}}"#
        );
        assert_eq!(
            serde_json::to_string(&EngineToUi::Pong {
                id: "heartbeat-1".into(),
            })
            .expect("pong serializes"),
            r#"{"type":"pong","id":"heartbeat-1"}"#
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
                bot: Some(false),
                account: AccountProjection::LoggedIn { name: "mel".into() },
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
            bot: Some(false),
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

        let push = EngineRequest::EnsurePush {
            network_id: crate::NetworkId(7),
            route: crate::PushRoute {
                route_id: "route-1".into(),
                endpoint: "https://push.example.test/route-1".into(),
                p256dh: "public-key".into(),
                auth: "unique-push-auth".into(),
            },
            unregister: vec!["https://push.example.test/route-old".into()],
        };
        assert!(!format!("{push:?}").contains("unique-push-auth"));
        assert_eq!(
            serde_json::to_value(push).expect("push request serializes"),
            serde_json::json!({
                "type": "ensure_push",
                "network_id": 7,
                "route": {
                    "route_id": "route-1",
                    "endpoint": "https://push.example.test/route-1",
                    "p256dh": "public-key",
                    "auth": "unique-push-auth",
                },
                "unregister": ["https://push.example.test/route-old"],
            })
        );

        assert_eq!(
            serde_json::to_value(EngineRequest::UnregisterPushRoute {
                network_id: crate::NetworkId(7),
                route_id: "route-old".into(),
                endpoint: "https://push.example.test/route-old".into(),
            })
            .expect("exact push unregistration serializes"),
            serde_json::json!({
                "type": "unregister_push_route",
                "network_id": 7,
                "route_id": "route-old",
                "endpoint": "https://push.example.test/route-old",
            })
        );

        let device = EngineRequest::StorePushDevice {
            credentials: crate::PushDeviceCredentials {
                relay: "https://push.example.test".into(),
                device_id: "device-1".into(),
                secret: "unique-device-secret".into(),
            },
        };
        assert!(!format!("{device:?}").contains("unique-device-secret"));
        assert_eq!(
            serde_json::to_value(device).expect("device request serializes"),
            serde_json::json!({
                "type": "store_push_device",
                "credentials": {
                    "relay": "https://push.example.test",
                    "device_id": "device-1",
                    "secret": "unique-device-secret",
                },
            })
        );
    }
}
