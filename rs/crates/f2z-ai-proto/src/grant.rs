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
fn required_cap<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Whole2z>, D::Error> {
    Option::deserialize(d)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
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
