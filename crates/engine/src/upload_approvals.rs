//! Device-local file hosts the user allowed to receive a connection's password (design 31, U1).

use serde::{Deserialize, Serialize};

use crate::storage::{KvBackend, Operation, Space, StorageError};

const APPROVALS_KEY: &[u8] = b"uploads/approvals";
const VERSION: u8 = 1;
/// A remembered approval lapses after 90 days and the next upload asks again.
const APPROVAL_LIFETIME_MS: i64 = 90 * 24 * 60 * 60 * 1_000;

/// One remembered approval: this account on this connection may send its password to this
/// file host authority.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct ApprovalKey {
    pub(crate) endpoint: String,
    pub(crate) account: String,
    pub(crate) authority: String,
}

#[derive(Deserialize, Serialize)]
struct StoredApproval {
    #[serde(flatten)]
    key: ApprovalKey,
    // Absent only in a record written without it, which therefore counts as expired.
    #[serde(default)]
    granted_at_ms: Option<i64>,
}

impl StoredApproval {
    fn is_current(&self, now_ms: i64) -> bool {
        self.granted_at_ms
            .is_some_and(|granted| granted <= now_ms && now_ms - granted < APPROVAL_LIFETIME_MS)
    }
}

#[derive(Deserialize, Serialize)]
struct ApprovalsRecord {
    version: u8,
    approvals: Vec<StoredApproval>,
}

async fn read<B: KvBackend>(backend: &B) -> Result<Vec<StoredApproval>, StorageError> {
    let Some(value) = backend.get(Space::Settings, APPROVALS_KEY).await? else {
        return Ok(Vec::new());
    };
    let record: ApprovalsRecord = serde_json::from_slice(&value)
        .map_err(|error| StorageError::Encoding(error.to_string()))?;
    if record.version != VERSION {
        return Err(StorageError::Encoding(
            "unsupported upload approvals version".into(),
        ));
    }
    Ok(record.approvals)
}

pub(crate) async fn is_remembered<B: KvBackend>(
    backend: &B,
    key: &ApprovalKey,
    now_ms: i64,
) -> Result<bool, StorageError> {
    Ok(read(backend)
        .await?
        .iter()
        .any(|approval| approval.key == *key && approval.is_current(now_ms)))
}

/// Records the approval as granted now, replacing any older grant for the same key and dropping
/// lapsed ones.
pub(crate) async fn remember<B: KvBackend>(
    backend: &B,
    key: ApprovalKey,
    now_ms: i64,
) -> Result<(), StorageError> {
    // An unreadable record must not block remembering forever; it is replaced.
    let mut approvals = read(backend).await.unwrap_or_default();
    approvals.retain(|approval| approval.key != key && approval.is_current(now_ms));
    approvals.push(StoredApproval {
        key,
        granted_at_ms: Some(now_ms),
    });
    let value = serde_json::to_vec(&ApprovalsRecord {
        version: VERSION,
        approvals,
    })
    .map_err(|error| StorageError::Encoding(error.to_string()))?;
    backend
        .commit(
            Space::Settings,
            vec![Operation::Put {
                key: APPROVALS_KEY.to_vec(),
                value,
            }],
        )
        .await
}

pub(crate) async fn forget_all<B: KvBackend>(backend: &B) -> Result<(), StorageError> {
    backend
        .commit(
            Space::Settings,
            vec![Operation::Delete {
                key: APPROVALS_KEY.to_vec(),
            }],
        )
        .await
}

#[cfg(test)]
mod tests {
    use crate::storage::{KvBackend, MemoryKv, Operation, Space};

    use super::{
        APPROVAL_LIFETIME_MS, APPROVALS_KEY, ApprovalKey, forget_all, is_remembered, remember,
    };

    const NOW: i64 = 1_794_600_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1_000;

    fn key(authority: &str) -> ApprovalKey {
        ApprovalKey {
            endpoint: "wss://irc.example.org/socket".into(),
            account: "luiz".into(),
            authority: authority.into(),
        }
    }

