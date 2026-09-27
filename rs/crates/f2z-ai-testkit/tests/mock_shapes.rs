//! The mock's streams, rendered without a socket: every style's event grammar,
//! usage conventions and faults.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use core::time::Duration;

use common::{adapter_usage, frames, visible_text};
use f2z_ai_testkit::mock::{
    ChatFlavor, Fault, Plan, ProviderStyle, RenderContext, Scenario, Step, plan,
};
use serde_json::Value;

fn ctx(include_usage: bool) -> RenderContext {
    RenderContext {
        model: "mock-model".into(),
        include_usage,
        request_seq: 7,
    }
}

fn stream(style: ProviderStyle, s: &Scenario, include_usage: bool) -> (Vec<Step>, bool) {
    match plan(style, s, &ctx(include_usage)) {
        Plan::Stream { steps, abort } => (steps, abort),
        Plan::Status { .. } => panic!("expected a stream"),
    }
}

fn body(style: ProviderStyle, s: &Scenario, include_usage: bool) -> Vec<u8> {
    plan(style, s, &ctx(include_usage)).body_bytes()
}

/// A spread of scenarios exercising every usage bucket.
fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario::default(),
        Scenario::default().with_output_tokens(0),
        Scenario::default()
            .with_input_tokens(1_200)
            .with_cache(5_000, 800)
            .with_output_tokens(350)
            .with_reasoning_tokens(100),
        // Reasoning above output is clamped, never negative visible output.
        Scenario::default()
            .with_output_tokens(5)
            .with_reasoning_tokens(50),
    ]
}

#[test]
fn a_reference_adapter_derives_exactly_the_expected_usage_in_every_style() {
    for s in scenarios() {
        for flavor in [ChatFlavor::OpenAi, ChatFlavor::Xai] {
            let s = s.clone().with_chat_flavor(flavor);
            for style in ProviderStyle::ALL {
                let b = body(style, &s, true);
                assert_eq!(
                    adapter_usage(style, flavor, &b),
                    s.expected_usage(style, true),
                    "{style:?} {flavor:?} {s:?}"
                );
                assert_eq!(
                    visible_text(style, &b).split_whitespace().count() as u64,
                    s.visible_tokens(),
                    "{style:?}: one visible delta per visible token"
                );
            }
        }
    }
}

#[test]
fn responses_events_are_named_sequenced_and_end_in_response_completed() {
    let s = Scenario::default()
        .with_output_tokens(4)
        .with_reasoning_tokens(1);
    let fs = frames(&body(ProviderStyle::OpenAiResponses, &s, true));
    let names: Vec<_> = fs.iter().map(|f| f.event.clone().unwrap()).collect();
    assert_eq!(names.first().unwrap(), "response.created");
    assert_eq!(names[1], "response.in_progress");
    assert_eq!(names.last().unwrap(), "response.completed");
    assert_eq!(
        names
            .iter()
            .filter(|n| *n == "response.output_text.delta")
            .count(),
        3
    );
    for (i, f) in fs.iter().enumerate() {
        let v = f.json();
        assert_eq!(
            v["type"],
            f.event.clone().unwrap(),
            "type matches event name"
        );
        assert_eq!(
            v["sequence_number"], i as u64,
            "contiguous sequence numbers"
        );
    }
    // The reasoning item precedes the message item.
    assert_eq!(fs[2].json()["item"]["type"], "reasoning");
    let usage = &fs.last().unwrap().json()["response"]["usage"];
    assert_eq!(usage["output_tokens"], 4, "output includes reasoning");
    assert_eq!(usage["output_tokens_details"]["reasoning_tokens"], 1);
    assert_eq!(usage["total_tokens"], 12 + 4);
}

#[test]
fn responses_input_tokens_include_cached_and_fold_in_cache_writes() {
    let s = Scenario::default()
        .with_input_tokens(100)
        .with_cache(40, 10);
    let fs = frames(&body(ProviderStyle::OpenAiResponses, &s, true));
    let usage = &fs.last().unwrap().json()["response"]["usage"];
    assert_eq!(usage["input_tokens"], 150);
    assert_eq!(usage["input_tokens_details"]["cached_tokens"], 40);
    let expected = s
        .expected_usage(ProviderStyle::OpenAiResponses, true)
        .unwrap();
    assert_eq!(
        expected.input_tokens, 110,
        "cache writes arrive as uncached"
    );
    assert_eq!(expected.cache_write_tokens, 0);
}

