use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
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
    };
    tokio::spawn(deliver_held_pushes(state.clone()));
    let client_api = Router::new()
        .route("/v1/devices", post(create_device))
        .route("/v1/devices/{device}/routes", post(create_route))
        .route("/v1/devices/{device}/lease", post(renew_lease))
        .route("/v1/devices/{device}/lease/release", post(release_lease))
        .route("/v1/routes/{route}/active", put(activate_route))
        .route("/v1/routes/{route}", delete(delete_route))
        .layer(client_cors(allowed_origins));
    Router::new()
        .route("/healthz", get(health))
        .merge(client_api)
        .route(
            "/v1/r/{route}",
            post(receive_push).layer(DefaultBodyLimit::max(MAX_HOME_BODY)),
        )
        .with_state(state)
}

fn client_cors(allowed_origins: &[Url]) -> CorsLayer {
    let origins = allowed_origins.iter().map(|origin| {
        HeaderValue::from_str(&origin.origin().ascii_serialization())
            .expect("validated origins are HTTP header values")
    });
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

async fn health(State(state): State<AppState>) -> Result<Response> {
    state.database.health().await?;
    Ok((StatusCode::OK, "ok\n").into_response())
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
    let target = match request.target {
        PlatformTarget::WebPush {
            endpoint,
            p256dh,
            auth,
        } => {
            validate_subscription_keys(&p256dh, &auth)?;
            state.targets.validate(&endpoint).await?;
            WebPushTarget {
                endpoint: endpoint.into(),
                p256dh,
                auth,
            }
        }
        PlatformTarget::Apns { token } | PlatformTarget::Fcm { token } => {
            drop(token);
            return Err(Error::NotImplemented);
        }
    };
    let credentials = state
        .database
        .create_device(identity.account, target)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedDevice {
            id: credentials.id,
            secret: credentials.secret,
        }),
    )
        .into_response())
}

#[derive(Deserialize)]
struct CreateRoute {
    home_vapid: String,
}

#[derive(Serialize)]
struct CreatedRoute {
    id: String,
    endpoint: String,
}

async fn create_route(
    State(state): State<AppState>,
    Path(device): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateRoute>,
) -> Result<Response> {
    let secret = bearer(&headers)?.to_owned();
    let home_vapid = decode_public_key(&request.home_vapid)?;
    let route = state
        .database
        .create_route(device, secret, home_vapid)
        .await?;
    let endpoint = format!("{}/v1/r/{}", state.origin, route.id);
    Ok((
        StatusCode::CREATED,
        Json(CreatedRoute {
            id: route.id,
            endpoint,
        }),
    )
        .into_response())
}

async fn activate_route(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    state
        .database
        .activate_route(route, bearer(&headers)?.to_owned())
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_route(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    state
        .database
        .delete_route(route, bearer(&headers)?.to_owned())
        .await?;
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
            device,
            bearer(&headers)?.to_owned(),
            request.tab_id,
            now,
            now.saturating_add(lease_milliseconds),
        )
        .await?;
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
    state.database.release_lease(device, secret, tab_id).await?;
    state.delivery_wakeup.notify_one();
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn receive_push(
    State(state): State<AppState>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let route_prefix: String = route_id.chars().take(8).collect();
    let result = deliver_push(&state, route_id, &headers, &body).await;
    let status = match &result {
        Ok(response) => response.status(),
        Err(error) => error.status(),
    };
    tracing::info!(route = %route_prefix, status = status.as_u16(), "push delivery");
    result
}

async fn deliver_push(
    state: &AppState,
    route_id: String,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response> {
    match state.database.route(route_id.clone()).await? {
        Route::Probing => Ok(StatusCode::CREATED.into_response()),
        Route::Active {
            device_id,
            account,
            home_vapid,
            target,
        } => {
            verify_vapid(headers, &home_vapid, &state.origin)?;
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
                return Ok(StatusCode::CREATED.into_response());
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
                PushOutcome::Accepted => Ok(StatusCode::CREATED.into_response()),
                PushOutcome::Dead => {
                    state.database.mark_device_dead(device_id).await?;
                    Err(Error::NotFound)
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
