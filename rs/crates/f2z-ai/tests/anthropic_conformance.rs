//! Anthropic Messages conformance for OpenAI-shaped tool calling and
//! structured output (zuu#1128 item 1): recorded / documented provider
//! payloads in `tests/fixtures/anthropic/`, run through the real adapter, the
//! real `ProviderBackend` (over HTTP to a local server that replays the
//! fixture), and the gateway's non-streaming union. No real provider call.
//!
//! * `streams.json` — each `.sse` fixture, the request the adapter is bound
//!   to, and the text / tool calls / finish reason / usage it must yield.
//! * `requests.json` — `/v1/chat` tool controls and `response_format`, and
//!   the Anthropic `tools` / `tool_choice` the adapter must send.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;
mod support;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use adapter_support::{ANTHROPIC, CHAT, RESPONSES, backend, catalog, drive, tuning};
use axum::http::StatusCode;
use f2z_ai::catalog::VerifiedCatalog;
use f2z_ai::provider::openai_chat::UsageConvention;
use f2z_ai::provider::sse::Decoder;
use f2z_ai::provider::{Content, Step, for_style};
use f2z_ai_proto::catalog::ApiStyle;
use f2z_ai_proto::chat::{ChatRequest, ChatResponse, FinishReason, ToolCall};
use f2z_ai_proto::event::{Done, Meta};
use f2z_ai_proto::{Event, Whole2z};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

fn fixture(name: &str) -> String {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests/fixtures/anthropic", name]
        .iter()
        .collect();
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn cases(file: &str) -> Vec<Value> {
    let value: Value = serde_json::from_str(&fixture(file)).unwrap();
    value["cases"].as_array().unwrap().clone()
}

/// A `/v1/chat` request for `model`: one user turn, then `extra`'s members.
fn chat(model: &str, extra: &Value) -> ChatRequest {
    let mut value = json!({
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "Go."}]}],
    });
    for (key, member) in extra.as_object().unwrap() {
        value[key] = member.clone();
    }
    serde_json::from_value(value).unwrap()
}

/// The adapter catalogue with `m-anthropic` (and `m-chat`) declaring tools
/// and `structured`.
fn declared(structured: Option<bool>) -> VerifiedCatalog {
    let mut value = serde_json::to_value(catalog(10_000).catalog()).unwrap();
    for model in value["models"].as_array_mut().unwrap() {
        let mut capabilities = json!({"tools": true});
        if let Some(declared) = structured {
            capabilities["structured_output"] = json!(declared);
        }
        model["capabilities"] = capabilities;
    }
    VerifiedCatalog::from_verified(serde_json::from_value(value).unwrap()).unwrap()
}

/// What one stream produced, as the adapter's parser saw it.
struct Parsed {
    text: String,
    text_deltas: usize,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<FinishReason>,
    usage: Option<f2z_ai_proto::Usage>,
}

fn parse(request: &ChatRequest, sse: &str) -> Parsed {
    let mut adapter = for_style(
        ApiStyle::AnthropicMessages,
        UsageConvention::CompletionIncludesReasoning,
    )
    .unwrap();
    adapter.bind(request);
    let mut parser = adapter.parser();
    let mut events = Vec::new();
    Decoder::new().push(sse.as_bytes(), &mut events).unwrap();
    let mut content = Vec::new();
    let mut terminal = false;
    for event in &events {
        if parser.feed(event, &mut content).unwrap() == Step::Terminal {
            terminal = true;
            break;
        }
    }
    assert!(terminal, "every fixture ends in message_stop");
    let ending = parser.end(true);
    assert_eq!(ending.failure, None);
    let mut parsed = Parsed {
        text: String::new(),
        text_deltas: 0,
        tool_calls: Vec::new(),
        finish_reason: ending.finish_reason,
        usage: ending.usage.reported(),
    };
    for item in content {
        match item {
            Content::Text(text) => {
                assert!(!text.is_empty(), "a delta is never empty");
                parsed.text_deltas += 1;
                parsed.text.push_str(&text);
            }
            Content::ToolCall(call) => parsed.tool_calls.push(call),
            // Fragments are informational (zuu#1128); the complete call is
            // what this conformance pins.
            Content::ToolCallDelta(_) => {}
        }
    }
    parsed
}