#[test]
fn chat_sends_usage_only_when_include_usage_was_requested() {
    let s = Scenario::default().with_output_tokens(3);
    // With include_usage: every chunk carries `usage`, null until the last.
    let with = frames(&body(ProviderStyle::ChatCompletions, &s, true));
    assert_eq!(with.last().unwrap().data, "[DONE]");
    let chunks: Vec<Value> = with[..with.len() - 1].iter().map(|f| f.json()).collect();
    let (last, rest) = chunks.split_last().unwrap();
    assert!(
        rest.iter()
            .all(|c| c["usage"].is_null() && c.get("usage").is_some())
    );
    assert_eq!(last["choices"], serde_json::json!([]));
    assert_eq!(last["usage"]["completion_tokens"], 3);
    assert_eq!(rest.last().unwrap()["choices"][0]["finish_reason"], "stop");
    assert_eq!(rest[0]["choices"][0]["delta"]["role"], "assistant");
    assert!(with.iter().all(|f| f.event.is_none()), "unnamed SSE only");

    // Without it: no usage member anywhere, and no usage chunk.
    let without = frames(&body(ProviderStyle::ChatCompletions, &s, false));
    assert!(
        without
            .iter()
            .filter(|f| f.data != "[DONE]")
            .all(|f| f.json().get("usage").is_none())
    );
    assert_eq!(without.len(), with.len() - 1);
    assert_eq!(
        s.expected_usage(ProviderStyle::ChatCompletions, false),
        None
    );
}

#[test]
fn xai_completion_tokens_exclude_reasoning_and_total_adds_it_back() {
    let s = Scenario::default()
        .with_input_tokens(32)
        .with_output_tokens(103)
        .with_reasoning_tokens(94)
        .with_chat_flavor(ChatFlavor::Xai);
    let fs = frames(&body(ProviderStyle::ChatCompletions, &s, true));
    let usage = fs[fs.len() - 2].json()["usage"].clone();
    assert_eq!(usage["prompt_tokens"], 32);
    assert_eq!(usage["completion_tokens"], 9);
    assert_eq!(usage["completion_tokens_details"]["reasoning_tokens"], 94);
    assert_eq!(usage["total_tokens"], 135);
    // Reading xAI's completion_tokens with OpenAI's convention under-counts.
    let naive = adapter_usage(
        ProviderStyle::ChatCompletions,
        ChatFlavor::OpenAi,
        &body(ProviderStyle::ChatCompletions, &s, true),
    )
    .unwrap();
    assert_eq!(naive.output_tokens, 9);
    assert_eq!(
        s.expected_usage(ProviderStyle::ChatCompletions, true)
            .unwrap()
            .output_tokens,
        103
    );
}

