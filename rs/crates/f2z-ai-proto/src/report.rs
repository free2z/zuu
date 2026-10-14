//! Reporting an AI call's output: `POST /api/sdk/v1/calls/{call_id}/report`
//! (`docs/free2z/sdk/spec/chat-api.md` §7.1).
//!
//! The user flags what a call produced as wrong or harmful, inside the app.
//! Free2Z stores the reference and the reason, never the AI content; the
//! report reaches the app's developer (developer console) and Free2Z
//! moderation, and `unsafe` alerts Free2Z staff.
use alloc::string::String;
use serde::{Deserialize, Serialize};

/// The most `detail` may hold, in Unicode scalar values.
pub const REPORT_DETAIL_MAX_CHARS: usize = 200;

/// Why the user reports the output. Prefer these over free text: apps that
/// children may use should offer preset choices only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ReportReason {
    /// Wrong: a wrong answer, a wrong grade, nonsense.
    Incorrect,
    /// Not suitable for the audience: rude, off-topic, mature.
    Inappropriate,
    /// Harmful or dangerous. Alerts Free2Z staff.
    Unsafe,
    /// Anything else.
    Other,
    /// A reason newer than this SDK, in a response. Never sent: a request
    /// carrying it is refused by [`CallReportRequest::check`].
    #[serde(other)]
    Unknown,
}

impl ReportReason {
    /// The wire value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incorrect => "incorrect",
            Self::Inappropriate => "inappropriate",
            Self::Unsafe => "unsafe",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// The request body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallReportRequest {
    /// Why.
    pub reason: ReportReason,
    /// Optional, short, single line: at most [`REPORT_DETAIL_MAX_CHARS`]
    /// characters and no control characters. Omitted rather than empty.
    /// Prefer a preset value (an app-defined code such as `wrong_grade`)
    /// to anything a user types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CallReportRequest {
    /// What the server would refuse with `400 invalid_request`, checked
    /// before anything is sent.
    ///
    /// # Errors
    /// A static reason naming the field.
    pub fn check(&self) -> Result<(), &'static str> {
        if self.reason == ReportReason::Unknown {
            return Err("reason must be incorrect, inappropriate, unsafe or other");
        }
        if let Some(detail) = &self.detail {
            check_detail(detail)?;
        }
        Ok(())
    }
}

/// `detail`'s rule: 1 to [`REPORT_DETAIL_MAX_CHARS`] characters, no control
/// characters (C0 and C1, which includes newline and tab).
///
/// # Errors
/// A static reason.
pub fn check_detail(detail: &str) -> Result<(), &'static str> {
    if detail.is_empty() {
        return Err("detail is empty: omit it instead");
    }
    if detail.chars().count() > REPORT_DETAIL_MAX_CHARS {
        return Err("detail is longer than 200 characters");
    }
    if detail.chars().any(char::is_control) {
        return Err("detail must be one line without control characters");
    }
    Ok(())
}

/// The report receipt, for a new report (`201`) and for a repeat by the same
/// user (`200`, which replaced the reason and detail). Unknown members are
/// ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallReport {
    /// The report.
    pub report_id: String,
    /// The reported call.
    pub call_id: String,
    /// The reason now on record.
    pub reason: ReportReason,
    /// When the report was first made, RFC 3339 UTC.
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    #[test]
    fn the_request_is_the_wire_shape_and_omits_an_absent_detail() {
        let bare = CallReportRequest {
            reason: ReportReason::Unsafe,
            detail: None,
        };
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"reason":"unsafe"}"#
        );
        let with = CallReportRequest {
            reason: ReportReason::Incorrect,
            detail: Some("wrong_grade".into()),
        };
        assert_eq!(
            serde_json::to_string(&with).unwrap(),
            r#"{"reason":"incorrect","detail":"wrong_grade"}"#
        );
    }

    #[test]
    fn detail_is_bounded_single_line_text() {
        assert!(check_detail("wrong_grade").is_ok());
        assert!(check_detail(&"é".repeat(200)).is_ok());
        assert!(check_detail(&"é".repeat(201)).is_err());
        assert!(check_detail("").is_err());
        for bad in ["a\nb", "a\tb", "a\u{0}b", "a\u{85}b", "a\u{7f}b"] {
            assert!(check_detail(bad).is_err(), "{bad:?}");
        }
        let unknown = CallReportRequest {
            reason: ReportReason::Unknown,
            detail: None,
        };
        assert!(unknown.check().is_err());
    }

    #[test]
    fn the_receipt_ignores_unknown_members_and_reasons() {
        let receipt: CallReport = serde_json::from_str(
            r#"{"report_id":"r","call_id":"c","reason":"spam","created_at":"2026-10-14T00:00:00Z","new":1}"#,
        )
        .unwrap();
        assert_eq!(receipt.reason, ReportReason::Unknown);
        assert_eq!(receipt.call_id, "c".to_string());
    }
}