fn finish(name: &str) -> FinishReason {
    serde_json::from_value(json!(name)).unwrap()
}

#[test]
fn recorded_streams_yield_the_openai_shaped_reply() {
    for case in cases("streams.json") {
        let name = case["name"].as_str().unwrap();
        let request: ChatRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let parsed = parse(&request, &fixture(case["fixture"].as_str().unwrap()));
        let expect = &case["expect"];
        assert_eq!(parsed.text, expect["text"].as_str().unwrap(), "{name}");
        if let Some(n) = expect.get("text_deltas") {
            // Streamed as it arrives, not buffered to the end.
            assert_eq!(parsed.text_deltas as u64, n.as_u64().unwrap(), "{name}");
        }
        let calls: Vec<ToolCall> = serde_json::from_value(expect["tool_calls"].clone()).unwrap();
        assert_eq!(parsed.tool_calls, calls, "{name}");
        for call in &parsed.tool_calls {
            // What the client will send back as a tool message's arguments.
            serde_json::from_str::<Value>(&call.arguments)
                .unwrap_or_else(|_| panic!("{name}: arguments are JSON text"));
        }
        assert_eq!(
            parsed.finish_reason,
            Some(finish(expect["finish_reason"].as_str().unwrap())),
            "{name}"
        );
        // Usage is Anthropic's own: a function call's tokens are in
        // output_tokens, never in the per-call server-tool count.
        let usage = parsed.usage.unwrap();
        assert_eq!(
            (usage.input_tokens, usage.output_tokens, usage.tool_calls),
            (
                expect["usage"]["input_tokens"].as_u64().unwrap(),
                expect["usage"]["output_tokens"].as_u64().unwrap(),
                0
            ),
            "{name}"
        );
    }
}

#[test]
fn a_structured_reply_is_valid_json_and_never_a_tool_call() {
    let request = chat(
        ANTHROPIC.id,
        &json!({"response_format": {"type": "json_object"}}),
    );
    let parsed = parse(&request, &fixture("response_format.sse"));
    let value: Value = serde_json::from_str(&parsed.text).unwrap();
    assert_eq!(value["steps"][1], "Count the slices");
    assert!(parsed.tool_calls.is_empty());
    assert_eq!(parsed.finish_reason, Some(FinishReason::Stop));
}

#[test]
fn a_tool_use_block_whose_input_arrives_whole_is_still_the_answer() {
    // No input_json_delta: the input is complete at content_block_start.
    let sse = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_w\",\"name\":\"json_object\",\"input\":{\"ok\":true}}}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );
    let request = chat(
        ANTHROPIC.id,
        &json!({"response_format": {"type": "json_object"}}),
    );
    let parsed = parse(&request, sse);
    assert_eq!(parsed.text, "{\"ok\":true}");
    assert_eq!(parsed.finish_reason, Some(FinishReason::Stop));
}

#[test]
fn a_second_forced_block_is_not_a_stream_this_request_produces() {
    let mut adapter = for_style(
        ApiStyle::AnthropicMessages,
        UsageConvention::CompletionIncludesReasoning,
    )
    .unwrap();
    adapter.bind(&chat(
        ANTHROPIC.id,
        &json!({"response_format": {"type": "json_object"}}),
    ));
    let mut parser = adapter.parser();
    let mut out = Vec::new();
    let block = |index: u64| {
        f2z_ai::provider::sse::SseEvent {
        event: "content_block_start".into(),
        data: json!({"type": "content_block_start", "index": index,
                     "content_block": {"type": "tool_use", "id": "t", "name": "json_object", "input": {}}})
        .to_string(),
    }
    };
    parser.feed(&block(0), &mut out).unwrap();
    assert!(parser.feed(&block(1), &mut out).is_err());
}

