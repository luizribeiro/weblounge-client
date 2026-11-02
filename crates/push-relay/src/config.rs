use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;
use url::Url;

use crate::{Error, Result};

/// The loopback-only default used behind the production reverse proxy.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8098";
/// The database name within the configured state directory.
pub const DATABASE_FILE: &str = "push-relay.sqlite3";

/// Process configuration. Every setting has a flag and environment equivalent.
#[derive(Clone, Debug, Parser)]
#[command(version, about)]
pub struct Config {
    /// Address on which the relay accepts HTTP from its reverse proxy.
    #[arg(long, env = "PUSH_RELAY_LISTEN", default_value = DEFAULT_LISTEN)]
    pub listen: SocketAddr,

    /// Directory containing the relay's SQLite database.
    #[arg(long, env = "PUSH_RELAY_STATE_DIR", default_value = "./state")]
    pub state_dir: PathBuf,

    /// Public HTTPS origin used for route URLs and incoming VAPID audiences.
    #[arg(
        long,
        env = "PUSH_RELAY_ORIGIN",
        default_value = "https://push.weblounge.org"
    )]
    pub origin: Url,

    /// PEM file containing the relay's P-256 VAPID private key.
    #[arg(long, env = "PUSH_RELAY_VAPID_KEY_FILE")]
    pub vapid_key_file: PathBuf,

    /// Concierge RFC 7662 introspection endpoint.
    #[arg(long, env = "PUSH_RELAY_CONCIERGE_URL")]
    pub concierge_url: Url,

    /// File containing the push-relay introspection client secret.
    #[arg(long, env = "PUSH_RELAY_CONCIERGE_SECRET_FILE")]
    pub concierge_secret_file: PathBuf,
}

impl Config {
    /// Returns the stable database path below [`Config::state_dir`].
    #[must_use]
    pub fn database_path(&self) -> PathBuf {
        self.state_dir.join(DATABASE_FILE)
    }

    /// Rejects origins and introspection endpoints that would weaken deployment boundaries.
    ///
    /// # Errors
    ///
    /// Returns an error when an origin or endpoint is not safe for its intended role.
    pub fn validate(&self) -> Result<()> {
        if self.origin.scheme() != "https"
            || self.origin.cannot_be_a_base()
            || !self.origin.username().is_empty()
            || self.origin.password().is_some()
        {
            return Err(Error::Config("--origin must be an HTTPS origin".to_owned()));
        }
        if self.origin.path() != "/"
            || self.origin.query().is_some()
            || self.origin.fragment().is_some()
        {
            return Err(Error::Config(
                "--origin must not contain a path, query, or fragment".to_owned(),
            ));
        }
        if !matches!(self.concierge_url.scheme(), "http" | "https") {
            return Err(Error::Config(
                "--concierge-url must use HTTP or HTTPS".to_owned(),
            ));
        }
        Ok(())
    }
}
