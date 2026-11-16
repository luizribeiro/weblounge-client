//! The single main window and the navigation policy it enforces.

#[cfg(desktop)]
pub mod desktop;

use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
    utils::config::BackgroundThrottlingPolicy, webview::NewWindowResponse,
};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::{RequestKind, Route, route};

#[derive(Debug, thiserror::Error)]
pub enum WindowError {
    #[error("invalid app URL: {0}")]
    Url(#[from] url::ParseError),
    #[error("could not create the window: {0}")]
    Tauri(#[from] tauri::Error),
}

pub const MAIN_LABEL: &str = "main";
pub const APP_URL: &str = "https://beta.weblounge.org";

pub fn create(app: &AppHandle, page_scripts: &[&str]) -> Result<(), WindowError> {
    let url = APP_URL.parse()?;
    let navigating = app.clone();
    let opening = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(url));
    #[cfg(desktop)]
    {
        builder = desktop::configure(builder, &app.package_info().name);
    }
    for script in page_scripts {
        builder = builder.initialization_script(*script);
    }
    let window = builder
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            let decision = route(RequestKind::Navigation, url);
            follow(decision, url, |url| open_externally(&navigating, url));
            decision == Route::Stay
        })
        .on_new_window(move |url, _features| {
            follow(route(RequestKind::NewWindow, &url), &url, |url| {
                open_externally(&opening, url);
            });
            NewWindowResponse::Deny
        })
        .build()?;
    #[cfg(desktop)]
    desktop::hide_instead_of_closing(&window);
    Ok(())
}

pub fn log_failure(action: &str, result: Result<(), impl std::fmt::Display>) {
    if let Err(error) = result {
        eprintln!("could not {action}: {error}");
    }
}

fn follow(decision: Route, url: &Url, open: impl FnOnce(&Url)) {
    if decision == Route::OpenExternally {
        open(url);
    }
}

fn open_externally(app: &AppHandle, url: &Url) {
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("could not open {url} externally: {error}");
    }
}

pub fn eval_in_page(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        log_failure("run a script in the page", window.eval(script));
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn opened_by(decision: Route, url: &str) -> Vec<String> {
        let opened = RefCell::new(Vec::new());
        let url: Url = url.parse().expect("test URL parses");
        follow(decision, &url, |url| {
            opened.borrow_mut().push(url.to_string());
        });
        opened.into_inner()
    }

    #[test]
    fn opens_the_url_only_when_routed_externally() {
        let url = "https://example.com/article";
        assert_eq!(opened_by(Route::OpenExternally, url), [url]);
        assert!(opened_by(Route::Stay, url).is_empty());
        assert!(opened_by(Route::Drop, "file:///etc/passwd").is_empty());
    }
}
