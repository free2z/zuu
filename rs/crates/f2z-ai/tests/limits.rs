//! Body limits (chat-api.md §1: 4 MiB without image parts, 20 MiB with),
//! decoding, readiness on the catalogue, and the skeleton's `501`.
//!
//! The limits are exercised at their **default** values — the config these
//! tests load sets no body limit — so a changed default fails here.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::StatusCode;
use bytes::Bytes;
use f2z_ai::catalog;
use f2z_ai::chat::NotImplemented;
use serde_json::{Value, json};
use support::*;
use tokio::sync::mpsc;

const MIB: usize = 1024 * 1024;

async fn gateway(overrides: &[(&str, &str)]) -> Running {
    let running = start(
        &config(overrides),
        deps(
            fixed_catalog(),
            Arc::new(NotImplemented),
            RecordingSettler::default(),
        ),
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    running
}

/// A valid request whose serialized size is exactly `size` bytes, text only.
fn text_request_of_size(size: usize) -> Vec<u8> {
    let empty = valid_chat("").to_string().len();
    valid_chat(&"a".repeat(size - empty))
        .to_string()
        .into_bytes()
}

/// A valid request of about `size` bytes whose bulk is one image part.
fn image_request_of_size(size: usize) -> Vec<u8> {
    let data = "A".repeat((size / 4) * 4);
    json!({
        "model": "example-large",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "what is this?"},
            {"type": "image", "media_type": "image/png", "data": data}
        ]}],
    })
    .to_string()
    .into_bytes()
}

