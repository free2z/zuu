//! `POST /v1/chat`: everything up to the backend.
//!
//! In order, each step failing as an HTTP error before any stream begins:
//!
//! 0. **Authentication and limits** ([`crate::auth`], chat-api.md §2.2 steps
//!    1–2): the bearer token, revocation (fail closed), the `ai:invoke`
//!    scope, then the per-user concurrency lease and the rate limits —
//!    before a byte of the body is read, so an unauthenticated client cannot
//!    make the gateway buffer 20 MiB. The lease is parked on the call's
//!    admission slot and released with it, after the call is settled.
//! 1. `Idempotency-Key`, if present, is 1–128 printable ASCII (chat-api.md §1).
//! 2. `Content-Type` is `application/json`.
//! 3. **Body limits** (chat-api.md §1): at most `max_body_bytes_with_images`
//!    is read at all — a `Content-Length` above it is refused before a byte of
//!    body is read — and a body above `max_body_bytes` is accepted only if it
//!    decodes to a request that actually carries an image part. Either refusal
//!    is `413 payload_too_large` with `details.limit_bytes`.
//! 4. **Decode** with `f2z_ai_proto::ChatRequest` — `deny_unknown_fields` all
//!    the way down — then the spec's structural rules ([`validate`]).
//!    `400 invalid_request` with `details.field` and `details.reason`.
//! 5. **Catalogue**: none verified and unexpired → `503 catalog_unavailable`.
//! 6. `stream: false` reserves bounded aggregation memory before provider I/O.
//! 7. The call's own detached task ([`crate::call`]) asks the [`ChatBackend`]
//!    to start it; a refusal becomes the HTTP response, a started stream is
//!    read at provider speed and delivered through a bounded buffer. This
//!    build's backend is [`NotImplemented`].
//!
//! The output clamp and the hold (chat-api.md §2.2 steps 5, 6) are the
//! metering layer's and slot in between 5 and 7.
//!
//! # Nothing here quotes the request
//!
//! A `serde_json` error message quotes the offending value — `invalid type:
//! string "<the user's prompt>", expected u64` — so it is never logged and
//! never returned. A decode failure is reported as a category, a line and a
//! column; a validation failure as a JSON path built from field names and
//! indices, never from content.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::chat::{ChatRequest, ContentPart, Role};
use http_body_util::BodyExt as _;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

use crate::admission::CallHandle;
use crate::auth::Gatekeeper;
use crate::call::{self, Upstream};
use crate::catalog::{self, VerifiedCatalog};
use crate::error::ApiFailure;
use crate::features::{Logged, RequestFeatures};
use crate::metrics::Rejection;
use crate::serve::ConnectionKill;

/// The image media types chat-api.md §2.1 accepts.
pub const IMAGE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/// At most this many image parts per request (chat-api.md §2.1).
pub const MAX_IMAGES: usize = 20;
/// `metadata`: at most this many keys (chat-api.md §2.1).
pub const MAX_METADATA_KEYS: usize = 16;
/// `metadata`: key length limit, in characters.
pub const MAX_METADATA_KEY_CHARS: usize = 64;
/// `metadata`: value length limit, in characters.
pub const MAX_METADATA_VALUE_CHARS: usize = 256;
/// `Idempotency-Key`: length limit.
pub const MAX_IDEMPOTENCY_KEY: usize = 128;

/// Upload-specific admission, separate from billable call concurrency.
#[derive(Default)]
pub struct UploadLimits(std::sync::Mutex<std::collections::HashMap<UploadKey, usize>>);

#[derive(Clone, PartialEq, Eq, Hash)]
enum UploadKey {
    Peer(std::net::IpAddr),
    User(String),
}

struct UploadLease {
    limits: Arc<UploadLimits>,
    key: UploadKey,
}

impl UploadLimits {
    fn acquire(self: &Arc<Self>, key: UploadKey, limit: usize) -> Result<UploadLease, ApiFailure> {
        let mut counts = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let count = counts.entry(key.clone()).or_default();
        if *count >= limit {
            return Err(ApiFailure::new(
                ErrorCode::Unavailable,
                "too many uploads from this caller",
            )
            .retry_after(1));
        }
        *count = count.saturating_add(1);
        Ok(UploadLease {
            limits: Arc::clone(self),
            key,
        })
    }
}

