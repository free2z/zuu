//! `KT.md` §9.2's endpoints, over HTTP.
//!
//! # TLS is terminated ahead of this process
//!
//! §9.2 says "plain HTTPS". This binary speaks HTTP/1.1 and expects an ingress
//! — a reverse proxy, a service mesh sidecar, a load balancer — to terminate
//! TLS in front of it. That is not a shortcut: a log's certificate lifecycle,
//! its ALPN and cipher policy, and its renewal automation belong to the
//! deployment, and a server binary that owned them would be a second, weaker
//! copy of infrastructure the operator already runs. **Bind it to loopback or
//! to a private network and put a terminator in front.** The default `listen`
//! is `127.0.0.1:8443` for exactly that reason.
//!
//! # The handle is in the body
//!
//! `/kt/v1/lookup` and `/kt/v1/history` are `POST`. §9.2: so the queried handle
//! does not land in the log's access logs, an intermediary's logs, or a
//! `Referer`. This module holds up its end by never putting a handle in a URL,
//! **and by never writing one to the operator log on those two paths** — an
//! access-log line naming the handle would put back exactly what the method
//! choice removed. Submissions are logged with their handle, because a
//! submission is a public directory change and correlating a complaint with an
//! epoch needs it.
//!
//! # Content negotiation
//!
//! `application/octet-stream` by default; `application/json` when the request
//! asks for it. The JSON is [`crate::json`]'s container — the same
//! `tls_codec` bytes, base64url — because JSON is a container, never a
//! transcript.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use f2z_codec::Canonical as _;
use f2z_codec::decode_canonical;
use f2z_kt_core::descriptor::SignedLogDescriptor;
use f2z_kt_core::{ErrorCode, WitnessCosignature};

use crate::error::{LogError, Result};
use crate::json;
use crate::log::LogService;
use crate::policy::SignedAuthorityPolicy;
use crate::ratelimit::{Class, RateLimiter};
use crate::wire::{ErrorBody, HistoryRequest, LookupRequest};

/// Everything a handler needs.
pub struct AppState {
    /// The log.
    pub log: Arc<LogService>,
    /// The signed descriptor, `KT.md` §9.1. Signed once at startup: its only
    /// time-varying field is `published_at_ms`, and re-signing it per request
    /// would make an unauthenticated `GET` a signing oracle.
    pub descriptor: SignedLogDescriptor,
    /// The signed handle-authority policy — zuu#594's reporting requirement.
    pub policy: SignedAuthorityPolicy,
    /// Per-endpoint-class rate limits (`KT.md` §9.3).
    pub limits: RateLimiter,
    /// The clock, injected so tests can stand at an instant.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// Read a `key=value` out of a raw query string.
///
/// Hand-parsed so that neither `axum`'s `Query` nor `Path` extractor is used,
/// which keeps `serde` out of this binary's dependency graph entirely. The two
/// parameters this API takes are both integers, and an integer parser is a
/// smaller thing to review than a derive macro's expansion.
fn query_u64(uri: &Uri, key: &str) -> Option<u64> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| value.parse::<u64>().ok())?
    })
}

/// The final path segment as a `u64`, for `/kt/v1/sth/{epoch}`.
fn trailing_u64(uri: &Uri) -> Option<u64> {
    uri.path().rsplit('/').next()?.parse::<u64>().ok()
}

/// Build the router.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/.well-known/free2z-kt/v1/log", get(descriptor))
        .route("/.well-known/free2z-kt/v1/authority", get(authority_policy))
        .route("/kt/v1/sth", get(latest_sth))
        .route("/kt/v1/sth/{epoch}", get(sth_at))
        .route("/kt/v1/audit", get(audit))
        .route("/kt/v1/lookup", post(lookup))
        .route("/kt/v1/history", post(history))
        .route("/kt/v1/submit", post(submit))
        .route("/kt/v1/cosign", post(cosign))
        // Operational, not part of KT.md. Says nothing about the log's state
        // beyond "the process is answering", because a health endpoint that
        // reports epoch progress is an unauthenticated view of whether the
        // scheduler is stuck.
        .route("/healthz", get(healthz))
        .with_state(state)
}

