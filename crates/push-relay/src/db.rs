use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

use crate::{Error, Result};

#[cfg(feature = "push-e2e")]
use serde::Serialize;

const MAX_DEVICES_PER_ACCOUNT: u32 = 20;
const MAX_ROUTES_PER_DEVICE: u32 = 25;
const MAX_HELD_PUSHES_PER_ACCOUNT: u32 = 100;
const DEAD_ENDPOINT_BATCH_SIZE: u32 = 5;
const SCHEMA_VERSION: u32 = 5;
const PROBING_ROUTE_TTL_SECONDS: i64 = 5 * 60;
const MAX_CONCURRENT_DATABASE_TASKS: usize = 8;

#[derive(Clone, Debug)]
pub(crate) struct WebPushTarget {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone)]
pub(crate) struct DeviceCredentials {
    pub id: String,
    pub secret: String,
}

impl std::fmt::Debug for DeviceCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeviceCredentials")
            .field("id", &self.id)
            .field("secret", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RouteCredentials {
    pub id: String,
    pub created: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum Route {
    Probing,
    Active {
        device_id: String,
        account: String,
        home_vapid: Vec<u8>,
        target: WebPushTarget,
    },
}

struct StoredRoute {
    state: String,
    device_id: String,
    account: String,
    home_vapid: Vec<u8>,
    target: WebPushTarget,
    created_at: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct HeldPush {
    pub id: i64,
    pub device_id: String,
    pub route_id: String,
    pub target: WebPushTarget,
    pub body: Vec<u8>,
    pub ttl: u32,
    pub urgency: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DuplicateActiveRoutes {
    pub device_id: String,
    pub route_count: u32,
}

#[cfg(feature = "push-e2e")]
#[derive(Debug, Serialize)]
pub(crate) struct TestDeviceState {
    pub id: String,
    pub probing: u32,
    pub active: u32,
    pub dead: u32,
    pub leases: u32,
    pub held: u32,
}

/// A small SQLite state store. Connections are short-lived and run off the async executor.
#[derive(Clone, Debug)]
pub struct Database {
    path: Arc<PathBuf>,
    tasks: Arc<Semaphore>,
}

impl Database {
    /// Opens the database and applies the slice-one schema.
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite cannot open or migrate the state file.
    pub async fn open(path: PathBuf) -> Result<Self> {
        let database = Self {
            path: Arc::new(path),
            tasks: Arc::new(Semaphore::new(MAX_CONCURRENT_DATABASE_TASKS)),
        };
        let schema_path = Arc::clone(&database.path);
        database
            .spawn(move || -> Result<()> {
                secure_database_file(&schema_path)?;
                let connection = connect(&schema_path)?;
                let journal_mode =
                    connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
                        row.get::<_, String>(0)
                    })?;
                if journal_mode != "wal" {
                    return Err(Error::Config("SQLite WAL mode is unavailable".to_owned()));
                }
                let schema_version =
                    connection
                        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))?;
                migrate_schema(&connection, schema_version)?;
                Ok(())
            })
            .await??;
        Ok(database)
    }

    async fn spawn<T, F>(&self, operation: F) -> Result<Result<T>>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let permit = Arc::clone(&self.tasks)
            .acquire_owned()
            .await
            .map_err(|_| Error::Config("database task limiter closed unexpectedly".to_owned()))?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation()
        })
        .await?;
        Ok(result)
    }

    pub(crate) async fn health(&self) -> Result<Vec<DuplicateActiveRoutes>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Vec<DuplicateActiveRoutes>> {
            let connection = connect(&path)?;
            let mut statement = connection.prepare(
                "SELECT device_id, COUNT(*) FROM routes
                 WHERE state = 'active'
                 GROUP BY device_id HAVING COUNT(*) > 1
                 ORDER BY device_id",
            )?;
            statement
                .query_map([], |row| {
                    Ok(DuplicateActiveRoutes {
                        device_id: row.get(0)?,
                        route_count: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .await?
    }

    #[cfg(feature = "push-e2e")]
    pub(crate) async fn test_device_states(&self) -> Result<Vec<TestDeviceState>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Vec<TestDeviceState>> {
            let connection = connect(&path)?;
            let mut statement = connection.prepare(
                "SELECT devices.id,
                        COALESCE(SUM(routes.state = 'probing'), 0),
                        COALESCE(SUM(routes.state = 'active'), 0),
                        COALESCE(SUM(routes.state = 'dead'), 0),
                        (SELECT COUNT(*) FROM leases WHERE leases.device_id = devices.id),
                        (SELECT COUNT(*) FROM held_pushes
                         JOIN routes AS held_routes ON held_routes.id = held_pushes.route_id
                         WHERE held_routes.device_id = devices.id)
                 FROM devices LEFT JOIN routes ON routes.device_id = devices.id
                 GROUP BY devices.id ORDER BY devices.id",
            )?;
            statement
                .query_map([], |row| {
                    Ok(TestDeviceState {
                        id: row.get(0)?,
                        probing: row.get(1)?,
                        active: row.get(2)?,
                        dead: row.get(3)?,
                        leases: row.get(4)?,
                        held: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .await?
    }

    #[cfg(feature = "push-e2e")]
    pub(crate) async fn test_expire_leases(&self) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            connect(&path)?.execute("UPDATE leases SET expires_at = 0", [])?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn create_device(
        &self,
        account: String,
        target: WebPushTarget,
    ) -> Result<DeviceCredentials> {
        let credentials = DeviceCredentials {
            id: random_token()?,
            secret: random_token()?,
        };
        let stored = credentials.clone();
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            retire_devices_for_endpoint(&transaction, &target.endpoint, None)?;
            let device_count = transaction.query_row(
                "SELECT COUNT(*) FROM devices WHERE account = ?1",
                [&account],
                |row| row.get::<_, u32>(0),
            )?;
            if device_count >= MAX_DEVICES_PER_ACCOUNT {
                return Err(Error::Capacity);
            }
            transaction.execute(
                "INSERT INTO devices (id, account, secret_hash, endpoint, p256dh, auth)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    stored.id,
                    account,
                    secret_hash(&stored.secret),
                    target.endpoint,
                    target.p256dh,
                    target.auth,
                ],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await??;
        Ok(credentials)
    }

    pub(crate) async fn update_target(
        &self,
        device_id: String,
        secret: String,
        target: WebPushTarget,
    ) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            retire_devices_for_endpoint(&transaction, &target.endpoint, Some(&device_id))?;
            transaction.execute(
                "UPDATE devices SET endpoint = ?2, p256dh = ?3, auth = ?4 WHERE id = ?1",
                params![device_id, target.endpoint, target.p256dh, target.auth],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn delete_device(&self, device_id: String, secret: String) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            retire_device(&transaction, &device_id)?;
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn ensure_route(
        &self,
        device_id: String,
        secret: String,
        home_vapid: Vec<u8>,
        my_route_id: Option<String>,
    ) -> Result<RouteCredentials> {
        let new_route_id = random_token()?;
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<RouteCredentials> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            expire_probing_routes(&transaction, unix_seconds())?;
            if let Some(route_id) = my_route_id {
                let owned = transaction.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM routes
                       WHERE id = ?1 AND device_id = ?2 AND home_vapid = ?3
                         AND state IN ('probing', 'active')
                     )",
                    params![route_id, device_id, home_vapid],
                    |row| row.get::<_, bool>(0),
                )?;
                if owned {
                    retire_home_routes_except(&transaction, &device_id, &home_vapid, &route_id)?;
                    transaction.commit()?;
                    return Ok(RouteCredentials {
                        id: route_id,
                        created: false,
                    });
                }
            }
            retire_home_routes(&transaction, &device_id, &home_vapid)?;
            let route_count = transaction.query_row(
                "SELECT COUNT(*) FROM routes WHERE device_id = ?1",
                [&device_id],
                |row| row.get::<_, u32>(0),
            )?;
            if route_count >= MAX_ROUTES_PER_DEVICE {
                return Err(Error::Capacity);
            }
            transaction.execute(
                "INSERT INTO routes (id, device_id, state, home_vapid)
                 VALUES (?1, ?2, 'probing', ?3)",
                params![new_route_id, device_id, home_vapid],
            )?;
            transaction.commit()?;
            Ok(RouteCredentials {
                id: new_route_id,
                created: true,
            })
        })
        .await?
    }

    pub(crate) async fn activate_route(
        &self,
        route_id: String,
        secret: String,
    ) -> Result<Vec<String>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Vec<String>> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (device_id, state, home_vapid) = transaction
                .query_row(
                    "SELECT device_id, state, home_vapid
                     FROM routes WHERE id = ?1 AND state != 'dead'",
                    [&route_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Vec<u8>>(2)?,
                        ))
                    },
                )
                .optional()?
                .ok_or(Error::NotFound)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            if state == "active" {
                transaction.commit()?;
                return Ok(Vec::new());
            }
            if state != "probing" {
                return Err(Error::NotFound);
            }
            let superseded = {
                let mut statement = transaction.prepare(
                    "SELECT id FROM routes
                     WHERE device_id = ?1 AND home_vapid = ?2 AND id != ?3 AND state != 'dead'
                     ORDER BY id",
                )?;
                statement
                    .query_map(params![device_id, home_vapid, route_id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?
            };
            for superseded_route in &superseded {
                retire_route(&transaction, superseded_route)?;
            }
            transaction.execute(
                "UPDATE routes SET state = 'active' WHERE id = ?1 AND state = 'probing'",
                [&route_id],
            )?;
            transaction.commit()?;
            Ok(superseded)
        })
        .await?
    }

    pub(crate) async fn delete_route(&self, route_id: String, secret: String) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let device_id = route_device(&transaction, &route_id)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            retire_route(&transaction, &route_id)?;
            gc_device_if_empty(&transaction, &device_id)?;
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn route(&self, route_id: String) -> Result<Route> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Route> {
            let mut connection = connect(&path)?;
            let now = unix_seconds();
            let mut stored = load_route(&connection, &route_id)?;
            if stored
                .as_ref()
                .is_some_and(|route| probing_route_expired(route, now))
            {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let expired = expire_probing_route(&transaction, &route_id, now)?;
                transaction.commit()?;
                if expired {
                    return Err(Error::NotFound);
                }
                stored = load_route(&connection, &route_id)?;
            }
            classify_route(stored)
        })
        .await?
    }

    pub(crate) async fn mark_device_dead(&self, device_id: String) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            retire_device(&transaction, &device_id)?;
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn dead_endpoints(
        &self,
        device_id: String,
        secret: String,
        home_vapid: Vec<u8>,
    ) -> Result<Vec<String>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Vec<String>> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            let account = device_account(&transaction, &device_id)?;
            let endpoints = {
                let mut statement = transaction.prepare(
                    "SELECT route_id FROM dead_endpoints
                     WHERE account = ?1 AND home_vapid = ?2
                     ORDER BY retired_at, route_id LIMIT ?3",
                )?;
                statement
                    .query_map(
                        params![account, home_vapid, DEAD_ENDPOINT_BATCH_SIZE],
                        |row| row.get(0),
                    )?
                    .collect::<rusqlite::Result<Vec<String>>>()?
            };
            transaction.commit()?;
            Ok(endpoints)
        })
        .await?
    }

    pub(crate) async fn acknowledge_dead_endpoints(
        &self,
        device_id: String,
        secret: String,
        home_vapid: Vec<u8>,
        route_ids: Vec<String>,
    ) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            let account = device_account(&transaction, &device_id)?;
            for route_id in route_ids {
                transaction.execute(
                    "DELETE FROM dead_endpoints
                     WHERE route_id = ?1 AND account = ?2 AND home_vapid = ?3",
                    params![route_id, account, home_vapid],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn renew_lease(
        &self,
        device_id: String,
        secret: String,
        tab_id: String,
        now: i64,
        expires_at: i64,
    ) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            let account = device_account(&transaction, &device_id)?;
            transaction.execute("DELETE FROM leases WHERE expires_at <= ?1", [now])?;
            transaction.execute("DELETE FROM held_pushes WHERE account = ?1", [&account])?;
            transaction.execute(
                "INSERT INTO leases (device_id, tab_id, expires_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(device_id, tab_id) DO UPDATE SET expires_at = excluded.expires_at",
                params![device_id, tab_id, expires_at],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn release_lease(
        &self,
        device_id: String,
        secret: String,
        tab_id: String,
    ) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            let connection = connect(&path)?;
            authenticate_device(&connection, &device_id, &secret)?;
            connection.execute(
                "DELETE FROM leases WHERE device_id = ?1 AND tab_id = ?2",
                params![device_id, tab_id],
            )?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn hold_if_leased(
        &self,
        account: String,
        route_id: String,
        body: Vec<u8>,
        ttl: u32,
        urgency: String,
        now: i64,
    ) -> Result<bool> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<bool> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute("DELETE FROM leases WHERE expires_at <= ?1", [now])?;
            let leased = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM leases
                   JOIN devices ON devices.id = leases.device_id
                   WHERE devices.account = ?1 AND leases.expires_at > ?2
                 )",
                params![account, now],
                |row| row.get::<_, bool>(0),
            )?;
            if leased {
                transaction.execute(
                    "INSERT INTO held_pushes (account, route_id, body, ttl, urgency, held_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![account, route_id, body, ttl, urgency, now],
                )?;
                let held_count = transaction.query_row(
                    "SELECT COUNT(*) FROM held_pushes WHERE account = ?1",
                    [&account],
                    |row| row.get::<_, u32>(0),
                )?;
                let overflow = held_count.saturating_sub(MAX_HELD_PUSHES_PER_ACCOUNT);
                if overflow > 0 {
                    transaction.execute(
                        "DELETE FROM held_pushes WHERE id IN (
                           SELECT id FROM held_pushes
                           WHERE account = ?1
                           ORDER BY id
                           LIMIT ?2
                         )",
                        params![account, overflow],
                    )?;
                }
            }
            transaction.commit()?;
            Ok(leased)
        })
        .await?
    }

    pub(crate) async fn next_held(&self, now: i64) -> Result<Option<HeldPush>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Option<HeldPush>> {
            let connection = connect(&path)?;
            connection.execute("DELETE FROM leases WHERE expires_at <= ?1", [now])?;
            connection.execute(
                "DELETE FROM held_pushes WHERE held_at + ttl * 1000 <= ?1",
                [now],
            )?;
            connection.execute(
                "DELETE FROM held_pushes WHERE route_id IN (
                   SELECT id FROM routes WHERE state != 'active'
                 )",
                [],
            )?;
            connection
                .query_row(
                    "SELECT held_pushes.id, routes.device_id, held_pushes.route_id,
                            devices.endpoint, devices.p256dh, devices.auth,
                            held_pushes.body, held_pushes.ttl, held_pushes.urgency,
                            held_pushes.held_at
                     FROM held_pushes
                     JOIN routes ON routes.id = held_pushes.route_id
                     JOIN devices ON devices.id = routes.device_id
                     WHERE NOT EXISTS (
                       SELECT 1 FROM leases
                       JOIN devices AS leased_devices ON leased_devices.id = leases.device_id
                       WHERE leased_devices.account = held_pushes.account
                         AND leases.expires_at > ?1
                     )
                     ORDER BY held_pushes.id
                     LIMIT 1",
                    [now],
                    |row| {
                        let ttl = row.get::<_, u32>(7)?;
                        let held_at = row.get::<_, i64>(9)?;
                        Ok(HeldPush {
                            id: row.get(0)?,
                            device_id: row.get(1)?,
                            route_id: row.get(2)?,
                            target: WebPushTarget {
                                endpoint: row.get(3)?,
                                p256dh: row.get(4)?,
                                auth: row.get(5)?,
                            },
                            body: row.get(6)?,
                            ttl: remaining_ttl(ttl, held_at, now),
                            urgency: row.get(8)?,
                        })
                    },
                )
                .optional()
                .map_err(Into::into)
        })
        .await?
    }

    pub(crate) async fn delete_held(&self, id: i64) -> Result<()> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<()> {
            connect(&path)?.execute("DELETE FROM held_pushes WHERE id = ?1", [id])?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn next_held_deadline(&self, now: i64) -> Result<Option<i64>> {
        let path = Arc::clone(&self.path);
        self.spawn(move || -> Result<Option<i64>> {
            connect(&path)?
                .query_row(
                    "SELECT MIN(
                       CASE
                         WHEN lease_deadline IS NULL OR push_deadline < lease_deadline
                           THEN push_deadline
                         ELSE lease_deadline
                       END
                     )
                     FROM (
                       SELECT held_at + ttl * 1000 AS push_deadline,
                              (
                                SELECT MAX(leases.expires_at)
                                FROM leases
                                JOIN devices ON devices.id = leases.device_id
                                WHERE devices.account = held_pushes.account
                                  AND leases.expires_at > ?1
                              ) AS lease_deadline
                       FROM held_pushes
                     )",
                    [now],
                    |row| row.get(0),
                )
                .map_err(Into::into)
        })
        .await?
    }
}

