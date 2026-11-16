//! The Swift half of the iOS shell. It owns every Apple API call, because the app crate denies
//! `unsafe`; the app reaches it only through [`IosShell`], and the page never does.

#![cfg(target_os = "ios")]

use tauri::{
    Manager, Runtime,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

tauri::ios_plugin_binding!(init_plugin_weblounge_ios_shell);

/// The handle the app runs the Swift commands through.
pub struct IosShell<R: Runtime>(pub PluginHandle<R>);

/// Registers the Swift plugin and manages its [`IosShell`] handle.
#[must_use]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("weblounge-ios-shell")
        .setup(|app, api| {
            app.manage(IosShell(
                api.register_ios_plugin(init_plugin_weblounge_ios_shell)?,
            ));
            Ok(())
        })
        .build()
}
