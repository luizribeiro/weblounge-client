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
    mark: Option<ServerTimeMs>,
    raw_mark: Option<ServerTimeMs>,
    pending: Option<ServerTimeMs>,
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

fn reconciled_stub(msgid: &str, provisional: i64, authoritative: i64) -> MessageStub {
    MessageStub {
        provisional_time: Some(ServerTimeMs::new(provisional)),
        ..stub(msgid, authoritative, false)
    }
}

fn provisional_stub(msgid: &str, time: i64) -> MessageStub {
    MessageStub {
        provisional_time: Some(ServerTimeMs::new(time)),
        ..stub(msgid, time, false)
    }
}

fn apply(facts: &mut ReadFacts, input: Input) {
    let previous_mark = facts.mark();
    match input {
        Input::Push(stub) | Input::History(stub) | Input::Live(stub) => {
            facts.merge_stub(stub);
        }
        Input::ServerMark(mark) => {
            facts.merge_mark(mark);
            if facts.mark() > previous_mark.map(|known| known.max(mark)) {
                facts.merge_pending(facts.mark().expect("carried mark"));
            }
        }
        Input::Read(mark) | Input::OwnMessage(mark) => {
            facts.merge_mark(mark);
            facts.merge_pending(facts.mark().expect("merged mark"));
        }
    }
    if facts.mark() > previous_mark
        && previous_mark.is_some()
        && let Some(pending) = facts.pending()
    {
        facts.merge_pending(pending.max(facts.mark().expect("advanced mark")));
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
        mark: facts.mark(),
        raw_mark: facts.raw_mark(),
        pending: facts.pending(),
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
        history_offset in 0_i64..1_001,
        chained_offset in 0_i64..1_001,
        live_offset in 1_i64..50,
        server_offset in 0_i64..20,
        read_offset in 0_i64..40,
        own_offset in 0_i64..40,
        priorities in prop::collection::vec(any::<u16>(), 8),
    ) {
        let history_time = push_time + history_offset;
        let chained_time = history_time + chained_offset;
        let inputs = vec![
            Input::Push(provisional_stub("duplicate", push_time)),
            Input::History(reconciled_stub("duplicate", push_time, history_time)),
            Input::Push(provisional_stub("chained", history_time)),
            Input::History(reconciled_stub("chained", history_time, chained_time)),
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
        peer_times in prop::collection::vec((0_i64..2_000, 0_i64..1_001), 0..40),
        server_mark in 0_i64..2_000,
        read_mark in 0_i64..2_000,
        own_message in 0_i64..2_000,
    ) {
        let mut authoritative = Vec::with_capacity(peer_times.len());
        let mut inputs = Vec::with_capacity(peer_times.len() + 3);
        inputs.extend(peer_times.into_iter().enumerate().map(|(index, (time, offset))| {
            let authoritative_time = time + offset;
            authoritative.push(authoritative_time);
            Input::History(reconciled_stub(&format!("peer-{index}"), time, authoritative_time))
        }));
        inputs.push(Input::ServerMark(ServerTimeMs::new(server_mark)));
        inputs.push(Input::Read(ServerTimeMs::new(read_mark)));
        inputs.push(Input::OwnMessage(ServerTimeMs::new(own_message)));

        let facts = fold(inputs);
        let mark = facts.mark().expect("generated marks are present");
        let expected = authoritative.iter().filter(|time| **time > mark.value()).count();

        prop_assert_eq!(unread_count(&facts), expected);
    }
}
