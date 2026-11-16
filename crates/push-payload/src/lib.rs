//! Decryption, parsing and notification formatting for IRC Web Push payloads.

mod decrypt;
mod format;
mod parse;
mod prepare;

pub use decrypt::{DecryptError, RouteKeys, decrypt_push_payload};
pub use format::{
    NotificationData, NotificationStrings, PreparedNotification, PushedMessage, PushedMessageKind,
    RouteMeta, VisibleNotification, counted_body, notification_for,
};
pub use parse::{ChatPayload, ParsePushError, PushEvent, parse_push_payload};
pub use prepare::{PrepareError, prepare_notification, prepare_notification_json};
use wasm_bindgen::prelude::{JsValue, wasm_bindgen};

/// Wasm boundary used by the classic service worker.
///
/// # Errors
///
/// Returns a JavaScript string when parsing or serialization fails.
#[wasm_bindgen]
pub fn parse_push_payload_json(input: &str) -> Result<String, JsValue> {
    let event = parse_push_payload(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&event).map_err(|error| JsValue::from_str(&error.to_string()))
}
