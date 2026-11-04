//! Rendering a [`Scenario`] into the exact bytes (and pauses) one response
//! sends. Pure: no I/O and no clock, so the shapes are testable without a
//! socket and the server is only a pacing loop over a [`Plan`]. Streams are
//! generated lazily ([`StreamPlan::steps`]), so their memory does not grow
//! with their length.

use core::fmt;
use core::time::Duration;

use serde_json::{Value, json};

use super::{ChatFlavor, Ending, Fault, ProviderStyle, Scenario, Stall};

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

/// One write: wait `delay`, then send `bytes`. Every step of a stream is
/// exactly one SSE frame, so a step boundary is a frame boundary — except the
/// last step of a [`Fault::DisconnectAtByte`] stream, which may be cut short.
///
/// `Debug` reports the bytes by length, per the workspace rule against
/// derived byte dumps (`f2z-codec/tests/workspace_debug_scan.rs`).
#[derive(Clone, PartialEq, Eq)]
pub struct Step {
    /// The pause before this write.
    pub delay: Duration,
    /// The bytes written.
    pub bytes: Vec<u8>,
}

impl fmt::Debug for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Step")
            .field("delay", &self.delay)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

/// A frame generator for the `i`-th step of a run of deltas.
type Gen = Box<dyn Fn(u64) -> Vec<u8> + Send + Sync>;

/// A stream is a few fixed frames around runs of per-token deltas. Runs are
/// generated one frame at a time as the stream is written, so a stream's
/// memory is independent of its length — 10 000 concurrent streams of 10 000
/// tokens each must not mean 10⁸ frames rendered up front.
enum Segment {
    Frame(Step),
    Run {
        count: u64,
        /// Extra pause before the first frame of the run.
        lead: Duration,
        /// Pause before every frame (the per-token time).
        each: Duration,
        /// `(index, pause)`: an extra pause before frame `index`.
        stall: Option<(u64, Duration)>,
        make: Gen,
    },
}

/// A `200 text/event-stream` answer, generated lazily by [`StreamPlan::steps`].
pub struct StreamPlan {
    segments: Vec<Segment>,
    style: ProviderStyle,
    fault: Fault,
}

impl fmt::Debug for StreamPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamPlan")
            .field("segments", &self.segments.len())
            .field("style", &self.style)
            .field("fault", &self.fault)
            .finish()
    }
}

impl StreamPlan {
    /// The writes, in order, with the fault applied as they are produced.
    #[must_use]
    pub fn steps(&self) -> Steps<'_> {
        Steps {
            plan: self,
            segment: 0,
            index: 0,
            sent: 0,
            frames: 0,
            done: false,
            aborted: false,
        }
    }

    /// Every write, and whether the connection is aborted after the last one.
    /// Materializes the whole stream: for tests, not for serving.
    #[must_use]
    pub fn collect_steps(&self) -> (Vec<Step>, bool) {
        let mut it = self.steps();
        let steps: Vec<Step> = it.by_ref().collect();
        (steps, it.aborted())
    }
}

/// The iterator of [`StreamPlan::steps`].
pub struct Steps<'a> {
    plan: &'a StreamPlan,
    segment: usize,
    index: u64,
    sent: u64,
    frames: u64,
    done: bool,
    aborted: bool,
}

impl Steps<'_> {
    /// After the iterator is exhausted: whether the stream ends in an abort
    /// ([`Fault::DisconnectAtByte`] fired) rather than a clean end of body.
    #[must_use]
    pub fn aborted(&self) -> bool {
        self.aborted
    }

    /// The next unfaulted step.
    fn raw_next(&mut self) -> Option<Step> {
        loop {
            let seg = self.plan.segments.get(self.segment)?;
            match seg {
                Segment::Frame(step) => {
                    self.segment = self.segment.saturating_add(1);
                    return Some(step.clone());
                }
                Segment::Run {
                    count,
                    lead,
                    each,
                    stall,
                    make,
                } => {
                    if self.index >= *count {
                        self.segment = self.segment.saturating_add(1);
                        self.index = 0;
                        continue;
                    }
                    let i = self.index;
                    let mut delay = *each;
                    if i == 0 {
                        delay = delay.saturating_add(*lead);
                    }
                    if let Some((at, pause)) = stall
                        && *at == i
                    {
                        delay = delay.saturating_add(*pause);
                    }
                    self.index = i.saturating_add(1);
                    return Some(Step {
                        delay,
                        bytes: make(i),
                    });
                }
            }
        }
    }
}

