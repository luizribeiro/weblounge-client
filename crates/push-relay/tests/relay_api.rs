//! End-to-end HTTP behavior for device and route lifecycle.

use std::{
    io,
    net::{IpAddr, Ipv4Addr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderValue, Method, Request, StatusCode, header},
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
use tokio::sync::Notify;
use tower::ServiceExt as _;
use tracing_subscriber::fmt::MakeWriter;
use url::Url;
use weblounge_push_relay::{
    Concierge, Database, Delivery, DnsResolver, EndpointValidator, Error, Introspection,
    PushOutcome, PushSender, Result, app_with_lease_ttl,
};

const ORIGIN: &str = "https://push.weblounge.test";
const CLIENT_ORIGIN: &str = "https://beta.weblounge.test";
const FIXTURE_ACCOUNT: &str = "private-account@example.test";
type Deliveries = Arc<Mutex<Vec<(String, Vec<u8>, u32)>>>;

#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl io::Write for LogWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("log capture")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogCapture {
    type Writer = LogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(Arc::clone(&self.0))
    }
}

impl LogCapture {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().expect("log capture").clone()).expect("UTF-8 logs")
    }
}

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
                account: FIXTURE_ACCOUNT.to_owned(),
            })
        } else if session_token == "concierge-down" {
            Err(Error::ConciergeUnavailable)
        } else {
            Err(Error::Unauthorized)
        }
    }
}

#[derive(Clone)]
struct FakeSender {
    deliveries: Deliveries,
    delivered: Arc<Notify>,
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
        self.delivered.notify_waiters();
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
    temporary: TempDir,
    app: Router,
    concierge_calls: Arc<AtomicUsize>,
    deliveries: Deliveries,
    delivered: Arc<Notify>,
    outcome: Arc<Mutex<PushOutcome>>,
    unavailable: Arc<std::sync::atomic::AtomicBool>,
    subscription_key: SecretKey,
}

impl Harness {
    async fn new() -> Self {
        Self::with_lease_ttl(Duration::from_secs(75)).await
    }

    async fn with_lease_ttl(lease_ttl: Duration) -> Self {
        let temporary = tempfile::tempdir().expect("temporary state");
        let database = Database::open(temporary.path().join("relay.sqlite3"))
            .await
            .expect("database");
        let concierge_calls = Arc::new(AtomicUsize::new(0));
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let delivered = Arc::new(Notify::new());
        let outcome = Arc::new(Mutex::new(PushOutcome::Accepted));
        let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let targets = EndpointValidator::new(
            [
                "push.example",
                "fcm.googleapis.com",
                "updates.push.services.mozilla.com",
                "web.push.apple.com",
                "db5.notify.windows.com",
            ],
            Arc::new(PublicDns),
        );
        let app = app_with_lease_ttl(
            database,
            FakeConcierge {
                calls: Arc::clone(&concierge_calls),
            },
            FakeSender {
                deliveries: Arc::clone(&deliveries),
                delivered: Arc::clone(&delivered),
                outcome: Arc::clone(&outcome),
                unavailable: Arc::clone(&unavailable),
            },
            targets,
            &Url::parse(ORIGIN).expect("origin"),
            &[Url::parse(CLIENT_ORIGIN).expect("client origin")],
            lease_ttl,
        );
        Self {
            temporary,
            app,
            concierge_calls,
            deliveries,
            delivered,
            outcome,
            unavailable,
            subscription_key: SecretKey::random(&mut OsRng),
        }
    }

    async fn create_device(&self) -> Value {
        self.create_device_at("push.example").await
    }

