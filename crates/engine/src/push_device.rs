use crate::{
    PushDeviceCredentials,
    storage::{KvBackend, Operation, Space, StorageError},
};

const KEY_PREFIX: &[u8] = b"push/device/";

fn key(relay: &str) -> Vec<u8> {
    [KEY_PREFIX, relay.as_bytes()].concat()
}

pub(crate) async fn read<B: KvBackend>(
    backend: &B,
    relay: &str,
) -> Result<Option<PushDeviceCredentials>, StorageError> {
    backend
        .get(Space::Durable, &key(relay))
        .await?
        .map(|value| {
            serde_json::from_slice(&value)
                .map_err(|error| StorageError::Encoding(error.to_string()))
        })
        .transpose()
}

pub(crate) async fn write<B: KvBackend>(
    backend: &B,
    credentials: &PushDeviceCredentials,
) -> Result<(), StorageError> {
    let value = serde_json::to_vec(credentials)
        .map_err(|error| StorageError::Encoding(error.to_string()))?;
    backend
        .commit(
            Space::Durable,
            vec![Operation::Put {
                key: key(&credentials.relay),
                value,
            }],
        )
        .await
}

pub(crate) async fn clear<B: KvBackend>(backend: &B, relay: &str) -> Result<(), StorageError> {
    backend
        .commit(Space::Durable, vec![Operation::Delete { key: key(relay) }])
        .await
}

#[cfg(test)]
mod tests {
    use crate::{PushDeviceCredentials, storage::MemoryKv};

    use super::{clear, read, write};

    #[tokio::test]
    async fn credentials_round_trip_only_under_their_relay_origin() {
        let storage = MemoryKv::default();
        let credentials = PushDeviceCredentials {
            relay: "https://push.example.test".into(),
            device_id: "device-1".into(),
            secret: "device-secret".into(),
        };

        write(&storage, &credentials).await.expect("write");
        assert_eq!(
            read(&storage, &credentials.relay).await.expect("read"),
            Some(credentials.clone())
        );
        assert_eq!(
            read(&storage, "https://other.example.test")
                .await
                .expect("other relay"),
            None
        );

        clear(&storage, &credentials.relay).await.expect("clear");
        assert_eq!(
            read(&storage, &credentials.relay).await.expect("read"),
            None
        );
    }
}
