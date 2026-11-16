use rusqlite::{Row, types::Type};

/// A browser `PushSubscription`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WebPushTarget {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// An APNs device token and the APNs environment that issued it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ApnsTarget {
    pub token: String,
    pub environment: ApnsEnvironment,
}

/// The APNs environment a device token belongs to; tokens are not valid across environments.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApnsEnvironment {
    /// `api.push.apple.com`, used by distribution-signed builds.
    Production,
    /// `api.sandbox.push.apple.com`, used by development-signed builds.
    Sandbox,
}

/// One value for each APNs environment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApnsEnvironments<T> {
    /// The value for [`ApnsEnvironment::Production`].
    pub production: T,
    /// The value for [`ApnsEnvironment::Sandbox`].
    pub sandbox: T,
}

impl<T> ApnsEnvironments<T> {
    /// The value for `environment`.
    pub fn get(&self, environment: ApnsEnvironment) -> &T {
        match environment {
            ApnsEnvironment::Production => &self.production,
            ApnsEnvironment::Sandbox => &self.sandbox,
        }
    }
}

/// Where a device receives its pushes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PushTarget {
    WebPush(WebPushTarget),
    Apns(ApnsTarget),
}

const WEB_PUSH: &str = "web_push";
const APNS: &str = "apns";

/// The `devices` columns that store a [`PushTarget`], in the order of [`PushTarget::values`].
const TARGET_COLUMNS: [&str; 5] = ["platform", "address", "p256dh", "auth", "apns_environment"];

/// The target columns as a select list, each qualified with `table`.
pub(crate) fn target_select_list(table: &str) -> String {
    TARGET_COLUMNS
        .map(|column| format!("{table}.{column}"))
        .join(", ")
}

/// The target columns and their placeholders, numbered from `first_parameter`.
pub(crate) fn target_insert_list(first_parameter: usize) -> (String, String) {
    let placeholders = (first_parameter..first_parameter + TARGET_COLUMNS.len())
        .map(|parameter| format!("?{parameter}"))
        .collect::<Vec<_>>()
        .join(", ");
    (TARGET_COLUMNS.join(", "), placeholders)
}

/// `column = ?n` assignments for the target columns, numbered from `first_parameter`.
pub(crate) fn target_assignments(first_parameter: usize) -> String {
    TARGET_COLUMNS
        .iter()
        .enumerate()
        .map(|(offset, column)| format!("{column} = ?{}", first_parameter + offset))
        .collect::<Vec<_>>()
        .join(", ")
}

impl ApnsEnvironment {
    fn stored(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Sandbox => "sandbox",
        }
    }

    fn from_stored(value: &str) -> Option<Self> {
        match value {
            "production" => Some(Self::Production),
            "sandbox" => Some(Self::Sandbox),
            _ => None,
        }
    }
}

impl PushTarget {
    /// The value that identifies one physical subscription across devices.
    pub(crate) fn address(&self) -> &str {
        match self {
            Self::WebPush(target) => &target.endpoint,
            Self::Apns(target) => &target.token,
        }
    }

    pub(crate) fn platform(&self) -> &'static str {
        match self {
            Self::WebPush(_) => WEB_PUSH,
            Self::Apns(_) => APNS,
        }
    }

    /// The stored value of each of [`TARGET_COLUMNS`].
    pub(crate) fn values(&self) -> [Option<&str>; 5] {
        match self {
            Self::WebPush(target) => [
                Some(WEB_PUSH),
                Some(&target.endpoint),
                Some(&target.p256dh),
                Some(&target.auth),
                None,
            ],
            Self::Apns(target) => [
                Some(APNS),
                Some(&target.token),
                None,
                None,
                Some(target.environment.stored()),
            ],
        }
    }

    /// Reads the [`TARGET_COLUMNS`] that start at column `first`.
    pub(crate) fn from_row(row: &Row<'_>, first: usize) -> rusqlite::Result<Self> {
        let platform = row.get::<_, String>(first)?;
        let address = row.get::<_, String>(first + 1)?;
        let p256dh = row.get::<_, Option<String>>(first + 2)?;
        let auth = row.get::<_, Option<String>>(first + 3)?;
        let environment = row.get::<_, Option<String>>(first + 4)?;
        match (platform.as_str(), p256dh, auth, environment) {
            (WEB_PUSH, Some(p256dh), Some(auth), None) => Ok(Self::WebPush(WebPushTarget {
                endpoint: address,
                p256dh,
                auth,
            })),
            (APNS, None, None, Some(environment)) => ApnsEnvironment::from_stored(&environment)
                .map(|environment| {
                    Self::Apns(ApnsTarget {
                        token: address,
                        environment,
                    })
                })
                .ok_or_else(|| malformed(first + 4)),
            _ => Err(malformed(first)),
        }
    }
}

fn malformed(column: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        "stored push target has an unknown shape".into(),
    )
}

#[cfg(test)]
mod tests {
    use super::{ApnsEnvironment, ApnsTarget, PushTarget, WebPushTarget};

    fn decode(values: [Option<&str>; 5]) -> rusqlite::Result<PushTarget> {
        rusqlite::Connection::open_in_memory()
            .expect("in-memory database")
            .query_row("SELECT ?1, ?2, ?3, ?4, ?5", values, |row| {
                PushTarget::from_row(row, 0)
            })
    }

    #[test]
    fn stored_values_decode_to_the_same_target() {
        for target in [
            PushTarget::WebPush(WebPushTarget {
                endpoint: "https://web.push.apple.com/QGx3".to_owned(),
                p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ".to_owned(),
                auth: "tBHItJI5svbpez7KI4CCXg".to_owned(),
            }),
            PushTarget::Apns(ApnsTarget {
                token: "5f1c6e0b9a3d4c2e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e"
                    .to_owned(),
                environment: ApnsEnvironment::Production,
            }),
        ] {
            assert_eq!(decode(target.values()).expect("decoded target"), target);
        }
    }

    #[test]
    fn mismatched_shapes_are_rejected() {
        for values in [
            [Some("apns"), Some("token"), None, None, Some("staging")],
            [Some("apns"), Some("token"), Some("key"), Some("auth"), None],
            [
                Some("web_push"),
                Some("https://push.example/1"),
                None,
                None,
                None,
            ],
            [Some("fcm"), Some("token"), None, None, None],
        ] {
            assert!(decode(values).is_err(), "{values:?}");
        }
    }
}
