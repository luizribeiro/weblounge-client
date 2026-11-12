//! Temporary macOS shell around the hosted weblounge web app.

mod login_item;
mod menu;
mod navigation;
mod window;

use tauri::{App, AppHandle, RunEvent, Wry, plugin::Plugin};

fn main() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(rust_side_opener())
        .plugin(window::state_plugin())
        .plugin(login_item::plugin())
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
    window::create(app.handle())?;
    Ok(())
}

fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if let RunEvent::Reopen { .. } = *event {
        window::show(app);
    }
}
