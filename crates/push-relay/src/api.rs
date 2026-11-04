use std::{sync::Arc, time::Duration};

#[cfg(feature = "push-e2e")]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State, rejection::BytesRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tower_http::cors::{AllowOrigin, CorsLayer};
use url::Url;

use crate::{
    Concierge, Database, Delivery, EndpointValidator, Error, PushSender, Result,
    auth::verify_vapid,
    db::{Route, WebPushTarget},
    outbound::PushOutcome,
};

const MAX_HOME_BODY: usize = 2_800;
const MAX_TTL: u32 = 28 * 24 * 60 * 60;
const LEASE_TTL: Duration = Duration::from_secs(75);

#[derive(Clone)]
struct AppState {
    database: Database,
    concierge: Arc<dyn Concierge>,
    sender: Arc<dyn PushSender>,
    targets: EndpointValidator,
    origin: String,
    lease_ttl: Duration,
    delivery_wakeup: Arc<Notify>,
    #[cfg(feature = "push-e2e")]
    refuse_next_push: Arc<AtomicBool>,
    #[cfg(feature = "push-e2e")]
    normal_pushes_dropped: Arc<AtomicUsize>,
}

/// The relay's configured HTTP application.
pub type App = Router;

/// Builds the relay API from its independently testable boundaries.
pub fn app(
    database: Database,
    concierge: impl Concierge,
    sender: impl PushSender,
    targets: EndpointValidator,
    origin: &Url,
    allowed_origins: &[Url],
) -> App {
    app_with_lease_ttl(
        database,
        concierge,
        sender,
        targets,
        origin,
        allowed_origins,
        LEASE_TTL,
    )
}

#[doc(hidden)]
pub fn app_with_lease_ttl(
    database: Database,
    concierge: impl Concierge,
    sender: impl PushSender,
    targets: EndpointValidator,
    origin: &Url,
    allowed_origins: &[Url],
    lease_ttl: Duration,
) -> App {
    let state = AppState {
        database,
        concierge: Arc::new(concierge),
        sender: Arc::new(sender),
        targets,
        origin: origin.origin().ascii_serialization(),
        lease_ttl,
        delivery_wakeup: Arc::new(Notify::new()),
        #[cfg(feature = "push-e2e")]
        refuse_next_push: Arc::new(AtomicBool::new(false)),
        #[cfg(feature = "push-e2e")]
        normal_pushes_dropped: Arc::new(AtomicUsize::new(0)),
    };
    tokio::spawn(deliver_held_pushes(state.clone()));
    let client_api = Router::new()
        .route("/v1/devices", post(create_device))
        .route("/v1/devices/{device}", delete(delete_device))
        .route("/v1/devices/{device}/target", put(update_target))
        .route("/v1/devices/{device}/routes", post(ensure_route))
        .route(
            "/v1/devices/{device}/dead-endpoints",
            get(take_dead_endpoints),
        )
        .route("/v1/devices/{device}/lease", post(renew_lease))
        .route("/v1/devices/{device}/lease/release", post(release_lease))
        .route("/v1/routes/{route}/active", put(activate_route))
        .route("/v1/routes/{route}", delete(delete_route))
        .layer(client_cors(allowed_origins));
    let router = Router::new()
        .route("/healthz", get(health))
        .merge(client_api)
        .route(
            "/v1/r/{route}",
            post(receive_push).layer(DefaultBodyLimit::max(MAX_HOME_BODY)),
        );
    #[cfg(feature = "push-e2e")]
    let router = router
        .route("/test/device-states", get(test_device_states))
        .route("/test/counters", get(test_counters))
        .route("/test/expire-leases", post(test_expire_leases))
        .route("/test/refuse-next-push", post(refuse_next_push));
    router.with_state(state)
}

