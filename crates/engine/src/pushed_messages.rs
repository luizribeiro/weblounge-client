use serde::Deserialize;

use crate::storage::{Direction, KeyBound, KeyRange, KvBackend, Space, StorageError};

const KEY_PREFIX: &[u8] = b"pushed-message\0";
const KEY_END: &[u8] = b"pushed-message\x01";
const MAX_MESSAGES: u32 = 500;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
/// One versioned service-worker message waiting to join an engine timeline.
#[doc(hidden)]
pub struct PushedMessage {
    schema: u32,
    pub(crate) network_label: String,
    pub(crate) nickname: String,
    pub(crate) sender: String,
    pub(crate) target: String,
    pub(crate) msgid: String,
    pub(crate) time: String,
    pub(crate) text: String,
    pub(crate) kind: PushedMessageKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PushedMessageKind {
    Message,
    Notice,
    Action,
}

pub(crate) async fn read<B: KvBackend>(backend: &B) -> Result<Vec<PushedMessage>, StorageError> {
    let page = backend
        .range(
            Space::Cache,
            KeyRange::new(
                KeyBound::Included(KEY_PREFIX.to_vec()),
                KeyBound::Excluded(KEY_END.to_vec()),
            ),
            Direction::Forward,
            MAX_MESSAGES,
        )
        .await?;
    Ok(page
        .rows
        .into_iter()
        .filter_map(|(_, value)| serde_json::from_slice::<PushedMessage>(&value).ok())
        .filter(|message| message.schema == 1)
        .collect())
}

#[cfg(test)]
mod tests {
    use crate::storage::{KvBackend, MemoryKv, Operation, Space};

    use super::{PushedMessageKind, read};

    #[tokio::test]
    async fn reads_only_valid_versioned_push_records() {
        let storage = MemoryKv::default();
        storage
            .commit(
                Space::Cache,
                vec![
                    Operation::Put {
                        key: b"pushed-message\0Lounge\0one".to_vec(),
                        value: br##"{"schema":1,"network_label":"Lounge","nickname":"weblounge","sender":"mel","target":"#lounge","msgid":"one","time":"2026-11-03T12:34:56.789Z","text":"hello","kind":"message"}"##.to_vec(),
                    },
                    Operation::Put {
                        key: b"pushed-message\0Lounge\0old".to_vec(),
                        value: br##"{"schema":0,"network_label":"Lounge","nickname":"weblounge","sender":"mel","target":"#lounge","msgid":"old","time":"2026-11-03T12:34:56.789Z","text":"old","kind":"message"}"##.to_vec(),
                    },
                    Operation::Put {
                        key: b"unrelated".to_vec(),
                        value: b"not json".to_vec(),
                    },
                ],
            )
            .await
            .expect("seed records");

        let messages = read(&storage).await.expect("read records");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].msgid, "one");
        assert_eq!(messages[0].kind, PushedMessageKind::Message);
    }
}
