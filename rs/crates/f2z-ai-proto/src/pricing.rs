//! `price_2z` — the cost-plus 2Z pricing formula, in exact integer arithmetic.
//!
//! # Two steps: meter, then price
//!
//! ```text
//! 1. meter   cost_nusd = ceil( Σ quantity × unit price )          whole nano-USD
//!
//! 2. price   p     = cost_usd × 100 × (1 + platform_margin)       2Z
//!            d     = p × dev_markup                               2Z
//!            total = max(min_charge, ceil(p + d))                 whole 2Z, ONE ceil
//!
//!            provider  = ceil(cost)                  milli-2Z  what the model provider is owed
//!            developer = floor(d)                    milli-2Z  the markup, never rounded up
//!            platform  = total − provider − developer  milli-2Z, incl. the round-up surplus
//! ```
//!
//! 1 2Z corresponds to $0.01 of usage, so `cost_usd × 100` is the cost in 2Z.
//!
//! **`cost_nusd` is the one number that crosses to the ledger.** The gateway
//! meters a call with [`metered_cost_nusd`] and hands that integer to the
//! ledger's settle; the ledger applies step 2. [`price_2z`] is exactly
//! `price_nusd(metered_cost_nusd(usage))`, so an estimate or hold computed here
//! and the settled charge are computed from the *same integer*. Pricing the
//! exact sub-nano-USD cost directly would not be: 100 001 tokens at
//! 66 666 000 nUSD per million is exactly 6 666 666.666 nUSD, which at a 50 %
//! margin is 0.99999… 2Z and rounds to 1 — while the metered 6 666 667 nUSD is
//! 1.00000005 2Z and rounds to 2.
//! `fixtures/pricing/from_usage.json` pins that boundary.
//!
//! Metering rounds **up** to whole nano-USD (10⁻⁷ 2Z), so the ledger is never
//! told a cost below the provider's. That quantization is a property of the
//! unit, not a second rounding of the price: the 2Z amount is rounded exactly
//! once, in step 2.
//!
//! # Units, and why there are no floats
//!
//! | Quantity | Unit | Type |
//! |---|---|---|
//! | token prices | nano-USD per **million** tokens ([`ModelPrices`]) | `u64` |
//! | per-image / per-tool prices | nano-USD per unit | `u64` |
//! | metered cost | nano-USD | [`Nusd`] |
//! | margin and markup | basis points ([`Bps`], 10 000 = 100 %) | `u32` |
//! | minimum charge | whole 2Z | [`Whole2z`] |
//! | every output | milli-2Z ([`Charge`]) | [`Milli2z`] |
//!
//! The amount types are newtypes ([`crate::amount`]) so that a nano-USD cost
//! cannot be added to a milli-2Z split by accident; the arithmetic inside
//! this module unwraps them once, computes in `u128`, and wraps the result.
//!
//! Prices are quoted per million tokens because that is how every provider
//! publishes them, and because a per-token price in nano-USD cannot represent
//! `$0.0375 / 1M` (37.5 nUSD). `tokens × nUSD-per-Mtok` is exactly 10⁻⁶ nUSD,
//! so step 1 sums integers and divides once.
//!
//! # Exactly one rounding of the total
//!
//! `total` is `ceil` of the exact rational `p + d`. Neither `p` nor `d` is
//! rounded on the way there. Rounding them separately would overcharge:
//! $0.021 at a 10 % developer markup is `p = 2.1`, `d = 0.21`,
//! `ceil(2.31) = 3`, whereas `ceil(2.1) + ceil(0.21)` would be `4`.
//! `fixtures/pricing/worked_examples.json` pins that case.
//!
//! The *splits* are computed from the same exact numerator, and only ever
//! partition `total`: they never change it.
//!
//! # Parity
//!
//! The ledger (SQL) is the authority that settles a charge; this module
//! mirrors it for estimates and holds. The JSON fixtures under
//! `rs/crates/f2z-ai-proto/fixtures/pricing/` are the shared contract the
//! Python and SQL implementations are tested against.

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::amount::{Milli2z, Nusd, Whole2z};
use crate::chat::Usage;

/// nano-USD in one 2Z. 1 2Z = $0.01 = 10⁷ nUSD.
pub const NUSD_PER_2Z: u64 = 10_000_000;
/// nano-USD in one milli-2Z.
pub const NUSD_PER_MILLI_2Z: u64 = 10_000;
/// milli-2Z in one 2Z.
pub const MILLI_PER_2Z: u64 = 1_000;
/// Tokens per price unit: token prices are quoted per million tokens.
pub const TOKENS_PER_PRICE_UNIT: u64 = 1_000_000;
/// The basis-point denominator: 10 000 bps = 100 %.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// `BPS_DENOMINATOR` as `u128`.
const BPS: u128 = 10_000;
/// `BPS_DENOMINATOR` squared: `(1 + m)(1 + k)` carries two of them.
const BPS_SQUARED: u128 = 100_000_000;

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
///
/// Unknown members are ignored so additive gateway catalogue metadata does
/// not break clients. A new price dimension still requires a catalogue schema
/// bump ([`crate::catalog::CATALOG_SCHEMA`]); consumers must validate the
/// supported schema before pricing because an unrecognized dimension is not
/// represented by this type.
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

