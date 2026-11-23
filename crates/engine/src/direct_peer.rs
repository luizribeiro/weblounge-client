use std::collections::HashSet;

use crate::{
    EngineToUi, PeerPresence, away_check::AwayChecks, witnessed_presence::WitnessedPresence,
};

/// A DM's hold on its peer. Lines go to the nick; a peer we share no channel with is watched, so
/// the network keeps reporting its presence for as long as the DM holds this.
#[derive(Clone, Debug)]
pub(crate) struct DirectPeer {
    nick: papo::Nick,
    watch: Option<papo::Watch>,
}

impl DirectPeer {
    pub(crate) fn resolve(client: &papo::Client, nick: &papo::Nick) -> Self {
        let state = client.snapshot();
        let holder = crate::name_key::known_user(&state, nick);
        let seen =
            holder.is_some_and(|user| user.nick() == state.nick() || user.channels().len() != 0);
        let watch = (!seen).then(|| client.watch(nick.as_str()));
        Self {
            nick: nick.clone(),
            watch,
        }
    }

    pub(crate) const fn nick(&self) -> &papo::Nick {
        &self.nick
    }

    pub(crate) const fn watches(&self) -> bool {
        self.watch.is_some()
    }
}

/// What this connection's events say about DM peers beyond papo's state: papo does not treat a
/// peer's own line as a report of its away state.
#[derive(Debug, Default)]
pub(crate) struct PeerEvidence {
    heard_from: HashSet<papo::Nick>,
    refused_watches: HashSet<papo::Nick>,
    witnessed: WitnessedPresence,
    away_checks: AwayChecks,
}

impl PeerEvidence {
    pub(crate) fn observe(&mut self, event: &papo::Event, now_ms: i64) {
        self.witnessed.observe(event, now_ms);
        self.away_checks.observe(event);
        match event {
            papo::Event::MonitorOffline(offline) => {
                self.heard_from.remove(&offline.subject.nick());
            }
            papo::Event::Message(message) if message.actor_party != papo::Party::Me => {
                self.heard_from.insert(message.actor.nick());
            }
            papo::Event::Quit(quit) => {
                self.heard_from.remove(&quit.actor.nick());
            }
            papo::Event::NickChanged(changed) => {
                if self.heard_from.remove(&changed.old) {
                    self.heard_from.insert(changed.new.clone());
                }
            }
            papo::Event::Warning(papo::event::Warning::MonitorListFull { nicks, .. }) => {
                self.refused_watches.extend(nicks.iter().cloned());
            }
            papo::Event::Connected(_) | papo::Event::Disconnected(_) => {
                self.heard_from.clear();
                self.refused_watches.clear();
            }
            _ => {}
        }
    }

    /// Presence the network vouches for: a peer in a shared channel by its reported away state,
    /// and a peer known only through `MONITOR` as online, away or offline.
    pub(crate) fn presence(
        &self,
        state: &papo::State,
        nick: &papo::Nick,
        watched: bool,
    ) -> Option<PeerPresence> {
        let user = crate::name_key::known_user(state, nick);
        if let Some(user) = user.filter(|user| user.channels().len() != 0) {
            return self.reported_away(user);
        }
        if state.presence(nick).ok()? == papo::Presence::Offline {
            return Some(PeerPresence::Offline);
        }
        let reported_online = user.filter(|user| {
            state
                .monitor_online()
                .any(|online| online.nick() == user.nick())
        });
        if let Some(user) = reported_online {
            return Some(
                self.reported_away(user)
                    .unwrap_or_else(|| unreported_monitor_presence(state)),
            );
        }
        self.heard_while_watched(state, nick, watched).then(|| {
            user.and_then(|user| self.reported_away(user))
                .unwrap_or(PeerPresence::Online)
        })
    }

    /// A watched peer's own live line counts as online without waiting for the `MONITOR` reply,
    /// which a throttling server delays; the watch is what reports its departure, so one the
    /// server refused doesn't count. papo forgets a peer it shares no channel with until that
    /// reply, so this asks only what the connection heard. `watched` is the DM's own hold:
    /// papo's `monitored()` omits a watch until its driver next runs, and no event follows to
    /// resync the row.
    fn heard_while_watched(&self, state: &papo::State, nick: &papo::Nick, watched: bool) -> bool {
        let accepted = || {
            !self.refused_watches.contains(nick)
                || state.monitored().any(|monitored| monitored == nick)
        };
        watched
            && state.supports(papo::Feature::Monitor)
            && accepted()
            && self.heard_from.contains(nick)
    }

