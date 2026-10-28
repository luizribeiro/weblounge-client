use crate::{BufferId, EngineToUi, MemberGroup, MemberProjection, state::nick_color_index};

pub(crate) const WINDOW_SIZE: u32 = 256;

#[derive(Default)]
pub(crate) struct Changes {
    channels: Vec<papo::ChannelName>,
    scheduled: bool,
}

impl Changes {
    pub(crate) fn record(&mut self, event: &papo::Event, state: &papo::State) -> bool {
        let channels = affected_channels(event, state);
        for channel in channels {
            if !self.channels.contains(&channel) {
                self.channels.push(channel);
            }
        }
        if self.channels.is_empty() || self.scheduled {
            return false;
        }
        self.scheduled = true;
        true
    }

    pub(crate) fn drain(&mut self) -> Vec<papo::ChannelName> {
        self.scheduled = false;
        std::mem::take(&mut self.channels)
    }
}

fn affected_channels(event: &papo::Event, state: &papo::State) -> Vec<papo::ChannelName> {
    match event {
        papo::Event::Connected(_) | papo::Event::Lagged(_) | papo::Event::CasemappingChanged(_) => {
            state
                .channels()
                .map(|channel| channel.name().clone())
                .collect()
        }
        papo::Event::ChannelSynced(event) => vec![event.channel.clone()],
        papo::Event::MembersRefreshed(event) => vec![event.channel.clone()],
        papo::Event::Joined(event) => vec![event.channel.clone()],
        papo::Event::Parted(event) => vec![event.channel.clone()],
        papo::Event::Kicked(event) => vec![event.channel.clone()],
        papo::Event::Quit(event) => event.channels.clone(),
        papo::Event::NickChanged(event) => event.channels.clone(),
        papo::Event::AwayChanged(event) => channels_for_nick(state, event.actor.nick()),
        papo::Event::AccountChanged(event) => channels_for_nick(state, event.actor.nick()),
        papo::Event::ModeChanged(event) => event.subject.channel().map_or_else(
            || {
                event
                    .subject
                    .nick()
                    .map_or_else(Vec::new, |nick| channels_for_nick(state, nick))
            },
            |channel| vec![channel.clone()],
        ),
        _ => Vec::new(),
    }
}

fn channels_for_nick(state: &papo::State, nick: &papo::Nick) -> Vec<papo::ChannelName> {
    state
        .user(nick)
        .into_iter()
        .flat_map(papo::User::channels)
        .cloned()
        .collect()
}

pub(crate) fn project(
    state: &papo::State,
    channel: &papo::ChannelName,
    buffer_id: BufferId,
    view_id: &str,
    version: u64,
    offset: u32,
    filter: &str,
) -> Option<EngineToUi> {
    let folded_filter = state.casemapping().fold(filter);
    let mut rows = state
        .channel(channel)?
        .members()
        .filter(|member| {
            state
                .casemapping()
                .fold(member.nick().as_ref())
                .contains(folded_filter.as_ref())
        })
        .map(|member| {
            let user = state.user(member.nick());
            let away = user.is_some_and(|user| matches!(user.away(), papo::Away::Away { .. }));
            let bot = user.and_then(papo::User::is_bot) == Some(true);
            let group = classify(member, away, bot);
            (group, member, user, away, bot)
        })
        .collect::<Vec<_>>();
    rows.sort_by(|first, second| {
        order(first.0)
            .cmp(&order(second.0))
            .then_with(|| first.1.nick().cmp(second.1.nick()))
    });
    let mut counts = [0; 5];
    for (group, ..) in &rows {
        counts[order(*group)] += 1;
    }
    let total = u32::try_from(rows.len()).unwrap_or(u32::MAX);
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let take = usize::try_from(WINDOW_SIZE).unwrap_or(usize::MAX);
    let members = rows
        .into_iter()
        .skip(start)
        .take(take)
        .map(|(group, member, user, away, bot)| MemberProjection {
            group,
            nick: member.nick().to_string(),
            mode_symbol: member.prefixes().first().map(|prefix| prefix.symbol()),
            away,
            bot,
            account: user
                .and_then(|user| user.account().name())
                .map(ToString::to_string),
            nick_color_index: nick_color_index(state.casemapping(), member.nick()),
            is_you: member.nick() == state.nick(),
        })
        .collect();
    Some(EngineToUi::MembersChanged {
        buffer_id,
        view_id: view_id.to_owned(),
        version,
        window_size: WINDOW_SIZE,
        offset: u32::try_from(start).unwrap_or(u32::MAX),
        total,
        counts,
        members,
        filter: (!filter.is_empty()).then(|| filter.to_owned()),
    })
}

