//! The Swift side's raw answers, and how each becomes the bridge type the page receives.

use serde::Deserialize;
use serde_json::Value;
use weblounge_native_bridge::{ApnsEnvironment, ApnsToken, DeliveredNotification, PushTarget};

/// The device token and what decides its APNs host.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    token: ApnsToken,
    simulator: bool,
    profile_aps_environment: Option<String>,
}

impl Registration {
    /// A development profile, or the simulator, which has none, registers with the sandbox.
    /// App Store and `TestFlight` builds carry no embedded profile and use production.
    pub fn into_target(self) -> PushTarget {
        let sandbox =
            self.simulator || self.profile_aps_environment.as_deref() == Some("development");
        PushTarget::Apns {
            token: self.token,
            environment: if sandbox {
                ApnsEnvironment::Sandbox
            } else {
                ApnsEnvironment::Production
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDelivered {
    identifier: String,
    user_info: Value,
}

#[derive(Deserialize)]
pub struct Delivered {
    notifications: Vec<RawDelivered>,
}

impl Delivered {
    /// A `userInfo` without valid notification data, such as APNs' placeholder, has no data.
    pub fn into_notifications(self) -> Vec<DeliveredNotification> {
        self.notifications
            .into_iter()
            .map(|raw| DeliveredNotification {
                identifier: raw.identifier,
                data: serde_json::from_value(raw.user_info).ok(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weblounge_native_bridge::NotificationData;

    use super::*;

    const TOKEN: &str = "740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad";

    fn environment(simulator: bool, profile: Option<&str>) -> ApnsEnvironment {
        let registration: Registration = serde_json::from_value(json!({
            "token": TOKEN,
            "simulator": simulator,
            "profileApsEnvironment": profile,
        }))
        .expect("parses");
        let PushTarget::Apns { token, environment } = registration.into_target();
        assert_eq!(token.as_str(), TOKEN);
        environment
    }

    #[test]
    fn the_profile_or_the_simulator_picks_the_apns_host() {
        assert_eq!(environment(true, None), ApnsEnvironment::Sandbox);
        assert_eq!(
            environment(false, Some("development")),
            ApnsEnvironment::Sandbox
        );
        assert_eq!(
            environment(false, Some("production")),
            ApnsEnvironment::Production
        );
        assert_eq!(environment(false, None), ApnsEnvironment::Production);
    }

    #[test]
    fn an_uppercase_or_short_token_is_rejected() {
        for token in [TOKEN.to_uppercase(), TOKEN[..10].to_owned()] {
            let answer =
                json!({ "token": token, "simulator": true, "profileApsEnvironment": null });
            assert!(serde_json::from_value::<Registration>(answer).is_err());
        }
    }

    #[test]
    fn delivered_user_info_becomes_notification_data_or_none() {
        let delivered: Delivered = serde_json::from_value(json!({ "notifications": [
            { "identifier": "Bq3k7jTr2qRwWb5A", "userInfo": {
                "route": "/Libera/%23weblounge",
                "conversationTag": "Libera/#weblounge",
                "messageId": "Bq3k7jTr2qRwWb5A",
                "messageTime": "2026-11-16T12:34:56.789Z",
                "aps": { "alert": { "title": "weblounge" } },
            } },
            { "identifier": "placeholder", "userInfo": {
                "aps": { "alert": { "title": "weblounge", "body": "New message" } },
                "r": "Xq3vY0bH2kRmT7nW9pLs1A",
                "c": "AAAA",
            } },
            { "identifier": "unsafe", "userInfo": { "route": "//evil.example/" } },
        ] }))
        .expect("parses");
        let notifications = delivered.into_notifications();

        assert_eq!(notifications.len(), 3);
        assert!(matches!(
            &notifications[0].data,
            Some(NotificationData::Chat(chat)) if chat.message_id == "Bq3k7jTr2qRwWb5A"
        ));
        assert_eq!(notifications[1].identifier, "placeholder");
        assert_eq!(notifications[1].data, None);
        assert_eq!(notifications[2].data, None);
    }
}