impl Drop for UploadLease {
    fn drop(&mut self) {
        let mut counts = self
            .limits
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = counts.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

/// What starts a valid, admitted call.
///
/// The seam Wave 2's provider adapters implement: authenticate the provider
/// request, take the hold, send the request, and return the provider's stream
/// as an [`Upstream`]. A refusal before any stream is an [`ApiFailure`] and
/// becomes the HTTP response.
///
/// **The settler is the single owner of releasing a hold.** Every call that
/// reaches `start` is handed to the settler exactly once — a `start` that
/// fails, times out or is cancelled by a drain as
/// [`crate::settle::UpstreamEnd::NotStarted`] — so a backend must **not**
/// release a hold it took itself; doing so would release it twice. A backend
/// that took a hold must make it discoverable to the settler (Wave 2: the
/// hold is keyed on the call's idempotency, metering.md §3).
///
/// `start` runs on the call's own detached task, bounded by the request
/// timeout and abortable by a drain — never on the request's future, so a
/// client hanging up mid-start does not cancel it half way.
#[async_trait]
pub trait ChatBackend: Send + Sync + 'static {
    /// Authenticated, markup-aware catalogue projection.
    async fn models(
        &self,
        _catalog: Arc<VerifiedCatalog>,
        _principal: &crate::auth::Principal,
    ) -> Result<serde_json::Value, ApiFailure> {
        Err(ApiFailure::not_implemented())
    }
    /// Same admission and clamp as chat, without creating a call or hold.
    async fn estimate(
        &self,
        _request: ChatRequest,
        _catalog: Arc<VerifiedCatalog>,
        _principal: &crate::auth::Principal,
    ) -> Result<serde_json::Value, ApiFailure> {
        Err(ApiFailure::not_implemented())
    }
    /// Account/app-scoped durable receipt lookup.
    async fn receipt(
        &self,
        _id: &str,
        _principal: &crate::auth::Principal,
    ) -> Result<serde_json::Value, ApiFailure> {
        Err(ApiFailure::not_implemented())
    }

    /// Start `request`, priced against `catalog`.
    ///
    /// # Errors
    ///
    /// An [`ApiFailure`] to answer with instead of a stream.
    async fn start(
        &self,
        request: ChatRequest,
        catalog: Arc<VerifiedCatalog>,
        call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure>;
}

/// This build's backend: every valid request is `501 not_implemented`.
#[derive(Clone, Copy, Debug, Default)]
pub struct NotImplemented;

#[async_trait]
impl ChatBackend for NotImplemented {
    async fn start(
        &self,
        _request: ChatRequest,
        _catalog: Arc<VerifiedCatalog>,
        _call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        Err(ApiFailure::not_implemented())
    }
}

/// What the handler needs.
#[derive(Clone)]
pub struct ChatState {
    /// Authentication and limits.
    pub gate: Arc<dyn Gatekeeper>,
    /// The backend.
    pub backend: Arc<dyn ChatBackend>,
    /// The catalogue in use.
    pub catalog: Arc<catalog::State>,
    /// Body limit without images.
    pub max_body_bytes: usize,
    /// Body limit with images; the hard cap.
    pub max_body_bytes_with_images: usize,
    /// How long the body may take to arrive.
    pub body_read_timeout: Duration,
    /// Where the upload-budget refusal is counted.
    pub metrics: Option<Arc<crate::metrics::Metrics>>,
    /// The gateway-wide budget, in bytes, for request bodies being read.
    pub upload_budget: Arc<Semaphore>,
    /// Per-peer pre-authentication and per-user upload admission.
    pub upload_limits: Arc<UploadLimits>,
    /// Pending authentication checks allowed per transport peer IP.
    pub max_pre_auth_uploads_per_peer: usize,
    /// `Retry-After` for a refusal on the upload budget.
    pub retry_after_secs: u32,
    /// How long a backend may take to start a call.
    pub start_timeout: Duration,
    /// Undelivered event bytes a stream may buffer.
    pub delivery_buffer_bytes: usize,
    /// Time with frames waiting and none delivered before delivery ends.
    pub delivery_stall: Duration,
    /// Upstream silence after which a streamed call sends `: ping`
    /// (chat-api.md §3); `None` sends none.
    pub stream_keepalive: Option<Duration>,
}

/// The handler.
///
/// Once the body has decoded and validated, the response carries a
/// [`Logged`] extension — the request's content-free [`RequestFeatures`] and
/// the call id once one is known — which the `response` log line reads
/// (`crate::server`'s observe layer). It never reaches the client.
pub async fn handle(State(state): State<ChatState>, request: Request) -> Response {
    let mut logged = None;
    let handle = request.extensions().get::<CallHandle>().cloned();
    let (mut response, failed_call) = match serve(&state, request, &mut logged).await {
        Ok(response) => (response, None),
        Err(failure) => {
            let call = failure
                .detail_of("call_id")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| id.parse::<uuid::Uuid>().ok());
            (failure.into_response(), call)
        }
    };
    if let Some(mut logged) = logged {
        logged.call_id = logged.call_id.or(failed_call).or_else(|| {
            response
                .headers()
                .get("x-f2z-call-id")
                .and_then(|v| v.to_str().ok())
                .and_then(|id| id.parse().ok())
        });
        // A refusal after the claim (e.g. response_format_unsupported) may
        // carry no call id in its body; the backend recorded it here.
        logged.call_id = logged
            .call_id
            .or_else(|| handle.as_ref().and_then(CallHandle::durable_call_id));
        response.extensions_mut().insert(logged);
    }
    response
}

/// Small authenticated GET routes use the same peer admission bound as chat.
pub async fn read_handle(State(state): State<ChatState>, request: Request) -> Response {
    async fn read(state: &ChatState, request: Request) -> Result<Response, ApiFailure> {
        let peer = request
            .extensions()
            .get::<std::net::SocketAddr>()
            .ok_or_else(|| ApiFailure::new(ErrorCode::Internal, "missing transport peer"))?;
        let permit = state.upload_limits.acquire(
            UploadKey::Peer(peer.ip()),
            state.max_pre_auth_uploads_per_peer,
        )?;
        let admitted = state.gate.admit(request.headers()).await?;
        drop(permit);
        let value = if request.uri().path() == "/v1/models" {
            let catalog = state.catalog.current(catalog::now_unix()).ok_or_else(|| {
                ApiFailure::new(ErrorCode::CatalogUnavailable, "no verified catalogue")
            })?;
            state.backend.models(catalog, &admitted.principal).await?
        } else {
            let id = request
                .uri()
                .path()
                .strip_prefix("/v1/calls/")
                .ok_or_else(ApiFailure::not_found)?;
            state.backend.receipt(id, &admitted.principal).await?
        };
        if request.uri().path() == "/v1/models" {
            let bytes = serde_json::to_vec(&value)
                .map_err(|_| ApiFailure::new(ErrorCode::Internal, "catalogue projection failed"))?;
            let hash = ring::digest::digest(&ring::digest::SHA256, &bytes)
                .as_ref()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let etag = format!("\"{hash}\"");
            let mut response = if request
                .headers()
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
                == Some(etag.as_str())
            {
                axum::http::StatusCode::NOT_MODIFIED.into_response()
            } else {
                axum::Json(value).into_response()
            };
            if let Ok(value) = HeaderValue::from_str(&etag) {
                response.headers_mut().insert(header::ETAG, value);
            }
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=60"),
            );
            response
                .headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Authorization"));
            return Ok(response);
        }
        let mut response = axum::Json(value).into_response();
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        Ok(response)
    }
    read(&state, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn serve(
    state: &ChatState,
    request: Request,
    logged: &mut Option<Logged>,
) -> Result<Response, ApiFailure> {
    let estimating = request.uri().path() == "/v1/chat/estimate";
    let (parts, body) = request.into_parts();
    let Some(call) = parts.extensions.get::<CallHandle>().cloned() else {
        // Only reachable if the router is assembled without admission, which
        // is a wiring bug and must not silently bypass the limits.
        return Err(ApiFailure::new(
            ErrorCode::Internal,
            "request reached /v1/chat without admission",
        ));
    };
    let peer = parts
        .extensions
        .get::<std::net::SocketAddr>()
        .ok_or_else(|| ApiFailure::new(ErrorCode::Internal, "request has no transport peer"))?;
    let preauth = state.upload_limits.acquire(
        UploadKey::Peer(peer.ip()),
        state.max_pre_auth_uploads_per_peer,
    )?;
    let admitted = state.gate.admit(&parts.headers).await?;
    drop(preauth);
    let upload_lease = state
        .upload_limits
        .acquire(UploadKey::User(admitted.principal.sub.clone()), 2)?;
    if let Some(lease) = admitted.lease
        && !call.attach_lease(lease)
    {
        return Err(ApiFailure::new(
            ErrorCode::Internal,
            "the call's concurrency slot was already taken",
        ));
    }
    call.set_principal(admitted.principal);
    check_headers(&parts.headers)?;
    if let Some(key) = parts
        .headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
    {
        call.set_idempotency_key(key.to_owned());
    }
    let (bytes, mut upload) = read_body(state, &parts.headers, body).await?;
    let nodes = json_complexity(&bytes).map_err(|error| {
        if bytes.len() > state.max_body_bytes {
            too_large(state.max_body_bytes)
        } else {
            error
        }
    })?;
    // Keep raw bytes plus conservative space for decoded strings, serde's
    // scratch copies, and small collection nodes alive through backend start.
    let extra = bytes
        .len()
        .saturating_mul(3)
        .saturating_add(nodes.saturating_mul(512));
    let extra = u32::try_from(extra).map_err(|_| too_large(state.max_body_bytes_with_images))?;
    let decoded = Arc::clone(&state.upload_budget)
        .try_acquire_many_owned(extra)
        .map_err(|_| {
            if let Some(metrics) = &state.metrics {
                metrics.record_rejection(Rejection::UploadBudget);
            }
            ApiFailure::new(
                ErrorCode::Unavailable,
                "this gateway instance is at its decoded-request memory budget",
            )
            .retry_after(state.retry_after_secs)
        })?;
    upload.merge(decoded);
    let request = decode(&bytes, state.max_body_bytes)?;
    validate(&request)?;
    *logged = Some(Logged {
        features: RequestFeatures::of(&request),
        call_id: None,
    });
    drop(upload_lease);
    // The raw bytes are no longer needed, but the decoded request is about
    // as large and lives on into the backend's `start`: the reservation goes
    // with it and is released only once `start` has returned (`call::run`).
    let body_bytes = bytes.len();
    drop(bytes);

    let Some(catalog) = state.catalog.current(catalog::now_unix()) else {
        return Err(ApiFailure::new(
            ErrorCode::CatalogUnavailable,
            "no verified, unexpired catalogue is loaded; the gateway will not price blind",
        ));
    };

    if estimating {
        let principal = call
            .principal()
            .ok_or_else(|| ApiFailure::new(ErrorCode::Internal, "missing principal"))?;
        return Ok(
            axum::Json(state.backend.estimate(request, catalog, principal).await?).into_response(),
        );
    }

    let aggregation = if request.stream {
        None
    } else {
        Some(crate::nonstream::Reservation::acquire(
            &state.upload_budget,
            state.delivery_buffer_bytes,
        )?)
    };
    tracing::debug!(
        call = call.id(),
        messages = request.messages.len(),
        tools = request.tools.len(),
        body_bytes,
        "chat request admitted"
    );
    let Some(slot) = call.take_slot() else {
        return Err(ApiFailure::new(
            ErrorCode::Internal,
            "the call's concurrency slot was already taken",
        ));
    };
    let response_deadline = tokio::time::Instant::from_std(call.started())
        .checked_add(state.start_timeout)
        .unwrap_or_else(tokio::time::Instant::now);
    let (head, body) = oneshot::channel();
    tokio::spawn(call::run(
        call::Start {
            backend: Arc::clone(&state.backend),
            request,
            catalog,
            call,
            slot,
            kill: parts.extensions.get::<ConnectionKill>().cloned(),
            upload,
            limits: call::Limits {
                buffer_bytes: state.delivery_buffer_bytes,
                stall: state.delivery_stall,
                start_timeout: state.start_timeout,
                // Streamed only: a non-streamed body is one JSON document.
                keepalive: state.stream_keepalive.filter(|_| aggregation.is_none()),
            },
        },
        head,
    ));
    match body.await {
        Ok(Ok(mut body)) => {
            if let Some(record) = body.replay.take() {
                if let Some(logged) = logged.as_mut() {
                    logged.call_id = record
                        .get("call_id")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|id| id.parse().ok());
                }
                let mut response = axum::Json(record).into_response();
                response
                    .headers_mut()
                    .insert("x-f2z-replayed", HeaderValue::from_static("true"));
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                return Ok(response);
            }
            if let Some(reservation) = aggregation {
                return Ok(crate::nonstream::collect(body, reservation, response_deadline).await);
            }
            let call_id = body.call_id.clone();
            let mut response = Body::new(body).into_response();
            let headers = response.headers_mut();
            if let Some(id) = call_id.and_then(|id| HeaderValue::from_str(&id).ok()) {
                headers.insert("x-f2z-call-id", id);
            }
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            Ok(response)
        }
        Ok(Err(failure)) => Err(failure),
        Err(_) => Err(ApiFailure::new(
            ErrorCode::Internal,
            "the call's task ended without answering",
        )),
    }
}

fn invalid(field: &str, reason: &'static str, message: &'static str) -> ApiFailure {
    ApiFailure::new(ErrorCode::InvalidRequest, message)
        .detail("field", field)
        .detail("reason", reason)
}

fn check_headers(headers: &HeaderMap) -> Result<(), ApiFailure> {
    if let Some(key) = headers.get("idempotency-key") {
        let bytes = key.as_bytes();
        let printable = bytes.iter().all(|b| (0x21..=0x7e).contains(b));
        if bytes.is_empty() || bytes.len() > MAX_IDEMPOTENCY_KEY || !printable {
            return Err(invalid(
                "Idempotency-Key",
                "format",
                "Idempotency-Key must be 1-128 printable ASCII characters",
            ));
        }
    }
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(invalid(
            "Content-Type",
            "unsupported",
            "requests are application/json",
        ));
    }
    Ok(())
}

