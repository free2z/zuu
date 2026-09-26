//! `price_2z` — the cost-plus 2Z pricing formula, in exact integer arithmetic.
//!
//! # The formula
//!
//! ```text
//! p     = cost_usd × 100 × (1 + platform_margin)      2Z owed to the platform side
//! d     = p × dev_markup                              2Z owed to the app developer
//! total = max(min_charge, ceil(p + d))                whole 2Z, ONE ceil
//!
//! provider  = ceil(cost)    milli-2Z   what the model provider is owed
//! developer = floor(d)      milli-2Z   the developer's markup, never rounded up
//! platform  = total − provider − developer   milli-2Z, including the round-up surplus
//! ```
//!
//! 1 2Z corresponds to $0.01 of usage, so `cost_usd × 100` is the cost in 2Z.
//!
//! # Units, and why there are no floats
//!
//! | Quantity | Unit | Type |
//! |---|---|---|
//! | token prices | nano-USD per **million** tokens ([`ModelPrices`]) | `u64` |
//! | per-image / per-tool prices | nano-USD per unit | `u64` |
//! | a cost handed over by a caller | nano-USD ([`Cost::from_nusd`]) | `u64` |
//! | exact internal cost | femto-USD (10⁻¹⁵ USD = 10⁻⁶ nano-USD) | `u128` |
//! | margin and markup | basis points ([`Bps`], 10 000 = 100 %) | `u32` |
//! | minimum charge | whole 2Z | `u64` |
//! | every output | milli-2Z ([`Charge`]) | `u64` |
//!
//! Prices are quoted per million tokens because that is how every provider
//! publishes them, and because a per-token price in nano-USD cannot represent
//! `$0.0375 / 1M` (37.5 nUSD). `tokens × nUSD-per-Mtok` is *exactly* a
//! femto-USD amount, so the cost of any usage vector is an integer with no
//! division at all. The whole formula then reduces to three integer
//! divisions — one `ceil` for the total, one `ceil` for the provider split,
//! one `floor` for the developer split — each over the exact numerator.
//!
//! # Exactly one rounding of the total
//!
//! `total` is `ceil` of the exact rational `p + d`. No intermediate value — not
//! `p`, not `d`, not the cost — is rounded on the way there. Rounding `p` and
//! `d` separately would overcharge: $0.021 at a 10 % developer markup is
//! `p = 2.1`, `d = 0.21`, `ceil(2.31) = 3`, whereas `ceil(2.1) + ceil(0.21)`
//! would be `4`. `fixtures/pricing/worked_examples.json` pins that case.
//!
//! The *splits* are computed from the same exact numerator, and only ever
//! partition `total`: they never change it.
//!
//! # Parity
//!
//! The ledger (SQL) is the authority that settles a charge; this function
//! mirrors it for estimates and holds. The JSON fixtures under
//! `rs/crates/f2z-ai-proto/fixtures/pricing/` are the shared contract the
//! Python and SQL implementations are tested against.

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::chat::Usage;

/// nano-USD in one 2Z. 1 2Z = $0.01 = 10⁷ nUSD.
pub const NUSD_PER_2Z: u64 = 10_000_000;
/// milli-2Z in one 2Z.
pub const MILLI_PER_2Z: u64 = 1_000;
/// Tokens per price unit: token prices are quoted per million tokens.
pub const TOKENS_PER_PRICE_UNIT: u64 = 1_000_000;
/// The basis-point denominator: 10 000 bps = 100 %.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// femto-USD per nano-USD.
const FUSD_PER_NUSD: u128 = 1_000_000;
/// femto-USD per milli-2Z: 10⁴ nUSD × 10⁶.
const FUSD_PER_MILLI_2Z: u128 = 10_000_000_000;
/// femto-USD per 2Z: 10⁷ nUSD × 10⁶.
const FUSD_PER_2Z: u128 = 10_000_000_000_000;
/// `BPS_DENOMINATOR` squared, as `u128`: `(1 + m)(1 + k)` carries two of them.
const BPS_SQUARED: u128 = 100_000_000;
/// `BPS_DENOMINATOR` as `u128`.
const BPS: u128 = 10_000;

/// A proportion in basis points: `Bps(5_000)` is 50 %, `Bps(10_000)` is 100 %.
///
/// Unsigned by construction. A negative platform margin could price a call
/// below cost, which the formula must never do.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Bps(pub u32);

