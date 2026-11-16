use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use axum::body::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::{Request, Response, body::Incoming, server::conn::http2, service::service_fn};
use hyper_util::rt::{TokioExecutor, TokioIo};
use reqwest::{StatusCode, Version, header::HeaderMap};

use crate::test_tls::{loopback_listener, self_signed_acceptor};

/// One request as the fake APNs server received it.
#[derive(Clone, Debug)]
pub(crate) struct ApnsRequest {
    pub version: Version,
    pub authority: String,
    pub path: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

type Replies = Arc<Mutex<VecDeque<(StatusCode, &'static str)>>>;

/// An HTTP/2-only TLS server that records requests and answers with queued replies.
pub(crate) struct FakeApns {
    address: std::net::SocketAddr,
    certificate: Vec<u8>,
    requests: Arc<Mutex<Vec<ApnsRequest>>>,
    replies: Replies,
    task: tokio::task::JoinHandle<()>,
}

impl FakeApns {
    pub(crate) async fn start(hosts: &[&str]) -> Self {
        let (acceptor, certificate) = self_signed_acceptor(hosts, &[b"h2"]);
        let listener = loopback_listener().await;
        let address = listener.local_addr().expect("APNs address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let replies: Replies = Arc::new(Mutex::new(VecDeque::new()));
        let (seen, queued) = (Arc::clone(&requests), Arc::clone(&replies));
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(stream) = acceptor.accept(stream).await else {
                    continue;
                };
                let (seen, queued) = (Arc::clone(&seen), Arc::clone(&queued));
                let service = service_fn(move |request| {
                    respond(request, Arc::clone(&seen), Arc::clone(&queued))
                });
                tokio::spawn(
                    http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(stream), service),
                );
            }
        });
        Self {
            address,
            certificate,
            requests,
            replies,
            task,
        }
    }

    /// Queues the status and JSON body of a later reply; unqueued requests get `200 OK`.
    pub(crate) fn reply(&self, status: StatusCode, body: &'static str) {
        self.replies
            .lock()
            .expect("APNs replies")
            .push_back((status, body));
    }

    pub(crate) fn address(&self) -> std::net::SocketAddr {
        self.address
    }

    pub(crate) fn certificate(&self) -> &[u8] {
        &self.certificate
    }

    pub(crate) fn requests(&self) -> Vec<ApnsRequest> {
        self.requests.lock().expect("APNs requests").clone()
    }
}

async fn respond(
    request: Request<Incoming>,
    seen: Arc<Mutex<Vec<ApnsRequest>>>,
    queued: Replies,
) -> hyper::Result<Response<Full<Bytes>>> {
    let (parts, body) = request.into_parts();
    let body = body.collect().await?.to_bytes().to_vec();
    seen.lock().expect("APNs requests").push(ApnsRequest {
        version: parts.version,
        authority: parts
            .uri
            .authority()
            .map(ToString::to_string)
            .unwrap_or_default(),
        path: parts.uri.path().to_owned(),
        headers: parts.headers,
        body,
    });
    let (status, body) = queued
        .lock()
        .expect("APNs replies")
        .pop_front()
        .unwrap_or((StatusCode::OK, ""));
    Ok(Response::builder()
        .status(status)
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("APNs response"))
}

impl Drop for FakeApns {
    fn drop(&mut self) {
        self.task.abort();
    }
}