#[test]
fn anthropic_stream_has_the_published_event_grammar() {
    let s = Scenario::default()
        .with_input_tokens(20)
        .with_cache(5, 3)
        .with_output_tokens(6)
        .with_reasoning_tokens(2);
    let fs = frames(&body(ProviderStyle::AnthropicMessages, &s, true));
    let names: Vec<_> = fs.iter().map(|f| f.event.clone().unwrap()).collect();
    assert_eq!(names.first().unwrap(), "message_start");
    assert_eq!(names[names.len() - 2], "message_delta");
    assert_eq!(names.last().unwrap(), "message_stop");
    assert!(names.contains(&"ping".to_owned()));
    for f in &fs {
        assert_eq!(f.json()["type"], f.event.clone().unwrap());
    }
    let start = fs[0].json();
    let u = &start["message"]["usage"];
    assert_eq!(
        u["input_tokens"], 20,
        "input excludes cache reads and writes"
    );
    assert_eq!(u["cache_read_input_tokens"], 5);
    assert_eq!(u["cache_creation_input_tokens"], 3);
    assert_eq!(u["output_tokens"], 1, "a placeholder, not the final count");
    // The thinking block comes first, with a signature, then text at index 1.
    let blocks: Vec<Value> = fs
        .iter()
        .filter(|f| f.event.as_deref() == Some("content_block_start"))
        .map(|f| f.json())
        .collect();
    assert_eq!(blocks[0]["content_block"]["type"], "thinking");
    assert_eq!(blocks[1]["content_block"]["type"], "text");
    assert_eq!(blocks[1]["index"], 1);
    let deltas: Vec<String> = fs
        .iter()
        .filter(|f| f.event.as_deref() == Some("content_block_delta"))
        .map(|f| f.json()["delta"]["type"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(deltas.iter().filter(|d| *d == "thinking_delta").count(), 2);
    assert_eq!(deltas.iter().filter(|d| *d == "signature_delta").count(), 1);
    assert_eq!(deltas.iter().filter(|d| *d == "text_delta").count(), 4);
    let delta = fs[fs.len() - 2].json();
    assert_eq!(
        delta["usage"]["output_tokens"], 6,
        "cumulative, thinking included"
    );
    assert_eq!(delta["delta"]["stop_reason"], "end_turn");
}

#[test]
fn omitting_usage_removes_the_final_report_in_each_style() {
    let s = Scenario::default().without_usage();
    for style in ProviderStyle::ALL {
        let b = body(style, &s, true);
        assert_eq!(
            adapter_usage(style, ChatFlavor::OpenAi, &b),
            None,
            "{style:?}"
        );
        assert_eq!(s.expected_usage(style, true), None);
    }
    // Responses still completes, with usage null.
    let fs = frames(&body(ProviderStyle::OpenAiResponses, &s, true));
    assert!(fs.last().unwrap().json()["response"]["usage"].is_null());
    // Chat still ends in [DONE] even though include_usage was requested.
    let fs = frames(&body(ProviderStyle::ChatCompletions, &s, true));
    assert_eq!(fs.last().unwrap().data, "[DONE]");
    // Anthropic: message_delta without usage, message_stop still sent.
    let fs = frames(&body(ProviderStyle::AnthropicMessages, &s, true));
    assert!(fs[fs.len() - 2].json().get("usage").is_none());
}

#[test]
fn a_disconnect_sends_exactly_n_bytes_then_aborts() {
    let full = body(ProviderStyle::AnthropicMessages, &Scenario::default(), true);
    for n in [0u64, 1, 37, full.len() as u64 - 1] {
        let s = Scenario::default().with_fault(Fault::DisconnectAtByte { byte: n });
        let (steps, abort) = stream(ProviderStyle::AnthropicMessages, &s, true);
        let sent: Vec<u8> = steps.iter().flat_map(|s| s.bytes.clone()).collect();
        assert!(abort, "byte {n}");
        assert_eq!(sent.len() as u64, n);
        assert_eq!(
            &sent[..],
            &full[..n as usize],
            "a prefix of the real stream"
        );
    }
    // At or past the end, the fault never fires.
    let s = Scenario::default().with_fault(Fault::DisconnectAtByte {
        byte: full.len() as u64,
    });
    let (_, abort) = stream(ProviderStyle::AnthropicMessages, &s, true);
    assert!(!abort);
}

#[test]
fn an_error_event_lands_on_a_frame_boundary_in_the_providers_shape() {
    for style in ProviderStyle::ALL {
        let s = Scenario::default().with_fault(Fault::ErrorEventAtByte {
            byte: 200,
            status: 529,
        });
        let (steps, abort) = stream(style, &s, true);
        assert!(!abort, "an error event ends the body cleanly");
        let b: Vec<u8> = steps.iter().flat_map(|s| s.bytes.clone()).collect();
        let before: usize = steps[..steps.len() - 1].iter().map(|s| s.bytes.len()).sum();
        assert!(before >= 200, "{style:?}: injected at or after byte 200");
        let fs = frames(&b);
        let last = fs.last().unwrap();
        let v = last.json();
        match style {
            ProviderStyle::OpenAiResponses => {
                assert_eq!(last.event.as_deref(), Some("error"));
                assert_eq!(v["type"], "error");
                assert_eq!(v["code"], "server_error");
                assert_eq!(v["sequence_number"], (fs.len() - 1) as u64);
            }
            ProviderStyle::ChatCompletions => {
                assert_eq!(v["error"]["type"], "server_error");
            }
            ProviderStyle::AnthropicMessages => {
                assert_eq!(last.event.as_deref(), Some("error"));
                assert_eq!(v["error"]["type"], "overloaded_error");
            }
        }
        assert_eq!(
            adapter_usage(style, ChatFlavor::OpenAi, &b),
            None,
            "{style:?}: no usage after the error"
        );
    }
}

#[test]
fn a_status_fault_answers_with_the_providers_error_body() {
    let s = Scenario::default().with_fault(Fault::Status { status: 429 });
    match plan(ProviderStyle::OpenAiResponses, &s, &ctx(true)) {
        Plan::Status {
            status,
            retry_after,
            body,
        } => {
            assert_eq!(status, 429);
            assert_eq!(retry_after, Some(1));
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["error"]["code"], "rate_limit_exceeded");
        }
        Plan::Stream { .. } => panic!("expected a status"),
    }
    let s = Scenario::default().with_fault(Fault::Status { status: 529 });
    match plan(ProviderStyle::AnthropicMessages, &s, &ctx(true)) {
        Plan::Status {
            retry_after, body, ..
        } => {
            assert_eq!(retry_after, None);
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["type"], "error");
            assert_eq!(v["error"]["type"], "overloaded_error");
        }
        Plan::Stream { .. } => panic!("expected a status"),
    }
}

#[test]
fn pacing_spreads_tokens_at_the_requested_rate_and_stalls_add_on_top() {
    let total = |steps: &[Step]| steps.iter().map(|s| s.delay).sum::<Duration>();
    for style in ProviderStyle::ALL {
        let s = Scenario::default()
            .with_output_tokens(40)
            .with_reasoning_tokens(10)
            .with_tokens_per_sec(20);
        let (steps, _) = stream(style, &s, true);
        assert_eq!(
            total(&steps),
            Duration::from_secs(2),
            "{style:?}: 40 tokens at 20/s"
        );
        let stalled = s.clone().with_stall(3, Duration::from_millis(750));
        let (steps, _) = stream(style, &stalled, true);
        assert_eq!(total(&steps), Duration::from_millis(2_750), "{style:?}");
        let unpaced = Scenario::default().with_output_tokens(40);
        let (steps, _) = stream(style, &unpaced, true);
        assert_eq!(total(&steps), Duration::ZERO);
    }
}
