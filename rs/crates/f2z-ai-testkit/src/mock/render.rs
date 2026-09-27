//! Rendering a [`Scenario`] into the exact bytes (and pauses) one response
//! sends. Pure: no I/O and no clock, so the shapes are testable without a
//! socket and the server is only a pacing loop over a [`Plan`].

use core::time::Duration;

use serde_json::{Value, json};

use super::{ChatFlavor, Fault, ProviderStyle, Scenario};

/// Fixed `created` / `created_at` timestamp. The mock has no clock; a stable
/// value keeps every rendering reproducible.
const CREATED: u64 = 1_700_000_000;

/// The words visible deltas cycle through. One word is one token.
const WORDS: [&str; 8] = [
    "The ", "quick ", "brown ", "fox ", "jumps ", "over ", "lazy ", "dogs. ",
];

/// Per-request inputs that do not come from the [`Scenario`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderContext {
    /// The `model` echoed in the stream.
    pub model: String,
    /// Chat Completions only: whether the request set
    /// `stream_options.include_usage: true`. Ignored by the other styles,
    /// which always report usage.
    pub include_usage: bool,
    /// A per-server request counter, used to make response ids unique.
    pub request_seq: u64,
}

/// One write: wait `delay`, then send `bytes`. Every step of a stream plan is
/// exactly one SSE frame, so a step boundary is a frame boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    /// The pause before this write.
    pub delay: Duration,
    /// The bytes written.
    pub bytes: Vec<u8>,
}

/// Everything one response does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// A non-streaming error answer.
    Status {
        /// The HTTP status.
        status: u16,
        /// `retry-after` seconds, sent for `429`.
        retry_after: Option<u32>,
        /// The provider-shaped JSON error body.
        body: Vec<u8>,
    },
    /// A `200 text/event-stream` answer.
    Stream {
        /// The writes, in order.
        steps: Vec<Step>,
        /// Whether to abort the connection after the last step instead of
        /// ending the body cleanly ([`Fault::DisconnectAtByte`]).
        abort: bool,
    },
}

impl Plan {
    /// The concatenated body bytes, ignoring pauses. For tests.
    #[must_use]
    pub fn body_bytes(&self) -> Vec<u8> {
        match self {
            Self::Status { body, .. } => body.clone(),
            Self::Stream { steps, .. } => steps.iter().flat_map(|s| s.bytes.clone()).collect(),
        }
    }
}