fn too_large(limit: usize) -> ApiFailure {
    ApiFailure::new(
        ErrorCode::PayloadTooLarge,
        "request body exceeds the limit: 4 MiB without image parts, 20 MiB with",
    )
    .detail("limit_bytes", limit)
}

/// Read the body within the limits, holding its share of the upload budget:
/// the declared `Content-Length`, or — for a body that declares none — the
/// hard cap, since that is what it may grow to.
///
/// The budget exists because the per-request cap alone is not a bound: 10,000
/// admitted requests each reading up to 20 MiB is ~195 GiB. A request that
/// cannot reserve its share is refused `503 unavailable` + `Retry-After`
/// before a byte of its body is read.
async fn read_body(
    state: &ChatState,
    headers: &HeaderMap,
    body: Body,
) -> Result<(Bytes, OwnedSemaphorePermit), ApiFailure> {
    let hard = state.max_body_bytes_with_images;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if let Some(declared) = declared
        && usize::try_from(declared).map_or(true, |n| n > hard)
    {
        // Refused before reading: the client is told without having to
        // upload the body first (and an `Expect: 100-continue` client never
        // sends it).
        return Err(too_large(hard));
    }
    let reserve = declared
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or_else(|| u32::try_from(hard).unwrap_or(u32::MAX));
    let Ok(upload) = Arc::clone(&state.upload_budget).try_acquire_many_owned(reserve) else {
        if let Some(metrics) = &state.metrics {
            metrics.record_rejection(Rejection::UploadBudget);
        }
        return Err(ApiFailure::new(
            ErrorCode::Unavailable,
            "this gateway instance is at its budget for request bodies in flight",
        )
        .retry_after(state.retry_after_secs));
    };
    let initial = declared
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(0)
        .min(hard);
    let collected =
        tokio::time::timeout(state.body_read_timeout, collect(body, hard, initial)).await;
    match collected {
        Ok(Ok(bytes)) => Ok((bytes, upload)),
        Ok(Err(Collect::TooLarge)) => Err(too_large(hard)),
        Ok(Err(Collect::FirstByteTimeout)) => Err(invalid(
            "body",
            "first_byte_timeout",
            "the first body byte did not arrive in time",
        )),
        Ok(Err(Collect::Failed)) => Err(invalid(
            "body",
            "read_failed",
            "the request body could not be read",
        )),
        Err(_) => Err(invalid(
            "body",
            "timeout",
            "the request body did not arrive within the body read timeout",
        )),
    }
}

