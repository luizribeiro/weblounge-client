use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use aes_gcm::{
    Aes128Gcm, Nonce,
    aead::{Aead as _, KeyInit as _},
};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdh::EphemeralSecret,
    ecdsa::{Signature, SigningKey, signature::Signer as _},
    elliptic_curve::sec1::ToEncodedPoint as _,
    pkcs8::DecodePrivateKey as _,
};
use rand_core::{OsRng, RngCore as _};
use reqwest::{Certificate, StatusCode, redirect::Policy};
use serde::Serialize;
use sha2::Sha256;
use url::Url;

use crate::{Error, Result, db::WebPushTarget};

/// An opaque home push and the browser subscription that should receive it.
#[derive(Clone, Debug)]
pub struct Delivery {
    pub(crate) route_id: String,
    pub(crate) target: WebPushTarget,
    pub(crate) body: Vec<u8>,
    pub(crate) ttl: u32,
}

impl Delivery {
    /// Constructs a Web Push delivery from a stored browser subscription.
    #[must_use]
    pub fn web_push(
        route_id: impl Into<String>,
        endpoint: impl Into<String>,
        p256dh: impl Into<String>,
        auth: impl Into<String>,
        body: Vec<u8>,
        ttl: u32,
    ) -> Self {
        Self {
            route_id: route_id.into(),
            target: WebPushTarget {
                endpoint: endpoint.into(),
                p256dh: p256dh.into(),
                auth: auth.into(),
            },
            body,
            ttl,
        }
    }

    /// The opaque route identifier included in the declarative envelope.
    #[must_use]
    pub fn route_id(&self) -> &str {
        &self.route_id
    }

    /// The encrypted home payload, unchanged.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    /// The home-provided lifetime in seconds.
    #[must_use]
    pub fn ttl(&self) -> u32 {
        self.ttl
    }

    /// The browser push-service endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.target.endpoint
    }
}

/// The only push-service outcomes that affect relay state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PushOutcome {
    /// The push service accepted the message.
    Accepted,
    /// The browser subscription is permanently gone.
    Dead,
}

/// Boundary between route handling and platform delivery.
#[async_trait]
pub trait PushSender: Send + Sync + 'static {
    /// Wraps, encrypts, signs, and sends one opaque home push.
    async fn send(&self, delivery: Delivery) -> Result<PushOutcome>;
}

/// Fully prepared request passed to the no-redirect HTTP transport.
#[derive(Clone, Debug)]
pub struct OutboundRequest {
    /// Browser push-service URL.
    pub endpoint: Url,
    /// Validated address to which the hostname must be pinned.
    pub address: std::net::SocketAddr,
    /// Home-provided lifetime in seconds.
    pub ttl: u32,
    /// Relay VAPID authorization header.
    pub authorization: String,
    /// RFC 8291 encrypted body.
    pub body: Vec<u8>,
}

/// HTTP seam used by integration tests to act as a push service.
#[async_trait]
pub trait HttpTransport: Send + Sync + 'static {
    /// Sends one request without following redirects.
    async fn send(&self, request: OutboundRequest) -> Result<StatusCode>;
}

#[derive(Clone, Debug)]
struct ReqwestTransport {
    root: Option<Certificate>,
}

impl ReqwestTransport {
    fn production() -> Self {
        Self { root: None }
    }

    #[cfg(test)]
    fn with_root_certificate(root: Certificate) -> Self {
        Self { root: Some(root) }
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn send(&self, request: OutboundRequest) -> Result<StatusCode> {
        let host = request
            .endpoint
            .host_str()
            .ok_or_else(|| Error::TargetRefused("endpoint has no host".to_owned()))?;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .resolve(host, request.address);
        if let Some(root) = &self.root {
            builder = builder.add_root_certificate(root.clone());
        }
        let client = builder.build()?;
        Ok(client
            .post(request.endpoint)
            .header("TTL", request.ttl)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", request.authorization)
            .body(request.body)
            .send()
            .await?
            .status())
    }
}

/// DNS seam used to validate every endpoint both at registration and delivery time.
#[async_trait]
pub trait DnsResolver: Send + Sync + 'static {
    /// Resolves every address advertised for a host and port.
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>>;
}

#[derive(Clone, Debug)]
struct SystemDns;

#[async_trait]
impl DnsResolver for SystemDns {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>> {
        let addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| Error::TargetRefused("DNS resolution failed".to_owned()))?;
        Ok(addresses.map(|address| address.ip()).collect())
    }
}

