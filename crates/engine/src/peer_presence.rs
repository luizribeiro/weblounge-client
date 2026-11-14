use crate::{EngineToUi, PeerPresence};

/// Presence for every peer papo currently tracks as online through `MONITOR`.
///
/// Peers absent from the result have no reported presence: the network said they went offline,
/// or never said anything about them.
pub(crate) fn reported(
    state: &papo::State,
) -> impl Iterator<Item = (papo::Conversation, PeerPresence)> + '_ {
    state.monitor_online().map(|user| {
        let presence = if matches!(user.away(), papo::Away::Away { .. }) {
            PeerPresence::Away
        } else {
            PeerPresence::Online
        };
        (papo::Conversation::Private(user.nick().clone()), presence)
    })
}

pub(crate) const fn may_change(event: &papo::Event) -> bool {
    matches!(
        event,
        papo::Event::MonitorOnline(_)
            | papo::Event::MonitorOffline(_)
            | papo::Event::AwayChanged(_)
            | papo::Event::NickChanged(_)
            | papo::Event::Quit(_)
            | papo::Event::Connected(_)
            | papo::Event::Disconnected(_)
            | papo::Event::FeaturesChanged { .. }
    )
}

pub(crate) const fn reveals_buffers(event: &EngineToUi) -> bool {
    matches!(
        event,
        EngineToUi::BufferAdded { .. } | EngineToUi::BuffersChanged { .. }
    )
}

#[cfg(test)]
pub(crate) mod test_support {
    use papo_testing::{Wire, wire};

    /// A registered client with `away-notify` and `extended-monitor` that monitors `alice`.
    pub(crate) async fn monitoring_alice() -> (papo::Client, papo::Events, Wire, papo::Nick) {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["away-notify", "extended-monitor"]).await;
        next(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":offline.test 005 weblounge MONITOR=100 :supported")
            .await;
        next(&mut events, |event| {
            matches!(event, papo::Event::FeaturesChanged { .. })
        })
        .await;
        client
            .monitor()
            .add(["alice"])
            .await
            .expect("monitor accepts");
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        let nick = client
            .state()
            .monitored()
            .next()
            .cloned()
            .expect("alice is monitored");
        (client, events, wire, nick)
    }

    pub(crate) async fn next(events: &mut papo::Events, predicate: impl Fn(&papo::Event) -> bool) {
        while !predicate(&events.next().await.expect("papo event stream remains open")) {}
    }
}

#[cfg(test)]
mod tests {
    use papo_testing::Wire;

    use super::test_support::{monitoring_alice, next};
    use crate::{
        BufferId, EngineToUi, NetworkId, PeerPresence,
        state::{DirectAvailability, NetworkModel},
    };

    struct Peer {
        client: papo::Client,
        events: papo::Events,
        wire: Wire,
        model: NetworkModel,
        alice: BufferId,
    }

    impl Peer {
        async fn monitored() -> Self {
            let (client, events, wire, nick) = monitoring_alice().await;
            let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
            let (alice, _) = model.open_direct(nick, DirectAvailability::Pending, &client.state());
            Self {
                client,
                events,
                wire,
                model,
                alice,
            }
        }

        async fn server(&mut self, line: &str, until: impl Fn(&papo::Event) -> bool) {
            self.wire.server(line).await;
            next(&mut self.events, until).await;
        }

        fn sync(&mut self) -> Vec<(BufferId, Option<PeerPresence>)> {
            self.model
                .sync_peer_presence(&self.client.state())
                .into_iter()
                .map(|event| match event {
                    EngineToUi::BufferUpdated { buffer } => (buffer.id, buffer.peer_presence),
                    other => panic!("unexpected presence event {other:?}"),
                })
                .collect()
        }
    }

    fn monitor_online(event: &papo::Event) -> bool {
        matches!(event, papo::Event::MonitorOnline(_))
    }

    fn away_changed(event: &papo::Event) -> bool {
        matches!(event, papo::Event::AwayChanged(_))
    }

    #[tokio::test]
    async fn a_peer_the_network_reports_nothing_about_has_no_presence() {
        let mut peer = Peer::monitored().await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_monitored_peer_coming_online_updates_its_direct_once() {
        let mut peer = Peer::monitored().await;

        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn away_notify_on_a_monitored_peer_toggles_between_away_and_online() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        _ = peer.sync();

        peer.server(":alice!~alice@cloak.example AWAY :lunch", away_changed)
            .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);

        peer.server(":alice!~alice@cloak.example AWAY", away_changed)
            .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn a_peer_reported_offline_loses_its_presence_instead_of_showing_offline() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        _ = peer.sync();

        peer.server(":offline.test 731 weblounge :alice", |event| {
            matches!(event, papo::Event::MonitorOffline(_))
        })
        .await;

        assert_eq!(peer.sync(), [(peer.alice, None)]);
    }

    #[tokio::test]
    async fn a_lost_connection_clears_presence_it_can_no_longer_vouch_for() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        _ = peer.sync();

        peer.wire.close().await;
        next(&mut peer.events, |event| {
            matches!(event, papo::Event::Disconnected(_))
        })
        .await;

        assert_eq!(peer.sync(), [(peer.alice, None)]);
    }

    #[tokio::test]
    async fn closing_a_direct_drops_its_presence_and_stops_updating_it() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        _ = peer.sync();

        _ = peer.model.close_direct(peer.alice);
        peer.server(":alice!~alice@cloak.example AWAY :lunch", away_changed)
            .await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_direct_opened_for_a_peer_already_online_gets_presence_at_once() {
        let (client, mut events, mut wire, nick) = monitoring_alice().await;
        wire.server(":offline.test 730 weblounge :alice!~alice@cloak.example")
            .await;
        next(&mut events, monitor_online).await;
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (alice, _) = model.open_direct(nick, DirectAvailability::Pending, &client.state());

        let updates = model.sync_peer_presence(&client.state());

        assert!(matches!(
            updates.as_slice(),
            [EngineToUi::BufferUpdated { buffer }]
                if buffer.id == alice && buffer.peer_presence == Some(PeerPresence::Online)
        ));
    }
}
