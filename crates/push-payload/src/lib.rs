//! Typed parsing for one decrypted IRC Web Push payload.

use papo_proto::{Command, Ctcp, LineRef, Source};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::{JsValue, wasm_bindgen};

/// One event carried by an IRC Web Push payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushEvent {
    /// A normal chat message.
    Message(ChatPayload),
    /// An IRC notice.
    Notice(ChatPayload),
    /// A CTCP action.
    Action(ChatPayload),
    /// An invitation to a channel.
    Invite {
        /// Nickname that sent the invitation.
        sender: String,
        /// Invited channel.
        target: String,
    },
    /// A remote read-marker advance.
    Markread {
        /// Conversation whose marker moved.
        target: String,
        /// Server-provided marker reference.
        until: String,
    },
    /// A push subscription or maintenance probe.
    Ping,
}

/// Message fields needed for notification display and local persistence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ChatPayload {
    /// Sender nickname.
    pub sender: String,
    /// Sender account supplied by the IRC home, when present.
    pub account: Option<String>,
    /// Wire target, which is the current nick for a direct message.
    pub target: String,
    /// Server message identifier.
    pub msgid: String,
    /// `IRCv3` server-time value.
    pub time: String,
    /// Display text with CTCP framing removed for actions.
    pub text: String,
}

/// A decrypted line that cannot become a supported typed event.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ParsePushError {
    /// The line is not valid IRC wire syntax.
    #[error("invalid IRC push payload: {0}")]
    InvalidLine(String),
    /// The command is valid IRC but not a supported push event.
    #[error("unsupported IRC push command")]
    Unsupported,
    /// A supported command is missing fields required for safe display.
    #[error("IRC push payload is missing required fields")]
    MissingField,
}

/// Parses one decrypted IRC line through `papo-proto`.
///
/// # Errors
///
/// Returns a typed failure for malformed, unsupported, or incomplete lines.
pub fn parse_push_payload(input: &str) -> Result<PushEvent, ParsePushError> {
    let line =
        LineRef::parse(input).map_err(|error| ParsePushError::InvalidLine(error.to_string()))?;
    match line.command() {
        Command::Privmsg => parse_privmsg(&line),
        Command::Notice => chat(&line).map(PushEvent::Notice),
        Command::Invite => Ok(PushEvent::Invite {
            sender: sender(&line)?,
            target: required_param(&line, 1)?.to_owned(),
        }),
        Command::Markread => Ok(PushEvent::Markread {
            target: required_param(&line, 0)?.to_owned(),
            until: required_param(&line, 1)?.to_owned(),
        }),
        Command::Ping => Ok(PushEvent::Ping),
        _ => Err(ParsePushError::Unsupported),
    }
}

fn parse_privmsg(line: &LineRef<'_>) -> Result<PushEvent, ParsePushError> {
    let mut payload = chat(line)?;
    let Some(ctcp) = Ctcp::parse(&payload.text) else {
        return Ok(PushEvent::Message(payload));
    };
    if !ctcp.command.eq_ignore_ascii_case("ACTION") {
        return Err(ParsePushError::Unsupported);
    }
    let action = ctcp.params.ok_or(ParsePushError::MissingField)?.to_owned();
    payload.text = action;
    Ok(PushEvent::Action(payload))
}

fn chat(line: &LineRef<'_>) -> Result<ChatPayload, ParsePushError> {
    Ok(ChatPayload {
        sender: sender(line)?,
        account: line.tag("account").map(std::borrow::Cow::into_owned),
        target: required_param(line, 0)?.to_owned(),
        msgid: line
            .tag("msgid")
            .ok_or(ParsePushError::MissingField)?
            .into_owned(),
        time: line
            .tag("time")
            .ok_or(ParsePushError::MissingField)?
            .into_owned(),
        text: required_param(line, 1)?.to_owned(),
    })
}

fn sender(line: &LineRef<'_>) -> Result<String, ParsePushError> {
    match line.source() {
        Some(Source::User { nick, .. }) => Ok(nick.to_owned()),
        _ => Err(ParsePushError::MissingField),
    }
}

fn required_param<'a>(line: &LineRef<'a>, index: usize) -> Result<&'a str, ParsePushError> {
    line.param(index)
        .filter(|value| !value.is_empty())
        .ok_or(ParsePushError::MissingField)
}

