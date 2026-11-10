use proptest::prelude::*;

use super::{
    AppBadgeConversation, ConversationKind, Divider, MessageStub, ReadFacts, ServerTimeMs,
    app_badge_count, conversation_badge, divider, mention_count, unread_count,
};

#[derive(Clone, Debug)]
enum Input {
    Push(MessageStub),
    History(MessageStub),
    Live(MessageStub),
    ServerMark(ServerTimeMs),
    Read(ServerTimeMs),
    OwnMessage(ServerTimeMs),
}

#[derive(Debug, Eq, PartialEq)]
struct Projection {
    unread: usize,
    mentions: usize,
    divider: Option<Divider>,
    badge: Option<super::ConversationBadge>,
    app_badge: usize,
}

fn stub(msgid: impl Into<String>, time: i64, mention: bool) -> MessageStub {
    MessageStub {
        msgid: msgid.into(),
        time: ServerTimeMs::new(time),
        provisional_time: None,
        mention,
    }
}

fn apply(facts: &mut ReadFacts, input: Input) {
    match input {
        Input::Push(stub) | Input::History(stub) | Input::Live(stub) => {
            facts.merge_stub(stub);
        }
        Input::ServerMark(mark) => facts.merge_mark(mark),
        Input::Read(mark) | Input::OwnMessage(mark) => {
            facts.merge_mark(mark);
            facts.merge_pending(mark);
        }
    }
}

fn fold(inputs: impl IntoIterator<Item = Input>) -> ReadFacts {
    let mut facts = ReadFacts::default();
    for input in inputs {
        apply(&mut facts, input);
    }
    facts
}

fn project(facts: &ReadFacts) -> Projection {
    Projection {
        unread: unread_count(facts),
        mentions: mention_count(facts, false),
        divider: divider(facts, facts.mark()),
        badge: conversation_badge(facts, false),
        app_badge: app_badge_count([AppBadgeConversation {
            kind: ConversationKind::Channel,
            facts,
            muted: false,
        }]),
    }
}

proptest! {
    #[test]
    fn any_input_permutation_has_the_same_projection(
        push_time in 1_i64..1_000,
        history_offset in 0_i64..3,
        live_offset in 1_i64..50,
        server_offset in 0_i64..20,
        read_offset in 0_i64..40,
        own_offset in 0_i64..40,
        priorities in prop::array::uniform6(any::<u16>()),
    ) {
        let inputs = vec![
            Input::Push(stub("duplicate", push_time, true)),
            Input::History(stub("duplicate", push_time + history_offset, false)),
            Input::Live(stub("live", push_time + live_offset, false)),
            Input::ServerMark(ServerTimeMs::new(push_time + server_offset)),
            Input::Read(ServerTimeMs::new(push_time + read_offset)),
            Input::OwnMessage(ServerTimeMs::new(push_time + own_offset)),
        ];
        let expected = project(&fold(inputs.clone()));
        let mut permutation: Vec<_> = inputs.into_iter().enumerate().collect();
        permutation.sort_by_key(|(index, _)| (priorities[*index], *index));

        let actual = project(&fold(permutation.into_iter().map(|(_, input)| input)));

        prop_assert_eq!(actual, expected);
    }

    #[test]
    fn count_equals_known_peer_messages_after_the_mark(
        peer_times in prop::collection::vec(0_i64..2_000, 0..40),
        server_mark in 0_i64..2_000,
        read_mark in 0_i64..2_000,
        own_message in 0_i64..2_000,
    ) {
        let mark = server_mark.max(read_mark).max(own_message);
        let expected = peer_times.iter().filter(|time| **time > mark).count();
        let mut inputs = Vec::with_capacity(peer_times.len() + 3);
        inputs.extend(peer_times.into_iter().enumerate().map(|(index, time)| {
            Input::Live(stub(format!("peer-{index}"), time, index % 3 == 0))
        }));
        inputs.push(Input::ServerMark(ServerTimeMs::new(server_mark)));
        inputs.push(Input::Read(ServerTimeMs::new(read_mark)));
        inputs.push(Input::OwnMessage(ServerTimeMs::new(own_message)));

        prop_assert_eq!(unread_count(&fold(inputs)), expected);
    }
}