/// A priced call, in milli-2Z.
///
/// `total_milli` is always a whole number of 2Z (a multiple of 1 000) and
/// `provider_milli + developer_milli + platform_milli == total_milli`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Charge {
    /// What the user is charged.
    pub total_milli: Milli2z,
    /// `ceil(cost)`: what the model provider is owed.
    pub provider_milli: Milli2z,
    /// `floor(d)`: the registered app's markup, credited to its developer.
    pub developer_milli: Milli2z,
    /// The remainder: platform margin plus the round-up surplus.
    pub platform_milli: Milli2z,
}

impl Charge {
    /// The total in whole 2Z. Exact: `total_milli` is a multiple of 1 000.
    #[must_use]
    pub fn total_2z(&self) -> Whole2z {
        Whole2z::new(
            self.total_milli
                .get()
                .checked_div(MILLI_PER_2Z)
                .unwrap_or(0),
        )
    }
}

/// Why a price could not be computed. The only failure is arithmetic overflow
/// on an absurd input; every realistic call prices without error.
#[non_exhaustive]
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

/// Step 1: the cost of `usage` at `prices`, rounded **up** to whole nano-USD.
///
/// This is the `cost_nusd` the gateway hands to the ledger's settle.
///
/// # Errors
///
/// [`PricingError::Overflow`] if the cost does not fit in `u64` nano-USD
/// (about $1.8 × 10¹⁰). Only an absurd usage vector reaches it.
pub fn metered_cost_nusd(usage: &Usage, prices: &ModelPrices) -> Result<Nusd, PricingError> {
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
    // Accumulate in 10⁻⁶ nUSD: tokens × (nUSD / 10⁶ tokens), exactly.
    let mut micro_nusd: u128 = 0;
    for (quantity, price) in per_mtok {
        let term = u128::from(quantity).checked_mul(u128::from(price));
        micro_nusd = term
            .and_then(|t| micro_nusd.checked_add(t))
            .ok_or(PricingError::Overflow)?;
    }
    for (quantity, price) in per_unit {
        let term = u128::from(quantity)
            .checked_mul(u128::from(price))
            .and_then(|t| t.checked_mul(u128::from(TOKENS_PER_PRICE_UNIT)));
        micro_nusd = term
            .and_then(|t| micro_nusd.checked_add(t))
            .ok_or(PricingError::Overflow)?;
    }
    to_u64(ceil_div(micro_nusd, u128::from(TOKENS_PER_PRICE_UNIT))?).map(Nusd::new)
}

/// Meter and price a call from its usage vector:
/// `price_nusd(metered_cost_nusd(usage, prices)?, …)`.
///
/// # Errors
///
/// [`PricingError::Overflow`] on an input too large to price.
pub fn price_2z(
    usage: &Usage,
    prices: &ModelPrices,
    platform_margin: Bps,
    dev_markup: Bps,
    min_charge_2z: Whole2z,
) -> Result<Charge, PricingError> {
    price_nusd(
        metered_cost_nusd(usage, prices)?,
        platform_margin,
        dev_markup,
        min_charge_2z,
    )
}

