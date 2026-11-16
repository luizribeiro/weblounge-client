//! The page's iOS commands. Each one runs its Swift counterpart and validates the answer into
//! the bridge's types, so a malformed answer fails here rather than in the page.

use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager, Wry, plugin::mobile::PluginInvokeError};
use weblounge_ios_shell::IosShell;
use weblounge_native_bridge::{
    CreateRouteKeysRequest, DropRouteKeysRequest, NativeBridgeError, PushPermission, PushTarget,
    RouteKeys, SetBadgeRequest,
};

use super::{
    answers::Registration,
    failure::{self, Fallback, apns_registration, keychain, notification_center},
};

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
pub async fn request_push_permission(app: AppHandle) -> Result<PushPermission, NativeBridgeError> {
    call(&app, "requestPushPermission", (), notification_center).await
}

#[tauri::command]
pub async fn push_permission(app: AppHandle) -> Result<PushPermission, NativeBridgeError> {
    call(&app, "pushPermission", (), notification_center).await
}

#[tauri::command]
pub async fn push_target(app: AppHandle) -> Result<Option<PushTarget>, NativeBridgeError> {
    let registration: Option<Registration> =
        call(&app, "pushTarget", (), apns_registration).await?;
    Ok(registration.map(Registration::into_target))
}

#[tauri::command]
pub async fn create_route_keys(
    app: AppHandle,
    request: CreateRouteKeysRequest,
) -> Result<RouteKeys, NativeBridgeError> {
    call(&app, "createRouteKeys", request, keychain).await
}

#[tauri::command]
pub async fn drop_route_keys(
    app: AppHandle,
    request: DropRouteKeysRequest,
) -> Result<(), NativeBridgeError> {
    call(&app, "dropRouteKeys", request, keychain).await
}

#[tauri::command]
pub async fn set_badge(app: AppHandle, request: SetBadgeRequest) -> Result<(), NativeBridgeError> {
    call(&app, "setBadge", request, notification_center).await
}