impl Iterator for Steps<'_> {
    type Item = Step;

    fn next(&mut self) -> Option<Step> {
        if self.done {
            return None;
        }
        if let Fault::ErrorEventAtByte { byte, status } = self.plan.fault
            && self.sent >= byte
        {
            // Only at a frame boundary still inside the stream: a `byte` at
            // or past its end never fires.
            if self.clone_peek_exists() {
                self.done = true;
                return Some(Step {
                    delay: Duration::ZERO,
                    bytes: stream_error_frame(self.plan.style, status, self.frames),
                });
            }
        }
        let Some(mut step) = self.raw_next() else {
            self.done = true;
            return None;
        };
        let len = u64::try_from(step.bytes.len()).unwrap_or(u64::MAX);
        if let Fault::DisconnectAtByte { byte } = self.plan.fault {
            let end = self.sent.saturating_add(len);
            if end > byte {
                let take = usize::try_from(byte.saturating_sub(self.sent)).unwrap_or(0);
                self.done = true;
                self.aborted = true;
                if take == 0 {
                    return None;
                }
                step.bytes.truncate(take);
                self.sent = byte;
                return Some(step);
            }
        }
        self.sent = self.sent.saturating_add(len);
        self.frames = self.frames.saturating_add(1);
        Some(step)
    }
}

impl Steps<'_> {
    /// Whether any unfaulted step remains, without consuming it.
    fn clone_peek_exists(&self) -> bool {
        let mut segment = self.segment;
        let mut index = self.index;
        while let Some(seg) = self.plan.segments.get(segment) {
            match seg {
                Segment::Frame(_) => return true,
                Segment::Run { count, .. } if index < *count => return true,
                Segment::Run { .. } => {
                    segment = segment.saturating_add(1);
                    index = 0;
                }
            }
        }
        false
    }
}

/// Everything one response does. `Debug` reports bodies by length.
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
    Stream(StreamPlan),
}

impl fmt::Debug for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status {
                status,
                retry_after,
                body,
            } => f
                .debug_struct("Status")
                .field("status", status)
                .field("retry_after", retry_after)
                .field("body_len", &body.len())
                .finish(),
            Self::Stream(s) => s.fmt(f),
        }
    }
}

