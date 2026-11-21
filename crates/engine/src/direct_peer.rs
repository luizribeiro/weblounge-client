use std::collections::HashSet;

use crate::{EngineToUi, PeerPresence, witnessed_presence::WitnessedPresence};

/// What this connection's events say about DM peers beyond papo's state: papo keeps a peer whose
/// direct handle is held in `monitor_online` after a `MONITOR` offline reply, and it does not treat
/// a peer's own line as a report of its away state.
#[derive(Debug, Default)]
pub(crate) struct PeerEvidence {
    reported_offline: HashSet<papo::Nick>,
    heard_from: HashSet<papo::Nick>,
    witnessed: WitnessedPresence,
}

impl PeerEvidence {
    pub(crate) fn observe(&mut self, event: &papo::Event, now_ms: i64) {
        self.witnessed.observe(event, now_ms);
        match event {
            papo::Event::MonitorOffline(offline) => {
                self.heard_from.remove(&offline.subject);
                self.reported_offline.insert(offline.subject.clone());
            }
            papo::Event::MonitorOnline(online) => {
                self.reported_offline.remove(online.subject.nick());
            }
            papo::Event::Message(message) if message.authorship != papo::Authorship::Own => {
                self.heard_from.insert(message.actor.nick().clone());
            }
            papo::Event::Quit(quit) => {
                self.heard_from.remove(quit.actor.nick());
            }
            papo::Event::NickChanged(changed) => {
                if self.heard_from.remove(changed.actor.nick()) {
                    self.heard_from.insert(changed.new.clone());
                }
            }
            papo::Event::Connected(_) | papo::Event::Disconnected(_) => {
                self.reported_offline.clear();
                self.heard_from.clear();
            }
            _ => {}
        }
    }

    /// Presence the network vouches for: a peer in a shared channel by its reported away state,
    /// and a peer known only through `MONITOR` as online, away or offline.
    pub(crate) fn presence(&self, state: &papo::State, nick: &papo::Nick) -> Option<PeerPresence> {
        let user = state.user(nick);
        if let Some(user) = user.filter(|user| user.channels().len() != 0) {
            return self.reported_away(user);
        }
        if self.reported_offline.contains(nick) {
            return Some(PeerPresence::Offline);
        }
        let user = user.filter(|user| {
            state
                .monitor_online()
                .any(|online| online.nick() == user.nick())
        })?;
        Some(
            self.reported_away(user)
                .unwrap_or_else(|| unreported_monitor_presence(state)),
        )
    }

    /// When this connection saw the peer enter `presence`, for an away or offline peer.
    pub(crate) fn since(&self, nick: &papo::Nick, presence: Option<PeerPresence>) -> Option<i64> {
        presence
            .filter(|presence| *presence != PeerPresence::Online)
            .and_then(|presence| self.witnessed.since(nick, presence))
    }

    fn reported_away(&self, user: &papo::User) -> Option<PeerPresence> {
        match user.away() {
            papo::Away::Away { .. } => Some(PeerPresence::Away),
            papo::Away::Present => Some(PeerPresence::Online),
            _ => self
                .heard_from
                .contains(user.nick())
                .then_some(PeerPresence::Online),
        }
    }
}

