//! Carries the Swift side's taps and lifecycle changes into the page.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, Webview, WebviewWindow,
    ipc::{Channel, InvokeResponseBody},
    webview::PageLoadPayload,
};
use weblounge_native_bridge::{AppLifecycle, PageEvent};

use super::{
    commands::call,
    failure::notification_center,
    shell_event::{ShellEvent, TapAction, app_page_loaded, tap_action, token_script},
};
use crate::{
    page_event::dispatch_script,
    window::{self, MAIN_LABEL, log_failure},
};

/// Whether the hosted page has finished loading, so a tap can be handed to it.
#[derive(Default)]
pub struct PageLoad(AtomicBool);

pub fn track_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    let loaded = app_page_loaded(payload.event(), payload.url());
    webview
        .state::<PageLoad>()
        .0
        .store(loaded, Ordering::Release);
}

pub fn watch(app: &AppHandle) {
    let receiving = app.clone();
    let channel = Channel::<Value>::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            handle(&receiving, &json);
        }
        Ok(())
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let watching = call::<()>(
            &app,
            "watchEvents",
            json!({ "handler": channel }),
            notification_center,
        );
        log_failure("watch the shell's events", watching.await);
    });
}

fn handle(app: &AppHandle, json: &str) {
    match serde_json::from_str(json) {
        Ok(ShellEvent::Tap { user_info }) => open_route(app, user_info),
        Ok(ShellEvent::Token(registration)) => match token_script(registration) {
            Ok(script) => window::eval_in_page(app, &script),
            Err(error) => eprintln!("could not announce the push target: {error}"),
        },
        Ok(ShellEvent::Lifecycle {
            side,
            background_task,
        }) => report_lifecycle(app, side, background_task),
        Err(error) => eprintln!("could not read a shell event: {error}"),
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_LABEL)
}

fn open_route(app: &AppHandle, user_info: Value) {
    let loaded = app.state::<PageLoad>().0.load(Ordering::Acquire);
    let Some(window) = main_window(app) else {
        eprintln!("dropped a notification tap: no window");
        return;
    };
    match tap_action(user_info, loaded) {
        Ok(TapAction::Dispatch(script)) => {
            log_failure("open the tapped route", window.eval(script));
        }
        Ok(TapAction::Navigate(url)) => log_failure("load the tapped route", window.navigate(url)),
        Err(error) => eprintln!("dropped a notification tap: {error}"),
    }
}

fn report_lifecycle(app: &AppHandle, side: AppLifecycle, background_task: Option<i64>) {
    let dispatched = dispatch_script(&PageEvent::Lifecycle(side))
        .map_err(|error| error.to_string())
        .and_then(|script| {
            let window = main_window(app).ok_or("no window")?;
            let ending = app.clone();
            window
                .eval_with_callback(script, move |_| {
                    if let Some(task) = background_task {
                        end_background_task(&ending, task);
                    }
                })
                .map_err(|error| error.to_string())
        });
    if let Err(error) = dispatched {
        eprintln!("could not report the lifecycle to the page: {error}");
        if let Some(task) = background_task {
            end_background_task(app, task);
        }
    }
}

fn end_background_task(app: &AppHandle, task: i64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ending = call::<()>(
            &app,
            "endBackgroundTask",
            json!({ "id": task }),
            notification_center,
        );
        log_failure("end the background task", ending.await);
    });
}
