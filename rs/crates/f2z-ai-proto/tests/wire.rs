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
    AssistantMessage, ChatRequest, ChatResponse, ContentPart, FinishReason, Message, OutputPart,
    Role, ToolCall, Usage, UsageSource,
};
use f2z_ai_proto::error::{ApiError, ErrorBody, ErrorCode};
use f2z_ai_proto::event::{Delta, Done, ErrorEvent, Event, EventError, Meta, UsageEvent};

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
                schema: serde_json::json!({"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}),
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
            schema,
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
