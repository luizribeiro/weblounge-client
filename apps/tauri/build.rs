//! Generates the Tauri context consumed by the app crate.

const PAGE_COMMANDS: &[&str] = &[
    "notification_permission",
    "request_notification_permission",
    "post_notification",
    "close_notification",
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = tauri_build::AppManifest::new().commands(PAGE_COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))?;
    Ok(())
}