enum Collect {
    TooLarge,
    Failed,
    FirstByteTimeout,
}

/// Read `body` into **one contiguous buffer** of at most `limit` bytes.
///
/// Not `BodyExt::collect`: that keeps every incoming frame as its own `Bytes`
/// (a heap descriptor each), so a body sent as one-byte chunks costs tens of
/// times its payload in memory — while the upload budget counts payload.
/// Here the memory is the payload, which is what the budget reserved.
async fn collect(mut body: Body, limit: usize, initial: usize) -> Result<Bytes, Collect> {
    let mut buffer = bytes::BytesMut::with_capacity(initial);
    let first_byte = tokio::time::Instant::now()
        .checked_add(Duration::from_secs(2))
        .ok_or(Collect::Failed)?;
    loop {
        let frame = if buffer.is_empty() {
            if tokio::time::Instant::now() >= first_byte {
                return Err(Collect::FirstByteTimeout);
            }
            tokio::time::timeout_at(first_byte, body.frame())
                .await
                .map_err(|_| Collect::FirstByteTimeout)?
        } else {
            body.frame().await
        };
        let Some(frame) = frame else {
            break;
        };
        let frame = frame.map_err(|_| Collect::Failed)?;
        if buffer.is_empty() {
            tokio::task::yield_now().await;
        }
        if let Ok(data) = frame.into_data() {
            if buffer.len().saturating_add(data.len()) > limit {
                return Err(Collect::TooLarge);
            }
            buffer.extend_from_slice(&data);
        }
    }
    Ok(buffer.freeze())
}

