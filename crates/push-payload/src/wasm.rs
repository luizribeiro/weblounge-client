//! The wasm boundary the classic service worker loads.

use wasm_bindgen::prelude::wasm_bindgen;

use crate::{NotificationStrings, RouteKeys, RouteMeta, counted_body};

/// Decrypts, parses and formats one push; see [`crate::prepare_notification_json`].
#[wasm_bindgen]
#[must_use]
pub fn prepare_notification(
    ciphertext: &[u8],
    private_key_pkcs8: &[u8],
    auth: &[u8],
    network_label: &str,
    nickname: &str,
) -> String {
    crate::prepare_notification_json(
        ciphertext,
        &RouteKeys {
            private_key_pkcs8: private_key_pkcs8.to_vec(),
            auth: auth.to_vec(),
        },
        &RouteMeta {
            network_label: network_label.to_owned(),
            nickname: nickname.to_owned(),
        },
    )
}

/// Appends the unread-count line; see [`crate::counted_body`].
#[wasm_bindgen]
#[must_use]
pub fn counted_notification_body(body: &str, count: u32, new_messages: &str) -> String {
    counted_body(
        body,
        count,
        &NotificationStrings {
            new_messages: new_messages.to_owned(),
        },
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{counted_notification_body, prepare_notification};
    use crate::decrypt::tests::{rfc_keys, seal_for_rfc_receiver};

    #[test]
    fn prepares_from_the_flat_arguments_the_worker_passes() {
        let keys = rfc_keys();
        let record = seal_for_rfc_receiver(
            b"@time=2026-11-16T09:41:07.512Z;msgid=w1 :mel!m@example.test PRIVMSG #lounge :deploy is green\x02",
        );

        let outcome: Value = serde_json::from_str(&prepare_notification(
            &record,
            &keys.private_key_pkcs8,
            &keys.auth,
            "Lounge",
            "weblounge",
        ))
        .expect("json");

        assert_eq!(outcome["outcome"], "prepared");
        assert_eq!(outcome["notification"]["title"], "mel in #lounge");
        assert_eq!(outcome["notification"]["threadId"], "Lounge/#lounge");
    }

    #[test]
    fn counts_with_the_worker_supplied_template() {
        assert_eq!(
            counted_notification_body("deploy is green", 2, "· {count} new messages"),
            "deploy is green\n· 2 new messages"
        );
    }
}
