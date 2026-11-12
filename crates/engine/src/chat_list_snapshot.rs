use crate::{
    read_model::{MessageStub, ReadFacts, ServerTimeMs, merge_max},
    storage::{KvBackend, Space, StorageError},
};
use serde::{Deserialize, Serialize};

pub(crate) const SNAPSHOT_KEY: &[u8] = b"chat-list-snapshot";
const SCHEMA_VERSION: u32 = 8;
const TRANSCRIPT_GAP_SCHEMA: u32 = 7;
const MERGED_ROW_SCHEMA: u32 = 6;
const ACCOUNT_KEY_SCHEMA: u32 = 2;
const COUNTLESS_BADGE_SCHEMA: u32 = 3;
const ACTIVITY_CURSOR_SCHEMA: u32 = 4;
const SAVED_BADGE_SCHEMA: u32 = 5;
pub(crate) const PREVIEW_LIMIT: usize = 80;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct ChatListSnapshot {
    schema: u32,
    fingerprint: String,
    #[serde(
        default,
        alias = "synced_through_ms",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) cursor_ms: Option<i64>,
    pub(crate) rows: Vec<SnapshotRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    presences: Vec<SnapshotPresence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tombstones: Vec<SnapshotRemoval>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SnapshotPresence {
    pub(crate) conversation: SnapshotConversation,
    pub(crate) joined_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SnapshotRemoval {
    pub(crate) conversation: SnapshotConversation,
    pub(crate) removed_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SnapshotChanges {
    fingerprint: String,
    cursor_ms: Option<i64>,
    rows: Vec<SnapshotRow>,
    removed: Vec<SnapshotRemoval>,
    joined: Vec<SnapshotPresence>,
}

impl SnapshotChanges {
    pub(crate) fn between(
        previous: &ChatListSnapshot,
        next: &ChatListSnapshot,
        removed: Vec<SnapshotRemoval>,
        joined: Vec<SnapshotPresence>,
    ) -> Option<Self> {
        let rows = next
            .rows
            .iter()
            .filter(|row| {
                previous
                    .rows
                    .iter()
                    .find(|stored| stored.conversation == row.conversation)
                    != Some(*row)
            })
            .cloned()
            .collect::<Vec<_>>();
        let cursor_ms = (next.cursor_ms > previous.cursor_ms)
            .then_some(next.cursor_ms)
            .flatten();
        (!rows.is_empty() || !removed.is_empty() || !joined.is_empty() || cursor_ms.is_some()).then(
            || Self {
                fingerprint: next.fingerprint.clone(),
                cursor_ms,
                rows,
                removed,
                joined,
            },
        )
    }

    #[cfg(test)]
    fn initial(snapshot: &ChatListSnapshot) -> Self {
        Self {
            fingerprint: snapshot.fingerprint.clone(),
            cursor_ms: snapshot.cursor_ms,
            rows: snapshot.rows.clone(),
            removed: snapshot.tombstones.clone(),
            joined: snapshot.presences.clone(),
        }
    }
}

impl ChatListSnapshot {
    pub(crate) fn new(fingerprint: String, rows: Vec<SnapshotRow>) -> Self {
        Self {
            schema: SCHEMA_VERSION,
            fingerprint,
            cursor_ms: None,
            rows,
            presences: Vec::new(),
            tombstones: Vec::new(),
        }
    }

    pub(crate) const fn with_cursor_ms(mut self, cursor_ms: Option<i64>) -> Self {
        self.cursor_ms = cursor_ms;
        self
    }

    pub(crate) fn decode(bytes: &[u8], expected: &str) -> Option<Self> {
        let mut value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
        let schema = u32::try_from(value.get("schema")?.as_u64()?).ok()?;
        if schema == TRANSCRIPT_GAP_SCHEMA {
            value["schema"] = SCHEMA_VERSION.into();
            for row in value.get_mut("rows")?.as_array_mut()? {
                row.as_object_mut()?.remove("gap_until");
            }
        } else if schema == MERGED_ROW_SCHEMA {
            value["schema"] = SCHEMA_VERSION.into();
        } else if matches!(
            schema,
            ACCOUNT_KEY_SCHEMA
                | COUNTLESS_BADGE_SCHEMA
                | ACTIVITY_CURSOR_SCHEMA
                | SAVED_BADGE_SCHEMA
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
                if row.get("newest").is_none()
                    && let Some(server_time_ms) = row
                        .get("last_activity_ms")
                        .and_then(serde_json::Value::as_i64)
                {
                    row.as_object_mut()?.insert(
                        "newest".into(),
                        serde_json::json!({ "server_time_ms": server_time_ms }),
                    );
                }
                row.as_object_mut()?.remove("stubs");
                row.as_object_mut()?.remove("gap_until");
                row.as_object_mut()?.remove("pending_read_at_ms");
                row.as_object_mut()?.remove("badge");
            }
        }
        let snapshot = serde_json::from_value::<Self>(value).ok()?;
        (snapshot.schema == SCHEMA_VERSION && snapshot.fingerprint == expected).then_some(snapshot)
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, StorageError> {
        serde_json::to_vec(self).map_err(|error| StorageError::Encoding(error.to_string()))
    }

    fn merge_row(&mut self, incoming: SnapshotRow) {
        if self
            .tombstones
            .iter()
            .any(|removed| removed.conversation == incoming.conversation)
        {
            return;
        }
        if let Some(stored) = self
            .rows
            .iter_mut()
            .find(|stored| stored.conversation == incoming.conversation)
        {
            stored.merge(incoming);
        } else {
            self.rows.push(incoming);
        }
    }

    fn merge_presence(&mut self, incoming: SnapshotPresence) {
        let conversation = incoming.conversation.clone();
        let joined_at_ms = incoming.joined_at_ms;
        if let Some(stored) = self
            .presences
            .iter_mut()
            .find(|stored| stored.conversation == incoming.conversation)
        {
            stored.joined_at_ms = stored.joined_at_ms.max(joined_at_ms);
        } else {
            self.presences.push(incoming);
        }
        self.tombstones.retain(|removed| {
            removed.conversation != conversation || removed.removed_at_ms >= joined_at_ms
        });
    }

    fn merge_removal(&mut self, incoming: SnapshotRemoval) {
        let joined_at_ms = self
            .presences
            .iter()
            .find(|presence| presence.conversation == incoming.conversation)
            .map(|presence| presence.joined_at_ms);
        if joined_at_ms.is_some_and(|joined| joined > incoming.removed_at_ms) {
            return;
        }
        let conversation = incoming.conversation.clone();
        if let Some(stored) = self
            .tombstones
            .iter_mut()
            .find(|stored| stored.conversation == conversation)
        {
            stored.removed_at_ms = stored.removed_at_ms.max(incoming.removed_at_ms);
        } else {
            self.tombstones.push(incoming);
        }
        self.rows.retain(|row| row.conversation != conversation);
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SnapshotRow {
    pub(crate) conversation: SnapshotConversation,
    pub(crate) title: String,
    pub(crate) last_activity_ms: Option<i64>,
    pub(crate) preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) newest: Option<SnapshotCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) read_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) raw_read_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_read_at_ms: Option<i64>,
    #[serde(default)]
    pub(crate) stubs: Vec<MessageStub>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) gap_until: Option<ServerTimeMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) peer_pin: Option<String>,
}

