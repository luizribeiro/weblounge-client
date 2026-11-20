//! Notification text, grouping and routing for one parsed push event.

use std::fmt::Write;

use papo_proto::{Isupport, Prefix};
use serde::Serialize;

use crate::{ChatPayload, PushEvent};

/// The local identity a push route delivers to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteMeta {
    /// The network's label, which names it in routes and tags.
    pub network_label: String,
    /// The user's nickname on that network.
    pub nickname: String,
}

/// What a platform does with one push.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreparedNotification {
    /// A notification to show.
    Visible(Box<VisibleNotification>),
    /// A remote read marker for one conversation; nothing to show.
    Markread {
        /// The conversation's notification tag.
        tag: String,
        /// The server's marker reference.
        until: String,
    },
    /// A subscription or maintenance probe; nothing to show.
    Ping,
}

/// A notification ready for the platform's notification center.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleNotification {
    /// The notification title.
    pub title: String,
    /// The notification body, before any unread-count suffix.
    pub body: String,
    /// The conversation tag that groups and replaces notifications.
    pub thread_id: String,
    /// The data a tap and later cleanup read back.
    pub user_info: NotificationData,
    /// The chat message to keep for the engine, when the push carried one.
    pub pushed: Option<PushedMessage>,
}

/// Data attached to a shown notification.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationData {
    /// The same-origin buffer path a tap opens.
    pub route: String,
    /// The conversation tag, for chat messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_tag: Option<String>,
    /// The server message id, for chat messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// The `IRCv3` server time, for chat messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_time: Option<String>,
}

/// A pushed chat message in the engine's versioned cache record shape.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PushedMessage {
    schema: u32,
    /// The network's label.
    pub network_label: String,
    /// The user's nickname when the push was sent.
    pub nickname: String,
    /// The buffer path of the message's conversation.
    pub route: String,
    /// The sender's nickname.
    pub sender: String,
    /// The sender's account, when the home supplied one.
    pub account: Option<String>,
    /// The wire target.
    pub target: String,
    /// The server message id.
    pub msgid: String,
    /// The `IRCv3` server time.
    pub time: String,
    /// The display text.
    pub text: String,
    /// The kind of chat line.
    pub kind: PushedMessageKind,
}

/// The kind of a pushed chat line.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PushedMessageKind {
    /// A `PRIVMSG`.
    Message,
    /// A `NOTICE`.
    Notice,
    /// A CTCP `ACTION`.
    Action,
}

/// Localised strings the platform supplies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationStrings {
    /// The unread-count line, with a `{count}` placeholder.
    pub new_messages: String,
}

/// Turns one parsed event into what the platform should do with it.
#[must_use]
pub fn notification_for(event: PushEvent, route: &RouteMeta) -> PreparedNotification {
    match event {
        PushEvent::Message(chat) => chat_notification(chat, PushedMessageKind::Message, route),
        PushEvent::Notice(chat) => chat_notification(chat, PushedMessageKind::Notice, route),
        PushEvent::Action(chat) => chat_notification(chat, PushedMessageKind::Action, route),
        PushEvent::Invite { sender, target } => invite_notification(sender, &target, route),
        PushEvent::Markread { target, until } => PreparedNotification::Markread {
            tag: conversation_tag(&route.network_label, &target),
            until,
        },
        PushEvent::Ping => PreparedNotification::Ping,
    }
}

/// Appends the unread-count line when more than one message is waiting.
#[must_use]
pub fn counted_body(body: &str, count: u32, strings: &NotificationStrings) -> String {
    if count <= 1 {
        return body.to_owned();
    }
    let suffix = strings
        .new_messages
        .replacen("{count}", &count.to_string(), 1);
    format!("{body}\n{suffix}")
}

fn chat_notification(
    chat: ChatPayload,
    kind: PushedMessageKind,
    route: &RouteMeta,
) -> PreparedNotification {
    let direct = !is_channel_target(&chat.target);
    let buffer = if direct { &chat.sender } else { &chat.target };
    let tag = conversation_tag(&route.network_label, buffer);
    let path = buffer_path(&route.network_label, buffer, direct);
    let title = if direct {
        chat.sender.clone()
    } else {
        format!("{} in {buffer}", chat.sender)
    };
    let body = match kind {
        PushedMessageKind::Action => format!("* {} {}", chat.sender, chat.text),
        PushedMessageKind::Message | PushedMessageKind::Notice => chat.text.clone(),
    };
    PreparedNotification::Visible(Box::new(VisibleNotification {
        title,
        body,
        user_info: NotificationData {
            route: path.clone(),
            conversation_tag: Some(tag.clone()),
            message_id: Some(chat.msgid.clone()),
            message_time: Some(chat.time.clone()),
        },
        thread_id: tag,
        pushed: Some(PushedMessage {
            schema: 1,
            network_label: route.network_label.clone(),
            nickname: route.nickname.clone(),
            route: path,
            sender: chat.sender,
            account: chat.account,
            target: chat.target,
            msgid: chat.msgid,
            time: chat.time,
            text: chat.text,
            kind,
        }),
    }))
}

fn invite_notification(sender: String, channel: &str, route: &RouteMeta) -> PreparedNotification {
    PreparedNotification::Visible(Box::new(VisibleNotification {
        title: sender,
        body: format!("Invited you to {channel}"),
        thread_id: conversation_tag(&route.network_label, channel),
        user_info: NotificationData {
            route: buffer_path(&route.network_label, channel, false),
            conversation_tag: None,
            message_id: None,
            message_time: None,
        },
        pushed: None,
    }))
}

fn conversation_tag(network_label: &str, buffer: &str) -> String {
    format!("{network_label}/{}", buffer.to_lowercase())
}

fn buffer_path(network_label: &str, buffer: &str, direct: bool) -> String {
    let network = encode_uri_component(network_label);
    if direct {
        format!("/{network}/@{}", encode_uri_component(buffer))
    } else {
        let channel = buffer.strip_prefix('#').unwrap_or(buffer);
        format!("/{network}/{}", encode_uri_component(channel))
    }
}

// Push homes don't send their ISUPPORT, so channel and status prefixes are IRC's defaults.
fn is_channel_target(target: &str) -> bool {
    let isupport = Isupport::default();
    let statuses: Vec<char> = isupport.prefix().into_iter().map(Prefix::symbol).collect();
    isupport.is_channel(target.trim_start_matches(statuses.as_slice()))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
#[path = "format_tests.rs"]
mod tests;
