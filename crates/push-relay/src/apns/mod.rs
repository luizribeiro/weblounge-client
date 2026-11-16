#[cfg(test)]
mod tests;
mod token;

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::{SecretKey, ecdsa::SigningKey, pkcs8::DecodePrivateKey as _};
use reqwest::{StatusCode, header::CONTENT_TYPE, redirect::Policy};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    ApnsSettings, Delivery, Error, PushOutcome, PushSender, Result,
    jwt::unix_seconds,
    outbound::{log_upstream_delivery, upstream_error},
    target::{ApnsEnvironment, ApnsEnvironments, PushTarget},
};
use token::ProviderTokens;

const DELIVERY_TIMEOUT: Duration = Duration::from_secs(15);

/// The relay's APNs provider identity, from the developer portal's "Keys" page.
#[derive(Clone, Debug)]
pub struct ApnsCredentials {
    /// The `.p8` file's PKCS #8 PEM text.
    pub key_pem: Vec<u8>,
    /// The ten-character key identifier.
    pub key_id: String,
    /// The ten-character team identifier.
    pub team_id: String,
    /// The app's bundle identifier, sent as `apns-topic`.
    pub topic: String,
}

/// Sends opaque home pushes to APNs over HTTP/2 with a cached provider token.
#[derive(Clone, Debug)]
pub struct ApnsSender {
    topic: Arc<str>,
    tokens: Arc<ProviderTokens>,
    hosts: Arc<ApnsEnvironments<Url>>,
    client: reqwest::Client,
}

#[derive(Serialize)]
struct Payload<'a> {
    aps: Aps,
    r: &'a str,
    c: String,
}

#[derive(Serialize)]
struct Aps {
    alert: Alert,
    #[serde(rename = "mutable-content")]
    mutable_content: u8,
    sound: &'static str,
}

#[derive(Serialize)]
struct Alert {
    title: &'static str,
    body: &'static str,
}

#[derive(Deserialize)]
struct Rejection {
    reason: String,
}

impl ApnsSender {
    /// Parses the provider key up front and constructs the sender for Apple's hosts.
    ///
    /// # Errors
    ///
    /// Returns an error when the key is not a PKCS #8 P-256 private key.
    pub fn new(credentials: ApnsCredentials) -> Result<Self> {
        let hosts = ApnsEnvironments {
            production: apple_host("https://api.push.apple.com/")?,
            sandbox: apple_host("https://api.sandbox.push.apple.com/")?,
        };
        Self::with_client(credentials, hosts, client_builder())
    }

    /// Reads the configured `.p8` key and constructs the sender.
    ///
    /// # Errors
    ///
    /// Returns an error when the key file is unreadable or not a P-256 PKCS #8 key.
    pub async fn from_settings(settings: ApnsSettings<'_>) -> Result<Self> {
        let sender = Self::new(ApnsCredentials {
            key_pem: tokio::fs::read(settings.key_file).await?,
            key_id: settings.key_id.to_owned(),
            team_id: settings.team_id.to_owned(),
            topic: settings.topic.to_owned(),
        })?;
        tracing::info!(topic = settings.topic, "APNs delivery enabled");
        Ok(sender)
    }

    fn with_client(
        credentials: ApnsCredentials,
        hosts: ApnsEnvironments<Url>,
        client: reqwest::ClientBuilder,
    ) -> Result<Self> {
        let pem = std::str::from_utf8(&credentials.key_pem)
            .map_err(|_| Error::Config("APNs key is not PEM text".to_owned()))?;
        let key = SecretKey::from_pkcs8_pem(pem)
            .map_err(|_| Error::Config("APNs key is not a P-256 PKCS #8 key".to_owned()))?;
        Ok(Self {
            topic: credentials.topic.into(),
            tokens: Arc::new(ProviderTokens::new(
                SigningKey::from(key),
                credentials.key_id,
                credentials.team_id,
            )),
            hosts: Arc::new(hosts),
            client: client.build()?,
        })
    }

    fn device_url(&self, environment: ApnsEnvironment, token: &str) -> Result<Url> {
        let host = self.hosts.get(environment);
        if !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::DeliveryUnavailable);
        }
        host.join(&format!("3/device/{token}"))
            .map_err(|_| Error::DeliveryUnavailable)
    }

    async fn post(&self, url: Url, delivery: &Delivery) -> Result<reqwest::Response> {
        self.client
            .post(url)
            .header(
                "authorization",
                format!("bearer {}", self.tokens.current()?),
            )
            .header("apns-topic", &*self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header(
                "apns-expiration",
                (unix_seconds()? + u64::from(delivery.ttl)).to_string(),
            )
            .header(CONTENT_TYPE, "application/json")
            .body(payload(delivery)?)
            .send()
            .await
            .map_err(upstream_error)
    }
}

async fn rejection_reason(response: reqwest::Response) -> Option<String> {
    response
        .json::<Rejection>()
        .await
        .ok()
        .map(|rejection| rejection.reason)
}

fn apple_host(url: &str) -> Result<Url> {
    Url::parse(url).map_err(|error| Error::Config(format!("invalid APNs host: {error}")))
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .https_only(true)
        .http2_prior_knowledge()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(DELIVERY_TIMEOUT)
}

fn payload(delivery: &Delivery) -> Result<Vec<u8>> {
    serde_json::to_vec(&Payload {
        aps: Aps {
            alert: Alert {
                title: "weblounge",
                body: "New message",
            },
            mutable_content: 1,
            sound: "default",
        },
        r: &delivery.route_id,
        c: URL_SAFE_NO_PAD.encode(&delivery.body),
    })
    .map_err(|error| Error::BadRequest(error.to_string()))
}

fn rejects_provider_token(status: StatusCode, reason: Option<&str>) -> bool {
    status == StatusCode::FORBIDDEN
        && matches!(
            reason,
            Some("ExpiredProviderToken" | "InvalidProviderToken")
        )
}

fn outcome(status: StatusCode, reason: Option<&str>) -> Result<PushOutcome> {
    match (status, reason) {
        (status, _) if status.is_success() => Ok(PushOutcome::Accepted),
        (StatusCode::GONE, _) | (StatusCode::BAD_REQUEST, Some("BadDeviceToken")) => {
            Ok(PushOutcome::Dead)
        }
        _ => Err(Error::PushServiceUnavailable),
    }
}

#[async_trait]
impl PushSender for ApnsSender {
    async fn send(&self, delivery: Delivery) -> Result<PushOutcome> {
        let PushTarget::Apns(target) = &delivery.target else {
            return Err(Error::DeliveryUnavailable);
        };
        let url = self.device_url(target.environment, &target.token)?;
        let target_host = url.host_str().unwrap_or_default().to_owned();
        let response = self.post(url, &delivery).await?;
        let status = response.status();
        let reason = if status.is_success() {
            None
        } else {
            rejection_reason(response).await
        };
        if rejects_provider_token(status, reason.as_deref()) {
            self.tokens.invalidate();
        }
        let outcome = outcome(status, reason.as_deref());
        log_upstream_delivery(&target_host, status, reason.as_deref(), &outcome);
        outcome
    }

    fn delivers_apns(&self) -> bool {
        true
    }
}