async fn descriptor(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let bytes = match state.descriptor.encode_canonical() {
        Ok(bytes) => bytes,
        Err(_) => return internal(),
    };
    let rendered = crate::descriptor::render(&state.descriptor);
    respond(&headers, StatusCode::OK, &bytes, &rendered)
}

async fn authority_policy(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    let bytes = match state.policy.encode_canonical() {
        Ok(bytes) => bytes,
        Err(_) => return internal(),
    };
    let rendered = format!(
        "\"vouching\":{},\"authorities\":{},\"max_validity_ms\":{},\"note\":\"{}\"",
        u32::from(state.policy.policy.vouching),
        state.policy.policy.authorities.len(),
        state.policy.policy.max_validity_ms,
        if state.policy.policy.vouches() {
            "a configured authority must sign a HandleAssertion before a handle's first entry"
        } else {
            "UNVOUCHED: no authority attests who owns a handle on this log"
        }
    );
    respond(&headers, StatusCode::OK, &bytes, &rendered)
}

async fn latest_sth(headers: HeaderMap, State(state): State<Arc<AppState>>) -> Response {
    finish(&headers, state.log.latest_bundle().await)
}

async fn sth_at(headers: HeaderMap, State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let Some(epoch) = trailing_u64(&uri) else {
        return error_response(&headers, &LogError::Malformed);
    };
    finish(&headers, state.log.bundle_at(epoch).await)
}

async fn audit(headers: HeaderMap, State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let (Some(from), Some(to)) = (query_u64(&uri, "from"), query_u64(&uri, "to")) else {
        return error_response(&headers, &LogError::Malformed);
    };
    // §9.3: "It MUST be rate-limited separately from every other endpoint."
    // Separately, because an audit response is measured in megabytes and a
    // shared bucket would let one auditor starve every lookup.
    if !state.limits.allow(Class::Audit, (state.clock)()) {
        return error_response(&headers, &LogError::RateLimited);
    }
    finish(&headers, state.log.audit(from, to).await)
}

async fn lookup(headers: HeaderMap, State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if !state.limits.allow(Class::Query, (state.clock)()) {
        return error_response(&headers, &LogError::RateLimited);
    }
    if body.len() > state.log.settings().max_request_bytes {
        return error_response(&headers, &LogError::Malformed);
    }
    let request = match decode_canonical::<LookupRequest>(&body) {
        Ok(request) => request.into_value(),
        Err(_) => return error_response(&headers, &LogError::Malformed),
    };
    if let Err(error) = request.validate() {
        return error_response(&headers, &LogError::Kt(error));
    }
    // Deliberately no log line naming the handle. See the module note.
    finish(&headers, state.log.lookup(&request.handle).await)
}

async fn history(headers: HeaderMap, State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if !state.limits.allow(Class::Query, (state.clock)()) {
        return error_response(&headers, &LogError::RateLimited);
    }
    if body.len() > state.log.settings().max_request_bytes {
        return error_response(&headers, &LogError::Malformed);
    }
    let request = match decode_canonical::<HistoryRequest>(&body) {
        Ok(request) => request.into_value(),
        Err(_) => return error_response(&headers, &LogError::Malformed),
    };
    if let Err(error) = request.validate() {
        return error_response(&headers, &LogError::Kt(error));
    }
    let params = match request.params {
        1 => akd_core::verify::history::HistoryParams::MostRecent(
            usize::try_from(request.count).unwrap_or(usize::MAX),
        ),
        _ => akd_core::verify::history::HistoryParams::Complete,
    };
    finish(&headers, state.log.history(&request.handle, params).await)
}

