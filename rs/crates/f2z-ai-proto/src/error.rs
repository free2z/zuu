//! Error codes: the `code` of an SSE `error` event and of an HTTP error body.
//!
//! A code is a stable, machine-readable string. The message beside it is for
//! humans and may change; a client branches on the code only.

use alloc::string::String;
use core::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Every error the gateway reports: the codes of `docs/sdk/spec/errors.md`
/// §2–§4. `tests/error_catalogue.rs` parses those tables and fails if a code,
/// its status or its retryability drifts from them.
///
/// `#[non_exhaustive]`: new codes are additive, and a client must handle one
/// it does not know (it deserializes as [`ErrorCode::Unknown`]).
///
/// `stream_interrupted` is deliberately absent: an SDK synthesises it when a
/// connection closes without a terminal event, and the gateway never sends it.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request body is malformed or violates the schema.
    InvalidRequest,
    /// No or invalid access token.
    InvalidToken,
    /// The token's account epoch (`aep`) or grant generation (`agen`) is
    /// stale: a security event, or the grant was revoked or narrowed. Also
    /// the public form of the ledger's `revoked` hold answer.
    TokenRevoked,
    /// The token lacks the `ai:invoke` scope.
    InsufficientScope,
    /// The operation needs a more recent sign-in (RFC 9470).
    InsufficientUserAuthentication,
    /// The app's registration is suspended.
    AppDisabled,
    /// The user's account cannot spend (for example a payment dispute is
    /// open). The public form of the ledger's `frozen` hold answer.
    AccountFrozen,
    /// A reversal took back 2Z already spent; the account owes the
    /// difference (`details.debt_milli_2z`) and cannot spend until future
    /// credits repay it. The public form of the ledger's `in_debt` answer.
    AccountInDebt,
    /// The balance cannot cover the hold.
    InsufficientBalance,
    /// The app's spend cap for this user would be exceeded.
    CapExceeded,
    /// The model id is not in the catalogue.
    ModelNotFound,
    /// The model or its provider is disabled by policy.
    ModelDisabled,
    /// No such call for this (user, app).
    CallNotFound,
    /// No such purchase for this (user, app).
    PurchaseNotFound,
    /// The `Idempotency-Key` was used with a different body, or names a call
    /// that is still running (`details.call_id`).
    IdempotencyConflict,
    /// The account already has the maximum number of open holds.
    TooManyHolds,
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
    /// The gateway is draining, cannot confirm revocation state, or the
    /// provider's circuit breaker is open.
    Unavailable,
    /// A gateway fault. Also the public form of a ledger answer the gateway
    /// did not expect (`markup_mismatch`, `unknown_rate_card`), with
    /// `details.reason`.
    Internal,
    /// Delivery to this client ended (the per-stream buffer filled, or it
    /// stalled) while the call continues upstream and will be charged.
    /// Stream-only; always with `settlement: "pending"`.
    DeliveryAborted,
    /// A code newer than this crate. Deserialization only.
    #[serde(other)]
    Unknown,
}

impl ErrorCode {
    /// Every code the gateway can send, in `errors.md` order. Excludes
    /// [`ErrorCode::Unknown`].
    pub const ALL: [Self; 26] = [
        Self::InvalidToken,
        Self::TokenRevoked,
        Self::InsufficientUserAuthentication,
        Self::InsufficientScope,
        Self::AppDisabled,
        Self::AccountFrozen,
        Self::AccountInDebt,
        Self::Unavailable,
        Self::InvalidRequest,
        Self::ContextLengthExceeded,
        Self::InsufficientBalance,
        Self::CapExceeded,
        Self::ModelDisabled,
        Self::ModelNotFound,
        Self::CallNotFound,
        Self::PurchaseNotFound,
        Self::IdempotencyConflict,
        Self::TooManyHolds,
        Self::PayloadTooLarge,
        Self::RateLimited,
        Self::ConcurrencyLimit,
        Self::ProviderError,
        Self::ProviderTimeout,
        Self::CatalogUnavailable,
        Self::Internal,
        Self::DeliveryAborted,
    ];

