//! The provider adapters: the unified `/v1/chat` request out, the provider's
//! stream and **its reported usage** back (zuu#1064, epic #1047).
//!
//! Three wire styles, one per [`ApiStyle`] the signed catalogue names, behind
//! one [`Provider`] trait:
//!
//! | `api_style` | Adapter | Real API |
//! |---|---|---|
//! | `openai_responses` | [`openai_responses::OpenAiResponses`] | OpenAI Responses, `stream: true` |
//! | `anthropic_messages` | [`anthropic::AnthropicMessages`] | Anthropic Messages, `stream: true` |
//! | `openai_chat` | [`openai_chat::OpenAiChat`] | Chat Completions with `stream_options.include_usage` — xAI and other compatible providers |
//!
//! # What an adapter is responsible for
//!
//! * **The request.** Built from the decoded [`ChatRequest`] and the
//!   catalogue model only. Nothing from the client's HTTP request reaches the
//!   provider: the backend never sees the client's headers, the outbound
//!   headers are built from an allowlist ([`client::ALLOWED_HEADERS`]), and
//!   images travel as the inline base64 the client sent — the gateway never
//!   fetches a URL a client supplied (there is no URL part to supply).
//! * **The stream.** Parsed into unified [`crate::call::Upstream`] events:
//!   `delta`, a complete `tool_call`, and `usage` when — and only when — the
//!   provider reported it.
//! * **The usage.** The money-critical part. Each provider counts
//!   differently, and each adapter normalises to
//!   [`f2z_ai_proto::Usage`]'s disjoint buckets. A stream that ended without a
//!   usage report is [`UsageReport::Missing`] — **never** a zero usage — so
//!   the metering fallback of metering.md §5.4 can take over.
//! * **The ending.** [`ProviderOutcome`]: why generation stopped, whether and
//!   how the provider failed, and the usage, handed to the settler with the
//!   call ([`crate::settle::CallRecord::outcome`]).
//!
//! # What an adapter is not
//!
//! It emits no `meta`, `done` or `error` event: those carry the hold and the
//! settlement, and belong to the metering layer that wraps this one. It takes
//! no hold and releases none — the settler is the single owner of a call's
//! outcome ([`crate::chat::ChatBackend`]). The binary wraps this adapter in
//! [`crate::meter::Metered`]; direct adapter injection is a test seam.

pub mod anthropic;
pub mod backend;
pub mod client;
pub mod openai_chat;
pub mod openai_responses;
pub mod resilience;
pub mod sse;
pub mod upstream;

use std::fmt;
use std::time::Duration;

use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::catalog::{ApiStyle, CatalogModel};
use f2z_ai_proto::chat::{ChatRequest, FinishReason, ToolCall, Usage};
use serde_json::Value;

use crate::error::ApiFailure;

pub use backend::{ProviderBackend, Timeouts, Tuning};
pub use upstream::ProviderUpstream;

/// Whether the provider reported the call's usage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageReport {
    /// The provider's own numbers, normalised. What the call settles on.
    Reported(Usage),
    /// The stream ended — cleanly or not — without a usage report. Never
    /// defaulted to zero: metering.md §5.4's estimate takes over.
    ///
    /// `partial` is what the provider did say before the stream ended, for
    /// the record only: Anthropic's `message_start` carries the input and
    /// cache counts but only a placeholder output count, so its
    /// `output_tokens` is left `0` here. It must not be settled on.
    Missing {
        /// Counts reported before the stream ended, if any; never complete.
        partial: Option<Usage>,
    },
}

impl UsageReport {
    /// The reported usage, if there is one.
    #[must_use]
    pub const fn reported(&self) -> Option<Usage> {
        match self {
            Self::Reported(usage) => Some(*usage),
            Self::Missing { .. } => None,
        }
    }
}

/// Where in the call a failure happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Before the first content event (`delta` or `tool_call`) — before the
    /// gateway commits to the model. Nothing reached the client, so the
    /// failure may be retried, and `fallback` may apply.
    BeforeContent,
    /// After content was produced: charged for what was produced
    /// (metering.md §5.2); never retried.
    AfterContent,
}

