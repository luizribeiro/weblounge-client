use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::ffi::ErrorCode;
use serde_json::json;

/// Errors produced while configuring or serving the relay.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Invalid process configuration.
    #[error("invalid configuration: {0}")]
    Config(String),
    /// A filesystem operation failed.
    #[error("filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    /// SQLite rejected an operation.
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    /// A blocking database task could not finish.
    #[error("database task failed: {0}")]
    DatabaseTask(#[from] tokio::task::JoinError),
    /// An HTTP client operation failed.
    #[error("outbound HTTP failed: {0}")]
    Http(#[from] reqwest::Error),
    /// Web Push encryption or signing failed.
    #[error("Web Push preparation failed: {0}")]
    Crypto(String),
    /// A request was not authenticated.
    #[error("authentication failed")]
    Unauthorized,
    /// An inbound VAPID JWT was absent, malformed, expired, or invalid.
    #[error("VAPID JWT verification failed")]
    VapidJwt,
    /// An inbound VAPID key did not match the route's pinned key.
    #[error("VAPID key does not match the route pin")]
    VapidPin,
    /// A requested object does not exist or is dead.
    #[error("not found")]
    NotFound,
    /// A device existed, but its delivery target or ownership has been retired.
    #[error("device is gone")]
    Gone,
    /// The request is syntactically or semantically invalid.
    #[error("invalid request: {0}")]
    BadRequest(String),
    /// The account or device reached a persistent-object limit.
    #[error("capacity limit reached")]
    Capacity,
    /// A recognized platform target belongs to a later relay slice.
    #[error("platform target is not implemented")]
    NotImplemented,
    /// Concierge could not decide whether the session is active.
    #[error("concierge introspection failed")]
    ConciergeUnavailable,
    /// The target is not a permitted public push-service endpoint.
    #[error("push target refused: {0}")]
    TargetRefused(String),
    /// The push service failed without declaring the subscription dead.
    #[error("push service failed")]
    PushServiceUnavailable,
    /// A previously registered delivery target cannot currently be validated or reached.
    #[error("delivery target is unavailable")]
    DeliveryUnavailable,
}

/// Relay result alias.
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Self::Unauthorized | Self::VapidJwt | Self::VapidPin => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Gone => StatusCode::GONE,
            Self::BadRequest(_) | Self::TargetRefused(_) => StatusCode::BAD_REQUEST,
            Self::Capacity => StatusCode::CONFLICT,
            Self::NotImplemented => StatusCode::NOT_IMPLEMENTED,
            Self::ConciergeUnavailable
            | Self::PushServiceUnavailable
            | Self::Http(_)
            | Self::Crypto(_) => StatusCode::BAD_GATEWAY,
            Self::DeliveryUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Database(error) if database_is_busy(error) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Config(_) | Self::Io(_) | Self::Database(_) | Self::DatabaseTask(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    pub(crate) fn inbound_reason(&self) -> &'static str {
        match self {
            Self::VapidJwt => "jwt",
            Self::VapidPin => "pin",
            Self::NotFound => "route",
            Self::Gone => "device",
            Self::BadRequest(_) => "request",
            Self::PushServiceUnavailable | Self::DeliveryUnavailable | Self::Http(_) => "upstream",
            Self::Unauthorized => "authorization",
            Self::Config(_)
            | Self::Io(_)
            | Self::Database(_)
            | Self::DatabaseTask(_)
            | Self::Crypto(_) => "internal",
            Self::Capacity => "capacity",
            Self::NotImplemented => "platform",
            Self::ConciergeUnavailable => "concierge",
            Self::TargetRefused(_) => "target",
        }
    }

    pub(crate) fn warn_if_internal(&self) {
        if matches!(
            self,
            Self::Config(_) | Self::Io(_) | Self::Database(_) | Self::DatabaseTask(_)
        ) {
            tracing::warn!(error = %self, "internal relay error");
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status();
        let retry_database = matches!(&self, Self::Database(error) if database_is_busy(error));
        self.warn_if_internal();
        let message = match status {
            StatusCode::UNAUTHORIZED => "unauthorized",
            StatusCode::NOT_FOUND => "not found",
            StatusCode::GONE => "device gone",
            StatusCode::BAD_REQUEST => "invalid request",
            StatusCode::CONFLICT => "capacity limit reached",
            StatusCode::NOT_IMPLEMENTED => "platform target not implemented",
            StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE => "upstream unavailable",
            _ => "internal error",
        };
        let mut response = (status, Json(json!({ "error": message }))).into_response();
        if retry_database {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}

fn database_is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

#[cfg(test)]
mod tests {
    use super::Error;
    use axum::{http::StatusCode, response::IntoResponse as _};

    #[test]
    fn busy_database_errors_are_retryable() {
        let sqlite = rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY);
        let response =
            Error::Database(rusqlite::Error::SqliteFailure(sqlite, None)).into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()["Retry-After"], "1");
    }
}
