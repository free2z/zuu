//! Current bearer-bound grant snapshot from `GET /api/sdk/v1/grant`.
use crate::Whole2z;
use alloc::{string::String, vec::Vec};
use serde::{Deserialize, Serialize};

/// Period of the original consented limit, not the remaining allowance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapPeriod {
    /// Calendar day.
    Day,
    /// Calendar week.
    Week,
    /// Calendar month.
    Month,
    /// Non-resetting total for the current grant policy.
    Total,
}

/// A current snapshot, not a promise that consent cannot subsequently change.
/// Server epochs are distinct from a client's local session generation. Cap
/// changes need not increment the grant generation: re-read before relying on
/// this policy. `enforced` is an explicit service assertion, never inferred from
/// a small remaining allowance, a scope, or a non-null cap.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// Authenticated account subject.
    pub sub: String,
    /// The authenticated app's opaque OAuth identifier.
    pub client_id: String,
    /// Current server account revocation epoch.
    pub account_epoch: u64,
    /// Current server grant revocation generation.
    pub grant_generation: u64,
    /// Current granted scopes.
    pub scopes: Vec<String>,
    /// Original consented limit, whole 2Z. Explicit null means uncapped.
    #[serde(deserialize_with = "required_cap")]
    pub spend_cap_2z: Option<Whole2z>,
    /// Reset period; never inferred from the remaining allowance.
    pub cap_period: CapPeriod,
    /// Whether the service currently enforces the exact returned policy.
    pub enforced: bool,
    /// Snapshot time, RFC 3339 UTC.
    pub as_of: String,
}
impl Grant {
    /// Validate the proof's semantic fields without imposing a freshness TTL.
    ///
    /// # Errors
    /// Returns a static protocol reason for an invalid identity, policy or timestamp.
    pub fn check(&self) -> Result<(), &'static str> {
        if self.sub.is_empty() || self.client_id.is_empty() {
            return Err("grant identity is empty");
        }
        if self.grant_generation == 0 || !self.scopes.iter().any(|s| s == "ai:invoke") {
            return Err("grant is not an AI authorization");
        }
        if !utc_timestamp(&self.as_of) {
            return Err("grant snapshot time is not RFC 3339 UTC");
        }
        Ok(())
    }
}

// RFC 3339 UTC, including fractional seconds and either explicit UTC suffix.
// Kept no_std; calendar validation prevents normalization of e.g. February 30.
fn utc_timestamp(s: &str) -> bool {
    let Some(s) = s
        .strip_suffix('Z')
        .or_else(|| s.strip_suffix('z'))
        .or_else(|| s.strip_suffix("+00:00"))
    else {
        return false;
    };
    if s.get(4..5) != Some("-")
        || s.get(7..8) != Some("-")
        || !matches!(s.get(10..11), Some("T" | "t"))
        || s.get(13..14) != Some(":")
        || s.get(16..17) != Some(":")
    {
        return false;
    }
    let number = |a, b| {
        s.get(a..b)
            .filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    let fraction = s.get(19..).unwrap_or("");
    (fraction.is_empty()
        || fraction
            .strip_prefix('.')
            .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())))
        && (1..=days).contains(&day)
        && hour < 24
        && minute < 60
        && second <= 60
}

fn required_cap<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Whole2z>, D::Error> {
    Option::deserialize(d)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_calendar_and_utc_are_validated() {
        for valid in ["2026-09-28T00:00:00Z", "2024-02-29T23:59:59.123456+00:00"] {
            assert!(utc_timestamp(valid));
        }
        for invalid in [
            "",
            "yesterday",
            "2026-02-29T00:00:00Z",
            "2026-09-31T00:00:00Z",
            "2026-09-28T24:00:00Z",
            "2026-09-28T00:00:00",
            "2026-09-28T00:00:00+01:00",
            "2026-09-28T00:00:00.Z",
        ] {
            assert!(!utc_timestamp(invalid), "{invalid}");
        }
    }
    #[test]
    fn cap_and_enforcement_are_required_not_defaulted() {
        let base = serde_json::json!({"sub":"s","client_id":"opaque","account_epoch":1,
            "grant_generation":2,"scopes":["ai:invoke"],"spend_cap_2z":null,
            "cap_period":"total","enforced":false,"as_of":"2026-09-28T00:00:00Z"});
        assert!(serde_json::from_value::<Grant>(base.clone()).is_ok());
        for key in [
            "spend_cap_2z",
            "cap_period",
            "enforced",
            "account_epoch",
            "grant_generation",
        ] {
            let mut v = base.clone();
            v.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<Grant>(v).is_err());
        }
        let mut unknown = base;
        unknown["cap_period"] = serde_json::json!("future");
        assert!(serde_json::from_value::<Grant>(unknown).is_err());
    }
}
