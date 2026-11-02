use async_trait::async_trait;
use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier as _};
#[cfg(test)]
use reqwest::Certificate;
use reqwest::redirect::Policy;
use serde::Deserialize;
use std::time::Duration;
use url::Url;

use crate::{Error, Result};

const CONCIERGE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_VAPID_LIFETIME_SECONDS: u64 = 24 * 60 * 60;

/// The member identity returned by concierge for an active session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Introspection {
    /// Stable concierge account name.
    pub account: String,
}

/// Entitlement boundary used only while a device is being created.
#[async_trait]
pub trait Concierge: Send + Sync + 'static {
    /// Returns the account for an active member session.
    async fn introspect(&self, session_token: &str) -> Result<Introspection>;
}

/// RFC 7662 client for concierge's loopback-only endpoint.
#[derive(Clone)]
pub struct ConciergeClient {
    client: reqwest::Client,
    url: Url,
    secret: String,
}

impl std::fmt::Debug for ConciergeClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConciergeClient")
            .field("url", &self.url)
            .field("secret", &"[redacted]")
            .finish_non_exhaustive()
    }
}

impl ConciergeClient {
    /// Constructs a client with redirects disabled.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP client cannot be constructed.
    pub fn new(url: Url, secret: String) -> Result<Self> {
        Self::with_client_builder(url, secret, reqwest::Client::builder(), CONCIERGE_TIMEOUT)
    }

    fn with_client_builder(
        url: Url,
        secret: String,
        builder: reqwest::ClientBuilder,
        timeout: Duration,
    ) -> Result<Self> {
        let client = builder
            .no_proxy()
            .redirect(Policy::none())
            .timeout(timeout)
            .build()?;
        Ok(Self {
            client,
            url,
            secret,
        })
    }

    #[cfg(test)]
    fn with_root_certificate(url: Url, secret: String, root: Certificate) -> Result<Self> {
        Self::with_client_builder(
            url,
            secret,
            reqwest::Client::builder().add_root_certificate(root),
            CONCIERGE_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn with_timeout(url: Url, secret: String, timeout: Duration) -> Result<Self> {
        Self::with_client_builder(url, secret, reqwest::Client::builder(), timeout)
    }
}

#[derive(Deserialize)]
struct IntrospectionResponse {
    active: bool,
    username: Option<String>,
}

#[async_trait]
impl Concierge for ConciergeClient {
    async fn introspect(&self, session_token: &str) -> Result<Introspection> {
        let response = self
            .client
            .post(self.url.clone())
            .basic_auth("push-relay", Some(&self.secret))
            .form(&[("token", session_token)])
            .send()
            .await
            .map_err(|_| Error::ConciergeUnavailable)?;
        if !response.status().is_success() {
            return Err(Error::ConciergeUnavailable);
        }
        let answer: IntrospectionResponse = response
            .json()
            .await
            .map_err(|_| Error::ConciergeUnavailable)?;
        match (answer.active, answer.username) {
            (true, Some(account)) if !account.is_empty() => Ok(Introspection { account }),
            _ => Err(Error::Unauthorized),
        }
    }
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
}

#[derive(Deserialize)]
struct JwtClaims {
    aud: Audience,
    exp: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

pub(crate) fn verify_vapid(
    headers: &HeaderMap,
    pinned_key: &[u8],
    expected_audience: &str,
) -> Result<()> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(Error::Unauthorized)?;
    let (token, supplied_key) = parse_vapid_authorization(authorization)?;
    let supplied_key = URL_SAFE_NO_PAD
        .decode(supplied_key)
        .map_err(|_| Error::Unauthorized)?;
    if supplied_key != pinned_key {
        return Err(Error::Unauthorized);
    }

    let mut parts = token.split('.');
    let encoded_header = parts.next().ok_or(Error::Unauthorized)?;
    let encoded_claims = parts.next().ok_or(Error::Unauthorized)?;
    let encoded_signature = parts.next().ok_or(Error::Unauthorized)?;
    if parts.next().is_some() {
        return Err(Error::Unauthorized);
    }
    let jwt_header: JwtHeader = decode_json(encoded_header)?;
    if jwt_header.alg != "ES256" {
        return Err(Error::Unauthorized);
    }
    let claims: JwtClaims = decode_json(encoded_claims)?;
    let audience_matches = match claims.aud {
        Audience::One(audience) => audience == expected_audience,
        Audience::Many(audiences) => audiences
            .iter()
            .any(|audience| audience == expected_audience),
    };
    let now = u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp())
        .map_err(|_| Error::Unauthorized)?;
    if !audience_matches
        || claims.exp <= now
        || claims.exp > now.saturating_add(MAX_VAPID_LIFETIME_SECONDS)
    {
        return Err(Error::Unauthorized);
    }

    let signature_bytes = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| Error::Unauthorized)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| Error::Unauthorized)?;
    let key = VerifyingKey::from_sec1_bytes(pinned_key).map_err(|_| Error::Unauthorized)?;
    key.verify(
        format!("{encoded_header}.{encoded_claims}").as_bytes(),
        &signature,
    )
    .map_err(|_| Error::Unauthorized)
}

