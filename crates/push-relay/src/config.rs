use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use clap::Parser;
use url::Url;

use crate::{Error, Result};

/// The loopback-only default used behind the production reverse proxy.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8098";
/// The database name within the configured state directory.
pub const DATABASE_FILE: &str = "push-relay.sqlite3";

/// Creates the state directory and restricts it to the service account on Unix.
///
/// # Errors
///
/// Returns an error if the directory cannot be created or secured.
pub async fn prepare_state_directory(path: &Path) -> Result<()> {
    tokio::fs::create_dir_all(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

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

    /// Browser origins allowed to call the device and route APIs.
    #[arg(long, env = "PUSH_RELAY_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub allowed_origins: Vec<Url>,

    /// PEM file containing the relay's P-256 VAPID private key.
    #[arg(long, env = "PUSH_RELAY_VAPID_KEY_FILE")]
    pub vapid_key_file: PathBuf,

    /// Concierge RFC 7662 introspection endpoint.
    #[arg(long, env = "PUSH_RELAY_CONCIERGE_URL")]
    pub concierge_url: Url,

    /// File containing the push-relay introspection client secret.
    #[arg(long, env = "PUSH_RELAY_CONCIERGE_SECRET_FILE")]
    pub concierge_secret_file: PathBuf,

    /// TEST ONLY: push-service hostname allowed to resolve to TEST-NET-3.
    #[cfg(feature = "push-e2e")]
    #[arg(long, env = "PUSH_RELAY_TEST_TARGET_HOST", hide = true)]
    pub test_target_host: Vec<String>,

    /// TEST ONLY: CA trusted for the push-service endpoint.
    #[cfg(feature = "push-e2e")]
    #[arg(long, env = "PUSH_RELAY_TEST_CA_FILE", hide = true)]
    pub test_ca_file: Option<PathBuf>,
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
        for origin in &self.allowed_origins {
            if !matches!(origin.scheme(), "http" | "https")
                || origin.cannot_be_a_base()
                || !origin.username().is_empty()
                || origin.password().is_some()
                || origin.path() != "/"
                || origin.query().is_some()
                || origin.fragment().is_some()
            {
                return Err(Error::Config(
                    "--allowed-origins values must be exact HTTP or HTTPS origins".to_owned(),
                ));
            }
        }
        #[cfg(feature = "push-e2e")]
        if self.test_target_host.is_empty() != self.test_ca_file.is_none() {
            return Err(Error::Config(
                "test target host and CA must be configured together".to_owned(),
            ));
        }
        #[cfg(feature = "push-e2e")]
        if self
            .test_target_host
            .iter()
            .any(|host| host.is_empty() || host.contains(['/', ':']))
        {
            return Err(Error::Config(
                "test target host must be a hostname".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use clap::Parser as _;
    use url::Url;

    #[tokio::test]
    async fn state_directory_is_private() {
        let temporary = tempfile::tempdir().expect("temporary parent");
        let state = temporary.path().join("state");
        super::prepare_state_directory(&state)
            .await
            .expect("state directory");
        let mode = std::fs::metadata(state)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn parses_and_validates_comma_separated_allowed_origins() {
        let config = super::Config::try_parse_from([
            "push-relay",
            "--allowed-origins",
            "https://beta.weblounge.org,http://localhost:5173",
            "--vapid-key-file",
            "vapid.pem",
            "--concierge-url",
            "http://127.0.0.1/introspect",
            "--concierge-secret-file",
            "concierge.secret",
        ])
        .expect("configuration");

        config.validate().expect("valid origins");
        assert_eq!(config.allowed_origins.len(), 2);
    }

    #[test]
    fn rejects_allowed_origin_with_more_than_an_origin() {
        let mut config = super::Config::try_parse_from([
            "push-relay",
            "--allowed-origins",
            "https://beta.weblounge.org/client",
            "--vapid-key-file",
            "vapid.pem",
            "--concierge-url",
            "http://127.0.0.1/introspect",
            "--concierge-secret-file",
            "concierge.secret",
        ])
        .expect("configuration");

        assert!(config.validate().is_err());
        config.allowed_origins = vec![Url::parse("ftp://beta.weblounge.org").expect("URL")];
        assert!(config.validate().is_err());
    }

    #[cfg(feature = "push-e2e")]
    #[test]
    fn test_target_requires_its_private_ca() {
        let mut config = super::Config::try_parse_from([
            "push-relay",
            "--vapid-key-file",
            "vapid.pem",
            "--concierge-url",
            "http://127.0.0.1/introspect",
            "--concierge-secret-file",
            "concierge.secret",
            "--test-target-host",
            "receiver.test",
        ])
        .expect("configuration");

        assert!(config.validate().is_err());
        config.test_ca_file = Some("ca.pem".into());
        config.validate().expect("paired test target configuration");

        config
            .test_target_host
            .push("second.receiver.test".to_owned());
        config.validate().expect("multiple test targets");
    }
}
