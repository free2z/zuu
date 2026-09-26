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

use f2z_ai_proto::chat::{
    ChatRequest, ContentPart, FinishReason, Message, Role, ToolCall, Usage, UsageSource,
};
use f2z_ai_proto::error::{ApiError, ErrorBody, ErrorCode};
use f2z_ai_proto::event::{Delta, Done, Event, EventError, Meta, UsageEvent};

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
fn requests_are_strict() {
    for bad in [
        // misspelt cap: must not be silently ignored
        r#"{"model":"m","messages":[],"max_tokens":5}"#,
        // image by URL: the gateway never fetches client URLs
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"image","url":"http://x"}]}]}"#,
        r#"{"model":"m","messages":[{"role":"robot"}]}"#,
    ] {
        assert!(serde_json::from_str::<ChatRequest>(bad).is_err(), "{bad}");
    }
}

#[test]
fn every_event_has_a_pinned_sse_frame() {
    let cases = [
        (
            Event::Meta(Meta {
                call_id: "c_1".into(),
                model: "m".into(),
                hold_2z: 3,
            }),
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
                charged_2z: 3,
                receipt_id: "r_1".into(),
                finish_reason: FinishReason::Stop,
                balance_hint_milli_2z: Some(97_000),
            }),
            "event: done\ndata: {\"charged_2z\":3,\"receipt_id\":\"r_1\",\"finish_reason\":\"stop\",\"balance_hint_milli_2z\":97000}\n\n",
        ),
        (
            Event::Error(ApiError {
                code: ErrorCode::Insufficient,
                message: "balance too low".into(),
            }),
            "event: error\ndata: {\"code\":\"insufficient\",\"message\":\"balance too low\"}\n\n",
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
    let event = Event::Meta(Meta {
        call_id: "c".into(),
        model: "m".into(),
        hold_2z: 1,
    });
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
    let all = [
        (ErrorCode::InvalidRequest, "invalid_request", 400),
        (ErrorCode::InvalidToken, "invalid_token", 401),
        (ErrorCode::InsufficientScope, "insufficient_scope", 403),
        (
            ErrorCode::InsufficientUserAuthentication,
            "insufficient_user_authentication",
            401,
        ),
        (ErrorCode::Insufficient, "insufficient", 402),
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
        assert_eq!(code.http_status(), status, "{wire}");
    }
    let body = ErrorBody {
        error: ApiError {
            code: ErrorCode::CapExceeded,
            message: "cap".into(),
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
