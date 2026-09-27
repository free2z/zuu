//! A mock model provider: OpenAI Responses, Chat Completions (OpenAI and xAI
//! usage shapes) and Anthropic Messages, streamed as SSE over a real loopback
//! socket.
//!
//! The gateway's provider adapters parse these streams, meter the usage in
//! them and settle on it, so the one property this module must have is that
//! **every stream, and especially every usage report, is shaped the way the
//! real provider shapes it** — including the places where providers disagree
//! with each other about what a number means. A mock that normalized usage
//! for the adapter would test nothing.
//!
//! [`Scenario::expected_usage`] is the other half: the normalized
//! [`f2z_ai_proto::Usage`] a *correct* adapter must derive from the stream the
//! mock emitted, so a test can assert an adapter's arithmetic without
//! restating each provider's conventions itself.
//!
//! # Routes
//!
//! | Route | Style | Real API it mimics |
//! |---|---|---|
//! | `POST /v1/responses` | [`ProviderStyle::OpenAiResponses`] | OpenAI Responses API, `stream: true` |
//! | `POST /v1/chat/completions` | [`ProviderStyle::ChatCompletions`] | OpenAI Chat Completions, `stream: true` — also the xAI API's shape |
//! | `POST /v1/messages` | [`ProviderStyle::AnthropicMessages`] | Anthropic Messages API, `stream: true` |
//!
//! Only streaming requests are served; a body without `"stream": true` is
//! answered `400`. Every route ignores authentication.
//!
//! # What each style emits
//!
//! Token counts come from the [`Scenario`], not from the request: the mock
//! does not tokenize. One visible output token is one delta event carrying one
//! word.
//!
//! ## OpenAI Responses (`/v1/responses`)
//!
//! Named SSE events (`event: <type>` + `data: <json>`), each JSON carrying
//! `type` and a monotonically increasing `sequence_number`:
//!
//! 1. `response.created`, `response.in_progress` — a `response` object with
//!    `status: "in_progress"`, empty `output`, `usage: null`.
//! 2. When `reasoning_tokens > 0`: `response.output_item.added` and
//!    `response.output_item.done` for a `{"type":"reasoning","summary":[]}`
//!    item (reasoning text is not streamed, as with the real API without
//!    summaries). The reasoning time is paced before the `done`.
//! 3. `response.output_item.added` (a `message` item),
//!    `response.content_part.added` (`output_text`), one
//!    `response.output_text.delta` per visible token (`delta`),
//!    `response.output_text.done`, `response.content_part.done`,
//!    `response.output_item.done`.
//! 4. `response.completed` with `response.usage`:
//!    `{input_tokens, input_tokens_details: {cached_tokens}, output_tokens,
//!    output_tokens_details: {reasoning_tokens}, total_tokens}`.
//!
//! Usage conventions, as OpenAI reports them: **`input_tokens` includes
//! `cached_tokens`**, and **`output_tokens` includes `reasoning_tokens`**.
//! OpenAI reports no cache *write* count, so a scenario's
//! `cache_write_tokens` are folded into `input_tokens` and reach
//! [`Scenario::expected_usage`] as uncached input.
//!
//! Mid-stream error: `event: error` with
//! `{"type":"error","code","message","param":null,"sequence_number"}`.
//!
//! ## Chat Completions (`/v1/chat/completions`)
//!
//! Unnamed SSE (`data: <json>` only), `object: "chat.completion.chunk"`:
//! a first chunk with `delta: {"role":"assistant","content":""}`, one
//! `delta: {"content": …}` chunk per visible token, a final chunk with
//! `delta: {}` and `finish_reason: "stop"`, then — **only when the request
//! set `stream_options.include_usage: true`** — a chunk with `choices: []` and
//! `usage`, then the literal `data: [DONE]`. With `include_usage` every other
//! chunk carries `"usage": null`, as the real API does. Without it no usage is
//! sent at all, which is the real API's behaviour and exactly the trap an
//! adapter must not fall into.
//!
//! `usage` is `{prompt_tokens, completion_tokens, total_tokens,
//! prompt_tokens_details: {cached_tokens},
//! completion_tokens_details: {reasoning_tokens}}`, and its meaning depends on
//! [`ChatFlavor`]:
//!
//! * [`ChatFlavor::OpenAi`] — `completion_tokens` **includes**
//!   `reasoning_tokens`; `total = prompt + completion`.
//! * [`ChatFlavor::Xai`] — `completion_tokens` **excludes**
//!   `reasoning_tokens`, and `total = prompt + completion + reasoning`, as in
//!   xAI's published reasoning-model usage examples. An adapter that treats
//!   xAI's `completion_tokens` as the whole output under-charges every
//!   reasoning call. This flavour is modelled on xAI's documentation; confirm
//!   against a live response before relying on it for anything but a test.
//!
//! In both, `prompt_tokens` includes `cached_tokens`, and there is no cache
//! write count (folded into prompt, as for Responses). Reasoning text is not
//! streamed; its time is paced before the first content delta.
//!
//! Mid-stream error: `data: {"error": {"message","type","param":null,"code"}}`.
//!
//! ## Anthropic Messages (`/v1/messages`)
//!
//! Named SSE events:
//!
//! 1. `message_start` — `message.usage` is
//!    `{input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
//!    output_tokens: 1}`. The `output_tokens` here is a placeholder, as in the
//!    real stream; the final count comes later.
//! 2. When `reasoning_tokens > 0`: a `thinking` content block
//!    (`content_block_start`, one `thinking_delta` per reasoning token, a
//!    `signature_delta`, `content_block_stop`).
//! 3. A `text` block: `content_block_start`, a `ping`, one `text_delta` per
//!    visible token, `content_block_stop`.
//! 4. `message_delta` with `delta: {"stop_reason":"end_turn",…}` and
//!    `usage: {"output_tokens": N}` — the **cumulative** output count,
//!    thinking included — then `message_stop`.
//!
//! Anthropic's buckets are **disjoint**: `input_tokens` excludes both cache
//! reads and cache writes — the same convention as `f2z_ai_proto::Usage`.
//! Anthropic does not report a thinking subset of `output_tokens`, so
//! [`Scenario::expected_usage`] has `reasoning_tokens: 0` for this style.
//!
//! Mid-stream error: `event: error` with
//! `{"type":"error","error":{"type","message"}}`.
//!
//! # Faults
//!
//! See [`Fault`]: an HTTP error status before the first byte (with the
//! provider's own error body and, for `429`, `retry-after`), a disconnect at
//! byte N, or a provider-shaped error event at the first frame boundary at or
//! after byte N. [`Scenario::omit_usage`] removes the final usage report
//! (see its documentation for what that means per style) and [`Stall`]
//! pauses the stream mid-way.
//!
//! # Pacing and the drain probe
//!
//! A paced stream ([`Scenario::tokens_per_sec`]) is written against an
//! absolute schedule, so its average rate is exact even at thousands of
//! tokens per second. The v1 spec requires the gateway to read upstream at
//! provider speed however slowly its own client reads (chat-api.md, the drain
//! rule); [`MockProvider::backpressured_writes`] counts the writes of paced
//! streams that the reader held up, so a test can assert it stayed `0`.

