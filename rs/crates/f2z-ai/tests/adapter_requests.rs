//! What the gateway sends a provider (zuu#1064): each adapter's translation
//! of the unified request, the header allowlist on the wire, and the
//! refusals `start` makes before any I/O.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;

use std::time::{Duration, Instant};

use adapter_support::*;
use f2z_ai::call::Upstream as _;
use f2z_ai::provider::client::ALLOWED_HEADERS;
use f2z_ai_proto::chat::ChatRequest;
use f2z_ai_testkit::mock::{MockProvider, ProviderStyle, Scenario};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

const METADATA_CANARY: &str = "metadata-canary-9f1c";

fn rich(model: &str) -> ChatRequest {
    serde_json::from_value(json!({
        "model": model,
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": "You tutor maths."}]},
            {"role": "user", "content": [
                {"type": "text", "text": "What is wrong?"},
                {"type": "image", "media_type": "image/png", "data": "iVBORw0KGgo="}
            ]},
            {"role": "assistant", "content": [{"type": "text", "text": "Checking."}],
             "tool_calls": [{"id": "call_1", "name": "lookup", "arguments": "{\"name\":\"q\"}"}]},
            {"role": "tool", "tool_call_id": "call_1", "content": [{"type": "text", "text": "{\"f\":1}"}]},
            {"role": "user", "content": [{"type": "text", "text": "And now?"}]}
        ],
        "tools": [{"name": "lookup", "description": "Find a formula",
                   "parameters": {"type": "object", "properties": {"name": {"type": "string"}}}}],
        "max_output_tokens": 99_999,
        "metadata": {"lesson": METADATA_CANARY}
    }))
    .unwrap()
}

async fn sent_body(mock: &MockProvider, model: Model) -> Value {
    let backend = backend(&mock.base_url(), tuning(0));
    let request = rich(model.id);
    let run = drive(&backend, &catalog(10_000), &request).await;
    assert_eq!(run.outcome.failure, None, "{}", model.id);
    let recorded = mock.recorded_requests();
    let last = recorded.last().unwrap();
    assert_eq!(last.style, model.style);
    let text = last.body.to_string();
    assert!(
        !text.contains(METADATA_CANARY),
        "metadata is never sent to a provider"
    );
    assert!(
        !text.contains("\"url\":\"http"),
        "no fetchable URL is ever sent"
    );
    last.body.clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_adapter_translates_the_unified_request() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();

    // The request's image parts are the usage's images, whatever the
    // provider's own report says nothing about.
    let run = drive(
        &backend(&mock.base_url(), tuning(0)),
        &catalog(10_000),
        &rich(ANTHROPIC.id),
    )
    .await;
    assert_eq!(run.outcome.usage.reported().unwrap().images, 1);
    assert_eq!(run.usage_event().unwrap().images, 1);

    let chat = sent_body(&mock, CHAT).await;
    assert_eq!(chat["model"], "m-chat-upstream");
    assert_eq!(chat["stream"], true);
    assert_eq!(chat["stream_options"]["include_usage"], true);
    assert_eq!(
        chat["max_completion_tokens"], 8192,
        "clamped to the model's ceiling"
    );
    let roles: Vec<&str> = chat["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["system", "user", "assistant", "tool", "user"]);
    assert_eq!(
        chat["messages"][1]["content"][1]["image_url"]["url"],
        "data:image/png;base64,iVBORw0KGgo="
    );
    assert_eq!(
        chat["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{\"name\":\"q\"}"
    );
    assert_eq!(chat["messages"][3]["tool_call_id"], "call_1");
    assert_eq!(chat["tools"][0]["function"]["name"], "lookup");

    let anthropic = sent_body(&mock, ANTHROPIC).await;
    assert_eq!(anthropic["max_tokens"], 8192);
    assert_eq!(anthropic["system"], "You tutor maths.");
    let turns = anthropic["messages"].as_array().unwrap();
    let roles: Vec<&str> = turns.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "user"], "roles alternate");
    assert_eq!(turns[0]["content"][1]["source"]["type"], "base64");
    assert_eq!(turns[1]["content"][1]["type"], "tool_use");
    assert_eq!(turns[1]["content"][1]["input"], json!({"name": "q"}));
    assert_eq!(turns[2]["content"][0]["type"], "tool_result");
    assert_eq!(turns[2]["content"][0]["tool_use_id"], "call_1");
    assert_eq!(turns[2]["content"][1]["text"], "And now?");
    assert_eq!(anthropic["tools"][0]["input_schema"]["type"], "object");

    let responses = sent_body(&mock, RESPONSES).await;
    assert_eq!(responses["store"], false);
    assert_eq!(responses["max_output_tokens"], 8192);
    let input = responses["input"].as_array().unwrap();
    let kinds: Vec<String> = input
        .iter()
        .map(|i| {
            i.get("type")
                .and_then(Value::as_str)
                .map_or_else(|| i["role"].as_str().unwrap().to_owned(), str::to_owned)
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "system",
            "user",
            "assistant",
            "function_call",
            "function_call_output",
            "user"
        ]
    );
    assert_eq!(input[1]["content"][1]["type"], "input_image");
    assert_eq!(input[3]["call_id"], "call_1");
    assert_eq!(input[4]["output"], "{\"f\":1}");
    assert_eq!(responses["tools"][0]["type"], "function");
    assert_eq!(responses["tools"][0]["strict"], false);
    mock.shutdown().await;
}