/// A provider-side failure, mapped to the contract's codes (errors.md §4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderFailure {
    /// `provider_error`, `provider_timeout`, `unavailable` or `internal`.
    pub code: ErrorCode,
    /// A fixed, content-free label: `http_status`, `stream_error`,
    /// `truncated`, `malformed_stream`, `connect`, `first_byte`, `idle`,
    /// `hard_limit`, `provider_circuit_open`, `provider_auth`, …. Never text
    /// from the provider's error body, which can quote the prompt.
    pub reason: &'static str,
    /// The provider's HTTP status, when the failure was one.
    pub status: Option<u16>,
    /// Whether another attempt could succeed.
    pub retryable: bool,
    /// The provider's `retry-after`, when it sent one.
    pub retry_after: Option<Duration>,
    /// Before or after content.
    pub phase: Phase,
}

impl ProviderFailure {
    /// A failure with no status and no `retry-after`.
    #[must_use]
    pub const fn new(code: ErrorCode, reason: &'static str, retryable: bool) -> Self {
        Self {
            code,
            reason,
            status: None,
            retryable,
            retry_after: None,
            phase: Phase::BeforeContent,
        }
    }

    /// The `details.phase` of a `provider_timeout` (errors.md §4), when this
    /// is one.
    #[must_use]
    pub fn timeout_phase(&self) -> Option<&'static str> {
        (self.code == ErrorCode::ProviderTimeout)
            .then_some(self.reason)
            .filter(|r| matches!(*r, "first_byte" | "idle" | "hard_limit"))
    }
}

/// How one provider call ended: what the settler needs beside the events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderOutcome {
    /// Why generation stopped, when the provider said. `None` on a failure.
    pub finish_reason: Option<FinishReason>,
    /// The usage, or its explicit absence.
    pub usage: UsageReport,
    /// Anthropic's 1-hour-TTL share of `usage.cache_write_tokens`
    /// (`cache_creation.ephemeral_1h_input_tokens`). It is priced differently
    /// from the 5-minute share and `f2z-ai-proto` has one cache-write price
    /// today (zuu#1059): carried here so the split is not lost on the way to
    /// the settler. `0` for every other provider.
    pub cache_write_1h_tokens: u64,
    /// The provider failure that ended the call, if one did.
    pub failure: Option<ProviderFailure>,
    /// Whether a `delta` or `tool_call` was produced (the call committed).
    pub output_produced: bool,
    /// The client-executed function calls the model produced. **Not** in
    /// `usage.tool_calls`, which counts only provider-billed server-side tool
    /// invocations (see the PR for zuu#1064 on the spec's wording).
    pub function_tool_calls: u64,
    /// Provider requests made for this call, retries included.
    pub attempts: u32,
}

/// Content an adapter's parser produced from one SSE event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Content {
    /// Assistant text, never empty.
    Text(String),
    /// A complete function call.
    ToolCall(ToolCall),
}

/// What the parser concluded when the stream ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ending {
    /// Why generation stopped, if the provider said so.
    pub finish_reason: Option<FinishReason>,
    /// The usage, or its absence.
    pub usage: UsageReport,
    /// See [`ProviderOutcome::cache_write_1h_tokens`].
    pub cache_write_1h_tokens: u64,
    /// A failure the stream itself reported, or its truncation.
    pub failure: Option<ProviderFailure>,
}

/// Whether the parser has seen the provider's terminal event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Keep reading.
    Continue,
    /// The provider's terminal event arrived (successful or not): stop
    /// reading, and call [`StreamParser::end`].
    Terminal,
}

/// The stream is not what this provider sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Malformed(pub &'static str);

/// One provider stream's parser. A fresh one per attempt.
pub trait StreamParser: Send {
    /// Consume one SSE event, pushing any content it completes.
    ///
    /// # Errors
    ///
    /// [`Malformed`] when the event cannot be what the provider sends.
    fn feed(&mut self, event: &sse::SseEvent, out: &mut Vec<Content>) -> Result<Step, Malformed>;

    /// The stream is over: after [`Step::Terminal`], or because the body
    /// ended (`terminal == false`: the provider's end-of-stream event never
    /// came). Returns the finish reason, usage and any failure.
    fn end(&mut self, terminal: bool) -> Ending;
}

