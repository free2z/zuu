//! Which form a keyed call was claimed under, so that a same-key retry that
//! straddles a `child_directed` flip or a key rotation replays that call
//! instead of becoming a second, paid one (tuzi#2639).
//!
//! The ledger keeps one form per call. A child-directed app's claim carries
//! HMACs of the fingerprint and the `Idempotency-Key`
//! ([`crate::meter::ChildDirectedKey`]); every other app's carries the
//! unkeyed SHA-256 and the key as sent. When the app's flag flips, or the
//! HMAC key rotates, a retry derives the other form, and `ledger.call_claim`
//! — which has no lookup-only mode — would insert a new call for it.
//!
//! So after every keyed claim that inserts a call, the gateway writes a
//! [`Record`] to Redis: the form the call was claimed under and its call id.
//! The record's Redis key is an HMAC of the `Idempotency-Key` under the
//! current server key, computed the same way whatever the app's flag says,
//! so the caller's key text is never stored. A keyed request reads it first.
//! If the record names a form other than the one this request derives, the
//! claim names the **recorded call id** with the fingerprint in the recorded
//! form; `call_claim` then resolves the existing call by id (call rows live
//! 90 days, longer than a record) and replays it, reports it pending, or
//! refuses a changed request — and inserts nothing. The canonical
//! `Idempotency-Key` form is what the claim carries, so a child-directed
//! caller never sends the key text even when it replays a call claimed in
//! the plain form.
//!
//! What it does not cover falls back to the canonical form, the behaviour
//! before this existed. Counted under `f2z_ai_idempotency_forms_total`
//! (`crate::metrics`): Redis unavailable, a failed record write, a record
//! naming a key no longer configured, a recorded call the ledger no longer
//! holds. Not countable, because they look like a first request: a record
//! evicted or lost to a Redis restart or flush, and a crash between the
//! claim and the record write.

use std::time::Duration;

use async_trait::async_trait;
use uuid::Uuid;

use crate::auth::store::StoreError;

/// How long a record lives: the ledger's idempotency key lifetime
/// ([`crate::ledger::IDEMPOTENCY_KEY_LIFETIME`], 24 h) plus
/// [`RECORD_TTL_MARGIN`], so 24 h 10 m. A record must outlive the key row it
/// describes: while the key row lives, a straddling retry with no record
/// claims in its canonical form and is charged a second time, counted only as
/// a `miss` (tuzi#2670 — the 23 h 50 m this replaced left the window's last
/// 10 minutes exposed). Outliving the key row is harmless: the retry names the
/// recorded call id, and call rows live 90 days, so it replays the call
/// instead of charging.
pub const RECORD_TTL: Duration =
    crate::ledger::IDEMPOTENCY_KEY_LIFETIME.saturating_add(RECORD_TTL_MARGIN);

/// How much longer a record lives than the ledger key. The key's expiry is
/// read on Postgres's clock from the claim's transaction start; the record's
/// `PX` runs on Redis's clock from its write, which follows the claim. The
/// margin absorbs skew between those two clocks and a slow claim-to-write
/// path, and costs 10 / 1440 ≈ 0.7 % more record memory.
pub const RECORD_TTL_MARGIN: Duration = Duration::from_secs(10 * 60);

/// The Redis operations the form records need.
#[async_trait]
pub trait FormStore: Send + Sync + 'static {
    /// `MGET`: each key's value, or `None` when absent.
    async fn get(&self, keys: &[String]) -> Result<Vec<Option<String>>, StoreError>;
    /// `SET key value PX ttl`.
    async fn put(&self, key: &str, value: &str, ttl: Duration) -> Result<(), StoreError>;
}

/// The form a call's fingerprint and `Idempotency-Key` were claimed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Form {
    /// The unkeyed SHA-256 fingerprint and the key as sent.
    Plain,
    /// HMACs under the child-directed key with this id
    /// ([`crate::meter::ChildDirectedKey::id`]).
    Keyed(String),
}

/// One record: a keyed call's form and id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// The form the call was claimed in.
    pub form: Form,
    /// The call it claimed.
    pub call: Uuid,
}