/// Wasm boundary used by the classic service worker.
///
/// # Errors
///
/// Returns a JavaScript string when parsing or serialization fails.
#[wasm_bindgen]
pub fn parse_push_payload_json(input: &str) -> Result<String, JsValue> {
    let event = parse_push_payload(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&event).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{ChatPayload, ParsePushError, PushEvent, parse_push_payload};

    const TIME: &str = "2026-11-03T12:34:56.789Z";

    #[test]
    fn parses_captured_ergo_message_shapes() {
        let cases = [
            (
                format!("@time={TIME};msgid=priv :mel!m@example.test PRIVMSG #lounge :hello there"),
                PushEvent::Message(ChatPayload {
                    sender: "mel".into(),
                    account: None,
                    target: "#lounge".into(),
                    msgid: "priv".into(),
                    time: TIME.into(),
                    text: "hello there".into(),
                }),
            ),
            (
                format!(
                    "@time={TIME};msgid=notice :NickServ!s@example.test NOTICE weblounge :identify first"
                ),
                PushEvent::Notice(ChatPayload {
                    sender: "NickServ".into(),
                    account: None,
                    target: "weblounge".into(),
                    msgid: "notice".into(),
                    time: TIME.into(),
                    text: "identify first".into(),
                }),
            ),
            (
                format!(
                    "@time={TIME};msgid=action :mel!m@example.test PRIVMSG #lounge :\u{1}ACTION waves\u{1}"
                ),
                PushEvent::Action(ChatPayload {
                    sender: "mel".into(),
                    account: None,
                    target: "#lounge".into(),
                    msgid: "action".into(),
                    time: TIME.into(),
                    text: "waves".into(),
                }),
            ),
        ];

        for (line, expected) in cases {
            assert_eq!(parse_push_payload(&line), Ok(expected));
        }
    }

    #[test]
    fn parses_sender_account() {
        let line = format!(
            "@time={TIME};msgid=account;account=louro :louro-pi!l@example.test PRIVMSG weblounge :hello"
        );

        assert!(matches!(
            parse_push_payload(&line),
            Ok(PushEvent::Message(ChatPayload { account: Some(account), .. }))
                if account == "louro"
        ));
    }

    #[test]
    fn preserves_server_time_verbatim() {
        let time = "2026-11-06T12:09:38.376999999Z";
        let line =
            format!("@time={time};msgid=precision :mel!m@example.test PRIVMSG #lounge :hello");

        assert!(matches!(
            parse_push_payload(&line),
            Ok(PushEvent::Message(ChatPayload { time: parsed, .. })) if parsed == time
        ));
    }

    #[test]
    fn parses_control_events() {
        assert_eq!(
            parse_push_payload(":mel!m@example.test INVITE weblounge #secret"),
            Ok(PushEvent::Invite {
                sender: "mel".into(),
                target: "#secret".into(),
            })
        );
        assert_eq!(
            parse_push_payload(
                ":irc.example.test MARKREAD #lounge timestamp=2026-11-03T12:34:56.789Z"
            ),
            Ok(PushEvent::Markread {
                target: "#lounge".into(),
                until: "timestamp=2026-11-03T12:34:56.789Z".into(),
            })
        );
        assert_eq!(
            parse_push_payload("PING :push-registration"),
            Ok(PushEvent::Ping)
        );
    }

    #[test]
    fn parses_ergo_length_limited_text_but_rejects_incomplete_lines() {
        let prefix = format!("@time={TIME};msgid=truncated :mel!m@example.test PRIVMSG #lounge :");
        let complete = format!("{prefix}{}", "x".repeat(600));
        let truncated = &complete[..510];
        assert_eq!(truncated.len(), 510);
        assert!(matches!(
            parse_push_payload(truncated),
            Ok(PushEvent::Message(ChatPayload { text, .. }))
                if text == complete[prefix.len()..510]
        ));
        assert_eq!(
            parse_push_payload(":mel!m@example.test PRIVMSG #lounge"),
            Err(ParsePushError::MissingField)
        );
        assert!(matches!(
            parse_push_payload("@time=bad"),
            Err(ParsePushError::InvalidLine(_))
        ));
    }
}