    pub(crate) fn away_checks(&mut self) -> &mut AwayChecks {
        &mut self.away_checks
    }

    /// When this connection saw the peer enter `presence`, for an away or offline peer.
    pub(crate) fn since(&self, nick: &papo::Nick, presence: Option<PeerPresence>) -> Option<i64> {
        presence
            .filter(|presence| *presence != PeerPresence::Online)
            .and_then(|presence| self.witnessed.since(nick, presence))
    }

    fn reported_away(&self, user: &papo::User) -> Option<PeerPresence> {
        match user.away() {
            papo::AwayStatus::Away { .. } => Some(PeerPresence::Away),
            papo::AwayStatus::Present => Some(PeerPresence::Online),
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
    crate::name_key::known_user(state, nick)
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
            | papo::Event::Warning(papo::event::Warning::MonitorListFull { .. })
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
    use crate::test_events::NextEvent;
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
        keep_watching(client.watch("alice"));
        assert_eq!(wire.next_sent().await, "MONITOR + alice");
        let nick = client
            .snapshot()
            .monitored()
            .next()
            .cloned()
            .expect("alice is monitored");
        (client, events, wire, nick)
    }

    /// The fixture's watch outlives the fixture, as a DM the test opens would keep it.
    pub(crate) fn keep_watching(watch: papo::Watch) {
        std::mem::forget(watch);
    }

    pub(crate) async fn next(events: &mut papo::Events, predicate: impl Fn(&papo::Event) -> bool) {
        while !predicate(
            &events
                .next_event()
                .await
                .expect("papo event stream remains open"),
        ) {}
    }
}

#[cfg(test)]
mod tests {
    use papo_testing::Wire;

    use super::test_support::{monitoring_alice, monitoring_alice_with, next};
    use crate::test_events::NextEvent;
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

        /// A DM whose handle resolved, so it holds its own watch on alice.
        async fn watched() -> Self {
            Self::monitored().await.resolved()
        }

        fn resolved(mut self) -> Self {
            let nick = self
                .model
                .direct_peer(self.alice)
                .expect("alice is a direct");
            let direct = super::DirectPeer::resolve(&self.client, &nick);
            self.model.resolve_direct(
                self.alice,
                DirectAvailability::Guarded(direct),
                &self.client.snapshot(),
            );
            self
        }

        /// A server that advertises no `MONITOR`, so nothing can watch alice.
        async fn without_monitor() -> Self {
            let (client, mut events, mut wire) =
                papo_testing::wire(papo::Client::builder("irc://offline.test", "weblounge"));
            wire.register(&["away-notify", "extended-monitor"]).await;
            next(&mut events, |event| {
                matches!(event, papo::Event::Connected(_))
            })
            .await;
            assert!(!client.watch("alice").is_live());
            let nick = client
                .snapshot()
                .name_rules()
                .expect("registered client knows the name rules")
                .nick("alice");
            Self::with_direct(client, events, wire, nick)
        }

        /// A server with `MONITOR` where nothing watches alice yet, as when her first line
        /// opens the DM.
        async fn monitor_available() -> Self {
            let (client, mut events, mut wire) =
                papo_testing::wire(papo::Client::builder("irc://offline.test", "weblounge"));
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
            let nick = client
                .snapshot()
                .name_rules()
                .expect("registered client knows the name rules")
                .nick("alice");
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
            let nick = crate::name_key::known_user(&client.snapshot(), "alice")
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
            let (alice, _) =
                model.open_direct(nick, DirectAvailability::Pending, &client.snapshot());
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
                    .next_event()
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
                .sync_direct_peers(&self.client.snapshot())
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
    async fn a_live_line_shows_a_watched_peer_online_before_monitor_answers() {
        let mut peer = Peer::watched().await;
        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);

        peer.report_connected().await;
        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_peer_whose_watch_the_server_refused_is_not_shown_online_by_its_line() {
        let mut peer = Peer::watched().await;
        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        _ = peer.sync();

        peer.server(
            ":offline.test 734 weblounge 100 alice :Monitor list is full",
            |event| {
                matches!(
                    event,
                    papo::Event::Warning(papo::event::Warning::MonitorListFull { .. })
                )
            },
        )
        .await;

        assert_eq!(peer.sync(), [(peer.alice, None)]);
    }

    #[tokio::test]
    async fn a_launch_watch_lets_a_live_line_show_an_unresolved_peer_online() {
        let mut peer = Peer::monitored().await;
        let nick = peer
            .model
            .direct_peer(peer.alice)
            .expect("alice is a direct");
        let watch = peer.client.watch(nick.as_str());
        peer.model.hold_launch_watches([(nick, watch)].into());

        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;

        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);
    }

