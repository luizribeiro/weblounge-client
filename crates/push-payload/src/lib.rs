//! Decryption, parsing and notification formatting for IRC Web Push payloads.

mod decrypt;
mod format;
mod parse;
mod prepare;
mod wasm;

pub use decrypt::{DecryptError, RouteKeys, decrypt_push_payload};
pub use format::{
    NotificationData, NotificationStrings, PreparedNotification, PushedMessage, PushedMessageKind,
    RouteMeta, VisibleNotification, counted_body, notification_for,
};
pub use parse::{ChatPayload, ParsePushError, PushEvent, parse_push_payload};
pub use prepare::{PrepareError, prepare_notification, prepare_notification_json};