/// Step 2: price a metered cost in nano-USD. See the module documentation.
///
/// # Errors
///
/// [`PricingError::Overflow`] on an input too large to price.
pub fn price_nusd(
    cost_nusd: Nusd,
    platform_margin: Bps,
    dev_markup: Bps,
    min_charge_2z: Whole2z,
) -> Result<Charge, PricingError> {
    let c = u128::from(cost_nusd.get());
    let one_plus_m = BPS
        .checked_add(u128::from(platform_margin.0))
        .ok_or(PricingError::Overflow)?;
    let one_plus_k = BPS
        .checked_add(u128::from(dev_markup.0))
        .ok_or(PricingError::Overflow)?;
    let per_2z = u128::from(NUSD_PER_2Z);
    let per_milli = u128::from(NUSD_PER_MILLI_2Z);

    // p + d = c·(1+m)·(1+k), in nUSD × BPS².
    let p_plus_d = c
        .checked_mul(one_plus_m)
        .and_then(|v| v.checked_mul(one_plus_k))
        .ok_or(PricingError::Overflow)?;
    // THE rounding: ceil to whole 2Z, over the exact numerator.
    let raw_2z = ceil_div(
        p_plus_d,
        BPS_SQUARED
            .checked_mul(per_2z)
            .ok_or(PricingError::Overflow)?,
    )?;
    let total_2z = raw_2z.max(u128::from(min_charge_2z.get()));
    let total_milli = total_2z
        .checked_mul(u128::from(MILLI_PER_2Z))
        .ok_or(PricingError::Overflow)?;

    // provider = ceil(c) in milli-2Z.
    let provider_milli = ceil_div(c, per_milli)?;
    // developer = floor(d) in milli-2Z, d = c·(1+m)·k (nUSD × BPS²).
    let d = c
        .checked_mul(one_plus_m)
        .and_then(|v| v.checked_mul(u128::from(dev_markup.0)))
        .ok_or(PricingError::Overflow)?;
    let developer_milli = d
        .checked_div(
            BPS_SQUARED
                .checked_mul(per_milli)
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
        total_milli: Milli2z::new(to_u64(total_milli)?),
        provider_milli: Milli2z::new(to_u64(provider_milli)?),
        developer_milli: Milli2z::new(to_u64(developer_milli)?),
        platform_milli: Milli2z::new(to_u64(platform_milli)?),
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
        let charge =
            price_nusd(Nusd::new(21_000_000), Bps::ZERO, Bps::ZERO, Whole2z::new(1)).unwrap();
        assert_eq!(
            charge,
            Charge {
                total_milli: Milli2z::new(3_000),
                provider_milli: Milli2z::new(2_100),
                developer_milli: Milli2z::new(0),
                platform_milli: Milli2z::new(900),
            }
        );
        assert_eq!(charge.total_2z(), Whole2z::new(3));
    }

    #[test]
    fn rounding_p_and_d_separately_would_overcharge() {
        let charge = price_nusd(
            Nusd::new(21_000_000),
            Bps::ZERO,
            Bps(1_000),
            Whole2z::new(1),
        )
        .unwrap();
        assert_eq!(
            charge.total_2z(),
            Whole2z::new(3),
            "ceil(2.1 + 0.21), not ceil(2.1) + ceil(0.21)"
        );
        assert_eq!(charge.developer_milli, Milli2z::new(210));
    }

    #[test]
    fn min_charge_applies_to_a_free_call() {
        let charge = price_nusd(Nusd::new(0), Bps(5_000), Bps::ZERO, Whole2z::new(1)).unwrap();
        assert_eq!(charge.total_milli, Milli2z::new(1_000));
        assert_eq!(charge.platform_milli, Milli2z::new(1_000));
    }

    #[test]
    fn an_exact_whole_2z_is_not_rounded_up() {
        let charge =
            price_nusd(Nusd::new(20_000_000), Bps::ZERO, Bps::ZERO, Whole2z::new(0)).unwrap();
        assert_eq!(charge.total_milli, Milli2z::new(2_000));
        assert_eq!(charge.platform_milli, Milli2z::new(0));
    }

    #[test]
    fn a_sub_nano_usd_cost_is_metered_up_and_still_charged() {
        // 1 token at 1 nUSD per million tokens is 10⁻⁶ nUSD: metered to 1 nUSD,
        // priced to ≥ 1 2Z, and the provider split is ≥ 1 milli, never 0.
        let usage = Usage {
            input_tokens: 1,
            ..Usage::default()
        };
        let prices = ModelPrices {
            input_nusd_per_mtok: 1,
            ..ModelPrices::default()
        };
        assert_eq!(metered_cost_nusd(&usage, &prices).unwrap(), Nusd::new(1));
        let charge = price_2z(&usage, &prices, Bps::ZERO, Bps::ZERO, Whole2z::new(0)).unwrap();
        assert_eq!(charge.total_milli, Milli2z::new(1_000));
        assert_eq!(charge.provider_milli, Milli2z::new(1));
    }

    #[test]
    fn an_estimate_prices_the_same_integer_the_ledger_settles() {
        // The boundary case adversarial review found: exact 9 999 999.999 nUSD
        // would price to 1 2Z, the metered 6 666 667 nUSD × 1.5 to 2 2Z. The
        // estimate must agree with settlement, so it must be 2.
        let usage = Usage {
            input_tokens: 100_001,
            ..Usage::default()
        };
        let prices = ModelPrices {
            input_nusd_per_mtok: 66_666_000,
            ..ModelPrices::default()
        };
        let metered = metered_cost_nusd(&usage, &prices).unwrap();
        assert_eq!(metered, Nusd::new(6_666_667));
        let settled = price_nusd(metered, Bps(5_000), Bps::ZERO, Whole2z::new(1)).unwrap();
        let estimated = price_2z(&usage, &prices, Bps(5_000), Bps::ZERO, Whole2z::new(1)).unwrap();
        assert_eq!(estimated, settled);
        assert_eq!(estimated.total_2z(), Whole2z::new(2));
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
            price_2z(&usage, &prices, Bps::ZERO, Bps::ZERO, Whole2z::new(0)),
            Err(PricingError::Overflow)
        );
        assert_eq!(
            price_nusd(
                Nusd::new(u64::MAX),
                Bps(u32::MAX),
                Bps(u32::MAX),
                Whole2z::new(0)
            ),
            Err(PricingError::Overflow)
        );
    }
}
