//! Decides whether a request stays in the window or goes to the system.

use tauri::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestKind {
    MainFrameNavigation,
    NewWindow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Stay,
    OpenExternally,
}

pub fn route(kind: RequestKind, url: &Url) -> Route {
    match kind {
        RequestKind::MainFrameNavigation if url.scheme() == "https" => Route::Stay,
        RequestKind::MainFrameNavigation | RequestKind::NewWindow => Route::OpenExternally,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route_of(kind: RequestKind, url: &str) -> Route {
        route(kind, &url.parse().expect("test URL parses"))
    }

    #[test]
    fn https_main_frame_navigation_stays() {
        for url in [
            "https://beta.weblounge.org/",
            "https://beta.weblounge.org/#/chat/%23rust",
            "https://example.com/elsewhere",
        ] {
            assert_eq!(route_of(RequestKind::MainFrameNavigation, url), Route::Stay);
        }
    }

    #[test]
    fn oauth_round_trip_stays() {
        for url in [
            "https://members.weblounge.org/oauth/authorize?client_id=weblounge&redirect_uri=https%3A%2F%2Fbeta.weblounge.org%2F&state=abc",
            "https://beta.weblounge.org/?code=xyz&state=abc",
        ] {
            assert_eq!(route_of(RequestKind::MainFrameNavigation, url), Route::Stay);
        }
    }

    #[test]
    fn new_window_requests_open_externally() {
        for url in [
            "https://example.com/article",
            "https://beta.weblounge.org/",
            "http://example.com/",
            "mailto:luiz@example.com",
        ] {
            assert_eq!(route_of(RequestKind::NewWindow, url), Route::OpenExternally);
        }
    }

    #[test]
    fn non_https_main_frame_navigation_opens_externally() {
        for url in [
            "mailto:luiz@example.com",
            "http://example.com/insecure",
            "irc://irc.libera.chat/rust",
            "slack://open",
            "tel:+15551234567",
        ] {
            assert_eq!(
                route_of(RequestKind::MainFrameNavigation, url),
                Route::OpenExternally,
                "{url}"
            );
        }
    }
}
