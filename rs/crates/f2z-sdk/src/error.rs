//! The SDK's one error type.
//!
//! Every non-2xx from the account API (`free2z.cash/api/sdk/v1`) and the AI
//! gateway (`ai.free2z.cash/v1`) is the envelope of `docs/sdk/spec/errors.md`
//! §1 and arrives as [`Error::Api`]. The identity provider's own RFC 6749
//! errors arrive as [`Error::Authorization`] (the redirect) or
//! [`Error::Token`] (the token endpoint). Switch on codes, never on messages:
//! messages are English, for logs, and not stable.

use std::fmt;
use std::time::Duration;

use f2z_ai_proto::ErrorCode;
use serde_json::{Map, Value};

use crate::ai::CallRecord;

/// Everything that can go wrong in this SDK.
#[non_exhaustive]
#[derive(Debug)]
pub enum Error {
    /// A configuration value is unusable: an empty client id, a URL that is
    /// neither `https` nor loopback `http`.
    Config(String),
    /// The discovery document is unusable: its `issuer` is not the configured
    /// one, it does not offer PKCE `S256`, or an endpoint is missing or not
    /// `https`.
    Discovery(String),
    /// No HTTP response at all: DNS, connect, TLS, or a timeout.
    Transport(TransportError),
    /// The authorization response's `iss` (RFC 9207) is missing or is not the
    /// issuer this sign-in was started against. The code was **not** used.
    IssuerMismatch {
        /// The configured issuer.
        expected: String,
        /// What the response carried, if anything.
        got: Option<String>,
    },
    /// The authorization response's `state` is missing or is not the one
    /// this sign-in sent. The code was **not** used.
    StateMismatch,
    /// The identity provider answered the authorization request with an
    /// error (`access_denied`, `invalid_scope`, `login_required`, …), after
    /// its `iss` and `state` were verified.
    Authorization(OAuthError),
    /// The token endpoint refused (`invalid_grant`, `invalid_client`, …).
    Token(OAuthError),
    /// The browser or platform authentication session failed or was
    /// dismissed.
    Browser(String),
    /// Nothing arrived in time. Almost always a registration mistake when it
    /// is the sign-in callback: the IdP does not redirect for an unknown
    /// client or redirect URI (`errors.md` §5).
    Timeout(&'static str),
    /// The ID token failed verification (signature, `iss`, `aud`, `exp`,
    /// `nonce`).
    IdToken(String),
    /// There is no usable session; the user must sign in (again). The stored
    /// refresh token has already been removed when the reason says so.
    SignedOut(SignedOutReason),
    /// The resource server wants a more recent or stronger authentication
    /// (RFC 9470). Run [`crate::Client::sign_in`] with
    /// [`crate::SignInOptions::step_up`] and retry once.
    StepUpRequired(StepUp),
    /// A non-2xx answer in the `errors.md` §1 envelope.
    Api(Box<ApiError>),
    /// A `/v1/chat` stream closed without a terminal event: the SDK-local
    /// `stream_interrupted`. The call may still be running and billable;
    /// read [`crate::ai::Ai::call`] with the `call_id` for its outcome.
    StreamInterrupted {
        /// The call, when `meta` or the response header named it.
        call_id: Option<String>,
    },
    /// A re-sent `Idempotency-Key` found the call already finished: this is
    /// its record. The completion itself is not retained by the gateway and
    /// cannot be delivered again; nothing new was charged.
    Replayed(Box<CallRecord>),
    /// A chat call ended in an `error` event. [`crate::ai::ChatFailure`]
    /// carries the event and what the failed call still cost; its
    /// `retryable()` says whether a new call may be made automatically.
    ChatFailed(Box<crate::ai::ChatFailure>),
    /// The call was cancelled through its [`crate::ai::CancelHandle`].
    /// Cancelling stops delivery, not generation: the call still settles.
    Cancelled,
    /// The server said something this SDK cannot interpret.
    Protocol(String),
    /// The [`crate::TokenStore`] failed.
    Storage(String),
    /// A local failure that should not happen (the OS CSPRNG failed).
    Internal(String),
}

impl Error {
    /// Whether this is the session ending — sign-in is the only remedy.
    #[must_use]
    pub fn is_signed_out(&self) -> bool {
        matches!(self, Self::SignedOut(_))
    }