impl Bps {
    /// 0 %.
    pub const ZERO: Self = Self(0);
}

/// Per-model prices from the catalogue.
///
/// Token prices are **nano-USD per million tokens**; image and tool prices are
/// nano-USD per image / per tool call. `$3.00 / 1M` input is
/// `input_nusd_per_mtok: 3_000_000_000`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModelPrices {
    /// Uncached input tokens.
    pub input_nusd_per_mtok: u64,
    /// Input tokens served from the provider's prompt cache.
    pub cached_input_nusd_per_mtok: u64,
    /// Input tokens written to the provider's prompt cache.
    pub cache_write_nusd_per_mtok: u64,
    /// Output tokens, reasoning tokens included.
    pub output_nusd_per_mtok: u64,
    /// Per input image.
    pub image_nusd: u64,
    /// Per server-side tool invocation the catalogue prices.
    pub tool_call_nusd: u64,
}

/// An exact provider cost, in femto-USD (10⁻¹⁵ USD).
///
/// Obtained from a usage vector with [`Cost::of_usage`] (no rounding at all)
/// or from a caller-supplied nano-USD amount with [`Cost::from_nusd`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cost {
    fusd: u128,
}

impl Cost {
    /// A cost stated in whole nano-USD — the unit the ledger's `settle`
    /// receives as `cost_nusd`.
    #[must_use]
    pub fn from_nusd(nusd: u64) -> Self {
        // u64::MAX × 10⁶ < u128::MAX, so this cannot overflow; saturate
        // anyway rather than carry an arithmetic-side-effect allowance.
        Self {
            fusd: u128::from(nusd).saturating_mul(FUSD_PER_NUSD),
        }
    }

    /// The exact cost of `usage` at `prices`: `Σ quantity × price`, with no
    /// division and therefore no rounding.
    ///
    /// # Errors
    ///
    /// [`PricingError::Overflow`] if the cost does not fit in `u128`
    /// femto-USD (about 3.4 × 10²³ USD). Only an absurd usage vector reaches
    /// it.
    pub fn of_usage(usage: &Usage, prices: &ModelPrices) -> Result<Self, PricingError> {
        let per_mtok = [
            (usage.input_tokens, prices.input_nusd_per_mtok),
            (usage.cached_input_tokens, prices.cached_input_nusd_per_mtok),
            (usage.cache_write_tokens, prices.cache_write_nusd_per_mtok),
            (usage.output_tokens, prices.output_nusd_per_mtok),
        ];
        let per_unit = [
            (usage.images, prices.image_nusd),
            (usage.tool_calls, prices.tool_call_nusd),
        ];
        let mut fusd: u128 = 0;
        // tokens × (nUSD / 10⁶ tokens) = 10⁻⁶ nUSD = femto-USD, exactly.
        for (quantity, price) in per_mtok {
            let term = u128::from(quantity).checked_mul(u128::from(price));
            fusd = term
                .and_then(|t| fusd.checked_add(t))
                .ok_or(PricingError::Overflow)?;
        }
        for (quantity, price) in per_unit {
            let term = u128::from(quantity)
                .checked_mul(u128::from(price))
                .and_then(|t| t.checked_mul(FUSD_PER_NUSD));
            fusd = term
                .and_then(|t| fusd.checked_add(t))
                .ok_or(PricingError::Overflow)?;
        }
        Ok(Self { fusd })
    }

    /// The exact cost in femto-USD.
    #[must_use]
    pub fn femto_usd(self) -> u128 {
        self.fusd
    }

    /// The cost rounded **up** to whole nano-USD — the value to hand the
    /// ledger's `settle(cost_nusd)`. Rounding up means the ledger can never be
    /// told a cost below the provider's.
    ///
    /// # Errors
    ///
    /// [`PricingError::Overflow`] if the result does not fit in `u64`.
    pub fn ceil_nusd(self) -> Result<u64, PricingError> {
        u64::try_from(ceil_div(self.fusd, FUSD_PER_NUSD)?).map_err(|_| PricingError::Overflow)
    }
}

