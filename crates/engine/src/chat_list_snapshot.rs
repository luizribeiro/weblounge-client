use crate::storage::{KvBackend, Operation, Space, StorageError};
use serde::{Deserialize, Serialize};

pub(crate) const SNAPSHOT_KEY: &[u8] = b"chat-list-snapshot";
const SCHEMA_VERSION: u32 = 2;
pub(crate) const PREVIEW_LIMIT: usize = 80;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct ChatListSnapshot {
    schema: u32,
    fingerprint: String,
    pub(crate) rows: Vec<SnapshotRow>,
}

impl ChatListSnapshot {
    pub(crate) fn new(fingerprint: String, rows: Vec<SnapshotRow>) -> Self {
        Self {
            schema: SCHEMA_VERSION,
            fingerprint,
            rows,
        }
    }

    pub(crate) fn decode(bytes: &[u8], expected: &str) -> Option<Self> {
        let snapshot = serde_json::from_slice::<Self>(bytes).ok()?;
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SnapshotConversation {
    Channel { key: String },
    Direct { key: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "count", rename_all = "snake_case")]
pub(crate) enum SnapshotBadge {
    None,
    Unread,
    Mentions(u64),
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
        ChatListSnapshot, SnapshotBadge, SnapshotConversation, SnapshotRow, clear, fingerprint,
        read, truncate_preview, write,
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
                    badge: SnapshotBadge::Unread,
                    preview: Some("mel: hello".into()),
                },
                SnapshotRow {
                    conversation: SnapshotConversation::Direct {
                        key: "alice".into(),
                    },
                    title: "Alice".into(),
                    last_activity_ms: Some(1_700_000_000_001),
                    badge: SnapshotBadge::Mentions(3),
                    preview: Some(truncate_preview(&"é".repeat(81))),
                },
            ],
        )
    }

    #[test]
    fn record_has_only_versioned_bounded_chat_list_data() {
        let snapshot = snapshot();
        let encoded = snapshot.encode().expect("encode");
        let value: serde_json::Value = serde_json::from_slice(&encoded).expect("json");

        assert_eq!(value["schema"], 2);
        assert_eq!(value["rows"][0]["last_activity_ms"], 1_700_000_000_000_i64);
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
