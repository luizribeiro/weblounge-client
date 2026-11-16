use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::{
    SecretKey,
    ecdsa::{Signature, VerifyingKey, signature::Verifier as _},
    pkcs8::{EncodePrivateKey as _, LineEnding},
};
use rand_core::OsRng;
use reqwest::{Certificate, StatusCode, Version};
use serde_json::{Value, json};
use url::Url;

use std::net::SocketAddr;

use super::{ApnsCredentials, ApnsHosts, ApnsSender, client_builder};
use crate::{
    ApnsSettings, Delivery, Error, PushOutcome, PushSender as _, Urgency,
    jwt::unix_seconds,
    target::{ApnsEnvironment, ApnsTarget, PushTarget},
    test_apns::{ApnsRequest, FakeApns},
};

const PRODUCTION: &str = "production.apns.test";
const SANDBOX: &str = "sandbox.apns.test";
const TOKEN: &str = "5f1c6e0b9a3d4c2e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e";
const MAX_APNS_PAYLOAD: usize = 4_096;
const MAX_HOME_BODY: usize = 2_800;

struct Fixture {
    apns: FakeApns,
    sender: ApnsSender,
    key: SecretKey,
}

fn credentials(key_pem: Vec<u8>) -> ApnsCredentials {
    ApnsCredentials {
        key_pem,
        key_id: "ABC123DEFG".to_owned(),
        team_id: "DEF123GHIJ".to_owned(),
        topic: "org.weblounge.ios".to_owned(),
    }
}

fn p8(key: &SecretKey) -> Vec<u8> {
    key.to_pkcs8_pem(LineEnding::LF)
        .expect("p8 key")
        .as_bytes()
        .to_vec()
}

fn sender_at(address: SocketAddr, root: &[u8], key: &SecretKey) -> ApnsSender {
    let host =
        |name: &str| Url::parse(&format!("https://{name}:{}/", address.port())).expect("fake host");
    let client = client_builder()
        .add_root_certificate(Certificate::from_der(root).expect("fake root"))
        .resolve(PRODUCTION, address)
        .resolve(SANDBOX, address);
    ApnsSender::with_client(
        credentials(p8(key)),
        ApnsHosts {
            production: host(PRODUCTION),
            sandbox: host(SANDBOX),
        },
        client,
    )
    .expect("APNs sender")
}

async fn fixture() -> Fixture {
    let apns = FakeApns::start(&[PRODUCTION, SANDBOX]).await;
    let key = SecretKey::random(&mut OsRng);
    let sender = sender_at(apns.address(), apns.certificate(), &key);
    Fixture { apns, sender, key }
}

fn delivery(environment: ApnsEnvironment, body: Vec<u8>) -> Delivery {
    Delivery {
        route_id: "kq3VJbW1xX0aY9Zr2pLm4w".to_owned(),
        target: PushTarget::Apns(ApnsTarget {
            token: TOKEN.to_owned(),
            environment,
        }),
        body,
        ttl: 600,
        urgency: Urgency::High,
    }
}

fn header<'a>(request: &'a ApnsRequest, name: &str) -> &'a str {
    request
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn jwt_part(jwt: &str, index: usize) -> Value {
    let part = jwt.split('.').nth(index).expect("JWT part");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("JSON")
}

#[tokio::test]
async fn accepted_push_carries_the_design_headers_and_payload() {
    let fixture = fixture().await;
    let before = unix_seconds().expect("clock");

    let outcome = fixture
        .sender
        .send(delivery(
            ApnsEnvironment::Production,
            b"ciphertext".to_vec(),
        ))
        .await;

    assert_eq!(outcome.expect("accepted"), PushOutcome::Accepted);
    let requests = fixture.apns.requests();
    let [request] = requests.as_slice() else {
        panic!("expected one request, got {requests:?}");
    };
    assert_eq!(request.version, Version::HTTP_2);
    assert_eq!(
        request.authority,
        format!("{PRODUCTION}:{}", fixture.apns.address().port())
    );
    assert_eq!(request.path, format!("/3/device/{TOKEN}"));
    assert_eq!(header(request, "apns-topic"), "org.weblounge.ios");
    assert_eq!(header(request, "apns-push-type"), "alert");
    assert_eq!(header(request, "apns-priority"), "10");
    assert_eq!(header(request, "content-type"), "application/json");
    let expiration = header(request, "apns-expiration")
        .parse::<u64>()
        .expect("expiration");
    let after = unix_seconds().expect("clock");
    assert!((before + 600..=after + 600).contains(&expiration));
    assert_eq!(
        String::from_utf8(request.body.clone()).expect("UTF-8 payload"),
        r#"{"aps":{"alert":{"title":"weblounge","body":"New message"},"mutable-content":1,"sound":"default"},"r":"kq3VJbW1xX0aY9Zr2pLm4w","c":"Y2lwaGVydGV4dA"}"#
    );

    let jwt = header(request, "authorization")
        .strip_prefix("bearer ")
        .expect("bearer token");
    assert_eq!(
        jwt_part(jwt, 0),
        json!({"alg": "ES256", "kid": "ABC123DEFG"})
    );
    let claims = jwt_part(jwt, 1);
    assert_eq!(claims["iss"], "DEF123GHIJ");
    assert!((before..=after).contains(&claims["iat"].as_u64().expect("iat")));
    let (signing_input, signature) = jwt.rsplit_once('.').expect("signature");
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).expect("base64url"))
        .expect("raw signature");
    VerifyingKey::from(fixture.key.public_key())
        .verify(signing_input.as_bytes(), &signature)
        .expect("signed with the provider key");
}

