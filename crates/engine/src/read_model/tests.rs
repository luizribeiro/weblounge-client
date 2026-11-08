use super::{
    AppBadgeConversation, BadgeCount, BadgeKind, ConversationBadge, ConversationKind, Divider,
    MAX_STUBS, MessageStub, ReadFacts, ServerTimeMs, SetOnceMerge, app_badge_count,
    conversation_badge, divider, mention_count, merge_max, merge_set_once,
    should_close_notification, unread_count,
};

fn stub(msgid: impl Into<String>, time: i64, mention: bool) -> MessageStub {
    MessageStub {
        msgid: msgid.into(),
        time: ServerTimeMs::new(time),
        mention,
    }
}

#[test]
fn maximum_merge_never_moves_backwards() {
    let mut value = Some(ServerTimeMs::new(20));

    merge_max(&mut value, Some(ServerTimeMs::new(10)));
    merge_max(&mut value, Some(ServerTimeMs::new(30)));

    assert_eq!(value, Some(ServerTimeMs::new(30)));
}

#[test]
fn stub_union_is_order_independent_and_keeps_monotonic_fields() {
    let push = stub("message-1", 100, true);
    let history = stub("message-1", 101, false);
    let mut push_first = ReadFacts::default();
    let mut history_first = ReadFacts::default();

    push_first.merge_stub(push.clone());
    push_first.merge_stub(history.clone());
    history_first.merge_stub(history);
    history_first.merge_stub(push);

    assert_eq!(push_first, history_first);
    assert_eq!(push_first.stubs(), [stub("message-1", 101, true)]);
}

#[test]
fn mark_prunes_covered_stubs_inclusively() {
    let mut facts = ReadFacts::default();
    facts.merge_stub(stub("before", 9, false));
    facts.merge_stub(stub("tie", 10, false));
    facts.merge_stub(stub("after", 11, false));

    facts.merge_mark(ServerTimeMs::new(10));

    assert_eq!(facts.stubs(), [stub("after", 11, false)]);
}

#[test]
fn cap_keeps_the_newest_stubs_and_records_the_gap() {
    let mut facts = ReadFacts::default();
    for time in 0..=MAX_STUBS {
        let time = i64::try_from(time).expect("stub cap fits i64");
        facts.merge_stub(stub(format!("message-{time}"), time, false));
    }

    assert_eq!(facts.stubs().len(), MAX_STUBS);
    assert_eq!(facts.stubs()[0].time, ServerTimeMs::new(1));
    assert_eq!(facts.gap_until(), Some(ServerTimeMs::new(1)));
}

#[test]
fn fact_snapshots_merge_commutatively() {
    let mut left = ReadFacts::default();
    left.merge_mark(ServerTimeMs::new(10));
    left.merge_pending(ServerTimeMs::new(12));
    left.merge_stub(stub("later", 14, false));
    let mut right = ReadFacts::default();
    right.merge_mark(ServerTimeMs::new(11));
    right.merge_gap_until(ServerTimeMs::new(20));
    right.merge_stub(stub("mention", 13, true));

    let mut left_then_right = left.clone();
    left_then_right.merge(right.clone());
    right.merge(left);

    assert_eq!(left_then_right, right);
}

#[test]
fn server_acknowledgement_clears_only_covered_pending_reads() {
    let mut facts = ReadFacts::default();
    facts.merge_pending(ServerTimeMs::new(20));

    facts.acknowledge(ServerTimeMs::new(19));
    assert_eq!(facts.pending(), Some(ServerTimeMs::new(20)));

    facts.acknowledge(ServerTimeMs::new(20));
    assert_eq!(facts.pending(), None);
}

#[test]
fn set_once_accepts_retries_and_rejects_conflicts() {
    let mut value = None;

    assert_eq!(merge_set_once(&mut value, "seed"), SetOnceMerge::Set);
    assert_eq!(merge_set_once(&mut value, "seed"), SetOnceMerge::Unchanged);
    assert_eq!(merge_set_once(&mut value, "other"), SetOnceMerge::Conflict);
    assert_eq!(value, Some("seed"));
}

#[test]
fn count_is_the_number_of_known_peer_messages_strictly_after_the_mark() {
    let mut facts = ReadFacts::default();
    facts.merge_stub(stub("tie", 10, true));
    facts.merge_stub(stub("plain", 11, false));
    facts.merge_stub(stub("mention", 12, true));
    facts.merge_mark(ServerTimeMs::new(10));

    assert_eq!(unread_count(&facts), 2);
}

#[test]
fn mention_count_obeys_the_mark_and_muting() {
    let mut facts = ReadFacts::default();
    facts.merge_stub(stub("plain", 11, false));
    facts.merge_stub(stub("mention", 12, true));

    assert_eq!(mention_count(&facts, false), 1);
    assert_eq!(mention_count(&facts, true), 0);
}

#[test]
fn divider_uses_the_frozen_mark_and_gap() {
    let mut facts = ReadFacts::default();
    facts.merge_stub(stub("first", 11, false));
    facts.merge_stub(stub("second", 12, false));

    assert_eq!(
        divider(&facts, Some(ServerTimeMs::new(10))),
        Some(Divider::Before {
            msgid: "first".into()
        })
    );
    assert_eq!(divider(&facts, None), None);

    facts.merge_gap_until(ServerTimeMs::new(11));
    assert_eq!(
        divider(&facts, Some(ServerTimeMs::new(10))),
        Some(Divider::AtTop)
    );
}

#[test]
fn conversation_badge_projects_exact_capped_and_mention_states() {
    let mut exact = ReadFacts::default();
    exact.merge_stub(stub("mention", 11, true));
    assert_eq!(
        conversation_badge(&exact, false),
        Some(ConversationBadge {
            count: BadgeCount::Exact(1),
            kind: BadgeKind::Mention,
        })
    );
    assert_eq!(
        conversation_badge(&exact, true),
        Some(ConversationBadge {
            count: BadgeCount::Exact(1),
            kind: BadgeKind::Unread,
        })
    );

    let mut capped = ReadFacts::default();
    capped.merge_gap_until(ServerTimeMs::new(20));
    assert_eq!(
        conversation_badge(&capped, false),
        Some(ConversationBadge {
            count: BadgeCount::MoreThan99,
            kind: BadgeKind::Unread,
        })
    );
}

#[test]
fn app_badge_sums_direct_unread_and_channel_mentions() {
    let mut direct = ReadFacts::default();
    direct.merge_stub(stub("dm-1", 11, true));
    direct.merge_stub(stub("dm-2", 12, true));
    let mut channel = ReadFacts::default();
    channel.merge_stub(stub("plain", 13, false));
    channel.merge_stub(stub("highlight", 14, true));

    assert_eq!(
        app_badge_count([
            AppBadgeConversation {
                kind: ConversationKind::Direct,
                facts: &direct,
                muted: false,
            },
            AppBadgeConversation {
                kind: ConversationKind::Channel,
                facts: &channel,
                muted: false,
            },
        ]),
        3
    );
}

#[test]
fn notification_close_is_conversation_scoped_and_inclusive() {
    let conversation = "network/#room";

    assert!(should_close_notification(
        &conversation,
        ServerTimeMs::new(10),
        &conversation,
        Some(ServerTimeMs::new(10))
    ));
    assert!(!should_close_notification(
        &"network/other",
        ServerTimeMs::new(10),
        &conversation,
        Some(ServerTimeMs::new(20))
    ));
    assert!(!should_close_notification(
        &conversation,
        ServerTimeMs::new(11),
        &conversation,
        Some(ServerTimeMs::new(10))
    ));
}
