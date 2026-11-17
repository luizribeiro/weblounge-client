use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Why a shell command failed. A request the shell can't parse never reaches a command, so
/// these are the platform's failures only.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeBridgeError {
    /// `registerForRemoteNotifications` failed, for example without the push entitlement;
    /// `push_target` reports it, since the token arrives after the permission request.
    #[error("APNs registration failed: {message}")]
    ApnsRegistration {
        /// The system's description.
        message: String,
    },
    /// The shared keychain refused to store, read or delete a route's key.
    #[error("keychain failed: {message}")]
    Keychain {
        /// The system's description.
        message: String,
    },
    /// The App Group container couldn't be read or written.
    #[error("App Group failed: {message}")]
    AppGroup {
        /// The system's description.
        message: String,
    },
    /// `UNUserNotificationCenter` failed to authorize, set the badge, or list or remove
    /// delivered notifications, or the app's notification settings couldn't be opened.
    #[error("notification center failed: {message}")]
    NotificationCenter {
        /// The system's description.
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::NativeBridgeError;

    #[test]
    fn errors_round_trip_as_a_kind_tagged_union() {
        for (error, value) in [
            (
                NativeBridgeError::ApnsRegistration {
                    message: "no valid aps-environment entitlement string found".to_owned(),
                },
                json!({
                    "kind": "apns_registration",
                    "message": "no valid aps-environment entitlement string found",
                }),
            ),
            (
                NativeBridgeError::Keychain {
                    message: "errSecInteractionNotAllowed".to_owned(),
                },
                json!({ "kind": "keychain", "message": "errSecInteractionNotAllowed" }),
            ),
            (
                NativeBridgeError::AppGroup {
                    message: "container unavailable".to_owned(),
                },
                json!({ "kind": "app_group", "message": "container unavailable" }),
            ),
            (
                NativeBridgeError::NotificationCenter {
                    message: "Notifications are not allowed for this application".to_owned(),
                },
                json!({
                    "kind": "notification_center",
                    "message": "Notifications are not allowed for this application",
                }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&error).expect("serializes"), value);
            assert_eq!(
                serde_json::from_value::<NativeBridgeError>(value).expect("parses"),
                error
            );
        }
    }

    #[test]
    fn display_names_the_subsystem() {
        let error = NativeBridgeError::Keychain {
            message: "errSecItemNotFound".to_owned(),
        };
        assert_eq!(error.to_string(), "keychain failed: errSecItemNotFound");
    }
}
