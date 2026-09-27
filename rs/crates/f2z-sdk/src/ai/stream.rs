//! [`ChatStream`]: one `/v1/chat` call as a pull-based stream of
//! `f2z_ai_proto` [`Event`]s.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use f2z_ai_proto::Event;
use f2z_ai_proto::chat::ToolCall;
use f2z_ai_proto::event::{Done, EventError, Meta, UsageEvent};
use tokio::sync::Notify;

use super::record::{CallRecord, Charge};
use super::{ChatFailure, ChatOptions};
use crate::client::Client;
use crate::error::{Error, TransportError};
use crate::http;
use crate::random;

use super::sse::{Frame, Parser};

/// Cancels a [`ChatStream`] from anywhere — another task, a UI button.
///
/// Cancelling closes the connection, which is how a client cancels
/// (`chat-api.md` §2.4). It stops **delivery**, not generation: the gateway
/// reads the provider to completion and settles on what it reports
/// (`finish_reason: cancelled`). Read the outcome with
/// [`crate::ai::Ai::wait_for_call`]. Dropping the [`ChatStream`] does the same.
#[derive(Clone, Debug)]
pub struct CancelHandle(Arc<CancelState>);

#[derive(Debug, Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelHandle {
    /// Cancel. Idempotent.
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    /// Whether [`CancelHandle::cancel`] was called.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }
}

/// One streamed `/v1/chat` call.
///
/// Read it with [`ChatStream::next`] until `None`. What it yields follows the
/// consumer rules of `chat-api.md` §3.1:
///
/// * events the SDK does not know are **skipped**, and a trailing CR never
///   reaches an event name;
/// * the terminal event (`done` or `error`) is the last item — read its
///   charge with `outcome()` (or [`Charge::from`]), never `charged_2z`;
/// * a stream that closes without a terminal event is
///   [`Error::StreamInterrupted`]: the call may still be running and
///   billable, so read its record rather than retrying;
/// * a lone `error` before `meta` that `ErrorEvent::retryable()` allows —
///   nothing delivered, nothing charged — is retried **inside** the stream as
///   a new call with a **new** `Idempotency-Key`, within
///   [`ChatOptions::max_retries`]. Nothing else is ever retried; a charged
///   or partial failure is handed to you as it is.
///
/// Dropping the stream closes the connection (a cancellation).
pub struct ChatStream {
    client: Client,
    body: Vec<u8>,
    options: ChatOptions,
    key: String,
    retries_left: u32,
    attempt: u32,
    response: Option<reqwest::Response>,
    parser: Parser,
    queue: VecDeque<Frame>,
    call_id: Option<String>,
    delivered: bool,
    finished: bool,
    cancel: CancelHandle,
    idle: Duration,
    /// The session generation this call belongs to: every re-send acts as
    /// the user who started it, or stops.
    session: Option<u64>,
}

impl std::fmt::Debug for ChatStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatStream")
            .field("call_id", &self.call_id)
            .field("idempotency_key", &self.key)
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

/// `future`, or a transport timeout after `limit`.
async fn bounded<T>(limit: Duration, future: impl Future<Output = T>) -> Result<T, Error> {
    tokio::time::timeout(limit, future).await.map_err(|_| {
        Error::Transport(TransportError::timeout(
            "the gateway sent headers but no body",
        ))
    })
}

fn backoff(base: Duration, attempt: u32) -> Duration {
    base.saturating_mul(2u32.saturating_pow(attempt.min(5)))
        .min(Duration::from_secs(30))
}

impl ChatStream {
    pub(crate) async fn open(
        client: Client,
        body: Vec<u8>,
        options: ChatOptions,
    ) -> Result<Self, Error> {
        let key = match &options.idempotency_key {
            Some(k) => k.clone(),
            None => random::uuid_v4()?,
        };
        let idle = client.inner.config.stream_idle_timeout;
        let mut stream = Self {
            client,
            body,
            retries_left: options.max_retries,
            options,
            key,
            attempt: 0,
            response: None,
            parser: Parser::default(),
            queue: VecDeque::new(),
            call_id: None,
            delivered: false,
            finished: false,
            cancel: CancelHandle(Arc::new(CancelState::default())),
            idle,
            session: None,
        };
        stream.connect().await?;
        Ok(stream)
    }

