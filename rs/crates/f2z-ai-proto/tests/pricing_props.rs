//! Property tests for `price_2z` / `price_nusd` / `metered_cost_nusd`.
//!
//! | Property | Test |
//! |---|---|
//! | the total is rounded exactly once, to the smallest whole 2Z ≥ p + d | [`the_total_is_one_ceil_of_the_exact_value`] |
//! | the charge is never below cost (the exact, unmetered cost) | [`the_charge_covers_cost`] |
//! | the splits sum to the total, and the developer never gets more than d | [`the_splits_partition_the_total`] |
//! | more usage never costs less | [`more_usage_never_costs_less`] |
//! | a higher margin or markup never costs less | [`higher_rates_never_cost_less`] |
//! | an estimate prices the same integer settlement does | [`an_estimate_is_the_settlement_of_its_metered_cost`] |
//!
//! The "exactly once" property is checked against the definition rather than
//! against a second implementation: with `N/D` the exact value of `p + d` in
//! 2Z, `ceil` is the unique integer `t` with `(t − 1)·D < N ≤ t·D`. An extra
//! intermediate ceil can only push `t` above that; an intermediate floor can
//! push it below. Either breaks the inequality for some input.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai_proto::Usage;
use f2z_ai_proto::amount::{Nusd, Whole2z};
use f2z_ai_proto::pricing::{Bps, ModelPrices, metered_cost_nusd, price_2z, price_nusd};
use proptest::prelude::*;

/// nano-USD per 2Z and per milli-2Z.
const NUSD_PER_2Z: u128 = 10_000_000;
const NUSD_PER_MILLI: u128 = 10_000;

// Ranges are generous but realistic, so no case is an overflow case: up to
// 10M of each token kind, $1000/M per token kind, 1000 % margin and markup.
fn usage() -> impl Strategy<Value = Usage> {
    (
        0..10_000_000u64,
        0..10_000_000u64,
        0..10_000_000u64,
        0..10_000_000u64,
        0..1_000u64,
        0..1_000u64,
    )
        .prop_map(|(i, ci, cw, o, img, t)| Usage {
            input_tokens: i,
            cached_input_tokens: ci,
            cache_write_tokens: cw,
            output_tokens: o,
            reasoning_tokens: 0,
            images: img,
            tool_calls: t,
        })
}

fn prices() -> impl Strategy<Value = ModelPrices> {
    // Include tiny prices so sub-nano-USD costs (where metering rounds) are common.
    let per_mtok = prop_oneof![0..1_000u64, 0..1_000_000_000_000u64];
    let per_unit = 0..100_000_000u64;
    (
        per_mtok.clone(),
        per_mtok.clone(),
        per_mtok.clone(),
        per_mtok,
        per_unit.clone(),
        per_unit,
    )
        .prop_map(|(i, ci, cw, o, img, t)| ModelPrices {
            input_nusd_per_mtok: i,
            cached_input_nusd_per_mtok: ci,
            cache_write_nusd_per_mtok: cw,
            output_nusd_per_mtok: o,
            image_nusd: img,
            tool_call_nusd: t,
        })
}

fn rate() -> impl Strategy<Value = Bps> {
    prop_oneof![
        Just(Bps(0)),
        Just(Bps(5_000)),
        (0..100_000u32).prop_map(Bps)
    ]
}

fn min_charge() -> impl Strategy<Value = u64> {
    prop_oneof![Just(0u64), Just(1u64), 0..100u64]
}

/// Small costs, where rounding dominates: up to 10 2Z, with many on or one
/// nano-USD either side of a whole-2Z boundary.
fn small_cost() -> impl Strategy<Value = u64> {
    let per_2z = u64::try_from(NUSD_PER_2Z).unwrap();
    prop_oneof![
        0..(10 * per_2z),
        (0..100u64).prop_map(move |k| k * per_2z / 10),
        (1..100u64).prop_map(move |k| k * per_2z - 1),
        (1..100u64).prop_map(move |k| k * per_2z + 1),
    ]
}