    async fn create_device_at(&self, target_host: &str) -> Value {
        let public = self.subscription_key.public_key().to_encoded_point(false);
        let response = call_json(
            &self.app,
            Method::POST,
            "/v1/devices",
            Some("member-session"),
            json!({
                "target": {
                    "platform": "web_push",
                    "endpoint": format!("https://{target_host}/send/device"),
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

    fn seed_active_routes(&self, routes: &[&Value]) {
        let mut connection =
            rusqlite::Connection::open(self.temporary.path().join("relay.sqlite3"))
                .expect("relay database");
        let transaction = connection.transaction().expect("seed transaction");
        for route in routes {
            transaction
                .execute(
                    "UPDATE routes SET state = 'active' WHERE id = ?1",
                    [route["id"].as_str().expect("route id")],
                )
                .expect("seed active route");
        }
        transaction.commit().expect("seed commit");
    }

    async fn renew_lease(&self, device: &Value, tab_id: &str) {
        let response = call_json(
            &self.app,
            Method::POST,
            &format!("/v1/devices/{}/lease", device["id"].as_str().expect("id")),
            device["secret"].as_str(),
            json!({ "tab_id": tab_id }),
            &[],
        )
        .await;
        assert_eq!(response.0, StatusCode::NO_CONTENT);
    }

    async fn release_lease(&self, device: &Value, tab_id: &str) {
        let response = call_json(
            &self.app,
            Method::POST,
            &format!(
                "/v1/devices/{}/lease/release",
                device["id"].as_str().expect("id")
            ),
            device["secret"].as_str(),
            json!({ "tab_id": tab_id }),
            &[],
        )
        .await;
        assert_eq!(response.0, StatusCode::NO_CONTENT);
    }

    async fn push(&self, route: &Value, home: &SecretKey, body: &[u8]) -> StatusCode {
        self.push_with_urgency(route, home, body, Some("high"))
            .await
    }

    async fn push_with_urgency(
        &self,
        route: &Value,
        home: &SecretKey,
        body: &[u8],
        urgency: Option<&str>,
    ) -> StatusCode {
        self.push_with_ttl_and_urgency(route, home, body, 60, urgency)
            .await
    }

    async fn push_with_ttl(
        &self,
        route: &Value,
        home: &SecretKey,
        body: &[u8],
        ttl: u32,
    ) -> StatusCode {
        self.push_with_ttl_and_urgency(route, home, body, ttl, Some("high"))
            .await
    }

    async fn push_with_ttl_and_urgency(
        &self,
        route: &Value,
        home: &SecretKey,
        body: &[u8],
        ttl: u32,
        urgency: Option<&str>,
    ) -> StatusCode {
        let authorization = vapid(home, ORIGIN, expiry_after(3_600));
        let ttl = ttl.to_string();
        let mut headers = vec![("Authorization", authorization.as_str()), ("TTL", &ttl)];
        if let Some(urgency) = urgency {
            headers.push(("Urgency", urgency));
        }
        call_bytes(
            &self.app,
            Method::POST,
            &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
            None,
            body.to_vec(),
            &headers,
        )
        .await
    }

    async fn wait_for_deliveries(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let notified = self.delivered.notified();
                if self.deliveries.lock().expect("deliveries").len() >= count {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("held delivery deadline");
    }

    fn held_bodies(&self) -> Vec<Vec<u8>> {
        let connection = rusqlite::Connection::open(self.temporary.path().join("relay.sqlite3"))
            .expect("relay database");
        let mut statement = connection
            .prepare("SELECT body FROM held_pushes ORDER BY id")
            .expect("held push query");
        statement
            .query_map([], |row| row.get(0))
            .expect("held push rows")
            .collect::<rusqlite::Result<Vec<Vec<u8>>>>()
            .expect("held push bodies")
    }

    async fn wait_for_held_count(&self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.held_bodies().len() != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("held push count");
    }
}

#[tokio::test]
async fn operational_logs_cover_the_relay_lifecycle_without_secrets_or_payloads() {
    let logs = LogCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_target(false)
        .with_writer(logs.clone())
        .finish();
    tracing::subscriber::set_global_default(subscriber).expect("test log subscriber");

    let lifecycle = run_logged_lifecycle().await;
    assert_safe_lifecycle_logs(&logs.text(), &lifecycle);
}

struct LoggedLifecycle {
    device: Value,
    route: Value,
    converged_route: Value,
    deleted_route: Value,
}

async fn run_logged_lifecycle() -> LoggedLifecycle {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    assert_eq!(
        harness.push(&route, &home, b"secret-probe-payload").await,
        StatusCode::CREATED
    );
    harness.activate(&device, &route).await;
    assert_eq!(
        harness
            .push_with_urgency(&route, &home, b"secret-normal-payload", Some("normal"),)
            .await,
        StatusCode::CREATED
    );
    harness.renew_lease(&device, "secret-tab-id").await;
    assert_eq!(
        harness.push(&route, &home, b"secret-held-payload").await,
        StatusCode::CREATED
    );
    harness.release_lease(&device, "secret-tab-id").await;
    harness.wait_for_deliveries(1).await;
    assert_eq!(
        harness
            .push(&route, &home, b"secret-forwarded-payload")
            .await,
        StatusCode::CREATED
    );

    let wrong_home = SecretKey::random(&mut OsRng);
    assert_eq!(
        harness
            .push(&route, &wrong_home, b"secret-pin-payload")
            .await,
        StatusCode::UNAUTHORIZED
    );
    let no_jwt = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
        None,
        b"secret-jwt-payload".to_vec(),
        &[("TTL", "60")],
    )
    .await;
    assert_eq!(no_jwt, StatusCode::UNAUTHORIZED);
    let oversized = call_bytes(
        &harness.app,
        Method::POST,
        &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
        None,
        vec![b'x'; 2_801],
        &[],
    )
    .await;
    assert_eq!(oversized, StatusCode::PAYLOAD_TOO_LARGE);

    let converged_route = harness.create_route(&device, &home).await;
    harness.activate(&device, &converged_route).await;

    let deleted_route = harness.create_route(&device, &home).await;
    let deleted = call_json(
        &harness.app,
        Method::DELETE,
        &format!(
            "/v1/routes/{}",
            deleted_route["id"].as_str().expect("route id")
        ),
        device["secret"].as_str(),
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(deleted.0, StatusCode::NO_CONTENT);

    let duplicate_home = SecretKey::random(&mut OsRng);
    let duplicate_route = harness.create_route(&device, &duplicate_home).await;
    harness.activate(&device, &duplicate_route).await;
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

    *harness.outcome.lock().expect("outcome") = PushOutcome::Dead;
    assert_eq!(
        harness
            .push(&converged_route, &home, b"secret-dead-payload")
            .await,
        StatusCode::NOT_FOUND
    );
    LoggedLifecycle {
        device,
        route,
        converged_route,
        deleted_route,
    }
}

fn assert_safe_lifecycle_logs(output: &str, lifecycle: &LoggedLifecycle) {
    for event in [
        "device created",
        "route created",
        "route activated",
        "route converged",
        "route deleted",
        "route dead",
        "device has duplicate active routes",
        "lease acquired",
        "lease released",
        "action=\"probing-discard\"",
        "action=\"held\"",
        "action=\"forwarded\"",
        "action=\"dropped\"",
        "urgency=normal",
        "outcome=\"dropped\"",
        "reason=\"pin\"",
        "reason=\"jwt\"",
        "reason=\"size\"",
    ] {
        assert!(output.contains(event), "missing {event:?} in {output}");
    }
    for value in [
        lifecycle.device["secret"].as_str().expect("device secret"),
        lifecycle.device["id"].as_str().expect("device id"),
        lifecycle.route["id"].as_str().expect("route id"),
        lifecycle.converged_route["id"]
            .as_str()
            .expect("converged route id"),
        lifecycle.deleted_route["id"]
            .as_str()
            .expect("deleted route id"),
        "member-session",
        "secret-tab-id",
        "secret-probe-payload",
        "secret-held-payload",
        "secret-forwarded-payload",
        "secret-normal-payload",
        "secret-pin-payload",
        "secret-jwt-payload",
        "secret-dead-payload",
        "/send/device",
        FIXTURE_ACCOUNT,
        "8.8.8.8",
    ] {
        assert!(!output.contains(value), "log leaked {value:?}: {output}");
    }
    assert!(output.contains(&lifecycle.device["id"].as_str().expect("device id")[..8]));
    assert!(output.contains(&lifecycle.route["id"].as_str().expect("route id")[..8]));
    assert!(output.contains("superseded_route="));
}

#[tokio::test]
async fn allowed_client_preflight_reflects_the_origin_and_api_contract() {
    let harness = Harness::new().await;
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/devices")
                .header(header::ORIGIN, CLIENT_ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "authorization,content-type",
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static(CLIENT_ORIGIN))
    );
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS),
        Some(&HeaderValue::from_static("authorization,content-type"))
    );
    let methods = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .expect("allowed methods")
        .to_str()
        .expect("method header");
    assert!(methods.split(',').any(|method| method.trim() == "POST"));
    assert!(methods.split(',').any(|method| method.trim() == "PUT"));
    assert!(methods.split(',').any(|method| method.trim() == "DELETE"));
}

#[tokio::test]
async fn disallowed_client_preflight_has_no_cors_permission() {
    let harness = Harness::new().await;
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/devices")
                .header(header::ORIGIN, "https://attacker.example")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none()
    );
}

#[tokio::test]
async fn allowed_actual_client_response_reflects_origin_and_varies() {
    let harness = Harness::new().await;
    let public = harness
        .subscription_key
        .public_key()
        .to_encoded_point(false);
    let body = serde_json::to_vec(&json!({
        "target": {
            "platform": "web_push",
            "endpoint": "https://push.example/send/device",
            "p256dh": URL_SAFE_NO_PAD.encode(public.as_bytes()),
            "auth": URL_SAFE_NO_PAD.encode([7_u8; 16]),
        }
    }))
    .expect("request JSON");
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/devices")
                .header(header::ORIGIN, CLIENT_ORIGIN)
                .header(header::AUTHORIZATION, "Bearer member-session")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static(CLIENT_ORIGIN))
    );
    assert!(
        response
            .headers()
            .get_all(header::VARY)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|value| value.trim().eq_ignore_ascii_case("origin"))
    );
    assert!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            .is_none()
    );
}

