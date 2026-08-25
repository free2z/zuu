//! The plugin's error type, and the one rule that governs it.
//!
//! **Every rejected command reaches the webview as exactly one
//! [`ErrorCode`](crate::models::ErrorCode) kebab string, and nothing else.**
//! `CLIENT-CONTRACT.md` §8 makes the union closed, and
//! `wallet/zuuli/src/lib/messaging/types.ts` declares **no error envelope** —
//! only `ErrorCodeSchema` and `isRetryable(code)`. A rejection carrying a free
//! prose string, or a JSON object, would not parse against anything the client
//! has, so the client would be left doing substring matching on an engine
//! message. So the serialized form is the bare code.
//!
//! The detail is not thrown away, it is *routed*: every error carries a
//! `context` for `tracing`, which reaches the developer's console and the log,
//! and never the webview. That asymmetry is deliberate — §8 says `internal`
//! "carries no detail by design".
//!
//! `tauri-plugin-zcash` serializes its errors as `Display` prose instead. That
//! is right for a plugin whose client reads errors as English; it is wrong
//! here, and the difference is the contract, not taste.

use crate::models::ErrorCode;

pub type Result<T> = core::result::Result<T, Error>;

/// A refusal, as the frontend sees it plus the detail it does not.
#[derive(Debug, Clone)]
pub struct Error {
    code: ErrorCode,
    context: String,
}

impl Error {
    /// The general constructor. `context` is for humans and logs; it never
    /// crosses IPC.
    pub fn new(code: ErrorCode, context: impl Into<String>) -> Self {
        Self {
            code,
            context: context.into(),
        }
    }

    /// An engine fault. §8: `internal` carries no detail by design, so the
    /// detail goes to the log and the webview gets the bare code.
    pub fn internal(context: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, context)
    }

    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    #[must_use]
    pub fn context(&self) -> &str {
        &self.context
    }

    /// §8: `engine-not-running` is retryable — the UI calls `start_engine`
    /// once, then retries once.
    pub fn engine_not_running(what: &str) -> Self {
        Self::new(
            ErrorCode::EngineNotRunning,
            format!("{what} requires a running engine"),
        )
    }

    /// §8: `not-enrolled` routes to enrollment, which is an app-crate command
    /// (§2.2) and not something this plugin can perform.
    pub fn not_enrolled(what: &str) -> Self {
        Self::new(
            ErrorCode::NotEnrolled,
            format!("{what} requires a directory entry"),
        )
    }
}

impl core::fmt::Display for Error {
    /// Deliberately the code and not the context: a `Display` that leaked the
    /// context would put it in every `format!`, and from there into an error
    /// path that reaches the webview by accident rather than by decision.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.code.as_str())
    }
}

impl core::error::Error for Error {}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> core::result::Result<S::Ok, S::Error> {
        // Logged here rather than at every construction site so that an error
        // which is caught and handled internally costs nothing, and one that
        // actually reaches the frontend is always recorded.
        tracing::warn!(code = %self.code, context = %self.context, "f2zmsg command refused");
        serializer.serialize_str(self.code.as_str())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        // Storage exhaustion is the one io error with a contract member of its
        // own, because §8 tells the UI to do something specific about it:
        // inbound stops being acknowledged, which is correct, because an
        // un-ACKed message is still on the relay.
        let code = match error.kind() {
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => {
                ErrorCode::StorageFull
            }
            _ => ErrorCode::Internal,
        };
        Self::new(code, error.to_string())
    }
}

impl From<crate::framing::FramingError> for Error {
    fn from(error: crate::framing::FramingError) -> Self {
        // A malformed envelope from a peer is not `relay-protocol-violation`:
        // the relay never saw inside it. It is our own engine failing to make
        // sense of an authenticated payload, which is what `internal` means.
        Self::internal(error.to_string())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_reaches_the_webview_as_a_bare_contract_code() {
        let json = serde_json::to_value(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            "3 configured, 0 independent, threshold 2",
        ))
        .expect("serialize");
        assert_eq!(json, serde_json::json!("witness-threshold-unmet"));
    }

    #[test]
    fn the_context_never_appears_in_the_serialized_form() {
        let secret = "queue addr 0xdeadbeef";
        let json = serde_json::to_string(&Error::internal(secret)).expect("serialize");
        assert!(!json.contains("deadbeef"), "context must not cross IPC: {json}");
    }

    #[test]
    fn display_is_the_code_so_prose_cannot_leak_through_a_format() {
        assert_eq!(
            Error::new(ErrorCode::PowRequired, "difficulty 20").to_string(),
            "pow-required"
        );
    }
}
