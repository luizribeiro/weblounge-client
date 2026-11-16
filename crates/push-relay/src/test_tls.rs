use std::{net::IpAddr, sync::Arc};

use rcgen::{CertifiedKey, generate_simple_self_signed};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer},
};

pub(crate) struct TlsServer {
    address: std::net::SocketAddr,
    certificate: Vec<u8>,
    requests: Arc<std::sync::atomic::AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

/// A TLS acceptor for `hosts` that offers `alpn`, and its DER certificate to trust.
pub(crate) fn self_signed_acceptor(hosts: &[&str], alpn: &[&[u8]]) -> (TlsAcceptor, Vec<u8>) {
    let CertifiedKey { cert, signing_key } = generate_simple_self_signed(
        hosts
            .iter()
            .map(|host| (*host).to_owned())
            .collect::<Vec<_>>(),
    )
    .expect("test certificate");
    let key = PrivatePkcs8KeyDer::from(signing_key.serialize_der());
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], key.into())
        .expect("TLS config");
    config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
    (TlsAcceptor::from(Arc::new(config)), cert.der().to_vec())
}

pub(crate) async fn loopback_listener() -> TcpListener {
    TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0))
        .await
        .expect("TLS listener")
}

impl TlsServer {
    pub(crate) async fn start(host: &str, response: impl Into<Vec<u8>>) -> Self {
        let (acceptor, certificate) = self_signed_acceptor(&[host], &[]);
        let listener = loopback_listener().await;
        let address = listener.local_addr().expect("TLS address");
        let response = Arc::new(response.into());
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let response = Arc::clone(&response);
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut request = vec![0_u8; 16 * 1024];
                    if stream.read(&mut request).await.is_ok() {
                        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = stream.write_all(&response).await;
                    }
                });
            }
        });
        Self {
            address,
            certificate,
            requests,
            task,
        }
    }

    pub(crate) fn address(&self) -> std::net::SocketAddr {
        self.address
    }

    pub(crate) fn port(&self) -> u16 {
        self.address.port()
    }

    pub(crate) fn certificate(&self) -> &[u8] {
        &self.certificate
    }

    pub(crate) fn requests(&self) -> usize {
        self.requests.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for TlsServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
