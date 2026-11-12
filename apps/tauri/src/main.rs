//! Temporary macOS shell around the hosted weblounge web app.

mod menu;
mod navigation;
mod window;

use tauri::{App, AppHandle, RunEvent};

fn main() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(window::state_plugin())
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
