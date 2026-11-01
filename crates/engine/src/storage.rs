//! Engine-owned device-local key/value storage.

use std::{collections::BTreeMap, sync::Mutex};

/// One storage namespace with a distinct persistence contract.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Space {
    /// Device-local user preferences.
    Settings,
    /// State whose owning feature requires it to survive restarts.
    Durable,
    /// Evictable state that can always be rebuilt.
    Cache,
}

/// One endpoint of a lexicographic byte-key range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeyBound {
    /// No endpoint in this direction.
    Unbounded,
    /// An inclusive endpoint.
    Included(Vec<u8>),
    /// An exclusive endpoint.
    Excluded(Vec<u8>),
}

/// A lexicographic range of byte keys.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyRange {
    /// Lower endpoint.
    pub start: KeyBound,
    /// Upper endpoint.
    pub end: KeyBound,
}

impl KeyRange {
    /// Creates a range from explicit endpoints.
    #[must_use]
    pub const fn new(start: KeyBound, end: KeyBound) -> Self {
        Self { start, end }
    }

    /// Selects every key.
    #[must_use]
    pub const fn all() -> Self {
        Self::new(KeyBound::Unbounded, KeyBound::Unbounded)
    }

    fn contains(&self, key: &[u8]) -> bool {
        bound_allows_start(&self.start, key) && bound_allows_end(&self.end, key)
    }
}

/// Ordering for a range scan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// Lowest key first.
    Forward,
    /// Highest key first.
    Reverse,
}

/// One mutation in an atomic commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Operation {
    /// Insert or replace a value.
    Put {
        /// Record key.
        key: Vec<u8>,
        /// Record value.
        value: Vec<u8>,
    },
    /// Delete one key if present.
    Delete {
        /// Record key.
        key: Vec<u8>,
    },
    /// Delete every key inside a range.
    DeleteRange {
        /// Range to remove.
        range: KeyRange,
    },
}

/// One bounded range result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Page {
    /// Ordered key/value rows.
    pub rows: Vec<(Vec<u8>, Vec<u8>)>,
    /// Whether at least one matching row follows this page.
    pub more: bool,
}

/// A storage boundary failure safe to surface in diagnostics.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StorageError {
    /// The platform store could not be opened.
    #[error("storage is unavailable: {0}")]
    Unavailable(String),
    /// A transaction failed or was aborted.
    #[error("storage transaction failed: {0}")]
    Transaction(String),
    /// A key or value could not be represented by the platform store.
    #[error("storage encoding failed: {0}")]
    Encoding(String),
    /// The platform refused a write because its quota was exhausted.
    #[error("storage quota exceeded: {0}")]
    Quota(String),
    /// The selected space is not part of the current implementation slice.
    #[error("storage space is not implemented: {0:?}")]
    UnsupportedSpace(Space),
}

/// The narrow persistence port owned by the engine.
#[allow(async_fn_in_trait)]
pub trait KvBackend {
    /// Reads one value.
    async fn get(&self, space: Space, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError>;

    /// Scans a range in the requested order up to `limit` rows.
    async fn range(
        &self,
        space: Space,
        range: KeyRange,
        direction: Direction,
        limit: u32,
    ) -> Result<Page, StorageError>;

    /// Applies every operation atomically.
    async fn commit(&self, space: Space, operations: Vec<Operation>) -> Result<(), StorageError>;

    /// Deletes every value in one space.
    async fn clear(&self, space: Space) -> Result<(), StorageError>;
}

/// A deterministic backend for engine tests.
#[derive(Debug, Default)]
pub struct MemoryKv {
    rows: Mutex<MemoryRows>,
}

type MemoryRows = BTreeMap<(Space, Vec<u8>), Vec<u8>>;

// The test backend is deliberately synchronous while conforming to the platform-async port.
#[allow(clippy::unused_async_trait_impl)]
impl KvBackend for MemoryKv {
    async fn get(&self, space: Space, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(lock(&self.rows).get(&(space, key.to_vec())).cloned())
    }