/// A priced call, in milli-2Z.
///
/// `total_milli` is always a whole number of 2Z (a multiple of 1 000) and
/// `provider_milli + developer_milli + platform_milli == total_milli`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Charge {
    /// What the user is charged.
    pub total_milli: u64,
    /// `ceil(cost)`: what the model provider is owed.
    pub provider_milli: u64,
    /// `floor(d)`: the registered app's markup, credited to its developer.
    pub developer_milli: u64,
    /// The remainder: platform margin plus the round-up surplus.
    pub platform_milli: u64,
}

impl Charge {
    /// The total in whole 2Z. Exact: `total_milli` is a multiple of 1 000.
    #[must_use]
    pub fn total_2z(&self) -> u64 {
        self.total_milli.checked_div(MILLI_PER_2Z).unwrap_or(0)
    }
}

/// Why a price could not be computed. The only failure is arithmetic overflow
/// on an absurd input; every realistic call prices without error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingError {
    /// An intermediate or final value did not fit its integer type.
    Overflow,
}

impl fmt::Display for PricingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Overflow => f.write_str("price computation overflowed"),
        }
    }
}

impl core::error::Error for PricingError {}

/// Price a call from its usage vector: [`Cost::of_usage`] then
/// [`price_cost`]. The cost is exact, so the total is still rounded once.
///
/// # Errors
///
/// [`PricingError::Overflow`] on an input too large to price.
pub fn price_2z(
    usage: &Usage,
    prices: &ModelPrices,
    platform_margin: Bps,
    dev_markup: Bps,
    min_charge_2z: u64,
) -> Result<Charge, PricingError> {
    price_cost(
        Cost::of_usage(usage, prices)?,
        platform_margin,
        dev_markup,
        min_charge_2z,
    )
}

/// Price an exact cost. See the module documentation for the formula.
///
/// # Errors
///
/// [`PricingError::Overflow`] on an input too large to price.
pub fn price_cost(
    cost: Cost,
    platform_margin: Bps,
    dev_markup: Bps,
    min_charge_2z: u64,
) -> Result<Charge, PricingError> {
    let c = cost.fusd;
    let one_plus_m = BPS
        .checked_add(u128::from(platform_margin.0))
        .ok_or(PricingError::Overflow)?;
    let one_plus_k = BPS
        .checked_add(u128::from(dev_markup.0))
        .ok_or(PricingError::Overflow)?;

    // p + d = c·(1+m)·(1+k), in femto-USD × BPS².
    let p_plus_d = c
        .checked_mul(one_plus_m)
        .and_then(|v| v.checked_mul(one_plus_k))
        .ok_or(PricingError::Overflow)?;
    // THE rounding: ceil to whole 2Z, over the exact numerator.
    let raw_2z = ceil_div(
        p_plus_d,
        BPS_SQUARED
            .checked_mul(FUSD_PER_2Z)
            .ok_or(PricingError::Overflow)?,
    )?;
    let total_2z = raw_2z.max(u128::from(min_charge_2z));
    let total_milli = total_2z
        .checked_mul(u128::from(MILLI_PER_2Z))
        .ok_or(PricingError::Overflow)?;

    // provider = ceil(c) in milli-2Z.
    let provider_milli = ceil_div(c, FUSD_PER_MILLI_2Z)?;
    // developer = floor(d) in milli-2Z, d = c·(1+m)·k (femto-USD × BPS²).
    let d = c
        .checked_mul(one_plus_m)
        .and_then(|v| v.checked_mul(u128::from(dev_markup.0)))
        .ok_or(PricingError::Overflow)?;
    let developer_milli = d
        .checked_div(
            BPS_SQUARED
                .checked_mul(FUSD_PER_MILLI_2Z)
                .ok_or(PricingError::Overflow)?,
        )
        .ok_or(PricingError::Overflow)?;
    // Never negative: total ≥ ceil(c + d) ≥ ceil(c) + floor(d) because the
    // margin is non-negative. A checked_sub keeps that a proof, not a hope.
    let platform_milli = total_milli
        .checked_sub(provider_milli)
        .and_then(|v| v.checked_sub(developer_milli))
        .ok_or(PricingError::Overflow)?;

    Ok(Charge {
        total_milli: to_u64(total_milli)?,
        provider_milli: to_u64(provider_milli)?,
        developer_milli: to_u64(developer_milli)?,
        platform_milli: to_u64(platform_milli)?,
    })
}

