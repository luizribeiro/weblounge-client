//! The single main window and its close-to-hide behaviour.

use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    webview::NewWindowResponse,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use crate::navigation::{RequestKind, Route, route};

#[derive(Debug, thiserror::Error)]
pub enum WindowError {
    #[error("invalid app URL: {0}")]
    Url(#[from] url::ParseError),
    #[error("could not create the window: {0}")]
    Tauri(#[from] tauri::Error),
}

pub const MAIN_LABEL: &str = "main";
const APP_URL: &str = "https://beta.weblounge.org";

// Persisting visibility would restore a window hidden by close-to-hide as hidden at the next launch.
fn persisted_state() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

pub fn state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    WindowStateBuilder::default()
        .with_state_flags(persisted_state())
        .build()
}

pub fn create(app: &AppHandle) -> Result<(), WindowError> {
    let url = APP_URL.parse()?;
    let navigating = app.clone();
    let opening = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(url))
        .title("weblounge")
        .visible(false)
        .inner_size(1280.0, 840.0)
        .min_inner_size(400.0, 480.0)
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
    hide_instead_of_closing(&window);
    show(app);
    Ok(())
}

fn log_failure(action: &str, result: tauri::Result<()>) {
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

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        log_failure("show the window", window.show());
        log_failure("focus the window", window.set_focus());
    }
}

pub fn reload(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        log_failure("reload the window", window.reload());
    }
}

fn hide_instead_of_closing(window: &WebviewWindow) {
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            log_failure("hide the window", hidden.hide());
        }
    });
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
    fn window_visibility_is_not_persisted() {
        assert!(!persisted_state().contains(StateFlags::VISIBLE));
        assert!(persisted_state().contains(StateFlags::SIZE | StateFlags::POSITION));
    }

    #[test]
    fn opens_the_url_only_when_routed_externally() {
        let url = "https://example.com/article";
        assert_eq!(opened_by(Route::OpenExternally, url), [url]);
        assert!(opened_by(Route::Stay, url).is_empty());
        assert!(opened_by(Route::Drop, "file:///etc/passwd").is_empty());
    }
}
