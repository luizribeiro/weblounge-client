use async_trait::async_trait;
use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier as _};
use reqwest::redirect::Policy;
use serde::Deserialize;
use url::Url;

use crate::{Error, Result};

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
#[derive(Clone, Debug)]
pub struct ConciergeClient {
    client: reqwest::Client,
    url: Url,
    secret: String,
}

impl ConciergeClient {
    /// Constructs a client with redirects disabled.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP client cannot be constructed.
    pub fn new(url: Url, secret: String) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()?;
        Ok(Self {
            client,
            url,
            secret,
        })
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
    if !audience_matches || claims.exp <= now {
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
