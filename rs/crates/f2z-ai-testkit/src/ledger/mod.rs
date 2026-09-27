//! The ledger contract the gateway meters against, and an in-memory fake.
//!
//! `docs/sdk/spec/metering.md` §3 (zuu #1051, **provisional** — in review when
//! this was written) specifies five operations, and ADR 0002 makes them the
//! only authority on whether 2Z can be reserved or charged:
//!
//! | Operation | Here |
//! |---|---|
//! | inquire — read-only, advisory | [`LedgerContract::inquire`] → [`Inquiry`] |
//! | hold — atomic check-and-reserve, keyed on the call | [`LedgerContract::hold`] → [`HoldOutcome`] |
//! | extend — absolute target, pushes the expiry | [`LedgerContract::extend`] → [`ExtendOutcome`] |
//! | settle — idempotent, never fails for lack of balance | [`LedgerContract::settle`] → [`SettleOutcome`] |
//! | release — idempotent | [`LedgerContract::release`] → [`ReleaseOutcome`] |
//! | expire — the platform's sweeper | [`InMemoryLedger::expire_due`] (not on the trait: the gateway never calls it) |
//!
//! The trait is what a gateway codes against; [`InMemoryLedger`] is one
//! implementation of it, so tests can run the whole hold → stream → settle
//! lifecycle, and every edge case of metering.md §5, without Postgres. When
//! the contract changes in review, the trait changes and the fake follows.
//!
//! Amounts follow metering.md §1: holds and charges in whole 2Z (`_2z`),
//! balances, caps, collections and splits in milli-2Z (`_milli_2z`), provider
//! cost in nano-USD. Pricing is [`f2z_ai_proto::pricing::price_nusd`] over the
//! hold's snapshot — never a second implementation.

mod memory;

use core::fmt;
use core::future::Future;
use core::time::Duration;

use f2z_ai_proto::Usage;
use f2z_ai_proto::chat::UsageSource;
use f2z_ai_proto::pricing::{Bps, ModelPrices, PricingError};

pub use memory::{CallRecord, GrantConfig, InMemoryLedger, LedgerTotals, MAX_OPEN_HOLDS};

/// A hold's identity, as the ledger issued it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HoldId(pub u64);

impl fmt::Display for HoldId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hold_{}", self.0)
    }
}

/// `hold_key` of metering.md §3: `(app, user, idempotency key, attempt)`.
/// A second hold with the same key is a replay of the first.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HoldKey {
    /// The registered app.
    pub app: String,
    /// The user.
    pub user: String,
    /// The call's idempotency key.
    pub idempotency_key: String,
    /// `1` for a call, `2` for its `fallback` retry.
    pub attempt: u8,
}

/// The one state a hold is in. The first terminal transition wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HoldState {
    /// Reserved, not yet terminal.
    Open,
    /// Charged by a settle.
    Settled,
    /// Released whole by a release.
    Released,
    /// Passed its expiry unsettled and released by the sweeper.
    Expired,
}

/// The answer to [`LedgerContract::inquire`]. Advisory: the hold decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inquiry {
    /// Balance minus open holds, in milli-2Z.
    pub available_milli_2z: u64,
    /// The grant's remaining cap for the current period, or `None` when
    /// uncapped.
    pub cap_remaining_milli_2z: Option<u64>,
    /// The user's open holds.
    pub open_holds: u32,
    /// Whether the account is frozen.
    pub frozen: bool,
}

/// The arguments of [`LedgerContract::hold`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldRequest {
    /// The user whose balance is reserved.
    pub user: String,
    /// The app the grant belongs to.
    pub app: String,
    /// The reservation, in whole 2Z. Must be at least 1.
    pub amount_2z: u64,
    /// The call's idempotency identity.
    pub hold_key: HoldKey,
    /// The account epoch the token carried (`aep`).
    pub aep: u64,
    /// The grant generation the token carried (`agen`).
    pub agen: u64,
    /// The catalogue model id, whose `min_charge_2z` the snapshot records.
    pub model_id: String,
    /// The rate card to price the settlement with.
    pub rate_card_version: u64,
    /// The catalogue version, recorded for reference only.
    pub catalog_version: u64,
    /// The markup the gateway believes the user consented to. Must equal the
    /// grant's.
    pub markup_bps: Bps,
    /// Time to expiry if never extended.
    pub ttl: Duration,
}

