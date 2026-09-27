//! One call's provider stream, as an [`Upstream`]: the attempt loop, the
//! provider deadlines, the retry rule, and the parse.
//!
//! # Cancellation safety is the whole design
//!
//! The call task polls [`Upstream::next`] inside a `select!` beside a 250 ms
//! stall tick and the drain signal (`crate::call::run`), so a `next` future
//! is routinely **dropped mid-await**. Everything that must survive that is
//! therefore state on the struct, not a local of the future:
//!
//! * the in-flight `send` is a boxed future in [`State::Sending`], polled by
//!   reference — dropping `next` does not drop the request;
//! * every deadline is an **absolute** instant stored in the state, so a
//!   restarted `next` resumes the same deadline instead of starting a fresh
//!   timeout (a relative `timeout(idle, …)` would be reset by every tick and
//!   the 60 s idle limit would never fire);
//! * reading the body is `Response::chunk`, which takes nothing until a chunk
//!   is ready.
//!
//! # Deadlines (chat-api.md §1)
//!
//! | Deadline | From | Outcome |
//! |---|---|---|
//! | connect, 5 s | each attempt's connect | `unavailable` (`connect`), retried |
//! | first byte, the model's `ttfb_timeout_ms` | each attempt's send, until its first body byte | `provider_timeout` (`first_byte`), **not** retried: the request was written |
//! | idle, the model's `idle_timeout_ms` (default 60 s) | each body chunk | `provider_timeout` (`idle`) |
//! | hard limit, 300 s | **admission of the call** | `provider_timeout` (`hard_limit`) |
//!
//! # Retry
//!
//! **Only before the provider can have accepted the request**, because a
//! provider bills a request it accepted whether or not the gateway reads the
//! answer — a retry after acceptance is the same call paid for twice, and
//! the client charged for one at most. So exactly two failures retry: a
//! refused **connection** (nothing was sent), and a **non-2xx status** the
//! provider answered with (it refused the request; `429`, `5xx`, `529`, per
//! [`super::classify_status`]) — except `502`, `504` and `408`, which an
//! intermediary can answer after forwarding the request to a model that is
//! still generating it. A timeout waiting for the
//! head, a transport error after the request was written, and anything after
//! a 2xx head — a cut stream, an error event, a first-byte or idle timeout —
//! end the call with that attempt's own usage, if it reported any.
//!
//! Retries are also invisible to the client (nothing was produced) and are
//! bounded by [`super::resilience`]'s per-call policy, per-provider budget
//! and circuit breaker.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::chat::UsageSource;
use f2z_ai_proto::event::{Delta, Event, UsageEvent};
use reqwest::Response;
use reqwest::header::HeaderMap;
use tokio::time::Instant;

use super::backend::ProviderHandle;
use super::resilience::{Permit, RetryPolicy, Verdict};
use super::sse::{Decoder, SseEvent};
use super::{
    Content, Ending, Phase, Provider, ProviderFailure, ProviderOutcome, Step, StreamParser,
    UsageReport, client,
};
use crate::call::Upstream;

/// How long a provider's error body may take to arrive.
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(5);

type Sending = Pin<Box<dyn Future<Output = reqwest::Result<Response>> + Send>>;

enum State {
    /// Begin the next attempt.
    Start,
    /// The request is out; waiting for the response head.
    Sending { send: Sending, deadline: Instant },
    /// A non-2xx: reading (a bounded prefix of) its body for the error type.
    ErrorBody {
        response: Response,
        status: u16,
        retry_after: Option<Duration>,
        body: Vec<u8>,
        deadline: Instant,
    },
    /// Reading the event stream.
    Streaming {
        response: Response,
        decoder: Decoder,
        parser: Box<dyn StreamParser>,
        got_bytes: bool,
        deadline: Instant,
    },
    /// Waiting out a backoff before the next attempt.
    Backoff { until: Instant },
    /// The outcome is known; only queued events remain.
    Done,
}