/// One upstream API style.
pub trait Provider: Send + Sync + fmt::Debug + 'static {
    /// The catalogue style this adapter speaks.
    fn style(&self) -> ApiStyle;

    /// The path appended to the provider's configured base URL.
    fn path(&self) -> &'static str;

    /// The allowlisted headers for this provider's request — the credential
    /// and the fixed protocol headers, nothing else.
    ///
    /// # Errors
    ///
    /// The key is not a valid header value.
    fn headers(
        &self,
        key: &secrecy::SecretString,
    ) -> Result<reqwest::header::HeaderMap, ApiFailure>;

    /// The provider request body.
    ///
    /// # Errors
    ///
    /// `400 invalid_request` for a request this provider cannot express.
    fn body(
        &self,
        request: &ChatRequest,
        model: &CatalogModel,
        max_output_tokens: u64,
    ) -> Result<Value, ApiFailure>;

    /// A parser for one attempt's stream.
    fn parser(&self) -> Box<dyn StreamParser>;

    /// A non-2xx answer. `body` is at most [`client::ERROR_BODY_LIMIT`]
    /// bytes and is read only for the provider's error *type*.
    fn classify_status(
        &self,
        status: u16,
        retry_after: Option<Duration>,
        body: &[u8],
    ) -> ProviderFailure {
        classify_status(status, retry_after, provider_error_type(body).as_deref())
    }
}

/// The adapter for a catalogue style, or `None` for one this build cannot
/// speak ([`ApiStyle::Unknown`], which the catalogue already refuses to call).
#[must_use]
pub fn for_style(
    style: ApiStyle,
    chat_usage: openai_chat::UsageConvention,
) -> Option<Box<dyn Provider>> {
    match style {
        ApiStyle::OpenaiResponses => Some(Box::new(openai_responses::OpenAiResponses)),
        ApiStyle::AnthropicMessages => Some(Box::new(anthropic::AnthropicMessages)),
        ApiStyle::OpenaiChat => Some(Box::new(openai_chat::OpenAiChat::new(chat_usage))),
        _ => None,
    }
}

/// Map a provider's non-2xx status to the contract (errors.md §4).
///
/// | Status | Code | Retry | Why |
/// |---|---|---|---|
/// | 401, 403 | `internal` | no | the gateway's own key is wrong: a configuration fault, not the provider's, and another attempt cannot fix it |
/// | 402 | `internal` | no | the platform's provider account (Anthropic `billing_error`) |
/// | 400, 404, 413, 422 | `provider_error` | no | the provider refused the translated request; the same request fails the same way |
/// | 408, 504 | `provider_timeout` | yes | |
/// | 429, 409, 5xx, 529 | `provider_error` | yes | overload and transient faults; `retry-after` honoured |
///
/// `error_type` is the provider's error `type`/`code`, where it sharpens a
/// status (an Anthropic `overloaded_error` on a `500`).
#[must_use]
pub fn classify_status(
    status: u16,
    retry_after: Option<Duration>,
    error_type: Option<&str>,
) -> ProviderFailure {
    let (code, reason, retryable) = match status {
        401 | 403 => (ErrorCode::Internal, "provider_auth", false),
        402 => (ErrorCode::Internal, "provider_billing", false),
        408 | 504 => (ErrorCode::ProviderTimeout, "first_byte", true),
        429 | 409 | 529 => (ErrorCode::ProviderError, "http_status", true),
        500..=599 => (ErrorCode::ProviderError, "http_status", true),
        _ if error_type.is_some_and(retryable_error_type) => {
            (ErrorCode::ProviderError, "http_status", true)
        }
        _ => (ErrorCode::ProviderError, "http_status", false),
    };
    ProviderFailure {
        code,
        reason,
        status: Some(status),
        retryable,
        retry_after,
        phase: Phase::BeforeContent,
    }
}

/// Whether a provider error `type` / `code` names a transient condition.
#[must_use]
pub fn retryable_error_type(kind: &str) -> bool {
    matches!(
        kind,
        "overloaded_error"
            | "api_error"
            | "rate_limit_error"
            | "timeout_error"
            | "server_error"
            | "rate_limit_exceeded"
            | "requests"
            | "tokens"
            | "internal_error"
            | "service_unavailable"
    )
}

/// The error `type` (or `code`) from a provider's JSON error body — the one
/// token the gateway reads from it. Everything else in the body (a message
/// that may quote the request) is discarded unread.
#[must_use]
pub fn provider_error_type(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let error = value.get("error")?;
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str))?;
    // A short identifier or nothing: this string reaches a log line.
    (kind.len() <= 64
        && kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.'))
    .then(|| kind.to_owned())
}

/// Read a JSON integer count, refusing anything that is not a non-negative
/// integer. Absent or `null` is `None`; a string, a float or a negative is
/// [`Malformed`] — a usage number the gateway cannot read exactly is not one
/// it may settle on.
///
/// # Errors
///
/// [`Malformed`] for a present value that is not a `u64`.
pub fn count(value: Option<&Value>, what: &'static str) -> Result<Option<u64>, Malformed> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or(Malformed(what)),
    }
}

