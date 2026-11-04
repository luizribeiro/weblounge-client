use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Error, Result};

#[cfg(feature = "push-e2e")]
use serde::Serialize;

const MAX_DEVICES_PER_ACCOUNT: u32 = 20;
const MAX_ROUTES_PER_DEVICE: u32 = 25;
const MAX_HELD_PUSHES_PER_ACCOUNT: u32 = 100;
const SCHEMA_VERSION: u32 = 2;

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

#[derive(Clone, Debug)]
pub(crate) struct HeldPush {
    pub id: i64,
    pub device_id: String,
    pub route_id: String,
    pub target: WebPushTarget,
    pub body: Vec<u8>,
    pub ttl: u32,
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
}

/// A small SQLite state store. Connections are short-lived and run off the async executor.
#[derive(Clone, Debug)]
pub struct Database {
    path: Arc<PathBuf>,
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
        };
        let schema_path = Arc::clone(&database.path);
        tokio::task::spawn_blocking(move || -> Result<()> {
            secure_database_file(&schema_path)?;
            let connection = connect(&schema_path)?;
            let journal_mode = connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
                row.get::<_, String>(0)
            })?;
            if journal_mode != "wal" {
                return Err(Error::Config("SQLite WAL mode is unavailable".to_owned()));
            }
            let schema_version = connection.pragma_query_value(None, "user_version", |row| {
                row.get::<_, u32>(0)
            })?;
            match schema_version {
                0 => connection.execute_batch(
                    "BEGIN;
                 CREATE TABLE IF NOT EXISTS devices (
                   id TEXT PRIMARY KEY,
                   account TEXT NOT NULL,
                   secret_hash BLOB NOT NULL,
                   endpoint TEXT NOT NULL,
                   p256dh TEXT NOT NULL,
                   auth TEXT NOT NULL,
                   created_at INTEGER NOT NULL DEFAULT (unixepoch())
                 );
                 CREATE TABLE IF NOT EXISTS routes (
                   id TEXT PRIMARY KEY,
                   device_id TEXT NOT NULL REFERENCES devices(id),
                   state TEXT NOT NULL CHECK (state IN ('probing', 'active', 'dead')),
                   home_vapid BLOB NOT NULL,
                   created_at INTEGER NOT NULL DEFAULT (unixepoch())
                 );
                 CREATE INDEX IF NOT EXISTS routes_device ON routes(device_id);
                 CREATE TABLE IF NOT EXISTS leases (
                   device_id TEXT NOT NULL REFERENCES devices(id),
                   tab_id TEXT NOT NULL,
                   expires_at INTEGER NOT NULL,
                   PRIMARY KEY (device_id, tab_id)
                 );
                 CREATE TABLE IF NOT EXISTS held_pushes (
                   id INTEGER PRIMARY KEY,
                   account TEXT NOT NULL,
                   route_id TEXT NOT NULL REFERENCES routes(id),
                   body BLOB NOT NULL,
                   ttl INTEGER NOT NULL,
                   held_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS held_pushes_account ON held_pushes(account);
                 PRAGMA user_version = 2;
                 COMMIT;",
                )?,
                1 => connection.execute_batch(
                    "BEGIN;
                     CREATE TABLE leases (
                       device_id TEXT NOT NULL REFERENCES devices(id),
                       tab_id TEXT NOT NULL,
                       expires_at INTEGER NOT NULL,
                       PRIMARY KEY (device_id, tab_id)
                     );
                     CREATE TABLE held_pushes (
                       id INTEGER PRIMARY KEY,
                       account TEXT NOT NULL,
                       route_id TEXT NOT NULL REFERENCES routes(id),
                       body BLOB NOT NULL,
                       ttl INTEGER NOT NULL,
                       held_at INTEGER NOT NULL
                     );
                     CREATE INDEX held_pushes_account ON held_pushes(account);
                     PRAGMA user_version = 2;
                     COMMIT;",
                )?,
                SCHEMA_VERSION => {}
                version => {
                    return Err(Error::Config(format!(
                        "database schema version {version} is newer than supported version {SCHEMA_VERSION}"
                    )));
                }
            }
            Ok(())
        })
        .await??;
        Ok(database)
    }

    pub(crate) async fn health(&self) -> Result<Vec<DuplicateActiveRoutes>> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<Vec<DuplicateActiveRoutes>> {
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
        tokio::task::spawn_blocking(move || -> Result<Vec<TestDeviceState>> {
            let connection = connect(&path)?;
            let mut statement = connection.prepare(
                "SELECT devices.id,
                        COALESCE(SUM(routes.state = 'probing'), 0),
                        COALESCE(SUM(routes.state = 'active'), 0),
                        COALESCE(SUM(routes.state = 'dead'), 0),
                        (SELECT COUNT(*) FROM leases WHERE leases.device_id = devices.id)
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
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
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
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
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

    pub(crate) async fn create_route(
        &self,
        device_id: String,
        secret: String,
        home_vapid: Vec<u8>,
    ) -> Result<RouteCredentials> {
        let route = RouteCredentials {
            id: random_token()?,
        };
        let stored = route.clone();
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut connection = connect(&path)?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authenticate_device(&transaction, &device_id, &secret)?;
            let route_count = transaction.query_row(
                "SELECT COUNT(*) FROM routes WHERE device_id = ?1 AND state != 'dead'",
                [&device_id],
                |row| row.get::<_, u32>(0),
            )?;
            if route_count >= MAX_ROUTES_PER_DEVICE {
                return Err(Error::Capacity);
            }
            transaction.execute(
                "INSERT INTO routes (id, device_id, state, home_vapid)
                 VALUES (?1, ?2, 'probing', ?3)",
                params![stored.id, device_id, home_vapid],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await??;
        Ok(route)
    }

    pub(crate) async fn activate_route(
        &self,
        route_id: String,
        secret: String,
    ) -> Result<Vec<String>> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
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
            transaction.execute(
                "UPDATE routes SET state = 'dead'
                 WHERE device_id = ?1 AND home_vapid = ?2 AND id != ?3 AND state != 'dead'",
                params![device_id, home_vapid, route_id],
            )?;
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
        tokio::task::spawn_blocking(move || -> Result<()> {
            let connection = connect(&path)?;
            let device_id = route_device(&connection, &route_id)?;
            authenticate_device(&connection, &device_id, &secret)?;
            connection.execute(
                "UPDATE routes SET state = 'dead' WHERE id = ?1",
                [&route_id],
            )?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn route(&self, route_id: String) -> Result<Route> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<Route> {
            let connection = connect(&path)?;
            let row = connection
                .query_row(
                    "SELECT routes.state, routes.device_id, devices.account, routes.home_vapid,
                            devices.endpoint, devices.p256dh, devices.auth
                     FROM routes JOIN devices ON devices.id = routes.device_id
                     WHERE routes.id = ?1",
                    [&route_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    },
                )
                .optional()?;
            match row {
                Some((state, _, _, _, _, _, _)) if state == "probing" => Ok(Route::Probing),
                Some((state, device_id, account, home_vapid, endpoint, p256dh, auth))
                    if state == "active" =>
                {
                    Ok(Route::Active {
                        device_id,
                        account,
                        home_vapid,
                        target: WebPushTarget {
                            endpoint,
                            p256dh,
                            auth,
                        },
                    })
                }
                _ => Err(Error::NotFound),
            }
        })
        .await?
    }

    pub(crate) async fn mark_device_dead(&self, device_id: String) -> Result<()> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<()> {
            connect(&path)?.execute(
                "UPDATE routes SET state = 'dead' WHERE device_id = ?1",
                [&device_id],
            )?;
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
        tokio::task::spawn_blocking(move || -> Result<()> {
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
        tokio::task::spawn_blocking(move || -> Result<()> {
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
        now: i64,
    ) -> Result<bool> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<bool> {
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
                    "INSERT INTO held_pushes (account, route_id, body, ttl, held_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![account, route_id, body, ttl, now],
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
        tokio::task::spawn_blocking(move || -> Result<Option<HeldPush>> {
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
                            held_pushes.body, held_pushes.ttl, held_pushes.held_at
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
                        let held_at = row.get::<_, i64>(8)?;
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
        tokio::task::spawn_blocking(move || -> Result<()> {
            connect(&path)?.execute("DELETE FROM held_pushes WHERE id = ?1", [id])?;
            Ok(())
        })
        .await?
    }

    pub(crate) async fn next_held_deadline(&self, now: i64) -> Result<Option<i64>> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<Option<i64>> {
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
    } else {
        Err(Error::Unauthorized)
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

#[cfg(test)]
mod tests {
    use super::{Database, MAX_DEVICES_PER_ACCOUNT, MAX_ROUTES_PER_DEVICE, WebPushTarget};
    use crate::Error;

    fn target(index: u32) -> WebPushTarget {
        WebPushTarget {
            endpoint: format!("https://push.example/{index}"),
            p256dh: "key".to_owned(),
            auth: "auth".to_owned(),
        }
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

        for _ in 0..MAX_ROUTES_PER_DEVICE {
            database
                .create_route(first.id.clone(), first.secret.clone(), vec![4; 65])
                .await
                .expect("route within limit");
        }
        let extra_route = database
            .create_route(first.id, first.secret, vec![4; 65])
            .await;
        assert!(matches!(extra_route, Err(Error::Capacity)));
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
        assert_eq!(version, 2);
        assert_eq!(journal, "wal");
        assert_eq!(mode, 0o600);
    }
}
