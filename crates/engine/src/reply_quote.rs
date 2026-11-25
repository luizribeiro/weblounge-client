use std::collections::HashMap;

use crate::{
    MessageKind, MessageProjection, ReplyParent,
    fetched_parents::{FetchedParent, FetchedParents},
};

/// One loaded row a reply can quote, with the parent it replies to in turn.
#[derive(Clone, Copy)]
pub(crate) struct QuotableRow<'a> {
    pub(crate) message: &'a MessageProjection,
    pub(crate) reply_to: Option<&'a str>,
}

/// A conversation's loaded rows by server message identifier, and the parents it fetched.
pub(crate) struct LoadedRows<'a> {
    rows: HashMap<&'a str, QuotableRow<'a>>,
    fetched: &'a FetchedParents,
    casemapping: papo::Casemapping,
    strips_prefix: bool,
}

impl<'a> LoadedRows<'a> {
    /// Channel replies carry their parent's nick for plain IRC clients; DMs never do.
    pub(crate) fn new(
        rows: impl IntoIterator<Item = QuotableRow<'a>>,
        fetched: &'a FetchedParents,
        casemapping: papo::Casemapping,
        channel: bool,
    ) -> Self {
        let rows = rows
            .into_iter()
            .flat_map(|row| {
                row.message
                    .server_ids
                    .iter()
                    .map(move |msgid| (msgid.as_str(), row))
            })
            .collect();
        Self {
            rows,
            fetched,
            casemapping,
            strips_prefix: channel,
        }
    }

    /// Fills a reply's quote and hides the `<parent nick>: ` its text starts with.
    pub(crate) fn quote(
        &self,
        mut message: MessageProjection,
        reply_to: &str,
    ) -> MessageProjection {
        let row = self.rows.get(reply_to);
        let author = row.map_or_else(
            || self.fetched.get(reply_to).and_then(FetchedParent::author),
            |parent| Some(parent.message.author.as_str()),
        );
        if let Some(text) = author.and_then(|author| self.without_prefix(&message, author)) {
            message.text = text.to_owned();
        }
        message.reply =
            Some(row.map_or_else(|| self.fetched.projection(reply_to), |row| self.parent(row)));
        message
    }

    /// A parent neither loaded nor looked up yet, which history should be asked for.
    pub(crate) fn needs_fetch(&self, reply_to: &str) -> bool {
        !self.rows.contains_key(reply_to) && self.fetched.get(reply_to).is_none()
    }

    fn parent(&self, row: &QuotableRow<'a>) -> ReplyParent {
        let parent = row.message;
        if matches!(parent.kind, MessageKind::Redacted(_)) {
            return ReplyParent::Deleted;
        }
        ReplyParent::Loaded {
            message_id: parent.id,
            author: parent.author.clone(),
            nick_color_index: parent.nick_color_index,
            text: self.shown_text(row).to_owned(),
        }
    }

    fn shown_text(&self, row: &QuotableRow<'a>) -> &'a str {
        row.reply_to
            .and_then(|msgid| self.rows.get(msgid))
            .and_then(|grandparent| self.without_prefix(row.message, &grandparent.message.author))
            .unwrap_or(&row.message.text)
    }

    /// Only a plain channel line carries the prefix plain IRC clients read.
    fn without_prefix<'t>(&self, reply: &'t MessageProjection, author: &str) -> Option<&'t str> {
        if !self.strips_prefix || reply.kind != MessageKind::Text {
            return None;
        }
        let (nick, rest) = reply.text.split_once(": ")?;
        (self.casemapping.fold(nick) == self.casemapping.fold(author)).then_some(rest)
    }
}

#[cfg(test)]
mod tests {
    use super::{LoadedRows, QuotableRow};
    use crate::fetched_parents::{FetchedParent, FetchedParents};
    use crate::{
        MessageAuthorship, MessageDelivery, MessageId, MessageKind, MessageProjection, Redaction,
        ReplyParent,
    };

    fn row(id: u64, author: &str, text: &str, msgid: &str) -> MessageProjection {
        MessageProjection {
            id: MessageId(id),
            author: author.into(),
            text: text.into(),
            kind: MessageKind::Text,
            bot: Some(false),
            authorship: MessageAuthorship::Other,
            nick_color_index: 3,
            highlighted: false,
            mentions: None,
            unverified_sender: None,
            reactions: None,
            own_redaction: None,
            reply: None,
            inert: false,
            delivery: MessageDelivery::Received,
            local_send_id: None,
            server_ids: vec![msgid.into()],
            server_time_ms: Some(1),
            received_at_ms: 1,
        }
    }

