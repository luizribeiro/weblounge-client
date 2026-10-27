//! DM sending boundary for papo's planned guarded direct-target handle.

/// A validated direct-message destination owned by the engine.
#[derive(Clone, Debug)]
pub(crate) struct DirectTarget(papo::Nick);

impl DirectTarget {
    pub(crate) const fn new(nick: papo::Nick) -> Self {
        Self(nick)
    }

    pub(crate) async fn send(
        self,
        client: &papo::Client,
        text: String,
    ) -> Result<papo::Sent, papo::Error> {
        client.privmsg(self.0, text).await
    }
}
