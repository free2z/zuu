//! The error envelope of `docs/free2z/sdk/spec/errors.md` §1, as an axum response.
//!
//! ```json
//! {"error": {"code": "payload_too_large", "message": "…", "details": {"limit_bytes": 4194304}}}
//! ```
//!
//! `f2z_ai_proto::error::ErrorBody` carries `code` and `message` only; the
//! gateway also needs the optional `details` object the prose spec defines, so
//! the envelope is serialized here. The `code` string is always either an
//! [`ErrorCode`]'s own wire string or [`NOT_IMPLEMENTED`], and the status is
//! always [`ErrorCode::http_status`] — "status and code agree" (errors.md §7)
//! holds by construction rather than by care.

use std::borrow::Cow;

use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use f2z_ai_proto::ErrorCode;
use serde_json::{Map, Value};

/// The requested mode is unsupported in this metered preview. Deliberately
/// outside `ErrorCode`: this is not a permanent part of the v1 contract.
pub const NOT_IMPLEMENTED: &str = "not_implemented";

/// The code for a path the public listener does not serve. Outside the
/// contract for the same reason as [`NOT_IMPLEMENTED`]: errors.md's codes
/// describe requests to endpoints that exist, and none of them is a `404` for
/// "no such endpoint" (`model_not_found` is about a model). To be reconciled
/// with the prose spec (zuu#1048).
pub const NOT_FOUND: &str = "not_found";

/// A refusal: status, code, message, optional details and headers.
#[derive(Clone, Debug)]
pub struct ApiFailure {
    status: StatusCode,
    code: &'static str,
    message: Cow<'static, str>,
    details: Option<Map<String, Value>>,
    retry_after_secs: Option<u32>,
    close: bool,
    headers: Vec<(HeaderName, HeaderValue)>,
}

impl ApiFailure {
    /// A failure carrying `code`, with the status the contract assigns it.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            // `None` is a stream-only code (`delivery_aborted`), never an
            // HTTP response; `internal` is the honest fallback.
            status: code
                .http_status()
                .and_then(|s| StatusCode::from_u16(s).ok())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code: code.as_str(),
            message: message.into(),
            details: None,
            retry_after_secs: None,
            close: false,
            headers: Vec::new(),
        }
    }

    /// `501 not_implemented`: the request was valid and this build cannot
    /// serve it. See [`NOT_IMPLEMENTED`].
    #[must_use]
    pub fn not_implemented() -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: NOT_IMPLEMENTED,
            message: Cow::Borrowed(
                "the requested response mode is not implemented in this gateway preview",
            ),
            details: None,
            retry_after_secs: None,
            close: false,
            headers: Vec::new(),
        }
    }

    /// `404 not_found`: no such endpoint. See [`NOT_FOUND`].
    #[must_use]
    pub fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: NOT_FOUND,
            message: Cow::Borrowed("no such endpoint"),
            details: None,
            retry_after_secs: None,
            close: false,
            headers: Vec::new(),
        }
    }

    /// Add one `details` member.
    #[must_use]
    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details
            .get_or_insert_with(Map::new)
            .insert(key.to_owned(), value.into());
        self
    }

    /// Send `Retry-After: secs`.
    #[must_use]
    pub const fn retry_after(mut self, secs: u32) -> Self {
        self.retry_after_secs = Some(secs);
        self
    }

    /// Send `Connection: close`, so a client on a keep-alive connection
    /// reconnects — through the load balancer, to an instance that is not
    /// draining — instead of reusing this one.
    #[must_use]
    pub const fn closing(mut self) -> Self {
        self.close = true;
        self
    }

    /// Send one more response header. A value that is not a valid header
    /// value is dropped rather than sent malformed; every caller passes text
    /// it built itself from a closed set.
    #[must_use]
    pub fn header(mut self, name: HeaderName, value: &str) -> Self {
        if let Ok(value) = HeaderValue::from_str(value) {
            self.headers.push((name, value));
        }
        self
    }

    /// The `details` member `key`, if set.
    #[must_use]
    pub fn detail_of(&self, key: &str) -> Option<&Value> {
        self.details.as_ref().and_then(|d| d.get(key))
    }

    /// The HTTP status.
    #[must_use]
    pub const fn status(&self) -> StatusCode {
        self.status
    }

    /// The wire code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        let mut error = Map::new();
        error.insert("code".to_owned(), Value::from(self.code));
        error.insert("message".to_owned(), Value::from(self.message.into_owned()));
        if let Some(details) = self.details {
            error.insert("details".to_owned(), Value::Object(details));
        }
        let mut envelope = Map::new();
        envelope.insert("error".to_owned(), Value::Object(error));
        let body = Value::Object(envelope).to_string();

        let mut response = (self.status, body).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Some(secs) = self.retry_after_secs {
            headers.insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        if self.close {
            headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
        }
        for (name, value) in self.headers {
            headers.insert(name, value);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_gets_the_status_the_contract_assigns() {
        for code in [
            ErrorCode::InvalidRequest,
            ErrorCode::PayloadTooLarge,
            ErrorCode::Unavailable,
            ErrorCode::CatalogUnavailable,
            ErrorCode::Internal,
        ] {
            let failure = ApiFailure::new(code, "x");
            assert_eq!(Some(failure.status().as_u16()), code.http_status());
            assert_eq!(failure.code(), code.as_str());
        }
    }

    #[test]
    fn not_implemented_is_not_a_proto_code_and_decodes_as_unknown() {
        let decoded: ErrorCode = serde_json::from_value(Value::from(NOT_IMPLEMENTED)).unwrap();
        assert_eq!(decoded, ErrorCode::Unknown);
        assert_eq!(
            ApiFailure::not_implemented().status(),
            StatusCode::NOT_IMPLEMENTED
        );
    }
}