/// A provider stream for one call.
pub struct ProviderUpstream {
    handle: Arc<ProviderHandle>,
    adapter: Box<dyn Provider>,
    url: reqwest::Url,
    headers: HeaderMap,
    body: Bytes,
    /// The body's share of the upload budget, released with the body.
    reservation: Option<tokio::sync::OwnedSemaphorePermit>,
    ttfb: Duration,
    idle: Duration,
    hard_deadline: Instant,
    retry: RetryPolicy,
    /// The request's image parts: `usage.images` (no provider reports it).
    images: u64,
    state: State,
    queue: VecDeque<Event>,
    attempts: u32,
    output_produced: bool,
    function_tool_calls: u64,
    permit: Option<Permit>,
    outcome: Option<ProviderOutcome>,
    events: Vec<SseEvent>,
    content: Vec<Content>,
}

impl std::fmt::Debug for ProviderUpstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the body (the prompt) or the headers (the key).
        f.debug_struct("ProviderUpstream")
            .field("provider", &self.handle.name)
            .field("style", &self.adapter.style())
            .field("attempts", &self.attempts)
            .field("output_produced", &self.output_produced)
            .finish_non_exhaustive()
    }
}

/// Everything [`ProviderUpstream::new`] needs.
pub(crate) struct Prepared {
    pub(crate) handle: Arc<ProviderHandle>,
    pub(crate) adapter: Box<dyn Provider>,
    pub(crate) url: reqwest::Url,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Bytes,
    pub(crate) ttfb: Duration,
    pub(crate) idle: Duration,
    pub(crate) hard_deadline: Instant,
    pub(crate) retry: RetryPolicy,
    pub(crate) images: u64,
}

impl ProviderUpstream {
    pub(crate) fn new(p: Prepared) -> Self {
        Self {
            handle: p.handle,
            adapter: p.adapter,
            url: p.url,
            headers: p.headers,
            body: p.body,
            reservation: None,
            ttfb: p.ttfb,
            idle: p.idle,
            hard_deadline: p.hard_deadline,
            retry: p.retry,
            images: p.images,
            state: State::Start,
            queue: VecDeque::new(),
            attempts: 0,
            output_produced: false,
            function_tool_calls: 0,
            permit: None,
            outcome: None,
            events: Vec::new(),
            content: Vec::new(),
        }
    }

    /// The outcome, once the stream has ended.
    #[must_use]
    pub fn outcome_ref(&self) -> Option<&ProviderOutcome> {
        self.outcome.as_ref()
    }

    fn phase(&self) -> Phase {
        if self.output_produced {
            Phase::AfterContent
        } else {
            Phase::BeforeContent
        }
    }