#[tokio::test]
async fn public_push_ingress_never_emits_cors_headers() {
    let harness = Harness::new().await;
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/r/missing-route")
                .header(header::ORIGIN, CLIENT_ORIGIN)
                .body(Body::from("ciphertext"))
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none()
    );
    assert!(response.headers().get(header::VARY).is_none());
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
    assert_eq!(
        health.1,
        Value::String("ok\nweblounge_push_relay_duplicate_active_route_devices 0\n".to_owned())
    );

    let device = harness.create_device_at("web.push.apple.com").await;
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
async fn health_reports_devices_with_duplicate_active_routes() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let first = harness
        .create_route(&device, &SecretKey::random(&mut OsRng))
        .await;
    let second = harness
        .create_route(&device, &SecretKey::random(&mut OsRng))
        .await;
    harness.seed_active_routes(&[&first, &second]);

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
    assert_eq!(
        health.1,
        Value::String("ok\nweblounge_push_relay_duplicate_active_route_devices 1\n".to_owned())
    );
}

#[cfg(feature = "push-e2e")]
#[tokio::test]
async fn full_chain_controls_report_state_and_refuse_exactly_one_push() {
    let harness = Harness::new().await;
    let device = harness.create_device_at("web.push.apple.com").await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;

    let states = call_json(
        &harness.app,
        Method::GET,
        "/test/device-states",
        None,
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(states.0, StatusCode::OK);
    assert_eq!(states.1[0]["probing"], 1);
    assert_eq!(states.1[0]["leases"], 0);

    let refusal = call_json(
        &harness.app,
        Method::POST,
        "/test/refuse-next-push",
        None,
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(refusal.0, StatusCode::NO_CONTENT);
    assert_eq!(
        harness.push(&route, &home, b"refused probe").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        harness.push(&route, &home, b"accepted probe").await,
        StatusCode::CREATED
    );

    harness.activate(&device, &route).await;
    assert_eq!(
        harness
            .push_with_urgency(&route, &home, b"read elsewhere", Some("normal"))
            .await,
        StatusCode::CREATED
    );
    let counters = call_json(
        &harness.app,
        Method::GET,
        "/test/counters",
        None,
        Value::Null,
        &[],
    )
    .await;
    assert_eq!(counters.0, StatusCode::OK);
    assert_eq!(counters.1["normal_pushes_dropped"], 1);
}

#[tokio::test]
async fn concierge_failure_is_502_without_created_credentials_or_request_secrets() {
    let harness = Harness::new().await;
    let public = harness
        .subscription_key
        .public_key()
        .to_encoded_point(false);
    let response = call_json(
        &harness.app,
        Method::POST,
        "/v1/devices",
        Some("concierge-down"),
        json!({
            "target": {
                "platform": "web_push",
                "endpoint": "https://push.example/send/device",
                "p256dh": URL_SAFE_NO_PAD.encode(public.as_bytes()),
                "auth": "subscription-auth-secret",
            }
        }),
        &[],
    )
    .await;
    assert_eq!(response.0, StatusCode::BAD_GATEWAY);
    assert_eq!(response.1, json!({"error": "upstream unavailable"}));
    let body = response.1.to_string();
    assert!(!body.contains("concierge-down"));
    assert!(!body.contains("subscription-auth-secret"));
    assert!(response.1.get("id").is_none());
    assert!(response.1.get("secret").is_none());
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
        &[
            ("Authorization", &authorization),
            ("TTL", "604800"),
            ("Urgency", "high"),
        ],
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
async fn activation_converges_same_device_and_home_without_touching_other_routes() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let other_device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let other_home = SecretKey::random(&mut OsRng);
    let mut stale_routes = Vec::new();
    for _ in 0..3 {
        stale_routes.push(harness.create_route(&device, &home).await);
    }
    let different_home = harness.create_route(&device, &other_home).await;
    let different_device = harness.create_route(&other_device, &home).await;
    let replacement = harness.create_route(&device, &home).await;
    let mut legacy_active = stale_routes.iter().collect::<Vec<_>>();
    legacy_active.extend([&different_home, &different_device]);
    harness.seed_active_routes(&legacy_active);

    harness.activate(&device, &replacement).await;
    harness.activate(&device, &replacement).await;

    for stale in &stale_routes {
        assert_eq!(
            harness.push(stale, &home, b"stale route").await,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        harness.push(&replacement, &home, b"replacement").await,
        StatusCode::CREATED
    );
    assert_eq!(
        harness
            .push(&different_home, &other_home, b"other home")
            .await,
        StatusCode::CREATED
    );
    assert_eq!(
        harness
            .push(&different_device, &home, b"other device")
            .await,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn urgency_policy_depends_on_the_push_service() {
    let harness = Harness::new().await;
    let home = SecretKey::random(&mut OsRng);
    for (host, forwarded, dropped) in [
        (
            "web.push.apple.com",
            vec![Some("high")],
            vec![Some("normal"), Some("low"), Some("very-low"), None],
        ),
        (
            "updates.push.services.mozilla.com",
            vec![Some("high"), Some("normal"), None],
            vec![Some("low"), Some("very-low")],
        ),
        (
            "fcm.googleapis.com",
            vec![Some("high"), Some("normal"), None],
            vec![Some("low"), Some("very-low")],
        ),
        (
            "db5.notify.windows.com",
            vec![Some("high"), Some("normal"), None],
            vec![Some("low"), Some("very-low")],
        ),
    ] {
        let device = harness.create_device_at(host).await;
        let route = harness.create_route(&device, &home).await;
        harness.activate(&device, &route).await;
        let before = harness.deliveries.lock().expect("deliveries").len();
        for urgency in dropped {
            assert_eq!(
                harness
                    .push_with_urgency(&route, &home, b"dropped control event", urgency)
                    .await,
                StatusCode::CREATED
            );
        }
        assert_eq!(harness.deliveries.lock().expect("deliveries").len(), before);
        for urgency in forwarded {
            assert_eq!(
                harness
                    .push_with_urgency(&route, &home, b"forwarded event", urgency)
                    .await,
                StatusCode::CREATED
            );
        }
        assert_eq!(
            harness.deliveries.lock().expect("deliveries").len(),
            before + if host == "web.push.apple.com" { 1 } else { 3 }
        );
    }
}

#[tokio::test]
async fn account_lease_holds_another_device_push_until_expiry() {
    let harness = Harness::with_lease_ttl(Duration::from_millis(250)).await;
    let active_device = harness.create_device().await;
    let receiving_device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&receiving_device, &home).await;
    harness.activate(&receiving_device, &route).await;
    harness.renew_lease(&active_device, "active-tab").await;

    assert_eq!(
        harness.push(&route, &home, b"held until expiry").await,
        StatusCode::CREATED
    );
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());

    harness.wait_for_deliveries(1).await;
    assert_eq!(
        harness.deliveries.lock().expect("deliveries")[0].1,
        b"held until expiry"
    );
}

#[tokio::test]
async fn lease_renewal_discards_pushes_the_account_read() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.renew_lease(&device, "tab").await;
    assert_eq!(
        harness.push(&route, &home, b"read while active").await,
        StatusCode::CREATED
    );

    harness.renew_lease(&device, "tab").await;
    harness.release_lease(&device, "tab").await;
    assert_eq!(
        harness.push(&route, &home, b"after release").await,
        StatusCode::CREATED
    );
    harness.wait_for_deliveries(1).await;

    let deliveries = harness.deliveries.lock().expect("deliveries");
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].1, b"after release");
}