fn client_cors(allowed_origins: &[Url]) -> CorsLayer {
    let origins = allowed_origins.iter().map(|origin| {
        HeaderValue::from_str(&origin.origin().ascii_serialization())
            .expect("validated origins are HTTP header values")
    });
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

async fn health(State(state): State<AppState>) -> Result<Response> {
    let duplicate_devices = state.database.health().await?;
    for duplicate in &duplicate_devices {
        tracing::warn!(
            device = %id_prefix(&duplicate.device_id),
            active_routes = duplicate.route_count,
            "device has duplicate active routes"
        );
    }
    Ok((
        StatusCode::OK,
        format!(
            "ok\nweblounge_push_relay_duplicate_active_route_devices {}\n",
            duplicate_devices.len()
        ),
    )
        .into_response())
}

#[cfg(feature = "push-e2e")]
async fn test_device_states(State(state): State<AppState>) -> Result<Response> {
    Ok(Json(state.database.test_device_states().await?).into_response())
}

#[cfg(feature = "push-e2e")]
async fn test_expire_leases(State(state): State<AppState>) -> Result<StatusCode> {
    state.database.test_expire_leases().await?;
    state.delivery_wakeup.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(feature = "push-e2e")]
async fn refuse_next_push(State(state): State<AppState>) -> StatusCode {
    state.refuse_next_push.store(true, Ordering::SeqCst);
    StatusCode::NO_CONTENT
}

#[cfg(feature = "push-e2e")]
async fn test_counters(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "normal_pushes_dropped": state.normal_pushes_dropped.load(Ordering::SeqCst),
    }))
}

#[derive(Deserialize)]
struct CreateDevice {
    target: PlatformTarget,
}

#[derive(Deserialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
enum PlatformTarget {
    WebPush {
        endpoint: Url,
        p256dh: String,
        auth: String,
    },
    Apns {
        token: String,
    },
    Fcm {
        token: String,
    },
}

#[derive(Serialize)]
struct CreatedDevice {
    id: String,
    secret: String,
}

async fn create_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateDevice>,
) -> Result<Response> {
    let session = bearer(&headers)?;
    let identity = state.concierge.introspect(session).await?;
    let target = validated_target(&state, request.target).await?;
    let credentials = state
        .database
        .create_device(identity.account, target)
        .await?;
    tracing::info!(device = %id_prefix(&credentials.id), "device created");
    Ok((
        StatusCode::CREATED,
        Json(CreatedDevice {
            id: credentials.id,
            secret: credentials.secret,
        }),
    )
        .into_response())
}

async fn validated_target(state: &AppState, target: PlatformTarget) -> Result<WebPushTarget> {
    match target {
        PlatformTarget::WebPush {
            endpoint,
            p256dh,
            auth,
        } => {
            validate_subscription_keys(&p256dh, &auth)?;
            state.targets.validate(&endpoint).await?;
            Ok(WebPushTarget {
                endpoint: endpoint.into(),
                p256dh,
                auth,
            })
        }
        PlatformTarget::Apns { token } | PlatformTarget::Fcm { token } => {
            drop(token);
            Err(Error::NotImplemented)
        }
    }
}

