use crate::{BufferId, EngineToUi, MemberGroup, MemberProjection, state::nick_color_index};

const MAX_WINDOW: u32 = 256;

pub(crate) fn project(
    state: &papo::State,
    channel: &papo::ChannelName,
    buffer_id: BufferId,
    offset: u32,
    limit: u32,
) -> Option<EngineToUi> {
    let mut rows = state
        .channel(channel)?
        .members()
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
    let take = usize::try_from(limit.min(MAX_WINDOW)).unwrap_or(usize::MAX);
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
        offset: u32::try_from(start).unwrap_or(u32::MAX),
        total,
        counts,
        members,
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

    use super::project;
    use crate::{BufferId, EngineToUi, MemberGroup};

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
        }) = project(&client.state(), &channel, BufferId(7), 1, 3)
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
            ["weblounge", "bravo", "charlie"]
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
        }) = project(&client.state(), &channel, BufferId(8), 1_000, 1_000)
        else {
            panic!("member window")
        };
        assert_eq!(counts, [1, 0, 2_000, 0, 0]);
        assert_eq!(total, 2_001);
        assert_eq!(members.len(), 256);
    }
}
