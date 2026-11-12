//! The single main window and its close-to-hide behaviour.

use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    webview::NewWindowResponse,
};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::{RequestKind, Route, route};

pub const MAIN_LABEL: &str = "main";
const APP_URL: &str = "https://beta.weblounge.org";

pub fn create(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let url = APP_URL.parse()?;
    let navigating = app.clone();
    let opening = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(url))
        .title("weblounge")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| {
            stays_after_routing(&navigating, RequestKind::MainFrameNavigation, url)
        })
        .on_new_window(move |url, _features| {
            stays_after_routing(&opening, RequestKind::NewWindow, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    hide_instead_of_closing(&window);
    Ok(())
}

fn stays_after_routing(app: &AppHandle, kind: RequestKind, url: &Url) -> bool {
    match route(kind, url) {
        Route::Stay => true,
        Route::OpenExternally => {
            if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!("could not open {url} externally: {error}");
            }
            false
        }
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn reload(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.reload();
    }
}

fn hide_instead_of_closing(window: &WebviewWindow) {
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
}