/// A `MONITOR` online reply carries no away state, and with always-on and auto-away a detached
/// peer stays connected. Where the server will report the peer's away changes, assume the worse
/// until it does; where it never will, being connected is all we can show.
fn unreported_monitor_presence(state: &papo::State) -> PeerPresence {
    if state.supports(papo::Feature::ExtendedMonitor) && state.supports(papo::Feature::AwayTracking)
    {
        PeerPresence::Away
    } else {
        PeerPresence::Online
    }
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
            | papo::Event::MembersRefreshed(_)
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
        monitoring_alice_with(&["away-notify", "extended-monitor"]).await
    }

    pub(crate) async fn monitoring_alice_with(
        caps: &[&str],
    ) -> (papo::Client, papo::Events, Wire, papo::Nick) {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(caps).await;
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

    use super::test_support::{monitoring_alice, monitoring_alice_with, next};
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
            Self::with_direct(client, events, wire, nick)
        }

        async fn monitored_without_away_reports() -> Self {
            let (client, events, wire, nick) = monitoring_alice_with(&["away-notify"]).await;
            Self::with_direct(client, events, wire, nick)
        }

        async fn report_connected(&mut self) {
            self.server(
                ":offline.test 730 weblounge :alice!~alice@cloak.example",
                monitor_online,
            )
            .await;
        }

        async fn report_offline(&mut self) {
            self.server(":offline.test 731 weblounge :alice", monitor_offline)
                .await;
        }

        async fn sharing_a_channel(caps: &[&str]) -> Self {
            let (client, mut events, mut wire) =
                papo_testing::wire(papo::Client::builder("irc://offline.test", "weblounge"));
            wire.register(caps).await;
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
            Self::with_direct(client, events, wire, nick)
        }

        fn with_direct(
            client: papo::Client,
            events: papo::Events,
            wire: Wire,
            nick: papo::Nick,
        ) -> Self {
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

        async fn report_online(&mut self) {
            self.report_connected().await;
            self.server(":alice!~alice@cloak.example AWAY", away_changed)
                .await;
        }

        async fn server(&mut self, line: &str, until: impl Fn(&papo::Event) -> bool) {
            self.wire.server(line).await;
            loop {
                let event = self
                    .events
                    .next()
                    .await
                    .expect("papo event stream remains open");
                self.model.observe_peers(&event, OBSERVED_AT_MS);
                if until(&event) {
                    return;
                }
            }
        }

        fn sync(&mut self) -> Vec<(BufferId, Option<PeerPresence>)> {
            self.sync_fact(|buffer| buffer.peer_presence)
        }

        fn sync_since(&mut self) -> Vec<(Option<PeerPresence>, Option<i64>)> {
            self.sync_fact(|buffer| (buffer.peer_presence, buffer.peer_presence_since_ms))
                .into_iter()
                .map(|(_, fact)| fact)
                .collect()
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

    const OBSERVED_AT_MS: i64 = 1_795_000_000_000;

    fn monitor_online(event: &papo::Event) -> bool {
        matches!(event, papo::Event::MonitorOnline(_))
    }

    fn monitor_offline(event: &papo::Event) -> bool {
        matches!(event, papo::Event::MonitorOffline(_))
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
        peer.report_online().await;
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

        peer.server(":offline.test 731 weblounge :alice", monitor_offline)
            .await;

        assert_eq!(peer.sync_bot(), [(peer.alice, true)]);
    }

    #[tokio::test]
    async fn a_channel_who_without_the_bot_flag_overrides_a_remembered_bot() {
        let mut peer = Peer::sharing_a_channel(&[]).await;
        assert_eq!(peer.wire.next_sent().await, "MODE #room");
        assert_eq!(peer.wire.next_sent().await, "WHO #room");
        peer.server(":offline.test 005 weblounge BOT=B :supported", |event| {
            matches!(event, papo::Event::FeaturesChanged { .. })
        })
        .await;
        peer.server(
            "@bot;msgid=bot;time=2026-11-14T12:01:00.000Z :alice!u@h PRIVMSG weblounge :I am a bot",
            message,
        )
        .await;
        assert_eq!(peer.sync_bot(), [(peer.alice, true)]);

        peer.wire
            .server(":offline.test 352 weblounge #room ~alice h offline.test alice H :0 Alice")
            .await;
        peer.server(
            ":offline.test 315 weblounge #room :End of WHO list",
            |event| matches!(event, papo::Event::MembersRefreshed { .. }),
        )
        .await;

        assert_eq!(peer.sync_bot(), [(peer.alice, false)]);
    }

    #[tokio::test]
    async fn a_pending_peer_reported_online_shows_online_without_resolving_its_handle() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        let nick = peer
            .model
            .direct_peer(peer.alice)
            .expect("alice is a direct");

        assert!(peer.model.begin_online_direct_resolution(&nick).is_none());
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn a_peer_the_network_reports_nothing_about_has_no_presence() {
        let mut peer = Peer::monitored().await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_monitored_peer_shows_away_until_its_away_state_is_reported() {
        let mut peer = Peer::monitored().await;

        peer.report_connected().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);

        peer.server(":alice!~alice@cloak.example AWAY", away_changed)
            .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_monitored_peer_shows_online_where_the_server_never_reports_away_changes() {
        let mut peer = Peer::monitored_without_away_reports().await;

        peer.report_connected().await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn a_peer_monitored_while_disconnected_is_offline_until_it_connects() {
        let mut peer = Peer::monitored().await;

        peer.report_offline().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Offline))]);

        peer.report_connected().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);
    }

    #[tokio::test]
    async fn a_line_from_a_monitored_peer_reports_it_online() {
        let mut peer = Peer::monitored().await;
        peer.report_connected().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);

        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn a_monitor_offline_reply_forgets_the_lines_a_peer_sent_before_it() {
        let mut peer = Peer::monitored().await;
        peer.server(
            ":offline.test 730 weblounge :alice!~alice@cloak.example",
            monitor_online,
        )
        .await;
        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        _ = peer.sync();

        peer.report_offline().await;
        _ = peer.sync();
        peer.report_connected().await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);
    }

    #[tokio::test]
    async fn away_notify_on_a_monitored_peer_toggles_between_away_and_online() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();

        peer.server(":alice!~alice@cloak.example AWAY :lunch", away_changed)
            .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);

        peer.server(":alice!~alice@cloak.example AWAY", away_changed)
            .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn a_peer_reported_offline_shows_offline() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();

        peer.report_offline().await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Offline))]);
    }

    #[tokio::test]
    async fn a_lost_connection_clears_presence_it_can_no_longer_vouch_for() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
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
        peer.report_online().await;
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
        wire.server(":alice!~alice@cloak.example AWAY").await;
        next(&mut events, away_changed).await;
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
    async fn a_peer_in_a_shared_channel_is_online_from_the_channel_who_until_it_leaves() {
        let mut peer = Peer::sharing_a_channel(&["away-notify"]).await;
        assert_eq!(peer.sync(), []);

        peer.wire
            .server(":offline.test 352 weblounge #room ~alice h offline.test alice H :0 Alice")
            .await;
        peer.server(
            ":offline.test 315 weblounge #room :End of WHO list",
            |event| matches!(event, papo::Event::MembersRefreshed { .. }),
        )
        .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);

        peer.server(":alice!u@h PART #room", |event| {
            matches!(event, papo::Event::Parted(_))
        })
        .await;
        assert_eq!(peer.sync(), [(peer.alice, None)]);
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
        peer.report_online().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);

        peer.report_offline().await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Offline))]);
    }

    #[tokio::test]
    async fn an_away_change_seen_this_session_carries_its_server_time() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();

        peer.server(
            "@time=2026-11-21T14:05:00.000Z :alice!~alice@cloak.example AWAY :lunch",
            away_changed,
        )
        .await;
        assert_eq!(
            peer.sync_since(),
            [(Some(PeerPresence::Away), Some(1_795_269_900_000))]
        );

        peer.server(":alice!~alice@cloak.example AWAY", away_changed)
            .await;
        assert_eq!(peer.sync_since(), [(Some(PeerPresence::Online), None)]);
    }

    #[tokio::test]
    async fn a_peer_assumed_away_from_a_bare_730_has_no_time() {
        let mut peer = Peer::monitored().await;

        peer.report_connected().await;

        assert_eq!(peer.sync_since(), [(Some(PeerPresence::Away), None)]);
    }

    #[tokio::test]
    async fn a_peer_seen_going_offline_is_last_seen_when_monitor_reported_it() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();

        peer.report_offline().await;

        assert_eq!(
            peer.sync_since(),
            [(Some(PeerPresence::Offline), Some(OBSERVED_AT_MS))]
        );
    }

    #[tokio::test]
    async fn a_peer_already_offline_when_first_watched_has_no_last_seen() {
        let mut peer = Peer::monitored().await;

        peer.report_offline().await;

        assert_eq!(peer.sync_since(), [(Some(PeerPresence::Offline), None)]);
    }

    #[tokio::test]
    async fn a_peer_coming_back_drops_its_last_seen() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();
        peer.report_offline().await;
        _ = peer.sync();

        peer.report_online().await;

        assert_eq!(peer.sync_since(), [(Some(PeerPresence::Online), None)]);
    }
}