impl SnapshotRow {
    fn merge(&mut self, incoming: Self) {
        let mut facts = read_facts(self);
        facts.merge(read_facts(&incoming));
        let incoming_is_newer = latest_time(&incoming) >= latest_time(self);
        let Self {
            title,
            last_activity_ms,
            preview,
            newest,
            peer_pin,
            ..
        } = incoming;
        if incoming_is_newer {
            self.title = title;
            self.last_activity_ms = last_activity_ms;
            self.preview = preview;
            self.newest = newest;
        }
        self.peer_pin = self.peer_pin.take().or(peer_pin);
        self.read_at_ms = facts.mark().map(ServerTimeMs::value);
        self.raw_read_at_ms = facts.raw_mark().map(ServerTimeMs::value);
        self.pending_read_at_ms = facts.pending().map(ServerTimeMs::value);
        self.stubs = facts.stubs().to_vec();
        self.gap_until = facts.gap_until();
    }
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

#[cfg(test)]
pub(crate) async fn write<B: KvBackend>(
    backend: &B,
    snapshot: &ChatListSnapshot,
) -> Result<(), StorageError> {
    write_changes(backend, &SnapshotChanges::initial(snapshot)).await
}

pub(crate) async fn write_changes<B: KvBackend>(
    backend: &B,
    changes: &SnapshotChanges,
) -> Result<(), StorageError> {
    let changes = changes.clone();
    backend
        .update(Space::Cache, SNAPSHOT_KEY, |stored| {
            let mut snapshot = stored
                .as_deref()
                .and_then(|bytes| ChatListSnapshot::decode(bytes, &changes.fingerprint))
                .unwrap_or_else(|| ChatListSnapshot::new(changes.fingerprint.clone(), Vec::new()));
            for joined in changes.joined {
                snapshot.merge_presence(joined);
            }
            for removed in changes.removed {
                snapshot.merge_removal(removed);
            }
            for row in changes.rows {
                snapshot.merge_row(row);
            }
            merge_max(&mut snapshot.cursor_ms, changes.cursor_ms);
            snapshot.encode().map(Some)
        })
        .await
}

pub(crate) async fn clear<B: KvBackend>(backend: &B) -> Result<(), StorageError> {
    backend.clear(Space::Cache).await
}

fn read_facts(row: &SnapshotRow) -> ReadFacts {
    let mut facts = ReadFacts::default();
    facts.merge_snapshot_marks(
        row.raw_read_at_ms.map(ServerTimeMs::new),
        row.read_at_ms.map(ServerTimeMs::new),
    );
    if let Some(pending) = row.pending_read_at_ms {
        facts.merge_pending(ServerTimeMs::new(pending));
    }
    for stub in &row.stubs {
        facts.merge_stub(stub.clone());
    }
    if let Some(gap_until) = row.gap_until {
        facts.merge_gap_until(gap_until);
    }
    facts
}

fn latest_time(row: &SnapshotRow) -> Option<i64> {
    row.newest
        .as_ref()
        .map(|cursor| cursor.server_time_ms)
        .or(row.last_activity_ms)
}

#[cfg(test)]
mod tests {
    use super::{
        ChatListSnapshot, SnapshotChanges, SnapshotConversation, SnapshotCursor, SnapshotPresence,
        SnapshotRemoval, SnapshotRow, clear, fingerprint, read, truncate_preview, write,
        write_changes,
    };
    use crate::read_model::{MessageStub, ServerTimeMs};
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
                    preview: Some("mel: hello".into()),
                    newest: Some(SnapshotCursor {
                        msgid: Some("newest-1".into()),
                        server_time_ms: 1_700_000_000_000,
                    }),
                    read_at_ms: Some(1_699_999_999_000),
                    raw_read_at_ms: Some(1_699_999_999_000),
                    pending_read_at_ms: Some(1_699_999_999_000),
                    stubs: vec![MessageStub {
                        msgid: "newest-1".into(),
                        time: ServerTimeMs::new(1_700_000_000_000),
                        provisional_time: None,
                        mention: false,
                    }],
                    gap_until: None,
                    peer_pin: None,
                },
                SnapshotRow {
                    conversation: SnapshotConversation::Direct {
                        key: "alice".into(),
                    },
                    title: "Alice".into(),
                    last_activity_ms: Some(1_700_000_000_001),
                    preview: Some(truncate_preview(&"é".repeat(81))),
                    newest: None,
                    read_at_ms: None,
                    raw_read_at_ms: None,
                    pending_read_at_ms: None,
                    stubs: vec![MessageStub {
                        msgid: "alice-1".into(),
                        time: ServerTimeMs::new(1_700_000_000_001),
                        provisional_time: None,
                        mention: true,
                    }],
                    gap_until: Some(ServerTimeMs::new(1_700_000_000_000)),
                    peer_pin: Some("papo-peer-v1;scope=server%3Aexample;account=alice".into()),
                },
            ],
        )
        .with_cursor_ms(Some(1_700_000_000_100))
    }

    #[test]
    fn record_has_only_versioned_bounded_chat_list_data() {
        let snapshot = snapshot();
        let encoded = snapshot.encode().expect("encode");
        let value: serde_json::Value = serde_json::from_slice(&encoded).expect("json");

        assert_eq!(value["schema"], 8);
        assert_eq!(value["cursor_ms"], 1_700_000_000_100_i64);
        assert!(value.get("synced_through_ms").is_none());
        assert_eq!(value["rows"][0]["last_activity_ms"], 1_700_000_000_000_i64);
        assert_eq!(value["rows"][0]["newest"]["msgid"], "newest-1");
        assert_eq!(value["rows"][0]["read_at_ms"], 1_699_999_999_000_i64);
        assert_eq!(
            value["rows"][0]["pending_read_at_ms"],
            1_699_999_999_000_i64
        );
        assert_eq!(value["rows"][0]["stubs"][0]["msgid"], "newest-1");
        assert_eq!(value["rows"][1]["stubs"][0]["mention"], true);
        assert_eq!(value["rows"][1]["gap_until"], 1_700_000_000_000_i64);
        assert!(value["rows"][0].get("badge").is_none());
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
    fn stored_stub_without_provisional_time_decodes() {
        let expected = snapshot();
        let encoded = expected.encode().expect("encode");
        let value: serde_json::Value = serde_json::from_slice(&encoded).expect("json");
        assert!(
            value["rows"][0]["stubs"][0]
                .get("provisional_time")
                .is_none()
        );

        let decoded = ChatListSnapshot::decode(&encoded, &expected.fingerprint).expect("decode");

        assert_eq!(decoded.rows[0].stubs[0].provisional_time, None);
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
    fn sync_boundary_field_decodes_as_the_network_cursor() {
        let snapshot = snapshot();
        let expected = fingerprint("Lounge", "wss://irc.example");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&snapshot.encode().expect("encode")).expect("json");
        let cursor = legacy
            .as_object_mut()
            .expect("snapshot")
            .remove("cursor_ms")
            .expect("cursor");
        legacy["synced_through_ms"] = cursor;

        assert_eq!(
            ChatListSnapshot::decode(&serde_json::to_vec(&legacy).expect("json"), &expected),
            Some(snapshot)
        );
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
            .remove("cursor_ms");
        legacy["rows"][0]["badge"] = serde_json::json!({ "kind": "unread" });
        legacy["rows"][1]["badge"] = serde_json::json!({ "kind": "mentions", "count": 3 });
        for row in legacy["rows"].as_array_mut().expect("rows") {
            row.as_object_mut().expect("row").remove("stubs");
            row.as_object_mut().expect("row").remove("gap_until");
        }

        let migrated =
            ChatListSnapshot::decode(&serde_json::to_vec(&legacy).expect("json"), &expected)
                .expect("schema 2 migrates");

        assert_eq!(migrated.schema, 8);
        assert_eq!(migrated.cursor_ms, None);
        assert!(migrated.rows.iter().all(|row| row.peer_pin.is_none()));
        assert!(migrated.rows.iter().all(|row| row.stubs.is_empty()));
    }

    #[test]
    fn countless_badge_schema_discards_saved_counts() {
        let snapshot = snapshot();
        let expected = fingerprint("Lounge", "wss://irc.example");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&snapshot.encode().expect("encode")).expect("json");
        legacy["schema"] = 3.into();
        legacy
            .as_object_mut()
            .expect("snapshot")
            .remove("cursor_ms");
        legacy["rows"][0]["badge"] = serde_json::json!({ "kind": "unread" });
        legacy["rows"][1]["badge"] = serde_json::json!({ "kind": "mentions", "count": 3 });
        for row in legacy["rows"].as_array_mut().expect("rows") {
            row.as_object_mut().expect("row").remove("stubs");
            row.as_object_mut().expect("row").remove("gap_until");
        }

        let migrated =
            ChatListSnapshot::decode(&serde_json::to_vec(&legacy).expect("json"), &expected)
                .expect("schema 3 migrates");

        assert!(migrated.rows.iter().all(|row| row.stubs.is_empty()));
    }

    #[test]
    fn schema_five_fixture_discards_counts_and_preserves_sync_facts() {
        let bytes = include_bytes!("../../../fixtures/read-state/schema-5-chat-list.json");

        let migrated = ChatListSnapshot::decode(bytes, "network").expect("schema 5 migrates");
        let row = &migrated.rows[0];
        let encoded: serde_json::Value =
            serde_json::from_slice(&migrated.encode().expect("encode migrated snapshot"))
                .expect("json");

        assert_eq!(migrated.schema, 8);
        assert_eq!(migrated.cursor_ms, Some(400));
        assert_eq!(row.read_at_ms, Some(100));
        assert_eq!(row.pending_read_at_ms, None);
        assert_eq!(
            row.newest,
            Some(SnapshotCursor {
                msgid: Some("alice-300".into()),
                server_time_ms: 300,
            })
        );
        assert!(row.stubs.is_empty());
        assert_eq!(row.gap_until, None);
        assert!(encoded["rows"][0].get("badge").is_none());
    }

    #[test]
    fn schema_six_migration_preserves_merged_read_facts() {
        let expected = snapshot();
        let mut previous: serde_json::Value =
            serde_json::from_slice(&expected.encode().expect("encode")).expect("json");
        previous["schema"] = 6.into();

        let migrated = ChatListSnapshot::decode(
            &serde_json::to_vec(&previous).expect("json"),
            &expected.fingerprint,
        )
        .expect("schema 6 migrates");

        assert_eq!(migrated, expected);
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

    #[test]
    fn interleaved_row_writers_keep_newer_facts_and_union_stubs() {
        let mut stored = snapshot().rows.remove(0);
        let mut newer = stored.clone();
        newer.read_at_ms = Some(1_699_999_999_500);
        newer.pending_read_at_ms = Some(1_699_999_999_600);
        newer.stubs = vec![MessageStub {
            msgid: "newer-stub".into(),
            time: ServerTimeMs::new(1_700_000_000_100),
            provisional_time: None,
            mention: true,
        }];
        let mut older = newer.clone();
        older.read_at_ms = Some(1_699_999_999_000);
        older.pending_read_at_ms = Some(1_699_999_999_100);
        older.stubs = vec![MessageStub {
            msgid: "older-stub".into(),
            time: ServerTimeMs::new(1_700_000_000_000),
            provisional_time: None,
            mention: false,
        }];

        stored.merge(newer);
        stored.merge(older);

        assert_eq!(stored.read_at_ms, Some(1_699_999_999_500));
        assert_eq!(stored.pending_read_at_ms, Some(1_699_999_999_600));
        assert_eq!(
            stored
                .stubs
                .iter()
                .map(|stub| stub.msgid.as_str())
                .collect::<Vec<_>>(),
            vec!["newest-1", "older-stub", "newer-stub"]
        );
    }

    #[test]
    fn equal_time_row_refreshes_its_preview() {
        let mut stored = snapshot().rows.remove(0);
        let mut refreshed = stored.clone();
        refreshed.preview = Some("new same-millisecond preview".into());

        stored.merge(refreshed.clone());

        assert_eq!(stored.preview, refreshed.preview);
    }

    #[tokio::test]
    async fn changed_rows_share_one_atomic_update() {
        let backend = MemoryKv::default();
        let before = snapshot();
        write(&backend, &before).await.expect("seed");
        let mut after = before.clone();
        after.rows[0].title = "new channel title".into();
        after.rows[0].last_activity_ms = Some(1_700_000_000_100);
        after.rows[1].title = "new direct title".into();
        after.rows[1].last_activity_ms = Some(1_700_000_000_101);
        backend.fail_commit_after(1);

        write(&backend, &after).await.expect("one batch update");

        let stored = read(&backend)
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &before.fingerprint));
        assert_eq!(stored, Some(after));
    }

    #[tokio::test]
    async fn only_an_explicit_removal_deletes_a_stored_row() {
        let backend = MemoryKv::default();
        let before = snapshot();
        write(&backend, &before).await.expect("seed");
        let without_channel =
            ChatListSnapshot::new(before.fingerprint.clone(), vec![before.rows[1].clone()]);

        assert!(
            SnapshotChanges::between(&before, &without_channel, Vec::new(), Vec::new()).is_none()
        );
        let changes = SnapshotChanges::between(
            &before,
            &without_channel,
            vec![SnapshotRemoval {
                conversation: before.rows[0].conversation.clone(),
                removed_at_ms: 1_700_000_000_200,
            }],
            Vec::new(),
        )
        .expect("explicit removal");
        write_changes(&backend, &changes).await.expect("remove row");

        let stored = read(&backend)
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &before.fingerprint))
            .expect("stored snapshot");
        assert_eq!(stored.rows, without_channel.rows);
    }

    #[tokio::test]
    async fn stale_writer_cannot_resurrect_an_explicitly_removed_row() {
        let backend = MemoryKv::default();
        let mut before = snapshot();
        before.rows.truncate(1);
        write(&backend, &before).await.expect("seed");
        let without_channel = ChatListSnapshot::new(before.fingerprint.clone(), Vec::new());
        let removal = SnapshotChanges::between(
            &before,
            &without_channel,
            vec![SnapshotRemoval {
                conversation: before.rows[0].conversation.clone(),
                removed_at_ms: 1_700_000_000_200,
            }],
            Vec::new(),
        )
        .expect("explicit removal");

        write_changes(&backend, &removal).await.expect("remove row");
        write(&backend, &before).await.expect("late stale writer");

        let stored = read(&backend)
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &before.fingerprint))
            .expect("stored snapshot");
        assert!(stored.rows.is_empty());

        let rejoin = SnapshotChanges::between(
            &without_channel,
            &before,
            Vec::new(),
            vec![SnapshotPresence {
                conversation: before.rows[0].conversation.clone(),
                joined_at_ms: 1_700_000_000_300,
            }],
        )
        .expect("later rejoin");
        write_changes(&backend, &rejoin).await.expect("rejoin row");
        let stored = read(&backend)
            .await
            .expect("read")
            .and_then(|bytes| ChatListSnapshot::decode(&bytes, &before.fingerprint))
            .expect("stored snapshot");
        assert_eq!(stored.rows, before.rows);
    }
}
