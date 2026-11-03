use serde::{Deserialize, Serialize};

use crate::storage::{KvBackend, Operation, Space, StorageError};

const PROMPT_KEY: &[u8] = b"notifications/prompt";

#[derive(Deserialize, Serialize)]
struct PromptRecord {
    version: u8,
    dismissed: bool,
}

pub(crate) async fn prompt_dismissed<B: KvBackend>(backend: &B) -> Result<bool, StorageError> {
    let Some(value) = backend.get(Space::Settings, PROMPT_KEY).await? else {
        return Ok(false);
    };
    let record: PromptRecord = serde_json::from_slice(&value)
        .map_err(|error| StorageError::Encoding(error.to_string()))?;
    if record.version != 1 {
        return Err(StorageError::Encoding(
            "unsupported notification prompt settings version".into(),
        ));
    }
    Ok(record.dismissed)
}

pub(crate) async fn dismiss_prompt<B: KvBackend>(backend: &B) -> Result<(), StorageError> {
    let value = serde_json::to_vec(&PromptRecord {
        version: 1,
        dismissed: true,
    })
    .map_err(|error| StorageError::Encoding(error.to_string()))?;
    backend
        .commit(
            Space::Settings,
            vec![Operation::Put {
                key: PROMPT_KEY.to_vec(),
                value,
            }],
        )
        .await
}

#[cfg(test)]
mod tests {
    use crate::storage::{KvBackend, MemoryKv, Operation, Space};

    use super::{PROMPT_KEY, dismiss_prompt, prompt_dismissed};

    #[tokio::test]
    async fn dismissal_defaults_off_and_persists_in_settings() {
        let storage = MemoryKv::default();

        assert!(!prompt_dismissed(&storage).await.expect("read default"));
        dismiss_prompt(&storage).await.expect("dismiss");
        assert!(prompt_dismissed(&storage).await.expect("read dismissal"));
        assert!(
            storage
                .get(Space::Durable, PROMPT_KEY)
                .await
                .expect("read durable")
                .is_none()
        );
    }

    #[tokio::test]
    async fn rejects_unknown_record_versions() {
        let storage = MemoryKv::default();
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: PROMPT_KEY.to_vec(),
                    value: br#"{"version":2,"dismissed":true}"#.to_vec(),
                }],
            )
            .await
            .expect("seed setting");

        assert!(prompt_dismissed(&storage).await.is_err());
    }
}
