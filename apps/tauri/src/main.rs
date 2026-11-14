//! Temporary macOS shell around the hosted weblounge web app.

mod launch;
mod login_item;
mod menu;
mod navigation;
mod notifications;
mod page_action;
mod security;
mod shell;
mod window;

use tauri::{App, AppHandle, RunEvent, Wry, plugin::Plugin};

const BADGE_SCRIPT: &str = include_str!("badge.js");

fn main() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(rust_side_opener())
        .plugin(window::state_plugin())
        .plugin(login_item::plugin())
        .manage(notifications::service())
        .invoke_handler(tauri::generate_handler![
            notifications::notification_permission,
            notifications::request_notification_permission,
            notifications::post_notification,
            notifications::close_notification,
        ])
        .setup(setup)
        .on_menu_event(|app, event| menu::handle_event(app, &event))
        .build(tauri::generate_context!())?;
    app.run(|app, event| handle_run_event(app, &event));
    Ok(())
}

#[derive(Debug, thiserror::Error)]
enum SetupError {
    #[error("could not build the menu: {0}")]
    Menu(#[from] tauri::Error),
    #[error(transparent)]
    Window(#[from] window::WindowError),
    #[error("could not build a page script: {0}")]
    Script(#[from] serde_json::Error),
}

fn rust_side_opener() -> impl Plugin<Wry> {
    // The plugin's injected click script cancels `target="_blank"` clicks and opens them over IPC,
    // which the remote page never has; links must reach `on_new_window` instead.
    tauri_plugin_opener::Builder::new()
        .open_js_links_on_click(false)
        .build()
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    install(app).map_err(Into::into)
}

fn install(app: &App) -> Result<(), SetupError> {
    app.set_menu(menu::build(app.handle())?)?;
    notifications::install_click_delegate(app.handle());
    let identity_script = shell::identity_script()?;
    let notification_script = notifications::init_script(notifications::initial_permission())?;
    window::create(
        app.handle(),
        !launch::starts_hidden(std::env::args()),
        &[&identity_script, BADGE_SCRIPT, &notification_script],
    )?;
    Ok(())
}

fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if let RunEvent::Reopen { .. } = *event {
        window::show(app);
    }
}
