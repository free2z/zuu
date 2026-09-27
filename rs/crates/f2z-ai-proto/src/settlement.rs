//! Whether a call's charge is final: the `settlement` field of `done`,
//! `error` and the non-streamed response, and the per-state rules for the
//! amount fields beside it.
//!
//! `docs/sdk/spec/chat-api.md` §3.6–§3.7 and `docs/sdk/spec/metering.md`
//! §3, §5.5, §5.6 and §5.11 are the prose this module encodes.
//!
//! | `settlement` | `charged_2z` | `receipt_id` | `collected` / `shortfall` | `released_2z` |
//! |---|---|---|---|---|
//! | `settled` | present | present iff `charged_2z > 0` | both or neither; `collected = charged × 1000 − shortfall` | `max(0, hold − charged)` |
//! | `pending` | absent | absent | absent | absent |
//! | `released` | absent or `0` | absent | absent or `0` | `= hold` |
//!
//! Under `pending` every amount except `hold_2z` is absent — including
//! `balance_hint_milli_2z` and `cap_remaining_milli_2z`, which describe a
//! settlement that has not happened — and a client reads `GET /v1/calls/{id}`
//! until its `status` is terminal.
//!
//! Decoding is tolerant, as for every response type: a gateway that breaks
//! these rules still decodes, so that a paid-for answer is never discarded
//! over a missing field. The rules are checked by the `check()` methods on
//! [`crate::event::Done`], [`crate::event::ErrorEvent`] and
//! [`crate::chat::ChatResponse`] — what a producer (the gateway, a test
//! double) calls before it emits one, and what a conformance test asserts.

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::amount::{Milli2z, Whole2z};

/// Whether the charge reported beside it is final.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Settlement {
    /// The ledger has confirmed the charge; the amounts are final. The
    /// default when the field is absent.
    #[default]
    Settled,
    /// The ledger had not confirmed the charge within 10 s of the provider
    /// finishing (or delivery ended with `delivery_aborted`). Every amount
    /// except `hold_2z` is absent; read `GET /v1/calls/{id}` until its
    /// `status` is terminal.
    Pending,
    /// The settler found the hold already expired: nothing was charged and
    /// no receipt exists. The platform pays the provider.
    Released,
    /// A value newer than this crate. Deserialization only. A client treats
    /// it as not final and reads the call record.
    #[serde(other)]
    Unknown,
}

impl Settlement {
    /// The wire string, e.g. `"pending"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Pending => "pending",
            Self::Released => "released",
            Self::Unknown => "unknown",
        }
    }

    /// Whether the amounts beside it are final (`settled` or `released`).
    #[must_use]
    pub fn is_final(self) -> bool {
        matches!(self, Self::Settled | Self::Released)
    }
}

impl fmt::Display for Settlement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A settlement-bearing payload that breaks the rules of its `settlement`
/// state. Each variant names the wire field at fault.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementError {
    /// `settlement` is a value this crate does not know; nothing can be
    /// checked, and a producer must not emit it.
    UnknownSettlement,
    /// A field the state requires is absent.
    Missing(&'static str),
    /// A field the state forbids is present (or, for `released`, non-zero).
    Unexpected(&'static str),
    /// A successful settled call charged `0`: every model's minimum charge is
    /// at least 1 2Z.
    ZeroCharge,
    /// `collected_milli_2z ≠ charged_2z × 1000 − shortfall_milli_2z`.
    CollectedMismatch,
    /// `released_2z` is not what the hold and the charge leave:
    /// `max(0, hold − charged)` when settled, `hold` when released.
    ReleasedMismatch,
    /// A shortfall inside the hold: the hold was already reserved, so a
    /// write-off can only be of the part of the charge above it.
    ShortfallWithinHold,
    /// `delivery_aborted` with a `settlement` other than `pending`: the call
    /// is still running upstream when delivery ends.
    DeliveryAbortedNotPending,
    /// An amount too large to check.
    Overflow,
}

impl fmt::Display for SettlementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSettlement => f.write_str("unknown settlement state"),
            Self::Missing(field) => write!(f, "{field} is required in this settlement state"),
            Self::Unexpected(field) => {
                write!(f, "{field} is not allowed in this settlement state")
            }
            Self::ZeroCharge => f.write_str("a settled successful call charges at least 1 2Z"),
            Self::CollectedMismatch => {
                f.write_str("collected_milli_2z must equal charged_2z × 1000 − shortfall_milli_2z")
            }
            Self::ReleasedMismatch => {
                f.write_str("released_2z does not match hold_2z and charged_2z")
            }
            Self::ShortfallWithinHold => {
                f.write_str("shortfall_milli_2z exceeds the part of the charge above the hold")
            }
            Self::DeliveryAbortedNotPending => {
                f.write_str("delivery_aborted must carry settlement \"pending\"")
            }
            Self::Overflow => f.write_str("amount overflow"),
        }
    }
}