/// Allocation-free lexical ceiling before serde can build owned collections.
/// This is deliberately not a JSON validator; serde still checks all syntax.
/// Quotes and backslash escapes are tracked so prompt/image bytes are not
/// mistaken for structure. Counts are conservative (keys and separators count).
fn json_complexity(bytes: &[u8]) -> Result<usize, ApiFailure> {
    let mut quoted = false;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut nodes = 0usize;
    for &byte in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => {
                quoted = true;
                nodes = nodes.saturating_add(1);
            }
            b'[' | b'{' => {
                depth = depth.saturating_add(1);
                nodes = nodes.saturating_add(1);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            b' ' | b'\r' | b'\n' | b'\t' => {}
            _ => nodes = nodes.saturating_add(1),
        }
        if depth > 32 || nodes > 16_384 {
            return Err(invalid(
                "body",
                "json_complexity",
                "the request exceeds the JSON nesting or structural-token limit",
            ));
        }
    }
    Ok(nodes)
}

/// Decode `bytes`, applying the text-only limit once the presence of an
/// image part is known.
fn decode(bytes: &[u8], text_limit: usize) -> Result<ChatRequest, ApiFailure> {
    json_complexity(bytes).map_err(|error| {
        if bytes.len() > text_limit {
            too_large(text_limit)
        } else {
            error
        }
    })?;
    let over_text_limit = bytes.len() > text_limit;
    let request = match serde_json::from_slice::<ChatRequest>(bytes) {
        Ok(request) => request,
        // A body over the text limit that is not even a valid request cannot
        // have earned the image allowance.
        Err(_) if over_text_limit => return Err(too_large(text_limit)),
        Err(error) => {
            if let Some(refusal) =
                response_format_refusal(bytes).or_else(|| tool_option_refusal(bytes))
            {
                return Err(refusal);
            }
            let reason = match error.classify() {
                serde_json::error::Category::Syntax => "syntax",
                serde_json::error::Category::Eof => "eof",
                serde_json::error::Category::Data | serde_json::error::Category::Io => "schema",
            };
            // Category, line and column. Never `error.to_string()`: it quotes
            // the request's own content.
            return Err(ApiFailure::new(
                ErrorCode::InvalidRequest,
                "the request body is not a valid /v1/chat request; see details for where",
            )
            .detail("reason", reason)
            .detail("line", error.line())
            .detail("column", error.column()));
        }
    };
    if over_text_limit && image_count(&request) == 0 {
        return Err(too_large(text_limit));
    }
    Ok(request)
}

/// A body that failed to decode because of an unknown `response_format.type`
/// gets a refusal that names the field, not just a line and column: it is
/// the one mistake an integrator porting an OpenAI call (`"type": "text"`)
/// is likely to make. Error path only; the body already passed
/// [`json_complexity`] and the size limits. Never quotes the request.
fn response_format_refusal(bytes: &[u8]) -> Option<ApiFailure> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let format = value.get("response_format")?;
    if format.is_null() {
        return Some(invalid(
            "response_format",
            "null",
            "response_format must be an object; omit it for an unconstrained reply",
        ));
    }
    match format.get("type").and_then(serde_json::Value::as_str) {
        Some("json_schema" | "json_object") => None,
        _ => Some(invalid(
            "response_format.type",
            "unsupported",
            "response_format.type must be \"json_schema\" or \"json_object\"",
        )),
    }
}

/// As [`response_format_refusal`], for the tool controls an integrator
/// porting from another API is likely to get wrong: a `tool_choice` that is
/// not one of OpenAI's four shapes (Anthropic's `"any"`, `{"type":"tool"}`),
/// a `null` control, and a tool `strict` that is not a boolean. Error path
/// only; never quotes the request.
fn tool_option_refusal(bytes: &[u8]) -> Option<ApiFailure> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if let Some(choice) = value.get("tool_choice")
        && serde_json::from_value::<f2z_ai_proto::chat::ToolChoice>(choice.clone()).is_err()
    {
        return Some(invalid(
            "tool_choice",
            if choice.is_null() {
                "null"
            } else {
                "unsupported"
            },
            "tool_choice must be \"auto\", \"none\", \"required\" or {\"type\":\"function\",\"function\":{\"name\":...}}",
        ));
    }
    if let Some(parallel) = value.get("parallel_tool_calls")
        && !parallel.is_boolean()
    {
        return Some(invalid(
            "parallel_tool_calls",
            if parallel.is_null() {
                "null"
            } else {
                "not_boolean"
            },
            "parallel_tool_calls must be true or false",
        ));
    }
    let tools = value.get("tools")?.as_array()?;
    for (index, tool) in tools.iter().enumerate() {
        if let Some(strict) = tool.get("strict")
            && !strict.is_boolean()
        {
            return Some(invalid(
                &format!("tools[{index}].strict"),
                if strict.is_null() {
                    "null"
                } else {
                    "not_boolean"
                },
                "a tool's strict must be true or false",
            ));
        }
    }
    None
}

fn image_count(request: &ChatRequest) -> usize {
    request
        .messages
        .iter()
        .flat_map(|m| &m.content)
        .filter(|p| matches!(p, ContentPart::Image { .. }))
        .count()
}