    fn rows<'a>(rows: &'a [(MessageProjection, Option<&'a str>)], channel: bool) -> LoadedRows<'a> {
        with_fetched(rows, Box::leak(Box::default()), channel)
    }

    fn with_fetched<'a>(
        rows: &'a [(MessageProjection, Option<&'a str>)],
        fetched: &'a FetchedParents,
        channel: bool,
    ) -> LoadedRows<'a> {
        LoadedRows::new(
            rows.iter().map(|(message, reply_to)| QuotableRow {
                message,
                reply_to: *reply_to,
            }),
            fetched,
            papo::Casemapping::Rfc1459,
            channel,
        )
    }

    #[test]
    fn a_channel_reply_quotes_its_loaded_parent_and_hides_the_nick_prefix() {
        let loaded = [(row(1, "Bruno", "the relay forwards ciphertext", "p1"), None)];
        let reply = rows(&loaded, true).quote(row(2, "luiz", "bruno: love it", "r1"), "p1");

        assert_eq!(reply.text, "love it");
        assert_eq!(
            reply.reply,
            Some(ReplyParent::Loaded {
                message_id: MessageId(1),
                author: "Bruno".into(),
                nick_color_index: 3,
                text: "the relay forwards ciphertext".into(),
            })
        );
    }

    #[test]
    fn the_prefix_matches_the_parent_nick_under_the_servers_casemapping() {
        let loaded = [(row(1, "[Bruno]", "ship it?", "p1"), None)];
        let reply = rows(&loaded, true).quote(row(2, "luiz", "{bruno}: yes", "r1"), "p1");

        assert_eq!(reply.text, "yes");
    }

    #[test]
    fn an_action_reply_keeps_its_text() {
        let loaded = [(row(1, "bruno", "ship it?", "p1"), None)];
        let mut action = row(2, "luiz", "bruno: ships it", "r1");
        action.kind = MessageKind::Action;
        let reply = rows(&loaded, true).quote(action, "p1");

        assert_eq!(reply.text, "bruno: ships it");
    }

    #[test]
    fn a_prefix_naming_someone_else_stays_in_the_text() {
        let loaded = [(row(1, "bruno", "ship it?", "p1"), None)];
        let reply = rows(&loaded, true).quote(row(2, "luiz", "ana: not yet", "r1"), "p1");

        assert_eq!(reply.text, "ana: not yet");
    }

    #[test]
    fn a_direct_reply_keeps_text_that_looks_like_a_prefix() {
        let loaded = [(row(1, "bruno", "ship it?", "p1"), None)];
        let reply = rows(&loaded, false).quote(row(2, "luiz", "bruno: yes", "r1"), "p1");

        assert_eq!(reply.text, "bruno: yes");
    }

    #[test]
    fn a_quoted_reply_shows_its_own_text_without_its_prefix() {
        let loaded = [
            (row(1, "ana", "who has the keys?", "p1"), None),
            (row(2, "bruno", "ana: I do", "p2"), Some("p1")),
        ];
        let reply = rows(&loaded, true).quote(row(3, "luiz", "bruno: thanks", "r1"), "p2");

        assert!(matches!(
            reply.reply,
            Some(ReplyParent::Loaded { ref text, .. }) if text == "I do"
        ));
    }

    #[test]
    fn a_deleted_parent_is_quoted_as_deleted_without_the_prefix() {
        let mut deleted = row(1, "bruno", "", "p1");
        deleted.kind = MessageKind::Redacted(Redaction { by: None });
        let loaded = [(deleted, None)];
        let reply = rows(&loaded, true).quote(row(2, "luiz", "bruno: ok", "r1"), "p1");

        assert_eq!(reply.reply, Some(ReplyParent::Deleted));
        assert_eq!(reply.text, "ok");
    }

    #[test]
    fn a_parent_outside_the_timeline_loads_until_history_answers() {
        let loaded = rows(&[], true);
        let reply = loaded.quote(row(2, "luiz", "bruno: ok", "r1"), "p1");

        assert_eq!(reply.reply, Some(ReplyParent::Loading));
        assert_eq!(reply.text, "bruno: ok");
        assert!(loaded.needs_fetch("p1"));
    }

    #[test]
    fn a_fetched_parent_is_quoted_and_its_nick_prefix_hidden() {
        let mut fetched = FetchedParents::default();
        fetched.request("p1");
        fetched.resolve(
            "p1",
            FetchedParent::Fetched {
                author: "Bruno".into(),
                nick_color_index: 4,
                text: "ship it?".into(),
            },
        );
        let loaded = with_fetched(&[], &fetched, true);
        let reply = loaded.quote(row(2, "luiz", "bruno: ok", "r1"), "p1");

        assert_eq!(reply.text, "ok");
        assert_eq!(
            reply.reply,
            Some(ReplyParent::Fetched {
                author: "Bruno".into(),
                nick_color_index: 4,
                text: "ship it?".into(),
            })
        );
        assert!(!loaded.needs_fetch("p1"));
    }

    #[test]
    fn a_parent_history_lacks_is_unavailable() {
        let mut fetched = FetchedParents::default();
        fetched.request("p1");
        fetched.resolve("p1", FetchedParent::Missing);
        let reply =
            with_fetched(&[], &fetched, true).quote(row(2, "luiz", "bruno: ok", "r1"), "p1");

        assert_eq!(reply.reply, Some(ReplyParent::Unavailable));
        assert_eq!(reply.text, "bruno: ok");
    }
}