/// Render `scenario` in `style`, with its [`Fault`] applied.
#[must_use]
pub fn plan(style: ProviderStyle, scenario: &Scenario, ctx: &RenderContext) -> Plan {
    if let Fault::Status { status } = scenario.fault {
        return Plan::Status {
            status,
            retry_after: (status == 429).then_some(1),
            body: status_body(style, status, ctx.request_seq),
        };
    }
    let steps = match style {
        ProviderStyle::OpenAiResponses => responses(scenario, ctx),
        ProviderStyle::ChatCompletions => chat(scenario, ctx),
        ProviderStyle::AnthropicMessages => anthropic(scenario, ctx),
    };
    apply_fault(style, scenario.fault, steps)
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/// The time `tokens` tokens take at `tps`, exactly, in whole nanoseconds.
fn token_time(tps: Option<u32>, tokens: u64) -> Duration {
    let Some(tps) = tps.filter(|t| *t > 0) else {
        return Duration::ZERO;
    };
    let nanos = u128::from(tokens)
        .saturating_mul(1_000_000_000)
        .checked_div(u128::from(tps))
        .unwrap_or(0);
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

/// Accumulates frames, attaching any pending pause to the next one.
struct Out {
    steps: Vec<Step>,
    pending: Duration,
}

impl Out {
    fn new() -> Self {
        Self {
            steps: Vec::new(),
            pending: Duration::ZERO,
        }
    }

    fn wait(&mut self, d: Duration) {
        self.pending = self.pending.saturating_add(d);
    }

    fn named(&mut self, event: &str, data: &Value) {
        self.push(format!("event: {event}\ndata: {data}\n\n").into_bytes());
    }

    fn data(&mut self, data: &str) {
        self.push(format!("data: {data}\n\n").into_bytes());
    }

    fn push(&mut self, bytes: Vec<u8>) {
        let delay = core::mem::take(&mut self.pending);
        self.steps.push(Step { delay, bytes });
    }

    /// The number of frames so far — also the next Responses
    /// `sequence_number`, since every frame there is one event.
    fn len(&self) -> u64 {
        u64::try_from(self.steps.len()).unwrap_or(u64::MAX)
    }
}

/// Emit `visible` deltas through `emit`, pacing each and applying the stall.
fn visible_deltas(out: &mut Out, scenario: &Scenario, mut emit: impl FnMut(&mut Out, &str)) {
    let per_token = token_time(scenario.tokens_per_sec, 1);
    let mut i: u64 = 0;
    while i < scenario.visible_tokens() {
        if let Some(stall) = scenario.stall.filter(|s| s.before_delta == i) {
            out.wait(stall.duration);
        }
        out.wait(per_token);
        emit(out, word(i));
        i = i.saturating_add(1);
    }
    // A stall at or past the last delta pauses before the closing events.
    if let Some(stall) = scenario.stall.filter(|s| s.before_delta >= i) {
        out.wait(stall.duration);
    }
}

fn word(i: u64) -> &'static str {
    let len = u64::try_from(WORDS.len()).unwrap_or(1);
    let idx = usize::try_from(i.checked_rem(len).unwrap_or(0)).unwrap_or(0);
    WORDS.get(idx).copied().unwrap_or("x ")
}

fn visible_text(scenario: &Scenario) -> String {
    let mut s = String::new();
    let mut i: u64 = 0;
    while i < scenario.visible_tokens() {
        s.push_str(word(i));
        i = i.saturating_add(1);
    }
    s
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

fn responses(scenario: &Scenario, ctx: &RenderContext) -> Vec<Step> {
    let id = format!("resp_mock_{}", ctx.request_seq);
    let msg_id = format!("msg_mock_{}", ctx.request_seq);
    let rs_id = format!("rs_mock_{}", ctx.request_seq);
    let reasoning = scenario.effective_reasoning_tokens();
    let text = visible_text(scenario);
    let response = |status: &str, output: Value, usage: Value| {
        json!({
            "id": id, "object": "response", "created_at": CREATED,
            "status": status, "model": ctx.model, "output": output, "usage": usage,
        })
    };
    let mut out = Out::new();
    let seq = |out: &Out| out.len();

    let empty = response("in_progress", json!([]), Value::Null);
    out.named(
        "response.created",
        &json!({"type": "response.created", "sequence_number": seq(&out), "response": empty}),
    );
    out.named(
        "response.in_progress",
        &json!({"type": "response.in_progress", "sequence_number": seq(&out), "response": empty}),
    );

    let mut output = Vec::new();
    let mut output_index: u64 = 0;
    if reasoning > 0 {
        let item = json!({"id": rs_id, "type": "reasoning", "summary": []});
        out.named(
            "response.output_item.added",
            &json!({"type": "response.output_item.added", "sequence_number": seq(&out),
                    "output_index": output_index, "item": item}),
        );
        out.wait(token_time(scenario.tokens_per_sec, reasoning));
        out.named(
            "response.output_item.done",
            &json!({"type": "response.output_item.done", "sequence_number": seq(&out),
                    "output_index": output_index, "item": item}),
        );
        output.push(item);
        output_index = 1;
    }

    out.named(
        "response.output_item.added",
        &json!({"type": "response.output_item.added", "sequence_number": seq(&out),
                "output_index": output_index,
                "item": {"id": msg_id, "type": "message", "status": "in_progress",
                         "role": "assistant", "content": []}}),
    );
    out.named(
        "response.content_part.added",
        &json!({"type": "response.content_part.added", "sequence_number": seq(&out),
                "item_id": msg_id, "output_index": output_index, "content_index": 0,
                "part": {"type": "output_text", "text": "", "annotations": []}}),
    );
    visible_deltas(&mut out, scenario, |out, w| {
        let s = out.len();
        out.named(
            "response.output_text.delta",
            &json!({"type": "response.output_text.delta", "sequence_number": s,
                    "item_id": msg_id, "output_index": output_index, "content_index": 0,
                    "delta": w, "logprobs": []}),
        );
    });
    out.named(
        "response.output_text.done",
        &json!({"type": "response.output_text.done", "sequence_number": seq(&out),
                "item_id": msg_id, "output_index": output_index, "content_index": 0,
                "text": text, "logprobs": []}),
    );
    let part = json!({"type": "output_text", "text": text, "annotations": []});
    out.named(
        "response.content_part.done",
        &json!({"type": "response.content_part.done", "sequence_number": seq(&out),
                "item_id": msg_id, "output_index": output_index, "content_index": 0,
                "part": part}),
    );
    let message = json!({"id": msg_id, "type": "message", "status": "completed",
                         "role": "assistant", "content": [part]});
    out.named(
        "response.output_item.done",
        &json!({"type": "response.output_item.done", "sequence_number": seq(&out),
                "output_index": output_index, "item": message}),
    );
    output.push(message);

    let usage = if scenario.omit_usage {
        Value::Null
    } else {
        // OpenAI: input includes cached (and, having no separate count, cache
        // writes); output includes reasoning.
        let input = scenario
            .input_tokens
            .saturating_add(scenario.cached_input_tokens)
            .saturating_add(scenario.cache_write_tokens);
        json!({
            "input_tokens": input,
            "input_tokens_details": {"cached_tokens": scenario.cached_input_tokens},
            "output_tokens": scenario.output_tokens,
            "output_tokens_details": {"reasoning_tokens": reasoning},
            "total_tokens": input.saturating_add(scenario.output_tokens),
        })
    };
    out.named(
        "response.completed",
        &json!({"type": "response.completed", "sequence_number": seq(&out),
                "response": response("completed", Value::Array(output), usage)}),
    );
    out.steps
}

// ---------------------------------------------------------------------------
// Chat Completions (OpenAI / xAI)
// ---------------------------------------------------------------------------

fn chat(scenario: &Scenario, ctx: &RenderContext) -> Vec<Step> {
    let id = format!("chatcmpl-mock-{}", ctx.request_seq);
    let chunk = |choices: Value, usage: Option<Value>| {
        let mut v = json!({
            "id": id, "object": "chat.completion.chunk", "created": CREATED,
            "model": ctx.model, "system_fingerprint": Value::Null, "choices": choices,
        });
        // With include_usage every chunk carries `usage`: null until the last.
        if ctx.include_usage
            && let Some(obj) = v.as_object_mut()
        {
            obj.insert("usage".into(), usage.unwrap_or(Value::Null));
        }
        v.to_string()
    };
    let choice = |delta: Value, finish: Value| json!([{"index": 0, "delta": delta, "logprobs": Value::Null, "finish_reason": finish}]);
    let mut out = Out::new();
    out.data(&chunk(
        choice(json!({"role": "assistant", "content": ""}), Value::Null),
        None,
    ));
    // Reasoning is not streamed in this shape; its time passes before the
    // first visible token.
    out.wait(token_time(
        scenario.tokens_per_sec,
        scenario.effective_reasoning_tokens(),
    ));
    visible_deltas(&mut out, scenario, |out, w| {
        out.data(&chunk(choice(json!({"content": w}), Value::Null), None));
    });
    out.data(&chunk(choice(json!({}), json!("stop")), None));
    if ctx.include_usage && !scenario.omit_usage {
        out.data(&chunk(json!([]), Some(chat_usage(scenario))));
    }
    out.data("[DONE]");
    out.steps
}

fn chat_usage(scenario: &Scenario) -> Value {
    let reasoning = scenario.effective_reasoning_tokens();
    let prompt = scenario
        .input_tokens
        .saturating_add(scenario.cached_input_tokens)
        .saturating_add(scenario.cache_write_tokens);
    let (completion, total) = match scenario.chat_flavor {
        ChatFlavor::OpenAi => (
            scenario.output_tokens,
            prompt.saturating_add(scenario.output_tokens),
        ),
        // xAI: completion excludes reasoning; total adds it back.
        ChatFlavor::Xai => {
            let completion = scenario.output_tokens.saturating_sub(reasoning);
            (
                completion,
                prompt.saturating_add(completion).saturating_add(reasoning),
            )
        }
    };
    json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "prompt_tokens_details": {"cached_tokens": scenario.cached_input_tokens},
        "completion_tokens_details": {"reasoning_tokens": reasoning},
    })
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

fn anthropic(scenario: &Scenario, ctx: &RenderContext) -> Vec<Step> {
    let reasoning = scenario.effective_reasoning_tokens();
    let mut out = Out::new();
    out.named(
        "message_start",
        &json!({"type": "message_start", "message": {
            "id": format!("msg_mock_{}", ctx.request_seq), "type": "message",
            "role": "assistant", "model": ctx.model, "content": [],
            "stop_reason": Value::Null, "stop_sequence": Value::Null,
            "usage": {
                "input_tokens": scenario.input_tokens,
                "cache_creation_input_tokens": scenario.cache_write_tokens,
                "cache_read_input_tokens": scenario.cached_input_tokens,
                "output_tokens": 1,
            },
        }}),
    );
    let mut index: u64 = 0;
    if reasoning > 0 {
        out.named(
            "content_block_start",
            &json!({"type": "content_block_start", "index": index,
                    "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
        );
        let per_token = token_time(scenario.tokens_per_sec, 1);
        let mut i: u64 = 0;
        while i < reasoning {
            out.wait(per_token);
            out.named(
                "content_block_delta",
                &json!({"type": "content_block_delta", "index": index,
                        "delta": {"type": "thinking_delta", "thinking": "hmm "}}),
            );
            i = i.saturating_add(1);
        }
        out.named(
            "content_block_delta",
            &json!({"type": "content_block_delta", "index": index,
                    "delta": {"type": "signature_delta", "signature": "bW9jay1zaWduYXR1cmU="}}),
        );
        out.named(
            "content_block_stop",
            &json!({"type": "content_block_stop", "index": index}),
        );
        index = 1;
    }
    out.named(
        "content_block_start",
        &json!({"type": "content_block_start", "index": index,
                "content_block": {"type": "text", "text": ""}}),
    );
    out.named("ping", &json!({"type": "ping"}));
    visible_deltas(&mut out, scenario, |out, w| {
        out.named(
            "content_block_delta",
            &json!({"type": "content_block_delta", "index": index,
                    "delta": {"type": "text_delta", "text": w}}),
        );
    });
    out.named(
        "content_block_stop",
        &json!({"type": "content_block_stop", "index": index}),
    );
    let mut delta = json!({"type": "message_delta",
                           "delta": {"stop_reason": "end_turn", "stop_sequence": Value::Null}});
    if !scenario.omit_usage
        && let Some(obj) = delta.as_object_mut()
    {
        obj.insert(
            "usage".into(),
            json!({"output_tokens": scenario.output_tokens}),
        );
    }
    out.named("message_delta", &delta);
    out.named("message_stop", &json!({"type": "message_stop"}));
    out.steps
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

fn apply_fault(style: ProviderStyle, fault: Fault, mut steps: Vec<Step>) -> Plan {
    match fault {
        Fault::None | Fault::Status { .. } => Plan::Stream {
            steps,
            abort: false,
        },
        Fault::DisconnectAtByte { byte } => {
            let mut sent: u64 = 0;
            let mut kept = Vec::new();
            for mut step in steps.drain(..) {
                let len = u64::try_from(step.bytes.len()).unwrap_or(u64::MAX);
                let end = sent.saturating_add(len);
                if end <= byte {
                    kept.push(step);
                    sent = end;
                    continue;
                }
                let take = usize::try_from(byte.saturating_sub(sent)).unwrap_or(0);
                if take > 0 {
                    step.bytes.truncate(take);
                    kept.push(step);
                }
                return Plan::Stream {
                    steps: kept,
                    abort: true,
                };
            }
            // The stream is shorter than `byte`: the fault never fires.
            Plan::Stream {
                steps: kept,
                abort: false,
            }
        }
        Fault::ErrorEventAtByte { byte, status } => {
            let mut sent: u64 = 0;
            let mut cut = None;
            for (i, step) in steps.iter().enumerate() {
                if sent >= byte {
                    cut = Some(i);
                    break;
                }
                let len = u64::try_from(step.bytes.len()).unwrap_or(u64::MAX);
                sent = sent.saturating_add(len);
            }
            if let Some(i) = cut {
                steps.truncate(i);
                let seq = u64::try_from(i).unwrap_or(u64::MAX);
                steps.push(Step {
                    delay: Duration::ZERO,
                    bytes: stream_error_frame(style, status, seq),
                });
            }
            Plan::Stream {
                steps,
                abort: false,
            }
        }
    }
}

/// OpenAI's `(type, code, message)` for a status.
fn openai_error(status: u16) -> (&'static str, Option<&'static str>, &'static str) {
    match status {
        429 => (
            "requests",
            Some("rate_limit_exceeded"),
            "Rate limit reached (mock).",
        ),
        401 => (
            "invalid_request_error",
            Some("invalid_api_key"),
            "Incorrect API key provided (mock).",
        ),
        s if s >= 500 => (
            "server_error",
            None,
            "The server had an error while processing your request (mock).",
        ),
        _ => ("invalid_request_error", None, "Invalid request (mock)."),
    }
}

/// Anthropic's error `type` for a status, per its published error table.
fn anthropic_error_type(status: u16) -> &'static str {
    match status {
        400 => "invalid_request_error",
        401 => "authentication_error",
        402 => "billing_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        504 => "timeout_error",
        529 => "overloaded_error",
        s if s >= 500 => "api_error",
        _ => "invalid_request_error",
    }
}

fn status_body(style: ProviderStyle, status: u16, request_seq: u64) -> Vec<u8> {
    let v = match style {
        ProviderStyle::OpenAiResponses | ProviderStyle::ChatCompletions => {
            let (kind, code, message) = openai_error(status);
            json!({"error": {"message": message, "type": kind, "param": Value::Null, "code": code}})
        }
        ProviderStyle::AnthropicMessages => json!({
            "type": "error",
            "error": {"type": anthropic_error_type(status), "message": "Mock provider error."},
            "request_id": format!("req_mock_{request_seq}"),
        }),
    };
    v.to_string().into_bytes()
}

fn stream_error_frame(style: ProviderStyle, status: u16, seq: u64) -> Vec<u8> {
    match style {
        ProviderStyle::OpenAiResponses => {
            let (kind, code, message) = openai_error(status);
            let v = json!({"type": "error", "code": code.unwrap_or(kind), "message": message,
                           "param": Value::Null, "sequence_number": seq});
            format!("event: error\ndata: {v}\n\n").into_bytes()
        }
        ProviderStyle::ChatCompletions => {
            let (kind, code, message) = openai_error(status);
            let v = json!({"error": {"message": message, "type": kind, "param": Value::Null,
                                     "code": code}});
            format!("data: {v}\n\n").into_bytes()
        }
        ProviderStyle::AnthropicMessages => {
            let v = json!({"type": "error", "error": {"type": anthropic_error_type(status),
                                                      "message": "Mock provider error."}});
            format!("event: error\ndata: {v}\n\n").into_bytes()
        }
    }
}
