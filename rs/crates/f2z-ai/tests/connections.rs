//! Connection admission happens before headers, and stalled socket writes
//! cannot retain a connection slot after response-body delivery has ended.
#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use axum::http::StatusCode;
use axum::{Router, routing::get as route_get};
use f2z_ai::chat::NotImplemented;
use f2z_ai::serve::{Limits, serve};
use std::sync::Arc;
use std::time::Duration;
use support::*;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

#[tokio::test]
async fn incomplete_header_flood_is_refused_while_admin_remains_available() {
    let running = start(
        &config(&[
            ("F2Z_AI_MAX_CONNECTIONS", "2"),
            ("F2Z_AI_MAX_ADMIN_CONNECTIONS", "2"),
        ]),
        deps(
            fixed_catalog(),
            Arc::new(NotImplemented),
            RecordingSettler::default(),
        ),
    )
    .await;
    let mut held = Vec::new();
    for _ in 0..2 {
        let mut stream = TcpStream::connect(running.public).await.unwrap();
        stream
            .write_all(b"POST /v1/chat HTTP/1.1\r\n")
            .await
            .unwrap();
        held.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    for _ in 0..32 {
        let mut excess = TcpStream::connect(running.public).await.unwrap();
        let mut byte = [0];
        let closed = tokio::time::timeout(Duration::from_millis(300), excess.read(&mut byte)).await;
        assert!(
            matches!(closed, Ok(Ok(0) | Err(_))),
            "excess socket retained without a permit"
        );
        assert_eq!(get(running.admin, "/healthz").await.0, StatusCode::OK);
    }
    assert_eq!(
        metric(
            running.admin,
            "f2z_ai_connections_active{listener=\"public\"} "
        )
        .await,
        "2"
    );
    assert_eq!(
        metric(
            running.admin,
            "f2z_ai_connections_rejected_total{listener=\"public\"} "
        )
        .await,
        "32"
    );
    drop(held);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        metric(
            running.admin,
            "f2z_ai_connections_active{listener=\"public\"} "
        )
        .await,
        "0"
    );
    assert_eq!(
        get(running.public, "/unknown").await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn socket_write_stall_releases_the_connection_permit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/large",
            route_get(|| async { vec![b'x'; 32 * 1024 * 1024] }),
        )
        .route("/healthz", route_get(|| async { "ok" }));
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(serve(
        listener,
        router,
        Limits {
            connections: 1,
            header_read: Duration::from_secs(5),
            write_stall: Duration::from_millis(50),
        },
        None,
        stopped,
        Duration::from_millis(100),
    ));
    let mut unread = TcpStream::connect(addr).await.unwrap();
    unread
        .write_all(b"GET /large HTTP/1.1\r\nHost: test\r\n\r\n")
        .await
        .unwrap();
    // The socket's send window fills even though the response Body is complete.
    // No read from this client releases it: only the production IO timer can.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let response = raw(
        addr,
        b"GET /healthz HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n",
        Duration::from_secs(2),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "stalled response kept the sole connection permit: {response}"
    );
    stop.send_replace(true);
    task.await.unwrap();
}
