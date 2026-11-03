//! Concierge introspection wire behavior.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Form, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    routing::post,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use url::Url;
use weblounge_push_relay::{Concierge as _, ConciergeClient, Error};

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<String>>>);

#[tokio::test]
async fn concierge_receives_basic_auth_and_the_session_only_in_the_form() {
    let seen = Seen::default();
    let router = Router::new()
        .route("/oauth/introspect", post(introspect))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let client = ConciergeClient::new(
        Url::parse(&format!("http://{address}/oauth/introspect")).expect("URL"),
        "client secret".to_owned(),
    )
    .expect("client");

    let identity = client
        .introspect("one-shot-session")
        .await
        .expect("active session");
    assert_eq!(identity.account, "mel");
    assert_eq!(*seen.0.lock().await, vec!["one-shot-session"]);
    server.abort();
}

#[tokio::test]
async fn concierge_rejects_inactive_sessions() {
    let router = Router::new().route(
        "/oauth/introspect",
        post(|| async { Json(json!({"active": false})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let client = ConciergeClient::new(
        Url::parse(&format!("http://{address}/oauth/introspect")).expect("URL"),
        "client secret".to_owned(),
    )
    .expect("client");

    assert!(matches!(
        client.introspect("expired").await,
        Err(Error::Unauthorized)
    ));
    server.abort();
}

#[tokio::test]
async fn concierge_maps_server_failures_to_unavailable() {
    let router = Router::new().route(
        "/oauth/introspect",
        post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let client = ConciergeClient::new(
        Url::parse(&format!("http://{address}/oauth/introspect")).expect("URL"),
        "client secret".to_owned(),
    )
    .expect("client");

    assert!(matches!(
        client.introspect("session").await,
        Err(Error::ConciergeUnavailable)
    ));
    server.abort();
}

#[tokio::test(start_paused = true)]
async fn concierge_maps_request_timeout_to_unavailable() {
    let router = Router::new().route(
        "/oauth/introspect",
        post(|| async { std::future::pending::<StatusCode>().await }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let client = ConciergeClient::new(
        Url::parse(&format!("http://{address}/oauth/introspect")).expect("URL"),
        "client secret".to_owned(),
    )
    .expect("client");

    assert!(matches!(
        client.introspect("session").await,
        Err(Error::ConciergeUnavailable)
    ));
    server.abort();
}

async fn introspect(
    State(seen): State<Seen>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    let expected = format!("Basic {}", STANDARD.encode("push-relay:client secret"));
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_client"})),
        );
    }
    let Some(token) = form.get("token") else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"missing token"})),
        );
    };
    seen.0.lock().await.push(token.clone());
    (
        StatusCode::OK,
        Json(json!({"active":true,"username":"mel"})),
    )
}
