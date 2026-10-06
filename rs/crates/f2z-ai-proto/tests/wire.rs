//! The JSON and SSE shapes, pinned as literal text.
//!
//! A round trip alone would stay green through a renamed field, because the
//! encoder and the decoder move together. These tests compare against strings
//! written out by hand, so a change to what goes on the wire fails here.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai_proto::amount::{Milli2z, Whole2z};
use f2z_ai_proto::chat::{
    AssistantMessage, ChatRequest, ChatResponse, ContentPart, FinishReason, MAX_TOOL_SCHEMA_BYTES,
    MAX_TOOLS, Message, OutputPart, Role, ToolCall, ToolChoice, Usage, UsageSource,
};
use f2z_ai_proto::error::{ApiError, ErrorBody, ErrorCode};
use f2z_ai_proto::event::{
    Delta, Done, ErrorEvent, Event, EventError, Meta, ToolCallDelta, UsageEvent,
};

#[test]
fn a_minimal_request_defaults_to_streaming() {
    let req: ChatRequest = serde_json::from_str(
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"#,
    )
    .unwrap();
    assert!(req.stream);
    assert!(req.tools.is_empty() && req.fallback.is_empty() && req.metadata.is_empty());
    assert_eq!(req.max_output_tokens, None);
    assert_eq!(
        req.messages[0].content,
        vec![ContentPart::Text { text: "hi".into() }]
    );
    // Serializes back to the same minimal form plus the explicit stream flag.
    assert_eq!(
        serde_json::to_string(&req).unwrap(),
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"stream":true}"#
    );
}

#[test]
fn a_full_request_parses() {
    let req: ChatRequest = serde_json::from_str(
        r#"{
          "model": "m",
          "messages": [
            {"role": "system", "content": [{"type": "text", "text": "be brief"}]},
            {"role": "user", "content": [
              {"type": "text", "text": "what is this?"},
              {"type": "image", "media_type": "image/png", "data": "iVBORw0KGgo="}
            ]},
            {"role": "assistant", "tool_calls": [{"id": "t1", "name": "lookup", "arguments": "{\"q\":1}"}]},
            {"role": "tool", "tool_call_id": "t1", "content": [{"type": "text", "text": "42"}]}
          ],
          "tools": [{"name": "lookup", "parameters": {"type": "object"}}],
          "max_output_tokens": 256,
          "stream": false,
          "metadata": {"lesson": "3"},
          "fallback": ["m2"]
        }"#,
    )
    .unwrap();
    assert!(!req.stream);
    assert_eq!(req.max_output_tokens, Some(256));
    assert_eq!(req.messages[2].role, Role::Assistant);
    assert_eq!(req.messages[3].tool_call_id.as_deref(), Some("t1"));
    assert_eq!(req.fallback, vec!["m2".to_string()]);
}

#[test]
fn strict_output_tokens_is_opt_in_and_pinned() {
    // Absent and `false` are the same request, and neither puts the flag on
    // the wire: a pre-#1122 request keeps its bytes, and so its idempotency
    // fingerprint.
    let base = r#"{"model":"m","messages":[],"max_output_tokens":1800,"stream":true}"#;
    let absent: ChatRequest = serde_json::from_str(base).unwrap();
    assert!(!absent.max_output_tokens_strict);
    assert_eq!(serde_json::to_string(&absent).unwrap(), base);
    let off: ChatRequest = serde_json::from_str(
        r#"{"model":"m","messages":[],"max_output_tokens":1800,"max_output_tokens_strict":false}"#,
    )
    .unwrap();
    assert_eq!(off, absent);

    let strict = r#"{"model":"m","messages":[],"max_output_tokens":1800,"max_output_tokens_strict":true,"stream":true}"#;
    let on: ChatRequest = serde_json::from_str(strict).unwrap();
    assert!(on.max_output_tokens_strict);
    assert_eq!(serde_json::to_string(&on).unwrap(), strict);
    // A string or number is refused, not coerced.
    for bad in [
        r#"{"model":"m","messages":[],"max_output_tokens_strict":"true"}"#,
        r#"{"model":"m","messages":[],"max_output_tokens_strict":1}"#,
    ] {
        assert!(serde_json::from_str::<ChatRequest>(bad).is_err(), "{bad}");
    }
}

