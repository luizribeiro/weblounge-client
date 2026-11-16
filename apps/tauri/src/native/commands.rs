//! The page's iOS commands. Each one runs its Swift counterpart and validates the answer into
//! the bridge's types, so a malformed answer fails here rather than in the page.

use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager, Wry, plugin::mobile::PluginInvokeError};
use weblounge_ios_shell::IosShell;
use weblounge_native_bridge::{NativeBridgeError, PushPermission};

use super::failure::{self, Fallback, notification_center};

pub(super) async fn call<T: DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    payload: impl Serialize,
    fallback: Fallback,
) -> Result<T, NativeBridgeError> {
    let shell = app.state::<IosShell<Wry>>();
    shell
        .0
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|error| match error {
            PluginInvokeError::InvokeRejected(rejected) => failure::rejection(
                rejected.code.as_deref(),
                rejected.message.unwrap_or_default(),
                fallback,
            ),
            other => fallback(other.to_string()),
        })
}

#[tauri::command]
pub async fn push_permission(app: AppHandle) -> Result<PushPermission, NativeBridgeError> {
    call(&app, "pushPermission", (), notification_center).await
}