    /// Advance the state machine by one await. Cancel-safe: see the module
    /// documentation.
    async fn step(&mut self) {
        let now = Instant::now();
        match &mut self.state {
            State::Done => {}
            State::Start => self.begin(now),
            State::Backoff { until } => {
                tokio::time::sleep_until(*until).await;
                self.state = State::Start;
            }
            State::Sending { send, deadline } => {
                let deadline = *deadline;
                match tokio::time::timeout_at(deadline, send.as_mut()).await {
                    // The request was written and no head came back: the
                    // provider may have accepted it and be generating (and
                    // billing). Never re-sent — see "Retry" above.
                    Err(_) => {
                        let failure = self.deadline_failure(deadline, false);
                        self.finish(
                            Some(failure),
                            None,
                            UsageReport::Missing { partial: None },
                            0,
                        );
                    }
                    // Nothing reached the provider: the one transport
                    // failure that is safe to retry.
                    Ok(Err(error)) if error.is_connect() => {
                        let failure = ProviderFailure::new(ErrorCode::Unavailable, "connect", true);
                        self.attempt_failed(failure);
                    }
                    Ok(Err(_)) => {
                        let failure =
                            ProviderFailure::new(ErrorCode::ProviderError, "transport", true);
                        self.finish(
                            Some(failure),
                            None,
                            UsageReport::Missing { partial: None },
                            0,
                        );
                    }
                    Ok(Ok(response)) if response.status().is_success() => {
                        // Accepted: nothing after this is ever re-sent, so
                        // the request body (up to 20 MiB of prompt and
                        // images) is not kept for the rest of the stream.
                        self.release_body();
                        // A half-open breaker's probe has its answer at the
                        // head: the provider is serving again. Waiting for
                        // the end of the probe's stream would refuse every
                        // other call for as long as it runs.
                        if self.permit.as_ref().is_some_and(Permit::is_probe)
                            && let Some(permit) = self.permit.take()
                        {
                            permit.record(Verdict::Success);
                        }
                        self.state = State::Streaming {
                            response,
                            decoder: Decoder::new(),
                            parser: self.adapter.parser(),
                            got_bytes: false,
                            deadline,
                        };
                    }
                    Ok(Ok(response)) => {
                        let retry_after = response
                            .headers()
                            .get(reqwest::header::RETRY_AFTER)
                            .and_then(|v| v.to_str().ok())
                            .and_then(parse_retry_after);
                        self.state = State::ErrorBody {
                            status: response.status().as_u16(),
                            response,
                            retry_after,
                            body: Vec::new(),
                            deadline: now
                                .checked_add(ERROR_BODY_TIMEOUT)
                                .unwrap_or(now)
                                .min(self.hard_deadline),
                        };
                    }
                }
            }
            State::ErrorBody {
                response,
                status,
                retry_after,
                body,
                deadline,
            } => {
                let more = match tokio::time::timeout_at(*deadline, response.chunk()).await {
                    Ok(Ok(Some(chunk))) => {
                        let room = client::ERROR_BODY_LIMIT.saturating_sub(body.len());
                        body.extend_from_slice(
                            chunk.get(..room.min(chunk.len())).unwrap_or_default(),
                        );
                        body.len() < client::ERROR_BODY_LIMIT
                    }
                    _ => false,
                };
                if !more {
                    let (status, retry_after) = (*status, *retry_after);
                    let failure = self.adapter.classify_status(status, retry_after, body);
                    tracing::info!(
                        provider = self.handle.name.as_str(),
                        status,
                        retryable = failure.retryable,
                        "provider answered with an error status"
                    );
                    self.attempt_failed(failure);
                }
            }
            State::Streaming {
                response,
                decoder,
                parser,
                got_bytes,
                deadline,
            } => {
                let read = tokio::time::timeout_at(*deadline, response.chunk()).await;
                match read {
                    Err(_) => {
                        let (at, first) = (*deadline, !*got_bytes);
                        let failure = self.deadline_failure(at, !first);
                        self.stream_over(false, Some(failure));
                    }
                    Ok(Err(_)) => {
                        let failure =
                            ProviderFailure::new(ErrorCode::ProviderError, "transport", true);
                        self.stream_over(false, Some(failure));
                    }
                    Ok(Ok(None)) => self.stream_over(false, None),
                    Ok(Ok(Some(chunk))) => {
                        *got_bytes = true;
                        // The idle allowance runs from this chunk's arrival,
                        // not from when this poll began.
                        let now = Instant::now();
                        *deadline = now
                            .checked_add(self.idle)
                            .unwrap_or(now)
                            .min(self.hard_deadline);
                        self.events.clear();
                        if decoder.push(&chunk, &mut self.events).is_err() {
                            let failure = ProviderFailure::new(
                                ErrorCode::ProviderError,
                                "malformed_stream",
                                true,
                            );
                            self.stream_over(false, Some(failure));
                            return;
                        }
                        let mut terminal = false;
                        let mut malformed = false;
                        for event in &self.events {
                            match parser.feed(event, &mut self.content) {
                                Ok(Step::Continue) => {}
                                Ok(Step::Terminal) => {
                                    terminal = true;
                                    break;
                                }
                                Err(super::Malformed(what)) => {
                                    tracing::warn!(
                                        provider = self.handle.name.as_str(),
                                        what,
                                        "malformed provider stream"
                                    );
                                    malformed = true;
                                    break;
                                }
                            }
                        }
                        self.drain_content();
                        if malformed {
                            let failure = ProviderFailure::new(
                                ErrorCode::ProviderError,
                                "malformed_stream",
                                true,
                            );
                            self.stream_over(false, Some(failure));
                        } else if terminal {
                            self.stream_over(true, None);
                        }
                    }
                }
            }
        }
    }

    /// The request will not be sent again: free its bytes and its share of
    /// the upload budget.
    fn release_body(&mut self) {
        self.body = Bytes::new();
        self.reservation = None;
    }

    /// Move parsed content into the event queue.
    fn drain_content(&mut self) {
        for content in self.content.drain(..) {
            self.output_produced = true;
            self.queue.push_back(match content {
                Content::Text(text) => Event::Delta(Delta { text }),
                Content::ToolCall(call) => {
                    self.function_tool_calls = self.function_tool_calls.saturating_add(1);
                    Event::ToolCall(call)
                }
            });
        }
    }

