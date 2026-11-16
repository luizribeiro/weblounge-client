use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use ts_rs::TS;

use crate::BufferRoutePath;

const SCHEMA_VERSION: u8 = 1;

/// The version of the engine's pushed-message cache record; the engine reads only version 1.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, TS)]
#[ts(type = "1")]
pub struct PushedMessageSchema;

impl Serialize for PushedMessageSchema {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(SCHEMA_VERSION)
    }
}

impl<'de> Deserialize<'de> for PushedMessageSchema {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = u8::deserialize(deserializer)?;
        if version == SCHEMA_VERSION {
            Ok(Self)
        } else {
            Err(de::Error::custom(format!(
                "unsupported pushed-message schema {version}"
            )))
        }
    }
}

/// Which kind of chat line was pushed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PushedMessageKind {
    /// A `PRIVMSG`.
    Message,
    /// A `NOTICE`.
    Notice,
    /// A CTCP `ACTION`.
    Action,
}

/// A message the extension showed before the page had its history. It is the record the
/// service worker writes into the engine's cache, field for field, so the page stores both
/// through one function.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PushedMessage {
    /// The record version.
    pub schema: PushedMessageSchema,
    /// The network label of the route the push came through.
    pub network_label: String,
    /// The user's nickname on that network.
    pub nickname: String,
    /// The buffer the message belongs to.
    pub route: BufferRoutePath,
    /// The sender's nickname.
    pub sender: String,
    /// The sender's account, when the server tagged one.
    pub account: Option<String>,
    /// The channel or nickname the line was sent to.
    pub target: String,
    /// The IRC msgid.
    pub msgid: String,
    /// The server time, as ISO 8601.
    pub time: String,
    /// The message text.
    pub text: String,
    /// The kind of line.
    pub kind: PushedMessageKind,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{PushedMessage, PushedMessageKind, PushedMessageSchema};
    use crate::BufferRoutePath;

    fn record() -> serde_json::Value {
        json!({
            "schema": 1,
            "network_label": "Libera",
            "nickname": "weblounge",
            "route": "/Libera/@mel",
            "sender": "mel",
            "account": null,
            "target": "weblounge",
            "msgid": "Bq3k7jTr2qRwWb5A",
            "time": "2026-11-16T12:34:56.789Z",
            "text": "are you around?",
            "kind": "message",
        })
    }

    #[test]
    fn a_pushed_message_round_trips_as_the_service_workers_record() {
        let message = PushedMessage {
            schema: PushedMessageSchema,
            network_label: "Libera".to_owned(),
            nickname: "weblounge".to_owned(),
            route: BufferRoutePath::try_from("/Libera/@mel".to_owned()).expect("valid route"),
            sender: "mel".to_owned(),
            account: None,
            target: "weblounge".to_owned(),
            msgid: "Bq3k7jTr2qRwWb5A".to_owned(),
            time: "2026-11-16T12:34:56.789Z".to_owned(),
            text: "are you around?".to_owned(),
            kind: PushedMessageKind::Message,
        };

        assert_eq!(
            serde_json::to_value(&message).expect("serializes"),
            record()
        );
        assert_eq!(
            serde_json::from_value::<PushedMessage>(record()).expect("parses"),
            message
        );
    }

    #[test]
    fn an_action_with_an_account_parses() {
        let mut value = record();
        value["account"] = json!("mel-account");
        value["kind"] = json!("action");
        let message = serde_json::from_value::<PushedMessage>(value).expect("parses");
        assert_eq!(message.account.as_deref(), Some("mel-account"));
        assert_eq!(message.kind, PushedMessageKind::Action);
    }

    #[test]
    fn a_record_without_an_account_key_parses_as_no_account() {
        let mut value = record();
        value.as_object_mut().expect("object").remove("account");
        let message = serde_json::from_value::<PushedMessage>(value).expect("parses");
        assert_eq!(message.account, None);
    }

    #[test]
    fn a_record_with_an_unsafe_route_is_rejected() {
        let mut value = record();
        value["route"] = json!("https://evil.example/Libera");
        assert!(serde_json::from_value::<PushedMessage>(value).is_err());
    }

    #[test]
    fn another_schema_version_is_rejected() {
        let mut value = record();
        value["schema"] = json!(2);
        assert!(serde_json::from_value::<PushedMessage>(value).is_err());
    }
}
