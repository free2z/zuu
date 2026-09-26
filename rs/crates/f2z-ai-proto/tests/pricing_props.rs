//! Property tests for `price_2z`.
//!
//! | Property | Test |
//! |---|---|
//! | the total is rounded exactly once, to the smallest whole 2Z ≥ p + d | [`the_total_is_one_ceil_of_the_exact_value`] |
//! | the charge is never below cost | [`the_charge_covers_cost`] |
//! | the splits sum to the total, and the developer never gets more than d | [`the_splits_partition_the_total`] |
//! | more usage never costs less | [`more_usage_never_costs_less`] |
//! | a higher margin or markup never costs less | [`higher_rates_never_cost_less`] |
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
use f2z_ai_proto::pricing::{Bps, Cost, ModelPrices, price_2z, price_cost};
use proptest::prelude::*;

/// femto-USD per 2Z.
const FUSD_PER_2Z: u128 = 10_000_000_000_000;
/// femto-USD per milli-2Z.
const FUSD_PER_MILLI: u128 = 10_000_000_000;

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
    let per_mtok = 0..1_000_000_000_000u64;
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

/// Small costs, where rounding dominates: up to 10 2Z, at femto-USD grain.
fn small_cost() -> impl Strategy<Value = u128> {
    prop_oneof![
        0..(10 * FUSD_PER_2Z),
        (0..100u128).prop_map(|k| k * FUSD_PER_2Z / 10),
        (1..100u128).prop_map(|k| k * FUSD_PER_2Z - 1),
        (1..100u128).prop_map(|k| k * FUSD_PER_2Z + 1),
    ]
}

/// A `Cost` from femto-USD, reached through the public API: one input token
/// at a price of `fusd` nUSD per million tokens is exactly `fusd` femto-USD.
fn cost_of(fusd: u128) -> Cost {
    let usage = Usage {
        input_tokens: 1,
        ..Usage::default()
    };
    let prices = ModelPrices {
        input_nusd_per_mtok: u64::try_from(fusd).unwrap(),
        ..ModelPrices::default()
    };
    Cost::of_usage(&usage, &prices).unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    #[test]
    fn the_total_is_one_ceil_of_the_exact_value(
        c in small_cost(), m in rate(), k in rate(), min in min_charge(),
    ) {
        let charge = price_cost(cost_of(c), m, k, min).unwrap();
        prop_assert_eq!(charge.total_milli % 1_000, 0, "total must be whole 2Z");
        let t = u128::from(charge.total_2z());
        // Exact p + d in 2Z is N / D.
        let n = c * (10_000 + u128::from(m.0)) * (10_000 + u128::from(k.0));
        let d = 100_000_000 * FUSD_PER_2Z;
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
        let cost = Cost::of_usage(&u, &p).unwrap();
        let charge = price_2z(&u, &p, m, k, min).unwrap();
        prop_assert!(u128::from(charge.total_milli) * FUSD_PER_MILLI >= cost.femto_usd());
        prop_assert!(u128::from(charge.provider_milli) * FUSD_PER_MILLI >= cost.femto_usd());
        // provider is ceil, not ceil + 1.
        prop_assert!(
            charge.provider_milli == 0
                || u128::from(charge.provider_milli - 1) * FUSD_PER_MILLI < cost.femto_usd()
        );
        prop_assert!(charge.total_2z() >= min);
    }

    #[test]
    fn the_splits_partition_the_total(u in usage(), p in prices(), m in rate(), k in rate(), min in min_charge()) {
        let cost = Cost::of_usage(&u, &p).unwrap();
        let charge = price_2z(&u, &p, m, k, min).unwrap();
        prop_assert_eq!(
            charge.provider_milli + charge.developer_milli + charge.platform_milli,
            charge.total_milli
        );
        // developer = floor(d): never above d, and within one milli of it.
        let d_scaled = cost.femto_usd() * (10_000 + u128::from(m.0)) * u128::from(k.0);
        let unit = 100_000_000 * FUSD_PER_MILLI;
        prop_assert!(u128::from(charge.developer_milli) * unit <= d_scaled);
        prop_assert!(u128::from(charge.developer_milli + 1) * unit > d_scaled);
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
        let before = price_2z(&u, &p, m, k, min).unwrap();
        let after = price_2z(&more, &p, m, k, min).unwrap();
        prop_assert!(after.total_milli >= before.total_milli);
        prop_assert!(after.provider_milli >= before.provider_milli);
        prop_assert!(after.developer_milli >= before.developer_milli);
    }

    #[test]
    fn higher_rates_never_cost_less(
        c in small_cost(), m in rate(), k in rate(), min in min_charge(),
        dm in 0..10_000u32, dk in 0..10_000u32,
    ) {
        let base = price_cost(cost_of(c), m, k, min).unwrap();
        let up = price_cost(cost_of(c), Bps(m.0 + dm), Bps(k.0 + dk), min).unwrap();
        prop_assert!(up.total_milli >= base.total_milli);
        prop_assert_eq!(up.provider_milli, base.provider_milli);
    }
}