impl Plan {
    /// The concatenated body bytes, ignoring pauses. For tests.
    #[must_use]
    pub fn body_bytes(&self) -> Vec<u8> {
        match self {
            Self::Status { body, .. } => body.clone(),
            Self::Stream(s) => s.steps().flat_map(|s| s.bytes).collect(),
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
    let segments = match (&scenario.replay, style) {
        (Some(replay), _) => replay_frames(replay.as_str()),
        (None, ProviderStyle::OpenAiResponses) => responses(scenario, ctx),
        (None, ProviderStyle::ChatCompletions) => chat(scenario, ctx),
        (None, ProviderStyle::AnthropicMessages) => anthropic(scenario, ctx),
    };
    Plan::Stream(StreamPlan {
        segments,
        style,
        fault: scenario.fault,
    })
}

/// A replayed body as one unpaced step per SSE frame: each step ends with
/// the blank line that ends its frame (`\n\n`, or `\r\n\r\n`), so a step
/// boundary is a frame boundary as everywhere else. Bytes after the last
/// blank line are one final step, unchanged.
fn replay_frames(body: &str) -> Vec<Segment> {
    let bytes = body.as_bytes();
    let step = |part: &[u8]| {
        Segment::Frame(Step {
            delay: Duration::ZERO,
            bytes: part.to_vec(),
        })
    };
    let mut segments = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while let Some(rest) = bytes.get(i..).filter(|r| !r.is_empty()) {
        let blank = if rest.starts_with(b"\r\n\r\n") {
            4
        } else if rest.starts_with(b"\n\n") {
            2
        } else {
            i = i.saturating_add(1);
            continue;
        };
        let end = i.saturating_add(blank);
        segments.push(step(bytes.get(start..end).unwrap_or_default()));
        start = end;
        i = end;
    }
    if let Some(tail) = bytes.get(start..).filter(|t| !t.is_empty()) {
        segments.push(step(tail));
    }
    segments
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

fn named_bytes(event: &str, data: &Value) -> Vec<u8> {
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

fn data_bytes(data: &str) -> Vec<u8> {
    format!("data: {data}\n\n").into_bytes()
}

/// Accumulates segments, attaching any pending pause to the next frame.
struct Out {
    segs: Vec<Segment>,
    pending: Duration,
    frames: u64,
}

impl Out {
    fn new() -> Self {
        Self {
            segs: Vec::new(),
            pending: Duration::ZERO,
            frames: 0,
        }
    }

    fn wait(&mut self, d: Duration) {
        self.pending = self.pending.saturating_add(d);
    }

    fn named(&mut self, event: &str, data: &Value) {
        self.push(named_bytes(event, data));
    }

    fn data(&mut self, data: &str) {
        self.push(data_bytes(data));
    }

    fn push(&mut self, bytes: Vec<u8>) {
        let delay = core::mem::take(&mut self.pending);
        self.segs.push(Segment::Frame(Step { delay, bytes }));
        self.frames = self.frames.saturating_add(1);
    }

    /// A run of `count` frames, `each` apart, generated on demand.
    fn run(&mut self, count: u64, each: Duration, stall: Option<Stall>, make: Gen) {
        let in_run = stall.filter(|s| s.before_delta < count);
        if count > 0 {
            let lead = core::mem::take(&mut self.pending);
            self.segs.push(Segment::Run {
                count,
                lead,
                each,
                stall: in_run.map(|s| (s.before_delta, s.duration)),
                make,
            });
            self.frames = self.frames.saturating_add(count);
        }
        // A stall at or past the last delta pauses before what follows.
        if let Some(s) = stall.filter(|s| s.before_delta >= count) {
            self.wait(s.duration);
        }
    }

    /// One frame, built only when it is written.
    fn lazy(&mut self, make: Gen) {
        self.run(1, Duration::ZERO, None, make);
    }

    /// The number of frames so far — also the next Responses
    /// `sequence_number`, since every frame there is one event.
    fn len(&self) -> u64 {
        self.frames
    }
}

/// The visible-token run: one frame per visible token, paced, with the stall.
fn visible_run(out: &mut Out, scenario: &Scenario, make: Gen) {
    out.run(
        scenario.visible_tokens(),
        token_time(scenario.tokens_per_sec, 1),
        scenario.stall,
        make,
    );
}

fn word(i: u64) -> &'static str {
    let len = u64::try_from(WORDS.len()).unwrap_or(1);
    let idx = usize::try_from(i.checked_rem(len).unwrap_or(0)).unwrap_or(0);
    WORDS.get(idx).copied().unwrap_or("x ")
}

/// The visible text of `n` tokens.
fn text_of(n: u64) -> String {
    let mut s = String::new();
    let mut i: u64 = 0;
    while i < n {
        s.push_str(word(i));
        i = i.saturating_add(1);
    }
    s
}

fn output_text_part(visible: u64) -> Value {
    json!({"type": "output_text", "text": text_of(visible), "annotations": []})
}

fn message_item(msg_id: &str, visible: u64, status: &str) -> Value {
    json!({"id": msg_id, "type": "message", "status": status,
           "role": "assistant", "content": [output_text_part(visible)]})
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

fn responses(scenario: &Scenario, ctx: &RenderContext) -> Vec<Segment> {
    let (terminal, status, item_status) = match scenario.ending {
        Ending::Complete => ("response.completed", "completed", "completed"),
        Ending::MaxOutputTokens => ("response.incomplete", "incomplete", "incomplete"),
        Ending::Failed => ("response.failed", "failed", "incomplete"),
    };
    let id = format!("resp_mock_{}", ctx.request_seq);
    let msg_id = format!("msg_mock_{}", ctx.request_seq);
    let rs_id = format!("rs_mock_{}", ctx.request_seq);
    let reasoning = scenario.effective_reasoning_tokens();
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

    let mut reasoning_item = None;
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
        reasoning_item = Some(item);
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
    let base = out.len();
    let item_id = msg_id.clone();
    visible_run(
        &mut out,
        scenario,
        Box::new(move |i| {
            named_bytes(
                "response.output_text.delta",
                &json!({"type": "response.output_text.delta",
                        "sequence_number": base.saturating_add(i),
                        "item_id": item_id, "output_index": output_index, "content_index": 0,
                        "delta": word(i), "logprobs": []}),
            )
        }),
    );
    // The closing frames each repeat the whole text, as the real API does.
    // They are built when written, one at a time, so a long stream holds no
    // copy of its text until its last few frames.
    let visible = scenario.visible_tokens();
    let (m, s0) = (msg_id.clone(), out.len());
    out.lazy(Box::new(move |_| {
        named_bytes(
            "response.output_text.done",
            &json!({"type": "response.output_text.done", "sequence_number": s0,
                    "item_id": m, "output_index": output_index, "content_index": 0,
                    "text": text_of(visible), "logprobs": []}),
        )
    }));
    let (m, s1) = (msg_id.clone(), out.len());
    out.lazy(Box::new(move |_| {
        named_bytes(
            "response.content_part.done",
            &json!({"type": "response.content_part.done", "sequence_number": s1,
                    "item_id": m, "output_index": output_index, "content_index": 0,
                    "part": output_text_part(visible)}),
        )
    }));
    let (m, s2) = (msg_id.clone(), out.len());
    out.lazy(Box::new(move |_| {
        named_bytes(
            "response.output_item.done",
            &json!({"type": "response.output_item.done", "sequence_number": s2,
                    "output_index": output_index, "item": message_item(&m, visible, item_status)}),
        )
    }));

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
    let (m, s3, rid, model) = (msg_id, out.len(), id.clone(), ctx.model.clone());
    out.lazy(Box::new(move |_| {
        let mut items: Vec<Value> = reasoning_item.iter().cloned().collect();
        items.push(message_item(&m, visible, item_status));
        let mut response = json!({"id": rid, "object": "response", "created_at": CREATED,
                                  "status": status, "model": model,
                                  "output": items, "usage": usage});
        if let Some(obj) = response.as_object_mut() {
            match terminal {
                "response.incomplete" => {
                    obj.insert(
                        "incomplete_details".into(),
                        json!({"reason": "max_output_tokens"}),
                    );
                }
                "response.failed" => {
                    obj.insert(
                        "error".into(),
                        json!({"code": "server_error",
                               "message": "The model failed to complete (mock)."}),
                    );
                }
                _ => {}
            }
        }
        named_bytes(
            terminal,
            &json!({"type": terminal, "sequence_number": s3, "response": response}),
        )
    }));
    out.segs
}

// ---------------------------------------------------------------------------
// Chat Completions (OpenAI / xAI)
// ---------------------------------------------------------------------------

fn chat(scenario: &Scenario, ctx: &RenderContext) -> Vec<Segment> {
    let id = format!("chatcmpl-mock-{}", ctx.request_seq);
    let (model, include_usage) = (ctx.model.clone(), ctx.include_usage);
    let chunk = move |choices: Value, usage: Option<Value>| {
        chat_chunk(&id, &model, include_usage, choices, usage)
    };
    let mut out = Out::new();
    out.data(&chunk(
        chat_choice(json!({"role": "assistant", "content": ""}), Value::Null),
        None,
    ));
    // Reasoning is not streamed in this shape; its time passes before the
    // first visible token.
    out.wait(token_time(
        scenario.tokens_per_sec,
        scenario.effective_reasoning_tokens(),
    ));
    let delta_chunk = chunk.clone();
    visible_run(
        &mut out,
        scenario,
        Box::new(move |i| {
            data_bytes(&delta_chunk(
                chat_choice(json!({"content": word(i)}), Value::Null),
                None,
            ))
        }),
    );
    let finish = match scenario.ending {
        Ending::Complete => "stop",
        Ending::MaxOutputTokens => "length",
        Ending::Failed => {
            out.push(stream_error_frame(ProviderStyle::ChatCompletions, 500, 0));
            return out.segs;
        }
    };
    out.data(&chunk(chat_choice(json!({}), json!(finish)), None));
    if ctx.include_usage && !scenario.omit_usage {
        out.data(&chunk(json!([]), Some(chat_usage(scenario))));
    }
    out.data("[DONE]");
    out.segs
}

fn chat_chunk(
    id: &str,
    model: &str,
    include_usage: bool,
    choices: Value,
    usage: Option<Value>,
) -> String {
    let mut v = json!({
        "id": id, "object": "chat.completion.chunk", "created": CREATED,
        "model": model, "system_fingerprint": Value::Null, "choices": choices,
    });
    // With include_usage every chunk carries `usage`: null until the last.
    if include_usage && let Some(obj) = v.as_object_mut() {
        obj.insert("usage".into(), usage.unwrap_or(Value::Null));
    }
    v.to_string()
}

fn chat_choice(delta: Value, finish: Value) -> Value {
    json!([{"index": 0, "delta": delta, "logprobs": Value::Null, "finish_reason": finish}])
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

fn anthropic(scenario: &Scenario, ctx: &RenderContext) -> Vec<Segment> {
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
                "cache_creation": cache_creation(scenario),
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
        let thinking = named_bytes(
            "content_block_delta",
            &json!({"type": "content_block_delta", "index": index,
                    "delta": {"type": "thinking_delta", "thinking": "hmm "}}),
        );
        out.run(
            reasoning,
            token_time(scenario.tokens_per_sec, 1),
            None,
            Box::new(move |_| thinking.clone()),
        );
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
    visible_run(
        &mut out,
        scenario,
        Box::new(move |i| {
            named_bytes(
                "content_block_delta",
                &json!({"type": "content_block_delta", "index": index,
                        "delta": {"type": "text_delta", "text": word(i)}}),
            )
        }),
    );
    out.named(
        "content_block_stop",
        &json!({"type": "content_block_stop", "index": index}),
    );
    let stop_reason = match scenario.ending {
        Ending::Complete => "end_turn",
        Ending::MaxOutputTokens => "max_tokens",
        Ending::Failed => {
            out.push(stream_error_frame(ProviderStyle::AnthropicMessages, 500, 0));
            return out.segs;
        }
    };
    match scenario.anthropic_cumulative {
        None => {
            let mut delta = json!({"type": "message_delta",
                                   "delta": {"stop_reason": stop_reason, "stop_sequence": Value::Null}});
            if !scenario.omit_usage
                && let Some(obj) = delta.as_object_mut()
            {
                obj.insert(
                    "usage".into(),
                    json!({"output_tokens": scenario.output_tokens}),
                );
            }
            out.named("message_delta", &delta);
        }
        Some(c) => {
            let k = u64::from(c.message_deltas.max(1));
            let mut j: u64 = 1;
            while j <= k {
                let part = |total: u64| {
                    let v = u128::from(total)
                        .saturating_mul(u128::from(j))
                        .checked_div(u128::from(k))
                        .unwrap_or(0);
                    u64::try_from(v).unwrap_or(u64::MAX)
                };
                let last = j == k;
                let mut delta = json!({"type": "message_delta", "delta": {
                    "stop_reason": if last { json!(stop_reason) } else { Value::Null },
                    "stop_sequence": Value::Null}});
                if !scenario.omit_usage
                    && let Some(obj) = delta.as_object_mut()
                {
                    // Running totals, input and cache counts included.
                    obj.insert(
                        "usage".into(),
                        json!({
                            "input_tokens": scenario.input_tokens
                                .saturating_add(part(c.server_tool_input_tokens)),
                            "cache_creation_input_tokens": scenario.cache_write_tokens,
                            "cache_read_input_tokens": scenario.cached_input_tokens,
                            "cache_creation": cache_creation(scenario),
                            "output_tokens": part(scenario.output_tokens),
                            "server_tool_use": {"web_search_requests": part(c.server_tool_uses)},
                        }),
                    );
                }
                out.named("message_delta", &delta);
                j = j.saturating_add(1);
            }
        }
    }
    out.named("message_stop", &json!({"type": "message_stop"}));
    out.segs
}

/// Anthropic's split of cache writes by TTL.
fn cache_creation(scenario: &Scenario) -> Value {
    let one_hour = scenario
        .cache_write_1h_tokens
        .min(scenario.cache_write_tokens);
    json!({
        "ephemeral_5m_input_tokens": scenario.cache_write_tokens.saturating_sub(one_hour),
        "ephemeral_1h_input_tokens": one_hour,
    })
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

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