/// Standard base64 (RFC 4648 §4), padded, checked without decoding.
fn is_standard_base64(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len().checked_rem(4) != Some(0) {
        return false;
    }
    let body = data.trim_end_matches('=');
    let padding = bytes.len().saturating_sub(body.len());
    padding <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// chat-api.md §2.1's structural rules — the ones that do not need the
/// catalogue. (A model's existence, its vision capability and its output cap
/// do, and are Wave 2.)
///
/// # Errors
///
/// `400 invalid_request` naming the field by path.
pub fn validate(request: &ChatRequest) -> Result<(), ApiFailure> {
    if request.model.is_empty() {
        return Err(invalid("model", "empty", "model is required"));
    }
    if request.messages.is_empty() {
        return Err(invalid(
            "messages",
            "empty",
            "messages must contain at least one message",
        ));
    }
    let mut images = 0usize;
    for (index, message) in request.messages.iter().enumerate() {
        let at = |field: &str| format!("messages[{index}].{field}");
        if message.role == Role::System && index != 0 {
            return Err(invalid(
                &at("role"),
                "system_not_first",
                "at most one system message, and only as the first message",
            ));
        }
        match message.role {
            Role::Tool if message.tool_call_id.is_none() => {
                return Err(invalid(
                    &at("tool_call_id"),
                    "required",
                    "a tool message requires tool_call_id",
                ));
            }
            Role::Tool => {}
            _ if message.tool_call_id.is_some() => {
                return Err(invalid(
                    &at("tool_call_id"),
                    "unexpected",
                    "tool_call_id is only valid on a tool message",
                ));
            }
            _ => {}
        }
        if !message.tool_calls.is_empty() && message.role != Role::Assistant {
            return Err(invalid(
                &at("tool_calls"),
                "unexpected",
                "tool_calls is only valid on an assistant message",
            ));
        }
        for (part_index, part) in message.content.iter().enumerate() {
            if let ContentPart::Image { media_type, data } = part {
                images = images.saturating_add(1);
                let field = format!("messages[{index}].content[{part_index}]");
                if !IMAGE_MEDIA_TYPES.contains(&media_type.as_str()) {
                    return Err(invalid(
                        &format!("{field}.media_type"),
                        "unsupported",
                        "image media_type must be image/png, image/jpeg, image/webp or image/gif",
                    ));
                }
                if !is_standard_base64(data) {
                    return Err(invalid(
                        &format!("{field}.data"),
                        "not_base64",
                        "image data must be standard, padded base64",
                    ));
                }
            }
        }
    }
    if images > MAX_IMAGES {
        return Err(invalid(
            "messages",
            "too_many_images",
            "at most 20 image parts per request",
        ));
    }
    request
        .check_tools()
        .map_err(|e| invalid(&e.field, e.reason, e.message))?;
    if request.max_output_tokens == Some(0) {
        return Err(invalid(
            "max_output_tokens",
            "out_of_range",
            "max_output_tokens must be at least 1",
        ));
    }
    if request.max_output_tokens_strict && request.max_output_tokens.is_none() {
        return Err(invalid(
            "max_output_tokens",
            "required",
            "max_output_tokens_strict requires max_output_tokens",
        ));
    }
    if let Some(format) = &request.response_format {
        format
            .check()
            .map_err(|e| invalid(e.field, e.reason, e.message))?;
    }
    if request.fallback.iter().any(String::is_empty) {
        return Err(invalid("fallback", "empty", "a fallback model id is empty"));
    }
    if request.metadata.len() > MAX_METADATA_KEYS {
        return Err(invalid(
            "metadata",
            "too_many_keys",
            "metadata has at most 16 keys",
        ));
    }
    for (key, value) in &request.metadata {
        if key.chars().count() > MAX_METADATA_KEY_CHARS
            || value.chars().count() > MAX_METADATA_VALUE_CHARS
        {
            return Err(invalid(
                "metadata",
                "too_long",
                "metadata keys are at most 64 characters and values at most 256",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(value: serde_json::Value) -> ChatRequest {
        serde_json::from_value(value).unwrap()
    }

    fn minimal() -> serde_json::Value {
        json!({"model": "m", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]})
    }

    fn reason(failure: &ApiFailure) -> String {
        let response = failure.clone().into_response();
        assert_eq!(response.status().as_u16(), 400);
        format!("{failure:?}")
    }

    #[test]
    fn the_minimal_request_is_valid() {
        validate(&request(minimal())).unwrap();
    }

    #[test]
    fn structural_rules_name_the_field_by_path() {
        let cases = [
            (json!({"model": "", "messages": []}), "model"),
            (json!({"model": "m", "messages": []}), "messages"),
            (
                json!({"model": "m", "messages": [
                    {"role": "user", "content": []},
                    {"role": "system", "content": []}]}),
                "messages[1].role",
            ),
            (
                json!({"model": "m", "messages": [{"role": "tool", "content": []}]}),
                "messages[0].tool_call_id",
            ),
            (
                json!({"model": "m", "messages": [{"role": "user", "tool_call_id": "x", "content": []}]}),
                "messages[0].tool_call_id",
            ),
            (
                json!({"model": "m", "messages": [{"role": "user", "content": [
                    {"type": "image", "media_type": "image/tiff", "data": "AAAA"}]}]}),
                "messages[0].content[0].media_type",
            ),
            (
                json!({"model": "m", "messages": [{"role": "user", "content": [
                    {"type": "image", "media_type": "image/png", "data": "not base64!"}]}]}),
                "messages[0].content[0].data",
            ),
            (
                json!({"model": "m", "max_output_tokens": 0, "messages": [{"role": "user", "content": []}]}),
                "max_output_tokens",
            ),
            (
                json!({"model": "m", "tools": [{"name": "f", "parameters": []}], "messages": [{"role": "user", "content": []}]}),
                "tools[0].parameters",
            ),
            (
                json!({"model": "m", "max_output_tokens_strict": true, "messages": [{"role": "user", "content": []}]}),
                "max_output_tokens",
            ),
            (
                json!({"model": "m", "response_format": {"type": "json_schema", "json_schema": {"name": "bad name", "schema": {}}}, "messages": [{"role": "user", "content": []}]}),
                "response_format.json_schema.name",
            ),
            (
                json!({"model": "m", "response_format": {"type": "json_schema", "json_schema": {"name": "n", "schema": "{}"}}, "messages": [{"role": "user", "content": []}]}),
                "response_format.json_schema.schema",
            ),
        ];
        for (value, field) in cases {
            let failure = validate(&request(value)).unwrap_err();
            let rendered = reason(&failure);
            assert!(
                rendered.contains(&format!("\"{field}\"")),
                "{field}: {rendered}"
            );
        }
    }

    #[test]
    fn tool_controls_are_named_when_malformed_and_need_tools() {
        let tools = json!([{"name": "lookup", "parameters": {"type": "object"}}]);
        // Decode: an OpenAI port's mistakes, named by field, never quoted.
        for (member, value, reason) in [
            ("tool_choice", json!("any"), "unsupported"),
            (
                "tool_choice",
                json!({"type": "tool", "name": "CANARY"}),
                "unsupported",
            ),
            ("tool_choice", serde_json::Value::Null, "null"),
            ("parallel_tool_calls", serde_json::Value::Null, "null"),
            ("parallel_tool_calls", json!("false"), "not_boolean"),
        ] {
            let mut body = minimal();
            body["tools"] = tools.clone();
            body[member] = value.clone();
            let failure = decode(body.to_string().as_bytes(), 1 << 20).unwrap_err();
            assert_eq!(failure.detail_of("field"), Some(&json!(member)), "{value}");
            assert_eq!(failure.detail_of("reason"), Some(&json!(reason)), "{value}");
            assert!(!reason_of(&failure).contains("CANARY"));
        }
        // Validate: a tool control needs tools, and a named function must be
        // one of them.
        for (extra, field, why) in [
            (
                json!({"tool_choice": "auto"}),
                "tool_choice",
                "requires_tools",
            ),
            (
                json!({"parallel_tool_calls": false}),
                "parallel_tool_calls",
                "requires_tools",
            ),
            (
                json!({"tools": tools, "tool_choice": {"type": "function", "function": {"name": "other"}}}),
                "tool_choice.function.name",
                "unknown_tool",
            ),
        ] {
            let mut body = minimal();
            for (key, value) in extra.as_object().unwrap() {
                body[key] = value.clone();
            }
            let failure = validate(&request(body)).unwrap_err();
            assert_eq!(failure.detail_of("field"), Some(&json!(field)));
            assert_eq!(failure.detail_of("reason"), Some(&json!(why)));
        }
        // Negative control: every well-formed control validates with tools.
        for choice in [
            json!("auto"),
            json!("none"),
            json!("required"),
            json!({"type": "function", "function": {"name": "lookup"}}),
        ] {
            let mut body = minimal();
            body["tools"] = tools.clone();
            body["tool_choice"] = choice;
            body["parallel_tool_calls"] = json!(false);
            validate(&decode(body.to_string().as_bytes(), 1 << 20).unwrap()).unwrap();
        }
    }

    fn reason_of(failure: &ApiFailure) -> String {
        format!("{failure:?}")
    }

    #[test]
    fn an_unknown_response_format_type_is_named_not_located() {
        for format in [
            json!({"type": "text"}),
            json!({"type": "xml", "json_schema": {}}),
            json!({"json_schema": {"name": "n", "schema": {}}}),
            json!("json_object"),
        ] {
            let mut body = minimal();
            body["response_format"] = format.clone();
            let failure = decode(body.to_string().as_bytes(), 1 << 20).unwrap_err();
            let rendered = reason(&failure);
            assert!(
                rendered.contains("\"response_format.type\"") && rendered.contains("unsupported"),
                "{format}: {rendered}"
            );
        }
        // A present null is refused by name, never read as absent.
        let mut body = minimal();
        body["response_format"] = serde_json::Value::Null;
        let failure = decode(body.to_string().as_bytes(), 1 << 20).unwrap_err();
        assert_eq!(failure.detail_of("field"), Some(&json!("response_format")));
        assert_eq!(failure.detail_of("reason"), Some(&json!("null")));
        // A known type with a bad member keeps the generic schema refusal
        // (and still never quotes the request).
        let mut body = minimal();
        body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "n", "schema": {}, "x": "CANARY"}});
        let rendered = reason(&decode(body.to_string().as_bytes(), 1 << 20).unwrap_err());
        assert!(
            rendered.contains("schema") && !rendered.contains("CANARY"),
            "{rendered}"
        );
        // And both known types decode and validate.
        for format in [
            json!({"type": "json_object"}),
            json!({"type": "json_schema", "json_schema": {"name": "activity_spec", "schema": {"type": "object"}, "strict": true}}),
        ] {
            let mut body = minimal();
            body["response_format"] = format;
            validate(&decode(body.to_string().as_bytes(), 1 << 20).unwrap()).unwrap();
        }
    }

    #[test]
    fn a_tool_control_from_another_api_is_named_not_located() {
        let with_tool = || {
            let mut body = minimal();
            body["tools"] = json!([{"name": "check_answer", "parameters": {"type": "object"}}]);
            body
        };
        for (member, value, field, why) in [
            ("tool_choice", json!("any"), "tool_choice", "unsupported"),
            (
                "tool_choice",
                json!({"type": "tool", "name": "check_answer"}),
                "tool_choice",
                "unsupported",
            ),
            (
                "tool_choice",
                json!({"type": "function", "name": "check_answer"}),
                "tool_choice",
                "unsupported",
            ),
            (
                "tool_choice",
                serde_json::Value::Null,
                "tool_choice",
                "null",
            ),
            (
                "parallel_tool_calls",
                serde_json::Value::Null,
                "parallel_tool_calls",
                "null",
            ),
            (
                "parallel_tool_calls",
                json!("false"),
                "parallel_tool_calls",
                "not_boolean",
            ),
        ] {
            let mut body = with_tool();
            body[member] = value.clone();
            let failure = decode(body.to_string().as_bytes(), 1 << 20).unwrap_err();
            assert_eq!(failure.detail_of("field"), Some(&json!(field)), "{value}");
            assert_eq!(failure.detail_of("reason"), Some(&json!(why)), "{value}");
        }
        let mut body = with_tool();
        body["tools"][0]["strict"] = serde_json::Value::Null;
        let failure = decode(body.to_string().as_bytes(), 1 << 20).unwrap_err();
        assert_eq!(failure.detail_of("field"), Some(&json!("tools[0].strict")));
        // Every OpenAI shape decodes and validates.
        for choice in [
            json!("auto"),
            json!("none"),
            json!("required"),
            json!({"type": "function", "function": {"name": "check_answer"}}),
        ] {
            let mut body = with_tool();
            body["tool_choice"] = choice;
            body["parallel_tool_calls"] = json!(false);
            body["tools"][0]["strict"] = json!(true);
            validate(&decode(body.to_string().as_bytes(), 1 << 20).unwrap()).unwrap();
        }
    }

    #[test]
    fn tool_limits_are_refused_by_path() {
        let mut body = minimal();
        body["tool_choice"] = json!("required");
        let failure = validate(&request(body)).unwrap_err();
        assert_eq!(failure.detail_of("field"), Some(&json!("tool_choice")));
        assert_eq!(failure.detail_of("reason"), Some(&json!("requires_tools")));
        let mut body = minimal();
        body["tools"] = json!([{"name": "a b", "parameters": {}}]);
        let failure = validate(&request(body)).unwrap_err();
        assert_eq!(failure.detail_of("field"), Some(&json!("tools[0].name")));
    }

    #[test]
    fn twenty_images_pass_and_twenty_one_do_not() {
        let image = json!({"type": "image", "media_type": "image/png", "data": "AAAA"});
        let mut value = minimal();
        value["messages"][0]["content"] = serde_json::Value::Array(vec![image.clone(); 20]);
        validate(&request(value.clone())).unwrap();
        value["messages"][0]["content"] = serde_json::Value::Array(vec![image; 21]);
        assert!(validate(&request(value)).is_err());
    }

    #[test]
    fn base64_check() {
        assert!(is_standard_base64("AAAA"));
        assert!(is_standard_base64("AA=="));
        assert!(is_standard_base64("iVBORw0KGgo="));
        assert!(!is_standard_base64(""));
        assert!(!is_standard_base64("AAA"));
        assert!(!is_standard_base64("A==="));
        assert!(!is_standard_base64("AA-_"));
    }

    #[test]
    fn a_decode_error_never_quotes_the_request() {
        let canary = "CANARY-7f3a-prompt-text";
        let body = format!(
            r#"{{"model":"m","max_output_tokens":"{canary}","messages":[{{"role":"user","content":[]}}]}}"#
        );
        let failure = decode(body.as_bytes(), 1 << 20).unwrap_err();
        // The negative control: serde_json's own message does quote it.
        let raw = serde_json::from_slice::<ChatRequest>(body.as_bytes()).unwrap_err();
        assert!(raw.to_string().contains(canary), "control: {raw}");
        assert!(!format!("{failure:?}").contains(canary), "{failure:?}");
    }

    #[test]
    fn over_the_text_limit_needs_an_image_to_pass() {
        let text = minimal().to_string();
        let limit = text.len() - 1;
        let failure = decode(text.as_bytes(), limit).unwrap_err();
        assert_eq!(failure.code(), "payload_too_large");

        let mut with_image = minimal();
        with_image["messages"][0]["content"] =
            json!([{"type": "image", "media_type": "image/png", "data": "AAAA"}]);
        let body = with_image.to_string();
        decode(body.as_bytes(), 10).unwrap();

        let failure = decode(b"{not json and long", 3).unwrap_err();
        assert_eq!(failure.code(), "payload_too_large");
    }
    #[test]
    fn json_limits_ignore_escaped_prompt_delimiters_and_bound_structure() {
        let prompt = "\"\\{}[],".repeat(20_000);
        let body = serde_json::json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":prompt}]}]}).to_string();
        decode(body.as_bytes(), usize::MAX).unwrap();
        let nested = format!("{}0{}", "[".repeat(33), "]".repeat(33));
        assert!(json_complexity(nested.as_bytes()).is_err());
        let tiny = format!("[{}0]", "{},".repeat(10_000));
        assert!(json_complexity(tiny.as_bytes()).is_err());
    }

    // A separate process makes Linux's peak RSS attributable to this one
    // decode, independent of other tests and allocator high-water marks.
    #[cfg(target_os = "linux")]
    #[test]
    fn adversarial_decode_stays_below_eight_mib_extra_peak_memory() {
        const CHILD: &str = "F2Z_JSON_MEMORY_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "chat::tests::adversarial_decode_stays_below_eight_mib_extra_peak_memory",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(result.success());
            return;
        }
        fn peak_kib() -> usize {
            let status = std::fs::read_to_string("/proc/self/status").unwrap();
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse()
                .unwrap()
        }
        // Valid schema with millions of tiny strings would amplify the owned
        // Vec<String> many times before any later semantic validation.
        let mut body = String::with_capacity(20 * 1024 * 1024);
        body.push_str(r#"{"model":"m","messages":[],"fallback":["#);
        while body.len() < 20 * 1024 * 1024 - 16 {
            body.push_str("\"x\",");
        }
        body.push_str("\"x\"]}");
        let before = peak_kib();
        let result = decode(body.as_bytes(), usize::MAX);
        let after = peak_kib();
        assert!(
            after.saturating_sub(before) < 8 * 1024,
            "decode allocated over 8MiB above input: {before} -> {after} KiB"
        );
        assert!(result.is_err());
    }
    #[tokio::test]
    async fn empty_body_frames_do_not_extend_first_byte_deadline() {
        struct EmptyFrames;
        impl http_body::Body for EmptyFrames {
            type Data = Bytes;
            type Error = std::convert::Infallible;
            fn poll_frame(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
                std::task::Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::new()))))
            }
        }
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            collect(Body::new(EmptyFrames), 1024, 0),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Collect::FirstByteTimeout)));
    }
}