#[test]
fn requests_translate_to_anthropic_tools_and_tool_choice() {
    let catalog = declared(Some(true));
    let model = catalog
        .catalog()
        .callable_model(ANTHROPIC.id)
        .unwrap()
        .clone();
    for case in cases("requests.json") {
        let name = case["name"].as_str().unwrap();
        let request = chat(ANTHROPIC.id, &case["request"]);
        let mut adapter = for_style(
            ApiStyle::AnthropicMessages,
            UsageConvention::CompletionIncludesReasoning,
        )
        .unwrap();
        adapter.bind(&request);
        let body = adapter.body(&request, &model, 1024).unwrap();
        for member in ["tools", "tool_choice"] {
            let want = &case["expect"][member];
            match body.get(member) {
                Some(sent) => assert_eq!(sent, want, "{name}: {member}"),
                None => assert!(want.is_null(), "{name}: {member} missing"),
            }
        }
        assert!(
            body.get("response_format").is_none() && body.get("parallel_tool_calls").is_none(),
            "{name}: no OpenAI member leaks into the Anthropic body"
        );
    }
}

#[test]
fn a_tool_round_trip_keeps_the_providers_ids() {
    // The id Anthropic gave a tool_use comes back on the client's tool
    // message and goes out as the tool_result's tool_use_id, unchanged.
    let catalog = declared(None);
    let model = catalog
        .catalog()
        .callable_model(ANTHROPIC.id)
        .unwrap()
        .clone();
    let request: ChatRequest = serde_json::from_value(json!({
        "model": ANTHROPIC.id,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "Weather in SF?"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "Checking."}],
             "tool_calls": [{"id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "name": "get_weather",
                             "arguments": "{\"location\": \"San Francisco, CA\"}"}]},
            {"role": "tool", "tool_call_id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
             "content": [{"type": "text", "text": "{\"f\": 61}"}]}
        ],
        "tools": [{"name": "get_weather", "parameters": {"type": "object"}}],
        "tool_choice": "auto"
    }))
    .unwrap();
    let adapter = for_style(
        ApiStyle::AnthropicMessages,
        UsageConvention::CompletionIncludesReasoning,
    )
    .unwrap();
    let body = adapter.body(&request, &model, 1024).unwrap();
    let turns = body["messages"].as_array().unwrap();
    assert_eq!(turns[1]["content"][1]["type"], "tool_use");
    assert_eq!(
        turns[1]["content"][1]["id"],
        "toolu_01T1x1fJ34qAmk2tNTrN7Up6"
    );
    assert_eq!(
        turns[1]["content"][1]["input"],
        json!({"location": "San Francisco, CA"})
    );
    assert_eq!(turns[2]["role"], "user");
    assert_eq!(turns[2]["content"][0]["type"], "tool_result");
    assert_eq!(
        turns[2]["content"][0]["tool_use_id"],
        "toolu_01T1x1fJ34qAmk2tNTrN7Up6"
    );
}