/// A granted hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeldHold {
    /// The new hold.
    pub hold_id: HoldId,
    /// Balance minus open holds after this one, in milli-2Z.
    pub available_milli_2z: u64,
    /// Remaining cap after this hold, or `None` when uncapped.
    pub cap_remaining_milli_2z: Option<u64>,
    /// When it expires unless extended, in the ledger clock's milliseconds.
    pub expires_at_ms: u64,
}

/// The answer to [`LedgerContract::hold`].
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldOutcome {
    /// Reserved.
    Held(HeldHold),
    /// The same `hold_key` was held before: that hold, in whatever state it is.
    Replayed {
        /// The original hold.
        hold_id: HoldId,
        /// Its current state.
        state: HoldState,
    },
    /// `available_milli_2z < amount_2z × 1000`.
    InsufficientBalance,
    /// The grant's cap for the period does not cover the amount.
    CapExceeded,
    /// The account is frozen.
    Frozen,
    /// The grant is revoked or missing, or `aep` / `agen` is stale.
    Revoked,
    /// `markup_bps` differs from the grant's consented markup.
    MarkupMismatch,
    /// The rate card, or the model in it, is unknown.
    UnknownRateCard,
    /// The user already has [`MAX_OPEN_HOLDS`] open holds.
    TooManyHolds,
    /// `amount_2z` was zero. Not in the spec's list: a hold is never below a
    /// model's minimum charge, which is at least 1, so this is a caller bug
    /// the fake reports rather than reserves nothing for.
    InvalidAmount,
}

/// The answer to [`LedgerContract::extend`]. Every variant but `NotOpen` and
/// `UnknownHold` has pushed the expiry out.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtendOutcome {
    /// Extended; `reserved_2z` is the reservation now in force.
    Held {
        /// The reservation in force.
        reserved_2z: u64,
        /// The new expiry.
        expires_at_ms: u64,
    },
    /// The raise could not be afforded; the reservation is unchanged but the
    /// expiry was pushed, so the stream continues.
    InsufficientBalance {
        /// The (unchanged) reservation in force.
        reserved_2z: u64,
        /// The new expiry.
        expires_at_ms: u64,
    },
    /// The raise exceeds the cap; as `InsufficientBalance` otherwise.
    CapExceeded {
        /// The (unchanged) reservation in force.
        reserved_2z: u64,
        /// The new expiry.
        expires_at_ms: u64,
    },
    /// The hold is terminal.
    NotOpen {
        /// Which terminal state.
        state: HoldState,
    },
    /// No such hold.
    UnknownHold,
}

/// The arguments of [`LedgerContract::settle`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleRequest {
    /// The hold to settle.
    pub hold_id: HoldId,
    /// The metered provider cost (`f2z_ai_proto::metered_cost_nusd`), the one
    /// number that crosses from the gateway to the ledger.
    pub cost_nusd: u64,
    /// The usage it was metered from, recorded with the call.
    pub usage: Usage,
    /// Whether the usage was provider-reported or estimated.
    pub source: UsageSource,
}

/// A settlement. Returned again, unchanged, by every later settle of the hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    /// The settled hold.
    pub hold_id: HoldId,
    /// The settlement's own id.
    pub receipt_id: String,
    /// The price, in whole 2Z — the price even when less was collected.
    pub charged_2z: u64,
    /// What was actually taken from the user.
    pub collected_milli_2z: u64,
    /// `charged_2z × 1000 − collected_milli_2z`: written off by the platform.
    pub shortfall_milli_2z: u64,
    /// The provider's part of the collection.
    pub provider_milli_2z: u64,
    /// The developer's part (their markup, reduced first by a shortfall after
    /// the platform's).
    pub developer_milli_2z: u64,
    /// The platform's part; negative only in a shortfall — its loss.
    pub platform_milli_2z: i64,
    /// The user's available balance after settlement (the `balance_hint`).
    pub available_milli_2z: u64,
    /// The grant's remaining cap in the hold's period after settlement.
    pub cap_remaining_milli_2z: Option<u64>,
}