async fn submit(headers: HeaderMap, State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if !state.limits.allow(Class::Submit, (state.clock)()) {
        return error_response(&headers, &LogError::RateLimited);
    }
    finish(&headers, state.log.submit(&body, (state.clock)()).await)
}

async fn cosign(headers: HeaderMap, State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    if !state.limits.allow(Class::Cosign, (state.clock)()) {
        return error_response(&headers, &LogError::RateLimited);
    }
    if body.len() > state.log.settings().max_request_bytes {
        return error_response(&headers, &LogError::Malformed);
    }
    let cosignature = match decode_canonical::<WitnessCosignature>(&body) {
        Ok(value) => value.into_value(),
        Err(_) => return error_response(&headers, &LogError::Malformed),
    };
    match state.log.accept_cosignature(&cosignature).await {
        // §9.2: the response is empty.
        Ok(()) => (StatusCode::NO_CONTENT, ()).into_response(),
        Err(error) => error_response(&headers, &error),
    }
}

async fn healthz() -> Response {
    (StatusCode::OK, "ok\n").into_response()
}

/// Encode a successful result, or turn its error into a §9.5 body.
fn finish<T: f2z_codec::Canonical>(headers: &HeaderMap, result: Result<T>) -> Response {
    match result {
        Ok(value) => match value.encode_canonical() {
            Ok(bytes) => respond(headers, StatusCode::OK, &bytes, ""),
            Err(_) => internal(),
        },
        Err(error) => error_response(headers, &error),
    }
}

/// Emit a body in whichever representation the caller asked for.
fn respond(headers: &HeaderMap, status: StatusCode, bytes: &[u8], rendered: &str) -> Response {
    if wants_json(headers) {
        let body = json::container(bytes, rendered);
        (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
    } else {
        (
            status,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes.to_vec(),
        )
            .into_response()
    }
}

/// Map a [`LogError`] to its `KT.md` §9.5 code and an HTTP status.
///
/// The log's own faults are logged here at `error` — with their detail, which
/// the operator needs — and answered with a body that carries the code and
/// nothing else, which is what §9.5 requires.
fn error_response(headers: &HeaderMap, error: &LogError) -> Response {
    let code = error.wire_code();
    if error.is_log_fault() {
        log::error!("{error}");
    }
    let status = http_status(code);
    let body = match ErrorBody::new(code.code()).and_then(|body| {
        body.encode_canonical()
            .map_err(|_| f2z_kt_core::KtError::Malformed)
    }) {
        Ok(bytes) => bytes,
        Err(_) => return internal(),
    };
    if wants_json(headers) {
        (
            status,
            [(header::CONTENT_TYPE, "application/json")],
            json::error_container(&body, code.code(), error.wire_detail()),
        )
            .into_response()
    } else {
        (
            status,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            body,
        )
            .into_response()
    }
}

/// The HTTP status that accompanies a §9.5 code.
///
/// The `uint16` in the body is the protocol's answer; the status is for
/// caches, proxies and `curl`. They are kept deliberately coarse — a status
/// that distinguished `ERR_COOLDOWN` from `ERR_VERSION_CONFLICT` would put
/// detail in a header that the body already carries in a checkable place.
const fn http_status(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::Malformed
        | ErrorCode::UnsupportedVersion
        | ErrorCode::BadSignature
        | ErrorCode::BadAuthorization
        | ErrorCode::VersionConflict
        | ErrorCode::Cooldown
        | ErrorCode::RangeTooWide
        | ErrorCode::NotAWitness => StatusCode::BAD_REQUEST,
        ErrorCode::EpochUnavailable => StatusCode::NOT_FOUND,
        ErrorCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
        // `ErrorCode` is `#[non_exhaustive]`: a code added to KT.md §9.5 later
        // must not silently become a 200. Internal-server-error is the safe
        // landing place until this match is updated deliberately.
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn internal() -> Response {
    log::error!("a response could not be encoded");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Vec::new(),
    )
        .into_response()
}

fn wants_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("application/json"))
}