#[tokio::test]
async fn start_refuses_before_any_io() {
    let backend = backend("http://127.0.0.1:9", tuning(0));
    let catalog = catalog(10_000);
    let refuse = |request: ChatRequest| {
        backend
            .open(&request, &catalog, Instant::now())
            .map(|_| ())
            .unwrap_err()
    };
    let e = refuse(request("no-such-model"));
    assert_eq!((e.status().as_u16(), e.code()), (404, "model_not_found"));
    let e = refuse(request("m-unconfigured"));
    assert_eq!((e.status().as_u16(), e.code()), (403, "model_disabled"));

    // Anthropic takes tool input as a JSON object; anything else cannot be
    // expressed and is the client's to fix.
    let mut bad = rich(ANTHROPIC.id);
    bad.messages[2].tool_calls[0].arguments = "not json".into();
    let e = refuse(bad);
    assert_eq!((e.status().as_u16(), e.code()), (400, "invalid_request"));
    // An image the provider cannot carry is refused, never dropped: a tool
    // result is text on Chat Completions and Responses, and `system` is
    // text on Anthropic.
    for model in [CHAT, RESPONSES] {
        let mut req = rich(model.id);
        req.messages[3].content.push(
            serde_json::from_value(
                json!({"type": "image", "media_type": "image/png", "data": "iVBORw0KGgo="}),
            )
            .unwrap(),
        );
        let e = refuse(req);
        assert_eq!(
            (e.status().as_u16(), e.code()),
            (400, "invalid_request"),
            "{}",
            model.id
        );
    }
    let mut req = rich(ANTHROPIC.id);
    req.messages[0].content.push(
        serde_json::from_value(
            json!({"type": "image", "media_type": "image/png", "data": "iVBORw0KGgo="}),
        )
        .unwrap(),
    );
    let e = refuse(req);
    assert_eq!((e.status().as_u16(), e.code()), (400, "invalid_request"));
}

/// A one-shot raw HTTP server: records the request head, answers 400.
async fn capture_head() -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        let mut buf = [0u8; 4096];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            head.extend_from_slice(&buf[..n]);
        }
        let _ = socket
            .write_all(
                b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            )
            .await;
        let end = head
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or(head.len());
        String::from_utf8_lossy(&head[..end]).into_owned()
    });
    (url, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_allowlisted_headers_reach_the_wire() {
    for model in [RESPONSES, ANTHROPIC, CHAT] {
        let (url, task) = capture_head().await;
        let backend = backend(&url, tuning(0));
        let mut upstream = backend
            .open(&request(model.id), &catalog(10_000), Instant::now())
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while upstream.next().await.is_some() {}
        })
        .await
        .unwrap();
        let head = task.await.unwrap();
        let mut names: Vec<String> = head
            .lines()
            .skip(1)
            .filter_map(|l| {
                l.split_once(':')
                    .map(|(n, _)| n.trim().to_ascii_lowercase())
            })
            .collect();
        names.sort();
        for name in &names {
            assert!(
                ALLOWED_HEADERS.contains(&name.as_str())
                    || name == "host"
                    || name == "content-length",
                "{}: header `{name}` is not on the allowlist",
                model.id
            );
        }
        let auth = if model.style == ProviderStyle::AnthropicMessages {
            "x-api-key"
        } else {
            "authorization"
        };
        assert!(names.iter().any(|n| n == auth), "{}: {names:?}", model.id);
        for forbidden in [
            "anthropic-beta",
            "openai-organization",
            "openai-project",
            "cookie",
        ] {
            assert!(!names.iter().any(|n| n == forbidden), "{forbidden}");
        }
    }
}