/// The request's effective output cap: the client's `max_output_tokens`,
/// never above the model's own ceiling. (The affordability clamp of
/// chat-api.md §2.2 step 5 is the metering layer's, and lowers it further.)
#[must_use]
pub fn output_cap(request: &ChatRequest, model: &CatalogModel) -> u64 {
    request
        .max_output_tokens
        .unwrap_or(model.max_output_tokens)
        .min(model.max_output_tokens)
        .max(1)
}

/// Refuse an image part on a message whose role this provider cannot carry
/// an image on — rather than drop it and bill an answer made without it.
///
/// # Errors
///
/// `400 invalid_request` naming the part.
pub fn images_only_on(
    request: &ChatRequest,
    roles: &[f2z_ai_proto::chat::Role],
) -> Result<(), ApiFailure> {
    for (index, message) in request.messages.iter().enumerate() {
        if roles.contains(&message.role) {
            continue;
        }
        if let Some(part) = message
            .content
            .iter()
            .position(|p| matches!(p, f2z_ai_proto::chat::ContentPart::Image { .. }))
        {
            return Err(ApiFailure::new(
                ErrorCode::InvalidRequest,
                "this model cannot take an image part on a message of this role",
            )
            .detail("field", format!("messages[{index}].content[{part}]"))
            .detail("reason", "image_not_supported_for_role"));
        }
    }
    Ok(())
}

/// The most tool-call argument text one stream may accumulate before it is
/// emitted: 4 MiB. Fragments are small and individually within the SSE
/// bound, and nothing reaches the bounded delivery buffer until a call is
/// complete, so without this an endpoint that never finished a call could
/// grow it without limit.
pub const MAX_PENDING_TOOL_BYTES: usize = 4 * 1024 * 1024;

/// The most tool calls one stream may have pending at once.
pub const MAX_PENDING_TOOLS: usize = 128;

/// `data:` URL for an inline image. Built from the client's own bytes; it is
/// not a location anything fetches.
#[must_use]
pub fn data_url(media_type: &str, data: &str) -> String {
    let mut url = String::with_capacity(
        media_type
            .len()
            .saturating_add(data.len())
            .saturating_add(13),
    );
    url.push_str("data:");
    url.push_str(media_type);
    url.push_str(";base64,");
    url.push_str(data);
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping_follows_the_table() {
        let f = classify_status(429, Some(Duration::from_secs(1)), None);
        assert_eq!((f.code, f.retryable), (ErrorCode::ProviderError, true));
        assert_eq!(f.retry_after, Some(Duration::from_secs(1)));
        for s in [500, 502, 503, 529] {
            let f = classify_status(s, None, None);
            assert_eq!(
                (f.code, f.retryable),
                (ErrorCode::ProviderError, true),
                "{s}"
            );
        }
        let f = classify_status(504, None, None);
        assert_eq!((f.code, f.retryable), (ErrorCode::ProviderTimeout, true));
        for s in [401, 403, 402] {
            let f = classify_status(s, None, None);
            assert_eq!((f.code, f.retryable), (ErrorCode::Internal, false), "{s}");
        }
        for s in [400, 404, 413, 422] {
            let f = classify_status(s, None, None);
            assert_eq!(
                (f.code, f.retryable),
                (ErrorCode::ProviderError, false),
                "{s}"
            );
        }
    }

    #[test]
    fn the_error_body_yields_its_type_and_nothing_else() {
        let body =
            br#"{"type":"error","error":{"type":"overloaded_error","message":"PROMPT CANARY"}}"#;
        assert_eq!(
            provider_error_type(body).as_deref(),
            Some("overloaded_error")
        );
        let body = br#"{"error":{"type":"has spaces and PROMPT","message":"x"}}"#;
        assert_eq!(provider_error_type(body), None);
    }

    #[test]
    fn counts_are_exact_integers_or_refused() {
        assert_eq!(count(None, "x"), Ok(None));
        assert_eq!(count(Some(&Value::Null), "x"), Ok(None));
        assert_eq!(count(Some(&serde_json::json!(7)), "x"), Ok(Some(7)));
        assert!(count(Some(&serde_json::json!(-1)), "x").is_err());
        assert!(count(Some(&serde_json::json!(1.5)), "x").is_err());
        assert!(count(Some(&serde_json::json!("7")), "x").is_err());
    }
}