    /// The HTTP status the code arrives with when it is an HTTP response
    /// (before a stream has started). Once a stream is open the status is
    /// already 200 and the code arrives in an `error` event instead.
    ///
    /// `None` for [`ErrorCode::DeliveryAborted`], which only ever arrives in
    /// a stream. [`ErrorCode::Unknown`] answers `500`: a client that must
    /// pick a status for a code it does not know treats it as a server fault.
    ///
    /// A non-streamed call that fails after output began is `502` whatever
    /// its code (`chat-api.md` §4); that is the one exception.
    #[must_use]
    pub fn http_status(self) -> Option<u16> {
        Some(match self {
            Self::InvalidRequest | Self::ContextLengthExceeded => 400,
            Self::InvalidToken | Self::TokenRevoked | Self::InsufficientUserAuthentication => 401,
            Self::InsufficientBalance => 402,
            Self::InsufficientScope
            | Self::AppDisabled
            | Self::AccountFrozen
            | Self::AccountInDebt
            | Self::CapExceeded
            | Self::ModelDisabled => 403,
            Self::ModelNotFound | Self::CallNotFound | Self::PurchaseNotFound => 404,
            Self::IdempotencyConflict | Self::TooManyHolds => 409,
            Self::PayloadTooLarge => 413,
            Self::RateLimited | Self::ConcurrencyLimit => 429,
            Self::Internal | Self::Unknown => 500,
            Self::ProviderError => 502,
            Self::CatalogUnavailable | Self::Unavailable => 503,
            Self::ProviderTimeout => 504,
            Self::DeliveryAborted => return None,
        })
    }

    /// Whether retrying the identical request later can succeed without the
    /// caller changing anything (`errors.md`'s "Retry" column). `true` never
    /// means "retry immediately": honour `Retry-After`, else back off.
    ///
    /// A retry the user wants attempted again uses a **new**
    /// `Idempotency-Key`; re-sending the old key only returns what it already
    /// produced (`chat-api.md` §2.5). That is why `internal` is retryable:
    /// the failed attempt is recorded under its key and a new key is a new
    /// call, so a retry can never double-charge.
    #[must_use]
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited
                | Self::ConcurrencyLimit
                | Self::TooManyHolds
                | Self::ProviderError
                | Self::ProviderTimeout
                | Self::CatalogUnavailable
                | Self::Unavailable
                | Self::Internal
        )
    }

    /// Whether this is a provider-side failure that `fallback` may recover
    /// from, when it happens before the gateway commits to a model (before
    /// `meta`): `provider_error`, `provider_timeout`, and `unavailable` (the
    /// provider's circuit breaker is open). Any other code ends the call:
    /// `fallback` is never tried after `meta`, and never for a refusal about
    /// the caller (balance, cap, token), which another model cannot fix.
    #[must_use]
    pub fn falls_back(self) -> bool {
        matches!(
            self,
            Self::ProviderError | Self::ProviderTimeout | Self::Unavailable
        )
    }

    /// The wire string, e.g. `"cap_exceeded"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidToken => "invalid_token",
            Self::TokenRevoked => "token_revoked",
            Self::InsufficientScope => "insufficient_scope",
            Self::InsufficientUserAuthentication => "insufficient_user_authentication",
            Self::AppDisabled => "app_disabled",
            Self::AccountFrozen => "account_frozen",
            Self::AccountInDebt => "account_in_debt",
            Self::InsufficientBalance => "insufficient_balance",
            Self::CapExceeded => "cap_exceeded",
            Self::ModelNotFound => "model_not_found",
            Self::ModelDisabled => "model_disabled",
            Self::CallNotFound => "call_not_found",
            Self::PurchaseNotFound => "purchase_not_found",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::TooManyHolds => "too_many_holds",
            Self::ContextLengthExceeded => "context_length_exceeded",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RateLimited => "rate_limited",
            Self::ConcurrencyLimit => "concurrency_limit",
            Self::ProviderError => "provider_error",
            Self::ProviderTimeout => "provider_timeout",
            Self::CatalogUnavailable => "catalog_unavailable",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
            Self::DeliveryAborted => "delivery_aborted",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error: the `error` member of an HTTP error body ([`ErrorBody`]).
///
/// The SSE `error` event carries more — the settlement of the failed call —
/// and is [`crate::event::ErrorEvent`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    /// What went wrong, for a program.
    pub code: ErrorCode,
    /// What went wrong, for a person. Never contains prompt or completion text.
    #[serde(default)]
    pub message: String,
    /// Code-specific detail, documented per code in `errors.md` (for
    /// example `debt_milli_2z` on `account_in_debt`, `call_id` on
    /// `idempotency_conflict`, `reason` on `internal`). A client tolerates
    /// its absence and unknown keys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

/// A non-streaming error response: `{"error": {"code": …, "message": …}}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// The error.
    pub error: ApiError,
}