    #[tokio::test]
    async fn without_monitor_a_resolved_peer_that_speaks_shows_no_presence() {
        let mut peer = Peer::without_monitor().await.resolved();

        peer.server(
            "@msgid=hi;time=2026-11-21T14:05:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_peer_watched_after_its_first_line_stays_online_when_another_peer_speaks() {
        let mut peer = Peer::monitor_available().await;
        peer.server(
            "@account=alice;msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        let mut peer = peer.resolved();
        assert_eq!(peer.wire.next_sent().await, "MONITOR + alice");
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Online))]);

        peer.server(
            "@account=bob;msgid=yo;time=2026-11-14T12:00:01.000Z :bob!~bob@cloak.example PRIVMSG weblounge :yo",
            message,
        )
        .await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn a_watched_peer_that_quits_after_speaking_is_not_shown_online() {
        let mut peer = Peer::watched().await;
        peer.server(
            "@msgid=hi;time=2026-11-14T12:00:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;
        _ = peer.sync();

        peer.server(":alice!~alice@cloak.example QUIT :bye", |event| {
            matches!(event, papo::Event::Quit(_))
        })
        .await;

        assert_eq!(peer.sync(), [(peer.alice, None)]);
    }

    #[tokio::test]
    async fn a_replayed_line_does_not_show_a_watched_peer_online() {
        let (client, events, wire, nick) = monitoring_alice_with(&[
            "away-notify",
            "extended-monitor",
            "draft/chathistory",
            "labeled-response",
            "batch",
            "server-time",
            "message-tags",
        ])
        .await;
        let mut peer = Peer::with_direct(client, events, wire, nick).resolved();
        peer.report_connected().await;
        assert_eq!(peer.sync(), [(peer.alice, Some(PeerPresence::Away))]);
        for line in [
            ":offline.test BATCH +playback chathistory alice",
            "@batch=playback;time=2026-11-14T12:00:00.000Z;msgid=old :alice!~alice@cloak.example PRIVMSG weblounge :hi",
        ] {
            peer.wire.server(line).await;
        }
        peer.server(":offline.test BATCH -playback", |event| {
            matches!(event, papo::Event::History(_))
        })
        .await;

        assert_eq!(peer.sync(), []);
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
        let (alice, _) = model.open_direct(nick, DirectAvailability::Pending, &client.snapshot());

        let updates = model.sync_direct_peers(&client.snapshot());

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
        let nick = peer
            .model
            .direct_peer(peer.alice)
            .expect("alice is a direct");
        let _held = super::DirectPeer::resolve(&peer.client, &nick);
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

    #[tokio::test]
    async fn without_monitor_a_peer_sharing_no_channel_shows_no_presence() {
        let mut peer = Peer::without_monitor().await;

        peer.server(
            "@msgid=hi;time=2026-11-21T14:05:00.000Z :alice!~alice@cloak.example PRIVMSG weblounge :hi",
            message,
        )
        .await;

        assert_eq!(peer.sync(), []);
    }

    #[tokio::test]
    async fn an_away_change_without_server_time_is_dated_when_it_arrived() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();
        let before = crate::state::time_millis(papo::time::now());

        peer.server(":alice!~alice@cloak.example AWAY :lunch", away_changed)
            .await;

        let after = crate::state::time_millis(papo::time::now());
        let [(Some(PeerPresence::Away), Some(since))] = peer.sync_since()[..] else {
            panic!("alice is away with a time");
        };
        assert!((before..=after).contains(&since));
    }

    #[tokio::test]
    async fn an_invalid_server_time_never_becomes_the_away_time() {
        let mut peer = Peer::monitored().await;
        peer.report_online().await;
        _ = peer.sync();
        let before = crate::state::time_millis(papo::time::now());

        peer.server(
            "@time=1999-99-99T99:99:99Z :alice!~alice@cloak.example AWAY :lunch",
            away_changed,
        )
        .await;

        let after = crate::state::time_millis(papo::time::now());
        let [(Some(PeerPresence::Away), Some(since))] = peer.sync_since()[..] else {
            panic!("alice is away with a time");
        };
        assert!((before..=after).contains(&since));
    }
}