/// Tokens counted with a stand-in tokenizer, scaled up by a per-model safety
/// factor (catalogue `safety_factor_bps`) and rounded up. Used to size a hold
/// for a provider whose tokenizer the gateway does not run exactly; a charge
/// is always settled from provider-reported usage, never from this.
///
/// # Errors
///
/// [`PricingError::Overflow`] if the scaled count does not fit in `u64`.
pub fn apply_safety_factor(tokens: u64, safety_factor: Bps) -> Result<u64, PricingError> {
    let scaled = u128::from(tokens)
        .checked_mul(u128::from(safety_factor.0))
        .ok_or(PricingError::Overflow)?;
    to_u64(ceil_div(scaled, BPS)?)
}

fn ceil_div(n: u128, d: u128) -> Result<u128, PricingError> {
    let q = n.checked_div(d).ok_or(PricingError::Overflow)?;
    let r = n.checked_rem(d).ok_or(PricingError::Overflow)?;
    if r == 0 {
        Ok(q)
    } else {
        q.checked_add(1).ok_or(PricingError::Overflow)
    }
}

fn to_u64(v: u128) -> Result<u64, PricingError> {
    u64::try_from(v).map_err(|_| PricingError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worked_example_is_three_2z() {
        // $0.021 at 0 % margin: 2.1 2Z, rounded once, up, to 3.
        let charge = price_cost(Cost::from_nusd(21_000_000), Bps::ZERO, Bps::ZERO, 1).unwrap();
        assert_eq!(
            charge,
            Charge {
                total_milli: 3_000,
                provider_milli: 2_100,
                developer_milli: 0,
                platform_milli: 900,
            }
        );
        assert_eq!(charge.total_2z(), 3);
    }

    #[test]
    fn rounding_p_and_d_separately_would_overcharge() {
        let charge = price_cost(Cost::from_nusd(21_000_000), Bps::ZERO, Bps(1_000), 1).unwrap();
        assert_eq!(
            charge.total_2z(),
            3,
            "ceil(2.1 + 0.21), not ceil(2.1) + ceil(0.21)"
        );
        assert_eq!(charge.developer_milli, 210);
    }

    #[test]
    fn min_charge_applies_to_a_free_call() {
        let charge = price_cost(Cost::default(), Bps(5_000), Bps::ZERO, 1).unwrap();
        assert_eq!(charge.total_milli, 1_000);
        assert_eq!(charge.platform_milli, 1_000);
    }

    #[test]
    fn an_exact_whole_2z_is_not_rounded_up() {
        let charge = price_cost(Cost::from_nusd(20_000_000), Bps::ZERO, Bps::ZERO, 0).unwrap();
        assert_eq!(charge.total_milli, 2_000);
        assert_eq!(charge.platform_milli, 0);
    }

    #[test]
    fn a_sub_nano_usd_cost_is_still_charged() {
        // 1 token at $0.000001/1M = 1 femto-USD. It must still price to ≥ 1 2Z
        // and the provider split must be ≥ 1 milli, never 0.
        let usage = Usage {
            input_tokens: 1,
            ..Usage::default()
        };
        let prices = ModelPrices {
            input_nusd_per_mtok: 1,
            ..ModelPrices::default()
        };
        let charge = price_2z(&usage, &prices, Bps::ZERO, Bps::ZERO, 0).unwrap();
        assert_eq!(charge.total_milli, 1_000);
        assert_eq!(charge.provider_milli, 1);
        assert_eq!(
            Cost::of_usage(&usage, &prices)
                .unwrap()
                .ceil_nusd()
                .unwrap(),
            1
        );
    }

    #[test]
    fn safety_factor_rounds_up() {
        assert_eq!(apply_safety_factor(100, Bps(11_500)).unwrap(), 115);
        assert_eq!(apply_safety_factor(1, Bps(11_500)).unwrap(), 2);
        assert_eq!(apply_safety_factor(7, Bps(10_000)).unwrap(), 7);
    }

    #[test]
    fn overflow_is_an_error_not_a_panic() {
        let usage = Usage {
            output_tokens: u64::MAX,
            ..Usage::default()
        };
        let prices = ModelPrices {
            output_nusd_per_mtok: u64::MAX,
            ..ModelPrices::default()
        };
        assert_eq!(
            price_2z(&usage, &prices, Bps(u32::MAX), Bps(u32::MAX), 0),
            Err(PricingError::Overflow)
        );
    }
}
