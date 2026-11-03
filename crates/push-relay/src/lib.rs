//! HTTP API and delivery machinery for the weblounge push relay.

mod api;
mod auth;
mod config;
mod db;
mod error;
mod outbound;
#[cfg(test)]
mod test_tls;

pub use api::{App, app};
pub use auth::{Concierge, ConciergeClient, Introspection};
pub use config::{Config, DATABASE_FILE, DEFAULT_LISTEN, prepare_state_directory};
pub use db::Database;
pub use error::{Error, Result};
pub use outbound::{
    Delivery, DnsResolver, EndpointValidator, HttpTransport, OutboundRequest, PushOutcome,
    PushSender, WebPushSender,
};
