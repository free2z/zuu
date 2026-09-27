//! OpenTelemetry, end to end: with `otlp_endpoint` set, request spans reach a
//! collector over OTLP/HTTP with the configured `authorization` header — and
//! the exported payload carries no prompt. (Off-by-default is a unit test in
//! `src/telemetry.rs`: no endpoint, no provider.)
//!
//! The collector is a plain socket on its own thread, recording what it is
//! sent. The exporter's client is blocking, so this test does what `main`
//! does: telemetry is initialised before the runtime and shut down after it.
//!
//! One test per file: it installs the process-global subscriber.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use f2z_ai::chat::NotImplemented;
use f2z_ai::telemetry;
use support::*;

const CANARY: &str = "CANARY-9b0c-not-in-spans";

/// One recorded collector request: head (lower-cased) and body.
type Captured = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

fn collector() -> (String, Captured) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let captured: Captured = Arc::default();
    let sink = Arc::clone(&captured);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut data = Vec::new();
            let mut buf = [0u8; 65536];
            let (head, body_start) = loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break (String::new(), 0);
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (String::from_utf8_lossy(&data[..at]).to_lowercase(), at + 4);
                }
            };
            let length = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while data.len() < body_start + length {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
            }
            let body = data[body_start.min(data.len())..].to_vec();
            sink.lock().unwrap().push((head, body));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
        }
    });
    (endpoint, captured)
}

#[test]
fn spans_are_exported_to_the_configured_collector_without_prompt_content() {
    let (endpoint, captured) = collector();
    let config = config(&[
        ("F2Z_AI_OTLP_ENDPOINT", &endpoint),
        ("F2Z_AI_OTLP_AUTHORIZATION", "Bearer otlp-test-token"),
        ("F2Z_AI_LOG_LEVEL", "trace"),
    ]);
    let telemetry = telemetry::init(&config).unwrap();
    assert!(telemetry.otel_enabled());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let running = start(
            &config,
            deps(
                fixed_catalog(),
                Arc::new(NotImplemented),
                RecordingSettler::default(),
            ),
        )
        .await;
        wait_readyz(running.admin, StatusCode::OK).await;
        let response = post_chat(running.public, &valid_chat(CANARY)).await;
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        let _ = text(response).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), running.gateway.run_until(async {}))
            .await
            .unwrap();
    });
    drop(runtime);
    telemetry.shutdown();

    let captured = captured.lock().unwrap().clone();
    let traces: Vec<_> = captured
        .iter()
        .filter(|(head, _)| head.starts_with("post /v1/traces "))
        .collect();
    assert!(
        !traces.is_empty(),
        "nothing exported; saw {} requests",
        captured.len()
    );
    let (head, _) = traces[0];
    assert!(
        head.contains("content-type: application/x-protobuf"),
        "{head}"
    );
    assert!(
        head.contains("authorization: bearer otlp-test-token"),
        "{head}"
    );

    let payload: Vec<u8> = traces.iter().flat_map(|(_, body)| body.clone()).collect();
    let contains = |needle: &[u8]| payload.windows(needle.len()).any(|w| w == needle);
    // Positive control: the request span and the service name are in there.
    assert!(contains(b"f2z-ai"), "service.name missing");
    assert!(contains(b"request"), "request span missing");
    assert!(
        !contains(CANARY.as_bytes()),
        "the prompt reached an exported span"
    );
}
