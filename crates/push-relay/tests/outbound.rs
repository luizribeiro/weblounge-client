//! Web Push wrapping, SSRF policy, and fake push-service behavior.

use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
};

use aes_gcm::{
    Aes128Gcm, Nonce,
    aead::{Aead as _, KeyInit as _},
};
use async_trait::async_trait;
use axum::response::IntoResponse as _;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    elliptic_curve::sec1::ToEncodedPoint as _,
    pkcs8::{EncodePrivateKey as _, LineEnding},
};
use rand_core::OsRng;
use reqwest::StatusCode;
use serde_json::json;
use sha2::Sha256;
use url::Url;
use weblounge_push_relay::{
    Delivery, DnsResolver, EndpointValidator, Error, HttpTransport, OutboundRequest, PushOutcome,
    PushSender, Result, WebPushSender,
};

#[derive(Debug)]
struct FixedDns(Vec<IpAddr>);

#[async_trait]
impl DnsResolver for FixedDns {
    async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}

#[derive(Debug)]
struct SequenceDns(Mutex<VecDeque<Vec<IpAddr>>>);

#[async_trait]
impl DnsResolver for SequenceDns {
    async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>> {
        self.0
            .lock()
            .expect("DNS answers")
            .pop_front()
            .ok_or_else(|| Error::TargetRefused("no DNS answer".to_owned()))
    }
}

#[derive(Clone)]
struct FakePushService {
    requests: Arc<Mutex<Vec<OutboundRequest>>>,
    status: StatusCode,
}

#[derive(Clone)]
struct AddressPushService {
    requests: Arc<Mutex<Vec<OutboundRequest>>>,
    reachable: Option<IpAddr>,
}

#[async_trait]
impl HttpTransport for AddressPushService {
    async fn send(&self, request: OutboundRequest) -> Result<StatusCode> {
        let address = request.address.ip();
        self.requests.lock().expect("request lock").push(request);
        if self.reachable == Some(address) {
            Ok(StatusCode::CREATED)
        } else {
            Err(Error::DeliveryUnavailable)
        }
    }
}

#[async_trait]
impl HttpTransport for FakePushService {
    async fn send(&self, request: OutboundRequest) -> Result<StatusCode> {
        self.requests.lock().expect("request lock").push(request);
        Ok(self.status)
    }
}

#[tokio::test]
async fn wraps_ciphertext_once_and_signs_the_fake_push_service_request() {
    let relay_key = SecretKey::random(&mut OsRng);
    let relay_pem = relay_key.to_pkcs8_pem(LineEnding::LF).expect("relay PEM");
    let receiver = SecretKey::random(&mut OsRng);
    let receiver_public = receiver.public_key().to_encoded_point(false);
    let receiver_auth = [17_u8; 16];
    let requests = Arc::new(Mutex::new(Vec::new()));
    let transport = FakePushService {
        requests: Arc::clone(&requests),
        status: StatusCode::CREATED,
    };
    let validator = EndpointValidator::new(
        ["push.example"],
        Arc::new(FixedDns(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])),
    );
    let sender =
        WebPushSender::with_transport(relay_pem.as_bytes(), validator, Arc::new(transport))
            .expect("sender");
    let inner = b"still encrypted by the home".to_vec();
    let outcome = sender
        .send(Delivery::web_push(
            "route-id",
            "https://push.example/send/device",
            URL_SAFE_NO_PAD.encode(receiver_public.as_bytes()),
            URL_SAFE_NO_PAD.encode(receiver_auth),
            inner.clone(),
            604_800,
        ))
        .await
        .expect("delivery");
    assert_eq!(outcome, PushOutcome::Accepted);

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.ttl, 604_800);
    assert_eq!(request.address.ip(), IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)));
    assert!(request.authorization.starts_with("vapid t="));
    let envelope = decrypt(&request.body, &receiver, &receiver_auth);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&envelope).expect("envelope JSON"),
        json!({
            "web_push": 8030,
            "mutable": true,
            "notification": {
                "title": "New message",
                "navigate": "/",
                "data": {
                    "r": "route-id",
                    "c": URL_SAFE_NO_PAD.encode(inner),
                },
            },
        })
    );
}

