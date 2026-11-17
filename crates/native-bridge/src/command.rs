use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The name of one shell command the page may `invoke`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativeCommand {
    /// Reads the notification authorization without prompting.
    PushPermission,
    /// Asks for alert, sound and badge authorization, then registers with APNs.
    RequestPushPermission,
    /// Opens the app's notification settings in the Settings app.
    OpenAppSettings,
    /// Reads the APNs target once the app delegate has a device token.
    PushTarget,
    /// Creates and stores one route's decryption keys.
    CreateRouteKeys,
    /// Forgets one route's keys and metadata.
    DropRouteKeys,
    /// Lists the routes whose pushes the extension could no longer decrypt.
    RoutesNeedingReregistration,
    /// Drains the messages the extension queued for the timeline.
    TakePushedMessages,
    /// Sets the app icon badge.
    SetBadge,
    /// Writes the per-conversation notification counts the extension starts from.
    WriteNotificationCounts,
    /// Lists the notifications still in Notification Center.
    DeliveredNotifications,
    /// Removes delivered notifications by identifier.
    RemoveDeliveredNotifications,
}

#[cfg(test)]
mod tests {
    use super::NativeCommand;

    #[test]
    fn commands_serialize_as_the_names_the_shell_registers() {
        for (command, name) in [
            (NativeCommand::PushPermission, "push_permission"),
            (
                NativeCommand::RequestPushPermission,
                "request_push_permission",
            ),
            (NativeCommand::OpenAppSettings, "open_app_settings"),
            (NativeCommand::PushTarget, "push_target"),
            (NativeCommand::CreateRouteKeys, "create_route_keys"),
            (NativeCommand::DropRouteKeys, "drop_route_keys"),
            (
                NativeCommand::RoutesNeedingReregistration,
                "routes_needing_reregistration",
            ),
            (NativeCommand::TakePushedMessages, "take_pushed_messages"),
            (NativeCommand::SetBadge, "set_badge"),
            (
                NativeCommand::WriteNotificationCounts,
                "write_notification_counts",
            ),
            (
                NativeCommand::DeliveredNotifications,
                "delivered_notifications",
            ),
            (
                NativeCommand::RemoveDeliveredNotifications,
                "remove_delivered_notifications",
            ),
        ] {
            assert_eq!(serde_json::to_value(command).expect("serializes"), name);
            assert_eq!(
                serde_json::from_value::<NativeCommand>(name.into()).expect("parses"),
                command
            );
        }
    }

    #[test]
    fn an_unknown_command_is_rejected() {
        assert!(serde_json::from_str::<NativeCommand>("\"post_notification\"").is_err());
    }
}
