use serde::Deserialize;

use super::{
    AppBadgeConversation, ConversationBadge, ConversationKind, Divider, ReadFacts, ServerTimeMs,
    app_badge_count, conversation_badge, divider, mention_count, should_close_notification,
    unread_count,
};

const GOLDEN_FIXTURES: &str = include_str!("../../../../fixtures/read-state/read-model.json");

#[derive(Debug, Deserialize)]
struct FixtureFile {
    version: u8,
    cases: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
struct FixtureCase {
    name: String,
    kind: ConversationKind,
    muted: bool,
    facts: ReadFacts,
    divider_mark: Option<ServerTimeMs>,
    notification_checks: Vec<NotificationCheck>,
    expected: ExpectedProjection,
}

#[derive(Debug, Deserialize)]
struct NotificationCheck {
    same_conversation: bool,
    time: ServerTimeMs,
    close: bool,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
struct ExpectedProjection {
    unread: usize,
    mentions: usize,
    divider: Option<Divider>,
    badge: Option<ConversationBadge>,
    app_badge: usize,
}

#[test]
fn shared_json_fixtures_match_every_projection() {
    let fixtures: FixtureFile = serde_json::from_str(GOLDEN_FIXTURES).expect("valid fixtures");
    assert_eq!(fixtures.version, 1);

    for case in fixtures.cases {
        let actual = ExpectedProjection {
            unread: unread_count(&case.facts),
            mentions: mention_count(&case.facts, case.muted),
            divider: divider(&case.facts, case.divider_mark),
            badge: conversation_badge(&case.facts, case.muted),
            app_badge: app_badge_count([AppBadgeConversation {
                kind: case.kind,
                facts: &case.facts,
                muted: case.muted,
            }]),
        };
        assert_eq!(actual, case.expected, "fixture {}", case.name);

        for check in case.notification_checks {
            let notification_conversation = if check.same_conversation {
                "network/conversation"
            } else {
                "network/other"
            };
            assert_eq!(
                should_close_notification(
                    &notification_conversation,
                    check.time,
                    &"network/conversation",
                    case.facts.mark(),
                ),
                check.close,
                "notification check in fixture {}",
                case.name,
            );
        }
    }
}