#[tokio::test]
async fn refuses_disallowed_and_non_public_targets() {
    let public = EndpointValidator::new(
        ["push.example"],
        Arc::new(FixedDns(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])),
    );
    assert!(
        public
            .validate(&Url::parse("https://other.example/send").expect("URL"))
            .await
            .is_err()
    );
    assert!(
        public
            .validate(&Url::parse("http://push.example/send").expect("URL"))
            .await
            .is_err()
    );

    for addresses in [
        vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))],
        vec![
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ],
    ] {
        let validator = EndpointValidator::new(["push.example"], Arc::new(FixedDns(addresses)));
        assert!(
            validator
                .validate(&Url::parse("https://push.example/send").expect("URL"))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn redirect_response_is_not_followed_or_reported_as_success() {
    let relay_key = SecretKey::random(&mut OsRng)
        .to_pkcs8_pem(LineEnding::LF)
        .expect("relay PEM");
    let receiver = SecretKey::random(&mut OsRng);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let validator = EndpointValidator::new(
        ["push.example"],
        Arc::new(FixedDns(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])),
    );
    let sender = WebPushSender::with_transport(
        relay_key.as_bytes(),
        validator,
        Arc::new(FakePushService {
            requests: Arc::clone(&requests),
            status: StatusCode::FOUND,
        }),
    )
    .expect("sender");
    let result = sender
        .send(Delivery::web_push(
            "route",
            "https://push.example/send",
            URL_SAFE_NO_PAD.encode(receiver.public_key().to_encoded_point(false).as_bytes()),
            URL_SAFE_NO_PAD.encode([0_u8; 16]),
            b"ciphertext".to_vec(),
            60,
        ))
        .await;
    assert!(matches!(result, Err(Error::PushServiceUnavailable)));
    assert_eq!(requests.lock().expect("requests").len(), 1);
}

#[tokio::test]
async fn both_upstream_404_and_410_mean_the_subscription_is_dead() {
    for status in [StatusCode::NOT_FOUND, StatusCode::GONE] {
        let relay_key = SecretKey::random(&mut OsRng)
            .to_pkcs8_pem(LineEnding::LF)
            .expect("relay PEM");
        let receiver = SecretKey::random(&mut OsRng);
        let validator = EndpointValidator::new(
            ["push.example"],
            Arc::new(FixedDns(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])),
        );
        let sender = WebPushSender::with_transport(
            relay_key.as_bytes(),
            validator,
            Arc::new(FakePushService {
                requests: Arc::new(Mutex::new(Vec::new())),
                status,
            }),
        )
        .expect("sender");
        let outcome = sender
            .send(Delivery::web_push(
                "route",
                "https://push.example/send",
                URL_SAFE_NO_PAD.encode(receiver.public_key().to_encoded_point(false).as_bytes()),
                URL_SAFE_NO_PAD.encode([0_u8; 16]),
                b"ciphertext".to_vec(),
                60,
            ))
            .await
            .expect("dead outcome");
        assert_eq!(outcome, PushOutcome::Dead);
    }
}

#[tokio::test]
async fn delivery_revalidation_maps_private_dns_to_upstream_unavailable() {
    let resolver = Arc::new(SequenceDns(Mutex::new(VecDeque::from([
        vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))],
        vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
    ]))));
    let validator = EndpointValidator::new(["push.example"], resolver);
    let endpoint = Url::parse("https://push.example/send").expect("URL");
    validator
        .validate(&endpoint)
        .await
        .expect("registration validation");
    let relay_key = SecretKey::random(&mut OsRng)
        .to_pkcs8_pem(LineEnding::LF)
        .expect("relay PEM");
    let receiver = SecretKey::random(&mut OsRng);
    let sender = WebPushSender::with_transport(
        relay_key.as_bytes(),
        validator,
        Arc::new(FakePushService {
            requests: Arc::new(Mutex::new(Vec::new())),
            status: StatusCode::CREATED,
        }),
    )
    .expect("sender");

    let result = sender
        .send(Delivery::web_push(
            "route",
            endpoint.to_string(),
            URL_SAFE_NO_PAD.encode(receiver.public_key().to_encoded_point(false).as_bytes()),
            URL_SAFE_NO_PAD.encode([0_u8; 16]),
            b"ciphertext".to_vec(),
            60,
        ))
        .await;
    assert!(matches!(result, Err(Error::DeliveryUnavailable)));
}

