//! Error codes: the `code` of an SSE `error` event and of an HTTP error body.
//!
//! A code is a stable, machine-readable string. The message beside it is for
//! humans and may change; a client branches on the code only.

use alloc::string::String;
use core::fmt;

use serde::{Deserialize, Serialize};

/// Every error the gateway reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request body is malformed or violates the schema.
    InvalidRequest,
    /// No or invalid access token.
    InvalidToken,
    /// The token lacks the `ai:invoke` scope.
    InsufficientScope,
    /// The operation needs a more recent sign-in (RFC 9470).
    InsufficientUserAuthentication,
    /// The balance cannot cover the hold.
    Insufficient,
    /// The app's spend cap for this user would be exceeded.
    CapExceeded,
    /// The model id is not in the catalogue.
    ModelNotFound,
    /// The model or its provider is disabled by policy.
    ModelDisabled,
    /// The input does not fit the model's context window.
    ContextLengthExceeded,
    /// The request body exceeds the size limit.
    PayloadTooLarge,
    /// Too many requests for this (app, user).
    RateLimited,
    /// Too many concurrent streams for this user.
    ConcurrencyLimit,
    /// The model provider returned an error.
    ProviderError,
    /// The model provider did not answer in time.
    ProviderTimeout,
    /// No verified catalogue is loaded; the gateway will not price blind.
    CatalogUnavailable,
    /// The gateway is draining or otherwise unavailable.
    Unavailable,
    /// An internal error.
    Internal,
    /// A code newer than this crate. Deserialization only.
    #[serde(other)]
    Unknown,
}

impl ErrorCode {
    /// The HTTP status the gateway answers with when the error happens before
    /// a stream has started. Once a stream is open the status is already 200
    /// and the code arrives in an `error` event instead.
    #[must_use]
    pub fn http_status(self) -> u16 {
        match self {
            Self::InvalidRequest | Self::ContextLengthExceeded => 400,
            Self::InvalidToken | Self::InsufficientUserAuthentication => 401,
            Self::Insufficient => 402,
            Self::InsufficientScope | Self::CapExceeded | Self::ModelDisabled => 403,
            Self::ModelNotFound => 404,
            Self::PayloadTooLarge => 413,
            Self::RateLimited | Self::ConcurrencyLimit => 429,
            Self::Internal | Self::Unknown => 500,
            Self::ProviderError => 502,
            Self::CatalogUnavailable | Self::Unavailable => 503,
            Self::ProviderTimeout => 504,
        }
    }

    /// Whether retrying the identical request later can succeed without the
    /// caller changing anything.
    #[must_use]
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited
                | Self::ConcurrencyLimit
                | Self::ProviderError
                | Self::ProviderTimeout
                | Self::CatalogUnavailable
                | Self::Unavailable
        )
    }

    /// The wire string, e.g. `"cap_exceeded"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidToken => "invalid_token",
            Self::InsufficientScope => "insufficient_scope",
            Self::InsufficientUserAuthentication => "insufficient_user_authentication",
            Self::Insufficient => "insufficient",
            Self::CapExceeded => "cap_exceeded",
            Self::ModelNotFound => "model_not_found",
            Self::ModelDisabled => "model_disabled",
            Self::ContextLengthExceeded => "context_length_exceeded",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RateLimited => "rate_limited",
            Self::ConcurrencyLimit => "concurrency_limit",
            Self::ProviderError => "provider_error",
            Self::ProviderTimeout => "provider_timeout",
            Self::CatalogUnavailable => "catalog_unavailable",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error: the payload of an SSE `error` event, and the `error` member of
/// an HTTP error body ([`ErrorBody`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    /// What went wrong, for a program.
    pub code: ErrorCode,
    /// What went wrong, for a person. Never contains prompt or completion text.
    #[serde(default)]
    pub message: String,
}

/// A non-streaming error response: `{"error": {"code": …, "message": …}}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// The error.
    pub error: ApiError,
}
