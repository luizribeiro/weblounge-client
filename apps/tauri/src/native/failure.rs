//! Turns the Swift side's rejections back into the bridge's errors.

use serde_json::json;
use weblounge_native_bridge::NativeBridgeError;

/// The error a command reports when Swift names no known subsystem, such as a request or
/// answer that failed to cross the plugin boundary.
pub type Fallback = fn(String) -> NativeBridgeError;

pub fn apns_registration(message: String) -> NativeBridgeError {
    NativeBridgeError::ApnsRegistration { message }
}

pub fn keychain(message: String) -> NativeBridgeError {
    NativeBridgeError::Keychain { message }
}

pub fn app_group(message: String) -> NativeBridgeError {
    NativeBridgeError::AppGroup { message }
}

pub fn notification_center(message: String) -> NativeBridgeError {
    NativeBridgeError::NotificationCenter { message }
}

/// Swift rejects with the error's `kind` as its code, so the code and message deserialize as
/// the bridge error itself.
pub fn rejection(code: Option<&str>, message: String, fallback: Fallback) -> NativeBridgeError {
    code.and_then(|kind| serde_json::from_value(json!({ "kind": kind, "message": message })).ok())
        .unwrap_or_else(|| fallback(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_code_names_the_subsystem() {
        assert_eq!(
            rejection(
                Some("app_group"),
                "container unavailable".to_owned(),
                keychain
            ),
            NativeBridgeError::AppGroup {
                message: "container unavailable".to_owned()
            }
        );
        assert_eq!(
            rejection(
                Some("apns_registration"),
                "no entitlement".to_owned(),
                keychain
            ),
            NativeBridgeError::ApnsRegistration {
                message: "no entitlement".to_owned()
            }
        );
    }

    #[test]
    fn a_missing_or_unknown_code_falls_back_to_the_commands_subsystem() {
        for code in [None, Some("network"), Some("")] {
            assert_eq!(
                rejection(code, "failed".to_owned(), notification_center),
                NativeBridgeError::NotificationCenter {
                    message: "failed".to_owned()
                },
                "{code:?}"
            );
        }
    }

    #[test]
    fn each_fallback_reports_its_own_subsystem() {
        let kinds: Vec<_> = [apns_registration, keychain, app_group, notification_center]
            .into_iter()
            .map(|fallback| serde_json::to_value(rejection(None, "x".to_owned(), fallback)))
            .map(|value| value.expect("serializes")["kind"].clone())
            .collect();
        assert_eq!(
            kinds,
            [
                "apns_registration",
                "keychain",
                "app_group",
                "notification_center"
            ]
        );
    }
}