    fn deadline_failure(&self, deadline: Instant, after_bytes: bool) -> ProviderFailure {
        if deadline >= self.hard_deadline {
            ProviderFailure::new(ErrorCode::ProviderTimeout, "hard_limit", false)
        } else if after_bytes {
            ProviderFailure::new(ErrorCode::ProviderTimeout, "idle", true)
        } else {
            ProviderFailure::new(ErrorCode::ProviderTimeout, "first_byte", true)
        }
    }

    fn begin(&mut self, now: Instant) {
        if now >= self.hard_deadline {
            let failure = ProviderFailure::new(ErrorCode::ProviderTimeout, "hard_limit", false);
            self.finish(
                Some(failure),
                None,
                UsageReport::Missing { partial: None },
                0,
            );
            return;
        }
        let Some(permit) = self.handle.breaker.try_acquire(now.into_std()) else {
            let failure =
                ProviderFailure::new(ErrorCode::Unavailable, "provider_circuit_open", false);
            self.finish(
                Some(failure),
                None,
                UsageReport::Missing { partial: None },
                0,
            );
            return;
        };
        self.permit = Some(permit);
        self.attempts = self.attempts.saturating_add(1);
        if self.attempts == 1 {
            self.handle.budget.deposit();
        }
        let send = self
            .handle
            .client
            .post(self.url.clone())
            .headers(self.headers.clone())
            .body(self.body.clone())
            .send();
        self.state = State::Sending {
            send: Box::pin(send),
            deadline: now
                .checked_add(self.ttfb)
                .unwrap_or(now)
                .min(self.hard_deadline),
        };
    }

    /// The attempt's stream is over — at its terminal event, at the end of
    /// the body, or on a failure of the gateway's own (`failure`).
    fn stream_over(&mut self, terminal: bool, failure: Option<ProviderFailure>) {
        let State::Streaming { parser, .. } = &mut self.state else {
            return;
        };
        let Ending {
            finish_reason,
            usage,
            cache_write_1h_tokens,
            failure: stream_failure,
        } = parser.end(terminal);
        // A stream exists, so the provider answered 2xx: it accepted the
        // request and bills for it whatever happens next. Never retried —
        // the attempt's own usage (or its absence) is what the call has.
        self.finish(
            failure.or(stream_failure),
            finish_reason,
            usage,
            cache_write_1h_tokens,
        );
    }

    /// An attempt failed **before the provider accepted it** — a refused
    /// connection, or a non-2xx head: retry if allowed, else finish.
    ///
    /// These are the only retries, because they are the only failures the
    /// provider cannot have billed: a timeout waiting for the head, a
    /// transport error after the request was written, and anything after a
    /// 2xx head all end the call (`finish`). So a retried attempt never has
    /// a usage of its own to keep — there is no cost trail to carry across.
    fn attempt_failed(&mut self, failure: ProviderFailure) {
        let usage = UsageReport::Missing { partial: None };
        let verdict = breaker_verdict(&failure);
        // A 502, 504 or 408 is an intermediary (or the provider's front
        // end) failing on a request it may already have forwarded: the model
        // may be generating it (RFC 9110 §15.6.3, §15.6.5). Retryable for the
        // client — a new call — but never re-sent here.
        let forwarded = matches!(failure.status, Some(408 | 502 | 504));
        if let Some(permit) = self.permit.take() {
            permit.record(verdict);
        }
        let now = Instant::now();
        let retry = self.attempts;
        let wait = (failure.retryable
            && !forwarded
            && !self.output_produced
            && retry <= self.retry.max_retries)
            .then(|| {
                self.retry
                    .backoff(retry, failure.retry_after, jitter_seed(retry))
            })
            .flatten()
            .and_then(|wait| now.checked_add(wait))
            .filter(|until| *until < self.hard_deadline);
        if let Some(until) = wait
            && !self.handle.breaker.is_open(now.into_std())
            && self.handle.budget.withdraw()
        {
            tracing::info!(
                provider = self.handle.name.as_str(),
                attempt = self.attempts,
                reason = failure.reason,
                status = failure.status,
                "retrying the provider request before any output"
            );
            self.state = State::Backoff { until };
            return;
        }
        self.finish(Some(failure), None, usage, 0);
    }