    async fn seed(storage: &MemoryKv, record: &[u8]) {
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: APPROVALS_KEY.to_vec(),
                    value: record.to_vec(),
                }],
            )
            .await
            .expect("seed");
    }

    async fn remembered(storage: &MemoryKv, key: &ApprovalKey, now_ms: i64) -> bool {
        is_remembered(storage, key, now_ms).await.expect("read")
    }

    #[tokio::test]
    async fn remembers_exact_approvals_in_settings() {
        let storage = MemoryKv::default();
        assert!(!remembered(&storage, &key("files.example.net"), NOW).await);

        remember(&storage, key("files.example.net"), NOW)
            .await
            .expect("remember");
        remember(&storage, key("files.example.net"), NOW)
            .await
            .expect("remember twice");

        assert!(remembered(&storage, &key("files.example.net"), NOW).await);
        assert!(!remembered(&storage, &key("files.example.net:8443"), NOW).await);
        let other_account = ApprovalKey {
            account: "tomo".into(),
            ..key("files.example.net")
        };
        assert!(!remembered(&storage, &other_account, NOW).await);
        assert!(
            storage
                .get(Space::Settings, APPROVALS_KEY)
                .await
                .expect("read settings")
                .is_some()
        );
        assert!(
            storage
                .get(Space::Durable, APPROVALS_KEY)
                .await
                .expect("read durable")
                .is_none()
        );
    }

    #[tokio::test]
    async fn approvals_lapse_after_ninety_days_and_a_new_grant_renews_them() {
        let storage = MemoryKv::default();
        remember(&storage, key("files.example.net"), NOW)
            .await
            .expect("remember");

        assert!(remembered(&storage, &key("files.example.net"), NOW + 89 * DAY).await);
        assert!(
            !remembered(
                &storage,
                &key("files.example.net"),
                NOW + APPROVAL_LIFETIME_MS
            )
            .await
        );
        assert!(!remembered(&storage, &key("files.example.net"), NOW - DAY).await);

        let later = NOW + 120 * DAY;
        remember(&storage, key("files.example.net"), later)
            .await
            .expect("renew");
        assert!(remembered(&storage, &key("files.example.net"), later + 89 * DAY).await);
        let stored = storage
            .get(Space::Settings, APPROVALS_KEY)
            .await
            .expect("read")
            .expect("record");
        assert_eq!(
            String::from_utf8(stored)
                .expect("json")
                .matches("files.example.net")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn approvals_without_a_grant_time_count_as_expired() {
        let storage = MemoryKv::default();
        seed(
            &storage,
            br#"{"version":1,"approvals":[{"endpoint":"wss://irc.example.org/socket","account":"luiz","authority":"files.example.net"}]}"#,
        )
        .await;

        assert!(!remembered(&storage, &key("files.example.net"), NOW).await);
    }

    #[tokio::test]
    async fn forgetting_clears_every_approval() {
        let storage = MemoryKv::default();
        remember(&storage, key("files.example.net"), NOW)
            .await
            .expect("remember");
        remember(&storage, key("cdn.example.com"), NOW)
            .await
            .expect("remember another");

        forget_all(&storage).await.expect("forget");

        for authority in ["files.example.net", "cdn.example.com"] {
            assert!(!remembered(&storage, &key(authority), NOW).await);
        }
    }

    #[tokio::test]
    async fn remembering_replaces_an_unreadable_record() {
        let storage = MemoryKv::default();
        seed(&storage, b"{not json").await;

        remember(&storage, key("files.example.net"), NOW)
            .await
            .expect("remember");
        assert!(remembered(&storage, &key("files.example.net"), NOW).await);
    }

    #[tokio::test]
    async fn rejects_unknown_record_versions() {
        let storage = MemoryKv::default();
        seed(&storage, br#"{"version":2,"approvals":[]}"#).await;

        assert!(
            is_remembered(&storage, &key("files.example.net"), NOW)
                .await
                .is_err()
        );
    }
}