/// The exact cost in 10⁻⁶ nUSD, computed here independently of the crate.
fn exact_micro_nusd(u: &Usage, p: &ModelPrices) -> u128 {
    let t = |q: u64, pr: u64| u128::from(q) * u128::from(pr);
    t(u.input_tokens, p.input_nusd_per_mtok)
        + t(u.cached_input_tokens, p.cached_input_nusd_per_mtok)
        + t(u.cache_write_tokens, p.cache_write_nusd_per_mtok)
        + t(u.output_tokens, p.output_nusd_per_mtok)
        + t(u.images, p.image_nusd) * 1_000_000
        + t(u.tool_calls, p.tool_call_nusd) * 1_000_000
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    #[test]
    fn the_total_is_one_ceil_of_the_exact_value(
        c in small_cost(), m in rate(), k in rate(), min in min_charge(),
    ) {
        let charge = price_nusd(Nusd::new(c), m, k, Whole2z::new(min)).unwrap();
        prop_assert_eq!(charge.total_milli.get() % 1_000, 0, "total must be whole 2Z");
        let t = u128::from(charge.total_2z().get());
        // Exact p + d in 2Z is N / D.
        let n = u128::from(c) * (10_000 + u128::from(m.0)) * (10_000 + u128::from(k.0));
        let d = 100_000_000 * NUSD_PER_2Z;
        let min = u128::from(min);
        // Never below the exact value, whichever term decided the total.
        prop_assert!(t * d >= n, "total {} below p + d", t);
        prop_assert!(t >= min);
        if t > min {
            // The formula's term decided it: t is exactly ceil(N/D), i.e. not
            // one whole 2Z (or more) above p + d.
            prop_assert!((t - 1) * d < n, "total {} is more than one ceil above p + d", t);
        }
    }

    #[test]
    fn the_charge_covers_cost(u in usage(), p in prices(), m in rate(), k in rate(), min in min_charge()) {
        let exact = exact_micro_nusd(&u, &p);
        let metered = metered_cost_nusd(&u, &p).unwrap().get();
        // Metering is ceil to whole nano-USD: ≥ exact, and less than 1 nUSD above.
        prop_assert!(u128::from(metered) * 1_000_000 >= exact);
        prop_assert!(metered == 0 || u128::from(metered - 1) * 1_000_000 < exact);

        let charge = price_2z(&u, &p, m, k, Whole2z::new(min)).unwrap();
        let milli = 1_000_000 * NUSD_PER_MILLI;
        prop_assert!(u128::from(charge.total_milli.get()) * milli >= exact);
        prop_assert!(u128::from(charge.provider_milli.get()) * NUSD_PER_MILLI >= u128::from(metered));
        // provider is ceil, not ceil + 1.
        prop_assert!(
            charge.provider_milli.get() == 0
                || u128::from(charge.provider_milli.get() - 1) * NUSD_PER_MILLI < u128::from(metered)
        );
        prop_assert!(charge.total_2z().get() >= min);
    }

    #[test]
    fn the_splits_partition_the_total(u in usage(), p in prices(), m in rate(), k in rate(), min in min_charge()) {
        let metered = metered_cost_nusd(&u, &p).unwrap().get();
        let charge = price_2z(&u, &p, m, k, Whole2z::new(min)).unwrap();
        prop_assert_eq!(
            charge.provider_milli.get() + charge.developer_milli.get() + charge.platform_milli.get(),
            charge.total_milli.get()
        );
        // developer = floor(d): never above d, and within one milli of it.
        let d_scaled = u128::from(metered) * (10_000 + u128::from(m.0)) * u128::from(k.0);
        let unit = 100_000_000 * NUSD_PER_MILLI;
        prop_assert!(u128::from(charge.developer_milli.get()) * unit <= d_scaled);
        prop_assert!(u128::from(charge.developer_milli.get() + 1) * unit > d_scaled);
    }

    #[test]
    fn more_usage_never_costs_less(
        u in usage(), p in prices(), m in rate(), k in rate(), min in min_charge(),
        which in 0..6usize, extra in 1..1_000_000u64,
    ) {
        let mut more = u;
        let slot = match which {
            0 => &mut more.input_tokens,
            1 => &mut more.cached_input_tokens,
            2 => &mut more.cache_write_tokens,
            3 => &mut more.output_tokens,
            4 => &mut more.images,
            _ => &mut more.tool_calls,
        };
        *slot += extra;
        let before = price_2z(&u, &p, m, k, Whole2z::new(min)).unwrap();
        let after = price_2z(&more, &p, m, k, Whole2z::new(min)).unwrap();
        prop_assert!(after.total_milli.get() >= before.total_milli.get());
        prop_assert!(after.provider_milli.get() >= before.provider_milli.get());
        prop_assert!(after.developer_milli.get() >= before.developer_milli.get());
    }

    #[test]
    fn higher_rates_never_cost_less(
        c in small_cost(), m in rate(), k in rate(), min in min_charge(),
        dm in 0..10_000u32, dk in 0..10_000u32,
    ) {
        let base = price_nusd(Nusd::new(c), m, k, Whole2z::new(min)).unwrap();
        let up = price_nusd(Nusd::new(c), Bps(m.0 + dm), Bps(k.0 + dk), Whole2z::new(min)).unwrap();
        prop_assert!(up.total_milli.get() >= base.total_milli.get());
        prop_assert_eq!(up.provider_milli.get(), base.provider_milli.get());
    }

    #[test]
    fn an_estimate_is_the_settlement_of_its_metered_cost(
        u in usage(), p in prices(), m in rate(), k in rate(), min in min_charge(),
    ) {
        let settled = price_nusd(metered_cost_nusd(&u, &p).unwrap(), m, k, Whole2z::new(min)).unwrap();
        prop_assert_eq!(price_2z(&u, &p, m, k, Whole2z::new(min)).unwrap(), settled);
    }
}