    fn finish(
        &mut self,
        failure: Option<ProviderFailure>,
        finish_reason: Option<f2z_ai_proto::chat::FinishReason>,
        usage: UsageReport,
        cache_write_1h_tokens: u64,
    ) {
        let failure = failure.map(|f| ProviderFailure {
            phase: self.phase(),
            ..f
        });
        if let Some(permit) = self.permit.take() {
            permit.record(match &failure {
                None => Verdict::Success,
                Some(f) => breaker_verdict(f),
            });
        }
        // Every provider bills images inside its token counts and none
        // reports how many it saw; the catalogue's per-image price
        // (metering.md §2.1) applies to the image parts the request sent.
        let usage = match usage {
            UsageReport::Reported(u) => UsageReport::Reported(f2z_ai_proto::chat::Usage {
                images: self.images,
                ..u
            }),
            missing @ UsageReport::Missing { .. } => missing,
        };
        self.release_body();
        // `usage` goes to the client only on a stream it belongs to: a
        // success, or a failure after output. A failure before any content
        // is a lone `error` (chat-api.md §3.1), so its usage — if a provider
        // reported one — stays in the outcome for the record.
        if let UsageReport::Reported(usage) = usage
            && (failure.is_none() || self.output_produced)
        {
            self.queue.push_back(Event::Usage(UsageEvent {
                usage,
                source: UsageSource::Provider,
            }));
        }
        match &failure {
            Some(f) => tracing::info!(
                provider = self.handle.name.as_str(),
                code = f.code.as_str(),
                reason = f.reason,
                status = f.status,
                after_content = self.output_produced,
                attempts = self.attempts,
                usage_reported = usage.reported().is_some(),
                "provider call failed"
            ),
            None => tracing::debug!(
                provider = self.handle.name.as_str(),
                attempts = self.attempts,
                usage_reported = usage.reported().is_some(),
                "provider call finished"
            ),
        }
        self.outcome = Some(ProviderOutcome {
            finish_reason: if failure.is_some() {
                None
            } else {
                finish_reason
            },
            usage,
            cache_write_1h_tokens,
            failure,
            output_produced: self.output_produced,
            function_tool_calls: self.function_tool_calls,
            attempts: self.attempts,
        });
        // Drops the response: the connection to the provider is closed.
        self.state = State::Done;
    }
}

/// What a failure says about the provider's health. A `429` is the
/// provider throttling this account, not failing; a request it refused
/// (4xx) or an `internal` (the gateway's own key) says nothing either.
fn breaker_verdict(failure: &ProviderFailure) -> Verdict {
    match failure.status {
        Some(429) => Verdict::Neutral,
        _ if failure.code == ErrorCode::Internal => Verdict::Neutral,
        _ if failure.retryable
            || matches!(
                failure.code,
                ErrorCode::ProviderTimeout | ErrorCode::Unavailable
            ) =>
        {
            Verdict::Failure
        }
        _ => Verdict::Neutral,
    }
}

/// `Retry-After`: delay-seconds, or an HTTP-date (RFC 9110 §10.2.3). A date
/// in the past is "now".
#[must_use]
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(
        at.duration_since(std::time::SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

/// A cheap per-retry jitter seed; not security-relevant.
fn jitter_seed(retry: u32) -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()));
    nanos ^ u64::from(retry).rotate_left(17)
}

#[async_trait]
impl Upstream for ProviderUpstream {
    async fn next(&mut self) -> Option<Event> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(event);
            }
            if matches!(self.state, State::Done) {
                return None;
            }
            self.step().await;
        }
    }

    fn outcome(&mut self) -> Option<ProviderOutcome> {
        self.outcome.clone()
    }

    fn keep_upload_reservation(&mut self, reservation: tokio::sync::OwnedSemaphorePermit) {
        if !self.body.is_empty() {
            self.reservation = Some(reservation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_is_seconds_or_an_http_date() {
        assert_eq!(parse_retry_after(" 3 "), Some(Duration::from_secs(3)));
        let soon = std::time::SystemTime::now() + Duration::from_secs(30);
        let d = parse_retry_after(&httpdate::fmt_http_date(soon)).unwrap();
        assert!(
            d > Duration::from_secs(27) && d <= Duration::from_secs(30),
            "{d:?}"
        );
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(Duration::ZERO),
            "a past date is now"
        );
        assert_eq!(parse_retry_after("soon"), None);
    }
}
