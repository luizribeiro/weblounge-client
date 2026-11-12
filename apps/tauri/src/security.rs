//! Pins the only way the hosted page can reach Tauri.

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::window::{APP_URL, MAIN_LABEL};

    #[test]
    fn remote_page_may_only_use_the_badge_and_notifications() {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("config is JSON");
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .expect("capabilities are declared inline");
        assert_eq!(capabilities.len(), 1);
        let capability = &capabilities[0];
        assert_eq!(capability["windows"], json!([MAIN_LABEL]));
        assert_eq!(
            capability["remote"]["urls"],
            json!([format!("{APP_URL}/*")])
        );
        assert_eq!(
            capability["permissions"],
            json!([
                "core:window:allow-set-badge-count",
                "allow-notification-permission",
                "allow-request-notification-permission",
                "allow-post-notification",
                "allow-close-notification"
            ])
        );
    }
}