#[tokio::test]
async fn delivery_prefers_ipv4_when_dns_returns_ipv6_first() {
    let ipv6 = IpAddr::V6("2606:4700:4700::1111".parse::<Ipv6Addr>().expect("IPv6"));
    let ipv4 = IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sender = sender_for_addresses(
        vec![ipv6, ipv4],
        AddressPushService {
            requests: Arc::clone(&requests),
            reachable: Some(ipv4),
        },
    );

    let outcome = sender.send(test_delivery()).await.expect("IPv4 delivery");

    assert_eq!(outcome, PushOutcome::Accepted);
    let addresses: Vec<_> = requests
        .lock()
        .expect("requests")
        .iter()
        .map(|request| request.address.ip())
        .collect();
    assert_eq!(addresses, vec![ipv4]);
}

#[tokio::test]
async fn delivery_tries_every_validated_address_before_reporting_unavailable() {
    let ipv6 = IpAddr::V6("2606:4700:4700::1111".parse::<Ipv6Addr>().expect("IPv6"));
    let ipv4 = IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sender = sender_for_addresses(
        vec![ipv6, ipv4],
        AddressPushService {
            requests: Arc::clone(&requests),
            reachable: None,
        },
    );

    let error = sender
        .send(test_delivery())
        .await
        .expect_err("all addresses fail");

    assert!(matches!(&error, Error::DeliveryUnavailable));
    let addresses: Vec<_> = requests
        .lock()
        .expect("requests")
        .iter()
        .map(|request| request.address.ip())
        .collect();
    assert_eq!(addresses, vec![ipv4, ipv6]);
    assert_eq!(
        error.into_response().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

fn sender_for_addresses(addresses: Vec<IpAddr>, transport: impl HttpTransport) -> WebPushSender {
    let relay_key = SecretKey::random(&mut OsRng)
        .to_pkcs8_pem(LineEnding::LF)
        .expect("relay PEM");
    let validator = EndpointValidator::new(["push.example"], Arc::new(FixedDns(addresses)));
    WebPushSender::with_transport(relay_key.as_bytes(), validator, Arc::new(transport))
        .expect("sender")
}

fn test_delivery() -> Delivery {
    let receiver = SecretKey::random(&mut OsRng);
    Delivery::web_push(
        "route",
        "https://push.example/send",
        URL_SAFE_NO_PAD.encode(receiver.public_key().to_encoded_point(false).as_bytes()),
        URL_SAFE_NO_PAD.encode([0_u8; 16]),
        b"ciphertext".to_vec(),
        60,
    )
}

fn decrypt(body: &[u8], receiver: &SecretKey, auth: &[u8]) -> Vec<u8> {
    assert!(body.len() > 102);
    let salt = &body[..16];
    assert_eq!(
        u32::from_be_bytes(body[16..20].try_into().expect("rs")),
        4_096
    );
    assert_eq!(body[20], 65);
    let sender_bytes = &body[21..86];
    let sender = PublicKey::from_sec1_bytes(sender_bytes).expect("sender key");
    let shared = diffie_hellman(receiver.to_nonzero_scalar(), sender.as_affine());
    let receiver_public = receiver.public_key().to_encoded_point(false);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(receiver_public.as_bytes());
    key_info.extend_from_slice(sender_bytes);
    let auth_prk = Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes().as_slice());
    let mut ikm = [0_u8; 32];
    auth_prk.expand(&key_info, &mut ikm).expect("input key");
    let content_prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut key = [0_u8; 16];
    let mut nonce = [0_u8; 12];
    content_prk
        .expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .expect("content key");
    content_prk
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("nonce");
    let cipher = Aes128Gcm::new_from_slice(&key).expect("cipher");
    let mut plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), &body[86..])
        .expect("plaintext");
    assert_eq!(plaintext.pop(), Some(2));
    plaintext
}