    /// The envelope, when this is an [`Error::Api`].
    #[must_use]
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Self::Api(e) => Some(e),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(m) => write!(f, "configuration: {m}"),
            Self::Discovery(m) => write!(f, "discovery: {m}"),
            Self::Transport(e) => write!(f, "transport: {e}"),
            Self::IssuerMismatch { expected, got } => write!(
                f,
                "authorization response iss {got:?} is not the issuer {expected:?}"
            ),
            Self::StateMismatch => f.write_str("authorization response state does not match"),
            Self::Authorization(e) => write!(f, "authorization refused: {e}"),
            Self::Token(e) => write!(f, "token endpoint refused: {e}"),
            Self::Browser(m) => write!(f, "browser: {m}"),
            Self::Timeout(what) => write!(f, "timed out waiting for {what}"),
            Self::IdToken(m) => write!(f, "ID token rejected: {m}"),
            Self::SignedOut(r) => write!(f, "signed out: {r}"),
            Self::StepUpRequired(s) => write!(f, "step-up authentication required: {s:?}"),
            Self::Api(e) => write!(f, "{e}"),
            Self::StreamInterrupted { call_id } => {
                write!(f, "stream_interrupted (call {call_id:?})")
            }
            Self::Replayed(r) => write!(f, "call {} was already made (replayed)", r.call_id),
            Self::ChatFailed(f2) => write!(
                f,
                "chat call {:?} failed: {} ({})",
                f2.call_id, f2.error.code, f2.error.message
            ),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Protocol(m) => write!(f, "protocol: {m}"),
            Self::Storage(m) => write!(f, "token store: {m}"),
            Self::Internal(m) => write!(f, "internal: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// A failure with no HTTP response. Opaque on purpose: the HTTP client is
/// an implementation detail.
#[derive(Debug)]
pub struct TransportError {
    message: String,
    timeout: bool,
}

impl TransportError {
    pub(crate) fn timeout(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            timeout: true,
        }
    }

    /// Whether it was a timeout.
    #[must_use]
    pub fn is_timeout(&self) -> bool {
        self.timeout
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // `without_url`: a URL can carry a query we would rather not log.
        let timeout = e.is_timeout();
        Self::Transport(TransportError {
            message: e.without_url().to_string(),
            timeout,
        })
    }
}

/// An RFC 6749 error (`{"error": …, "error_description": …}` or the
/// redirect's query parameters).
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthError {
    /// The code, e.g. `invalid_grant`, `access_denied`.
    pub error: String,
    /// For a log; not for the user.
    pub description: Option<String>,
}

impl OAuthError {
    pub(crate) fn new(error: impl Into<String>, description: Option<String>) -> Self {
        Self {
            error: error.into(),
            description,
        }
    }
}

impl fmt::Display for OAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.description {
            Some(d) => write!(f, "{} ({d})", self.error),
            None => f.write_str(&self.error),
        }
    }
}

/// Why there is no session.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignedOutReason {
    /// Nobody has signed in, or the grant carried no refresh token
    /// (`offline_access` was not granted) and the access token expired.
    NoSession,
    /// The token endpoint refused the refresh token (`invalid_grant`: expired,
    /// reused, a stale account epoch, a revoked grant). Never retried.
    RefreshRejected,
    /// A resource server answered `401 token_revoked`: the grant or the
    /// account changed underneath the session.
    TokenRevoked,
    /// [`crate::Client::sign_out`] was called.
    SignedOut,
}

impl fmt::Display for SignedOutReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoSession => "no session",
            Self::RefreshRejected => "the refresh token was refused",
            Self::TokenRevoked => "the grant or the account was revoked",
            Self::SignedOut => "signed out",
        })
    }
}