#[test]
fn response_format_is_opt_in_and_pinned() {
    use f2z_ai_proto::chat::{JsonSchemaFormat, MAX_RESPONSE_SCHEMA_BYTES, ResponseFormat};

    // Absent: not on the wire, so a pre-existing request keeps its bytes —
    // and its idempotency fingerprint.
    let base = r#"{"model":"m","messages":[],"stream":true}"#;
    let absent: ChatRequest = serde_json::from_str(base).unwrap();
    assert_eq!(absent.response_format, None);
    assert_eq!(serde_json::to_string(&absent).unwrap(), base);

    // The two shapes, pinned as literal text in both directions.
    let schema = r#"{"model":"m","messages":[],"stream":true,"response_format":{"type":"json_schema","json_schema":{"name":"activity_spec","schema":{"properties":{"title":{"type":"string"}},"required":["title"],"type":"object"},"strict":true}}}"#;
    let on: ChatRequest = serde_json::from_str(schema).unwrap();
    assert_eq!(
        on.response_format,
        Some(ResponseFormat::JsonSchema {
            json_schema: JsonSchemaFormat {
                name: "activity_spec".into(),
                schema: serde_json::json!({"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}).into(),
                strict: Some(true),
            }
        })
    );
    assert_eq!(serde_json::to_string(&on).unwrap(), schema);
    on.response_format.as_ref().unwrap().check().unwrap();

    let object =
        r#"{"model":"m","messages":[],"stream":true,"response_format":{"type":"json_object"}}"#;
    let on: ChatRequest = serde_json::from_str(object).unwrap();
    assert_eq!(on.response_format, Some(ResponseFormat::JsonObject {}));
    assert_eq!(serde_json::to_string(&on).unwrap(), object);

    // `strict` absent stays absent (the provider's default), never `false`.
    let lax: ResponseFormat = serde_json::from_str(
        r#"{"type":"json_schema","json_schema":{"name":"n","schema":{"type":"object"}}}"#,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&lax).unwrap(),
        r#"{"type":"json_schema","json_schema":{"name":"n","schema":{"type":"object"}}}"#
    );

    // Refused at decode: unknown types (including `text`, the default),
    // a missing type, unknown members at either level, coerced booleans.
    for bad in [
        r#"{"type":"text"}"#,
        r#"{"type":"xml"}"#,
        r#"{"json_schema":{"name":"n","schema":{}}}"#,
        r#"{"type":"json_object","schema":{}}"#,
        r#"{"type":"json_schema"}"#,
        r#"{"type":"json_schema","json_schema":{"name":"n"}}"#,
        r#"{"type":"json_schema","json_schema":{"name":"n","schema":{},"description":"x"}}"#,
        r#"{"type":"json_schema","json_schema":{"name":"n","schema":{},"strict":"true"}}"#,
        r#"{"type":"json_schema","json_schema":{"name":"n","schema":{},"strict":null}}"#,
        r#""json_object""#,
        // A present null is a constraint the caller asked for, not absence.
        "null",
    ] {
        let body = format!(r#"{{"model":"m","messages":[],"response_format":{bad}}}"#);
        assert!(
            serde_json::from_str::<ChatRequest>(&body).is_err(),
            "accepted {bad}"
        );
    }

    // Decodes, but outside the limits `check` holds.
    let format = |name: &str, schema: serde_json::Value| ResponseFormat::JsonSchema {
        json_schema: JsonSchemaFormat {
            name: name.into(),
            schema: schema.into(),
            strict: None,
        },
    };
    let object = serde_json::json!({"type": "object"});
    for (format, field, reason) in [
        (
            format("", object.clone()),
            "response_format.json_schema.name",
            "empty",
        ),
        (
            format(&"n".repeat(65), object.clone()),
            "response_format.json_schema.name",
            "too_long",
        ),
        (
            format("has space", object.clone()),
            "response_format.json_schema.name",
            "invalid_characters",
        ),
        (
            format("n", serde_json::json!([])),
            "response_format.json_schema.schema",
            "not_object",
        ),
        (
            format("n", serde_json::json!(true)),
            "response_format.json_schema.schema",
            "not_object",
        ),
    ] {
        let error = format.check().unwrap_err();
        assert_eq!((error.field, error.reason), (field, reason));
    }
    format(&"n".repeat(64), object).check().unwrap();

    // The size bound is exact: a schema of exactly the limit passes, one byte
    // more does not. `{"d":"…"}` is 8 bytes of framing around the string.
    let sized = |bytes: usize| format("n", serde_json::json!({"d": "x".repeat(bytes - 8)}));
    sized(MAX_RESPONSE_SCHEMA_BYTES).check().unwrap();
    let error = sized(MAX_RESPONSE_SCHEMA_BYTES + 1).check().unwrap_err();
    assert_eq!(error.reason, "too_large");
}

/// zuu#1132: schema member order is the caller's, through decode and
/// encode, for both `response_format` and tool `parameters` — byte for byte.
#[test]
fn schema_member_order_survives_the_wire() {
    // Deliberately NOT sorted: `reasoning` before `answer`, `type` last,
    // `zeta` before `alpha`, nested objects unsorted too.
    let body = r#"{"model":"m","messages":[],"tools":[{"name":"lookup","parameters":{"type":"object","properties":{"zeta":{"type":"string","description":"z"},"alpha":{"type":"integer"}},"required":["zeta","alpha"]}}],"stream":false,"response_format":{"type":"json_schema","json_schema":{"name":"activity_spec","schema":{"properties":{"reasoning":{"type":"string"},"answer":{"type":"number"}},"required":["reasoning","answer"],"additionalProperties":false,"type":"object"},"strict":true}}}"#;
    let request: ChatRequest = serde_json::from_str(body).unwrap();
    assert_eq!(serde_json::to_string(&request).unwrap(), body);

    // Negative control: the same body through `serde_json::Value` — what
    // these fields were before #1132 — comes out reordered, so the assertion
    // above can fail.
    let value: serde_json::Value = serde_json::from_str(body).unwrap();
    let through_value = serde_json::to_string(&value["response_format"]).unwrap();
    assert!(
        through_value.find("\"answer\"") < through_value.find("\"reasoning\""),
        "{through_value}"
    );
    let tools = serde_json::to_string(&value["tools"]).unwrap();
    assert!(tools.find("\"alpha\"") < tools.find("\"zeta\""), "{tools}");
}

#[test]
fn tool_choice_and_parallel_tool_calls_are_opt_in_and_pinned() {
    use f2z_ai_proto::chat::ToolChoice;

    // Absent: not on the wire, so a pre-existing request keeps its bytes.
    let base = r#"{"model":"m","messages":[],"stream":true}"#;
    let absent: ChatRequest = serde_json::from_str(base).unwrap();
    assert_eq!(
        (absent.tool_choice.clone(), absent.parallel_tool_calls),
        (None, None)
    );
    assert_eq!(serde_json::to_string(&absent).unwrap(), base);

    // OpenAI's four shapes, pinned as literal text in both directions.
    for (text, choice) in [
        (r#""auto""#, ToolChoice::Auto),
        (r#""none""#, ToolChoice::None),
        (r#""required""#, ToolChoice::Required),
        (
            r#"{"type":"function","function":{"name":"lookup"}}"#,
            ToolChoice::Function {
                name: "lookup".into(),
            },
        ),
    ] {
        let body = format!(
            r#"{{"model":"m","messages":[],"stream":true,"tool_choice":{text},"parallel_tool_calls":false}}"#
        );
        let on: ChatRequest = serde_json::from_str(&body).unwrap();
        assert_eq!(on.tool_choice, Some(choice), "{text}");
        assert_eq!(on.parallel_tool_calls, Some(false));
        assert_eq!(serde_json::to_string(&on).unwrap(), body);
    }

    // Refused at decode, never read as absent or as a default: an unknown
    // mode, another `type`, extra members at either level, a null.
    for bad in [
        r#""any""#,
        r#""Auto""#,
        r#"{"type":"tool","name":"lookup"}"#,
        r#"{"type":"function"}"#,
        r#"{"type":"function","function":{}}"#,
        r#"{"type":"function","function":{"name":"lookup","strict":true}}"#,
        r#"{"type":"function","function":{"name":"lookup"},"extra":1}"#,
        r#"{"function":{"name":"lookup"}}"#,
        r#"true"#,
        "null",
    ] {
        let body = format!(r#"{{"model":"m","messages":[],"tool_choice":{bad}}}"#);
        assert!(
            serde_json::from_str::<ChatRequest>(&body).is_err(),
            "accepted tool_choice {bad}"
        );
    }
    for bad in ["null", r#""false""#, "0"] {
        let body = format!(r#"{{"model":"m","messages":[],"parallel_tool_calls":{bad}}}"#);
        assert!(
            serde_json::from_str::<ChatRequest>(&body).is_err(),
            "accepted parallel_tool_calls {bad}"
        );
    }
    // The decode error names the shape, never the caller's value.
    let error = serde_json::from_str::<ChatRequest>(
        r#"{"model":"m","messages":[],"tool_choice":"CANARY-VALUE"}"#,
    )
    .unwrap_err()
    .to_string();
    assert!(!error.contains("CANARY"), "{error}");
}

#[test]
fn reasoning_effort_is_opt_in_and_pinned() {
    use f2z_ai_proto::chat::ReasoningEffort;

    // Absent: not on the wire, so a pre-existing request keeps its bytes
    // (and its idempotency fingerprint).
    let base = r#"{"model":"m","messages":[],"stream":true}"#;
    let absent: ChatRequest = serde_json::from_str(base).unwrap();
    assert_eq!(absent.reasoning_effort, None);
    assert_eq!(serde_json::to_string(&absent).unwrap(), base);
    assert_eq!(
        serde_json::to_string(&ChatRequest::new("m", vec![])).unwrap(),
        base
    );

    // OpenAI's four values, pinned as literal text in both directions.
    for (text, effort) in [
        ("minimal", ReasoningEffort::Minimal),
        ("low", ReasoningEffort::Low),
        ("medium", ReasoningEffort::Medium),
        ("high", ReasoningEffort::High),
    ] {
        let body =
            format!(r#"{{"model":"m","messages":[],"stream":true,"reasoning_effort":"{text}"}}"#);
        let on: ChatRequest = serde_json::from_str(&body).unwrap();
        assert_eq!(on.reasoning_effort, Some(effort), "{text}");
        assert_eq!(effort.as_str(), text);
        assert_eq!(serde_json::to_string(&on).unwrap(), body);
        assert_eq!(
            ChatRequest::new("m", vec![]).with_reasoning_effort(effort),
            on
        );
    }

    // Refused at decode, never mapped to a neighbour or read as absent:
    // provider values the unified wire does not carry, another case, a
    // non-string, a null.
    for bad in [
        r#""none""#,
        r#""xhigh""#,
        r#""High""#,
        r#""""#,
        "1",
        "{}",
        "null",
    ] {
        let body = format!(r#"{{"model":"m","messages":[],"reasoning_effort":{bad}}}"#);
        assert!(
            serde_json::from_str::<ChatRequest>(&body).is_err(),
            "accepted reasoning_effort {bad}"
        );
    }
    // The decode error names the shape, never the caller's value.
    let error = serde_json::from_str::<ChatRequest>(
        r#"{"model":"m","messages":[],"reasoning_effort":"CANARY-VALUE"}"#,
    )
    .unwrap_err()
    .to_string();
    assert!(!error.contains("CANARY"), "{error}");
}

#[test]
fn reasoning_effort_capability_and_levels_are_signed_members() {
    use f2z_ai_proto::catalog::{ModelCapabilities, ModelControls};

    // Absent reads as unsupported and not narrowed, and re-encodes as before.
    let caps: ModelCapabilities = serde_json::from_str(r#"{"reasoning":true}"#).unwrap();
    assert!(!caps.reasoning_effort);
    assert_eq!(
        serde_json::to_string(&caps).unwrap(),
        r#"{"vision":false,"tools":false,"reasoning":true}"#
    );
    let caps: ModelCapabilities =
        serde_json::from_str(r#"{"reasoning":true,"reasoning_effort":true}"#).unwrap();
    assert!(caps.reasoning_effort);
    assert_eq!(
        serde_json::to_string(&caps).unwrap(),
        r#"{"vision":false,"tools":false,"reasoning":true,"reasoning_effort":true}"#
    );
    for bad in [
        r#"{"reasoning_effort":null}"#,
        r#"{"reasoning_effort":"true"}"#,
    ] {
        assert!(
            serde_json::from_str::<ModelCapabilities>(bad).is_err(),
            "{bad}"
        );
    }
    let controls: ModelControls =
        serde_json::from_str(r#"{"effort_levels":["low","high","xhigh"]}"#).unwrap();
    assert_eq!(
        controls.effort_levels.as_deref(),
        Some(&["low".to_owned(), "high".to_owned(), "xhigh".to_owned()][..])
    );
    assert_eq!(
        serde_json::to_string(&ModelControls::default()).unwrap(),
        "{}"
    );
}

#[test]
fn requests_are_strict() {
    for bad in [
        // misspelt cap: must not be silently ignored
        r#"{"model":"m","messages":[],"max_tokens":5}"#,
        // image by URL: the gateway never fetches client URLs
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"image","url":"http://x"}]}]}"#,
        r#"{"model":"m","messages":[{"role":"robot"}]}"#,
        // strictness reaches nested request types too
        r#"{"model":"m","messages":[{"role":"assistant","tool_calls":[{"id":"t","name":"f","arguments":"{}","extra":1}]}]}"#,
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"x","extra":1}]}]}"#,
        r#"{"model":"m","messages":[],"tools":[{"name":"f","parameters":{},"extra":1}]}"#,
    ] {
        assert!(serde_json::from_str::<ChatRequest>(bad).is_err(), "{bad}");
    }
}

#[test]
fn every_event_has_a_pinned_sse_frame() {
    let cases = [
        (
            Event::Meta(Meta::new("c_1", "m", Whole2z::new(3))),
            "event: meta\ndata: {\"call_id\":\"c_1\",\"model\":\"m\",\"hold_2z\":3}\n\n",
        ),
        (
            Event::Delta(Delta {
                text: "line1\nline2".into(),
            }),
            "event: delta\ndata: {\"text\":\"line1\\nline2\"}\n\n",
        ),
        (
            Event::ToolCall(ToolCall {
                id: "t1".into(),
                name: "lookup".into(),
                arguments: "{}".into(),
            }),
            "event: tool_call\ndata: {\"id\":\"t1\",\"name\":\"lookup\",\"arguments\":\"{}\"}\n\n",
        ),
        (
            Event::Usage(UsageEvent {
                usage: Usage {
                    input_tokens: 10,
                    output_tokens: 5,
                    ..Usage::default()
                },
                source: UsageSource::Provider,
            }),
            "event: usage\ndata: {\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"cache_write_tokens\":0,\"output_tokens\":5,\"reasoning_tokens\":0,\"images\":0,\"tool_calls\":0},\"source\":\"provider\"}\n\n",
        ),
        (
            Event::Done(Done {
                balance_hint_milli_2z: Some(Milli2z::new(97_000)),
                ..Done::settled(Whole2z::new(3), "r_1", FinishReason::Stop)
            }),
            "event: done\ndata: {\"charged_2z\":3,\"receipt_id\":\"r_1\",\"finish_reason\":\"stop\",\"balance_hint_milli_2z\":97000,\"settlement\":\"settled\",\"usage_source\":\"provider\"}\n\n",
        ),
        (
            Event::Error(ErrorEvent::uncharged(
                ErrorCode::InsufficientBalance,
                "balance too low",
            )),
            "event: error\ndata: {\"code\":\"insufficient_balance\",\"message\":\"balance too low\",\"settlement\":\"settled\",\"charged_2z\":0,\"partial\":false}\n\n",
        ),
    ];
    for (event, frame) in cases {
        assert_eq!(event.to_sse().unwrap(), frame, "{}", event.name());
        // And back, from the parts an SSE reader hands over.
        let data = frame
            .strip_prefix(&format!("event: {}\ndata: ", event.name()))
            .unwrap()
            .strip_suffix("\n\n")
            .unwrap();
        assert_eq!(Event::from_sse(event.name(), data).unwrap(), event);
    }
}

#[test]
fn the_ipc_form_is_tagged() {
    let event = Event::Meta(Meta::new("c", "m", Whole2z::new(1)));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"meta","call_id":"c","model":"m","hold_2z":1}"#
    );
    assert!(!event.is_terminal());
}

#[test]
fn clients_tolerate_what_a_newer_gateway_adds() {
    // A new field on a known event.
    let e = Event::from_sse(
        "done",
        r#"{"charged_2z":1,"receipt_id":"r","finish_reason":"brand_new_reason","extra":true}"#,
    )
    .unwrap();
    assert!(e.is_terminal());
    let Event::Done(done) = e else { panic!() };
    assert_eq!(done.finish_reason, FinishReason::Unknown);
    // A new error code.
    let Event::Error(err) = Event::from_sse("error", r#"{"code":"new_code"}"#).unwrap() else {
        panic!()
    };
    assert_eq!(err.code, ErrorCode::Unknown);
    // A new event kind: reported, so the reader can skip it.
    assert!(matches!(
        Event::from_sse("thinking", "{}"),
        Err(EventError::UnknownEvent(name)) if name == "thinking"
    ));
}

#[test]
fn error_codes_are_stable_strings_with_statuses() {
    // The original seventeen, pinned by hand; `spec_conformance.rs` checks
    // every code against errors.md.
    let all = [
        (ErrorCode::InvalidRequest, "invalid_request", 400),
        (ErrorCode::InvalidToken, "invalid_token", 401),
        (ErrorCode::InsufficientScope, "insufficient_scope", 403),
        (
            ErrorCode::InsufficientUserAuthentication,
            "insufficient_user_authentication",
            401,
        ),
        (ErrorCode::InsufficientBalance, "insufficient_balance", 402),
        (ErrorCode::CapExceeded, "cap_exceeded", 403),
        (ErrorCode::ModelNotFound, "model_not_found", 404),
        (ErrorCode::ModelDisabled, "model_disabled", 403),
        (
            ErrorCode::ContextLengthExceeded,
            "context_length_exceeded",
            400,
        ),
        (ErrorCode::PayloadTooLarge, "payload_too_large", 413),
        (ErrorCode::RateLimited, "rate_limited", 429),
        (ErrorCode::ConcurrencyLimit, "concurrency_limit", 429),
        (ErrorCode::ProviderError, "provider_error", 502),
        (ErrorCode::ProviderTimeout, "provider_timeout", 504),
        (ErrorCode::CatalogUnavailable, "catalog_unavailable", 503),
        (ErrorCode::Unavailable, "unavailable", 503),
        (ErrorCode::Internal, "internal", 500),
    ];
    for (code, wire, status) in all {
        assert_eq!(serde_json::to_string(&code).unwrap(), format!("\"{wire}\""));
        assert_eq!(code.as_str(), wire);
        assert_eq!(code.http_status(), Some(status), "{wire}");
    }
    let body = ErrorBody {
        error: ApiError {
            code: ErrorCode::CapExceeded,
            message: "cap".into(),
            details: None,
        },
    };
    assert_eq!(
        serde_json::to_string(&body).unwrap(),
        r#"{"error":{"code":"cap_exceeded","message":"cap"}}"#
    );
}

#[test]
fn an_assistant_message_round_trips() {
    let m = Message {
        role: Role::Assistant,
        content: vec![ContentPart::Text { text: "ok".into() }],
        tool_calls: vec![],
        tool_call_id: None,
    };
    assert_eq!(
        serde_json::to_string(&m).unwrap(),
        r#"{"role":"assistant","content":[{"type":"text","text":"ok"}]}"#
    );
}

#[test]
fn a_response_tolerates_what_a_newer_gateway_adds() {
    // Unknown members at every level, and an unknown content-part type, must
    // not make a client reject a completed, charged answer.
    let resp: ChatResponse = serde_json::from_str(
        r#"{
          "call_id": "c", "model": "m",
          "message": {
            "content": [
              {"type": "text", "text": "hel", "annotations": []},
              {"type": "citation", "url": "x"},
              {"type": "text", "text": "lo"}
            ],
            "annotations": [],
            "tool_calls": [{"id": "t", "name": "f", "arguments": "{}", "index": 0}]
          },
          "finish_reason": "stop",
          "usage": {"input_tokens": 1, "output_tokens": 2, "audio_tokens": 3},
          "charged_2z": 1, "receipt_id": "r",
          "brand_new": true
        }"#,
    )
    .unwrap();
    assert_eq!(resp.message.text(), "hello");
    assert_eq!(resp.message.content[1], OutputPart::Unknown);
    assert_eq!(resp.usage_source, UsageSource::Provider);
    let history = resp.message.into_message();
    assert_eq!(history.role, Role::Assistant);
    assert_eq!(history.content.len(), 2, "the unknown part is dropped");
    assert_eq!(history.tool_calls.len(), 1);
    // …and the resulting history message is a valid strict request message.
    let json = serde_json::to_string(&history).unwrap();
    serde_json::from_str::<Message>(&json).unwrap();
    let _ = AssistantMessage::default();
}

