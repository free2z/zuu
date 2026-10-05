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

#[test]
fn openai_standard_processing_cannot_be_overridden_by_caller_metadata() {
    use f2z_ai::provider::{for_style, openai_chat::UsageConvention};
    use f2z_ai_proto::catalog::ApiStyle;

    let catalog = catalog(10_000);
    let mut model = catalog.catalog().callable_model(CHAT.id).unwrap().clone();
    let mut request = rich(CHAT.id);
    request
        .metadata
        .insert("service_tier".into(), "priority".into());
    for style in [ApiStyle::OpenaiChat, ApiStyle::OpenaiResponses] {
        let adapter = for_style(style, UsageConvention::CompletionIncludesReasoning).unwrap();
        model.provider = "openai".into();
        let body = adapter.body(&request, &model, 16).unwrap().to_value();
        assert_eq!(body["service_tier"], "default");
        for provider in ["xai", "chatco"] {
            model.provider = provider.into();
            let body = adapter.body(&request, &model, 16).unwrap().to_value();
            assert!(body.get("service_tier").is_none());
        }
    }
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
    assert!(
        chat.get("service_tier").is_none(),
        "compatible providers keep their own contract"
    );
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
    assert_eq!(responses["service_tier"], "default");
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

/// The adapter catalogue with `m-chat` moved to `provider` and given
/// `structured` as its declared `capabilities.structured_output`.
fn with_chat_model(provider: &str, structured: Option<bool>) -> f2z_ai::catalog::VerifiedCatalog {
    let mut value = serde_json::to_value(catalog(10_000).catalog()).unwrap();
    for model in value["models"].as_array_mut().unwrap() {
        if model["id"] == CHAT.id {
            model["provider"] = json!(provider);
            if let Some(declared) = structured {
                model["capabilities"] = json!({"structured_output": declared});
            }
        }
    }
    f2z_ai::catalog::VerifiedCatalog::from_verified(serde_json::from_value(value).unwrap()).unwrap()
}

fn with_format(model: &str, format: &Value) -> ChatRequest {
    let mut value = serde_json::to_value(request(model)).unwrap();
    value["response_format"] = format.clone();
    serde_json::from_value(value).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_format_reaches_chat_completions_exactly_as_sent() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(0));
    // gpt-4o's shape tonight: OpenAI, Chat Completions, no declaration.
    let catalog = with_chat_model("openai", None);
    // Wire round trip: client JSON text -> proto -> gateway -> provider body.
    let activity = json!({"type": "json_schema", "json_schema": {
        "name": "activity_spec", "strict": true,
        "schema": {"type": "object", "additionalProperties": false,
                   "properties": {"title": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}}},
                   "required": ["title", "steps"]}}});
    for format in [activity, json!({"type": "json_object"})] {
        let text = format!(
            r#"{{"model":"{}","messages":[{{"role":"user","content":[{{"type":"text","text":"Reply in JSON."}}]}}],"response_format":{format}}}"#,
            CHAT.id
        );
        let request: ChatRequest = serde_json::from_str(&text).unwrap();
        let run = drive(&backend, &catalog, &request).await;
        assert_eq!(run.outcome.failure, None);
        let sent = mock.recorded_requests().last().unwrap().body.clone();
        assert_eq!(sent["response_format"], format, "sent unchanged");
        assert_eq!(sent["service_tier"], "default");
    }
    // Absent stays absent: nothing is invented for an ordinary call.
    drive(&backend, &catalog, &request(CHAT.id)).await;
    assert!(
        mock.recorded_requests()
            .last()
            .unwrap()
            .body
            .get("response_format")
            .is_none()
    );
    mock.shutdown().await;
}