#[tokio::test]
async fn what_cannot_be_expressed_is_refused_before_any_io() {
    // Port 9 (discard): a request that got as far as I/O would fail with a
    // connection error, not these refusals.
    let backend = backend("http://127.0.0.1:9", tuning(0));
    let refusal = |request: &ChatRequest, catalog: &VerifiedCatalog| {
        backend
            .open(request, catalog, Instant::now())
            .map(|_| ())
            .err()
    };
    let tools = json!([{"name": "lookup", "parameters": {"type": "object"}}]);
    let format = json!({"type": "json_object"});

    // A response_format beside tools: the forced tool would leave the
    // caller's tools uncallable.
    let both = chat(
        ANTHROPIC.id,
        &json!({"tools": tools, "response_format": format}),
    );
    let e = refusal(&both, &declared(Some(true))).unwrap();
    assert_eq!((e.status().as_u16(), e.code()), (400, "invalid_request"));
    assert_eq!(
        e.detail_of("reason"),
        Some(&json!("response_format_unsupported"))
    );
    assert_eq!(e.detail_of("conflict"), Some(&json!("tools")));
    // Negative controls: each half alone passes every pre-I/O check.
    let format_only = chat(ANTHROPIC.id, &json!({"response_format": format}));
    assert!(refusal(&format_only, &declared(Some(true))).is_none());
    let tools_only = chat(
        ANTHROPIC.id,
        &json!({"tools": tools, "tool_choice": "required", "parallel_tool_calls": false}),
    );
    assert!(refusal(&tools_only, &declared(Some(true))).is_none());

    // Structured output on Anthropic must be declared: absent and false
    // both refuse.
    for structured in [None, Some(false)] {
        let e = refusal(&format_only, &declared(structured)).unwrap();
        assert_eq!(
            e.detail_of("reason"),
            Some(&json!("response_format_unsupported")),
            "{structured:?}"
        );
    }

    // tool_choice / parallel_tool_calls on an adapter without the
    // translation (Responses): refused, never dropped. Negative control: the
    // same request without them passes. Chat Completions translates both
    // natively (zuu#1128, tests/tool_conformance.rs), so there they pass.
    for (extra, _) in [
        (json!({"tools": tools, "tool_choice": "required"}), ()),
        (json!({"tools": tools, "parallel_tool_calls": false}), ()),
    ] {
        assert!(
            refusal(&chat(CHAT.id, &extra), &declared(Some(true))).is_none(),
            "{extra}"
        );
    }
    for model in [RESPONSES] {
        for (extra, field) in [
            (
                json!({"tools": tools, "tool_choice": "required"}),
                "tool_choice",
            ),
            (
                json!({"tools": tools, "parallel_tool_calls": false}),
                "parallel_tool_calls",
            ),
        ] {
            let e = refusal(&chat(model.id, &extra), &declared(Some(true))).unwrap();
            assert_eq!((e.status().as_u16(), e.code()), (400, "invalid_request"));
            assert_eq!(e.detail_of("field"), Some(&json!(field)), "{}", model.id);
            assert_eq!(
                e.detail_of("reason"),
                Some(&json!("tools_unsupported")),
                "{}",
                model.id
            );
        }
        assert!(
            refusal(
                &chat(model.id, &json!({"tools": tools})),
                &declared(Some(true))
            )
            .is_none(),
            "{}",
            model.id
        );
    }

    // The direct adapter path also refuses a tool control with no tools.
    let e = refusal(
        &chat(ANTHROPIC.id, &json!({"tool_choice": "auto"})),
        &declared(None),
    )
    .unwrap();
    assert_eq!(e.detail_of("reason"), Some(&json!("requires_tools")));
}

/// A local provider that answers every request with `sse` and records each
/// request body.
async fn replay(sse: String) -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&bodies);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let sse = sse.clone();
            let recorded = Arc::clone(&recorded);
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buf = [0u8; 8192];
                let body = loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0, "request ended early");
                    bytes.extend_from_slice(&buf[..n]);
                    let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map_or(0, |v| v.trim().parse().unwrap());
                    if bytes.len() >= end + 4 + length {
                        break bytes[end + 4..end + 4 + length].to_vec();
                    }
                };
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap());
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    sse.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(sse.as_bytes()).await.unwrap();
                let _ = socket.shutdown().await;
            });
        }
    });
    (url, bodies)
}

