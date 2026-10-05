//! The AI gateway (`ai.free2z.cash/v1`, `docs/free2z/sdk/spec/chat-api.md`):
//! streamed chat, the models list, estimates and call records.
//!
//! Wire types are `f2z_ai_proto`'s; this module adds the transport and the
//! consumer rules. In short:
//!
//! * read a call's cost with `outcome()` — [`Charge`] here — never from
//!   `charged_2z`;
//! * retry only what `retryable()` allows, and a retry is a **new** call with
//!   a **new** `Idempotency-Key`; re-sending the **same** key is receipt
//!   recovery and never does new work;
//! * skip events you do not know;
//! * cancel by dropping the stream or through its [`CancelHandle`] — which
//!   stops delivery, not the charge.
//!
//! ```no_run
//! # async fn run(client: f2z_sdk::Client) -> Result<(), f2z_sdk::Error> {
//! use f2z_sdk::ai::Charge;
//! use f2z_sdk::proto::chat::Message;
//! use f2z_sdk::proto::{ChatRequest, Event};
//!
//! let request = ChatRequest::new("example-model-small", vec![Message::user("Hello")])
//!     .with_max_output_tokens(200);
//! let mut stream = client.ai().chat(request).await?;
//! while let Some(event) = stream.next().await? {
//!     match event {
//!         Event::Delta(d) => print!("{}", d.text),
//!         Event::Done(done) => match Charge::from(done.outcome()) {
//!             Charge::Charged { charged_2z, .. } => println!("\n{charged_2z}"),
//!             Charge::NothingCharged => println!("\nfree"),
//!             _ => println!("\nsettling…"),
//!         },
//!         _ => {}
//!     }
//! }
//! # Ok(()) }
//! ```
//!
//! Structured output: set `response_format` and parse the reply text as
//! JSON. A model whose `capabilities.structured_output` is `false` refuses
//! the call up front (`400 invalid_request`,
//! `reason: "response_format_unsupported"`); a reply that stopped at
//! `length` is truncated JSON, so check `finish_reason` before parsing.
//!
//! The schema is an [`f2z_ai_proto::OrderedJson`]: its members are sent in
//! the order written, and OpenAI writes the reply's keys in that order.
//! Parse it from text to keep that order — `serde_json::json!` builds a
//! `Value`, which has already sorted them.
//!
//! ```
//! use f2z_sdk::proto::OrderedJson;
//! use f2z_sdk::proto::chat::{JsonSchemaFormat, ResponseFormat};
//!
//! let schema: OrderedJson = r#"{
//!     "type": "object",
//!     "properties": {"reasoning": {"type": "string"}, "answer": {"type": "string"}},
//!     "required": ["reasoning", "answer"],
//!     "additionalProperties": false
//! }"#
//! .parse()
//! .expect("valid JSON");
//! let format = ResponseFormat::JsonSchema {
//!     json_schema: JsonSchemaFormat {
//!         name: "activity_spec".into(),
//!         schema,
//!         strict: Some(true),
//!     },
//! };
//! format.check().expect("within the gateway's limits");
//! let sent = serde_json::to_string(&format).expect("serializes");
//! assert!(sent.find("reasoning") < sent.find("answer"));
//! ```
//!
//! Reasoning effort: on a model whose `capabilities.reasoning_effort` is
//! `true` (and whose `controls.effort_levels`, when listed, include the
//! level), set `reasoning_effort`. Any other model refuses the call before
//! any hold (`400 invalid_request`, `reason: "reasoning_effort_unsupported"`)
//! — it is never sent without it. Reasoning is billed as output and, on
//! OpenAI, counts inside `max_output_tokens`: leave room for it.
//!
//! ```
//! use f2z_sdk::proto::chat::{ChatRequest, Message, ReasoningEffort};
//!
//! let request = ChatRequest::new("MODEL_ID_FROM_V1_MODELS", vec![Message::user("Plan a week.")])
//!     .with_reasoning_effort(ReasoningEffort::Low);
//! assert_eq!(
//!     serde_json::to_value(&request).unwrap()["reasoning_effort"],
//!     "low"
//! );
//! ```

mod record;
mod sse;
mod stream;

use std::time::{Duration, Instant};

use f2z_ai_proto::chat::EstimateResponse;
use f2z_ai_proto::event::ErrorEvent;
use f2z_ai_proto::{ChatRequest, ErrorCode, Milli2z, Whole2z};
use reqwest::StatusCode;
use url::Url;

pub use record::{
    CallError, CallRecord, CallStatus, Capabilities, Charge, Controls, ModelInfo, Models,
};
pub use stream::{CancelHandle, ChatStream, Completion};

use crate::client::Client;
use crate::error::{ApiError, Error};

/// `details.reason` on every `max_output_tokens_strict` refusal.
const STRICT_OUTPUT_REASON: &str = "max_output_tokens_strict";
use crate::http;

