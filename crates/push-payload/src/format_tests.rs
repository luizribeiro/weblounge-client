use serde_json::json;

use super::{
    NotificationStrings, PreparedNotification, PushedMessageKind, RouteMeta, VisibleNotification,
    counted_body, notification_for,
};
use crate::parse_push_payload;

const TIME: &str = "2026-11-03T12:34:56.789Z";

fn lounge() -> RouteMeta {
    RouteMeta {
        network_label: "Lounge".into(),
        nickname: "weblounge".into(),
    }
}

fn prepared(line: &str) -> PreparedNotification {
    notification_for(parse_push_payload(line).expect("fixture parses"), &lounge())
}

fn visible(line: &str) -> VisibleNotification {
    match prepared(line) {
        PreparedNotification::Visible(notification) => *notification,
        other => panic!("expected a visible notification, got {other:?}"),
    }
}

#[test]
fn formats_captured_ergo_chat_lines_like_the_service_worker() {
    let cases = [
        (
            format!(
                "@account=mel;time={TIME};msgid=priv :mel!m@example.test PRIVMSG #lounge :hello there"
            ),
            "mel in #lounge",
            "hello there",
            "Lounge/#lounge",
            "/Lounge/lounge",
        ),
        (
            format!(
                "@time={TIME};msgid=notice :NickServ!s@example.test NOTICE weblounge :identify first"
            ),
            "NickServ",
            "identify first",
            "Lounge/nickserv",
            "/Lounge/@NickServ",
        ),
        (
            format!(
                "@time={TIME};msgid=action :mel!m@example.test PRIVMSG #lounge :\u{1}ACTION waves\u{1}"
            ),
            "mel in #lounge",
            "* mel waves",
            "Lounge/#lounge",
            "/Lounge/lounge",
        ),
        (
            format!(
                "@account=mel;time={TIME};msgid=emoji :mel!m@example.test PRIVMSG #lounge :ship it 🚀"
            ),
            "mel in #lounge",
            "ship it 🚀",
            "Lounge/#lounge",
            "/Lounge/lounge",
        ),
    ];

    for (line, title, body, tag, route) in cases {
        let notification = visible(&line);
        assert_eq!(
            (
                notification.title.as_str(),
                notification.body.as_str(),
                notification.thread_id.as_str()
            ),
            (title, body, tag),
            "{line}"
        );
        assert_eq!(
            serde_json::to_value(&notification.user_info).expect("serializes"),
            json!({
                "route": route,
                "conversationTag": tag,
                "messageId": notification.pushed.as_ref().map(|message| &message.msgid),
                "messageTime": TIME,
            })
        );
    }
}

#[test]
fn keeps_the_pushed_message_in_the_engine_cache_record_shape() {
    let notification = visible(&format!(
        "@account=louro;time={TIME};msgid=dm-7 :louro-pi!l@example.test PRIVMSG weblounge :are you around?"
    ));

    assert_eq!(
        serde_json::to_value(notification.pushed).expect("serializes"),
        json!({
            "schema": 1,
            "network_label": "Lounge",
            "nickname": "weblounge",
            "route": "/Lounge/@louro-pi",
            "sender": "louro-pi",
            "account": "louro",
            "target": "weblounge",
            "msgid": "dm-7",
            "time": TIME,
            "text": "are you around?",
            "kind": "message",
        })
    );
}

#[test]
fn matches_the_own_nick_under_rfc1459_casemapping() {
    let route = RouteMeta {
        network_label: "Lounge".into(),
        nickname: "luiz[away]~".into(),
    };
    let cases = [
        ("LUIZ{AWAY}^", true),
        ("Luiz[Away]~", true),
        ("lúiz[away]~", false),
        ("luiz[away]~_", false),
    ];

    for (target, direct) in cases {
        let line =
            format!("@time={TIME};msgid=dm :mel!m@example.test PRIVMSG {target} :still there?");
        let PreparedNotification::Visible(notification) =
            notification_for(parse_push_payload(&line).expect("parses"), &route)
        else {
            panic!("expected a visible notification");
        };
        let expected = if direct {
            "mel".to_owned()
        } else {
            format!("mel in {target}")
        };
        assert_eq!(notification.title, expected, "{target}");
    }
}