    /// The `Idempotency-Key` the current request carries. Re-sending the
    /// same request with it (`ChatOptions::idempotency_key`) is receipt
    /// recovery — it can never start a second call.
    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.key
    }

    /// The call id, once the response header or `meta` has named it.
    #[must_use]
    pub fn call_id(&self) -> Option<&str> {
        self.call_id.as_deref()
    }

    /// A handle that cancels this stream from elsewhere.
    #[must_use]
    pub fn cancel_handle(&self) -> CancelHandle {
        self.cancel.clone()
    }

    /// Sleep for `delay` unless cancelled first. Cancellation is checked
    /// before every send, so a Stop pressed during a backoff never starts
    /// a new — billable — call.
    async fn pause(&self, delay: Duration) -> Result<(), Error> {
        let notified = self.cancel.0.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        tokio::select! {
            biased;
            () = &mut notified => Err(Error::Cancelled),
            () = tokio::time::sleep(delay) => Ok(()),
        }
    }

    /// Send the request, retrying only what may be retried:
    ///
    /// * no response at all → the **same** key again (the gateway replays
    ///   the call if it ran, so this cannot double-charge);
    /// * an HTTP error that `retryable()` allows → a **new** key.
    async fn connect(&mut self) -> Result<(), Error> {
        let url = format!("{}/chat", self.client.inner.config.ai_base);
        let header_timeout = self.client.inner.config.request_timeout;
        let mut transport_left = self.options.transport_retries;
        loop {
            if self.cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let key = self.key.clone();
            let body = self.body.clone();
            let sent = tokio::time::timeout(
                header_timeout,
                self.client
                    .send_authorized_in(&mut self.session, |http, token| {
                        http.post(&url)
                            .bearer_auth(token)
                            .header("Idempotency-Key", &key)
                            .header(reqwest::header::ACCEPT, "text/event-stream")
                            .header(reqwest::header::CONTENT_TYPE, "application/json")
                            .body(body.clone())
                    }),
            )
            .await
            .unwrap_or_else(|_| {
                Err(Error::Transport(TransportError::timeout(
                    "no response headers from the gateway",
                )))
            });
            let response = match sent {
                Err(Error::Transport(_)) if transport_left > 0 => {
                    transport_left = transport_left.saturating_sub(1);
                    self.pause(backoff(self.options.retry_base_delay, self.attempt))
                        .await?;
                    self.attempt = self.attempt.saturating_add(1);
                    continue;
                }
                other => other?,
            };
            if let Some(id) = http::header_string(response.headers(), "x-f2z-call-id") {
                self.call_id = Some(id);
            }
            if response.status().is_success() {
                let content_type = http::header_string(response.headers(), "content-type")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if content_type.starts_with("text/event-stream") {
                    self.response = Some(response);
                    return Ok(());
                }
                if content_type.starts_with("application/json") {
                    // An idempotent replay of a finished call: its record,
                    // no content (§2.5). Branch on Content-Type, not on what
                    // was asked for.
                    let record: CallRecord =
                        bounded(header_timeout, http::read_json(response)).await??;
                    return Err(Error::Replayed(Box::new(record)));
                }
                return Err(Error::Protocol(format!(
                    "unexpected content type {content_type:?}"
                )));
            }
            // The body of a refusal is bounded too: headers followed by a
            // stalled body must not hang a call nobody can cancel yet.
            let error = bounded(header_timeout, http::read_error(response)).await?;
            if error.retryable() && self.retries_left > 0 {
                self.retries_left = self.retries_left.saturating_sub(1);
                let wait = error
                    .retry_after
                    .unwrap_or_else(|| backoff(self.options.retry_base_delay, self.attempt));
                self.attempt = self.attempt.saturating_add(1);
                self.pause(wait).await?;
                // A retry of a failed call is a NEW call: a new key.
                self.key = random::uuid_v4()?;
                self.call_id = None;
                continue;
            }
            return Err(Error::Api(Box::new(error)));
        }
    }

    fn finish(&mut self) {
        self.finished = true;
        // Dropping the response closes the connection.
        self.response = None;
        self.queue.clear();
    }

    fn interrupted(&mut self) -> Error {
        self.finish();
        Error::StreamInterrupted {
            call_id: self.call_id.clone(),
        }
    }

    /// The next event, or `None` after the terminal event.
    ///
    /// # Errors
    ///
    /// [`Error::StreamInterrupted`] when the connection ended (or went
    /// silent for [`crate::Config::stream_idle_timeout`]) without a terminal
    /// event; [`Error::Cancelled`] after [`CancelHandle::cancel`];
    /// [`Error::Protocol`] for an event whose payload does not decode. Each
    /// ends the stream.
    pub async fn next(&mut self) -> Result<Option<Event>, Error> {
        loop {
            if self.finished {
                return Ok(None);
            }
            if self.cancel.is_cancelled() {
                self.finish();
                return Err(Error::Cancelled);
            }
            if let Some(frame) = self.queue.pop_front() {
                let event = match Event::from_sse(&frame.event, &frame.data) {
                    Ok(event) => event,
                    // New event kinds are additive: skip what we do not know.
                    Err(EventError::UnknownEvent(_)) => continue,
                    Err(e) => {
                        self.finish();
                        return Err(Error::Protocol(format!(
                            "event {:?} (call {:?}): {e}",
                            frame.event, self.call_id
                        )));
                    }
                };
                if let Event::Meta(meta) = &event {
                    self.call_id = Some(meta.call_id.clone());
                }
                if let Event::Error(error) = &event
                    && !self.delivered
                    && self.retries_left > 0
                    && error.retryable()
                {
                    // A lone `error` before anything was delivered, known to
                    // have charged nothing: the call is recorded as failed,
                    // and the retry is a new call with a new key.
                    self.retries_left = self.retries_left.saturating_sub(1);
                    self.response = None;
                    self.parser = Parser::default();
                    self.queue.clear();
                    let delay = backoff(self.options.retry_base_delay, self.attempt);
                    if let Err(e) = self.pause(delay).await {
                        self.finish();
                        return Err(e);
                    }
                    self.attempt = self.attempt.saturating_add(1);
                    self.key = random::uuid_v4()?;
                    self.call_id = None;
                    if let Err(e) = self.connect().await {
                        self.finish();
                        return Err(e);
                    }
                    continue;
                }
                self.delivered = true;
                if event.is_terminal() {
                    self.finish();
                }
                return Ok(Some(event));
            }

            let Some(response) = self.response.as_mut() else {
                return Err(self.interrupted());
            };
            let cancel = Arc::clone(&self.cancel.0);
            let notified = cancel.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if cancel.cancelled.load(Ordering::SeqCst) {
                self.finish();
                return Err(Error::Cancelled);
            }
            let read = tokio::time::timeout(self.idle, response.chunk());
            tokio::select! {
                biased;
                () = &mut notified => {
                    self.finish();
                    return Err(Error::Cancelled);
                }
                result = read => match result {
                    Ok(Ok(Some(bytes))) => {
                        let mut frames = Vec::new();
                        if let Err(e) = self.parser.push(&bytes, &mut frames) {
                            self.finish();
                            return Err(e);
                        }
                        self.queue.extend(frames);
                    }
                    // EOF, a broken connection, or silence past the idle
                    // limit — all without a terminal event.
                    Ok(Ok(None) | Err(_)) | Err(_) => return Err(self.interrupted()),
                }
            }
        }
    }

    /// Read the whole stream into a [`Completion`].
    ///
    /// # Errors
    ///
    /// As [`ChatStream::next`], plus [`Error::ChatFailed`] when the stream
    /// ends in an `error` event — carrying what the failed call cost.
    pub async fn collect(mut self) -> Result<Completion, Error> {
        let mut meta = None;
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        let mut usage = None;
        while let Some(event) = self.next().await? {
            match event {
                Event::Meta(m) => meta = Some(m),
                Event::Delta(d) => text.push_str(&d.text),
                Event::ToolCall(t) => tool_calls.push(t),
                Event::Usage(u) => usage = Some(u),
                Event::Done(done) => {
                    let charge = Charge::from(done.outcome());
                    return Ok(Completion {
                        call_id: meta
                            .as_ref()
                            .map(|m: &Meta| m.call_id.clone())
                            .or_else(|| self.call_id.clone()),
                        meta,
                        text,
                        tool_calls,
                        usage,
                        charge,
                        done,
                    });
                }
                Event::Error(error) => {
                    let charge = Charge::from(error.outcome());
                    return Err(Error::ChatFailed(Box::new(ChatFailure {
                        call_id: self.call_id.clone(),
                        charge,
                        error,
                        partial_text: text,
                    })));
                }
                _ => {}
            }
        }
        Err(self.interrupted())
    }
}

/// A finished, successful call: everything the stream delivered.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct Completion {
    /// The call.
    pub call_id: Option<String>,
    /// The `meta` event.
    pub meta: Option<Meta>,
    /// Every `delta`, concatenated.
    pub text: String,
    /// Every `tool_call`, in order.
    pub tool_calls: Vec<ToolCall>,
    /// The `usage` event.
    pub usage: Option<UsageEvent>,
    /// What it cost, from `done.outcome()`. [`Charge::NotFinal`] under
    /// `settlement: "pending"`: read the record until it is terminal.
    pub charge: Charge,
    /// The `done` event.
    pub done: Done,
}

impl ChatFailure {
    /// Whether an app may retry this failure automatically (with a new
    /// call): `ErrorEvent::retryable()` — never for a charged, partial or
    /// not-final failure.
    #[must_use]
    pub fn retryable(&self) -> bool {
        self.error.retryable()
    }
}
