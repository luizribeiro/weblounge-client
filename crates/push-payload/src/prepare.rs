//! The one entry point every platform calls for an encrypted push.

use serde::Serialize;

use crate::{
    DecryptError, ParsePushError, PreparedNotification, RouteKeys, RouteMeta, decrypt_push_payload,
    notification_for, parse_push_payload,
};

/// Why a push could not become a detailed notification.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PrepareError {
    /// The route's keys could not open the record, so the route needs re-registering.
    #[error(transparent)]
    Decrypt(DecryptError),
    /// The plaintext is not a supported IRC event; show the generic notification.
    #[error(transparent)]
    Parse(ParsePushError),
}

/// Decrypts, parses and formats one push for `route`.
///
/// # Errors
///
/// Returns whether decryption or parsing failed, since platforms recover differently.
pub fn prepare_notification(
    ciphertext: &[u8],
    keys: &RouteKeys,
    route: &RouteMeta,
) -> Result<PreparedNotification, PrepareError> {
    let plaintext = decrypt_push_payload(ciphertext, keys).map_err(PrepareError::Decrypt)?;
    let event =
        parse_push_payload(&String::from_utf8_lossy(&plaintext)).map_err(PrepareError::Parse)?;
    Ok(notification_for(event, route))
}

/// The JSON both platform boundaries return for [`prepare_notification`].
#[must_use]
pub fn prepare_notification_json(ciphertext: &[u8], keys: &RouteKeys, route: &RouteMeta) -> String {
    let outcome = match prepare_notification(ciphertext, keys, route) {
        Ok(notification) => PrepareOutcome::Prepared { notification },
        Err(error) => PrepareOutcome::Failed {
            stage: match error {
                PrepareError::Decrypt(_) => FailedStage::Decrypt,
                PrepareError::Parse(_) => FailedStage::Parse,
            },
            message: error.to_string(),
        },
    };
    serde_json::to_string(&outcome).unwrap_or_else(|_| UNSERIALIZABLE.to_owned())
}

// Serializing these types cannot fail; the fallback keeps the boundaries panic-free regardless.
const UNSERIALIZABLE: &str =
    r#"{"outcome":"failed","stage":"parse","message":"unserializable notification"}"#;

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum PrepareOutcome {
    Prepared { notification: PreparedNotification },
    Failed { stage: FailedStage, message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum FailedStage {
    Decrypt,
    Parse,
}

#[cfg(test)]
#[path = "prepare_tests.rs"]
mod tests;