#[tokio::test]
async fn sandbox_tokens_go_to_the_sandbox_host_with_the_cached_provider_token() {
    let fixture = fixture().await;
    for environment in [ApnsEnvironment::Sandbox, ApnsEnvironment::Production] {
        fixture
            .sender
            .send(delivery(environment, b"ciphertext".to_vec()))
            .await
            .expect("accepted");
    }

    let requests = fixture.apns.requests();
    let hosts = requests
        .iter()
        .map(|request| request.authority.split(':').next().expect("host"))
        .collect::<Vec<_>>();
    assert_eq!(hosts, [SANDBOX, PRODUCTION]);
    assert_eq!(
        header(&requests[0], "authorization"),
        header(&requests[1], "authorization")
    );
}

#[tokio::test]
async fn unregistered_and_bad_device_tokens_are_dead_targets() {
    let fixture = fixture().await;
    fixture.apns.reply(
        StatusCode::GONE,
        r#"{"reason":"Unregistered","timestamp":1762000000000}"#,
    );
    fixture
        .apns
        .reply(StatusCode::BAD_REQUEST, r#"{"reason":"BadDeviceToken"}"#);

    for _ in 0..2 {
        let outcome = fixture
            .sender
            .send(delivery(
                ApnsEnvironment::Production,
                b"ciphertext".to_vec(),
            ))
            .await;
        assert_eq!(outcome.expect("dead target"), PushOutcome::Dead);
    }
}

fn issued_at(request: &ApnsRequest) -> u64 {
    let jwt = header(request, "authorization")
        .strip_prefix("bearer ")
        .expect("bearer token");
    jwt_part(jwt, 1)["iat"].as_u64().expect("iat")
}

const CACHED_ISSUED_AT: u64 = 1_762_000_000;

async fn fixture_with_cached_token() -> Fixture {
    let fixture = fixture().await;
    fixture
        .sender
        .tokens
        .at(tokio::time::Instant::now(), CACHED_ISSUED_AT)
        .expect("cached token");
    fixture
}

async fn send_once(fixture: &Fixture) -> crate::Result<PushOutcome> {
    fixture
        .sender
        .send(delivery(
            ApnsEnvironment::Production,
            b"ciphertext".to_vec(),
        ))
        .await
}

#[tokio::test]
async fn a_rejected_provider_token_is_replaced_on_the_next_delivery() {
    for reason in ["ExpiredProviderToken", "InvalidProviderToken"] {
        let fixture = fixture_with_cached_token().await;
        let body = format!(r#"{{"reason":"{reason}"}}"#);
        fixture
            .apns
            .reply(StatusCode::FORBIDDEN, Box::leak(body.into_boxed_str()));
        let rejected = send_once(&fixture).await;
        assert!(
            matches!(rejected, Err(Error::PushServiceUnavailable)),
            "{reason}: {rejected:?}"
        );
        let before = unix_seconds().expect("clock");
        send_once(&fixture)
            .await
            .expect("accepted with a fresh token");

        let requests = fixture.apns.requests();
        assert_eq!(requests.len(), 2, "{reason}: no retry");
        assert_eq!(issued_at(&requests[0]), CACHED_ISSUED_AT);
        assert!(issued_at(&requests[1]) >= before, "{reason}");
    }
}

#[tokio::test]
async fn other_forbidden_answers_keep_the_cached_provider_token() {
    let fixture = fixture_with_cached_token().await;
    fixture.apns.reply(
        StatusCode::FORBIDDEN,
        r#"{"reason":"BadCertificateEnvironment"}"#,
    );
    fixture.apns.reply(
        StatusCode::INTERNAL_SERVER_ERROR,
        r#"{"reason":"InternalServerError"}"#,
    );
    for _ in 0..2 {
        assert!(matches!(
            send_once(&fixture).await,
            Err(Error::PushServiceUnavailable)
        ));
    }
    send_once(&fixture).await.expect("accepted");
    let requests = fixture.apns.requests();
    assert!(
        requests
            .iter()
            .all(|request| issued_at(request) == CACHED_ISSUED_AT)
    );
}

#[tokio::test]
async fn other_rejections_are_ordinary_failures() {
    let fixture = fixture().await;
    for (status, body) in [
        (StatusCode::BAD_REQUEST, r#"{"reason":"BadTopic"}"#),
        (
            StatusCode::FORBIDDEN,
            r#"{"reason":"ExpiredProviderToken"}"#,
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"reason":"TooManyRequests"}"#,
        ),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"reason":"InternalServerError"}"#,
        ),
        (StatusCode::BAD_REQUEST, "<html>proxy error</html>"),
        (StatusCode::SERVICE_UNAVAILABLE, ""),
    ] {
        fixture.apns.reply(status, body);
        let outcome = fixture
            .sender
            .send(delivery(
                ApnsEnvironment::Production,
                b"ciphertext".to_vec(),
            ))
            .await;
        assert!(
            matches!(outcome, Err(Error::PushServiceUnavailable)),
            "{status} {body}: {outcome:?}"
        );
    }
}