/// An RFC 9470 step-up challenge: what the next authorization request must
/// carry.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StepUp {
    /// The largest acceptable age of the last authentication, in seconds.
    pub max_age: Option<u64>,
    /// The authentication context the operation needs, e.g.
    /// `urn:f2z:acr:mfa`.
    pub acr_values: Option<String>,
}

/// A non-2xx answer from the account API or the gateway, in the envelope of
/// `errors.md` §1.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    /// The HTTP status.
    pub status: u16,
    /// The wire code, exactly as sent — including codes this SDK does not
    /// know. [`ApiError::error_code`] is the typed form.
    pub code: String,
    /// English, for logs. Not stable; never parse it.
    pub message: String,
    /// Code-specific detail (`errors.md`), when present.
    pub details: Option<Map<String, Value>>,
    /// `Retry-After`, when the server sent one in seconds.
    pub retry_after: Option<Duration>,
    /// `X-F2Z-Call-Id`, when the gateway had created a call.
    pub call_id: Option<String>,
}

impl ApiError {
    /// The typed code. [`ErrorCode::Unknown`] for a code newer than
    /// `f2z-ai-proto`, and for the account API's own codes
    /// (`invalid_quantity`, `rail_unavailable`, …) — read [`ApiError::code`]
    /// for those.
    #[must_use]
    pub fn error_code(&self) -> ErrorCode {
        parse_code(&self.code)
    }

    /// Whether an SDK may retry this on its own, with a **new**
    /// `Idempotency-Key`: `f2z_ai_proto`'s rule, which refuses a charged,
    /// partial or not-final failure and any `details` that suggest the call
    /// may have run.
    #[must_use]
    pub fn retryable(&self) -> bool {
        self.to_proto().retryable()
    }

    pub(crate) fn to_proto(&self) -> f2z_ai_proto::error::ApiError {
        let mut e: f2z_ai_proto::error::ApiError = match serde_json::from_value(Value::Object(
            [
                ("code".to_owned(), Value::String(self.code.clone())),
                ("message".to_owned(), Value::String(self.message.clone())),
            ]
            .into_iter()
            .collect(),
        )) {
            Ok(e) => e,
            // Unreachable for a string code; refuse to retry if it ever is.
            Err(_) => f2z_ai_proto::error::ApiError {
                code: ErrorCode::Unknown,
                message: self.message.clone(),
                details: None,
            },
        };
        e.details.clone_from(&self.details);
        e
    }

    /// A `details` member as an unsigned integer.
    #[must_use]
    pub fn detail_u64(&self, key: &str) -> Option<u64> {
        self.details.as_ref()?.get(key)?.as_u64()
    }

    /// A `details` member as a string.
    #[must_use]
    pub fn detail_str(&self, key: &str) -> Option<&str> {
        self.details.as_ref()?.get(key)?.as_str()
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.message)
    }
}

pub(crate) fn parse_code(code: &str) -> ErrorCode {
    serde_json::from_value(Value::String(code.to_owned())).unwrap_or(ErrorCode::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(code: &str, details: Option<Value>) -> ApiError {
        ApiError {
            status: 503,
            code: code.into(),
            message: String::new(),
            details: details.and_then(|d| d.as_object().cloned()),
            retry_after: None,
            call_id: None,
        }
    }

    #[test]
    fn unknown_codes_keep_their_wire_string() {
        let e = api("invalid_quantity", None);
        assert_eq!(e.error_code(), ErrorCode::Unknown);
        assert_eq!(e.code, "invalid_quantity");
        assert!(!e.retryable());
    }

    #[test]
    fn retryability_is_the_protos() {
        assert!(api("unavailable", None).retryable());
        assert!(!api("insufficient_balance", None).retryable());
        // A charged 502 is never retried.
        let charged = api(
            "provider_error",
            Some(serde_json::json!({
                "settlement": "settled", "charged_2z": 1, "receipt_id": "r",
                "partial": true
            })),
        );
        assert!(!charged.retryable());
    }
}
