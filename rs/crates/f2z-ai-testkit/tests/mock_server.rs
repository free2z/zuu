//! The mock provider over a real loopback socket: the bytes on the wire are
//! the rendered plan, pauses are real, faults reach the client as faults.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use core::time::Duration;
use std::time::Instant;

use common::adapter_usage;
use f2z_ai_testkit::mock::{
    ChatFlavor, Fault, MockProvider, ProviderStyle, RenderContext, SCENARIO_HEADER, Scenario, plan,
};
use serde_json::{Value, json};

fn request_body(style: ProviderStyle) -> Value {
    match style {
        ProviderStyle::ChatCompletions => json!({
            "model": "grok-test", "stream": true,
            "stream_options": {"include_usage": true},
            "messages": [{"role": "user", "content": "hi"}],
        }),
        ProviderStyle::OpenAiResponses => {
            json!({"model": "gpt-test", "stream": true, "input": "hi"})
        }
        ProviderStyle::AnthropicMessages => json!({
            "model": "claude-test", "stream": true, "max_tokens": 64,
            "messages": [{"role": "user", "content": "hi"}],
        }),
    }
}

async fn post(mock: &MockProvider, style: ProviderStyle, body: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{}{}", mock.base_url(), style.path()))
        .json_body(body)
        .send()
        .await
        .unwrap()
}

/// `reqwest` without its `json` feature: set the body by hand.
trait JsonBody {
    fn json_body(self, v: &Value) -> Self;
}

impl JsonBody for reqwest::RequestBuilder {
    fn json_body(self, v: &Value) -> Self {
        self.header("content-type", "application/json")
            .body(v.to_string())
    }
}

/// Read the body chunk by chunk; `Err` carries what arrived before the error.
async fn read_all(mut resp: reqwest::Response) -> Result<Vec<u8>, Vec<u8>> {
    let mut got = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => got.extend_from_slice(&c),
            Ok(None) => return Ok(got),
            Err(_) => return Err(got),
        }
    }
}

#[tokio::test]
async fn every_style_streams_exactly_the_rendered_bytes() {
    let scenario = Scenario::default()
        .with_output_tokens(9)
        .with_reasoning_tokens(2)
        .with_cache(3, 4);
    let mock = MockProvider::start(scenario.clone()).await.unwrap();
    for (seq, style) in ProviderStyle::ALL.into_iter().enumerate() {
        let body = request_body(style);
        let resp = post(&mock, style, &body).await;
        assert_eq!(resp.status(), 200);
        assert!(
            resp.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );
        let got = read_all(resp).await.unwrap();
        let expected = plan(
            style,
            &scenario,
            &RenderContext {
                model: body["model"].as_str().unwrap().to_owned(),
                include_usage: true,
                request_seq: seq as u64,
            },
        )
        .body_bytes();
        assert_eq!(got, expected, "{style:?}");
        assert_eq!(
            adapter_usage(style, ChatFlavor::OpenAi, &got),
            scenario.expected_usage(style, true)
        );
    }
    assert_eq!(mock.request_count(), 3);
    let recorded = mock.recorded_requests();
    assert_eq!(recorded.len(), 3);
    assert_eq!(recorded[2].style, ProviderStyle::AnthropicMessages);
    assert_eq!(recorded[2].body["model"], "claude-test");
    mock.shutdown().await;
}

#[tokio::test]
async fn chat_honours_the_requests_include_usage() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let mut body = request_body(ProviderStyle::ChatCompletions);
    body.as_object_mut().unwrap().remove("stream_options");
    let got = read_all(post(&mock, ProviderStyle::ChatCompletions, &body).await)
        .await
        .unwrap();
    assert_eq!(
        adapter_usage(ProviderStyle::ChatCompletions, ChatFlavor::OpenAi, &got),
        None
    );
    assert!(!String::from_utf8(got).unwrap().contains("\"usage\""));
    mock.shutdown().await;
}

#[tokio::test]
async fn status_faults_arrive_before_the_first_byte_with_retry_after() {
    let mock = MockProvider::start(Scenario::default().with_fault(Fault::Status { status: 429 }))
        .await
        .unwrap();
    let resp = post(
        &mock,
        ProviderStyle::OpenAiResponses,
        &request_body(ProviderStyle::OpenAiResponses),
    )
    .await;
    assert_eq!(resp.status(), 429);
    assert_eq!(resp.headers()["retry-after"], "1");
    let v: Value = serde_json::from_slice(&read_all(resp).await.unwrap()).unwrap();
    assert_eq!(v["error"]["type"], "requests");

    mock.set_scenario(Scenario::default().with_fault(Fault::Status { status: 529 }));
    let resp = post(
        &mock,
        ProviderStyle::AnthropicMessages,
        &request_body(ProviderStyle::AnthropicMessages),
    )
    .await;
    assert_eq!(resp.status().as_u16(), 529);
    let v: Value = serde_json::from_slice(&read_all(resp).await.unwrap()).unwrap();
    assert_eq!(v["error"]["type"], "overloaded_error");
    mock.shutdown().await;
}

#[tokio::test]
async fn a_disconnect_is_a_transport_error_after_exactly_n_bytes() {
    let mock = MockProvider::start(
        Scenario::default()
            .with_output_tokens(50)
            .with_fault(Fault::DisconnectAtByte { byte: 333 }),
    )
    .await
    .unwrap();
    for style in ProviderStyle::ALL {
        let resp = post(&mock, style, &request_body(style)).await;
        assert_eq!(resp.status(), 200, "headers were already sent");
        let partial = read_all(resp)
            .await
            .expect_err("a dropped stream must not look complete");
        assert_eq!(partial.len(), 333, "{style:?}");
    }
    mock.shutdown().await;
}