/// Options of one chat call.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatOptions {
    /// The `Idempotency-Key`. `None` draws a fresh one per call, which is
    /// what a new call wants. Pass the key of an earlier call to recover its
    /// receipt ([`Error::Replayed`]) — never to run it again.
    pub idempotency_key: Option<String>,
    /// How many times a failure that `retryable()` allows — a refused
    /// request, or a lone `error` before `meta` — is retried as a new call.
    pub max_retries: u32,
    /// How many times a request that got **no response** is re-sent with
    /// the same key.
    pub transport_retries: u32,
    /// The first backoff; it doubles per attempt, capped at 30 s. A
    /// `Retry-After` from the server takes precedence.
    pub retry_base_delay: Duration,
}

impl Default for ChatOptions {
    fn default() -> Self {
        Self {
            idempotency_key: None,
            max_retries: 2,
            transport_retries: 2,
            retry_base_delay: Duration::from_secs(1),
        }
    }
}

impl ChatOptions {
    /// With a caller-chosen key.
    #[must_use]
    pub fn with_idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// With at most `n` automatic retries of a retryable failure.
    #[must_use]
    pub fn with_max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    /// With at most `n` same-key re-sends of a request that got no response.
    #[must_use]
    pub fn with_transport_retries(mut self, n: u32) -> Self {
        self.transport_retries = n;
        self
    }

    /// With a different first backoff.
    #[must_use]
    pub fn with_retry_base_delay(mut self, delay: Duration) -> Self {
        self.retry_base_delay = delay;
        self
    }
}

/// A call that ended in an `error` event, with what it still cost.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct ChatFailure {
    /// The call, when known.
    pub call_id: Option<String>,
    /// The terminal `error` event.
    pub error: ErrorEvent,
    /// What the failed call cost, from `error.outcome()`.
    pub charge: Charge,
    /// The text delivered before the failure.
    pub partial_text: String,
}

/// The gateway client: [`Client::ai`].
#[derive(Clone, Debug)]
pub struct Ai {
    client: Client,
}

impl Client {
    /// The AI gateway, with this client's session. Needs `ai:invoke`.
    #[must_use]
    pub fn ai(&self) -> Ai {
        Ai {
            client: self.clone(),
        }
    }
}

