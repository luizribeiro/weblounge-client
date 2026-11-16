//! Pins the only way the hosted page can reach Tauri.

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::{Value, json};
    use weblounge_native_bridge::NativeCommand;

    use crate::{
        page_commands::PAGE_COMMANDS,
        window::{APP_URL, MAIN_LABEL},
    };

    const IOS_PERMISSIONS: [&str; 10] = [
        "allow-push-permission",
        "allow-request-push-permission",
        "allow-push-target",
        "allow-create-route-keys",
        "allow-drop-route-keys",
        "allow-take-pushed-messages",
        "allow-set-badge",
        "allow-write-notification-counts",
        "allow-delivered-notifications",
        "allow-remove-delivered-notifications",
    ];

    fn capabilities() -> Vec<Value> {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("config is JSON");
        config["app"]["security"]["capabilities"]
            .as_array()
            .expect("capabilities are declared inline")
            .clone()
    }

    fn assert_scoped_to_the_hosted_page(capability: &Value) {
        assert_eq!(capability["windows"], json!([MAIN_LABEL]));
        assert_eq!(
            capability["remote"]["urls"],
            json!([format!("{APP_URL}/*")])
        );
    }

    #[test]
    fn remote_page_has_exactly_the_shared_and_the_ios_capability() {
        let identifiers: Vec<_> = capabilities()
            .iter()
            .map(|capability| capability["identifier"].clone())
            .collect();
        assert_eq!(
            identifiers,
            [json!("remote-page"), json!("remote-page-ios")]
        );
    }

    #[test]
    fn remote_page_may_only_use_the_badge_notifications_and_window_chrome() {
        let capability = &capabilities()[0];
        assert_scoped_to_the_hosted_page(capability);
        assert!(capability.get("platforms").is_none());
        assert_eq!(
            capability["permissions"],
            json!([
                "core:window:allow-set-badge-count",
                "allow-notification-permission",
                "allow-request-notification-permission",
                "allow-post-notification",
                "allow-close-notification",
                "core:window:allow-start-dragging",
                "core:window:allow-internal-toggle-maximize",
                "core:window:allow-is-fullscreen",
                "core:window:allow-set-theme",
                "core:window:allow-set-background-color",
                "core:webview:allow-set-webview-background-color"
            ])
        );
    }

    #[test]
    fn remote_page_may_use_the_native_bridge_commands_on_ios_only() {
        let capability = &capabilities()[1];
        assert_scoped_to_the_hosted_page(capability);
        assert_eq!(capability["platforms"], json!(["iOS"]));
        assert_eq!(capability["permissions"], json!(IOS_PERMISSIONS));
    }

    /// The match stops compiling when the bridge gains a command, so its grant is decided here.
    fn every_native_command() -> HashSet<NativeCommand> {
        use NativeCommand::{
            CreateRouteKeys, DeliveredNotifications, DropRouteKeys, PushPermission, PushTarget,
            RemoveDeliveredNotifications, RequestPushPermission, SetBadge, TakePushedMessages,
            WriteNotificationCounts,
        };
        let all = [
            PushPermission,
            RequestPushPermission,
            PushTarget,
            CreateRouteKeys,
            DropRouteKeys,
            TakePushedMessages,
            SetBadge,
            WriteNotificationCounts,
            DeliveredNotifications,
            RemoveDeliveredNotifications,
        ];
        for command in all {
            match command {
                PushPermission
                | RequestPushPermission
                | PushTarget
                | CreateRouteKeys
                | DropRouteKeys
                | TakePushedMessages
                | SetBadge
                | WriteNotificationCounts
                | DeliveredNotifications
                | RemoveDeliveredNotifications => {}
            }
        }
        all.into_iter().collect()
    }

    #[test]
    fn the_ios_permissions_name_every_native_command_once() {
        let commands: HashSet<NativeCommand> = IOS_PERMISSIONS
            .iter()
            .map(|permission| {
                let name = permission.trim_start_matches("allow-").replace('-', "_");
                serde_json::from_value(json!(name)).expect("a native command")
            })
            .collect();
        assert_eq!(commands.len(), IOS_PERMISSIONS.len());
        assert_eq!(commands, every_native_command());
        for permission in IOS_PERMISSIONS {
            let name = permission.trim_start_matches("allow-").replace('-', "_");
            assert!(
                PAGE_COMMANDS.contains(&name.as_str()),
                "build.rs defines no permission for {name}"
            );
        }
    }
}
