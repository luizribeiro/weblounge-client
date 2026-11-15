//! Turning a chat row into a redaction tombstone.

use std::collections::{HashMap, VecDeque};

use crate::{MessageKind, MessageProjection, Redaction};

const EARLY_REDACTION_LIMIT: usize = 256;

/// The chat-list preview of a conversation whose only loaded messages were deleted.
pub(crate) const REDACTED_PREVIEW: &str = "Message deleted";

/// Redactions whose message has not arrived, keyed by the redacted msgid.
#[derive(Debug, Default)]
pub(crate) struct EarlyRedactions {
    order: VecDeque<String>,
    redactors: HashMap<String, Option<String>>,
}

impl EarlyRedactions {
    /// Remembers a redaction; the first one for a msgid wins, as it does for a loaded row.
    pub(crate) fn remember(&mut self, msgid: String, redactor: Option<String>) {
        if self.redactors.contains_key(&msgid) {
            return;
        }
        self.redactors.insert(msgid.clone(), redactor);
        self.order.push_back(msgid);
        if self.order.len() > EARLY_REDACTION_LIMIT
            && let Some(oldest) = self.order.pop_front()
        {
            self.redactors.remove(&oldest);
        }
    }

    /// Removes and returns the redactor of the first listed msgid that was redacted early.
    pub(crate) fn take<'a>(
        &mut self,
        msgids: impl IntoIterator<Item = &'a String>,
    ) -> Option<EarlyRedaction> {
        let msgid = msgids
            .into_iter()
            .find(|msgid| self.redactors.contains_key(*msgid))?;
        self.order.retain(|known| known != msgid);
        self.redactors
            .remove(msgid)
            .map(|redactor| EarlyRedaction { redactor })
    }
}

/// A remembered redaction of a message that had not arrived.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct EarlyRedaction {
    pub(crate) redactor: Option<String>,
}

/// The name shown for whoever redacted a message: a user's nick, or the server's name.
pub(crate) fn redactor_name(actor: &papo::Source) -> String {
    match actor {
        papo::Source::User(user) => user.nick().to_string(),
        papo::Source::Server(server) => server.to_string(),
        _ => String::new(),
    }
}

/// Drops a message's text, reactions and highlight, keeping its identity, sender and time.
///
/// Returns false when the message was already redacted.
pub(crate) fn redact_projection(
    message: &mut MessageProjection,
    redactor: Option<String>,
    casemapping: papo::Casemapping,
) -> bool {
    if matches!(message.kind, MessageKind::Redacted(_)) {
        return false;
    }
    let by = redactor.filter(|redactor| {
        !redactor.is_empty() && casemapping.fold(redactor) != casemapping.fold(&message.author)
    });
    message.kind = MessageKind::Redacted(Redaction { by });
    message.text.clear();
    message.reactions = None;
    message.highlighted = false;
    message.own_redaction = None;
    true
}

#[cfg(test)]
mod tests {
    use super::{EARLY_REDACTION_LIMIT, EarlyRedaction, EarlyRedactions, redact_projection};
    use crate::{
        MessageAuthorship, MessageDelivery, MessageId, MessageKind, MessageProjection,
        ReactionActorProjection, ReactionProjection, Redaction,
    };

    fn message(author: &str) -> MessageProjection {
        MessageProjection {
            id: MessageId(7),
            author: author.into(),
            text: "my card number is 4111".into(),
            kind: MessageKind::Text,
            bot: None,
            authorship: MessageAuthorship::Other,
            nick_color_index: 2,
            highlighted: true,
            unverified_sender: None,
            reactions: Some(vec![ReactionProjection {
                text: "👍".into(),
                actors: vec![ReactionActorProjection {
                    nick: "bob".into(),
                    mine: false,
                }],
                mine: false,
                own_delivery: None,
            }]),
            own_redaction: None,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: vec!["m1".into()],
            server_time_ms: Some(1_000),
            received_at_ms: 1_001,
        }
    }

    fn kind(by: Option<&str>) -> MessageKind {
        MessageKind::Redacted(Redaction {
            by: by.map(str::to_owned),
        })
    }

    #[test]
    fn redaction_drops_the_text_and_keeps_the_row_identity() {
        let mut redacted = message("[alice]");
        assert!(redact_projection(
            &mut redacted,
            Some("{ALICE}".into()),
            papo::Casemapping::Rfc1459
        ));
        assert_eq!(redacted.kind, kind(None));
        assert_eq!(redacted.text, "");
        assert_eq!(redacted.reactions, None);
        assert!(!redacted.highlighted);
        let original = message("[alice]");
        assert_eq!(
            (
                redacted.id,
                redacted.author,
                redacted.server_ids,
                redacted.server_time_ms
            ),
            (
                original.id,
                original.author,
                original.server_ids,
                original.server_time_ms
            )
        );
    }

    #[test]
    fn ascii_casemapping_tells_brackets_apart() {
        let mut redacted = message("[alice]");
        redact_projection(
            &mut redacted,
            Some("{alice}".into()),
            papo::Casemapping::Ascii,
        );
        assert_eq!(redacted.kind, kind(Some("{alice}")));
    }

    #[test]
    fn another_users_redaction_names_the_redactor_once() {
        let mut redacted = message("alice");
        assert!(redact_projection(
            &mut redacted,
            Some("op".into()),
            papo::Casemapping::Rfc1459
        ));
        assert_eq!(redacted.kind, kind(Some("op")));
        assert!(!redact_projection(
            &mut redacted,
            Some("alice".into()),
            papo::Casemapping::Rfc1459
        ));
        assert_eq!(redacted.kind, kind(Some("op")));
    }

    #[test]
    fn early_redactions_keep_the_first_redactor_and_stay_bounded() {
        let mut early = EarlyRedactions::default();
        early.remember("first".into(), Some("op".into()));
        early.remember("repeat".into(), Some("op".into()));
        early.remember("repeat".into(), Some("alice".into()));
        assert_eq!(
            early.take(&["repeat".to_owned()]),
            Some(EarlyRedaction {
                redactor: Some("op".into())
            })
        );
        for index in 0..EARLY_REDACTION_LIMIT {
            early.remember(format!("later-{index}"), None);
        }
        assert_eq!(early.take(&["first".to_owned()]), None);
        let later = ["unknown".to_owned(), "later-3".to_owned()];
        assert_eq!(early.take(&later), Some(EarlyRedaction { redactor: None }));
        assert_eq!(early.take(&later), None);
    }
}
