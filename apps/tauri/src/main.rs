//! Temporary macOS shell around the hosted weblounge web app.

mod menu;
mod window;

use tauri::{App, AppHandle, RunEvent};

fn main() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(setup)
        .on_menu_event(|app, event| menu::handle_event(app, &event))
        .build(tauri::generate_context!())?;
    app.run(|app, event| handle_run_event(app, &event));
    Ok(())
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    app.set_menu(menu::build(app.handle())?)?;
    window::create(app.handle())?;
    Ok(())
}

fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = *event {
        window::show(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}
