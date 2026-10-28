//! DM sending boundary for papo's planned guarded direct-target handle.
//!
//! Sends remain unguarded when the current papo state has no logged-in account for the nick. Until
//! papo 0.1 provides `client.direct(nick)`, the engine refuses the narrower case where both the DM
//! buffer and current state have accounts and they differ.

/// A direct send failed before or during protocol delivery.
#[derive(Debug)]
pub(crate) enum DirectSendError {
    /// The nick is now logged in to a different account than the established DM buffer.
    AccountChanged,
    /// Papo rejected or could not complete the send.
    Protocol,
}

/// A validated direct-message destination owned by the engine.
#[derive(Clone, Debug)]
pub(crate) struct DirectTarget {
    nick: papo::Nick,
    account: Option<papo::AccountName>,
}

impl DirectTarget {
    pub(crate) const fn new(nick: papo::Nick, account: Option<papo::AccountName>) -> Self {
        Self { nick, account }
    }

    pub(crate) const fn nick(&self) -> &papo::Nick {
        &self.nick
    }

    pub(crate) async fn send(
        self,
        client: &papo::Client,
        text: String,
        action: bool,
    ) -> Result<papo::Sent, DirectSendError> {
        if let Some(expected) = self.account.as_ref()
            && let Some(current) = client
                .state()
                .user(&self.nick)
                .and_then(|user| user.account().name())
            && current != expected
        {
            return Err(DirectSendError::AccountChanged);
        }
        let target = client
            .direct(&self.nick)
            .await
            .map_err(|_| DirectSendError::Protocol)?;
        if action {
            client.action(target, text).await
        } else {
            client.privmsg(target, text).await
        }
        .map_err(|_| DirectSendError::Protocol)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use papo_testing::wire;

    use super::{DirectSendError, DirectTarget};
    use crate::name_key::RequiredNameRules;

    #[tokio::test]
    async fn refuses_a_dm_when_the_known_account_changed() {
        let caps = ["account-notify", "extended-join"];
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&caps).await;
        wait_for(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@host JOIN #room weblounge :WebLounge")
            .await;
        wait_for(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        wire.server(":alice!a@host JOIN #room alice-one :Alice")
            .await;
        wait_for(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let snapshot = client.state();
        let target = DirectTarget::new(
            snapshot.required_name_rules().nick("alice"),
            Some(snapshot.required_name_rules().account("alice-one")),
        );

        wire.server(":alice!a@host ACCOUNT alice-two").await;
        wait_for(&mut events, |event| {
            matches!(event, papo::Event::AccountChanged(_))
        })
        .await;

        assert!(matches!(
            target.send(&client, "wrong recipient".into(), false).await,
            Err(DirectSendError::AccountChanged)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), wire.next_sent())
                .await
                .is_err()
        );
    }

    async fn wait_for(events: &mut papo::Events, predicate: impl Fn(&papo::Event) -> bool) {
        loop {
            let event = events.next().await.expect("event stream remains open");
            if predicate(&event) {
                return;
            }
        }
    }
}