mod render;
mod server;

use core::time::Duration;

use f2z_ai_proto::Usage;

pub use render::{Plan, RenderContext, Step, plan};
pub use server::{MockProvider, RecordedRequest, SCENARIO_HEADER};

/// The upstream API shape a request is served in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderStyle {
    /// OpenAI Responses API, `POST /v1/responses`.
    OpenAiResponses,
    /// Chat Completions, `POST /v1/chat/completions` (OpenAI and xAI).
    ChatCompletions,
    /// Anthropic Messages API, `POST /v1/messages`.
    AnthropicMessages,
}

impl ProviderStyle {
    /// Every style, for tests that want to run the same assertion over all.
    pub const ALL: [Self; 3] = [
        Self::OpenAiResponses,
        Self::ChatCompletions,
        Self::AnthropicMessages,
    ];

    /// The route this style is served on.
    #[must_use]
    pub fn path(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "/v1/responses",
            Self::ChatCompletions => "/v1/chat/completions",
            Self::AnthropicMessages => "/v1/messages",
        }
    }
}

/// Which provider's usage conventions a Chat Completions stream follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ChatFlavor {
    /// OpenAI: `completion_tokens` includes reasoning.
    #[default]
    OpenAi,
    /// xAI: `completion_tokens` excludes reasoning; `total_tokens` adds it.
    Xai,
}