impl core::error::Error for SettlementError {}

/// The settlement-relevant fields of a payload, borrowed for one check.
pub(crate) struct Fields<'a> {
    pub settlement: Settlement,
    pub charged_2z: Option<Whole2z>,
    pub receipt_id: Option<&'a str>,
    pub collected_milli_2z: Option<Milli2z>,
    pub shortfall_milli_2z: Option<Milli2z>,
    /// `None` for a payload that has no such field (`error`).
    pub hold_2z: Option<Whole2z>,
    pub released_2z: Option<Whole2z>,
    /// Amounts that exist only once a settlement happened
    /// (`balance_hint_milli_2z`, `cap_remaining_milli_2z`), by wire name,
    /// with whether each is present.
    pub post_settlement: &'a [(&'static str, bool)],
    /// A successful completion (`done`, a `200` response): a settled one
    /// charges at least the minimum, which is never below 1 2Z. An `error`
    /// before any output settles at `0`.
    pub success: bool,
}

pub(crate) fn check(f: &Fields<'_>) -> Result<(), SettlementError> {
    match f.settlement {
        Settlement::Unknown => Err(SettlementError::UnknownSettlement),
        Settlement::Pending => check_pending(f),
        Settlement::Released => check_released(f),
        Settlement::Settled => check_settled(f),
    }
}

fn check_pending(f: &Fields<'_>) -> Result<(), SettlementError> {
    let forbidden = [
        ("charged_2z", f.charged_2z.is_some()),
        ("receipt_id", f.receipt_id.is_some()),
        ("collected_milli_2z", f.collected_milli_2z.is_some()),
        ("shortfall_milli_2z", f.shortfall_milli_2z.is_some()),
        ("released_2z", f.released_2z.is_some()),
    ];
    for (field, present) in forbidden.iter().chain(f.post_settlement) {
        if *present {
            return Err(SettlementError::Unexpected(field));
        }
    }
    Ok(())
}

fn check_released(f: &Fields<'_>) -> Result<(), SettlementError> {
    if f.receipt_id.is_some() {
        return Err(SettlementError::Unexpected("receipt_id"));
    }
    if f.charged_2z.is_some_and(|c| c != Whole2z::ZERO) {
        return Err(SettlementError::Unexpected("charged_2z"));
    }
    if f.collected_milli_2z.is_some_and(|c| c != Milli2z::ZERO) {
        return Err(SettlementError::Unexpected("collected_milli_2z"));
    }
    if f.shortfall_milli_2z.is_some_and(|s| s != Milli2z::ZERO) {
        return Err(SettlementError::Unexpected("shortfall_milli_2z"));
    }
    if let (Some(hold), Some(released)) = (f.hold_2z, f.released_2z)
        && hold != released
    {
        return Err(SettlementError::ReleasedMismatch);
    }
    Ok(())
}

fn check_settled(f: &Fields<'_>) -> Result<(), SettlementError> {
    let charged = f.charged_2z.ok_or(SettlementError::Missing("charged_2z"))?;
    if f.success && charged == Whole2z::ZERO {
        return Err(SettlementError::ZeroCharge);
    }
    match (charged == Whole2z::ZERO, f.receipt_id) {
        (false, None) => return Err(SettlementError::Missing("receipt_id")),
        (false, Some("")) => return Err(SettlementError::Missing("receipt_id")),
        (true, Some(_)) => return Err(SettlementError::Unexpected("receipt_id")),
        _ => {}
    }
    let charged_milli = charged.to_milli().ok_or(SettlementError::Overflow)?;
    match (f.collected_milli_2z, f.shortfall_milli_2z) {
        (None, None) => {}
        (Some(_), None) => return Err(SettlementError::Missing("shortfall_milli_2z")),
        (None, Some(_)) => return Err(SettlementError::Missing("collected_milli_2z")),
        (Some(collected), Some(shortfall)) => {
            if charged_milli.checked_sub(shortfall) != Some(collected) {
                return Err(SettlementError::CollectedMismatch);
            }
            if let Some(hold) = f.hold_2z {
                let above_hold = charged
                    .saturating_sub(hold)
                    .to_milli()
                    .ok_or(SettlementError::Overflow)?;
                if shortfall > above_hold {
                    return Err(SettlementError::ShortfallWithinHold);
                }
            }
        }
    }
    if let (Some(hold), Some(released)) = (f.hold_2z, f.released_2z)
        && released != hold.saturating_sub(charged)
    {
        return Err(SettlementError::ReleasedMismatch);
    }
    Ok(())
}

/// `Option<Option<T>>` that keeps "absent" (`None`) apart from `null`
/// (`Some(None)`): `cap_remaining_milli_2z` is `null` for an uncapped grant
/// and absent while settlement is pending. Use with `#[serde(default)]`.
pub(crate) fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}
