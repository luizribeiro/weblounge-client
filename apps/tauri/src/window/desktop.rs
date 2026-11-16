//! The desktop window's size, persistence, visibility and close-to-hide behaviour.

use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use super::{MAIN_LABEL, log_failure};

// Persisting visibility would restore a window hidden by close-to-hide as hidden at the next launch.
fn persisted_state() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

pub fn state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    WindowStateBuilder::default()
        .with_state_flags(persisted_state())
        .build()
}

pub fn configure<'a>(
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
    title: &str,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    builder
        .title(title)
        .visible(false)
        .inner_size(1280.0, 840.0)
        .min_inner_size(400.0, 480.0)
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

pub fn toggle_fullscreen(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let result = window
            .is_fullscreen()
            .and_then(|fullscreen| window.set_fullscreen(!fullscreen));
        log_failure("toggle full screen", result);
    }
}

pub(super) fn hide_instead_of_closing(window: &WebviewWindow) {
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
    use super::*;

    #[test]
    fn window_visibility_is_not_persisted() {
        assert!(!persisted_state().contains(StateFlags::VISIBLE));
        assert!(persisted_state().contains(StateFlags::SIZE | StateFlags::POSITION));
    }
}