/// A fault injected into one response.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Fault {
    /// No fault: the stream completes.
    #[default]
    None,
    /// Answer with this HTTP status **before the first byte** of any stream
    /// (after [`Scenario::ttfb`]), with the provider's own JSON error body.
    /// Typical values: `429`, `500`, `503`, and Anthropic's `529`.
    Status {
        /// The HTTP status code.
        status: u16,
    },
    /// Send exactly `byte` bytes of the stream body — possibly ending in the
    /// middle of a frame — then drop the connection without terminating the
    /// chunked body. A `byte` beyond the stream's length never fires.
    DisconnectAtByte {
        /// How many body bytes to send before the drop.
        byte: u64,
    },
    /// At the first frame boundary at or after `byte`, stop the normal stream,
    /// emit the provider's mid-stream error event for `status`, and end the
    /// body cleanly. No usage report follows. A `byte` beyond the stream's
    /// length never fires.
    ErrorEventAtByte {
        /// The byte offset from which the error may be injected.
        byte: u64,
        /// The HTTP status whose provider error type the event carries.
        status: u16,
    },
}

/// A mid-stream pause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Stall {
    /// Pause before the visible-output delta with this 0-based index. An index
    /// at or past the number of visible tokens pauses before the stream's
    /// closing events instead.
    pub before_delta: u64,
    /// How long to pause.
    pub duration: Duration,
}

/// What one mock response does. Every count is in tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scenario {
    /// Uncached input tokens.
    pub input_tokens: u64,
    /// Input tokens read from the prompt cache.
    pub cached_input_tokens: u64,
    /// Input tokens written to the prompt cache. Only Anthropic reports these
    /// separately; OpenAI-shaped streams fold them into input.
    pub cache_write_tokens: u64,
    /// Total generated tokens, **reasoning included**.
    pub output_tokens: u64,
    /// The reasoning subset of `output_tokens`. Clamped to `output_tokens`.
    pub reasoning_tokens: u64,
    /// Generation speed for reasoning and visible tokens alike. `None` streams
    /// as fast as the socket allows.
    pub tokens_per_sec: Option<u32>,
    /// Delay before the response headers (and therefore before the first body
    /// byte, and before a [`Fault::Status`] answer).
    pub ttfb: Duration,
    /// The injected fault, if any.
    pub fault: Fault,
    /// Remove the final usage report. Per style: Responses sends
    /// `response.completed` with `"usage": null`; Chat Completions sends no
    /// usage chunk even when `include_usage` was requested; Anthropic sends
    /// `message_delta` without its `usage` member (`message_start`'s input
    /// counts still arrive, but the output count never does).
    pub omit_usage: bool,
    /// An optional mid-stream pause.
    pub stall: Option<Stall>,
    /// Chat Completions usage conventions.
    pub chat_flavor: ChatFlavor,
    /// The `model` echoed in the stream. `None` echoes the request's `model`.
    pub model: Option<String>,
}

impl Default for Scenario {
    fn default() -> Self {
        Self {
            input_tokens: 12,
            cached_input_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 16,
            reasoning_tokens: 0,
            tokens_per_sec: None,
            ttfb: Duration::ZERO,
            fault: Fault::None,
            omit_usage: false,
            stall: None,
            chat_flavor: ChatFlavor::OpenAi,
            model: None,
        }
    }
}

