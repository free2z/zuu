//! Upload admission and early body deadlines on real sockets.
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod support;
use async_trait::async_trait;
use axum::http::{HeaderMap, StatusCode};
use f2z_ai::{
    ApiFailure,
    auth::{Admitted, Gatekeeper},
    chat::NotImplemented,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use support::*;
use tokio::{io::AsyncWriteExt, net::TcpStream};

struct TestGate {
    held: AtomicUsize,
    release: tokio::sync::Notify,
}
#[async_trait]
impl Gatekeeper for TestGate {
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        if headers.contains_key("x-hold-auth") {
            self.held.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
        }
        let mut admitted = OpenGate.admit(headers).await?;
        if let Some(user) = headers.get("x-test-user") {
            admitted.principal.sub = user.to_str().unwrap().into();
        }
        Ok(admitted)
    }
}
async fn setup(gate: Arc<TestGate>) -> Running {
    let mut dependencies = deps(
        fixed_catalog(),
        Arc::new(NotImplemented),
        RecordingSettler::default(),
    );
    dependencies.gate = gate;
    let running = start(&config(&[]), dependencies).await;
    wait_readyz(running.admin, StatusCode::OK).await;
    running
}
fn gate() -> Arc<TestGate> {
    Arc::new(TestGate {
        held: AtomicUsize::new(0),
        release: tokio::sync::Notify::new(),
    })
}

#[tokio::test]
async fn forwarded_headers_do_not_bypass_pre_auth_peer_limit() {
    let gate = gate();
    let running = setup(gate.clone()).await;
    let mut held = Vec::new();
    for n in 0..16 {
        let mut socket = TcpStream::connect(running.public).await.unwrap();
        socket.write_all(format!("POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nContent-Length: 0\r\nX-Hold-Auth: yes\r\nX-Forwarded-For: 192.0.2.{n}\r\n\r\n").as_bytes()).await.unwrap();
        held.push(socket);
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while gate.held.load(Ordering::SeqCst) < 16 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let response = raw(running.public, b"POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nContent-Length: 0\r\nX-Hold-Auth: yes\r\nX-Forwarded-For: 203.0.113.7\r\n\r\n", Duration::from_secs(1)).await;
    assert!(response.starts_with("HTTP/1.1 503"), "{response}");
    assert_eq!(gate.held.load(Ordering::SeqCst), 16);
    gate.release.notify_waiters();
    drop(held);
}

#[tokio::test]
async fn stalled_uploads_are_limited_per_verified_user_and_first_byte() {
    let running = setup(gate()).await;
    let mut held = Vec::new();
    let header = b"POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nContent-Length: 20971520\r\nX-Test-User: alice\r\n\r\n";
    for _ in 0..2 {
        let mut socket = TcpStream::connect(running.public).await.unwrap();
        socket.write_all(header).await.unwrap();
        held.push(socket);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let response = raw(running.public, header, Duration::from_secs(1)).await;
    assert!(response.starts_with("HTTP/1.1 503"), "{response}");
    let mut request = chat_request(valid_chat("other user still works").to_string());
    request
        .headers_mut()
        .insert("x-test-user", "bob".parse().unwrap());
    assert_eq!(
        send(running.public, request).await.status(),
        StatusCode::NOT_IMPLEMENTED
    );
    use tokio::io::AsyncReadExt;
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        held[0].read_to_string(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(response.contains("first_byte_timeout"), "{response}");
    drop(held);
    let mut request = chat_request(valid_chat("alice capacity recovered").to_string());
    request
        .headers_mut()
        .insert("x-test-user", "alice".parse().unwrap());
    assert_eq!(
        send(running.public, request).await.status(),
        StatusCode::NOT_IMPLEMENTED
    );
}

#[tokio::test]
async fn chunked_upload_without_first_data_times_out_early() {
    let running = setup(gate()).await;
    let response = raw(running.public,
        b"POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
        Duration::from_secs(3)).await;
    assert!(response.contains("first_byte_timeout"), "{response}");
}

#[tokio::test]
async fn shared_ingress_can_size_pending_slow_auth_above_default() {
    let gate = gate();
    let mut dependencies = deps(
        fixed_catalog(),
        Arc::new(NotImplemented),
        RecordingSettler::default(),
    );
    dependencies.gate = gate.clone();
    let running = start(
        &config(&[("F2Z_AI_MAX_PRE_AUTH_UPLOADS_PER_PEER", "32")]),
        dependencies,
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let mut held = Vec::new();
    for _ in 0..20 {
        let mut socket = TcpStream::connect(running.public).await.unwrap();
        socket.write_all(b"POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nContent-Length: 0\r\nX-Hold-Auth: yes\r\n\r\n").await.unwrap();
        held.push(socket);
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while gate.held.load(Ordering::SeqCst) < 20 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("configured ingress allowance did not admit slow checks beyond the default16");
    assert_eq!(
        post_chat(
            running.public,
            &valid_chat("same ingress, unrelated caller")
        )
        .await
        .status(),
        StatusCode::NOT_IMPLEMENTED
    );
    gate.release.notify_waiters();
    drop(held);
}
