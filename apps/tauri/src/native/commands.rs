//! The page's iOS commands. Each one runs its Swift counterpart and validates the answer into
//! the bridge's types, so a malformed answer fails here rather than in the page.

use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager, Wry, plugin::mobile::PluginInvokeError};
use weblounge_ios_shell::IosShell;
use weblounge_native_bridge::{
    CreateRouteKeysRequest, DeliveredNotification, DropRouteKeysRequest, NativeBridgeError,
    PushPermission, PushTarget, PushedMessage, RemoveDeliveredNotificationsRequest, RouteKeys,
    SetBadgeRequest, WriteNotificationCountsRequest,
};

use super::{
    answers::{Delivered, Drained, Registration},
    failure::{self, Fallback, apns_registration, app_group, keychain, notification_center},
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
pub async fn take_pushed_messages(app: AppHandle) -> Result<Vec<PushedMessage>, NativeBridgeError> {
    let drained: Drained = call(&app, "takePushedMessages", (), app_group).await?;
    Ok(drained.into_messages())
}

#[tauri::command]
pub async fn set_badge(app: AppHandle, request: SetBadgeRequest) -> Result<(), NativeBridgeError> {
    call(&app, "setBadge", request, notification_center).await
}

#[tauri::command]
pub async fn write_notification_counts(
    app: AppHandle,
    request: WriteNotificationCountsRequest,
) -> Result<(), NativeBridgeError> {
    call(&app, "writeNotificationCounts", request, app_group).await
}

#[tauri::command]
pub async fn delivered_notifications(
    app: AppHandle,
) -> Result<Vec<DeliveredNotification>, NativeBridgeError> {
    let delivered: Delivered =
        call(&app, "deliveredNotifications", (), notification_center).await?;
    Ok(delivered.into_notifications())
}

#[tauri::command]
pub async fn remove_delivered_notifications(
    app: AppHandle,
    request: RemoveDeliveredNotificationsRequest,
) -> Result<(), NativeBridgeError> {
    call(
        &app,
        "removeDeliveredNotifications",
        request,
        notification_center,
    )
    .await
}