    async fn range(
        &self,
        space: Space,
        range: KeyRange,
        direction: Direction,
        limit: u32,
    ) -> Result<Page, StorageError> {
        let rows = lock(&self.rows);
        let mut matches = rows
            .iter()
            .filter(|((row_space, key), _)| *row_space == space && range.contains(key))
            .map(|((_, key), value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        if direction == Direction::Reverse {
            matches.reverse();
        }
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let more = matches.len() > limit;
        matches.truncate(limit);
        Ok(Page {
            rows: matches,
            more,
        })
    }

    async fn commit(&self, space: Space, operations: Vec<Operation>) -> Result<(), StorageError> {
        let mut next = lock(&self.rows).clone();
        for operation in operations {
            match operation {
                Operation::Put { key, value } => {
                    next.insert((space, key), value);
                }
                Operation::Delete { key } => {
                    next.remove(&(space, key));
                }
                Operation::DeleteRange { range } => {
                    next.retain(|(row_space, key), _| *row_space != space || !range.contains(key));
                }
            }
        }
        *lock(&self.rows) = next;
        Ok(())
    }

    async fn clear(&self, space: Space) -> Result<(), StorageError> {
        lock(&self.rows).retain(|(row_space, _), _| *row_space != space);
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn bound_allows_start(bound: &KeyBound, key: &[u8]) -> bool {
    match bound {
        KeyBound::Unbounded => true,
        KeyBound::Included(start) => key >= start.as_slice(),
        KeyBound::Excluded(start) => key > start.as_slice(),
    }
}

fn bound_allows_end(bound: &KeyBound, key: &[u8]) -> bool {
    match bound {
        KeyBound::Unbounded => true,
        KeyBound::Included(end) => key <= end.as_slice(),
        KeyBound::Excluded(end) => key < end.as_slice(),
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod indexed_db {
    use idb::{
        CursorDirection, Database, DatabaseEvent, Factory, KeyRange as IdbKeyRange,
        ObjectStoreParams, Query, TransactionMode,
    };
    use js_sys::Uint8Array;
    use wasm_bindgen::JsValue;

    use super::{
        Direction, KeyBound, KeyRange, KvBackend, MemoryKv, Operation, Page, Space, StorageError,
    };

    const DATABASE_NAME: &str = "weblounge";
    const DATABASE_VERSION: u32 = 1;
    const CACHE_STORE: &str = "cache";

    /// The worker-safe IndexedDB backend used by web engines.
    #[derive(Debug)]
    pub struct IdbKv {
        database: Database,
    }

    /// Web cache storage that degrades to memory when browser persistence is unavailable.
    #[derive(Debug)]
    pub enum WebKv {
        /// Persistent worker-owned IndexedDB.
        IndexedDb(IdbKv),
        /// Empty, session-only cache used when IndexedDB cannot be opened.
        Memory(MemoryKv),
    }

    impl WebKv {
        /// Opens IndexedDB without making evictable Cache storage a startup dependency.
        pub async fn open() -> Self {
            match IdbKv::open().await {
                Ok(backend) => Self::IndexedDb(backend),
                Err(_) => Self::Memory(MemoryKv::default()),
            }
        }
    }

    impl KvBackend for WebKv {
        async fn get(&self, space: Space, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
            match self {
                Self::IndexedDb(backend) => backend.get(space, key).await,
                Self::Memory(backend) => backend.get(space, key).await,
            }
        }

        async fn range(
            &self,
            space: Space,
            range: KeyRange,
            direction: Direction,
            limit: u32,
        ) -> Result<Page, StorageError> {
            match self {
                Self::IndexedDb(backend) => backend.range(space, range, direction, limit).await,
                Self::Memory(backend) => backend.range(space, range, direction, limit).await,
            }
        }

        async fn commit(
            &self,
            space: Space,
            operations: Vec<Operation>,
        ) -> Result<(), StorageError> {
            match self {
                Self::IndexedDb(backend) => backend.commit(space, operations).await,
                Self::Memory(backend) => backend.commit(space, operations).await,
            }
        }

        async fn clear(&self, space: Space) -> Result<(), StorageError> {
            match self {
                Self::IndexedDb(backend) => backend.clear(space).await,
                Self::Memory(backend) => backend.clear(space).await,
            }
        }
    }

    impl IdbKv {
        /// Opens the application database and creates the Cache space when needed.
        pub async fn open() -> Result<Self, StorageError> {
            let factory = Factory::new().map_err(open_error)?;
            let mut request = factory
                .open(DATABASE_NAME, Some(DATABASE_VERSION))
                .map_err(open_error)?;
            request.on_upgrade_needed(|event| {
                let Ok(database) = event.database() else {
                    return;
                };
                if !database
                    .store_names()
                    .iter()
                    .any(|name| name == CACHE_STORE)
                {
                    let _ = database.create_object_store(CACHE_STORE, ObjectStoreParams::new());
                }
            });
            let database = request.await.map_err(open_error)?;
            if !database
                .store_names()
                .iter()
                .any(|name| name == CACHE_STORE)
            {
                return Err(StorageError::Unavailable(
                    "cache object store was not created".into(),
                ));
            }
            Ok(Self { database })
        }

        fn store_name(space: Space) -> Result<&'static str, StorageError> {
            match space {
                Space::Cache => Ok(CACHE_STORE),
                Space::Settings | Space::Durable => Err(StorageError::UnsupportedSpace(space)),
            }
        }
    }

    impl KvBackend for IdbKv {
        async fn get(&self, space: Space, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
            let store_name = Self::store_name(space)?;
            let transaction = self
                .database
                .transaction(&[store_name], TransactionMode::ReadOnly)
                .map_err(transaction_error)?;
            let store = transaction
                .object_store(store_name)
                .map_err(transaction_error)?;
            let value = store
                .get(bytes_value(key))
                .map_err(transaction_error)?
                .await
                .map_err(transaction_error)?;
            transaction.await.map_err(transaction_error)?;
            value.map(|value| decode_bytes(&value)).transpose()
        }

        async fn range(
            &self,
            space: Space,
            range: KeyRange,
            direction: Direction,
            limit: u32,
        ) -> Result<Page, StorageError> {
            let store_name = Self::store_name(space)?;
            let transaction = self
                .database
                .transaction(&[store_name], TransactionMode::ReadOnly)
                .map_err(transaction_error)?;
            let store = transaction
                .object_store(store_name)
                .map_err(transaction_error)?;
            let query = idb_range(&range)?.map(Query::from);
            let cursor_direction = match direction {
                Direction::Forward => CursorDirection::Next,
                Direction::Reverse => CursorDirection::Prev,
            };
            let cursor = store
                .open_cursor(query, Some(cursor_direction))
                .map_err(transaction_error)?
                .await
                .map_err(transaction_error)?;
            let Some(cursor) = cursor else {
                transaction.await.map_err(transaction_error)?;
                return Ok(Page {
                    rows: Vec::new(),
                    more: false,
                });
            };
            let mut cursor = cursor.into_managed();
            let mut rows = Vec::new();
            let page_limit = usize::try_from(limit).unwrap_or(usize::MAX);
            while let (Some(key), Some(value)) = (
                cursor.key().map_err(transaction_error)?,
                cursor.value().map_err(transaction_error)?,
            ) {
                if rows.len() == page_limit {
                    transaction.await.map_err(transaction_error)?;
                    return Ok(Page { rows, more: true });
                }
                rows.push((decode_bytes(&key)?, decode_bytes(&value)?));
                cursor.next(None).await.map_err(transaction_error)?;
            }
            transaction.await.map_err(transaction_error)?;
            Ok(Page { rows, more: false })
        }

        async fn commit(
            &self,
            space: Space,
            operations: Vec<Operation>,
        ) -> Result<(), StorageError> {
            let store_name = Self::store_name(space)?;
            let transaction = self
                .database
                .transaction(&[store_name], TransactionMode::ReadWrite)
                .map_err(transaction_error)?;
            let store = transaction
                .object_store(store_name)
                .map_err(transaction_error)?;
            for operation in operations {
                match operation {
                    Operation::Put { key, value } => {
                        store
                            .put(&bytes_value(&value), Some(&bytes_value(&key)))
                            .map_err(transaction_error)?;
                    }
                    Operation::Delete { key } => {
                        store.delete(bytes_value(&key)).map_err(transaction_error)?;
                    }
                    Operation::DeleteRange { range } => {
                        if let Some(range) = idb_range(&range)? {
                            store.delete(range).map_err(transaction_error)?;
                        } else {
                            store.clear().map_err(transaction_error)?;
                        }
                    }
                }
            }
            transaction
                .commit()
                .map_err(transaction_error)?
                .await
                .map(|_| ())
                .map_err(transaction_error)
        }

        async fn clear(&self, space: Space) -> Result<(), StorageError> {
            let store_name = Self::store_name(space)?;
            let transaction = self
                .database
                .transaction(&[store_name], TransactionMode::ReadWrite)
                .map_err(transaction_error)?;
            transaction
                .object_store(store_name)
                .map_err(transaction_error)?
                .clear()
                .map_err(transaction_error)?;
            transaction
                .commit()
                .map_err(transaction_error)?
                .await
                .map(|_| ())
                .map_err(transaction_error)
        }
    }

    fn idb_range(range: &KeyRange) -> Result<Option<IdbKeyRange>, StorageError> {
        match (&range.start, &range.end) {
            (KeyBound::Unbounded, KeyBound::Unbounded) => Ok(None),
            (KeyBound::Unbounded, end) => IdbKeyRange::upper_bound(
                &bound_value(end),
                Some(matches!(end, KeyBound::Excluded(_))),
            )
            .map(Some)
            .map_err(transaction_error),
            (start, KeyBound::Unbounded) => IdbKeyRange::lower_bound(
                &bound_value(start),
                Some(matches!(start, KeyBound::Excluded(_))),
            )
            .map(Some)
            .map_err(transaction_error),
            (start, end) => IdbKeyRange::bound(
                &bound_value(start),
                &bound_value(end),
                Some(matches!(start, KeyBound::Excluded(_))),
                Some(matches!(end, KeyBound::Excluded(_))),
            )
            .map(Some)
            .map_err(transaction_error),
        }
    }

    fn bound_value(bound: &KeyBound) -> JsValue {
        match bound {
            KeyBound::Included(value) | KeyBound::Excluded(value) => bytes_value(value),
            KeyBound::Unbounded => JsValue::UNDEFINED,
        }
    }

    fn bytes_value(bytes: &[u8]) -> JsValue {
        Uint8Array::from(bytes).into()
    }

    fn decode_bytes(value: &JsValue) -> Result<Vec<u8>, StorageError> {
        if value.is_object() {
            Ok(Uint8Array::new(value).to_vec())
        } else {
            Err(StorageError::Encoding(
                "IndexedDB value was not binary data".into(),
            ))
        }
    }

    fn open_error(error: idb::Error) -> StorageError {
        StorageError::Unavailable(error.to_string())
    }

    fn transaction_error(error: idb::Error) -> StorageError {
        let message = error.to_string();
        if message.contains("QuotaExceededError") {
            StorageError::Quota(message)
        } else {
            StorageError::Transaction(message)
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub use indexed_db::{IdbKv, WebKv};

#[cfg(test)]
mod tests {
    use super::{Direction, KeyBound, KeyRange, KvBackend, MemoryKv, Operation, Space};

    #[tokio::test]
    async fn memory_backend_conforms_to_atomic_space_isolated_kv_contract() {
        let backend = MemoryKv::default();
        backend
            .commit(
                Space::Cache,
                vec![
                    Operation::Put {
                        key: b"a".to_vec(),
                        value: b"one".to_vec(),
                    },
                    Operation::Put {
                        key: b"b".to_vec(),
                        value: b"two".to_vec(),
                    },
                    Operation::Put {
                        key: b"c".to_vec(),
                        value: b"three".to_vec(),
                    },
                ],
            )
            .await
            .expect("seed cache");
        backend
            .commit(
                Space::Durable,
                vec![Operation::Put {
                    key: b"b".to_vec(),
                    value: b"durable".to_vec(),
                }],
            )
            .await
            .expect("seed durable");

        assert_eq!(
            backend.get(Space::Cache, b"b").await.expect("read"),
            Some(b"two".to_vec())
        );
        assert_eq!(
            backend
                .range(Space::Cache, KeyRange::all(), Direction::Reverse, 2)
                .await
                .expect("reverse range"),
            super::Page {
                rows: vec![
                    (b"c".to_vec(), b"three".to_vec()),
                    (b"b".to_vec(), b"two".to_vec()),
                ],
                more: true,
            }
        );

        backend.clear(Space::Cache).await.expect("clear cache");
        assert_eq!(backend.get(Space::Cache, b"b").await.expect("read"), None);
        assert_eq!(
            backend.get(Space::Durable, b"b").await.expect("read"),
            Some(b"durable".to_vec())
        );
    }

    #[tokio::test]
    async fn memory_backend_honors_range_endpoints_and_mixed_commits() {
        let backend = MemoryKv::default();
        backend
            .commit(
                Space::Cache,
                (b'a'..=b'e')
                    .map(|key| Operation::Put {
                        key: vec![key],
                        value: vec![key],
                    })
                    .collect(),
            )
            .await
            .expect("seed");
        let middle = KeyRange::new(
            KeyBound::Excluded(vec![b'a']),
            KeyBound::Included(vec![b'd']),
        );

        assert_eq!(
            backend
                .range(Space::Cache, middle.clone(), Direction::Forward, 10)
                .await
                .expect("range")
                .rows
                .iter()
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>(),
            vec![vec![b'b'], vec![b'c'], vec![b'd']]
        );

        backend
            .commit(
                Space::Cache,
                vec![
                    Operation::DeleteRange { range: middle },
                    Operation::Delete { key: vec![b'e'] },
                    Operation::Put {
                        key: vec![b'z'],
                        value: b"last".to_vec(),
                    },
                ],
            )
            .await
            .expect("mixed commit");
        assert_eq!(
            backend
                .range(Space::Cache, KeyRange::all(), Direction::Forward, 10)
                .await
                .expect("range")
                .rows,
            vec![(vec![b'a'], vec![b'a']), (vec![b'z'], b"last".to_vec())]
        );
    }
}