impl Record {
    /// `v1:plain:<call>` or `v1:keyed:<key id>:<call>`.
    #[must_use]
    pub fn encode(&self) -> String {
        match &self.form {
            Form::Plain => format!("v1:plain:{}", self.call),
            Form::Keyed(kid) => format!("v1:keyed:{kid}:{}", self.call),
        }
    }

    /// The inverse of [`Record::encode`]; `None` for anything else.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let rest = text.strip_prefix("v1:")?;
        let (form, call) = if let Some(call) = rest.strip_prefix("plain:") {
            (Form::Plain, call)
        } else {
            let (kid, call) = rest.strip_prefix("keyed:")?.split_once(':')?;
            if kid.is_empty() || !kid.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            (Form::Keyed(kid.to_owned()), call)
        };
        Some(Self {
            form,
            call: call.parse().ok()?,
        })
    }
}

/// The Redis key of a record: `<ns>:ai:idem:<sub>:<app>:<mac>`, where `mac`
/// is [`crate::meter::ChildDirectedKey`]'s record HMAC of the
/// `Idempotency-Key`. Scoped like the ledger's key: per account and app.
#[must_use]
pub fn record_key(namespace: &str, subject: Uuid, app: Uuid, mac: &str) -> String {
    format!("{namespace}:ai:idem:{subject}:{app}:{mac}")
}

/// What became of one keyed request's form lookup. A closed set: these are
/// the `outcome` label values of `f2z_ai_idempotency_forms_total`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No record: a first request, or one whose record expired.
    Miss,
    /// The record names the form this request derives anyway.
    Same,
    /// The record names another form: the claim named its call.
    Straddle,
    /// Degraded: Redis failed or timed out; the canonical form was used.
    Unavailable,
    /// Degraded: a record that does not parse, or names a key this gateway
    /// no longer holds; the canonical form was used.
    UnknownRecord,
    /// Degraded: the record for a new call could not be written.
    WriteFailed,
    /// Degraded: a claim by a recorded call id inserted a call, so the
    /// ledger no longer held the call the record named.
    Orphaned,
}

impl Outcome {
    /// Every outcome, in rendering order.
    pub const ALL: [Self; 7] = [
        Self::Miss,
        Self::Same,
        Self::Straddle,
        Self::Unavailable,
        Self::UnknownRecord,
        Self::WriteFailed,
        Self::Orphaned,
    ];

    /// The metric label.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Miss => "miss",
            Self::Same => "same",
            Self::Straddle => "straddle",
            Self::Unavailable => "unavailable",
            Self::UnknownRecord => "unknown_record",
            Self::WriteFailed => "write_failed",
            Self::Orphaned => "orphaned",
        }
    }

    /// Whether this outcome left a straddling retry exposed to a second
    /// charge (the alert's numerator).
    #[must_use]
    pub const fn degraded(self) -> bool {
        matches!(
            self,
            Self::Unavailable | Self::UnknownRecord | Self::WriteFailed | Self::Orphaned
        )
    }

    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Miss => 0,
            Self::Same => 1,
            Self::Straddle => 2,
            Self::Unavailable => 3,
            Self::UnknownRecord => 4,
            Self::WriteFailed => 5,
            Self::Orphaned => 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_and_refuse_anything_else() {
        let call: Uuid = "01920000-0000-7000-8000-000000000001".parse().unwrap();
        for form in [Form::Plain, Form::Keyed("0123456789abcdef".into())] {
            let record = Record { form, call };
            assert_eq!(Record::parse(&record.encode()), Some(record));
        }
        for bad in [
            "",
            "plain:01920000-0000-7000-8000-000000000001",
            "v2:plain:01920000-0000-7000-8000-000000000001",
            "v1:plain:not-a-uuid",
            "v1:keyed::01920000-0000-7000-8000-000000000001",
            "v1:keyed:zz:01920000-0000-7000-8000-000000000001",
            "v1:keyed:01920000-0000-7000-8000-000000000001",
        ] {
            assert_eq!(Record::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn labels_are_distinct_and_indexes_dense() {
        let mut labels: Vec<_> = Outcome::ALL.iter().map(|o| o.label()).collect();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), Outcome::ALL.len());
        for (i, outcome) in Outcome::ALL.iter().enumerate() {
            assert_eq!(outcome.index(), i);
        }
    }
}
