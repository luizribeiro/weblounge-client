# 22 — Storage

Status: approved by Luiz; minimal cache slice authorized for the startup chat-list snapshot.

## Problem

The engine needs device-local persistence without giving the UI or platform shells ownership of
product state. The web engine must use the same abstraction in a `SharedWorker` and its dedicated
worker fallback, while native engines need a backend that does not depend on browser APIs.

## Backend boundary

The engine owns one async byte-key/value trait with a closed set of spaces:

```rust
pub enum Space {
    Settings,
    Durable,
    Cache,
}

pub trait KvBackend {
    async fn get(&self, space: Space, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError>;
    async fn range(
        &self,
        space: Space,
        range: KeyRange,
        direction: Direction,
        limit: u32,
    ) -> Result<Page, StorageError>;
    async fn commit(&self, space: Space, operations: Vec<Operation>)
        -> Result<(), StorageError>;
    async fn clear(&self, space: Space) -> Result<(), StorageError>;
}
```

`commit` is atomic. Operations are puts, deletes, and key-range deletes, so a caller cannot hold a
transaction across an unrelated await. The engine uses static dispatch and typed layers above this
trait; the UI never opens or writes a store directly.

The spaces have distinct contracts:

- `Settings` contains device-local user preferences. There is no settings sync.
- `Durable` contains state that must survive restart, such as drafts and pending sends.
- `Cache` contains evictable, rebuildable projections. Correct startup never depends on it.

## Platform implementations

Web engines use the `idb` crate from inside the `SharedWorker` or dedicated worker. One IndexedDB
database named `weblounge` has `settings`, `durable`, and `cache` object stores. Settings and
Durable transactions request strict durability; Cache uses relaxed durability.

Native engines use `rusqlite` in WAL mode on a dedicated storage thread. Settings and Durable
share one SQLite file; Cache has its own file so it can be discarded independently. Engine tests
use a deterministic in-memory `BTreeMap` backend and run the same backend conformance cases.

## Schema and versioning

The backend schema is deliberately stable and untyped: space plus byte key maps to byte value. An
IndexedDB upgrade only creates missing object stores. SQLite uses a single `WITHOUT ROWID` table
keyed by `(space, key)`. Backend schemas do not migrate product records.

Typed layers version their own records. Settings and Durable may define ordered migrations when
their schemas arrive. Cache records are never migrated: an unknown version, identity mismatch, or
decode failure clears or ignores the affected cache and lets live state rebuild it.

## Errors and lifecycle

`StorageError` distinguishes unavailable/open, transaction, encoding, and quota failures while
retaining a safe diagnostic string. Cache failures degrade to an empty cache and are reported for
diagnostics; failures in Settings or Durable are surfaced to their owning feature because those
spaces promise persistence.

Sign-out atomically clears all device-local state associated with the signed-in profile, including
the Cache space. Web database access remains engine-owned for the worker's lifetime; native
SQLite handles remain on their storage thread.

## Testing

- Shared conformance tests cover get, ordered range and limits, atomic mixed operations,
  range deletion, space isolation, and clear against memory and each platform backend.
- IndexedDB tests run in both worker kinds; browser coverage includes Chromium, Firefox, and
  WebKit. They exercise upgrade/open, reverse cursors, strict and relaxed transactions, quota/error
  mapping, and clear.
- Typed-layer tests cover version rejection, corrupt records, identity mismatch, and sign-out.
- Playwright proves persisted UI state paints before live synchronization without making the cache
  necessary for a cold start.

## Out of scope

This design does not define settings declarations, durable queues, cached history tails, secrets,
cross-device sync, cache budgets, or eviction policy. Those typed layers are added only with their
own reviewed behavior.