fn classify(member: &papo::Member, away: bool, bot: bool) -> MemberGroup {
    if bot {
        MemberGroup::Bots
    } else if away {
        MemberGroup::Away
    } else if member.rank() >= Some(papo::Rank::Op) {
        MemberGroup::Operators
    } else if !member.prefixes().is_empty() {
        MemberGroup::Voiced
    } else {
        MemberGroup::Online
    }
}

const fn order(group: MemberGroup) -> usize {
    match group {
        MemberGroup::Operators => 0,
        MemberGroup::Voiced => 1,
        MemberGroup::Online => 2,
        MemberGroup::Away => 3,
        MemberGroup::Bots => 4,
    }
}

#[cfg(test)]
mod tests {
    use papo_testing::wire;

    use super::{Changes, project};
    use crate::{BufferId, EngineToUi, MemberGroup};

    fn assert_channel_change(changes: &mut Changes, event: &papo::Event, state: &papo::State) {
        assert!(changes.record(event, state));
        assert_eq!(changes.drain(), [state.name_rules().channel("#room")]);
    }

    #[tokio::test]
    async fn projects_realistic_multi_prefix_names_and_user_facts() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[
            "account-notify",
            "away-notify",
            "message-tags",
            "multi-prefix",
        ])
        .await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@h JOIN #room").await;
        wire.server(
            ":offline.test 353 weblounge = #room :@+Alpha +bravo charlie service @weblounge",
        )
        .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        while !matches!(events.next().await, Some(papo::Event::ChannelSynced(_))) {}
        wire.server(":Alpha!u@h ACCOUNT alice").await;
        wire.server(":charlie!u@h AWAY :lunch").await;
        wire.server("@bot :service!u@h PRIVMSG #room :ready").await;
        for _ in 0..3 {
            _ = events.next().await;
        }

        let channel = client.state().name_rules().channel("#room");
        let Some(EngineToUi::MembersChanged {
            counts,
            total,
            members,
            ..
        }) = project(&client.state(), &channel, BufferId(7), "test", 0, 1, "")
        else {
            panic!("member window")
        };
        assert_eq!(counts, [2, 1, 0, 1, 1]);
        assert_eq!(total, 5);
        assert_eq!(
            members
                .iter()
                .map(|member| member.nick.as_str())
                .collect::<Vec<_>>(),
            ["weblounge", "bravo", "charlie", "service"]
        );
        assert_eq!(members[0].group, MemberGroup::Operators);
        assert_eq!(members[1].mode_symbol, Some('+'));
        assert!(members[2].away);
    }

    #[tokio::test]
    async fn caps_a_two_thousand_member_channel_to_one_window() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["multi-prefix"]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@h JOIN #large").await;
        wire.server(":offline.test 353 weblounge = #large :@weblounge")
            .await;
        wire.server(":offline.test 366 weblounge #large :End of NAMES")
            .await;
        while !matches!(events.next().await, Some(papo::Event::ChannelSynced(_))) {}
        for index in 0..2_000 {
            wire.server(format!(":u{index:04}!u@h JOIN #large")).await;
            while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        }

        let channel = client.state().name_rules().channel("#large");
        let Some(EngineToUi::MembersChanged {
            counts,
            total,
            members,
            ..
        }) = project(&client.state(), &channel, BufferId(8), "test", 0, 1_000, "")
        else {
            panic!("member window")
        };
        assert_eq!(counts, [1, 0, 2_000, 0, 0]);
        assert_eq!(total, 2_001);
        assert_eq!(members.len(), 256);
    }

    #[tokio::test]
    async fn coalesces_a_five_hundred_quit_netsplit_to_one_patch() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@h JOIN #large").await;
        wire.server(":offline.test 353 weblounge = #large :weblounge")
            .await;
        wire.server(":offline.test 366 weblounge #large :End of NAMES")
            .await;
        while !matches!(events.next().await, Some(papo::Event::ChannelSynced(_))) {}
        for index in 0..500 {
            wire.server(format!(":u{index:03}!u@h JOIN #large")).await;
            while !matches!(events.next().await, Some(papo::Event::Joined(_))) {}
        }

        let mut changes = Changes::default();
        let mut scheduled = 0;
        for index in 0..500 {
            wire.server(format!(":u{index:03}!u@h QUIT :split")).await;
            let event = loop {
                if let Some(event @ papo::Event::Quit(_)) = events.next().await {
                    break event;
                }
            };
            scheduled += usize::from(changes.record(&event, &client.state()));
        }

        assert_eq!(scheduled, 1);
        assert_eq!(
            changes.drain(),
            [client.state().name_rules().channel("#large")]
        );
    }

    #[tokio::test]
    async fn tracks_all_live_member_fact_changes_from_wire_events() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&["away-notify", "multi-prefix"]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":offline.test 005 weblounge BOT=B :supported")
            .await;
        wire.server(":weblounge!u@h JOIN #room").await;
        wire.server(":offline.test 353 weblounge = #room :@weblounge +voice quitter service")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        while !matches!(events.next().await, Some(papo::Event::ChannelSynced(_))) {}

        let mut changes = Changes::default();
        for (line, expected) in [
            (":joiner!u@h JOIN #room", "join"),
            (":weblounge!u@h MODE #room +o joiner", "mode"),
            (":weblounge!u@h MODE #room -v voice", "mode"),
            (":joiner!u@h AWAY :lunch", "away"),
            (":joiner!u@h NICK renamed", "nick"),
            (":voice!u@h PART #room :bye", "part"),
            (":quitter!u@h QUIT :gone", "quit"),
            (":offline.test MODE weblounge +B", "mode"),
        ] {
            wire.server(line).await;
            let event = events.next().await.expect("typed member event");
            let kind = match event {
                papo::Event::Joined(_) => "join",
                papo::Event::ModeChanged(_) => "mode",
                papo::Event::AwayChanged(_) => "away",
                papo::Event::NickChanged(_) => "nick",
                papo::Event::Parted(_) => "part",
                papo::Event::Quit(_) => "quit",
                _ => "other",
            };
            assert_eq!(kind, expected);
            assert_channel_change(&mut changes, &event, &client.state());
        }

        let channel = client.state().name_rules().channel("#room");
        let Some(EngineToUi::MembersChanged { members, .. }) =
            project(&client.state(), &channel, BufferId(9), "test", 0, 0, "")
        else {
            panic!("member window")
        };
        assert_eq!(
            members
                .iter()
                .find(|member| member.nick == "weblounge")
                .map(|member| member.group),
            Some(MemberGroup::Bots)
        );
    }

    #[tokio::test]
    async fn filters_member_windows_with_the_servers_casemapping() {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(&[]).await;
        while !matches!(events.next().await, Some(papo::Event::Connected(_))) {}
        wire.server(":weblounge!u@h JOIN #room").await;
        wire.server(":offline.test 353 weblounge = #room :weblounge [Garden]")
            .await;
        wire.server(":offline.test 366 weblounge #room :End of NAMES")
            .await;
        while !matches!(events.next().await, Some(papo::Event::ChannelSynced(_))) {}

        let channel = client.state().name_rules().channel("#room");
        let Some(EngineToUi::MembersChanged {
            total,
            members,
            filter,
            ..
        }) = project(
            &client.state(),
            &channel,
            BufferId(10),
            "test",
            0,
            0,
            "{garden}",
        )
        else {
            panic!("filtered member window")
        };
        assert_eq!(total, 1);
        assert_eq!(members[0].nick, "[Garden]");
        assert_eq!(filter.as_deref(), Some("{garden}"));
    }
}
