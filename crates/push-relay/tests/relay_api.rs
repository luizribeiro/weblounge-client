//! End-to-end HTTP behavior for device and route lifecycle.

use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::{
    SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer as _},
    elliptic_curve::sec1::ToEncodedPoint as _,
};
use rand_core::OsRng;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt as _;
use url::Url;
use weblounge_push_relay::{
    Concierge, Database, Delivery, DnsResolver, EndpointValidator, Error, Introspection,
    PushOutcome, PushSender, Result, app,
};

const ORIGIN: &str = "https://push.weblounge.test";
type Deliveries = Arc<Mutex<Vec<(String, Vec<u8>, u32)>>>;

#[derive(Clone)]
struct FakeConcierge {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Concierge for FakeConcierge {
    async fn introspect(&self, session_token: &str) -> Result<Introspection> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if session_token == "member-session" {
            Ok(Introspection {
                account: "mel".to_owned(),
            })
        } else {
            Err(Error::Unauthorized)
        }
    }
}

#[derive(Clone)]
struct FakeSender {
    deliveries: Deliveries,
    outcome: Arc<Mutex<PushOutcome>>,
    unavailable: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait]
impl PushSender for FakeSender {
    async fn send(&self, delivery: Delivery) -> Result<PushOutcome> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(Error::DeliveryUnavailable);
        }
        self.deliveries.lock().expect("delivery lock").push((
            delivery.route_id().to_owned(),
            delivery.body().to_vec(),
            delivery.ttl(),
        ));
        Ok(*self.outcome.lock().expect("outcome lock"))
    }
}

#[derive(Debug)]
struct PublicDns;

#[async_trait]
impl DnsResolver for PublicDns {
    async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
    }
}

struct Harness {
    _temporary: TempDir,
    app: Router,
    concierge_calls: Arc<AtomicUsize>,
    deliveries: Deliveries,
    outcome: Arc<Mutex<PushOutcome>>,
    unavailable: Arc<std::sync::atomic::AtomicBool>,
    subscription_key: SecretKey,
}

impl Harness {
    async fn new() -> Self {
        let temporary = tempfile::tempdir().expect("temporary state");
        let database = Database::open(temporary.path().join("relay.sqlite3"))
            .await
            .expect("database");
        let concierge_calls = Arc::new(AtomicUsize::new(0));
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let outcome = Arc::new(Mutex::new(PushOutcome::Accepted));
        let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let targets = EndpointValidator::new(["push.example"], Arc::new(PublicDns));
        let app = app(
            database,
            FakeConcierge {
                calls: Arc::clone(&concierge_calls),
            },
            FakeSender {
                deliveries: Arc::clone(&deliveries),
                outcome: Arc::clone(&outcome),
                unavailable: Arc::clone(&unavailable),
            },
            targets,
            &Url::parse(ORIGIN).expect("origin"),
        );
        Self {
            _temporary: temporary,
            app,
            concierge_calls,
            deliveries,
            outcome,
            unavailable,
            subscription_key: SecretKey::random(&mut OsRng),
        }
    }

    async fn create_device(&self) -> Value {
        let public = self.subscription_key.public_key().to_encoded_point(false);
        let response = call_json(
            &self.app,
            Method::POST,
            "/v1/devices",
            Some("member-session"),
            json!({
                "target": {
                    "platform": "web_push",
                    "endpoint": "https://push.example/send/device",
                    "p256dh": URL_SAFE_NO_PAD.encode(public.as_bytes()),
                    "auth": URL_SAFE_NO_PAD.encode([7_u8; 16]),
                }
            }),
            &[],
        )
        .await;
        assert_eq!(response.0, StatusCode::CREATED);
        response.1
    }

    async fn create_route(&self, device: &Value, home_key: &SecretKey) -> Value {
        let response = call_json(
            &self.app,
            Method::POST,
            &format!("/v1/devices/{}/routes", device["id"].as_str().expect("id")),
            device["secret"].as_str(),
            json!({
                "home_vapid": URL_SAFE_NO_PAD.encode(
                    home_key.public_key().to_encoded_point(false).as_bytes()
                ),
            }),
            &[],
        )
        .await;
        assert_eq!(response.0, StatusCode::CREATED);
        response.1
    }

