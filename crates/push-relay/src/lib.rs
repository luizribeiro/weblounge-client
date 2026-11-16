//! HTTP API and delivery machinery for the weblounge push relay.

mod api;
mod apns;
mod auth;
mod config;
mod db;
mod error;
mod jwt;
mod outbound;
mod platform_sender;
mod target;
#[cfg(test)]
mod test_apns;
#[cfg(test)]
mod test_tls;

pub use api::{App, app, app_with_lease_ttl};
pub use apns::{ApnsCredentials, ApnsSender};
pub use auth::{Concierge, ConciergeClient, Introspection};
pub use config::{Config, DATABASE_FILE, DEFAULT_LISTEN, prepare_state_directory};
pub use db::Database;
pub use error::{Error, Result};
pub use outbound::{
    Delivery, DnsResolver, EndpointValidator, HttpTransport, OutboundRequest, PushOutcome,
    PushSender, Urgency, WebPushSender,
};
pub use platform_sender::PlatformSender;
pub use target::ApnsEnvironment;
