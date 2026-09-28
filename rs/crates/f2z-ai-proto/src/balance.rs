//! `GET https://free2z.cash/api/sdk/v1/balance` — the account's balance, as
//! `docs/free2z/sdk/spec/purchase.md` §1.1 defines it.
//!
//! The endpoint belongs to the account API, not the gateway, but its numbers
//! are the ones every `/v1/chat` hint (`balance_hint_milli_2z`) and refusal
//! (`insufficient_balance`, `account_in_debt`) is about, so the type lives
//! beside them: an SDK decodes the hint and the authority with one set of
//! amount types.

use alloc::string::String;

use serde::{Deserialize, Serialize};

use crate::amount::Milli2z;

/// The account's balance.
///
/// `available = balance − held`. While `debt_milli_2z` is non-zero,
/// `available_milli_2z` is `0` and every spend is refused with
/// `403 account_in_debt`; the next credit repays the debt first. Apps show
/// `available`, and show a debt as its own line — it is never folded into
/// `balance_milli_2z`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Balance {
    /// What can be spent now: `balance − held`.
    pub available_milli_2z: Milli2z,
    /// The sum of open AI-call holds.
    pub held_milli_2z: Milli2z,
    /// The balance, holds included.
    pub balance_milli_2z: Milli2z,
    /// What the account owes after a reversal took back 2Z already spent.
    /// Always present on the wire, never negative; `0` when absent so an
    /// older server does not make the balance undecodable.
    #[serde(default)]
    pub debt_milli_2z: Milli2z,
    /// When the numbers were read, RFC 3339 UTC.
    pub as_of: String,
}

impl Balance {
    /// Whether the account is in debt, and so cannot spend.
    #[must_use]
    pub fn in_debt(&self) -> bool {
        self.debt_milli_2z != Milli2z::ZERO
    }
}