    async fn activate(&self, device: &Value, route: &Value) {
        let response = call_json(
            &self.app,
            Method::PUT,
            &format!(
                "/v1/routes/{}/active",
                route["id"].as_str().expect("route id")
            ),
            device["secret"].as_str(),
            Value::Null,
            &[],
        )
        .await;
        assert_eq!(response.0, StatusCode::NO_CONTENT);
    }
}

#[tokio::test]
async fn health_checks_sqlite_and_device_creation_introspects_only_once() {
    let harness = Harness::new().await;
    let health = call_json(
        &harness.app,
        Method::GET,
        "/healthz",
        None,
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(health.0, StatusCode::OK);

    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    assert_eq!(harness.concierge_calls.load(Ordering::SeqCst), 1);

    let unauthorized = call_json(
        &harness.app,
        Method::POST,
        "/v1/devices",
        Some("expired-session"),
        json!({"target":{"platform":"apns","token":"later"}}),
        &[],
    )
    .await;
    assert_eq!(unauthorized.0, StatusCode::UNAUTHORIZED);
    assert_eq!(harness.concierge_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn device_secret_authorization_is_scoped_to_its_own_device() {
    let harness = Harness::new().await;
    let first = harness.create_device().await;
    let second = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let first_id = first["id"].as_str().expect("first device id");
    let second_secret = second["secret"].as_str().expect("second device secret");
    let home_vapid = URL_SAFE_NO_PAD.encode(home.public_key().to_encoded_point(false).as_bytes());

    let wrong_create = call_json(
        &harness.app,
        Method::POST,
        &format!("/v1/devices/{first_id}/routes"),
        Some(second_secret),
        json!({"home_vapid": home_vapid}),
        &[],
    )
    .await;
    assert_eq!(wrong_create.0, StatusCode::UNAUTHORIZED);
    let route = harness.create_route(&first, &home).await;
    let route_id = route["id"].as_str().expect("route id");
    let activate_path = format!("/v1/routes/{route_id}/active");

    for (bearer, headers) in [
        (Some(second_secret), Vec::new()),
        (None, Vec::new()),
        (None, vec![("Authorization", "Basic malformed")]),
        (None, vec![("Authorization", "Bearer")]),
    ] {
        let response = call_json(
            &harness.app,
            Method::PUT,
            &activate_path,
            bearer,
            Value::Null,
            &headers,
        )
        .await;
        assert_eq!(response.0, StatusCode::UNAUTHORIZED);
    }
    harness.activate(&first, &route).await;

    let wrong_delete = call_json(
        &harness.app,
        Method::DELETE,
        &format!("/v1/routes/{route_id}"),
        Some(second_secret),
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(wrong_delete.0, StatusCode::UNAUTHORIZED);
    let deleted = call_json(
        &harness.app,
        Method::DELETE,
        &format!("/v1/routes/{route_id}"),
        first["secret"].as_str(),
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(deleted.0, StatusCode::NO_CONTENT);

    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));
    let after_delete = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{route_id}"),
        None,
        b"ciphertext".to_vec(),
        &[("Authorization", &authorization), ("TTL", "60")],
    )
    .await;
    assert_eq!(after_delete, StatusCode::NOT_FOUND);
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
}

#[tokio::test]
async fn probing_discards_then_active_verifies_vapid_and_passes_ttl() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    let route_id = route["id"].as_str().expect("route id");

    let probe = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{route_id}"),
        None,
        b"registration probe".to_vec(),
        &[],
    )
    .await;
    assert_eq!(probe, StatusCode::CREATED);
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());

    harness.activate(&device, &route).await;
    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));
    let delivered = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{route_id}"),
        None,
        b"opaque encrypted body".to_vec(),
        &[("Authorization", &authorization), ("TTL", "604800")],
    )
    .await;
    assert_eq!(delivered, StatusCode::CREATED);
    assert_eq!(
        *harness.deliveries.lock().expect("deliveries"),
        vec![(
            route_id.to_owned(),
            b"opaque encrypted body".to_vec(),
            604_800,
        )]
    );
}