/// zuu#1132: the caller's schema member order reaches the provider's wire
/// bytes — `response_format` on Chat Completions, tool `parameters` on all
/// three adapters. Read from the raw body text: the parsed `body` is a
/// `serde_json::Value`, which sorts members and so cannot see the bug.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema_member_order_reaches_the_provider_as_sent() {
    // Unsorted at every level: `reasoning` before `answer`, `type` last,
    // `zeta` before `alpha`, nested `properties` unsorted too.
    const SCHEMA: &str = r#"{"properties":{"reasoning":{"type":"string"},"answer":{"type":"object","properties":{"value":{"type":"number"},"unit":{"type":"string"}}}},"required":["reasoning","answer"],"additionalProperties":false,"type":"object"}"#;
    const PARAMETERS: &str = r#"{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"integer"}},"required":["zeta","alpha"]}"#;
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(0));
    let catalog = with_chat_model("openai", None);
    let text = |model: &str, format: bool| {
        let format = if format {
            format!(
                r#","response_format":{{"type":"json_schema","json_schema":{{"name":"activity_spec","schema":{SCHEMA},"strict":true}}}}"#
            )
        } else {
            String::new()
        };
        format!(
            r#"{{"model":"{model}","messages":[{{"role":"user","content":[{{"type":"text","text":"Reply in JSON."}}]}}],"tools":[{{"name":"lookup","parameters":{PARAMETERS}}}]{format}}}"#
        )
    };
    let sent_text = |request: ChatRequest| {
        let backend = &backend;
        let catalog = &catalog;
        let mock = &mock;
        async move {
            let run = drive(backend, catalog, &request).await;
            assert_eq!(run.outcome.failure, None, "{}", request.model);
            mock.recorded_requests()
                .last()
                .unwrap()
                .body_text
                .clone()
                .unwrap()
        }
    };
    for (model, format) in [(CHAT, true), (RESPONSES, false), (ANTHROPIC, false)] {
        // Client JSON text -> proto -> gateway -> provider bytes.
        let request: ChatRequest = serde_json::from_str(&text(model.id, format)).unwrap();
        let sent = sent_text(request).await;
        let schema_key = if model.style == ProviderStyle::AnthropicMessages {
            "input_schema"
        } else {
            "parameters"
        };
        assert!(
            sent.contains(&format!(r#""{schema_key}":{PARAMETERS}"#)),
            "{}: tool parameters reordered: {sent}",
            model.id
        );
        if format {
            assert!(
                sent.contains(&format!(
                    r#""json_schema":{{"name":"activity_spec","schema":{SCHEMA},"strict":true}}"#
                )),
                "{}: response_format schema reordered: {sent}",
                model.id
            );
        }

        // Negative control: the same request, its schemas round-tripped
        // through `serde_json::Value` as the gateway did before #1132,
        // reaches the provider sorted — so the assertions above can fail.
        let via_value: ChatRequest =
            serde_json::from_value(serde_json::from_str(&text(model.id, format)).unwrap()).unwrap();
        let sorted = sent_text(via_value).await;
        assert!(
            !sorted.contains(PARAMETERS),
            "{}: control did not reorder: {sorted}",
            model.id
        );
        assert!(sorted.contains(r#""properties":{"alpha""#), "{sorted}");
        if format {
            assert!(!sorted.contains(SCHEMA), "{sorted}");
            assert!(sorted.contains(r#""properties":{"answer""#), "{sorted}");
        }
    }
    mock.shutdown().await;
}

#[tokio::test]
async fn response_format_is_refused_before_any_io_where_it_cannot_be_honoured() {
    // Port 9 (discard): a request that got as far as I/O would fail with a
    // connection error, not this refusal.
    let backend = backend("http://127.0.0.1:9", tuning(0));
    let format = json!({"type": "json_object"});
    let cases = [
        // No translation for these APIs, whatever the catalogue says.
        (RESPONSES.id, with_chat_model("openai", None)),
        (ANTHROPIC.id, with_chat_model("openai", None)),
        // A compatible provider must be declared; absence is not support.
        (CHAT.id, with_chat_model("chatco", None)),
        // A declared `false` wins over the OpenAI default.
        (CHAT.id, with_chat_model("openai", Some(false))),
    ];
    for (model, catalog) in &cases {
        let e = backend
            .open(&with_format(model, &format), catalog, Instant::now())
            .map(|_| ())
            .unwrap_err();
        assert_eq!(
            (e.status().as_u16(), e.code()),
            (400, "invalid_request"),
            "{model}"
        );
        assert_eq!(
            e.detail_of("reason"),
            Some(&json!("response_format_unsupported")),
            "{model}"
        );
        // Negative control: without the field, the same model and catalogue
        // pass every pre-I/O check.
        assert!(
            backend
                .open(&request(model), catalog, Instant::now())
                .is_ok(),
            "{model}"
        );
    }
    // And a declaration admits a compatible provider.
    assert!(
        backend
            .open(
                &with_format(CHAT.id, &format),
                &with_chat_model("chatco", Some(true)),
                Instant::now()
            )
            .is_ok()
    );
}
