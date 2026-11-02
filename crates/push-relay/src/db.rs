use std::{path::PathBuf, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Error, Result};

#[derive(Clone, Debug)]
pub(crate) struct WebPushTarget {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DeviceCredentials {
    pub id: String,
    pub secret: String,
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
        home_vapid: Vec<u8>,
        target: WebPushTarget,
    },
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
            let connection = connect(&schema_path)?;
            connection.execute_batch(
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
                 COMMIT;",
            )?;
            Ok(())
        })
        .await??;
        Ok(database)
    }

    pub(crate) async fn health(&self) -> Result<()> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<()> {
            connect(&path)?.query_row("SELECT 1", [], |_| Ok(()))?;
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
        tokio::task::spawn_blocking(move || -> Result<()> {
            connect(&path)?.execute(
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
            let connection = connect(&path)?;
            authenticate_device(&connection, &device_id, &secret)?;
            connection.execute(
                "INSERT INTO routes (id, device_id, state, home_vapid)
                 VALUES (?1, ?2, 'probing', ?3)",
                params![stored.id, device_id, home_vapid],
            )?;
            Ok(())
        })
        .await??;
        Ok(route)
    }

    pub(crate) async fn activate_route(&self, route_id: String, secret: String) -> Result<()> {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let connection = connect(&path)?;
            let device_id = route_device(&connection, &route_id)?;
            authenticate_device(&connection, &device_id, &secret)?;
            let changed = connection.execute(
                "UPDATE routes SET state = 'active' WHERE id = ?1 AND state = 'probing'",
                [&route_id],
            )?;
            if changed == 1 {
                Ok(())
            } else {
                Err(Error::NotFound)
            }
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
                    "SELECT routes.state, routes.device_id, routes.home_vapid,
                            devices.endpoint, devices.p256dh, devices.auth
                     FROM routes JOIN devices ON devices.id = routes.device_id
                     WHERE routes.id = ?1",
                    [&route_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Vec<u8>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .optional()?;
            match row {
                Some((state, _, _, _, _, _)) if state == "probing" => Ok(Route::Probing),
                Some((state, device_id, home_vapid, endpoint, p256dh, auth))
                    if state == "active" =>
                {
                    Ok(Route::Active {
                        device_id,
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
}

fn connect(path: &PathBuf) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(connection)
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

fn random_token() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| Error::Config(format!("secure randomness is unavailable: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn secret_hash(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}