impl Ai {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.client.inner.config.ai_base)
    }

    /// Start a streamed chat call with a fresh `Idempotency-Key`.
    ///
    /// `request.stream` is forced to `true`.
    ///
    /// # Errors
    ///
    /// [`Error::Api`] for a refusal before the stream began (`402
    /// insufficient_balance`, `403 cap_exceeded`, `429`, …) once retries
    /// allowed by `retryable()` are spent.
    pub async fn chat(&self, request: ChatRequest) -> Result<ChatStream, Error> {
        self.chat_with(request, ChatOptions::default()).await
    }

    /// [`Ai::chat`] with options.
    ///
    /// # Errors
    ///
    /// As [`Ai::chat`]; with an old key, [`Error::Replayed`] when that call
    /// already finished.
    pub async fn chat_with(
        &self,
        mut request: ChatRequest,
        options: ChatOptions,
    ) -> Result<ChatStream, Error> {
        request.stream = true;
        if let Some(key) = &options.idempotency_key
            && !(1..=128).contains(&key.len())
        {
            return Err(Error::Config(
                "an Idempotency-Key is 1-128 characters".into(),
            ));
        }
        local_limits(&request)?;
        let body = serde_json::to_vec(&request).map_err(|e| Error::Internal(e.to_string()))?;
        ChatStream::open(self.client.clone(), body, options).await
    }

    /// Stream a call to the end: [`Ai::chat`] then [`ChatStream::collect`].
    ///
    /// # Errors
    ///
    /// As both; [`Error::ChatFailed`] carries a failed call's cost.
    pub async fn complete(&self, request: ChatRequest) -> Result<Completion, Error> {
        self.chat(request).await?.collect().await
    }

    /// `GET /v1/models`, revalidated with `If-None-Match` against the last
    /// answer this client saw.
    ///
    /// # Errors
    ///
    /// [`Error::Api`] with the envelope.
    pub async fn models(&self) -> Result<Models, Error> {
        let url = self.url("/models");
        let timeout = self.client.inner.config.request_timeout;
        let cached = self
            .client
            .inner
            .models_cache
            .lock()
            .ok()
            .and_then(|c| c.clone());
        let etag = cached.as_ref().map(|(e, _)| e.clone());
        let response = self
            .client
            .send_authorized(|http, token| {
                let r = http.get(&url).bearer_auth(token).timeout(timeout);
                match &etag {
                    Some(e) => r.header(reqwest::header::IF_NONE_MATCH, e),
                    None => r,
                }
            })
            .await?;
        if response.status() == StatusCode::NOT_MODIFIED
            && let Some((_, models)) = cached
        {
            return Ok(models);
        }
        let response = http::expect_success(response).await?;
        let etag = http::header_string(response.headers(), "etag");
        let models: Models = http::read_json(response).await?;
        if let (Some(etag), Ok(mut cache)) = (etag, self.client.inner.models_cache.lock()) {
            *cache = Some((etag, models.clone()));
        }
        Ok(models)
    }

    /// `POST /v1/chat/estimate`: what a call would hold now. No hold, no
    /// charge, no provider call. Not a quotation.
    ///
    /// # Errors
    ///
    /// Exactly as `/v1/chat` would refuse (`402`, `403 cap_exceeded`, …),
    /// with the same `details`.
    pub async fn estimate(&self, request: &ChatRequest) -> Result<EstimateResponse, Error> {
        let url = self.url("/chat/estimate");
        let timeout = self.client.inner.config.request_timeout;
        local_limits(request)?;
        let body = serde_json::to_vec(request).map_err(|e| Error::Internal(e.to_string()))?;
        let response = self
            .client
            .send_authorized(|http, token| {
                http.post(&url)
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .timeout(timeout)
                    .body(body.clone())
            })
            .await?;
        let response = http::expect_success(response).await?;
        http::read_json(response).await
    }

    /// Estimate-then-strict-chat, the safe way: whether `request` would run
    /// **now** with its full `max_output_tokens` — no hold, no charge, no
    /// provider call — and, if not, which recovery to offer the user.
    ///
    /// ```no_run
    /// # async fn run(client: f2z_sdk::Client) -> Result<(), f2z_sdk::Error> {
    /// use f2z_sdk::ai::Preflight;
    /// use f2z_sdk::proto::{ChatRequest, chat::Message};
    ///
    /// let request = ChatRequest::new("MODEL_ID", vec![Message::user("Plan a lesson")])
    ///     .with_max_output_tokens(1800)
    ///     .strict();
    /// match client.ai().preflight(&request).await? {
    ///     Preflight::Ready(_) => { /* enable Generate; send `request` as is */ }
    ///     Preflight::NeedsTopUp { required_2z, .. } => { /* offer a purchase */ }
    ///     Preflight::NeedsBudget { resets_at, .. } => { /* link free2z.cash/account/apps */ }
    ///     Preflight::TooLarge(_) => { /* shorten input or lower max_output_tokens */ }
    ///     _ => {}
    /// }
    /// # Ok(()) }
    /// ```
    ///
    /// # Errors
    ///
    /// [`Error::Config`] unless `request` is strict
    /// ([`ChatRequest::strict`]) with `max_output_tokens` set — a non-strict
    /// estimate is priced differently and can disagree with a strict call.
    /// Every other failure is returned as [`Ai::estimate`] returns it.
    pub async fn preflight(&self, request: &ChatRequest) -> Result<Preflight, Error> {
        if request.max_output_tokens.is_none() || !request.max_output_tokens_strict {
            return Err(Error::Config(
                "preflight needs a strict request: set max_output_tokens and \
                 max_output_tokens_strict (ChatRequest::with_max_output_tokens(..).strict())"
                    .into(),
            ));
        }
        match self.estimate(request).await {
            Ok(estimate) => Ok(Preflight::Ready(estimate)),
            Err(Error::Api(e)) => Preflight::from_refusal(e).map_err(Error::Api),
            Err(e) => Err(e),
        }
    }

    /// `GET /v1/calls/{id}`: a call's record — for a receipt, or to learn
    /// the outcome of a stream that was interrupted, cancelled or ended
    /// `pending`.
    ///
    /// # Errors
    ///
    /// [`Error::Api`] (`404 call_not_found`).
    pub async fn call(&self, call_id: &str) -> Result<CallRecord, Error> {
        let mut url = Url::parse(&self.client.inner.config.ai_base)
            .map_err(|e| Error::Config(format!("ai_base: {e}")))?;
        url.path_segments_mut()
            .map_err(|()| Error::Config("ai_base cannot be a base".into()))?
            .extend(["calls", call_id]);
        let timeout = self.client.inner.config.request_timeout;
        let response = self
            .client
            .send_authorized(|http, token| {
                http.get(url.clone()).bearer_auth(token).timeout(timeout)
            })
            .await?;
        let response = http::expect_success(response).await?;
        http::read_json(response).await
    }

    /// Read a call's record until its status is terminal (`settled`,
    /// `settled_partial`, `released`) — 1 s, 2 s, 4 s, … capped at 10 s — or
    /// `max_wait` passes, returning the last record either way.
    ///
    /// # Errors
    ///
    /// As [`Ai::call`].
    pub async fn wait_for_call(
        &self,
        call_id: &str,
        max_wait: Duration,
    ) -> Result<CallRecord, Error> {
        let deadline = Instant::now().checked_add(max_wait);
        let mut delay = Duration::from_secs(1);
        loop {
            let record = self.call(call_id).await?;
            if record.status.is_terminal() {
                return Ok(record);
            }
            match deadline {
                Some(d) if Instant::now().checked_add(delay).is_none_or(|t| t > d) => {
                    return Ok(record);
                }
                _ => tokio::time::sleep(delay).await,
            }
            delay = delay.saturating_mul(2).min(Duration::from_secs(10));
        }
    }
}

