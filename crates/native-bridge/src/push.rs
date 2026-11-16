use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::validated::validated_string;

/// The notification authorization state, spelled like the page's `NotificationPermission`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PushPermission {
    /// Alerts, sounds and badges are allowed.
    Granted,
    /// The user refused; only Settings can change it.
    Denied,
    /// The user hasn't been asked yet.
    Default,
}

validated_string!(
    /// An APNs device token as lowercase hex, so one device has one spelling.
    ApnsToken,
    is_apns_token
);

fn is_apns_token(value: &str) -> bool {
    value.len() >= 64
        && value.len().is_multiple_of(2)
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Which APNs host the token belongs to, set by the provisioning profile.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ApnsEnvironment {
    /// `api.push.apple.com`: `TestFlight` and App Store builds.
    Production,
    /// `api.sandbox.push.apple.com`: development builds from Xcode.
    Sandbox,
}

/// The device's push target, tagged by platform the way the relay's device API expects it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "platform", rename_all = "snake_case")]
pub enum PushTarget {
    /// An iOS device registered with APNs.
    Apns {
        /// The device token from `didRegisterForRemoteNotificationsWithDeviceToken`.
        token: ApnsToken,
        /// The APNs host the token is valid on.
        environment: ApnsEnvironment,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ApnsEnvironment, ApnsToken, PushPermission, PushTarget};
    use crate::InvalidValue;

    const TOKEN: &str = "740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad";

    #[test]
    fn permissions_use_the_pages_notification_permission_strings() {
        for (permission, text) in [
            (PushPermission::Granted, "granted"),
            (PushPermission::Denied, "denied"),
            (PushPermission::Default, "default"),
        ] {
            assert_eq!(
                serde_json::to_value(permission).expect("serializes"),
                json!(text)
            );
        }
    }

    #[test]
    fn an_apns_target_round_trips_in_the_relays_shape() {
        let token = ApnsToken::try_from(TOKEN.to_owned()).expect("valid token");
        assert_eq!(token.as_str(), TOKEN);
        let target = PushTarget::Apns {
            token,
            environment: ApnsEnvironment::Production,
        };
        let value = json!({ "platform": "apns", "token": TOKEN, "environment": "production" });

        assert_eq!(serde_json::to_value(&target).expect("serializes"), value);
        assert_eq!(
            serde_json::from_value::<PushTarget>(value).expect("parses"),
            target
        );
    }

    #[test]
    fn longer_tokens_are_accepted() {
        assert!(ApnsToken::try_from(TOKEN.repeat(2)).is_ok());
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        for token in [
            String::new(),
            TOKEN[..62].to_owned(),
            format!("{TOKEN}a"),
            TOKEN.to_uppercase(),
            TOKEN.replacen('7', "g", 1),
            format!("<{}>", &TOKEN[..62]),
        ] {
            assert_eq!(ApnsToken::try_from(token), Err(InvalidValue::ApnsToken));
        }
    }

    #[test]
    fn a_target_with_an_invalid_token_does_not_deserialize() {
        let value = json!({ "platform": "apns", "token": "abc", "environment": "sandbox" });
        assert!(serde_json::from_value::<PushTarget>(value).is_err());
    }
}
