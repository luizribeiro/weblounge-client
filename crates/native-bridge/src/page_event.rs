use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::BufferRoutePath;

/// Which side of the app lifecycle the shell just crossed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AppLifecycle {
    /// The app is active again.
    Foreground,
    /// The app entered the background, where iOS may not deliver `pagehide` or `freeze`.
    Background,
}

/// A `CustomEvent` the shell dispatches on the page's `window`: `name` is the event type and
/// `detail` its `detail`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "name", content = "detail")]
pub enum PageEvent {
    /// A notification tap while the page is loaded.
    #[serde(rename = "weblounge:open-route")]
    OpenRoute(BufferRoutePath),
    /// The app moved between foreground and background.
    #[serde(rename = "weblounge:lifecycle")]
    Lifecycle(AppLifecycle),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AppLifecycle, PageEvent};
    use crate::BufferRoutePath;

    fn open_route() -> PageEvent {
        PageEvent::OpenRoute(
            BufferRoutePath::try_from("/Libera/@mel".to_owned()).expect("valid route"),
        )
    }

    #[test]
    fn events_round_trip_as_name_and_detail() {
        for (event, value) in [
            (
                open_route(),
                json!({ "name": "weblounge:open-route", "detail": "/Libera/@mel" }),
            ),
            (
                PageEvent::Lifecycle(AppLifecycle::Background),
                json!({ "name": "weblounge:lifecycle", "detail": "background" }),
            ),
            (
                PageEvent::Lifecycle(AppLifecycle::Foreground),
                json!({ "name": "weblounge:lifecycle", "detail": "foreground" }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&event).expect("serializes"), value);
            assert_eq!(
                serde_json::from_value::<PageEvent>(value).expect("parses"),
                event
            );
        }
    }

    #[test]
    fn an_open_route_event_with_an_unsafe_route_does_not_deserialize() {
        let value = json!({ "name": "weblounge:open-route", "detail": "//evil.example" });
        assert!(serde_json::from_value::<PageEvent>(value).is_err());
    }
}