/// [`Ai::preflight`]: whether a strict request would run now and, if not,
/// the recovery UX to show. A snapshot — the call itself must still carry
/// `max_output_tokens_strict`, which is the guarantee. Amounts are `None`
/// when the server did not send them.
#[non_exhaustive]
#[derive(Clone, Debug)]
pub enum Preflight {
    /// It would run now with exactly `max_output_tokens`.
    Ready(EstimateResponse),
    /// `402 insufficient_balance`: the balance cannot cover it. Offer a
    /// purchase, then re-read the balance once the purchase is `credited`.
    NeedsTopUp {
        /// The hold the call needs.
        required_2z: Option<Whole2z>,
        /// What the user has now.
        available_milli_2z: Option<Milli2z>,
        /// The refusal, for logs and any other `details`.
        error: Box<ApiError>,
    },
    /// `403 cap_exceeded`: this app's budget for the user cannot cover it.
    /// Buying 2Z does **not** help; link to `https://free2z.cash/account/apps`
    /// or wait for `resets_at`.
    NeedsBudget {
        /// The hold the call needs.
        required_2z: Option<Whole2z>,
        /// What is left of the budget this period.
        cap_remaining_milli_2z: Option<Milli2z>,
        /// RFC 3339; `None` also for a `total` budget, which never resets.
        resets_at: Option<String>,
        /// The refusal, for logs and any other `details`.
        error: Box<ApiError>,
    },
    /// `400 context_length_exceeded`, or `400 invalid_request` on
    /// `max_output_tokens` with `reason: max_output_tokens_strict` (above the
    /// model's ceiling): it can never run as
    /// asked. Shorten the input or lower `max_output_tokens`.
    TooLarge(Box<ApiError>),
}

impl Preflight {
    fn from_refusal(error: Box<ApiError>) -> Result<Self, Box<ApiError>> {
        let required_2z = error.detail_u64("required_2z").map(Whole2z::new);
        match error.error_code() {
            ErrorCode::InsufficientBalance => Ok(Self::NeedsTopUp {
                required_2z,
                available_milli_2z: error.detail_u64("available_milli_2z").map(Milli2z::new),
                error,
            }),
            ErrorCode::CapExceeded => Ok(Self::NeedsBudget {
                required_2z,
                cap_remaining_milli_2z: error
                    .detail_u64("cap_remaining_milli_2z")
                    .map(Milli2z::new),
                resets_at: error.detail_str("resets_at").map(str::to_owned),
                error,
            }),
            ErrorCode::ContextLengthExceeded => Ok(Self::TooLarge(error)),
            // Only the strict ceiling refusal: `field: max_output_tokens` is
            // also `out_of_range` (0) or `required`, a malformed request that
            // shortening the input would not fix.
            ErrorCode::InvalidRequest
                if error.detail_str("field") == Some("max_output_tokens")
                    && error.detail_str("reason") == Some(STRICT_OUTPUT_REASON) =>
            {
                Ok(Self::TooLarge(error))
            }
            _ => Err(error),
        }
    }
}

/// The gateway's structural limits that need no catalogue, checked before
/// anything is sent: a request the gateway would refuse never spends a
/// request against the user's or the app's rate allowance.
fn local_limits(request: &ChatRequest) -> Result<(), Error> {
    match &request.response_format {
        Some(format) => format.check().map_err(|e| Error::Config(e.to_string())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod local_limit_tests {
    use super::*;

    #[test]
    fn a_response_format_outside_the_limits_is_refused_before_sending() {
        let mut request: ChatRequest =
            serde_json::from_value(serde_json::json!({"model": "m", "messages": []})).unwrap();
        local_limits(&request).unwrap();
        request.response_format = Some(
            serde_json::from_value(serde_json::json!({"type": "json_schema",
                "json_schema": {"name": "activity_spec", "schema": {"type": "object"}}}))
            .unwrap(),
        );
        local_limits(&request).unwrap();
        request.response_format = Some(
            serde_json::from_value(serde_json::json!({"type": "json_schema",
                "json_schema": {"name": "has space", "schema": {"type": "object"}}}))
            .unwrap(),
        );
        assert!(matches!(local_limits(&request), Err(Error::Config(m)) if m.contains("name")));
    }
}
