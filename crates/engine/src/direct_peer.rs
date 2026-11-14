use crate::{EngineToUi, PeerPresence};

/// Presence the network vouches for: the peer shares a channel with us or `MONITOR` reports it
/// online. Anything else, including a `MONITOR` offline reply, is no presence at all.
pub(crate) fn of(
    state: &papo::State,
    nick: &papo::Nick,
    reported_offline: bool,
) -> Option<PeerPresence> {
    let user = state.user(nick)?;
    let visible = user.channels().len() != 0
        || (!reported_offline
            && state
                .monitor_online()
                .any(|online| online.nick() == user.nick()));
    visible.then(|| {
        if matches!(user.away(), papo::Away::Away { .. }) {
            PeerPresence::Away
        } else {
            PeerPresence::Online
        }
    })
}

/// papo forgets a peer once it leaves our view, so an unknown answer keeps what was last reported:
/// being a bot is part of who the peer is, not of whether it is connected.
pub(crate) fn bot(state: &papo::State, nick: &papo::Nick, last_reported: bool) -> bool {
    state
        .user(nick)
        .and_then(papo::User::is_bot)
        .unwrap_or(last_reported)
}

pub(crate) const fn may_change(event: &papo::Event) -> bool {
    matches!(
        event,
        papo::Event::MonitorOnline(_)
            | papo::Event::MonitorOffline(_)
            | papo::Event::Message(_)
            | papo::Event::Notice(_)
            | papo::Event::AwayChanged(_)
            | papo::Event::NickChanged(_)
            | papo::Event::Quit(_)
            | papo::Event::Connected(_)
            | papo::Event::Disconnected(_)
            | papo::Event::FeaturesChanged { .. }
            | papo::Event::Joined(_)
            | papo::Event::Parted(_)
            | papo::Event::Kicked(_)
            | papo::Event::ChannelSynced(_)
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
        BufferId, BufferProjection, EngineToUi, NetworkId, PeerPresence,
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
            loop {
                let event = self
                    .events
                    .next()
                    .await
                    .expect("papo event stream remains open");
                self.model.observe_monitor(&event);
                if until(&event) {
                    return;
                }
            }
        }

        fn sync(&mut self) -> Vec<(BufferId, Option<PeerPresence>)> {
            self.sync_fact(|buffer| buffer.peer_presence)
        }

        fn sync_bot(&mut self) -> Vec<(BufferId, bool)> {
            self.sync_fact(|buffer| buffer.peer_bot)
        }

        fn sync_fact<T>(&mut self, fact: impl Fn(&BufferProjection) -> T) -> Vec<(BufferId, T)> {
            self.model
                .sync_direct_peers(&self.client.state())
                .into_iter()
                .map(|event| match event {
                    EngineToUi::BufferUpdated { buffer } => (buffer.id, fact(&buffer)),
                    other => panic!("unexpected peer event {other:?}"),
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

    fn message(event: &papo::Event) -> bool {
        matches!(event, papo::Event::Message(_))
    }

    #[tokio::test]
    async fn the_bot_tag_on_a_peers_messages_marks_its_direct_as_a_bot() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        _ = peer.sync();

        peer.server(
            "@msgid=human;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        assert_eq!(peer.sync_bot(), []);

        peer.server(
            "@bot;msgid=bot;time=2026-11-14T12:01:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :I am a bot",
            message,
        )
        .await;
        assert_eq!(peer.sync_bot(), [(peer.alice, true)]);
        assert_eq!(peer.sync_bot(), []);
    }

    #[tokio::test]
    async fn a_bot_that_goes_offline_is_still_shown_as_a_bot() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        peer.server(
            "@bot;msgid=bot;time=2026-11-14T12:01:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :I am a bot",
            message,
        )
        .await;
        _ = peer.sync();

        peer.server(":offline.test 731 weblounge :alice", |event| {
            matches!(event, papo::Event::MonitorOffline(_))
        })
        .await;

        assert_eq!(peer.sync_bot(), [(peer.alice, true)]);
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

        let updates = model.sync_direct_peers(&client.state());

        assert!(matches!(
            updates.as_slice(),
            [EngineToUi::BufferUpdated { buffer }]
                if buffer.id == alice && buffer.peer_presence == Some(PeerPresence::Online)
        ));
    }

    #[tokio::test]
    async fn a_peer_seen_in_a_shared_channel_is_online_until_it_leaves() {
        let (client, mut events, mut wire) =
            papo_testing::wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["away-notify"]).await;
        next(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        wire.server(":weblounge!u@h JOIN #room").await;
        wire.server(":offline.test 353 weblounge = #room :weblounge alice")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        next(&mut events, |event| {
            matches!(event, papo::Event::ChannelSynced(_))
        })
        .await;
        let nick = client
            .state()
            .user("alice")
            .map(|user| user.nick().clone())
            .expect("alice shares #room");
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        let (alice, _) = model.open_direct(nick, DirectAvailability::Pending, &client.state());
        let presence = |model: &mut NetworkModel| {
            model
                .sync_direct_peers(&client.state())
                .into_iter()
                .map(|event| match event {
                    EngineToUi::BufferUpdated { buffer } => (buffer.id, buffer.peer_presence),
                    other => panic!("unexpected presence event {other:?}"),
                })
                .collect::<Vec<_>>()
        };

        assert_eq!(presence(&mut model), [(alice, Some(PeerPresence::Online))]);

        wire.server(":alice!u@h PART #room").await;
        next(&mut events, |event| matches!(event, papo::Event::Parted(_))).await;
        assert_eq!(presence(&mut model), [(alice, None)]);
    }

    #[tokio::test]
    async fn a_peer_held_by_a_direct_handle_still_goes_offline_on_a_731() {
        let mut peer = Peer::monitored().await;
        let request = tokio::spawn({
            let client = peer.client.clone();
            async move { client.direct("alice").await }
        });
        assert_eq!(peer.wire.next_sent().await, "WHO alice %na");
        peer.wire
            .server(":offline.test 354 weblounge alice alice-account")
            .await;
        peer.wire
            .server(":offline.test 315 weblounge alice :End of WHO list")
            .await;
        let _held = request
            .await
            .expect("direct task completes")
            .expect("direct");
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);

        peer.server(":offline.test 731 weblounge :alice", |event| {
            matches!(event, papo::Event::MonitorOffline(_))
        })
        .await;

        assert_eq!(peer.sync(), [(peer.alice, None)]);
    }
}