/// Allowlist and public-address checks for browser push subscriptions.
#[derive(Clone)]
pub struct EndpointValidator {
    allowed_hosts: Arc<HashSet<String>>,
    resolver: Arc<dyn DnsResolver>,
}

impl std::fmt::Debug for EndpointValidator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EndpointValidator")
            .field("allowed_hosts", &self.allowed_hosts)
            .finish_non_exhaustive()
    }
}

impl EndpointValidator {
    /// Uses the Web Push services supported by the first relay slice.
    #[must_use]
    pub fn production() -> Self {
        Self::new(
            [
                "fcm.googleapis.com",
                "updates.push.services.mozilla.com",
                "web.push.apple.com",
            ],
            Arc::new(SystemDns),
        )
    }

    /// Constructs a validator with an explicit allowlist and resolver.
    #[must_use]
    pub fn new(
        allowed_hosts: impl IntoIterator<Item = impl Into<String>>,
        resolver: Arc<dyn DnsResolver>,
    ) -> Self {
        Self {
            allowed_hosts: Arc::new(allowed_hosts.into_iter().map(Into::into).collect()),
            resolver,
        }
    }

    /// Validates the URL and every current DNS answer, returning one pinned address.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed, disallowed, unresolvable, or non-public targets.
    pub async fn validate(&self, endpoint: &Url) -> Result<std::net::SocketAddr> {
        if endpoint.scheme() != "https"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(Error::TargetRefused(
                "endpoint must be an HTTPS URL without credentials or a fragment".to_owned(),
            ));
        }
        let host = endpoint
            .host_str()
            .ok_or_else(|| Error::TargetRefused("endpoint has no host".to_owned()))?;
        if !self.allowed_hosts.contains(host) {
            return Err(Error::TargetRefused(
                "endpoint host is not an allowed push service".to_owned(),
            ));
        }
        let port = endpoint
            .port_or_known_default()
            .ok_or_else(|| Error::TargetRefused("endpoint has no port".to_owned()))?;
        if port != 443 {
            return Err(Error::TargetRefused(
                "push-service endpoint must use port 443".to_owned(),
            ));
        }
        let addresses = self.resolver.resolve(host, port).await?;
        if addresses.is_empty() || addresses.iter().any(|address| !is_public(*address)) {
            return Err(Error::TargetRefused(
                "endpoint resolves to a non-public address".to_owned(),
            ));
        }
        Ok(std::net::SocketAddr::new(addresses[0], port))
    }
}

/// Production Web Push sender, using a relay-owned VAPID key.
#[derive(Clone)]
pub struct WebPushSender {
    vapid_key: Arc<SigningKey>,
    vapid_public: Arc<Vec<u8>>,
    targets: EndpointValidator,
    transport: Arc<dyn HttpTransport>,
}

impl std::fmt::Debug for WebPushSender {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebPushSender")
            .field("vapid_public", &URL_SAFE_NO_PAD.encode(&*self.vapid_public))
            .field("targets", &self.targets)
            .finish_non_exhaustive()
    }
}

impl WebPushSender {
    /// Parses the relay key up front and constructs the sender.
    ///
    /// # Errors
    ///
    /// Returns an error when the key is not a PEM-encoded P-256 private key.
    pub fn new(vapid_key: &[u8], targets: EndpointValidator) -> Result<Self> {
        Self::with_transport(vapid_key, targets, Arc::new(ReqwestTransport::production()))
    }

    /// Constructs a sender with an explicit no-redirect transport.
    ///
    /// # Errors
    ///
    /// Returns an error when the key is not a PEM-encoded P-256 private key.
    pub fn with_transport(
        vapid_key: &[u8],
        targets: EndpointValidator,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self> {
        let pem = std::str::from_utf8(vapid_key)
            .map_err(|_| Error::Crypto("VAPID key is not PEM text".to_owned()))?;
        let secret = SecretKey::from_pkcs8_pem(pem)
            .or_else(|_| SecretKey::from_sec1_pem(pem))
            .map_err(|_| Error::Crypto("VAPID key is not a P-256 private key".to_owned()))?;
        let public = secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        Ok(Self {
            vapid_key: Arc::new(SigningKey::from(secret)),
            vapid_public: Arc::new(public),
            targets,
            transport,
        })
    }
}

#[derive(Serialize)]
struct Envelope<'a> {
    web_push: u16,
    mutable: bool,
    notification: Notification<'a>,
}

#[derive(Serialize)]
struct Notification<'a> {
    title: &'static str,
    navigate: &'static str,
    data: NotificationData<'a>,
}

#[derive(Serialize)]
struct NotificationData<'a> {
    r: &'a str,
    c: String,
}