async fn post_bytes(running: &Running, body: Vec<u8>) -> (StatusCode, Value) {
    let response = send(running.public, chat_request(body)).await;
    let status = response.status();
    let error = error_of(response).await;
    (status, error)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_text_request_at_4_mib_is_accepted_and_one_byte_over_is_413() {
    let running = gateway(&[]).await;

    let (status, error) = post_bytes(&running, text_request_of_size(4 * MIB)).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{error}");
    assert_eq!(error["code"], "not_implemented");

    let (status, error) = post_bytes(&running, text_request_of_size(4 * MIB + 1)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{error}");
    assert_eq!(error["code"], "payload_too_large");
    assert_eq!(error["details"]["limit_bytes"], 4 * MIB);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_with_an_image_may_use_up_to_20_mib() {
    let running = gateway(&[]).await;

    let (status, error) = post_bytes(&running, image_request_of_size(12 * MIB)).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{error}");

    let near = image_request_of_size(20 * MIB - 4096);
    assert!(near.len() > 20 * MIB - 4096 && near.len() <= 20 * MIB);
    let (status, error) = post_bytes(&running, near).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{error}");
    // Over 20 MiB with a Content-Length is refused before the body is read,
    // so a client writing it sees a broken pipe rather than the 413; that
    // path is `a_declared_length_over_20_mib_is_refused_before_the_body_is_sent`
    // and the chunked one is `a_chunked_body_over_20_mib_is_cut_off_at_the_limit`.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_declared_length_over_20_mib_is_refused_before_the_body_is_sent() {
    let running = gateway(&[]).await;
    // Headers only: if the gateway waited for the body it would never answer.
    let head = format!(
        "POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n",
        20 * MIB + 1
    );
    let response = raw(running.public, head.as_bytes(), Duration::from_secs(3)).await;
    assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    assert!(response.contains("\"limit_bytes\":20971520"), "{response}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chunked_body_over_20_mib_is_cut_off_at_the_limit() {
    let running = gateway(&[]).await;
    // No Content-Length: the limit has to hold while reading.
    let (tx, rx) = mpsc::channel::<Bytes>(4);
    tokio::spawn(async move {
        let chunk = Bytes::from(vec![b' '; MIB]);
        for _ in 0..21 {
            if tx.send(chunk.clone()).await.is_err() {
                return;
            }
        }
    });
    let response = send(running.public, chat_request(Body::new(ChannelBody(rx)))).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_of(response).await["details"]["limit_bytes"], 20 * MIB);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_never_finishes_arriving_is_refused_at_the_read_timeout() {
    let running = gateway(&[("F2Z_AI_BODY_READ_TIMEOUT_SECS", "1")]).await;
    let head = "POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\n\
                Content-Length: 100\r\n\r\n{\"model\":";
    let response = raw(running.public, head.as_bytes(), Duration::from_secs(4)).await;
    assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    assert!(response.contains("\"reason\":\"timeout\""), "{response}");
    assert_eq!(
        metric(running.admin, "f2z_ai_active_streams ").await,
        "0",
        "the slow upload's slot was not released"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decoding_is_strict_and_the_skeleton_answers_501() {
    let running = gateway(&[]).await;

    let (status, error) = post_bytes(&running, valid_chat("hi").to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(error["code"], "not_implemented");

    let mut unknown = valid_chat("hi");
    unknown["temperature"] = json!(0.2);
    let (status, error) = post_bytes(&running, unknown.to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_request");
    assert_eq!(error["details"]["reason"], "schema");

    let (status, error) = post_bytes(&running, b"{\"model\":".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["details"]["reason"], "eof");

    let no_messages = json!({"model": "example-large", "messages": []});
    let (status, error) = post_bytes(&running, no_messages.to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["details"]["field"], "messages");

    let wrong_type = axum::http::Request::post("/v1/chat")
        .header("host", "g")
        .header("content-type", "text/plain")
        .body(Body::from(valid_chat("hi").to_string()))
        .unwrap();
    let response = send(running.public, wrong_type).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(error_of(response).await["details"]["field"], "Content-Type");

    let (status, _) = get(running.public, "/v1/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_verified_catalogue_the_gateway_is_not_ready_and_prices_nothing() {
    let running = start(
        &config(&[]),
        deps(
            Arc::new(catalog::Unconfigured),
            Arc::new(NotImplemented),
            RecordingSettler::default(),
        ),
    )
    .await;
    // Give the poller its first attempt.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, why) = get(running.admin, "/readyz").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(why.contains("catalogue"), "{why}");
    assert_eq!(get(running.admin, "/healthz").await.0, StatusCode::OK);
    assert_eq!(metric(running.admin, "f2z_ai_ready ").await, "0");
    assert_eq!(metric(running.admin, "f2z_ai_catalog_version ").await, "0");

    let response = post_chat(running.public, &valid_chat("hi")).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_of(response).await["code"], "catalog_unavailable");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_a_verified_catalogue_the_gateway_is_ready_and_reports_its_version() {
    let running = gateway(&[]).await;
    assert_eq!(metric(running.admin, "f2z_ai_ready ").await, "1");
    assert_eq!(
        metric(running.admin, "f2z_ai_catalog_version ").await,
        fresh_catalog().catalog().version.to_string()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_bodies_in_flight_are_bounded_gateway_wide() {
    let running = gateway(&[
        ("F2Z_AI_MAX_BODY_BYTES", "10000"),
        ("F2Z_AI_MAX_BODY_BYTES_WITH_IMAGES", "40000"),
        ("F2Z_AI_MAX_UPLOAD_BUFFER_BYTES", "60000"),
        ("F2Z_AI_BODY_READ_TIMEOUT_SECS", "5"),
        ("F2Z_AI_RETRY_AFTER_SECS", "2"),
    ])
    .await;
    // One upload declares 40000 bytes and sends none of them: it holds 40000
    // of the 60000-byte budget while it waits.
    let slow = "POST /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Type: application/json\r\n\
                Content-Length: 40000\r\n\r\n";
    let mut holder = tokio::net::TcpStream::connect(running.public)
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut holder, slow.as_bytes())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A second that would need 40000 more is refused before it is read.
    let refused = raw(running.public, slow.as_bytes(), Duration::from_secs(2)).await;
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert!(
        refused.to_ascii_lowercase().contains("retry-after: 2"),
        "{refused}"
    );
    assert_eq!(
        metric(
            running.admin,
            "f2z_ai_rejected_total{reason=\"upload_budget\"} "
        )
        .await,
        "1"
    );
    // A small one still fits in what is left.
    let (status, _) = post_bytes(&running, valid_chat("hi").to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    drop(holder);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_sent_as_one_byte_chunks_is_read_into_one_buffer_and_decodes() {
    let running = gateway(&[]).await;
    let body = valid_chat("tiny chunks").to_string().into_bytes();
    let (tx, rx) = mpsc::channel::<Bytes>(body.len());
    for byte in body {
        tx.send(Bytes::from(vec![byte])).await.unwrap();
    }
    drop(tx);
    let response = send(running.public, chat_request(Body::new(ChannelBody(rx)))).await;
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
}