#[tokio::test]
async fn every_tab_must_release_before_a_held_push_is_delivered() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.renew_lease(&device, "first-tab").await;
    harness.renew_lease(&device, "second-tab").await;
    assert_eq!(
        harness.push(&route, &home, b"two tabs").await,
        StatusCode::CREATED
    );

    harness.release_lease(&device, "first-tab").await;
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());
    harness.release_lease(&device, "second-tab").await;
    harness.wait_for_deliveries(1).await;
}

#[tokio::test]
async fn beacon_form_release_delivers_without_an_authorization_header() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.renew_lease(&device, "beacon-tab").await;
    assert_eq!(
        harness.push(&route, &home, b"beacon release").await,
        StatusCode::CREATED
    );

    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("secret", device["secret"].as_str().expect("secret"))
        .append_pair("tab_id", "beacon-tab")
        .finish();
    let status = call_bytes(
        &harness.app,
        Method::POST,
        &format!(
            "/v1/devices/{}/lease/release",
            device["id"].as_str().expect("id")
        ),
        None,
        form.into_bytes(),
        &[("Content-Type", "application/x-www-form-urlencoded")],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    harness.wait_for_deliveries(1).await;
}

#[tokio::test]
async fn held_pushes_drop_the_oldest_row_at_the_account_cap() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.renew_lease(&device, "busy-tab").await;

    for index in 0..=100 {
        let body = format!("held-{index}");
        assert_eq!(
            harness.push(&route, &home, body.as_bytes()).await,
            StatusCode::CREATED
        );
    }
    let held = harness.held_bodies();
    assert_eq!(held.len(), 100);
    assert_eq!(held[0], b"held-1");
    assert_eq!(held[99], b"held-100");
}

