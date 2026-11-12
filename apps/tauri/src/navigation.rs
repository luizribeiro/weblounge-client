//! Decides whether a request stays in the window, goes to the system or is dropped.

use tauri::Url;

const APP_HOSTS: &[&str] = &["beta.weblounge.org", "members.weblounge.org"];
const IN_PAGE_SCHEMES: &[&str] = &["about", "blob", "data"];
const EXTERNAL_SCHEMES: &[&str] = &["http", "https", "mailto"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestKind {
    Navigation,
    NewWindow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Stay,
    OpenExternally,
    Drop,
}

pub fn route(kind: RequestKind, url: &Url) -> Route {
    let scheme = url.scheme();
    if kind == RequestKind::Navigation && (is_app_page(url) || IN_PAGE_SCHEMES.contains(&scheme)) {
        Route::Stay
    } else if EXTERNAL_SCHEMES.contains(&scheme) {
        Route::OpenExternally
    } else {
        Route::Drop
    }
}

fn is_app_page(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|host| APP_HOSTS.contains(&host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use RequestKind::{Navigation, NewWindow};
    use Route::{Drop, OpenExternally, Stay};

    #[test]
    fn routes_every_kind_of_url() {
        let cases = [
            (Navigation, "https://beta.weblounge.org/", Stay),
            (
                Navigation,
                "https://beta.weblounge.org/#/chat/%23rust",
                Stay,
            ),
            (
                Navigation,
                "https://members.weblounge.org/oauth/authorize?client_id=weblounge&redirect_uri=https%3A%2F%2Fbeta.weblounge.org%2F&state=abc",
                Stay,
            ),
            (Navigation, "about:blank", Stay),
            (Navigation, "blob:https://beta.weblounge.org/6b1c", Stay),
            (Navigation, "data:text/html,hello", Stay),
            (Navigation, "https://example.com/article", OpenExternally),
            (
                Navigation,
                "https://beta.weblounge.org.evil.example/",
                OpenExternally,
            ),
            (Navigation, "http://beta.weblounge.org/", OpenExternally),
            (Navigation, "http://example.com/", OpenExternally),
            (Navigation, "mailto:luiz@example.com", OpenExternally),
            (NewWindow, "https://example.com/article", OpenExternally),
            (NewWindow, "https://beta.weblounge.org/", OpenExternally),
            (NewWindow, "http://example.com/", OpenExternally),
            (NewWindow, "mailto:luiz@example.com", OpenExternally),
            (Navigation, "file:///etc/passwd", Drop),
            (Navigation, "javascript:alert(1)", Drop),
            (
                Navigation,
                "x-apple.systempreferences:com.apple.preference.security",
                Drop,
            ),
            (Navigation, "irc://irc.libera.chat/rust", Drop),
            (Navigation, "slack://open", Drop),
            (NewWindow, "file:///etc/passwd", Drop),
            (NewWindow, "javascript:alert(1)", Drop),
            (NewWindow, "data:text/html,hello", Drop),
            (NewWindow, "about:blank", Drop),
            (NewWindow, "irc://irc.libera.chat/rust", Drop),
        ];
        for (kind, url, expected) in cases {
            let parsed: Url = url.parse().expect("test URL parses");
            assert_eq!(route(kind, &parsed), expected, "{kind:?} {url}");
        }
    }
}