/// The non-streaming answer to a call whose upstream produced `events`:
/// the gateway's union of the stream (`stream: false`), with the metering
/// layer's `meta` and `done` around the adapter's events.
async fn nonstream(events: Vec<Event>, finish_reason: FinishReason) -> ChatResponse {
    let (backend, mut streams) = support::ControlledBackend::new();
    let running = support::start(
        &support::config(&[]),
        support::deps(
            support::fixed_catalog(),
            backend,
            support::RecordingSettler::default(),
        ),
    )
    .await;
    support::wait_readyz(running.admin, StatusCode::OK).await;
    let mut body = support::valid_chat("hello");
    body["stream"] = json!(false);
    let addr = running.public;
    let client =
        tokio::spawn(
            async move { support::send(addr, support::chat_request(body.to_string())).await },
        );
    let upstream = streams.recv().await.unwrap();
    upstream
        .send(Event::Meta(Meta::new(
            "call-1",
            ANTHROPIC.id,
            Whole2z::new(2),
        )))
        .await
        .unwrap();
    for event in events {
        upstream.send(event).await.unwrap();
    }
    upstream
        .send(Event::Done(Done::settled(
            Whole2z::new(1),
            "receipt-1",
            finish_reason,
        )))
        .await
        .unwrap();
    drop(upstream);
    let response = client.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_str(&support::text(response).await).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structured_output_end_to_end_streams_text_and_answers_content() {
    let (url, sent) = replay(fixture("response_format.sse")).await;
    let backend = backend(&url, tuning(0));
    let request = chat(
        ANTHROPIC.id,
        &json!({"response_format": {"type": "json_schema", "json_schema": {
            "name": "activity_spec", "strict": true,
            "schema": {"type": "object", "additionalProperties": false,
                       "required": ["title", "steps"],
                       "properties": {"title": {"type": "string"},
                                      "steps": {"type": "array", "items": {"type": "string"}}}}}}}),
    );
    let run = drive(&backend, &declared(Some(true)), &request).await;
    assert_eq!(run.outcome.failure, None);

    // What went to Anthropic: one forced, strict tool carrying the schema.
    let body = sent.lock().unwrap().last().unwrap().clone();
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    assert_eq!(body["tools"][0]["name"], "activity_spec");
    assert_eq!(body["tools"][0]["strict"], true);
    assert_eq!(
        body["tools"][0]["input_schema"]["required"],
        json!(["title", "steps"])
    );
    assert_eq!(
        body["tool_choice"],
        json!({"type": "tool", "name": "activity_spec", "disable_parallel_tool_use": true})
    );

    // Streaming: text deltas, as they arrived; no tool_call event.
    let json_text =
        "{\"title\": \"Fractions\", \"steps\": [\"Cut the pie\", \"Count the slices\"]}";
    assert_eq!(run.text(), json_text);
    assert_eq!(run.deltas(), 3);
    assert!(run.tool_calls().is_empty());
    assert_eq!(run.outcome.function_tool_calls, 0);
    assert_eq!(run.outcome.finish_reason, Some(FinishReason::Stop));
    let usage = run.usage_event().unwrap();
    assert_eq!((usage.input_tokens, usage.output_tokens), (388, 42));

    // Non-streaming: the reply's content is the JSON text.
    let reply = nonstream(run.events, run.outcome.finish_reason.unwrap()).await;
    reply.check().unwrap();
    assert_eq!(reply.message.text(), json_text);
    assert!(reply.message.tool_calls.is_empty());
    assert_eq!(reply.finish_reason, FinishReason::Stop);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_calls_end_to_end_keep_ids_and_finish_tool_calls() {
    let (url, sent) = replay(fixture("tool_use.sse")).await;
    let backend = backend(&url, tuning(0));
    let request = chat(
        ANTHROPIC.id,
        &json!({"tools": [{"name": "get_weather", "parameters": {"type": "object"}}],
                "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
                "parallel_tool_calls": false}),
    );
    let run = drive(&backend, &declared(None), &request).await;
    assert_eq!(run.outcome.failure, None);
    let body = sent.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        body["tool_choice"],
        json!({"type": "tool", "name": "get_weather", "disable_parallel_tool_use": true})
    );

    let calls = run.tool_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "toolu_01T1x1fJ34qAmk2tNTrN7Up6");
    assert_eq!(run.outcome.function_tool_calls, 1);
    assert_eq!(run.outcome.finish_reason, Some(FinishReason::ToolCalls));
    // The function call's tokens are output tokens; no per-call charge.
    let usage = run.usage_event().unwrap();
    assert_eq!((usage.output_tokens, usage.tool_calls), (89, 0));

    let reply = nonstream(run.events, run.outcome.finish_reason.unwrap()).await;
    reply.check().unwrap();
    assert_eq!(
        reply.message.text(),
        "Okay, let's check the weather for San Francisco, CA:"
    );
    assert_eq!(reply.message.tool_calls, calls);
    assert_eq!(reply.finish_reason, FinishReason::ToolCalls);
}