#[test]
fn the_largest_home_body_fits_the_apns_payload_limit() {
    let largest = delivery(ApnsEnvironment::Production, vec![0xff; MAX_HOME_BODY]);
    assert!(super::payload(&largest).expect("payload").len() <= MAX_APNS_PAYLOAD);
}

#[tokio::test]
async fn web_push_targets_are_not_sent_to_apns() {
    let fixture = fixture().await;
    let web_push = Delivery::web_push(
        "route",
        "https://web.push.apple.com/QGx3",
        "key",
        "auth",
        b"ciphertext".to_vec(),
        60,
    );
    assert!(matches!(
        fixture.sender.send(web_push).await,
        Err(Error::DeliveryUnavailable)
    ));
    assert!(fixture.apns.requests().is_empty());
}

#[tokio::test]
async fn a_token_that_is_not_hex_never_reaches_apns() {
    let fixture = fixture().await;
    let mut smuggled = delivery(ApnsEnvironment::Production, b"ciphertext".to_vec());
    smuggled.target = PushTarget::Apns(ApnsTarget {
        token: "../../3/device/other?x=1".to_owned(),
        environment: ApnsEnvironment::Production,
    });
    assert!(matches!(
        fixture.sender.send(smuggled).await,
        Err(Error::DeliveryUnavailable)
    ));
    assert!(fixture.apns.requests().is_empty());
}

#[tokio::test]
async fn an_unreachable_apns_host_is_delivery_unavailable() {
    let apns = FakeApns::start(&[PRODUCTION]).await;
    let closed = crate::test_tls::loopback_listener()
        .await
        .local_addr()
        .expect("closed address");
    let sender = sender_at(closed, apns.certificate(), &SecretKey::random(&mut OsRng));
    assert!(matches!(
        sender
            .send(delivery(
                ApnsEnvironment::Production,
                b"ciphertext".to_vec()
            ))
            .await,
        Err(Error::DeliveryUnavailable)
    ));
}

#[test]
fn the_provider_key_must_be_a_pkcs8_p256_key() {
    for key_pem in [
        b"not a key".to_vec(),
        vec![0xff, 0xfe],
        b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".to_vec(),
    ] {
        assert!(matches!(
            ApnsSender::new(credentials(key_pem)),
            Err(Error::Config(_))
        ));
    }
    ApnsSender::new(credentials(p8(&SecretKey::random(&mut OsRng)))).expect("valid .p8 key");
}

#[tokio::test]
async fn settings_load_the_p8_key_file() {
    let directory = tempfile::tempdir().expect("secrets directory");
    let key_file = directory.path().join("push-relay-apns-key");
    std::fs::write(&key_file, p8(&SecretKey::random(&mut OsRng))).expect("key file");
    let settings = |key_file| ApnsSettings {
        key_file,
        key_id: "ABC123DEFG",
        team_id: "DEF123GHIJ",
        topic: "org.weblounge.ios",
    };

    let sender = ApnsSender::from_settings(settings(&key_file))
        .await
        .expect("sender");
    assert!(sender.delivers_apns());
    let missing = directory.path().join("missing");
    assert!(matches!(
        ApnsSender::from_settings(settings(&missing)).await,
        Err(Error::Io(_))
    ));
}
