use super::{collect, harness, lock, next_matching, process_event};
use crate::{BufferId, EngineToUi, PeerPresence, state::DirectAvailability};

const ALICE_ONLINE: &str = ":offline.test 730 weblounge :alice!~alice@cloak.example";
const ALICE_OFFLINE: &str = ":offline.test 731 weblounge :alice";

struct Session {
    client: papo::Client,
    events: papo::Events,
    wire: papo_testing::Wire,
    state: std::sync::Arc<std::sync::Mutex<super::RuntimeState>>,
    outbound: tokio::sync::mpsc::UnboundedSender<EngineToUi>,
    receiver: tokio::sync::mpsc::UnboundedReceiver<EngineToUi>,
    alice: BufferId,
}

impl Session {
    /// Registered with away-notify and extended-monitor, watching alice, with her DM open.
    async fn watching_alice() -> Self {
        Self::watching_alice_with(&["away-notify", "extended-monitor"]).await
    }

    async fn watching_alice_with(caps: &[&str]) -> Self {
        let (client, events, wire, nick) =
            crate::direct_peer::test_support::monitoring_alice_with(caps).await;
        let (state, outbound, receiver) = harness(client.clone());
        let alice = lock(&state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .open_direct(nick, DirectAvailability::Pending, &client.state())
            .0;
        Self {
            client,
            events,
            wire,
            state,
            outbound,
            receiver,
            alice,
        }
    }

    async fn deliver(&mut self, line: &str, wanted: impl Fn(&papo::Event) -> bool) {
        self.wire.server(line).await;
        loop {
            let event = next_matching(&mut self.events, crate::direct_peer::may_change).await;
            let done = wanted(&event);
            process_event(&self.state, &self.outbound, &self.client, 1, event);
            if done {
                return;
            }
        }
    }

    async fn report_online(&mut self, line: &str) {
        self.deliver(line, |event| matches!(event, papo::Event::MonitorOnline(_)))
            .await;
    }

    async fn answer_who(&mut self, nick: &str, flag: char) {
        self.wire
            .server(format!(
                ":offline.test 352 weblounge * ~{nick} cloak.example offline.test {nick} {flag} :0 {nick}"
            ))
            .await;
        self.wire
            .server(format!(
                ":offline.test 315 weblounge {nick} :End of WHO list"
            ))
            .await;
    }

    /// Something the client sends next; any WHO queued before it would have gone out first.
    async fn expect_no_who_before_marker(&mut self, marker: &str) {
        let monitor = self.client.monitor();
        let nick = marker.to_owned();
        let add = tokio::spawn(async move { monitor.add([nick.as_str()]).await });
        assert_eq!(self.wire.next_sent().await, format!("MONITOR + {marker}"));
        add.await.expect("monitor task").expect("monitor accepts");
    }

    async fn presence_update(&mut self) -> Option<PeerPresence> {
        self.presence_and_time().await.0
    }

    async fn presence_and_time(&mut self) -> (Option<PeerPresence>, Option<i64>) {
        loop {
            let event = self.receiver.recv().await.expect("engine output open");
            match event {
                EngineToUi::BufferUpdated { buffer } if buffer.id == self.alice => {
                    return (buffer.peer_presence, buffer.peer_presence_since_ms);
                }
                _ => {}
            }
        }
    }
}

#[tokio::test]
async fn a_watched_peer_coming_online_is_asked_once_and_shows_its_reply() {
    let mut session = Session::watching_alice().await;

    session.report_online(ALICE_ONLINE).await;
    assert_eq!(session.wire.next_sent().await, "WHO alice");
    assert_eq!(session.presence_update().await, Some(PeerPresence::Away));
    session.answer_who("alice", 'H').await;

    assert_eq!(session.presence_update().await, Some(PeerPresence::Online));
    session.expect_no_who_before_marker("carol").await;
}

#[tokio::test]
async fn a_who_reply_of_gone_keeps_the_peer_away_even_after_it_speaks() {
    let mut session = Session::watching_alice().await;
    session.report_online(ALICE_ONLINE).await;
    assert_eq!(session.wire.next_sent().await, "WHO alice");
    _ = collect(&mut session.receiver);

    session.answer_who("alice", 'G').await;
    session
        .deliver(
            ":alice!~alice@cloak.example PRIVMSG weblounge :marker",
            |event| matches!(event, papo::Event::Message(_)),
        )
        .await;

    let updates = collect(&mut session.receiver);
    assert!(!updates.iter().any(|event| matches!(event,
        EngineToUi::BufferUpdated { buffer } if buffer.peer_presence == Some(PeerPresence::Online))));
}

#[tokio::test]
async fn opening_a_dm_asks_nothing() {
    let mut session = Session::watching_alice().await;

    session.expect_no_who_before_marker("carol").await;
}

#[tokio::test]
async fn a_peer_whose_away_state_is_known_is_not_asked() {
    let mut session = Session::watching_alice().await;
    session.wire.server(":weblounge!u@h JOIN #room").await;
    session
        .wire
        .server(":offline.test 353 weblounge = #room :weblounge alice")
        .await;
    session
        .wire
        .server(":offline.test 366 weblounge #room :End of NAMES")
        .await;
    assert_eq!(session.wire.next_sent().await, "MODE #room");
    assert_eq!(session.wire.next_sent().await, "WHO #room");
    session
        .wire
        .server(
            ":offline.test 352 weblounge #room ~alice cloak.example offline.test alice H :0 Alice",
        )
        .await;
    session
        .deliver(
            ":offline.test 315 weblounge #room :End of WHO list",
            |event| matches!(event, papo::Event::MembersRefreshed(_)),
        )
        .await;

    session.report_online(ALICE_ONLINE).await;

    session.expect_no_who_before_marker("carol").await;
}

#[tokio::test]
async fn a_peer_in_a_shared_channel_is_left_to_that_channels_who() {
    let mut session = Session::watching_alice().await;
    session.wire.server(":weblounge!u@h JOIN #room").await;
    session
        .wire
        .server(":offline.test 353 weblounge = #room :weblounge alice")
        .await;
    session
        .deliver(":offline.test 366 weblounge #room :End of NAMES", |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
    assert_eq!(session.wire.next_sent().await, "MODE #room");
    assert_eq!(session.wire.next_sent().await, "WHO #room");

    session.report_online(ALICE_ONLINE).await;

    session.expect_no_who_before_marker("carol").await;
}

#[tokio::test]
async fn a_peer_is_asked_again_after_going_offline_and_coming_back() {
    let mut session = Session::watching_alice().await;
    session.report_online(ALICE_ONLINE).await;
    assert_eq!(session.wire.next_sent().await, "WHO alice");
    session.answer_who("alice", 'H').await;

    session
        .deliver(ALICE_OFFLINE, |event| {
            matches!(event, papo::Event::MonitorOffline(_))
        })
        .await;
    session.report_online(ALICE_ONLINE).await;

    assert_eq!(session.wire.next_sent().await, "WHO alice");
}

#[tokio::test]
async fn peers_coming_online_together_are_asked_one_at_a_time() {
    let mut session = Session::watching_alice().await;
    session.expect_no_who_before_marker("bob").await;

    session
        .deliver(
            ":offline.test 730 weblounge :alice!~alice@cloak.example,bob!~bob@cloak.example",
            |event| matches!(event, papo::Event::MonitorOnline(online) if online.subject.nick() == "bob"),
        )
        .await;

    assert_eq!(session.wire.next_sent().await, "WHO alice");
    session.expect_no_who_before_marker("carol").await;
    session.answer_who("alice", 'H').await;
    assert_eq!(session.wire.next_sent().await, "WHO bob");
}

#[tokio::test]
async fn without_away_reports_the_who_alone_sets_away_and_gives_no_time() {
    for caps in [&["away-notify"][..], &[]] {
        let mut session = Session::watching_alice_with(caps).await;

        session.report_online(ALICE_ONLINE).await;
        assert_eq!(session.wire.next_sent().await, "WHO alice");
        assert_eq!(
            session.presence_and_time().await,
            (Some(PeerPresence::Online), None),
            "no away guess with caps {caps:?}"
        );
        session.answer_who("alice", 'G').await;

        assert_eq!(
            session.presence_and_time().await,
            (Some(PeerPresence::Away), None),
            "the WHO's answer, undated, with caps {caps:?}"
        );
    }
}
