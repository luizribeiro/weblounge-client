/// Papo's opaque saved form of one row's return address and server message identifiers.
///
/// Reactions and deletions restore their target from it, so they reach exactly the audience the
/// row came from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SavedMessage(String);

impl SavedMessage {
    /// A line without a server message identifier cannot be restored, so it saves nothing.
    pub(crate) fn of(reference: &papo::MessageRef) -> Option<Self> {
        reference.msgid().map(|_| Self(reference.to_saved()))
    }

    pub(crate) fn of_message(message: &papo::event::Message) -> Option<Self> {
        Self::of(&message.return_address())
    }

    /// Each line of a split send keeps the send's audience under its own confirmed msgid.
    pub(crate) fn of_sent_line(line: &papo::SentLine) -> Option<Self> {
        Self::of(&line.return_address())
    }

    pub(crate) fn restore(&self, client: &papo::Client) -> Result<papo::MessageRef, papo::Error> {
        client.saved_message(&self.0)
    }
}

/// The message papo makes of one server line on a fresh connection.
#[cfg(test)]
pub(crate) async fn received(line: &str) -> (papo::Client, papo::event::Message) {
    use crate::test_events::NextEvent;
    let (client, mut events, mut wire) =
        papo_testing::wire(papo::Client::builder("irc://offline.test", "weblounge"));
    wire.register(&[]).await;
    wire.server(line).await;
    loop {
        if let Some(papo::Event::Message(message)) = events.next_event().await {
            return (client, message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SavedMessage, received};

    #[tokio::test]
    async fn a_channel_line_restores_its_audience_and_msgid() {
        let (client, message) = received("@msgid=m1 :alice!a@host PRIVMSG #room :hello").await;
        let saved = SavedMessage::of_message(&message).expect("a line with a msgid saves");
        let restored = saved.restore(&client).expect("papo restores it");
        assert_eq!(
            restored.msgid().map(ToString::to_string).as_deref(),
            Some("m1")
        );
        assert_eq!(restored.to_string(), "#room");
    }

    #[tokio::test]
    async fn a_private_line_restores_its_sender_and_msgid() {
        let (client, message) = received(r"@msgid=d\:1 :alice!a@host PRIVMSG weblounge :hi").await;
        let restored = SavedMessage::of_message(&message)
            .expect("a line with a msgid saves")
            .restore(&client)
            .expect("papo restores it");
        assert_eq!(
            restored.msgid().map(ToString::to_string).as_deref(),
            Some("d;1")
        );
        assert_eq!(restored.to_string(), "alice");
    }

    #[tokio::test]
    async fn a_line_without_a_msgid_saves_nothing() {
        let (_client, message) = received(":alice!a@host PRIVMSG #room :hello").await;
        assert_eq!(SavedMessage::of_message(&message), None);
    }
}