#[tokio::test]
async fn ttfb_pacing_and_stalls_are_real_time() {
    let ttfb = Duration::from_millis(150);
    let mock = MockProvider::start(
        Scenario::default()
            .with_ttfb(ttfb)
            .with_output_tokens(10)
            .with_tokens_per_sec(100)
            .with_stall(5, Duration::from_millis(200)),
    )
    .await
    .unwrap();
    let t0 = Instant::now();
    let resp = post(
        &mock,
        ProviderStyle::AnthropicMessages,
        &request_body(ProviderStyle::AnthropicMessages),
    )
    .await;
    assert!(t0.elapsed() >= ttfb, "headers arrive after the TTFB");
    read_all(resp).await.unwrap();
    // 150 ms TTFB + 10 tokens at 100/s + a 200 ms stall.
    assert!(
        t0.elapsed() >= Duration::from_millis(450),
        "{:?}",
        t0.elapsed()
    );
    mock.shutdown().await;
}

#[tokio::test]
async fn a_named_scenario_is_selected_per_request() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    mock.insert_scenario(
        "overloaded",
        Scenario::default().with_fault(Fault::Status { status: 529 }),
    );
    let client = reqwest::Client::new();
    let url = format!(
        "{}{}",
        mock.base_url(),
        ProviderStyle::AnthropicMessages.path()
    );
    let body = request_body(ProviderStyle::AnthropicMessages);
    let named = client
        .post(&url)
        .header(SCENARIO_HEADER, "overloaded")
        .json_body(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(named.status().as_u16(), 529);
    let default = client.post(&url).json_body(&body).send().await.unwrap();
    assert_eq!(default.status(), 200);
    let unknown = client
        .post(&url)
        .header(SCENARIO_HEADER, "nope")
        .json_body(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 400);
    let not_streaming = client
        .post(&url)
        .json_body(&json!({"model": "m", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(not_streaming.status(), 400);
    assert_eq!(
        mock.recorded_requests()[0].scenario.as_deref(),
        Some("overloaded")
    );
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reader_that_stops_reading_is_counted_as_backpressure() {
    // Paced fast enough that a stalled reader fills the socket buffers
    // within the test's wait.
    let mock = MockProvider::start(
        Scenario::default()
            .with_output_tokens(20_000)
            .with_tokens_per_sec(20_000),
    )
    .await
    .unwrap();
    // A prompt reader at a realistic provider speed: no backpressure.
    mock.insert_scenario(
        "realistic",
        Scenario::default()
            .with_output_tokens(300)
            .with_tokens_per_sec(1_000),
    );
    let resp = reqwest::Client::new()
        .post(format!(
            "{}{}",
            mock.base_url(),
            ProviderStyle::ChatCompletions.path()
        ))
        .header(SCENARIO_HEADER, "realistic")
        .json_body(&request_body(ProviderStyle::ChatCompletions))
        .send()
        .await
        .unwrap();
    read_all(resp).await.unwrap();
    assert_eq!(mock.backpressured_writes(), 0);
    // A reader that sends its request and never reads, with a small receive
    // buffer so the socket fills deterministically rather than after however
    // many megabytes the OS auto-tunes to.
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4_096).unwrap();
    let mut stalled = socket.connect(mock.addr()).await.unwrap();
    let body = request_body(ProviderStyle::ChatCompletions).to_string();
    let request = format!(
        "POST {} HTTP/1.1\r\nhost: {}\r\ncontent-type: application/json\r\n\
         content-length: {}\r\n\r\n{body}",
        ProviderStyle::ChatCompletions.path(),
        mock.addr(),
        body.len()
    );
    tokio::io::AsyncWriteExt::write_all(&mut stalled, request.as_bytes())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(mock.backpressured_writes() > 0);
    drop(stalled);
    mock.shutdown().await;
}

#[tokio::test]
async fn a_client_that_leaves_during_a_stall_ends_the_producer_and_big_bodies_are_not_kept() {
    let mock = MockProvider::start(Scenario::default().with_stall(0, Duration::from_secs(300)))
        .await
        .unwrap();
    let resp = post(
        &mock,
        ProviderStyle::AnthropicMessages,
        &request_body(ProviderStyle::AnthropicMessages),
    )
    .await;
    assert_eq!(mock.active_streams(), 1);
    drop(resp);
    // The producer is mid-way through a 300 s stall; it must notice at once.
    let t0 = Instant::now();
    while mock.active_streams() > 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "a stalled producer outlived its client"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    mock.shutdown().await;

    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let mut body = request_body(ProviderStyle::AnthropicMessages);
    body["padding"] = Value::String("x".repeat(100_000));
    read_all(post(&mock, ProviderStyle::AnthropicMessages, &body).await)
        .await
        .unwrap();
    let rec = &mock.recorded_requests()[0];
    assert!(rec.body.is_null());
    assert!(rec.body_len > 100_000);
    mock.shutdown().await;
}

#[tokio::test]
async fn a_request_body_above_axums_default_limit_is_served() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let mut body = request_body(ProviderStyle::OpenAiResponses);
    body["input"] = Value::String("x".repeat(6 * 1024 * 1024));
    let resp = post(&mock, ProviderStyle::OpenAiResponses, &body).await;
    assert_eq!(resp.status(), 200);
    read_all(resp).await.unwrap();
    mock.shutdown().await;
}