#[tokio::test]
async fn active_route_rejects_wrong_pin_audience_and_expiry() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    let path = format!("/v1/r/{}", route["id"].as_str().expect("route identifier"));

    let wrong_key = SecretKey::random(&mut OsRng);
    for authorization in [
        vapid(&wrong_key, ORIGIN, expiry_after(3_600)),
        vapid(&home, "https://wrong.example", expiry_after(3_600)),
        vapid(&home, ORIGIN, expiry_after(-1)),
        vapid(&home, ORIGIN, expiry_after(48 * 60 * 60)),
    ] {
        let status = call_bytes(
            &harness.app,
            Method::POST,
            &path,
            None,
            b"ciphertext".to_vec(),
            &[("Authorization", &authorization), ("TTL", "60")],
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
}

#[tokio::test]
async fn active_route_rejects_malformed_or_untrusted_vapid_jwts() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    let path = format!("/v1/r/{}", route["id"].as_str().expect("route identifier"));
    let expiry = expiry_after(3_600);
    let public = URL_SAFE_NO_PAD.encode(home.public_key().to_encoded_point(false).as_bytes());
    let valid = vapid(&home, ORIGIN, expiry);
    let four_part = valid.replacen(",k=", ".extra,k=", 1);

    let authorizations = [
        vapid_custom(&home, "none", json!(ORIGIN), expiry, None, false, None),
        vapid_custom(&home, "HS256", json!(ORIGIN), expiry, None, false, None),
        vapid_custom(&home, "ES384", json!(ORIGIN), expiry, None, false, None),
        vapid_custom(
            &home,
            "ES256",
            json!(ORIGIN),
            expiry,
            Some(json!("https://signed.example")),
            false,
            None,
        ),
        vapid_custom(&home, "ES256", json!(ORIGIN), expiry, None, true, None),
        vapid_custom(&home, "ES256", json!(ORIGIN), expiry, None, false, Some(63)),
        format!("vapid k={public}"),
        "vapid t=header.claims.signature".to_owned(),
        four_part,
        vapid_custom(&home, "ES256", json!([ORIGIN]), expiry, None, false, None),
    ];
    for authorization in &authorizations {
        let status = call_bytes(
            &harness.app,
            Method::POST,
            &path,
            None,
            b"ciphertext".to_vec(),
            &[("Authorization", authorization), ("TTL", "60")],
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let missing_authorization = call_bytes(
        &harness.app,
        Method::POST,
        &path,
        None,
        b"ciphertext".to_vec(),
        &[("TTL", "60")],
    )
    .await;
    assert_eq!(missing_authorization, StatusCode::UNAUTHORIZED);
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
}

#[tokio::test]
async fn active_route_rejects_ttl_over_28_days() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));

    let status = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
        None,
        b"ciphertext".to_vec(),
        &[("Authorization", &authorization), ("TTL", "2419201")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
}

