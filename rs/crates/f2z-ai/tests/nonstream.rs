//! Nonstreaming delivery shares the detached pipeline and its billing owner.
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
mod support;
use axum::http::StatusCode;
use f2z_ai::settle::UpstreamEnd;
use f2z_ai_proto::chat::{ChatResponse, FinishReason};
use f2z_ai_proto::event::{Done, Meta};
use f2z_ai_proto::{Event, Whole2z};
use serde_json::{Value, json};
use std::time::Duration;
use support::*;
use tokio::io::AsyncWriteExt as _;

fn request() -> axum::http::Request<axum::body::Body> {
    let mut value = valid_chat("hello");
    value["stream"] = json!(false);
    chat_request(value.to_string())
}
fn meta() -> Event {
    Event::Meta(Meta::new("call-1", "model", Whole2z::new(2)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_success_is_not_reported_as_zero_charge() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let running = start(&config(&[]), deps(fixed_catalog(), backend, settler)).await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let addr = running.public;
    let client = tokio::spawn(async move { send(addr, request()).await });
    let upstream = streams.recv().await.unwrap();
    upstream.send(meta()).await.unwrap();
    upstream.send(delta("Hello")).await.unwrap();
    upstream.send(usage(5)).await.unwrap();
    upstream
        .send(Event::Done(Done::pending(
            Whole2z::new(2),
            FinishReason::ContentFilter,
        )))
        .await
        .unwrap();
    drop(upstream);
    let response = client.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let reply: ChatResponse = serde_json::from_str(&text(response).await).unwrap();
    reply.check().unwrap();
    assert_eq!(reply.settlement, f2z_ai_proto::Settlement::Pending);
    assert_eq!(reply.charged_2z, None);
    assert_eq!(reply.receipt_id, None);
    assert_eq!(reply.message.text(), "Hello");
    assert_eq!(reply.finish_reason, FinishReason::ContentFilter);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aggregate_overflow_returns_pending_and_provider_still_finishes() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let running = start(
        &config(&[("F2Z_AI_DELIVERY_BUFFER_BYTES", "2097152")]),
        deps(fixed_catalog(), backend, settler.clone()),
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let addr = running.public;
    let client = tokio::spawn(async move { send(addr, request()).await });
    let upstream = streams.recv().await.unwrap();
    upstream.send(meta()).await.unwrap();
    // Individually legal frames; total output exceeds the response reservation.
    for _ in 0..300 {
        upstream.send(delta(&"x".repeat(4096))).await.unwrap();
        tokio::task::yield_now().await;
    }
    let response = tokio::time::timeout(Duration::from_secs(3), client)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let value: Value = serde_json::from_str(&text(response).await).unwrap();
    assert_eq!(value["error"]["code"], "internal");
    assert_eq!(value["error"]["details"]["reason"], "response_limit");
    assert_eq!(value["error"]["details"]["settlement"], "pending");
    assert!(value["error"]["details"].get("charged_2z").is_none());
    upstream.send(usage(99)).await.unwrap();
    drop(upstream);
    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].usage.unwrap().output_tokens, 99);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnected_nonstream_client_does_not_cancel_provider_or_settlement() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let running = start(
        &config(&[]),
        deps(fixed_catalog(), backend, settler.clone()),
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let mut client = tokio::net::TcpStream::connect(running.public)
        .await
        .unwrap();
    let mut value = valid_chat("hello");
    value["stream"] = json!(false);
    let body = value.to_string();
    client.write_all(format!("POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let upstream = streams.recv().await.unwrap();
    upstream.send(meta()).await.unwrap();
    drop(client);
    for _ in 0..50 {
        upstream.send(delta("after disconnect")).await.unwrap();
    }
    upstream.send(usage(123)).await.unwrap();
    drop(upstream);
    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].usage.unwrap().output_tokens, 123);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_deadline_returns_reconcilable_pending_before_outer_timeout() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let running = start(
        &config(&[("F2Z_AI_REQUEST_TIMEOUT_SECS", "1")]),
        deps(fixed_catalog(), backend, settler.clone()),
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let addr = running.public;
    let client = tokio::spawn(async move { send(addr, request()).await });
    let upstream = streams.recv().await.unwrap();
    upstream.send(meta()).await.unwrap();
    upstream.send(delta("still working")).await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(3), client)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let value: Value = serde_json::from_str(&text(response).await).unwrap();
    assert_eq!(value["error"]["details"]["call_id"], "call-1");
    assert_eq!(value["error"]["details"]["settlement"], "pending");
    upstream.send(usage(12)).await.unwrap();
    drop(upstream);
    assert_eq!(
        wait_records(&settler, 1).await[0]
            .usage
            .unwrap()
            .output_tokens,
        12
    );
}