#[test]
fn percent_encodes_routes_like_encode_uri_component() {
    let route = RouteMeta {
        network_label: "Libera Chat".into(),
        nickname: "weblounge".into(),
    };
    let line = format!("@time={TIME};msgid=x :mel!m@example.test PRIVMSG #café/ops? :hi");

    let PreparedNotification::Visible(notification) =
        notification_for(parse_push_payload(&line).expect("parses"), &route)
    else {
        panic!("expected a visible notification");
    };

    assert_eq!(
        notification.user_info.route,
        "/Libera%20Chat/caf%C3%A9%2Fops%3F"
    );
    assert_eq!(notification.thread_id, "Libera Chat/#café/ops?");
}

#[test]
fn formats_an_invite_without_a_pushed_message() {
    let notification = visible(":mel!m@example.test INVITE weblounge #Secret");

    assert_eq!(notification.title, "mel");
    assert_eq!(notification.body, "Invited you to #Secret");
    assert_eq!(notification.thread_id, "Lounge/#secret");
    assert_eq!(
        serde_json::to_value(&notification.user_info).expect("serializes"),
        json!({ "route": "/Lounge/Secret" })
    );
    assert_eq!(notification.pushed, None);
}

#[test]
fn turns_markread_and_ping_into_silent_controls() {
    assert_eq!(
        prepared(&format!(
            ":irc.example.test MARKREAD #Lounge timestamp={TIME}"
        )),
        PreparedNotification::Markread {
            tag: "Lounge/#lounge".into(),
            until: format!("timestamp={TIME}"),
        }
    );
    assert_eq!(
        prepared("PING :push-registration"),
        PreparedNotification::Ping
    );
}

#[test]
fn records_the_kind_of_chat_line() {
    let notice = visible(&format!(
        "@time={TIME};msgid=n :ChanServ!s@example.test NOTICE #lounge :topic locked"
    ));

    assert_eq!(
        notice.pushed.map(|message| message.kind),
        Some(PushedMessageKind::Notice)
    );
}

#[test]
fn adds_the_count_line_only_for_several_messages() {
    let strings = NotificationStrings {
        new_messages: "· {count} new messages".into(),
    };

    assert_eq!(
        counted_body("latest from iris", 0, &strings),
        "latest from iris"
    );
    assert_eq!(
        counted_body("latest from iris", 1, &strings),
        "latest from iris"
    );
    assert_eq!(
        counted_body("latest from iris", 3, &strings),
        "latest from iris\n· 3 new messages"
    );
}

#[test]
fn serializes_for_the_platform_boundaries() {
    assert_eq!(
        serde_json::to_value(prepared("PING :push-registration")).expect("serializes"),
        json!({ "kind": "ping" })
    );
    assert_eq!(
        serde_json::to_value(prepared(":mel!m@example.test INVITE weblounge #lounge"))
            .expect("serializes"),
        json!({
            "kind": "visible",
            "title": "mel",
            "body": "Invited you to #lounge",
            "threadId": "Lounge/#lounge",
            "userInfo": { "route": "/Lounge/lounge" },
            "pushed": null,
        })
    );
}

#[test]
fn formats_a_direct_action_with_the_sender_as_title() {
    let notification = visible(&format!(
        "@time={TIME};msgid=dm-action :Mel!m@example.test PRIVMSG weblounge :\u{1}ACTION waves at you\u{1}"
    ));

    assert_eq!(notification.title, "Mel");
    assert_eq!(notification.body, "* Mel waves at you");
    assert_eq!(notification.thread_id, "Lounge/mel");
    assert_eq!(notification.user_info.route, "/Lounge/@Mel");
}

#[test]
fn lowercases_non_ascii_letters_in_conversation_tags() {
    let notification = visible(&format!(
        "@time={TIME};msgid=cafe :mel!m@example.test PRIVMSG #CAFÉ :bonjour"
    ));

    assert_eq!(notification.thread_id, "Lounge/#café");
}

#[test]
fn tags_a_direct_markread_by_the_peer() {
    assert_eq!(
        prepared(&format!(":ergo.test MARKREAD Mel timestamp={TIME}")),
        PreparedNotification::Markread {
            tag: "Lounge/mel".into(),
            until: format!("timestamp={TIME}"),
        }
    );
}

#[test]
fn keeps_a_missing_account_as_null_in_the_record() {
    let notification = visible(&format!(
        "@time={TIME};msgid=anon :guest!g@example.test PRIVMSG #lounge :hi all"
    ));

    assert_eq!(
        serde_json::to_value(notification.pushed).expect("serializes")["account"],
        serde_json::Value::Null
    );
}

#[test]
fn leaves_a_count_template_without_a_placeholder_as_written() {
    let strings = NotificationStrings {
        new_messages: "· more new messages".into(),
    };

    assert_eq!(
        counted_body("latest", 4, &strings),
        "latest\n· more new messages"
    );
}
