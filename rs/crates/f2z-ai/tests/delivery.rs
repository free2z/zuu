//! Client backpressure never reaches the upstream (chat-api.md §2.4, ADR
//! 0001): a client that does not read cannot slow the upstream read; its
//! delivery ends — buffer full, or stalled — with `delivery_aborted` and
//! `settlement: "pending"`, while the call is read to its usage and settled.
//! And a call counts against the limit until its settle returns.
//!
//! The non-reading client is a raw socket with a small receive buffer that
//! never reads until the end, so the kernel's socket buffers fill and the
//! gateway's own per-stream buffer is what takes the rest.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::http::StatusCode;
use f2z_ai::settle::{CallRecord, Delivery, Settler, UpstreamEnd};
use f2z_ai::{Deps, Gateway};
use support::*;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::{Notify, mpsc};

/// Open a streamed call from a client that will not read.
async fn stalled_client(public: SocketAddr) -> TcpStream {
    let socket = TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let mut stream = socket.connect(public).await.unwrap();
    let body = valid_chat("please be slow").to_string();
    let request = format!(
        "POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}

/// Push `count` deltas of `size` bytes, each within a deadline that only a
/// throttled upstream read could miss.
async fn push_fast(upstream: &mpsc::Sender<f2z_ai_proto::Event>, count: usize, size: usize) {
    let text = "x".repeat(size);
    for _ in 0..count {
        tokio::time::timeout(Duration::from_secs(2), upstream.send(delta(&text)))
            .await
            .expect("the upstream read was throttled by the client")
            .unwrap();
    }
}

/// The gateway drops the connection within a few seconds, without the client
/// reading anything first... apart from what the kernel already buffered.
async fn assert_connection_closed(mut client: TcpStream) {
    let mut sink = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(6), client.read_to_end(&mut sink)).await;
    assert!(closed.is_ok(), "the connection was never dropped");
}

async fn read_everything(mut client: TcpStream) -> String {
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), client.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_delivery_buffer_aborts_delivery_and_the_upstream_is_read_to_its_usage() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[("F2Z_AI_DELIVERY_BUFFER_BYTES", "65536")]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let client = stalled_client(running.public).await;
    let upstream = streams.recv().await.unwrap();
    // 16 MiB: more than every socket buffer between here and the client.
    push_fast(&upstream, 1024, 16 * 1024).await;
    wait_metric(
        running.admin,
        "f2z_ai_delivery_aborted_total{reason=\"buffer_full\"} ",
        "1",
    )
    .await;
    // The upstream is still read after delivery ended.
    push_fast(&upstream, 64, 16 * 1024).await;
    upstream.send(usage(99)).await.unwrap();
    drop(upstream);

    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].delivery, Delivery::BufferFull);
    assert_eq!(records[0].usage.unwrap().output_tokens, 99);
    assert_eq!(
        metric(running.admin, "f2z_ai_delivery_buffered_bytes ").await,
        "0"
    );

    // When the client finally reads, delivery ends with delivery_aborted and
    // then the connection closes — well before the 30 s kill — so it can
    // never be reused for another request (it would inherit this one's end).
    let started = std::time::Instant::now();
    let seen = read_everything(client).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the connection stayed open after the aborted delivery"
    );
    assert!(
        seen.starts_with("HTTP/1.1 200"),
        "{}",
        &seen[..seen.len().min(200)]
    );
    assert!(
        seen.contains("\"code\":\"delivery_aborted\""),
        "no delivery_aborted"
    );
    assert!(seen.contains("\"settlement\":\"pending\""));
    assert!(
        !seen.contains("\"output_tokens\":99"),
        "delivered past the abort"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_delivery_progress_for_the_stall_limit_aborts_delivery_only() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[
        ("F2Z_AI_DELIVERY_STALL_SECS", "1"),
        ("F2Z_AI_DELIVERY_BUFFER_BYTES", "268435456"),
    ]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let client = stalled_client(running.public).await;
    let upstream = streams.recv().await.unwrap();
    push_fast(&upstream, 1024, 16 * 1024).await;
    let before = metric(running.admin, "f2z_ai_delivery_buffered_bytes ").await;
    assert_ne!(before, "0", "nothing was waiting in the buffer");
    wait_metric(
        running.admin,
        "f2z_ai_delivery_aborted_total{reason=\"stalled\"} ",
        "1",
    )
    .await;
    assert_eq!(
        metric(running.admin, "f2z_ai_delivery_buffered_bytes ").await,
        "0"
    );
    // Even if the socket deadline already closed delivery, the running
    // upstream still owns its call slot until settlement completes.
    assert_eq!(metric(running.admin, "f2z_ai_active_streams ").await, "1");
    push_fast(&upstream, 16, 1024).await;
    upstream.send(usage(7)).await.unwrap();
    drop(upstream);

    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].delivery, Delivery::Stalled);
    assert_eq!(records[0].usage.unwrap().output_tokens, 7);

    // The socket deadline may already have closed this unread connection;
    // either timer ordering must release the slot after settlement.
    assert_connection_closed(client).await;
    wait_metric(running.admin, "f2z_ai_active_streams ", "0").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delivery_that_stalls_after_the_upstream_ended_is_still_bounded() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[
        // Sending 16 MiB can take over a second on a shared CI runner.
        ("F2Z_AI_DELIVERY_STALL_SECS", "5"),
        ("F2Z_AI_DELIVERY_BUFFER_BYTES", "268435456"),
    ]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    // The provider finishes at once, with most of its output undelivered.
    let client = stalled_client(running.public).await;
    let upstream = streams.recv().await.unwrap();
    push_fast(&upstream, 1024, 16 * 1024).await;
    upstream.send(usage(5)).await.unwrap();
    drop(upstream);
    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].delivery, Delivery::Open);
    // Settled, but its delivery still holds the slot and the buffer...
    assert_eq!(metric(running.admin, "f2z_ai_active_streams ").await, "1");
    assert_ne!(
        metric(running.admin, "f2z_ai_delivery_buffered_bytes ").await,
        "0"
    );
    // ...until the stall rule, still running after the upstream ended, ends it.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if metric(
                running.admin,
                "f2z_ai_delivery_aborted_total{reason=\"stalled\"} ",
            )
            .await
                == "1"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("post-upstream delivery did not reach its five-second stall deadline");
    assert_eq!(
        metric(running.admin, "f2z_ai_delivery_buffered_bytes ").await,
        "0"
    );
    assert_connection_closed(client).await;
    wait_metric(running.admin, "f2z_ai_active_streams ", "0").await;
}