#[async_trait]
impl PushSender for WebPushSender {
    async fn send(&self, delivery: Delivery) -> Result<PushOutcome> {
        let endpoint = Url::parse(&delivery.target.endpoint)
            .map_err(|_| Error::TargetRefused("endpoint is not a URL".to_owned()))?;
        let address = self.targets.validate(&endpoint).await?;
        let envelope = serde_json::to_vec(&Envelope {
            web_push: 8030,
            mutable: true,
            notification: Notification {
                title: "New message",
                navigate: "/",
                data: NotificationData {
                    r: &delivery.route_id,
                    c: URL_SAFE_NO_PAD.encode(&delivery.body),
                },
            },
        })
        .map_err(|error| Error::BadRequest(error.to_string()))?;
        let payload = encrypt_payload(&envelope, &delivery.target.p256dh, &delivery.target.auth)?;
        let authorization = vapid_authorization(
            &self.vapid_key,
            &self.vapid_public,
            &endpoint.origin().ascii_serialization(),
        )?;

        let status = self
            .transport
            .send(OutboundRequest {
                endpoint,
                address,
                ttl: delivery.ttl,
                authorization,
                body: payload,
            })
            .await?;
        match status {
            status if status.is_success() => Ok(PushOutcome::Accepted),
            StatusCode::NOT_FOUND | StatusCode::GONE => Ok(PushOutcome::Dead),
            _ => Err(Error::PushServiceUnavailable),
        }
    }
}

fn encrypt_payload(content: &[u8], p256dh: &str, auth: &str) -> Result<Vec<u8>> {
    let recipient_bytes = URL_SAFE_NO_PAD
        .decode(p256dh)
        .map_err(|_| Error::Crypto("subscription key is not base64url".to_owned()))?;
    let recipient = PublicKey::from_sec1_bytes(&recipient_bytes)
        .map_err(|_| Error::Crypto("subscription key is not P-256".to_owned()))?;
    let auth = URL_SAFE_NO_PAD
        .decode(auth)
        .map_err(|_| Error::Crypto("subscription auth is not base64url".to_owned()))?;

    let sender_secret = EphemeralSecret::random(&mut OsRng);
    let sender_public = sender_secret.public_key().to_encoded_point(false);
    let shared = sender_secret.diffie_hellman(&recipient);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&recipient_bytes);
    key_info.extend_from_slice(sender_public.as_bytes());
    let auth_prk = Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes().as_slice());
    let mut ikm = [0_u8; 32];
    auth_prk
        .expand(&key_info, &mut ikm)
        .map_err(|_| Error::Crypto("could not derive Web Push input key".to_owned()))?;

    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let content_prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut key = [0_u8; 16];
    let mut nonce = [0_u8; 12];
    content_prk
        .expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .map_err(|_| Error::Crypto("could not derive Web Push content key".to_owned()))?;
    content_prk
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| Error::Crypto("could not derive Web Push nonce".to_owned()))?;
    let mut plaintext = content.to_vec();
    plaintext.push(2);
    let cipher = Aes128Gcm::new_from_slice(&key)
        .map_err(|_| Error::Crypto("could not initialize Web Push cipher".to_owned()))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| Error::Crypto("could not encrypt Web Push payload".to_owned()))?;

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&4_096_u32.to_be_bytes());
    body.push(65);
    body.extend_from_slice(sender_public.as_bytes());
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

#[derive(Serialize)]
struct VapidClaims<'a> {
    aud: &'a str,
    exp: u64,
    sub: &'static str,
}

fn vapid_authorization(key: &SigningKey, public: &[u8], audience: &str) -> Result<String> {
    let now = u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp())
        .map_err(|_| Error::Crypto("system clock precedes the Unix epoch".to_owned()))?;
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::to_vec(&VapidClaims {
        aud: audience,
        exp: now + 12 * 60 * 60,
        sub: "mailto:push@weblounge.org",
    })
    .map_err(|error| Error::Crypto(error.to_string()))?;
    let claims = URL_SAFE_NO_PAD.encode(claims);
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    let token = format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    Ok(format!(
        "vapid t={token},k={}",
        URL_SAFE_NO_PAD.encode(public)
    ))
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_documentation()
                || address.is_multicast()
                || address.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && matches!(octets[1], 18 | 19))
                || octets[0] >= 240)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public(IpAddr::V4(mapped));
            }
            if segments[..6] == [0; 6] {
                return is_public(IpAddr::V4(embedded_v4(segments[6], segments[7])));
            }
            if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
                return is_public(IpAddr::V4(embedded_v4(segments[6], segments[7])));
            }
            if segments[..3] == [0x0064, 0xff9b, 1]
                && segments[4] & 0xff00 == 0
                && segments[5].trailing_zeros() >= 8
            {
                let [first, second] = segments[3].to_be_bytes();
                let [_, third] = segments[4].to_be_bytes();
                let [fourth, _] = segments[5].to_be_bytes();
                return is_public(IpAddr::V4(Ipv4Addr::new(first, second, third, fourth)));
            }
            if segments[0] == 0x2002 {
                return is_public(IpAddr::V4(embedded_v4(segments[1], segments[2])));
            }
            if segments[..2] == [0x2001, 0] {
                let server = embedded_v4(segments[2], segments[3]);
                let client = embedded_v4(!segments[6], !segments[7]);
                return is_public(IpAddr::V4(server)) && is_public(IpAddr::V4(client));
            }

            is_global_ipv6(address)
        }
    }
}

