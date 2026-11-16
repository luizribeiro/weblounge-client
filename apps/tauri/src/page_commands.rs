/// The app commands the page may invoke. build.rs `include!`s this file to generate their
/// permissions, so it holds items only.
pub const PAGE_COMMANDS: &[&str] = &[
    "notification_permission",
    "request_notification_permission",
    "post_notification",
    "close_notification",
    "push_permission",
    "request_push_permission",
    "push_target",
    "create_route_keys",
    "drop_route_keys",
    "take_pushed_messages",
    "set_badge",
    "write_notification_counts",
    "delivered_notifications",
    "remove_delivered_notifications",
];
