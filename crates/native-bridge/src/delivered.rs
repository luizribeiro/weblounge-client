use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::BufferRoutePath;

/// The `data` of a chat notification, in the fields the page's read and redaction cleanup
/// match on.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChatNotificationData {
    /// Where a tap opens.
    pub route: BufferRoutePath,
    /// The conversation tag, `<network label>/<lowercased buffer>`.
    pub conversation_tag: String,
    /// The IRC msgid, which is also the notification's identifier.
    pub message_id: String,
    /// The message's server time, as ISO 8601.
    pub message_time: String,
}

/// The `data` of a notification that shows no message, such as an invite.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct RouteNotificationData {
    /// Where a tap opens.
    pub route: BufferRoutePath,
}

/// A notification's `userInfo`, shaped like the `data` the service worker gives its
/// notifications so the page's cleanup reads both the same way. Untagged variants are tried
/// in order and extra fields are ignored, so `Chat` must come first; data missing any chat
/// field reads as `Route`, which the page's cleanup treats as unread, as it does on the web.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum NotificationData {
    /// A notification for one message.
    Chat(ChatNotificationData),
    /// A notification that only opens a buffer.
    Route(RouteNotificationData),
}

/// One notification still in Notification Center.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct DeliveredNotification {
    /// The request identifier, which `remove_delivered_notifications` takes.
    pub identifier: String,
    /// The extension's data, absent when APNs showed its placeholder.
    pub data: Option<NotificationData>,
}

/// `remove_delivered_notifications`: withdraws notifications; unknown identifiers are ignored.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct RemoveDeliveredNotificationsRequest {
    /// The identifiers to remove.
    pub identifiers: Vec<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ChatNotificationData, DeliveredNotification, NotificationData, RouteNotificationData,
    };
    use crate::BufferRoutePath;

    fn route(path: &str) -> BufferRoutePath {
        BufferRoutePath::try_from(path.to_owned()).expect("valid route")
    }

    #[test]
    fn a_chat_notification_carries_the_service_workers_data_fields() {
        let notification = DeliveredNotification {
            identifier: "AAAAAAAAAAAAAAAAAAAAAA".to_owned(),
            data: Some(NotificationData::Chat(ChatNotificationData {
                route: route("/Libera/weblounge"),
                conversation_tag: "Libera/#weblounge".to_owned(),
                message_id: "AAAAAAAAAAAAAAAAAAAAAA".to_owned(),
                message_time: "2026-11-16T12:34:56.789Z".to_owned(),
            })),
        };
        let value = json!({
            "identifier": "AAAAAAAAAAAAAAAAAAAAAA",
            "data": {
                "route": "/Libera/weblounge",
                "conversationTag": "Libera/#weblounge",
                "messageId": "AAAAAAAAAAAAAAAAAAAAAA",
                "messageTime": "2026-11-16T12:34:56.789Z",
            },
        });

        assert_eq!(
            serde_json::to_value(&notification).expect("serializes"),
            value
        );
        assert_eq!(
            serde_json::from_value::<DeliveredNotification>(value).expect("parses"),
            notification
        );
    }

    #[test]
    fn a_generic_notification_has_a_route_but_no_message() {
        let value = json!({ "identifier": "generic-1", "data": { "route": "/" } });
        let notification =
            serde_json::from_value::<DeliveredNotification>(value.clone()).expect("parses");

        assert_eq!(
            notification.data,
            Some(NotificationData::Route(RouteNotificationData {
                route: route("/")
            }))
        );
        assert_eq!(
            serde_json::to_value(&notification).expect("serializes"),
            value
        );
    }

    #[test]
    fn partial_chat_data_reads_as_a_route() {
        let value = json!({
            "identifier": "invite-1",
            "data": { "route": "/Libera/lounge", "conversationTag": "Libera/#lounge" },
        });
        let notification = serde_json::from_value::<DeliveredNotification>(value).expect("parses");

        assert_eq!(
            notification.data,
            Some(NotificationData::Route(RouteNotificationData {
                route: route("/Libera/lounge"),
            }))
        );
    }

    #[test]
    fn a_placeholder_has_no_data() {
        let value = json!({ "identifier": "placeholder", "data": null });
        let notification =
            serde_json::from_value::<DeliveredNotification>(value.clone()).expect("parses");
        assert_eq!(notification.data, None);
        assert_eq!(
            serde_json::to_value(&notification).expect("serializes"),
            value
        );
    }

    #[test]
    fn data_with_an_unsafe_route_does_not_deserialize() {
        let value = json!({ "identifier": "x", "data": { "route": "https://evil.example/" } });
        assert!(serde_json::from_value::<DeliveredNotification>(value).is_err());
    }
}