/// The answer to [`LedgerContract::settle`].
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettleOutcome {
    /// Settled — by this call, or by an earlier one whose result this is.
    Settled(Settlement),
    /// Released or expired first: nothing is charged; the provider's cost is
    /// the platform's (metering.md §5.6).
    NotOpen {
        /// Which terminal state.
        state: HoldState,
    },
    /// No such hold.
    UnknownHold,
}

/// The answer to [`LedgerContract::release`].
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseOutcome {
    /// Released, by this call or an earlier one.
    Released,
    /// It had expired.
    Expired,
    /// A settle won; the settlement stands.
    Settled,
    /// No such hold.
    UnknownHold,
}

/// Why an operation did not produce an answer at all.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError {
    /// The ledger could not be reached (injected by
    /// [`InMemoryLedger::fail_next`]). The operation did not happen.
    Unavailable,
    /// The user has no account.
    UnknownAccount,
    /// Pricing overflowed on an absurd cost.
    Pricing(PricingError),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => f.write_str("ledger unavailable"),
            Self::UnknownAccount => f.write_str("unknown account"),
            Self::Pricing(e) => write!(f, "pricing failed: {e}"),
        }
    }
}

impl std::error::Error for LedgerError {}

/// One model in a [`RateCard`]: what a hold snapshots.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateCardModel {
    /// Provider prices, used to cross-check a settle's `cost_nusd` against its
    /// usage ([`CallRecord::metered_from_usage`]).
    pub prices: ModelPrices,
    /// The minimum charge, whole 2Z, at least 1.
    pub min_charge_2z: u64,
}

/// A versioned rate card the ledger holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateCard {
    /// Its version.
    pub version: u64,
    /// The platform margin.
    pub platform_margin_bps: Bps,
    /// Per model id.
    pub models: std::collections::BTreeMap<String, RateCardModel>,
}

impl RateCard {
    /// The rate card a signed catalogue names: its margin and every model's
    /// prices and minimum charge.
    #[must_use]
    pub fn from_catalog(catalog: &f2z_ai_proto::catalog::Catalog) -> Self {
        Self {
            version: catalog.rate_card_version,
            platform_margin_bps: catalog.platform_margin_bps,
            models: catalog
                .models
                .iter()
                .map(|m| {
                    (
                        m.id.clone(),
                        RateCardModel {
                            prices: m.prices,
                            min_charge_2z: m.min_charge_2z,
                        },
                    )
                })
                .collect(),
        }
    }
}

/// The ledger operations the gateway is allowed, and nothing else
/// (ADR 0002). Futures are `Send` so a multi-threaded gateway can hold them
/// across `.await`.
pub trait LedgerContract: Send + Sync {
    /// Read-only: what a hold for `(user, app)` could reserve right now.
    fn inquire(
        &self,
        user: &str,
        app: &str,
    ) -> impl Future<Output = Result<Inquiry, LedgerError>> + Send;

    /// Atomically check and reserve.
    fn hold(
        &self,
        request: HoldRequest,
    ) -> impl Future<Output = Result<HoldOutcome, LedgerError>> + Send;

    /// Push the expiry to now + `ttl` and raise the reservation to
    /// `reserve_to_2z` if that is higher (an absolute target).
    fn extend(
        &self,
        hold_id: HoldId,
        reserve_to_2z: u64,
        ttl: Duration,
    ) -> impl Future<Output = Result<ExtendOutcome, LedgerError>> + Send;

    /// Price, charge, release the rest, record. Idempotent per hold.
    fn settle(
        &self,
        request: SettleRequest,
    ) -> impl Future<Output = Result<SettleOutcome, LedgerError>> + Send;

    /// Release the whole hold. Idempotent.
    fn release(
        &self,
        hold_id: HoldId,
    ) -> impl Future<Output = Result<ReleaseOutcome, LedgerError>> + Send;
}
