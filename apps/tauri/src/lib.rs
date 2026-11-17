//! Temporary shell around the hosted weblounge web app, for macOS and iOS.

#[cfg(desktop)]
mod launch;
#[cfg(desktop)]
mod login_item;
#[cfg(desktop)]
mod menu;
#[cfg(any(target_os = "ios", test))]
mod native;
mod navigation;
#[cfg(desktop)]
mod notifications;
#[cfg(desktop)]
mod page_action;
#[cfg(test)]
mod page_commands;
#[cfg(any(target_os = "ios", test))]
mod page_event;
mod security;
mod shell;
mod window;

use tauri::{App, Wry, plugin::Plugin};

#[cfg(desktop)]
const BADGE_SCRIPT: &str = include_str!("badge.js");

/// Builds and runs the app until it quits.
///
/// # Errors
///
/// Fails when Tauri cannot build the app from its context.
pub fn run() -> tauri::Result<()> {
    let builder = tauri::Builder::default()
        .plugin(rust_side_opener())
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            notifications::notification_permission,
            #[cfg(desktop)]
            notifications::request_notification_permission,
            #[cfg(desktop)]
            notifications::post_notification,
            #[cfg(desktop)]
            notifications::close_notification,
            #[cfg(target_os = "ios")]
            native::commands::push_permission,
            #[cfg(target_os = "ios")]
            native::commands::request_push_permission,
            #[cfg(target_os = "ios")]
            native::commands::open_app_settings,
            #[cfg(target_os = "ios")]
            native::commands::push_target,
            #[cfg(target_os = "ios")]
            native::commands::create_route_keys,
            #[cfg(target_os = "ios")]
            native::commands::drop_route_keys,
            #[cfg(target_os = "ios")]
            native::commands::routes_needing_reregistration,
            #[cfg(target_os = "ios")]
            native::commands::take_pushed_messages,
            #[cfg(target_os = "ios")]
            native::commands::set_badge,
            #[cfg(target_os = "ios")]
            native::commands::write_notification_counts,
            #[cfg(target_os = "ios")]
            native::commands::delivered_notifications,
            #[cfg(target_os = "ios")]
            native::commands::remove_delivered_notifications,
        ])
        .setup(setup);
    #[cfg(target_os = "ios")]
    let builder = builder
        .plugin(weblounge_ios_shell::init())
        .manage(native::PageLoad::default())
        .on_page_load(native::track_page_load);
    #[cfg(desktop)]
    let builder = builder
        .manage(notifications::service())
        .plugin(window::desktop::state_plugin())
        .plugin(login_item::plugin())
        .on_menu_event(|app, event| menu::handle_event(app, &event));
    let app = builder.build(tauri::generate_context!())?;
    app.run(|app, event| handle_run_event(app, &event));
    Ok(())
}

#[cfg(mobile)]
mod mobile {
    #[tauri::mobile_entry_point]
    fn start() {
        if let Err(error) = super::run() {
            eprintln!("could not run the app: {error}");
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum SetupError {
    #[cfg(desktop)]
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
    #[cfg(desktop)]
    install_menu(app)?;
    #[cfg(desktop)]
    notifications::install_click_delegate(app.handle());
    window::create(app.handle(), &page_scripts()?)?;
    #[cfg(target_os = "ios")]
    native::watch(app.handle());
    #[cfg(desktop)]
    if !launch::starts_hidden(std::env::args()) {
        window::desktop::show(app.handle());
    }
    Ok(())
}

fn page_scripts() -> Result<Vec<String>, SetupError> {
    let identity = shell::identity_script()?;
    #[cfg(desktop)]
    let scripts = vec![
        identity,
        BADGE_SCRIPT.to_owned(),
        notifications::init_script(notifications::initial_permission())?,
    ];
    #[cfg(mobile)]
    let scripts = vec![identity];
    Ok(scripts)
}

#[cfg(desktop)]
fn install_menu(app: &App) -> Result<(), SetupError> {
    menu::hide_system_full_screen_item();
    app.set_menu(menu::build(app.handle())?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::Reopen { .. } = *event {
        window::desktop::show(app);
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_: &tauri::AppHandle, _: &tauri::RunEvent) {}

#[cfg(test)]
mod tests {
    #[test]
    fn injects_the_badge_and_notification_shims_only_into_desktop_pages() {
        let scripts = super::page_scripts().expect("page scripts build");
        for shim in [include_str!("badge.js"), include_str!("notification.js")] {
            assert_eq!(
                scripts.iter().any(|script| script.contains(shim)),
                cfg!(desktop)
            );
        }
        assert!(scripts[0].contains("__WEBLOUNGE_SHELL__"));
    }
}