#[tokio::test]
async fn active_route_requires_a_non_negative_numeric_ttl() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    let path = format!("/v1/r/{}", route["id"].as_str().expect("route id"));
    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));

    for ttl in [None, Some("not-a-number"), Some("-1")] {
        let mut headers = vec![("Authorization", authorization.as_str())];
        if let Some(ttl) = ttl {
            headers.push(("TTL", ttl));
        }
        let status = call_bytes(
            &harness.app,
            Method::POST,
            &path,
            None,
            b"ciphertext".to_vec(),
            &headers,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
}

#[tokio::test]
async fn dead_upstream_kills_every_device_route_and_always_maps_to_404() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let first = harness.create_route(&device, &home).await;
    let second = harness.create_route(&device, &home).await;
    harness.activate(&device, &first).await;
    harness.activate(&device, &second).await;
    *harness.outcome.lock().expect("outcome") = PushOutcome::Dead;
    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));

    for route in [&first, &second] {
        let status = call_bytes(
            &harness.app,
            Method::POST,
            &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
            None,
            b"ciphertext".to_vec(),
            &[("Authorization", &authorization), ("TTL", "60")],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    assert_eq!(harness.deliveries.lock().expect("deliveries").len(), 1);
}

#[tokio::test]
async fn delivery_target_failures_map_to_503() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.unavailable.store(true, Ordering::SeqCst);
    let authorization = vapid(&home, ORIGIN, expiry_after(3_600));

    let status = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
        None,
        b"ciphertext".to_vec(),
        &[("Authorization", &authorization), ("TTL", "60")],
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn oversized_home_body_is_413_before_route_handling() {
    let harness = Harness::new().await;
    let status = call_bytes(
        &harness.app,
        Method::POST,
        "/v1/r/not-a-route",
        None,
        vec![0_u8; 2_801],
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn chunked_body_limit_accepts_exactly_2800_bytes_and_rejects_one_more() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    let path = format!("/v1/r/{}", route["id"].as_str().expect("route id"));

    let exact = call_chunks(&harness.app, &path, [1_400, 1_400]).await;
    assert_eq!(exact, StatusCode::CREATED);
    let oversized = call_chunks(&harness.app, &path, [1_400, 1_401]).await;
    assert_eq!(oversized, StatusCode::PAYLOAD_TOO_LARGE);
}

async fn call_json(
    app: &Router,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    body: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&body).expect("request JSON")
    };
    let mut request = Request::builder().method(method).uri(path);
    if !bytes.is_empty() {
        request = request.header("Content-Type", "application/json");
    }
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(bytes)).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), 16 * 1024)
        .await
        .expect("response body");
    let value = if body.is_empty() || body.as_ref() == b"ok\n" {
        Value::Null
    } else {
        serde_json::from_slice(&body).expect("response JSON")
    };
    (status, value)
}

async fn call_bytes(
    app: &Router,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> StatusCode {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    app.clone()
        .oneshot(request.body(Body::from(body)).expect("request"))
        .await
        .expect("response")
        .status()
}

async fn call_chunks(app: &Router, path: &str, chunk_lengths: [usize; 2]) -> StatusCode {
    let chunks = chunk_lengths.map(|length| {
        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(vec![0_u8; length]))
    });
    let body = Body::from_stream(futures::stream::iter(chunks));
    app.clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(path)
                .body(body)
                .expect("request"),
        )
        .await
        .expect("response")
        .status()
}

fn vapid(key: &SecretKey, audience: &str, expiry: u64) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"aud": audience, "exp": expiry, "sub": "mailto:test@example"}))
            .expect("claims"),
    );
    let input = format!("{header}.{claims}");
    let signature: Signature = SigningKey::from(key.clone()).sign(input.as_bytes());
    let public = key.public_key().to_encoded_point(false);
    format!(
        "vapid t={input}.{},k={}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        URL_SAFE_NO_PAD.encode(public.as_bytes())
    )
}

fn vapid_custom(
    key: &SecretKey,
    algorithm: &str,
    audience: Value,
    expiry: u64,
    signed_audience: Option<Value>,
    tamper_signature: bool,
    signature_length: Option<usize>,
) -> String {
    let header = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&json!({"typ": "JWT", "alg": algorithm})).expect("header"));
    let claims = |audience| {
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(
                &json!({"aud": audience, "exp": expiry, "sub": "mailto:test@example"}),
            )
            .expect("claims"),
        )
    };
    let encoded_claims = claims(audience);
    let signed_claims = signed_audience.map_or_else(|| encoded_claims.clone(), claims);
    let signing_input = format!("{header}.{signed_claims}");
    let signature: Signature = SigningKey::from(key.clone()).sign(signing_input.as_bytes());
    let mut signature = signature.to_bytes().to_vec();
    if tamper_signature {
        signature[0] ^= 1;
    }
    if let Some(length) = signature_length {
        signature.truncate(length);
    }
    let public = key.public_key().to_encoded_point(false);
    format!(
        "vapid t={header}.{encoded_claims}.{},k={}",
        URL_SAFE_NO_PAD.encode(signature),
        URL_SAFE_NO_PAD.encode(public.as_bytes())
    )
}

fn expiry_after(seconds: i64) -> u64 {
    let now = u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp()).expect("clock");
    now.saturating_add_signed(seconds)
}
