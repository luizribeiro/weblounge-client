use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One conversation's unread notification count, the page's `ConversationNotificationCount`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationNotificationCount {
    /// The conversation tag, `<network label>/<lowercased buffer>`.
    pub tag: String,
    /// Notifications the engine still counts as unread.
    pub count: u32,
    /// When the conversation was last read, in Unix milliseconds, so the extension can ignore
    /// a late push for a message already read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub read_at_ms: Option<u64>,
}

/// `write_notification_counts`: replaces the counts and read markers in the App Group.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct WriteNotificationCountsRequest {
    /// Every known conversation; one missing here has no count.
    pub counts: Vec<ConversationNotificationCount>,
}

/// `set_badge`: sets the app icon badge, where zero clears it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct SetBadgeRequest {
    /// The number to show.
    pub count: u32,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ConversationNotificationCount, SetBadgeRequest, WriteNotificationCountsRequest};

    #[test]
    fn counts_round_trip_in_the_pages_shape() {
        let request = WriteNotificationCountsRequest {
            counts: vec![
                ConversationNotificationCount {
                    tag: "Libera/#weblounge".to_owned(),
                    count: 0,
                    read_at_ms: Some(1_794_833_696_789),
                },
                ConversationNotificationCount {
                    tag: "Libera/mel".to_owned(),
                    count: 3,
                    read_at_ms: None,
                },
            ],
        };
        let value = json!({
            "counts": [
                { "tag": "Libera/#weblounge", "count": 0, "readAtMs": 1_794_833_696_789_u64 },
                { "tag": "Libera/mel", "count": 3 },
            ],
        });

        assert_eq!(serde_json::to_value(&request).expect("serializes"), value);
        assert_eq!(
            serde_json::from_value::<WriteNotificationCountsRequest>(value).expect("parses"),
            request
        );
    }

    #[test]
    fn negative_or_fractional_counts_are_rejected() {
        for count in [json!(-1), json!(1.5)] {
            let value = json!({ "counts": [{ "tag": "Libera/mel", "count": count }] });
            assert!(serde_json::from_value::<WriteNotificationCountsRequest>(value).is_err());
            assert!(serde_json::from_value::<SetBadgeRequest>(json!({ "count": count })).is_err());
            let marker =
                json!({ "counts": [{ "tag": "Libera/mel", "count": 0, "readAtMs": count }] });
            assert!(serde_json::from_value::<WriteNotificationCountsRequest>(marker).is_err());
        }
    }

    #[test]
    fn an_empty_replacement_clears_every_count() {
        let request =
            serde_json::from_value::<WriteNotificationCountsRequest>(json!({ "counts": [] }))
                .expect("parses");
        assert!(request.counts.is_empty());
    }

    #[test]
    fn a_zero_badge_round_trips() {
        let value = json!({ "count": 0 });
        let request = SetBadgeRequest { count: 0 };
        assert_eq!(serde_json::to_value(request).expect("serializes"), value);
        assert_eq!(
            serde_json::from_value::<SetBadgeRequest>(value).expect("parses"),
            request
        );
    }
}