#[test]
fn a_new_usage_source_does_not_discard_a_paid_answer() {
    let Event::Usage(u) = Event::from_sse(
        "usage",
        r#"{"usage":{"input_tokens":1},"source":"partial"}"#,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(u.source, UsageSource::Unknown);
    assert_eq!(u.usage.input_tokens, 1);
}

#[test]
fn a_crlf_reader_still_parses() {
    // A reader that split lines on `\n` alone leaves the `\r` of a CRLF stream
    // on the event name.
    let e = Event::from_sse("delta\r", r#"{"text":"x"}"#).unwrap();
    assert_eq!(e, Event::Delta(Delta { text: "x".into() }));
}

#[test]
fn the_ipc_form_parses_and_an_unknown_type_is_skippable() {
    let e = Event::from_ipc_json(r#"{"type":"delta","text":"x"}"#).unwrap();
    assert_eq!(e, Event::Delta(Delta { text: "x".into() }));
    assert!(matches!(
        Event::from_ipc_json(r#"{"type":"thinking","text":"x"}"#),
        Err(EventError::UnknownEvent(name)) if name == "thinking"
    ));
    assert!(matches!(
        Event::from_ipc_json(r#"{"type":"delta"}"#),
        Err(EventError::Payload(_))
    ));
    assert!(matches!(
        Event::from_ipc_json("not json"),
        Err(EventError::Payload(_))
    ));
}

// zuu#1128: tool calling. Literal text, so a renamed member fails here.
#[test]
fn tool_controls_are_openai_shaped_on_the_wire_and_omitted_when_absent() {
    let text = r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"tools":[{"name":"check_answer","description":"Grade","parameters":{"type":"object"},"strict":true}],"stream":true,"tool_choice":{"type":"function","function":{"name":"check_answer"}},"parallel_tool_calls":false}"#;
    let req: ChatRequest = serde_json::from_str(text).unwrap();
    assert_eq!(req.tools[0].strict, Some(true));
    assert_eq!(
        req.tool_choice,
        Some(ToolChoice::Function {
            name: "check_answer".into()
        })
    );
    assert_eq!(req.parallel_tool_calls, Some(false));
    req.check_tools().unwrap();
    assert_eq!(serde_json::to_string(&req).unwrap(), text);
    for (mode, choice) in [
        ("auto", ToolChoice::Auto),
        ("none", ToolChoice::None),
        ("required", ToolChoice::Required),
    ] {
        let wire = format!("\"{mode}\"");
        assert_eq!(serde_json::to_string(&choice).unwrap(), wire);
        assert_eq!(serde_json::from_str::<ToolChoice>(&wire).unwrap(), choice);
    }
    // Absent stays absent: an old request is byte-identical.
    let plain: ChatRequest = serde_json::from_str(
        r#"{"model":"m","messages":[],"tools":[{"name":"f","parameters":{}}]}"#,
    )
    .unwrap();
    let out = serde_json::to_string(&plain).unwrap();
    for member in ["strict", "tool_choice", "parallel_tool_calls"] {
        assert!(
            !out.contains(member),
            "{member} serialized when absent: {out}"
        );
    }
}

#[test]
fn tool_controls_refuse_null_and_shapes_from_other_apis() {
    let base = |extra: &str| {
        format!(r#"{{"model":"m","messages":[],"tools":[{{"name":"f","parameters":{{}}{extra}}}]"#)
    };
    for bad in [
        format!("{},\"tool_choice\":null}}", base("")),
        format!("{},\"tool_choice\":\"any\"}}", base("")),
        format!(
            "{},\"tool_choice\":{{\"type\":\"tool\",\"name\":\"f\"}}}}",
            base("")
        ),
        format!(
            "{},\"tool_choice\":{{\"type\":\"function\",\"function\":{{\"name\":\"f\"}},\"x\":1}}}}",
            base("")
        ),
        format!("{},\"parallel_tool_calls\":null}}", base("")),
        format!("{}}}", base(",\"strict\":null")),
        format!("{}}}", base(",\"strict\":\"true\"")),
    ] {
        assert!(
            serde_json::from_str::<ChatRequest>(&bad).is_err(),
            "accepted {bad}"
        );
    }
}

#[test]
fn check_tools_names_the_broken_limit() {
    let req = |value: serde_json::Value| -> ChatRequest { serde_json::from_value(value).unwrap() };
    let tool = |name: &str| serde_json::json!({"name": name, "parameters": {"type": "object"}});
    let cases = [
        (
            serde_json::json!({"tools": [tool("has space")]}),
            "tools[0].name",
            "invalid_characters",
        ),
        (
            serde_json::json!({"tools": [tool(&"n".repeat(65))]}),
            "tools[0].name",
            "too_long",
        ),
        (
            serde_json::json!({"tools": [tool("f"), tool("f")]}),
            "tools[1].name",
            "duplicate",
        ),
        (
            serde_json::json!({"tools": [{"name": "f", "parameters": {"d": "x".repeat(MAX_TOOL_SCHEMA_BYTES)}}]}),
            "tools[0].parameters",
            "too_large",
        ),
        (
            serde_json::json!({"tools": (0..=MAX_TOOLS).map(|i| tool(&format!("f{i}"))).collect::<Vec<_>>()}),
            "tools",
            "too_many",
        ),
        (
            serde_json::json!({"tool_choice": "auto"}),
            "tool_choice",
            "requires_tools",
        ),
        (
            serde_json::json!({"parallel_tool_calls": true}),
            "parallel_tool_calls",
            "requires_tools",
        ),
        (
            serde_json::json!({"tools": [tool("f")], "tool_choice": {"type": "function", "function": {"name": "g"}}}),
            "tool_choice.function.name",
            "unknown_tool",
        ),
    ];
    for (mut value, field, reason) in cases {
        value["model"] = "m".into();
        value["messages"] = serde_json::json!([]);
        let error = req(value).check_tools().unwrap_err();
        assert_eq!((error.field.as_str(), error.reason), (field, reason));
    }
    // Negative control: the limits themselves are allowed.
    let mut ok = serde_json::json!({"model": "m", "messages": [],
        "tools": (0..MAX_TOOLS).map(|i| tool(&format!("f_{i}-x"))).collect::<Vec<_>>(),
        "tool_choice": "required", "parallel_tool_calls": false});
    ok["tools"][0]["name"] = "n".repeat(64).into();
    req(ok).check_tools().unwrap();
}

#[test]
fn a_tool_call_delta_frame_is_pinned_and_skippable_by_an_old_reader() {
    let first = Event::ToolCallDelta(ToolCallDelta {
        index: 0,
        id: Some("call_1".into()),
        name: Some("check_answer".into()),
        arguments: String::new(),
    });
    assert_eq!(
        first.to_sse().unwrap(),
        "event: tool_call_delta\ndata: {\"index\":0,\"id\":\"call_1\",\"name\":\"check_answer\",\"arguments\":\"\"}\n\n"
    );
    let next = Event::from_sse("tool_call_delta", r#"{"index":1,"arguments":"{\"a\""}"#).unwrap();
    assert_eq!(
        next,
        Event::ToolCallDelta(ToolCallDelta {
            index: 1,
            id: None,
            name: None,
            arguments: "{\"a\"".into()
        })
    );
    assert!(f2z_ai_proto::event::KNOWN_EVENTS.contains(&"tool_call_delta"));
    assert!(matches!(
        Event::from_ipc_json(r#"{"type":"tool_call_delta","index":0,"arguments":"{}"}"#),
        Ok(Event::ToolCallDelta(_))
    ));
}