#[tokio::test]
async fn expired_held_pushes_are_deleted_instead_of_delivered() {
    let harness = Harness::new().await;
    let device = harness.create_device().await;
    let home = SecretKey::random(&mut OsRng);
    let route = harness.create_route(&device, &home).await;
    harness.activate(&device, &route).await;
    harness.renew_lease(&device, "busy-tab").await;
    assert_eq!(
        harness
            .push_with_ttl(&route, &home, b"already expired", 0)
            .await,
        StatusCode::CREATED
    );
    harness.wait_for_held_count(0).await;
    assert!(harness.deliveries.lock().expect("deliveries").is_empty());

    harness.release_lease(&device, "busy-tab").await;
    assert_eq!(
        harness.push(&route, &home, b"delivery sentinel").await,
        StatusCode::CREATED
    );
    harness.wait_for_deliveries(1).await;

    let deliveries = harness.deliveries.lock().expect("deliveries");
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].1, b"delivery sentinel");
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
        &[
            ("Authorization", &authorization),
            ("TTL", "2419201"),
            ("Urgency", "high"),
        ],
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
        let mut headers = vec![
            ("Authorization", authorization.as_str()),
            ("Urgency", "high"),
        ];
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
    let first_home = SecretKey::random(&mut OsRng);
    let second_home = SecretKey::random(&mut OsRng);
    let first = harness.create_route(&device, &first_home).await;
    let second = harness.create_route(&device, &second_home).await;
    harness.activate(&device, &first).await;
    harness.activate(&device, &second).await;
    *harness.outcome.lock().expect("outcome") = PushOutcome::Dead;

    for (route, home) in [(&first, &first_home), (&second, &second_home)] {
        let authorization = vapid(home, ORIGIN, expiry_after(3_600));
        let status = call_bytes(
            &harness.app,
            Method::POST,
            &format!("/v1/r/{}", route["id"].as_str().expect("route id")),
            None,
            b"ciphertext".to_vec(),
            &[
                ("Authorization", &authorization),
                ("TTL", "60"),
                ("Urgency", "high"),
            ],
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
        &[
            ("Authorization", &authorization),
            ("TTL", "60"),
            ("Urgency", "high"),
        ],
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
    } else if body.starts_with(b"ok\n") {
        Value::String(String::from_utf8(body.to_vec()).expect("UTF-8 health response"))
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
