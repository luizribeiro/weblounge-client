//! What the Swift side reports, and what a notification tap does to the page.

use serde::Deserialize;
use serde_json::Value;
use tauri::{Url, webview::PageLoadEvent};
use weblounge_native_bridge::{BufferRoutePath, PageEvent, RouteNotificationData};

use super::answers::Registration;
use crate::{page_event::dispatch_script, window::APP_URL};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ShellEvent {
    /// The user opened a notification.
    Tap { user_info: Value },
    /// APNs issued a device token, or a different one.
    Token(Registration),
}

#[derive(Debug, PartialEq)]
pub enum TapAction {
    /// The loaded page opens the route itself.
    Dispatch(String),
    /// The page isn't loaded yet, so it loads at the route instead.
    Navigate(Url),
}

#[derive(Debug, thiserror::Error)]
pub enum TapError {
    #[error("the notification has no valid route: {0}")]
    NoRoute(serde_json::Error),
    #[error("could not build the open-route script: {0}")]
    Script(serde_json::Error),
    #[error("could not build the route URL: {0}")]
    Url(#[from] url::ParseError),
}

pub fn tap_action(user_info: Value, page_loaded: bool) -> Result<TapAction, TapError> {
    let RouteNotificationData { route } =
        serde_json::from_value(user_info).map_err(TapError::NoRoute)?;
    if page_loaded {
        dispatch_script(&PageEvent::OpenRoute(route))
            .map(TapAction::Dispatch)
            .map_err(TapError::Script)
    } else {
        Ok(TapAction::Navigate(route_url(&route)?))
    }
}

/// Announces a new device token to the page.
pub fn token_script(registration: Registration) -> Result<String, serde_json::Error> {
    dispatch_script(&PageEvent::PushTarget(registration.into_target()))
}

/// Only the hosted app listens for taps; the concierge's sign-in pages don't.
pub fn app_page_loaded(event: PageLoadEvent, url: &Url) -> bool {
    event == PageLoadEvent::Finished && url.as_str().starts_with(&format!("{APP_URL}/"))
}

fn route_url(route: &BufferRoutePath) -> Result<Url, url::ParseError> {
    format!("{APP_URL}{}", route.as_str()).parse()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_tap_event_parses() {
        let tap = json!({ "kind": "tap", "userInfo": { "route": "/Libera/@mel" } });
        assert_eq!(
            serde_json::from_value::<ShellEvent>(tap).expect("parses"),
            ShellEvent::Tap {
                user_info: json!({ "route": "/Libera/@mel" })
            }
        );
    }

    #[test]
    fn a_token_event_announces_the_push_target() {
        let token = json!({
            "kind": "token",
            "token": "740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad",
            "simulator": true,
            "profileApsEnvironment": null,
        });
        let ShellEvent::Token(registration) =
            serde_json::from_value::<ShellEvent>(token).expect("parses")
        else {
            panic!("not a token event");
        };
        assert_eq!(
            token_script(registration).expect("script builds"),
            "window.dispatchEvent(new CustomEvent(\"weblounge:push-target\", { detail: \
             {\"environment\":\"sandbox\",\"platform\":\"apns\",\"token\":\
             \"740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad\"} }));"
        );
    }

    #[test]
    fn a_tap_on_the_loaded_page_dispatches_open_route() {
        let user_info = json!({ "route": "/Libera/%23weblounge", "messageId": "x", "aps": {} });
        assert_eq!(
            tap_action(user_info, true).expect("routes"),
            TapAction::Dispatch(
                "window.dispatchEvent(new CustomEvent(\"weblounge:open-route\", \
                 { detail: \"/Libera/%23weblounge\" }));"
                    .to_owned()
            )
        );
    }

    #[test]
    fn a_tap_before_the_page_loads_opens_the_route_url() {
        let action = tap_action(json!({ "route": "/Libera/@mel" }), false).expect("routes");
        assert_eq!(
            action,
            TapAction::Navigate(
                "https://beta.weblounge.org/Libera/@mel"
                    .parse()
                    .expect("valid")
            )
        );
        let root = tap_action(json!({ "route": "/" }), false).expect("routes");
        assert_eq!(
            root,
            TapAction::Navigate("https://beta.weblounge.org/".parse().expect("valid"))
        );
    }

    #[test]
    fn only_a_finished_load_of_the_hosted_app_takes_taps() {
        let app: Url = "https://beta.weblounge.org/Libera/@mel"
            .parse()
            .expect("valid");
        let concierge: Url = "https://members.weblounge.org/login"
            .parse()
            .expect("valid");
        let lookalike: Url = "https://beta.weblounge.org.evil.example/"
            .parse()
            .expect("valid");
        assert!(app_page_loaded(PageLoadEvent::Finished, &app));
        assert!(!app_page_loaded(PageLoadEvent::Started, &app));
        assert!(!app_page_loaded(PageLoadEvent::Finished, &concierge));
        assert!(!app_page_loaded(PageLoadEvent::Finished, &lookalike));
    }

    #[test]
    fn a_tap_without_a_safe_route_is_dropped() {
        for user_info in [
            json!({ "aps": { "alert": "New message" }, "r": "route", "c": "AAAA" }),
            json!({ "route": "//evil.example/x" }),
            json!({ "route": "@evil.example" }),
            json!({ "route": 7 }),
            json!({ "route": "" }),
            json!({ "route": "/Libera\\weblounge" }),
            json!({ "route": "/Libera/.." }),
            json!({ "route": "/Libera/mel?next=//evil.example" }),
            json!({ "route": "/Libera/mel#x" }),
        ] {
            assert!(matches!(
                tap_action(user_info, true),
                Err(TapError::NoRoute(_))
            ));
        }
    }
}
