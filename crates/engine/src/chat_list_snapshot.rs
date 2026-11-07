use crate::storage::{KvBackend, Operation, Space, StorageError};
use serde::{Deserialize, Serialize};

pub(crate) const SNAPSHOT_KEY: &[u8] = b"chat-list-snapshot";
const SCHEMA_VERSION: u32 = 5;
const ACCOUNT_KEY_SCHEMA: u32 = 2;
const COUNTLESS_BADGE_SCHEMA: u32 = 3;
const ACTIVITY_CURSOR_SCHEMA: u32 = 4;
pub(crate) const PREVIEW_LIMIT: usize = 80;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct ChatListSnapshot {
    schema: u32,
    fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) synced_through_ms: Option<i64>,
    pub(crate) rows: Vec<SnapshotRow>,
}

impl ChatListSnapshot {
    pub(crate) fn new(fingerprint: String, rows: Vec<SnapshotRow>) -> Self {
        Self {
            schema: SCHEMA_VERSION,
            fingerprint,
            synced_through_ms: None,
            rows,
        }
    }

    pub(crate) const fn with_synced_through_ms(mut self, synced_through_ms: Option<i64>) -> Self {
        self.synced_through_ms = synced_through_ms;
        self
    }

    pub(crate) fn decode(bytes: &[u8], expected: &str) -> Option<Self> {
        let mut value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
        let schema = u32::try_from(value.get("schema")?.as_u64()?).ok()?;
        if matches!(
            schema,
            ACCOUNT_KEY_SCHEMA | COUNTLESS_BADGE_SCHEMA | ACTIVITY_CURSOR_SCHEMA
        ) {
            value["schema"] = SCHEMA_VERSION.into();
            for row in value.get_mut("rows")?.as_array_mut()? {
                if schema <= ACCOUNT_KEY_SCHEMA {
                    row.as_object_mut()?.remove("peer_pin");
                }
                if schema <= COUNTLESS_BADGE_SCHEMA {
                    let badge = row.get_mut("badge")?.as_object_mut()?;
                    let kind = badge.get("kind")?.as_str()?;
                    if kind == "unread" && !badge.contains_key("count") {
                        badge.insert("count".into(), 1.into());
                    } else if kind == "mentions" && !badge.contains_key("mentions") {
                        let mentions = badge.get("count")?.clone();
                        badge.insert("mentions".into(), mentions);
                    }
                }
                if let Some(server_time_ms) = row
                    .get("last_activity_ms")
                    .and_then(serde_json::Value::as_i64)
                {
                    row.as_object_mut()?.insert(
                        "newest".into(),
                        serde_json::json!({ "server_time_ms": server_time_ms }),
                    );
                }
            }
        }
        let snapshot = serde_json::from_value::<Self>(value).ok()?;
        (snapshot.schema == SCHEMA_VERSION && snapshot.fingerprint == expected).then_some(snapshot)
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, StorageError> {
        serde_json::to_vec(self).map_err(|error| StorageError::Encoding(error.to_string()))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SnapshotRow {
    pub(crate) conversation: SnapshotConversation,
    pub(crate) title: String,
    pub(crate) last_activity_ms: Option<i64>,
    pub(crate) badge: SnapshotBadge,
    pub(crate) preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) newest: Option<SnapshotCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) read_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) peer_pin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SnapshotCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) msgid: Option<String>,
    pub(crate) server_time_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SnapshotConversation {
    Channel { key: String },
    Direct { key: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SnapshotBadge {
    None,
    Unread { count: u64 },
    Mentions { count: u64, mentions: u64 },
}

pub(crate) fn fingerprint(label: &str, endpoint: &str) -> String {
    format!("{}:{label}{}:{endpoint}", label.len(), endpoint.len())
}

pub(crate) fn truncate_preview(value: &str) -> String {
    let mut characters = value.chars();
    let prefix = characters.by_ref().take(PREVIEW_LIMIT).collect::<String>();
    if characters.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
pub(crate) async fn read<B: KvBackend>(backend: &B) -> Result<Option<Vec<u8>>, StorageError> {
    backend.get(Space::Cache, SNAPSHOT_KEY).await
}

pub(crate) async fn write<B: KvBackend>(
    backend: &B,
    snapshot: &ChatListSnapshot,
) -> Result<(), StorageError> {
    backend
        .commit(
            Space::Cache,
            vec![Operation::Put {
                key: SNAPSHOT_KEY.to_vec(),
                value: snapshot.encode()?,
            }],
        )
        .await
}

pub(crate) async fn clear<B: KvBackend>(backend: &B) -> Result<(), StorageError> {
    backend.clear(Space::Cache).await
}

#[cfg(test)]
mod tests {
    use super::{
        ChatListSnapshot, SnapshotBadge, SnapshotConversation, SnapshotCursor, SnapshotRow, clear,
        fingerprint, read, truncate_preview, write,
    };
    use crate::storage::MemoryKv;

    fn snapshot() -> ChatListSnapshot {
        ChatListSnapshot::new(
            fingerprint("Lounge", "wss://irc.example"),
            vec![
                SnapshotRow {
                    conversation: SnapshotConversation::Channel {
                        key: "#rust".into(),
                    },
                    title: "#Rust".into(),
                    last_activity_ms: Some(1_700_000_000_000),
                    badge: SnapshotBadge::Unread { count: 7 },
                    preview: Some("mel: hello".into()),
                    newest: Some(SnapshotCursor {
                        msgid: Some("newest-1".into()),
                        server_time_ms: 1_700_000_000_000,
                    }),
                    read_at_ms: Some(1_699_999_999_000),
                    peer_pin: None,
                },
                SnapshotRow {
                    conversation: SnapshotConversation::Direct {
                        key: "alice".into(),
                    },
                    title: "Alice".into(),
                    last_activity_ms: Some(1_700_000_000_001),
                    badge: SnapshotBadge::Mentions {
                        count: 5,
                        mentions: 3,
                    },
                    preview: Some(truncate_preview(&"é".repeat(81))),
                    newest: None,
                    read_at_ms: None,
                    peer_pin: Some("papo-peer-v1;scope=server%3Aexample;account=alice".into()),
                },
            ],
        )
        .with_synced_through_ms(Some(1_700_000_000_100))
    }

    #[test]
    fn record_has_only_versioned_bounded_chat_list_data() {
        let snapshot = snapshot();
        let encoded = snapshot.encode().expect("encode");
        let value: serde_json::Value = serde_json::from_slice(&encoded).expect("json");

        assert_eq!(value["schema"], 5);
        assert_eq!(value["synced_through_ms"], 1_700_000_000_100_i64);
        assert_eq!(value["rows"][0]["last_activity_ms"], 1_700_000_000_000_i64);
        assert_eq!(value["rows"][0]["newest"]["msgid"], "newest-1");
        assert_eq!(value["rows"][0]["read_at_ms"], 1_699_999_999_000_i64);
        assert_eq!(value["rows"][0]["badge"]["count"], 7);
        assert_eq!(value["rows"][1]["badge"]["count"], 5);
        assert_eq!(value["rows"][1]["badge"]["mentions"], 3);
        assert_eq!(
            value["rows"][1]["preview"]
                .as_str()
                .map(str::chars)
                .map(Iterator::count),
            Some(81)
        );
        assert!(value["rows"][0].get("id").is_none());
        assert!(value["rows"][0].get("timestamp").is_none());
    }

    #[test]
    fn validation_ignores_corruption_unknown_versions_and_other_networks() {
        let snapshot = snapshot();
        let expected = fingerprint("Lounge", "wss://irc.example");
        assert_eq!(
            ChatListSnapshot::decode(&snapshot.encode().expect("encode"), &expected),
            Some(snapshot.clone())
        );
        assert!(ChatListSnapshot::decode(b"not json", &expected).is_none());

        let mut unknown: serde_json::Value =
            serde_json::from_slice(&snapshot.encode().expect("encode")).expect("json");
        unknown["schema"] = 1.into();
        assert!(
            ChatListSnapshot::decode(&serde_json::to_vec(&unknown).expect("json"), &expected)
                .is_none()
        );
        assert!(ChatListSnapshot::decode(&snapshot.encode().expect("encode"), "other").is_none());
    }

    #[test]
    fn account_key_schema_migrates_without_inventing_peer_pins() {
        let snapshot = snapshot();
        let expected = fingerprint("Lounge", "wss://irc.example");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&snapshot.encode().expect("encode")).expect("json");
        legacy["schema"] = 2.into();
        legacy
            .as_object_mut()
            .expect("snapshot")
            .remove("synced_through_ms");
        for row in legacy["rows"].as_array_mut().expect("rows") {
            let badge = row["badge"].as_object_mut().expect("badge");
            if badge["kind"] == "unread" {
                badge.remove("count");
            } else if badge["kind"] == "mentions" {
                badge.remove("mentions");
                badge.insert("count".into(), 3.into());
            }
        }

        let migrated =
            ChatListSnapshot::decode(&serde_json::to_vec(&legacy).expect("json"), &expected)
                .expect("schema 2 migrates");

        assert_eq!(migrated.schema, 5);
        assert_eq!(migrated.synced_through_ms, None);
        assert!(migrated.rows.iter().all(|row| row.peer_pin.is_none()));
        assert_eq!(migrated.rows[0].badge, SnapshotBadge::Unread { count: 1 });
        assert_eq!(
            migrated.rows[1].badge,
            SnapshotBadge::Mentions {
                count: 3,
                mentions: 3,
            }
        );
    }

    #[test]
    fn countless_badge_schema_migrates_to_visible_counts() {
        let snapshot = snapshot();
        let expected = fingerprint("Lounge", "wss://irc.example");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&snapshot.encode().expect("encode")).expect("json");
        legacy["schema"] = 3.into();
        legacy
            .as_object_mut()
            .expect("snapshot")
            .remove("synced_through_ms");
        legacy["rows"][0]["badge"] = serde_json::json!({ "kind": "unread" });
        legacy["rows"][1]["badge"] = serde_json::json!({ "kind": "mentions", "count": 3 });

        let migrated =
            ChatListSnapshot::decode(&serde_json::to_vec(&legacy).expect("json"), &expected)
                .expect("schema 3 migrates");

        assert_eq!(migrated.rows[0].badge, SnapshotBadge::Unread { count: 1 });
        assert_eq!(
            migrated.rows[1].badge,
            SnapshotBadge::Mentions {
                count: 3,
                mentions: 3,
            }
        );
    }

    #[tokio::test]
    async fn whole_record_write_and_sign_out_clear_are_atomic() {
        let backend = MemoryKv::default();
        let expected = snapshot();
        write(&backend, &expected).await.expect("write");
        assert_eq!(
            read(&backend)
                .await
                .expect("read")
                .and_then(|bytes| ChatListSnapshot::decode(&bytes, &expected.fingerprint)),
            Some(expected)
        );
        clear(&backend).await.expect("clear");
        assert_eq!(read(&backend).await.expect("read"), None);
    }
}
