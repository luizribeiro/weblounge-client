//! Generates the committed TypeScript bindings for the page's native bridge.

use std::{env, error::Error, path::Path};

use ts_rs::TS;
use weblounge_native_bridge::{
    CreateRouteKeysRequest, DeliveredNotification, DropRouteKeysRequest, NativeBridgeError,
    NativeCommand, PageEvent, PushPermission, PushTarget, PushedMessage,
    RemoveDeliveredNotificationsRequest, RouteKeys, SetBadgeRequest,
    WriteNotificationCountsRequest,
};

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: export_bridge <output-directory>")?;

    NativeCommand::export_all_to(&output)?;
    PushPermission::export_all_to(&output)?;
    PushTarget::export_all_to(&output)?;
    PageEvent::export_all_to(&output)?;
    CreateRouteKeysRequest::export_all_to(&output)?;
    DropRouteKeysRequest::export_all_to(&output)?;
    RouteKeys::export_all_to(&output)?;
    DeliveredNotification::export_all_to(&output)?;
    RemoveDeliveredNotificationsRequest::export_all_to(&output)?;
    PushedMessage::export_all_to(&output)?;
    SetBadgeRequest::export_all_to(&output)?;
    WriteNotificationCountsRequest::export_all_to(&output)?;
    NativeBridgeError::export_all_to(&output)?;
    weblounge_ts_export::trim_trailing_whitespace(Path::new(&output))?;
    Ok(())
}