async fn update_target(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateDevice>,
) -> Result<Response> {
    let target = validated_target(&state, request.target).await?;
    state
        .database
        .update_target(device.clone(), bearer(&headers)?.to_owned(), target)
        .await?;
    tracing::info!(device = %id_prefix(&device), "device target updated");
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_device(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    state
        .database
        .delete_device(device.clone(), bearer(&headers)?.to_owned())
        .await?;
    tracing::info!(device = %id_prefix(&device), "device deleted");
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct CreateRoute {
    home_vapid: String,
    #[serde(default)]
    my_route_id: Option<String>,
}

#[derive(Serialize)]
struct CreatedRoute {
    id: String,
    endpoint: String,
}

async fn ensure_route(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateRoute>,
) -> Result<Response> {
    let secret = bearer(&headers)?.to_owned();
    let home_vapid = decode_public_key(&request.home_vapid)?;
    let route = state
        .database
        .ensure_route(device.clone(), secret, home_vapid, request.my_route_id)
        .await?;
    let status = if route.created {
        tracing::info!(
            route = %id_prefix(&route.id),
            device = %id_prefix(&device),
            "route created"
        );
        StatusCode::CREATED
    } else {
        tracing::info!(
            route = %id_prefix(&route.id),
            device = %id_prefix(&device),
            "route reused"
        );
        StatusCode::OK
    };
    let endpoint = format!("{}/v1/r/{}", state.origin, route.id);
    Ok((
        status,
        Json(CreatedRoute {
            id: route.id,
            endpoint,
        }),
    )
        .into_response())
}

#[derive(Serialize)]
struct DeadEndpoints {
    endpoints: Vec<String>,
}

async fn take_dead_endpoints(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let routes = state
        .database
        .take_dead_endpoints(device, bearer(&headers)?.to_owned())
        .await?;
    Ok(Json(DeadEndpoints {
        endpoints: routes
            .into_iter()
            .map(|route| format!("{}/v1/r/{route}", state.origin))
            .collect(),
    })
    .into_response())
}

async fn activate_route(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let superseded = state
        .database
        .activate_route(route.clone(), bearer(&headers)?.to_owned())
        .await?;
    for superseded_route in superseded {
        tracing::info!(
            route = %id_prefix(&route),
            superseded_route = %id_prefix(&superseded_route),
            "route converged"
        );
    }
    tracing::info!(route = %id_prefix(&route), "route activated");
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_route(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    state
        .database
        .delete_route(route.clone(), bearer(&headers)?.to_owned())
        .await?;
    tracing::info!(route = %id_prefix(&route), "route deleted");
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct LeaseRequest {
    tab_id: String,
}

async fn renew_lease(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
    Json(request): Json<LeaseRequest>,
) -> Result<Response> {
    validate_tab_id(&request.tab_id)?;
    let now = unix_milliseconds();
    let lease_milliseconds = i64::try_from(state.lease_ttl.as_millis())
        .map_err(|_| Error::Config("lease TTL is too large".to_owned()))?;
    state
        .database
        .renew_lease(
            device.clone(),
            bearer(&headers)?.to_owned(),
            request.tab_id,
            now,
            now.saturating_add(lease_milliseconds),
        )
        .await?;
    tracing::info!(device = %id_prefix(&device), "lease acquired");
    state.delivery_wakeup.notify_one();
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn release_lease(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let (secret, tab_id) = if let Ok(secret) = bearer(&headers) {
        let request: LeaseRequest = serde_json::from_slice(&body)
            .map_err(|_| Error::BadRequest("invalid lease release".to_owned()))?;
        (secret.to_owned(), request.tab_id)
    } else {
        beacon_release(&body)?
    };
    validate_tab_id(&tab_id)?;
    state
        .database
        .release_lease(device.clone(), secret, tab_id)
        .await?;
    tracing::info!(device = %id_prefix(&device), "lease released");
    state.delivery_wakeup.notify_one();
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn receive_push(
    State(state): State<AppState>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, BytesRejection>,
) -> Response {
    let route_prefix = id_prefix(&route_id);
    #[cfg(feature = "push-e2e")]
    if state.refuse_next_push.swap(false, Ordering::SeqCst) {
        tracing::info!(route = %route_prefix, reason = "test-refusal", "inbound push");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let body = match body {
        Ok(body) => body,
        Err(rejection) => {
            let reason = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "size"
            } else {
                "body"
            };
            tracing::info!(route = %route_prefix, action = "rejected", reason, "inbound push");
            return rejection.into_response();
        }
    };
    match deliver_push(&state, route_id, &headers, &body).await {
        Ok(PushDisposition::ProbingDiscard) => {
            tracing::info!(
                route = %route_prefix,
                action = "probing-discard",
                outcome = "discarded",
                "inbound push"
            );
            StatusCode::CREATED.into_response()
        }
        Ok(PushDisposition::UrgencyDropped { urgency }) => {
            #[cfg(feature = "push-e2e")]
            if matches!(urgency, Urgency::Normal) {
                state.normal_pushes_dropped.fetch_add(1, Ordering::SeqCst);
            }
            tracing::info!(
                route = %route_prefix,
                urgency = %urgency,
                action = "dropped",
                outcome = "dropped",
                reason = "urgency",
                "inbound push"
            );
            StatusCode::CREATED.into_response()
        }
        Ok(PushDisposition::Held { urgency }) => {
            tracing::info!(
                route = %route_prefix,
                urgency = %urgency,
                action = "held",
                outcome = "held",
                "inbound push"
            );
            StatusCode::CREATED.into_response()
        }
        Ok(PushDisposition::Forwarded { urgency }) => {
            tracing::info!(
                route = %route_prefix,
                urgency = %urgency,
                action = "forwarded",
                outcome = "forwarded",
                "inbound push"
            );
            StatusCode::CREATED.into_response()
        }
        Ok(PushDisposition::TargetDead { device_id, urgency }) => {
            tracing::info!(
                route = %route_prefix,
                device = %id_prefix(&device_id),
                "route dead"
            );
            tracing::info!(
                route = %route_prefix,
                urgency = %urgency,
                action = "rejected",
                outcome = "target-dead",
                reason = "target-dead",
                "inbound push"
            );
            Error::NotFound.into_response()
        }
        Err(error) => {
            tracing::info!(
                route = %route_prefix,
                action = "rejected",
                reason = error.inbound_reason(),
                "inbound push"
            );
            error.into_response()
        }
    }
}

enum PushDisposition {
    ProbingDiscard,
    UrgencyDropped { urgency: Urgency },
    Held { urgency: Urgency },
    Forwarded { urgency: Urgency },
    TargetDead { device_id: String, urgency: Urgency },
}

#[derive(Clone, Copy)]
enum TargetKind {
    AppleWebPush,
    OtherWebPush,
}

impl TargetKind {
    fn for_web_push(target: &WebPushTarget) -> Result<Self> {
        let endpoint = Url::parse(&target.endpoint).map_err(|_| Error::DeliveryUnavailable)?;
        Ok(if endpoint.host_str() == Some("web.push.apple.com") {
            Self::AppleWebPush
        } else {
            Self::OtherWebPush
        })
    }
}

#[derive(Clone, Copy)]
enum Urgency {
    VeryLow,
    Low,
    Normal,
    High,
}

impl Urgency {
    fn from_headers(headers: &HeaderMap) -> Result<Self> {
        let Some(value) = headers.get("Urgency") else {
            return Ok(Self::Normal);
        };
        match value.to_str().ok() {
            Some("very-low") => Ok(Self::VeryLow),
            Some("low") => Ok(Self::Low),
            Some("normal") => Ok(Self::Normal),
            Some("high") => Ok(Self::High),
            _ => Err(Error::BadRequest("invalid Urgency header".to_owned())),
        }
    }

    fn is_deliverable_to(self, target: TargetKind) -> bool {
        match target {
            TargetKind::AppleWebPush => matches!(self, Self::High),
            TargetKind::OtherWebPush => matches!(self, Self::Normal | Self::High),
        }
    }
}

impl std::fmt::Display for Urgency {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::VeryLow => "very-low",
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
        })
    }
}

async fn deliver_push(
    state: &AppState,
    route_id: String,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<PushDisposition> {
    match state.database.route(route_id.clone()).await? {
        Route::Probing => Ok(PushDisposition::ProbingDiscard),
        Route::Active {
            device_id,
            account,
            home_vapid,
            target,
        } => {
            verify_vapid(headers, &home_vapid, &state.origin)?;
            let urgency = Urgency::from_headers(headers)?;
            if !urgency.is_deliverable_to(TargetKind::for_web_push(&target)?) {
                return Ok(PushDisposition::UrgencyDropped { urgency });
            }
            let ttl = headers
                .get("TTL")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| Error::BadRequest("TTL must be an unsigned integer".to_owned()))?;
            if ttl > MAX_TTL {
                return Err(Error::BadRequest("TTL must not exceed 28 days".to_owned()));
            }
            if state
                .database
                .hold_if_leased(
                    account,
                    route_id.clone(),
                    body.to_vec(),
                    ttl,
                    unix_milliseconds(),
                )
                .await?
            {
                state.delivery_wakeup.notify_one();
                return Ok(PushDisposition::Held { urgency });
            }
            let outcome = state
                .sender
                .send(Delivery {
                    route_id,
                    target,
                    body: body.to_vec(),
                    ttl,
                })
                .await?;
            match outcome {
                PushOutcome::Accepted => Ok(PushDisposition::Forwarded { urgency }),
                PushOutcome::Dead => {
                    state.database.mark_device_dead(device_id.clone()).await?;
                    Ok(PushDisposition::TargetDead { device_id, urgency })
                }
            }
        }
    }
}

async fn deliver_held_pushes(state: AppState) {
    loop {
        let notified = state.delivery_wakeup.notified();
        let now = unix_milliseconds();
        match state.database.next_held(now).await {
            Ok(Some(held)) => {
                let route_prefix = id_prefix(&held.route_id);
                let device_prefix = id_prefix(&held.device_id);
                let outcome = state
                    .sender
                    .send(Delivery {
                        route_id: held.route_id,
                        target: held.target,
                        body: held.body,
                        ttl: held.ttl,
                    })
                    .await;
                match outcome {
                    Ok(PushOutcome::Accepted) => {
                        let _ = state.database.delete_held(held.id).await;
                    }
                    Ok(PushOutcome::Dead) => {
                        tracing::info!(
                            route = %route_prefix,
                            device = %device_prefix,
                            "route dead"
                        );
                        let _ = state.database.mark_device_dead(held.device_id).await;
                        let _ = state.database.delete_held(held.id).await;
                    }
                    Err(_) => {
                        tokio::select! {
                            () = tokio::time::sleep(Duration::from_secs(1)) => {}
                            () = notified => {}
                        }
                    }
                }
                continue;
            }
            Ok(None) => {}
            Err(_) => {
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    () = notified => {}
                }
                continue;
            }
        }
        match state.database.next_held_deadline(now).await {
            Ok(Some(deadline)) => {
                let wait = u64::try_from(deadline.saturating_sub(now)).unwrap_or_default();
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(wait)) => {}
                    () = notified => {}
                }
            }
            Ok(None) => notified.await,
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

fn beacon_release(body: &[u8]) -> Result<(String, String)> {
    let fields = url::form_urlencoded::parse(body)
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    let secret = fields
        .get("secret")
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or(Error::Unauthorized)?;
    let tab_id = fields
        .get("tab_id")
        .cloned()
        .ok_or_else(|| Error::BadRequest("missing tab id".to_owned()))?;
    Ok((secret, tab_id))
}

fn validate_tab_id(tab_id: &str) -> Result<()> {
    if tab_id.is_empty() || tab_id.len() > 128 {
        Err(Error::BadRequest("invalid tab id".to_owned()))
    } else {
        Ok(())
    }
}

fn unix_milliseconds() -> i64 {
    let now = time::OffsetDateTime::now_utc();
    now.unix_timestamp()
        .saturating_mul(1_000)
        .saturating_add(i64::from(now.millisecond()))
}

fn id_prefix(id: &str) -> String {
    id.chars().take(8).collect()
}

fn bearer(headers: &HeaderMap) -> Result<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(Error::Unauthorized)
}

fn decode_public_key(encoded: &str) -> Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Error::BadRequest("VAPID key is not base64url".to_owned()))?;
    if bytes.len() != 65 || bytes.first() != Some(&4) {
        return Err(Error::BadRequest(
            "VAPID key must be an uncompressed P-256 public key".to_owned(),
        ));
    }
    PublicKey::from_sec1_bytes(&bytes)
        .map_err(|_| Error::BadRequest("VAPID key is not a P-256 public key".to_owned()))?;
    Ok(bytes)
}

fn validate_subscription_keys(p256dh: &str, auth: &str) -> Result<()> {
    decode_public_key(p256dh)?;
    let auth = URL_SAFE_NO_PAD
        .decode(auth)
        .map_err(|_| Error::BadRequest("subscription auth is not base64url".to_owned()))?;
    if auth.len() != 16 {
        return Err(Error::BadRequest(
            "subscription auth must contain 16 bytes".to_owned(),
        ));
    }
    Ok(())
}