fn decode_json<T: for<'de> Deserialize<'de>>(encoded: &str) -> Result<T> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Error::Unauthorized)?;
    serde_json::from_slice(&bytes).map_err(|_| Error::Unauthorized)
}

fn parse_vapid_authorization(value: &str) -> Result<(&str, &str)> {
    let (scheme, parameters) = value.split_once(' ').ok_or(Error::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("vapid") {
        return Err(Error::Unauthorized);
    }
    let mut token = None;
    let mut key = None;
    for parameter in parameters.split(',').map(str::trim) {
        if let Some(value) = parameter.strip_prefix("t=") {
            token = Some(value);
        } else if let Some(value) = parameter.strip_prefix("k=") {
            key = Some(value);
        }
    }
    match (token, key) {
        (Some(token), Some(key)) if !token.is_empty() && !key.is_empty() => Ok((token, key)),
        _ => Err(Error::Unauthorized),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::{Router, routing::post};
    use reqwest::Certificate;
    use url::Url;

    use super::{Concierge as _, ConciergeClient};
    use crate::test_tls::TlsServer;

    #[tokio::test]
    async fn concierge_ignores_https_proxy() {
        let server = TlsServer::start(
            "127.0.0.1",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 32\r\n\r\n{\"active\":true,\"username\":\"mel\"}",
        )
        .await;
        let root = Certificate::from_der(server.certificate()).expect("test root");
        let client = ConciergeClient::with_root_certificate(
            Url::parse(&format!("https://127.0.0.1:{}/introspect", server.port())).expect("URL"),
            "concierge-secret".to_owned(),
            root,
        )
        .expect("client");

        temp_env::async_with_vars([("HTTPS_PROXY", Some("http://127.0.0.1:9"))], async {
            let identity =
                tokio::time::timeout(Duration::from_secs(2), client.introspect("member-session"))
                    .await
                    .expect("request completed")
                    .expect("introspection succeeded");
            assert_eq!(identity.account, "mel");
        })
        .await;
        assert_eq!(server.requests(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn concierge_has_a_bounded_request_timeout() {
        let router = Router::new().route(
            "/introspect",
            post(|| async { std::future::pending::<axum::http::StatusCode>().await }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let client = ConciergeClient::with_timeout(
            Url::parse(&format!("http://{address}/introspect")).expect("URL"),
            "secret".to_owned(),
            Duration::from_secs(5),
        )
        .expect("client");

        let result = client.introspect("session").await;
        assert!(matches!(result, Err(crate::Error::ConciergeUnavailable)));
        server.abort();
    }

    #[test]
    fn concierge_debug_redacts_the_secret() {
        let client = ConciergeClient::new(
            Url::parse("http://127.0.0.1/introspect").expect("URL"),
            "should-never-appear".to_owned(),
        )
        .expect("client");
        let debug = format!("{client:?}");
        assert!(!debug.contains("should-never-appear"));
        assert!(debug.contains("[redacted]"));
    }
}