impl Scenario {
    /// Set the total output tokens (reasoning included).
    #[must_use]
    pub fn with_output_tokens(mut self, n: u64) -> Self {
        self.output_tokens = n;
        self
    }

    /// Set the uncached input tokens.
    #[must_use]
    pub fn with_input_tokens(mut self, n: u64) -> Self {
        self.input_tokens = n;
        self
    }

    /// Set the reasoning subset of the output.
    #[must_use]
    pub fn with_reasoning_tokens(mut self, n: u64) -> Self {
        self.reasoning_tokens = n;
        self
    }

    /// Set the prompt-cache read and write counts.
    #[must_use]
    pub fn with_cache(mut self, read: u64, write: u64) -> Self {
        self.cached_input_tokens = read;
        self.cache_write_tokens = write;
        self
    }

    /// Pace generation at `tps` tokens per second (`0` means unpaced).
    #[must_use]
    pub fn with_tokens_per_sec(mut self, tps: u32) -> Self {
        self.tokens_per_sec = if tps == 0 { None } else { Some(tps) };
        self
    }

    /// Delay the response headers by `ttfb`.
    #[must_use]
    pub fn with_ttfb(mut self, ttfb: Duration) -> Self {
        self.ttfb = ttfb;
        self
    }

    /// Inject `fault`.
    #[must_use]
    pub fn with_fault(mut self, fault: Fault) -> Self {
        self.fault = fault;
        self
    }

    /// Remove the final usage report.
    #[must_use]
    pub fn without_usage(mut self) -> Self {
        self.omit_usage = true;
        self
    }

    /// Pause for `duration` before visible delta `before_delta`.
    #[must_use]
    pub fn with_stall(mut self, before_delta: u64, duration: Duration) -> Self {
        self.stall = Some(Stall {
            before_delta,
            duration,
        });
        self
    }

    /// Use `flavor`'s Chat Completions usage conventions.
    #[must_use]
    pub fn with_chat_flavor(mut self, flavor: ChatFlavor) -> Self {
        self.chat_flavor = flavor;
        self
    }

    /// The reasoning tokens actually emitted: never more than the output.
    #[must_use]
    pub fn effective_reasoning_tokens(&self) -> u64 {
        self.reasoning_tokens.min(self.output_tokens)
    }

    /// The visible (non-reasoning) output tokens, one delta each.
    #[must_use]
    pub fn visible_tokens(&self) -> u64 {
        self.output_tokens
            .saturating_sub(self.effective_reasoning_tokens())
    }

    /// The normalized usage a correct adapter derives from a **complete**
    /// stream of this scenario in `style`, or `None` when the stream carries no
    /// final usage report (usage omitted, or Chat Completions without
    /// `include_usage`). Faults are not considered: a faulted stream's usage
    /// is whatever reached the adapter before the fault.
    #[must_use]
    pub fn expected_usage(&self, style: ProviderStyle, include_usage: bool) -> Option<Usage> {
        if self.omit_usage {
            return None;
        }
        let reasoning = self.effective_reasoning_tokens();
        match style {
            ProviderStyle::ChatCompletions if !include_usage => None,
            ProviderStyle::OpenAiResponses | ProviderStyle::ChatCompletions => Some(Usage {
                // No cache-write count exists in OpenAI's shape: those tokens
                // arrive as ordinary (uncached) prompt tokens.
                input_tokens: self.input_tokens.saturating_add(self.cache_write_tokens),
                cached_input_tokens: self.cached_input_tokens,
                cache_write_tokens: 0,
                output_tokens: self.output_tokens,
                reasoning_tokens: reasoning,
                images: 0,
                tool_calls: 0,
            }),
            ProviderStyle::AnthropicMessages => Some(Usage {
                input_tokens: self.input_tokens,
                cached_input_tokens: self.cached_input_tokens,
                cache_write_tokens: self.cache_write_tokens,
                output_tokens: self.output_tokens,
                // Anthropic does not break thinking out of output_tokens.
                reasoning_tokens: 0,
                images: 0,
                tool_calls: 0,
            }),
        }
    }
}