fn migrate_schema(connection: &Connection, version: u32) -> Result<()> {
    match version {
        0 => create_schema(connection)?,
        1 => migrate_schema_one(connection)?,
        2 => migrate_schema_two(connection)?,
        3 => migrate_schema_three(connection)?,
        4 => migrate_schema_four(connection)?,
        SCHEMA_VERSION => {}
        version => {
            return Err(Error::Config(format!(
                "database schema version {version} is newer than supported version {SCHEMA_VERSION}"
            )));
        }
    }
    Ok(())
}

fn create_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "BEGIN;
         CREATE TABLE devices (
           id TEXT PRIMARY KEY, account TEXT NOT NULL, secret_hash BLOB NOT NULL,
           endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
           created_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE TABLE routes (
           id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
           state TEXT NOT NULL CHECK (state IN ('probing', 'active', 'dead')),
           home_vapid BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX routes_device ON routes(device_id);
         CREATE TABLE leases (
           device_id TEXT NOT NULL REFERENCES devices(id), tab_id TEXT NOT NULL,
           expires_at INTEGER NOT NULL, PRIMARY KEY (device_id, tab_id)
         );
         CREATE TABLE held_pushes (
           id INTEGER PRIMARY KEY, account TEXT NOT NULL,
           route_id TEXT NOT NULL REFERENCES routes(id), body BLOB NOT NULL,
           ttl INTEGER NOT NULL,
           urgency TEXT NOT NULL CHECK (urgency IN ('very-low', 'low', 'normal', 'high')),
           held_at INTEGER NOT NULL
         );
         CREATE INDEX held_pushes_account ON held_pushes(account);
         CREATE TABLE retired_devices (
           id TEXT PRIMARY KEY, secret_hash BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE TABLE dead_endpoints (
           route_id TEXT PRIMARY KEY, account TEXT NOT NULL, home_vapid BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX dead_endpoints_account ON dead_endpoints(account);
         PRAGMA user_version = 5;
         COMMIT;",
    )?;
    Ok(())
}

fn migrate_schema_one(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "BEGIN;
         CREATE TABLE leases (
           device_id TEXT NOT NULL REFERENCES devices(id), tab_id TEXT NOT NULL,
           expires_at INTEGER NOT NULL, PRIMARY KEY (device_id, tab_id)
         );
         CREATE TABLE held_pushes (
           id INTEGER PRIMARY KEY, account TEXT NOT NULL,
           route_id TEXT NOT NULL REFERENCES routes(id), body BLOB NOT NULL,
           ttl INTEGER NOT NULL,
           urgency TEXT NOT NULL CHECK (urgency IN ('very-low', 'low', 'normal', 'high')),
           held_at INTEGER NOT NULL
         );
         CREATE INDEX held_pushes_account ON held_pushes(account);
         CREATE TABLE retired_devices (
           id TEXT PRIMARY KEY, secret_hash BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE TABLE dead_endpoints (
           route_id TEXT PRIMARY KEY, account TEXT NOT NULL, home_vapid BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX dead_endpoints_account ON dead_endpoints(account);
         PRAGMA user_version = 5;
         COMMIT;",
    )?;
    Ok(())
}

fn migrate_schema_two(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "BEGIN;
         CREATE TABLE retired_devices (
           id TEXT PRIMARY KEY, secret_hash BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE TABLE dead_endpoints (
           route_id TEXT PRIMARY KEY, account TEXT NOT NULL, home_vapid BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX dead_endpoints_account ON dead_endpoints(account);
         INSERT OR IGNORE INTO dead_endpoints (route_id, account, home_vapid)
           SELECT routes.id, devices.account, routes.home_vapid FROM routes
           JOIN devices ON devices.id = routes.device_id WHERE routes.state = 'dead';
         DELETE FROM held_pushes WHERE route_id IN (
           SELECT id FROM routes WHERE state = 'dead'
         );
         DELETE FROM routes WHERE state = 'dead';
         ALTER TABLE held_pushes ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal'
           CHECK (urgency IN ('very-low', 'low', 'normal', 'high'));
         PRAGMA user_version = 5;
         COMMIT;",
    )?;
    Ok(())
}

fn migrate_schema_three(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "BEGIN;
         ALTER TABLE held_pushes ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal'
           CHECK (urgency IN ('very-low', 'low', 'normal', 'high'));
         DROP TABLE dead_endpoints;
         CREATE TABLE dead_endpoints (
           route_id TEXT PRIMARY KEY, account TEXT NOT NULL, home_vapid BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX dead_endpoints_account ON dead_endpoints(account);
         PRAGMA user_version = 5;
         COMMIT;",
    )?;
    Ok(())
}

fn migrate_schema_four(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "BEGIN;
         DROP TABLE dead_endpoints;
         CREATE TABLE dead_endpoints (
           route_id TEXT PRIMARY KEY, account TEXT NOT NULL, home_vapid BLOB NOT NULL,
           retired_at INTEGER NOT NULL DEFAULT (unixepoch())
         );
         CREATE INDEX dead_endpoints_account ON dead_endpoints(account);
         PRAGMA user_version = 5;
         COMMIT;",
    )?;
    Ok(())
}

fn connect(path: &PathBuf) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(connection)
}

fn secure_database_file(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

        options.mode(0o600);
        drop(options.open(path)?);
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    drop(options.open(path)?);
    Ok(())
}

fn retire_devices_for_endpoint(
    transaction: &rusqlite::Transaction<'_>,
    endpoint: &str,
    except: Option<&str>,
) -> Result<()> {
    let devices = {
        let mut statement = transaction.prepare(
            "SELECT id FROM devices WHERE endpoint = ?1 AND (?2 IS NULL OR id != ?2) ORDER BY id",
        )?;
        statement
            .query_map(params![endpoint, except], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for device in devices {
        retire_device(transaction, &device)?;
    }
    Ok(())
}

fn retire_device(transaction: &rusqlite::Transaction<'_>, device_id: &str) -> Result<()> {
    let secret_hash = transaction
        .query_row(
            "SELECT secret_hash FROM devices WHERE id = ?1",
            [device_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?
        .ok_or_else(|| retired_or_missing(transaction, device_id))?;
    let routes = {
        let mut statement = transaction.prepare("SELECT id FROM routes WHERE device_id = ?1")?;
        statement
            .query_map([device_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for route in routes {
        retire_route(transaction, &route)?;
    }
    transaction.execute("DELETE FROM leases WHERE device_id = ?1", [device_id])?;
    transaction.execute("DELETE FROM devices WHERE id = ?1", [device_id])?;
    transaction.execute(
        "INSERT OR REPLACE INTO retired_devices (id, secret_hash) VALUES (?1, ?2)",
        params![device_id, secret_hash],
    )?;
    Ok(())
}

fn retire_home_routes(
    transaction: &rusqlite::Transaction<'_>,
    device_id: &str,
    home_vapid: &[u8],
) -> Result<()> {
    let routes = {
        let mut statement = transaction.prepare(
            "SELECT id FROM routes WHERE device_id = ?1 AND home_vapid = ?2 ORDER BY id",
        )?;
        statement
            .query_map(params![device_id, home_vapid], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for route in routes {
        retire_route(transaction, &route)?;
    }
    Ok(())
}

fn retire_home_routes_except(
    transaction: &rusqlite::Transaction<'_>,
    device_id: &str,
    home_vapid: &[u8],
    retained_route: &str,
) -> Result<()> {
    let routes = {
        let mut statement = transaction.prepare(
            "SELECT id FROM routes
             WHERE device_id = ?1 AND home_vapid = ?2 AND id != ?3 ORDER BY id",
        )?;
        statement
            .query_map(params![device_id, home_vapid, retained_route], |row| {
                row.get(0)
            })?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for route in routes {
        retire_route(transaction, &route)?;
    }
    Ok(())
}

fn retire_route(transaction: &rusqlite::Transaction<'_>, route_id: &str) -> Result<()> {
    let retired = transaction
        .query_row(
            "SELECT devices.account, routes.home_vapid FROM routes
             JOIN devices ON devices.id = routes.device_id WHERE routes.id = ?1",
            [route_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?;
    let Some((account, home_vapid)) = retired else {
        return Ok(());
    };
    transaction.execute("DELETE FROM held_pushes WHERE route_id = ?1", [route_id])?;
    transaction.execute("DELETE FROM routes WHERE id = ?1", [route_id])?;
    transaction.execute(
        "INSERT OR IGNORE INTO dead_endpoints (route_id, account, home_vapid)
         VALUES (?1, ?2, ?3)",
        params![route_id, account, home_vapid],
    )?;
    Ok(())
}

fn load_route(connection: &Connection, route_id: &str) -> Result<Option<StoredRoute>> {
    connection
        .query_row(
            "SELECT routes.state, routes.device_id, devices.account, routes.home_vapid,
                    devices.endpoint, devices.p256dh, devices.auth, routes.created_at
             FROM routes JOIN devices ON devices.id = routes.device_id
             WHERE routes.id = ?1",
            [route_id],
            |row| {
                Ok(StoredRoute {
                    state: row.get(0)?,
                    device_id: row.get(1)?,
                    account: row.get(2)?,
                    home_vapid: row.get(3)?,
                    target: WebPushTarget {
                        endpoint: row.get(4)?,
                        p256dh: row.get(5)?,
                        auth: row.get(6)?,
                    },
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn classify_route(stored: Option<StoredRoute>) -> Result<Route> {
    match stored {
        Some(route) if route.state == "probing" => Ok(Route::Probing),
        Some(route) if route.state == "active" => Ok(Route::Active {
            device_id: route.device_id,
            account: route.account,
            home_vapid: route.home_vapid,
            target: route.target,
        }),
        _ => Err(Error::NotFound),
    }
}

fn probing_route_expired(route: &StoredRoute, now: i64) -> bool {
    route.state == "probing" && route.created_at <= now.saturating_sub(PROBING_ROUTE_TTL_SECONDS)
}

fn expire_probing_route(
    transaction: &rusqlite::Transaction<'_>,
    route_id: &str,
    now: i64,
) -> Result<bool> {
    let expired = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM routes
           WHERE id = ?1 AND state = 'probing' AND created_at <= ?2
         )",
        params![route_id, now.saturating_sub(PROBING_ROUTE_TTL_SECONDS)],
        |row| row.get(0),
    )?;
    if expired {
        retire_route(transaction, route_id)?;
    }
    Ok(expired)
}

fn expire_probing_routes(transaction: &rusqlite::Transaction<'_>, now: i64) -> Result<()> {
    let routes = {
        let mut statement = transaction.prepare(
            "SELECT id FROM routes WHERE state = 'probing' AND created_at <= ?1 ORDER BY id",
        )?;
        statement
            .query_map([now.saturating_sub(PROBING_ROUTE_TTL_SECONDS)], |row| {
                row.get(0)
            })?
            .collect::<rusqlite::Result<Vec<String>>>()?
    };
    for route in routes {
        retire_route(transaction, &route)?;
    }
    Ok(())
}

fn gc_device_if_empty(transaction: &rusqlite::Transaction<'_>, device_id: &str) -> Result<()> {
    let has_routes = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM routes WHERE device_id = ?1)",
        [device_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !has_routes {
        retire_device(transaction, device_id)?;
    }
    Ok(())
}

fn authenticate_device(connection: &Connection, id: &str, secret: &str) -> Result<()> {
    let expected = connection
        .query_row(
            "SELECT secret_hash FROM devices WHERE id = ?1",
            [id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?;
    let given = secret_hash(secret);
    if expected
        .as_deref()
        .is_some_and(|hash| hash.ct_eq(given.as_slice()).into())
    {
        Ok(())
    } else if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM retired_devices WHERE id = ?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )? {
        Err(Error::Gone)
    } else {
        Err(Error::Unauthorized)
    }
}

fn retired_or_missing(connection: &Connection, id: &str) -> Error {
    match connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM retired_devices WHERE id = ?1)",
        [id],
        |row| row.get::<_, bool>(0),
    ) {
        Ok(true) => Error::Gone,
        _ => Error::NotFound,
    }
}

fn route_device(connection: &Connection, route_id: &str) -> Result<String> {
    connection
        .query_row(
            "SELECT device_id FROM routes WHERE id = ?1 AND state != 'dead'",
            [route_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)
}

fn device_account(connection: &Connection, device_id: &str) -> Result<String> {
    connection
        .query_row(
            "SELECT account FROM devices WHERE id = ?1",
            [device_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)
}

fn random_token() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| Error::Config(format!("secure randomness is unavailable: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn secret_hash(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

fn remaining_ttl(ttl: u32, held_at: i64, now: i64) -> u32 {
    let elapsed_milliseconds = now.saturating_sub(held_at);
    let elapsed_seconds = elapsed_milliseconds.saturating_add(999) / 1_000;
    let elapsed_seconds = u32::try_from(elapsed_seconds).unwrap_or(u32::MAX);
    ttl.saturating_sub(elapsed_seconds)
}

fn unix_seconds() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, task::Poll};

    use futures::{pin_mut, poll};

    use super::{
        Database, MAX_CONCURRENT_DATABASE_TASKS, MAX_DEVICES_PER_ACCOUNT, MAX_ROUTES_PER_DEVICE,
        WebPushTarget,
    };
    use crate::Error;

    fn target(index: u32) -> WebPushTarget {
        WebPushTarget {
            endpoint: format!("https://push.example/{index}"),
            p256dh: "key".to_owned(),
            auth: "auth".to_owned(),
        }
    }

    #[tokio::test]
    async fn bounds_concurrent_blocking_database_tasks() {
        let temporary = tempfile::tempdir().expect("temporary state");
        let database = Database::open(temporary.path().join("relay.sqlite3"))
            .await
            .expect("database");
        let permits = (0..MAX_CONCURRENT_DATABASE_TASKS)
            .map(|_| {
                Arc::clone(&database.tasks)
                    .try_acquire_owned()
                    .expect("configured database task permit")
            })
            .collect::<Vec<_>>();
        assert!(
            Arc::clone(&database.tasks).try_acquire_owned().is_err(),
            "database task limiter admitted an extra operation"
        );

        let operation = database.spawn(|| Ok(()));
        pin_mut!(operation);
        assert!(matches!(poll!(operation.as_mut()), Poll::Pending));

        drop(permits);
        operation
            .await
            .expect("database task")
            .expect("database operation");
    }

    #[tokio::test]
    async fn caps_devices_per_account_and_live_routes_per_device() {
        let temporary = tempfile::tempdir().expect("temporary state");
        let database = Database::open(temporary.path().join("relay.sqlite3"))
            .await
            .expect("database");
        let first = database
            .create_device("mel".to_owned(), target(0))
            .await
            .expect("first device");
        for index in 1..MAX_DEVICES_PER_ACCOUNT {
            database
                .create_device("mel".to_owned(), target(index))
                .await
                .expect("device within limit");
        }
        let extra_device = database
            .create_device("mel".to_owned(), target(MAX_DEVICES_PER_ACCOUNT))
            .await;
        assert!(matches!(extra_device, Err(Error::Capacity)));

        for index in 0..MAX_ROUTES_PER_DEVICE {
            database
                .ensure_route(
                    first.id.clone(),
                    first.secret.clone(),
                    vec![u8::try_from(index).expect("route index"); 65],
                    None,
                )
                .await
                .expect("route within limit");
        }
        let extra_route = database
            .ensure_route(first.id, first.secret, vec![255; 65], None)
            .await;
        assert!(matches!(extra_route, Err(Error::Capacity)));
    }

    #[tokio::test]
    async fn dead_endpoints_are_scoped_bounded_and_acknowledged() {
        let temporary = tempfile::tempdir().expect("temporary state");
        let path = temporary.path().join("relay.sqlite3");
        let database = Database::open(path.clone()).await.expect("database");
        let device = database
            .create_device("mel".to_owned(), target(0))
            .await
            .expect("device");
        let first_home = vec![1_u8; 65];
        let second_home = vec![2_u8; 65];
        let connection = rusqlite::Connection::open(path).expect("connection");
        for index in 0..6 {
            connection
                .execute(
                    "INSERT INTO dead_endpoints (route_id, account, home_vapid)
                     VALUES (?1, 'mel', ?2)",
                    rusqlite::params![format!("first-{index}"), first_home],
                )
                .expect("first-home endpoint");
        }
        connection
            .execute(
                "INSERT INTO dead_endpoints (route_id, account, home_vapid)
                 VALUES ('second-0', 'mel', ?1)",
                [&second_home],
            )
            .expect("second-home endpoint");

        let batch = database
            .dead_endpoints(device.id.clone(), device.secret.clone(), first_home.clone())
            .await
            .expect("first batch");
        assert_eq!(
            batch,
            (0..5)
                .map(|index| format!("first-{index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            database
                .dead_endpoints(device.id.clone(), device.secret.clone(), second_home,)
                .await
                .expect("other home"),
            vec!["second-0"]
        );
        database
            .acknowledge_dead_endpoints(
                device.id.clone(),
                device.secret.clone(),
                first_home.clone(),
                batch,
            )
            .await
            .expect("acknowledge batch");
        assert_eq!(
            database
                .dead_endpoints(device.id, device.secret, first_home)
                .await
                .expect("remaining batch"),
            vec!["first-5"]
        );
    }

    #[test]
    fn device_credentials_debug_redacts_the_secret() {
        let credentials = super::DeviceCredentials {
            id: "device-id".to_owned(),
            secret: "should-never-appear".to_owned(),
        };
        let debug = format!("{credentials:?}");
        assert!(debug.contains("device-id"));
        assert!(!debug.contains("should-never-appear"));
        assert!(debug.contains("[redacted]"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn database_uses_wal_versioning_and_private_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = tempfile::tempdir().expect("temporary state");
        let path = temporary.path().join("relay.sqlite3");
        Database::open(path.clone()).await.expect("database");
        let connection = rusqlite::Connection::open(&path).expect("connection");
        let version = connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .expect("schema version");
        let journal = connection
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .expect("journal mode");
        let mode = std::fs::metadata(path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(version, 5);
        assert_eq!(journal, "wal");
        assert_eq!(mode, 0o600);
    }
}
