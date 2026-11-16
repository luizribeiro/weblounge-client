//! Decryption and typed parsing of IRC Web Push payloads.

mod decrypt;
mod parse;

pub use decrypt::{DecryptError, RouteKeys, decrypt_push_payload};
pub use parse::{ChatPayload, ParsePushError, PushEvent, parse_push_payload};
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
