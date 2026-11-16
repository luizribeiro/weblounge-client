use serde_json::{Value, json};

use super::{PrepareError, prepare_notification, prepare_notification_json};
use crate::{
    DecryptError, ParsePushError, PreparedNotification, RouteMeta,
    decrypt::tests::{rfc_keys, rfc_record, seal_for_rfc_receiver},
};

const TIME: &str = "2026-11-16T09:41:07.512Z";

fn lounge() -> RouteMeta {
    RouteMeta {
        network_label: "Lounge".into(),
        nickname: "weblounge".into(),
    }
}

fn sealed_line(line: &str) -> Vec<u8> {
    seal_for_rfc_receiver(&[line.as_bytes(), b"\x02"].concat())
}

#[test]
fn prepares_an_encrypted_ergo_direct_message() {
    let record = sealed_line(&format!(
        "@account=mel;time={TIME};msgid=Rk3x :mel!~mel@example.test PRIVMSG weblounge :lunch at noon?"
    ));

    let Ok(PreparedNotification::Visible(notification)) =
        prepare_notification(&record, &rfc_keys(), &lounge())
    else {
        panic!("expected a visible notification");
    };

    assert_eq!(notification.title, "mel");
    assert_eq!(notification.body, "lunch at noon?");
    assert_eq!(notification.thread_id, "Lounge/mel");
    assert_eq!(notification.user_info.route, "/Lounge/@mel");
}

#[test]
fn prepares_an_encrypted_markread_as_a_control() {
    let record = sealed_line(&format!(":ergo.test MARKREAD #lounge timestamp={TIME}"));

    assert_eq!(
        prepare_notification(&record, &rfc_keys(), &lounge()),
        Ok(PreparedNotification::Markread {
            tag: "Lounge/#lounge".into(),
            until: format!("timestamp={TIME}"),
        })
    );
}

#[test]
fn separates_decrypt_failures_from_unsupported_lines() {
    let mut tampered = sealed_line("PING :push-registration");
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    let version = sealed_line(&format!(
        "@time={TIME};msgid=v :mel!m@example.test PRIVMSG weblounge :\u{1}VERSION\u{1}"
    ));

    assert_eq!(
        prepare_notification(&tampered, &rfc_keys(), &lounge()),
        Err(PrepareError::Decrypt(DecryptError::Authentication))
    );
    assert_eq!(
        prepare_notification(&version, &rfc_keys(), &lounge()),
        Err(PrepareError::Parse(ParsePushError::Unsupported))
    );
}

#[test]
fn reports_the_failed_stage_across_the_json_boundary() {
    let prepared: Value = serde_json::from_str(&prepare_notification_json(
        &sealed_line("PING :push-registration"),
        &rfc_keys(),
        &lounge(),
    ))
    .expect("json");
    let undecryptable: Value =
        serde_json::from_str(&prepare_notification_json(&[0; 40], &rfc_keys(), &lounge()))
            .expect("json");
    let not_irc: Value = serde_json::from_str(&prepare_notification_json(
        &rfc_record(),
        &rfc_keys(),
        &lounge(),
    ))
    .expect("json");

    assert_eq!(
        prepared,
        json!({ "outcome": "prepared", "notification": { "kind": "ping" } })
    );
    assert_eq!(
        undecryptable,
        json!({
            "outcome": "failed",
            "stage": "decrypt",
            "message": "encrypted push payload is truncated",
        })
    );
    assert_eq!(not_irc["stage"], "parse");
}

#[test]
fn decodes_invalid_utf8_lossily_like_text_decoder() {
    let line = [
        format!("@time={TIME};msgid=latin1 :mel!m@example.test PRIVMSG #lounge :caf").as_bytes(),
        b"\xe9 au lait\x02",
    ]
    .concat();

    let Ok(PreparedNotification::Visible(notification)) =
        prepare_notification(&seal_for_rfc_receiver(&line), &rfc_keys(), &lounge())
    else {
        panic!("expected a visible notification");
    };

    assert_eq!(notification.body, "caf\u{fffd} au lait");
}