/// A settler that holds each settle until released.
struct GatedSettler {
    gate: Arc<Notify>,
    records: RecordingSettler,
}

#[async_trait]
impl Settler for GatedSettler {
    async fn settle(&self, record: CallRecord) {
        self.gate.notified().await;
        self.records.settle(record).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnected_call_counts_against_the_limit_until_its_settle_returns() {
    let (backend, mut streams) = ControlledBackend::new();
    let gate = Arc::new(Notify::new());
    let records = RecordingSettler::default();
    let config = config(&[("F2Z_AI_MAX_CONCURRENT_CALLS", "1")]);
    let gateway = Gateway::bind(
        &config,
        Deps {
            gate: support::open_gate(),
            catalog: fixed_catalog(),
            backend,
            settler: Arc::new(GatedSettler {
                gate: Arc::clone(&gate),
                records: records.clone(),
            }),
        },
    )
    .await
    .unwrap();
    let (public, admin) = (gateway.public_addr(), gateway.admin_addr());
    wait_readyz(admin, StatusCode::OK).await;

    let response = post_chat(public, &valid_chat("one")).await;
    let upstream = streams.recv().await.unwrap();
    drop(response);
    upstream.send(usage(1)).await.unwrap();
    drop(upstream);
    // The upstream is done and the client is gone; the settle is held.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let refused = post_chat(public, &valid_chat("two")).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(metric(admin, "f2z_ai_active_streams ").await, "1");

    gate.notify_one();
    wait_records(&records, 1).await;
    wait_metric(admin, "f2z_ai_active_streams ", "0").await;
    let admitted = post_chat(public, &valid_chat("three")).await;
    assert_eq!(admitted.status(), StatusCode::OK);
    drop(gateway);
}

// zuu#1128: `tool_call_delta` fragments are informational and repeat what the
// complete `tool_call` carries, so they must never be what fills the buffer:
// under backpressure they are dropped, and the authoritative call still fits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_call_fragments_never_fill_the_buffer_the_call_needs() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[("F2Z_AI_DELIVERY_BUFFER_BYTES", "65536")]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let _client = stalled_client(running.public).await;
    let upstream = streams.recv().await.unwrap();
    // 16 MiB of fragments — what fills every socket buffer and then some.
    let piece = "x".repeat(16 * 1024);
    for _ in 0..1024 {
        let fragment = f2z_ai_proto::Event::ToolCallDelta(f2z_ai_proto::event::ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments: piece.clone(),
        });
        tokio::time::timeout(Duration::from_secs(2), upstream.send(fragment))
            .await
            .expect("the upstream read was throttled by the client")
            .unwrap();
    }
    // The complete call is larger than the half of the buffer fragments may
    // use, so it fits only if the waiting fragments make way for it.
    let call = f2z_ai_proto::Event::ToolCall(f2z_ai_proto::chat::ToolCall {
        id: "call_1".into(),
        name: "check_answer".into(),
        arguments: "y".repeat(48 * 1024),
    });
    upstream.send(call).await.unwrap();
    upstream.send(usage(99)).await.unwrap();
    drop(upstream);

    let records = wait_records(&settler, 1).await;
    assert_ne!(records[0].delivery, Delivery::BufferFull);
    assert_eq!(
        metric(
            running.admin,
            "f2z_ai_delivery_aborted_total{reason=\"buffer_full\"} "
        )
        .await,
        "0"
    );
}
