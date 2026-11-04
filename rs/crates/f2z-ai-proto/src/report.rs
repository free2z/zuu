//! Reporting an AI call's output: `POST /api/sdk/v1/calls/{call_id}/report`
//! (`docs/free2z/sdk/spec/chat-api.md` §7.1).
//!
//! The user flags what a call produced as wrong or harmful, inside the app.
//! Free2Z stores the reference and the reason, never the AI content; the
//! report reaches the app's developer (`GET /api/oauth/apps/{app_id}/reports/`) and Free2Z
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
    /// characters, no control, line/paragraph-separator or bidi-control
    /// characters ([`check_detail`]). Omitted rather than empty.
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

/// `detail`'s rule, the server's: 1 to [`REPORT_DETAIL_MAX_CHARS`]
/// characters on one line — no C0/C1 control characters (so no newline or
/// tab), no U+2028/U+2029 line and paragraph separators, and no bidi
/// controls (U+202A–U+202E, U+2066–U+2069). ZWJ and ZWNJ are allowed.
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
    if detail.chars().any(forbidden_in_detail) {
        return Err("detail must be one line without control or bidi characters");
    }
    Ok(())
}

fn forbidden_in_detail(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
}

/// A gateway `call_id`: a UUID in its hyphenated form (the gateway issues
/// UUIDv7), any case. Checked before it becomes a URL path segment.
///
/// # Errors
/// A static reason.
pub fn check_call_id(call_id: &str) -> Result<(), &'static str> {
    let bytes = call_id.as_bytes();
    let shaped = bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    if shaped {
        Ok(())
    } else {
        Err("call_id is not a UUID")
    }
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
        assert!(check_detail("family\u{200D}emoji \u{200C}zwnj").is_ok());
        for bad in [
            "a\nb",
            "a\tb",
            "a\u{0}b",
            "a\u{85}b",
            "a\u{7f}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "a\u{202A}b",
            "a\u{202E}b",
            "a\u{2066}b",
            "a\u{2069}b",
        ] {
            assert!(check_detail(bad).is_err(), "{bad:?}");
        }
        let unknown = CallReportRequest {
            reason: ReportReason::Unknown,
            detail: None,
        };
        assert!(unknown.check().is_err());
    }

    #[test]
    fn a_call_id_is_a_hyphenated_uuid() {
        assert!(check_call_id("019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c").is_ok());
        assert!(check_call_id("019A2F1C-9C7B-7E21-8A3D-4B5E6F7A8B9C").is_ok());
        for bad in [
            "",
            "../grant",
            "019a2f1c9c7b7e218a3d4b5e6f7a8b9c",
            "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c/x",
            "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9g",
            "019a2f1c-9c7b-7e21-8a3d+4b5e6f7a8b9c",
        ] {
            assert!(check_call_id(bad).is_err(), "{bad:?}");
        }
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
