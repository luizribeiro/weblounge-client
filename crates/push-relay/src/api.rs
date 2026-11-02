use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    Concierge, Database, Delivery, EndpointValidator, Error, PushSender, Result,
    auth::verify_vapid,
    db::{Route, WebPushTarget},
    outbound::PushOutcome,
};

const MAX_HOME_BODY: usize = 2_800;

#[derive(Clone)]
struct AppState {
    database: Database,
    concierge: Arc<dyn Concierge>,
    sender: Arc<dyn PushSender>,
    targets: EndpointValidator,
    origin: String,
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
) -> App {
    let state = AppState {
        database,
        concierge: Arc::new(concierge),
        sender: Arc::new(sender),
        targets,
        origin: origin.origin().ascii_serialization(),
    };
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/devices", post(create_device))
        .route("/v1/devices/{device}/routes", post(create_route))
        .route("/v1/routes/{route}/active", put(activate_route))
        .route("/v1/routes/{route}", delete(delete_route))
        .route(
            "/v1/r/{route}",
            post(receive_push).layer(DefaultBodyLimit::max(MAX_HOME_BODY)),
        )
        .with_state(state)
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

async fn receive_push(
    State(state): State<AppState>,
    Path(route_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    match state.database.route(route_id.clone()).await? {
        Route::Probing => Ok(StatusCode::CREATED.into_response()),
        Route::Active {
            device_id,
            home_vapid,
            target,
        } => {
            verify_vapid(&headers, &home_vapid, &state.origin)?;
            let ttl = headers
                .get("TTL")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| Error::BadRequest("TTL must be an unsigned integer".to_owned()))?;
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
