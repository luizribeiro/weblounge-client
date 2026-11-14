//! Device-local file hosts the user allowed to receive a connection's password (design 31, U1).

use serde::{Deserialize, Serialize};

use crate::storage::{KvBackend, Operation, Space, StorageError};

const APPROVALS_KEY: &[u8] = b"uploads/approvals";
const VERSION: u8 = 1;

/// One remembered approval: this account on this connection may send its password to this
/// file host authority.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct ApprovalKey {
    pub(crate) endpoint: String,
    pub(crate) account: String,
    pub(crate) authority: String,
}

#[derive(Deserialize, Serialize)]
struct ApprovalsRecord {
    version: u8,
    approvals: Vec<ApprovalKey>,
}

async fn read<B: KvBackend>(backend: &B) -> Result<Vec<ApprovalKey>, StorageError> {
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
) -> Result<bool, StorageError> {
    Ok(read(backend).await?.contains(key))
}

pub(crate) async fn remember<B: KvBackend>(
    backend: &B,
    key: ApprovalKey,
) -> Result<(), StorageError> {
    // An unreadable record must not block remembering forever; it is replaced.
    let mut approvals = read(backend).await.unwrap_or_default();
    if approvals.contains(&key) {
        return Ok(());
    }
    approvals.push(key);
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

    use super::{APPROVALS_KEY, ApprovalKey, forget_all, is_remembered, remember};

    fn key(authority: &str) -> ApprovalKey {
        ApprovalKey {
            endpoint: "wss://irc.example.org/socket".into(),
            account: "luiz".into(),
            authority: authority.into(),
        }
    }

    #[tokio::test]
    async fn remembers_exact_approvals_in_settings() {
        let storage = MemoryKv::default();
        assert!(
            !is_remembered(&storage, &key("files.example.net"))
                .await
                .expect("read empty")
        );

        remember(&storage, key("files.example.net"))
            .await
            .expect("remember");
        remember(&storage, key("files.example.net"))
            .await
            .expect("remember twice");

        assert!(
            is_remembered(&storage, &key("files.example.net"))
                .await
                .expect("read")
        );
        assert!(
            !is_remembered(&storage, &key("files.example.net:8443"))
                .await
                .expect("read other port")
        );
        let other_account = ApprovalKey {
            account: "tomo".into(),
            ..key("files.example.net")
        };
        assert!(
            !is_remembered(&storage, &other_account)
                .await
                .expect("read other account")
        );
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
    async fn forgetting_clears_every_approval() {
        let storage = MemoryKv::default();
        remember(&storage, key("files.example.net"))
            .await
            .expect("remember");
        remember(&storage, key("cdn.example.com"))
            .await
            .expect("remember another");

        forget_all(&storage).await.expect("forget");

        for authority in ["files.example.net", "cdn.example.com"] {
            assert!(
                !is_remembered(&storage, &key(authority))
                    .await
                    .expect("read")
            );
        }
    }

    #[tokio::test]
    async fn remembering_replaces_an_unreadable_record() {
        let storage = MemoryKv::default();
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: APPROVALS_KEY.to_vec(),
                    value: b"{not json".to_vec(),
                }],
            )
            .await
            .expect("seed");

        remember(&storage, key("files.example.net"))
            .await
            .expect("remember");
        assert!(
            is_remembered(&storage, &key("files.example.net"))
                .await
                .expect("read")
        );
    }

    #[tokio::test]
    async fn rejects_unknown_record_versions() {
        let storage = MemoryKv::default();
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: APPROVALS_KEY.to_vec(),
                    value: br#"{"version":2,"approvals":[]}"#.to_vec(),
                }],
            )
            .await
            .expect("seed");

        assert!(
            is_remembered(&storage, &key("files.example.net"))
                .await
                .is_err()
        );
    }
}