/// What the ledger's `hold` can refuse with (`metering.md` §3), and how each
/// refusal reaches a client. The ledger's names are internal; this is the one
/// place the mapping to public codes is written down.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LedgerRefusal {
    /// `in_debt` — checked before the balance.
    InDebt,
    /// `insufficient_balance`.
    InsufficientBalance,
    /// `cap_exceeded`.
    CapExceeded,
    /// `frozen`.
    Frozen,
    /// `revoked` — the token's epoch or grant generation is stale.
    Revoked,
    /// `markup_mismatch` — the gateway and ledger disagree on configuration.
    MarkupMismatch,
    /// `unknown_rate_card` — the ledger does not hold the catalogue's rate card.
    UnknownRateCard,
    /// `too_many_holds`.
    TooManyHolds,
}

impl LedgerRefusal {
    /// The code a client sees.
    #[must_use]
    pub fn error_code(self) -> ErrorCode {
        match self {
            Self::InDebt => ErrorCode::AccountInDebt,
            Self::InsufficientBalance => ErrorCode::InsufficientBalance,
            Self::CapExceeded => ErrorCode::CapExceeded,
            Self::Frozen => ErrorCode::AccountFrozen,
            Self::Revoked => ErrorCode::TokenRevoked,
            Self::MarkupMismatch | Self::UnknownRateCard => ErrorCode::Internal,
            Self::TooManyHolds => ErrorCode::TooManyHolds,
        }
    }

    /// The ledger's own name for the answer — the `details.reason` the
    /// gateway attaches when the public code is `internal`.
    #[must_use]
    pub fn ledger_name(self) -> &'static str {
        match self {
            Self::InDebt => "in_debt",
            Self::InsufficientBalance => "insufficient_balance",
            Self::CapExceeded => "cap_exceeded",
            Self::Frozen => "frozen",
            Self::Revoked => "revoked",
            Self::MarkupMismatch => "markup_mismatch",
            Self::UnknownRateCard => "unknown_rate_card",
            Self::TooManyHolds => "too_many_holds",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_is_every_variant_but_unknown() {
        for code in ErrorCode::ALL {
            match code {
                ErrorCode::InvalidRequest
                | ErrorCode::InvalidToken
                | ErrorCode::TokenRevoked
                | ErrorCode::InsufficientScope
                | ErrorCode::InsufficientUserAuthentication
                | ErrorCode::AppDisabled
                | ErrorCode::AccountFrozen
                | ErrorCode::AccountInDebt
                | ErrorCode::InsufficientBalance
                | ErrorCode::CapExceeded
                | ErrorCode::ModelNotFound
                | ErrorCode::ModelDisabled
                | ErrorCode::CallNotFound
                | ErrorCode::PurchaseNotFound
                | ErrorCode::IdempotencyConflict
                | ErrorCode::TooManyHolds
                | ErrorCode::ContextLengthExceeded
                | ErrorCode::PayloadTooLarge
                | ErrorCode::RateLimited
                | ErrorCode::ConcurrencyLimit
                | ErrorCode::ProviderError
                | ErrorCode::ProviderTimeout
                | ErrorCode::CatalogUnavailable
                | ErrorCode::Unavailable
                | ErrorCode::Internal
                | ErrorCode::DeliveryAborted => {}
                ErrorCode::Unknown => panic!("Unknown is not a code the gateway sends"),
            }
        }
        // A variant added to the enum must be added to the match above (no
        // wildcard), to `ALL`, and to `errors.md`; `tests/error_catalogue.rs`
        // fails when `ALL` and the document's tables disagree.
        let mut seen = alloc::vec::Vec::new();
        for code in ErrorCode::ALL {
            assert!(!seen.contains(&code), "{code} listed twice");
            seen.push(code);
        }
    }

    #[test]
    fn ledger_refusals_map_to_public_codes() {
        assert_eq!(LedgerRefusal::Revoked.error_code(), ErrorCode::TokenRevoked);
        assert_eq!(LedgerRefusal::Frozen.error_code(), ErrorCode::AccountFrozen);
        assert_eq!(LedgerRefusal::InDebt.error_code(), ErrorCode::AccountInDebt);
        assert_eq!(
            LedgerRefusal::MarkupMismatch.error_code(),
            ErrorCode::Internal
        );
        assert_eq!(
            LedgerRefusal::UnknownRateCard.error_code(),
            ErrorCode::Internal
        );
        assert_eq!(
            LedgerRefusal::UnknownRateCard.ledger_name(),
            "unknown_rate_card"
        );
        assert_eq!(
            LedgerRefusal::TooManyHolds.error_code(),
            ErrorCode::TooManyHolds
        );
    }
}