fn embedded_v4(high: u16, low: u16) -> Ipv4Addr {
    let [first, second] = high.to_be_bytes();
    let [third, fourth] = low.to_be_bytes();
    Ipv4Addr::new(first, second, third, fourth)
}

fn is_global_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if (segments[0] & 0xe000) != 0x2000 || (segments[0] & 0xfff0) == 0x3ff0 {
        return false;
    }
    if segments[0] == 0x2001 && (segments[1] <= 0x01ff || segments[1] == 0x0db8) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use std::{net::IpAddr, time::Duration};

    use reqwest::{Certificate, StatusCode};
    use url::Url;

    use super::{HttpTransport as _, OutboundRequest, ReqwestTransport, is_public};
    use crate::test_tls::TlsServer;

    fn request(endpoint: Url, address: std::net::SocketAddr) -> OutboundRequest {
        OutboundRequest {
            endpoint,
            address,
            ttl: 60,
            authorization: "vapid t=test,k=test".to_owned(),
            body: b"encrypted".to_vec(),
        }
    }

    #[tokio::test]
    async fn transport_ignores_https_proxy_and_uses_the_pinned_address() {
        let server = TlsServer::start(
            "push.example",
            b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
        let root = Certificate::from_der(server.certificate()).expect("test root");
        let transport = ReqwestTransport::with_root_certificate(root);

        temp_env::async_with_vars([("HTTPS_PROXY", Some("http://127.0.0.1:9"))], async {
            let status = tokio::time::timeout(
                Duration::from_secs(2),
                transport.send(request(
                    Url::parse(&format!("https://push.example:{}/send", server.port()))
                        .expect("URL"),
                    server.address(),
                )),
            )
            .await
            .expect("request completed")
            .expect("request succeeded");
            assert_eq!(status, StatusCode::CREATED);
        })
        .await;
        assert_eq!(server.requests(), 1);
    }

    #[tokio::test]
    async fn transport_does_not_follow_redirects() {
        let destination = TlsServer::start(
            "destination.example",
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: https://destination.example:{}/stolen\r\nContent-Length: 0\r\n\r\n",
            destination.port(),
        );
        let source = TlsServer::start("push.example", response.into_bytes()).await;
        let root = Certificate::from_der(source.certificate()).expect("test root");
        let transport = ReqwestTransport::with_root_certificate(root);

        let status = transport
            .send(request(
                Url::parse(&format!("https://push.example:{}/send", source.port())).expect("URL"),
                source.address(),
            ))
            .await
            .expect("redirect response");
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(source.requests(), 1);
        assert_eq!(destination.requests(), 0);
    }

    #[test]
    fn public_address_policy_rechecks_special_ipv6_encodings() {
        for address in [
            "100.64.0.1",
            "192.0.0.1",
            "192.88.99.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "64:ff9b:1:a00:0001::",
            "2002:0a00:0001::",
            "2001:0000:0808:0808:0000:0000:f5ff:fffe",
            "fec0::1",
            "100::1",
            "fe80::1",
            "fc00::1",
            "::1",
        ] {
            let address = address.parse::<IpAddr>().expect("test address");
            assert!(!is_public(address), "{address} must be refused");
        }

        for address in [
            "8.8.8.8",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "::8.8.8.8",
            "64:ff9b::808:808",
            "64:ff9b:1:808:0008:0800::",
            "2002:0808:0808::",
            "2001:0000:0808:0808:0000:0000:f7f7:f7f7",
        ] {
            let address = address.parse::<IpAddr>().expect("test address");
            assert!(is_public(address), "{address} must be allowed");
        }
    }
}
