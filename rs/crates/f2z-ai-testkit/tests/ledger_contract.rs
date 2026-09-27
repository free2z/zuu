//! The in-memory ledger against metering.md §3 and §5 (zuu #1051), driven by
//! `f2z-ai-proto`'s shared pricing fixtures.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::Arc;

use f2z_ai_proto::Usage;
use f2z_ai_proto::chat::UsageSource;
use f2z_ai_proto::pricing::{Bps, ModelPrices, metered_cost_nusd};
use f2z_ai_testkit::fixtures::{cost_cases, usage_cases};
use f2z_ai_testkit::ledger::{
    ExtendOutcome, GrantConfig, HoldId, HoldKey, HoldOutcome, HoldRequest, HoldState,
    InMemoryLedger, LedgerContract, LedgerError, MAX_OPEN_HOLDS, RateCard, RateCardModel,
    ReleaseOutcome, SettleOutcome, SettleRequest, Settlement,
};

const TTL: Duration = Duration::from_secs(300);
const MODEL: &str = "m";

struct World {
    ledger: InMemoryLedger,
    agen: u64,
    markup: Bps,
    next_key: std::cell::Cell<u32>,
}

impl World {
    fn new(
        balance_milli: u64,
        margin: Bps,
        markup: Bps,
        min_charge: u64,
        cap: Option<u64>,
    ) -> Self {
        Self::with_prices(
            balance_milli,
            margin,
            markup,
            min_charge,
            cap,
            ModelPrices::default(),
        )
    }

    fn with_prices(
        balance_milli: u64,
        margin: Bps,
        markup: Bps,
        min_charge: u64,
        cap: Option<u64>,
        prices: ModelPrices,
    ) -> Self {
        let ledger = InMemoryLedger::new();
        ledger.open_account("u", balance_milli);
        let agen = ledger.grant(
            "u",
            "app",
            GrantConfig {
                markup_bps: markup,
                spend_cap_2z: cap,
            },
        );
        ledger.add_rate_card(RateCard {
            version: 1,
            platform_margin_bps: margin,
            models: BTreeMap::from([(
                MODEL.to_owned(),
                RateCardModel {
                    prices,
                    min_charge_2z: min_charge,
                },
            )]),
        });
        Self {
            ledger,
            agen,
            markup,
            next_key: std::cell::Cell::new(0),
        }
    }

    fn request(&self, amount_2z: u64) -> HoldRequest {
        let k = self.next_key.get();
        self.next_key.set(k + 1);
        HoldRequest {
            user: "u".into(),
            app: "app".into(),
            amount_2z,
            hold_key: HoldKey {
                call_id: format!("idem-{k}"),
                attempt: 1,
            },
            aep: self.ledger.account_epoch("u").unwrap(),
            agen: self.agen,
            model_id: MODEL.into(),
            rate_card_version: 1,
            catalog_version: 42,
            markup_bps: self.markup,
            ttl: TTL,
        }
    }

    async fn hold(&self, amount_2z: u64) -> HoldId {
        match self.ledger.hold(self.request(amount_2z)).await.unwrap() {
            HoldOutcome::Held(h) => h.hold_id,
            other => panic!("expected held, got {other:?}"),
        }
    }

    async fn settle(&self, hold_id: HoldId, cost_nusd: u64) -> SettleOutcome {
        self.ledger
            .settle(SettleRequest {
                hold_id,
                cost_nusd,
                usage: Usage::default(),
                source: UsageSource::Provider,
            })
            .await
            .unwrap()
    }
}

fn settled(o: SettleOutcome) -> Settlement {
    match o {
        SettleOutcome::Settled(s) => s,
        other => panic!("expected settled, got {other:?}"),
    }
}

#[tokio::test]
async fn every_cost_fixture_settles_to_its_expected_charge_and_splits() {
    let cases = cost_cases().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let w = World::new(
            u64::MAX / 4,
            c.platform_margin,
            c.dev_markup,
            c.min_charge_2z,
            None,
        );
        let id = w.hold(c.expected.total_2z().max(1)).await;
        let s = settled(w.settle(id, c.cost_nusd).await);
        assert_eq!(s.charged_2z, c.expected.total_2z(), "{}", c.name);
        assert_eq!(s.collected_milli_2z, c.expected.total_milli, "{}", c.name);
        assert_eq!(s.shortfall_milli_2z, 0);
        assert_eq!(s.provider_milli_2z, c.expected.provider_milli, "{}", c.name);
        assert_eq!(
            s.developer_milli_2z, c.expected.developer_milli,
            "{}",
            c.name
        );
        assert_eq!(
            s.platform_milli_2z,
            i64::try_from(c.expected.platform_milli).unwrap(),
            "{}",
            c.name
        );
        assert_eq!(
            w.ledger.balance_milli_2z("u"),
            Some(u64::MAX / 4 - c.expected.total_milli)
        );
        w.ledger.check_invariants().unwrap();
    }
}

#[tokio::test]
async fn every_usage_fixture_meters_and_settles_and_the_record_cross_checks() {
    for c in usage_cases().unwrap() {
        let cost = metered_cost_nusd(&c.usage, &c.prices).unwrap();
        assert_eq!(cost, c.expected_cost_nusd, "{}", c.name);
        let w = World::with_prices(
            10_000_000_000,
            c.platform_margin,
            c.dev_markup,
            c.min_charge_2z,
            None,
            c.prices,
        );
        let id = w.hold(c.expected.total_2z().max(1)).await;
        let s = settled(
            w.ledger
                .settle(SettleRequest {
                    hold_id: id,
                    cost_nusd: cost,
                    usage: c.usage,
                    source: UsageSource::Provider,
                })
                .await
                .unwrap(),
        );
        assert_eq!(s.charged_2z, c.expected.total_2z(), "{}", c.name);
        assert_eq!(
            s.developer_milli_2z, c.expected.developer_milli,
            "{}",
            c.name
        );
        let rec = w.ledger.call(id).unwrap();
        assert_eq!(rec.metered_from_usage, Some(cost), "{}", c.name);
        assert_eq!(rec.usage, Some(c.usage));
    }
}

/// metering.md §6.7, number for number.
#[tokio::test]
async fn the_worked_write_off_example() {
    // 2 000 held + 400 available; cost 1 000 m2Z; m = b = 50 %.
    let w = World::new(2_400, Bps(5_000), Bps(5_000), 1, Some(12));
    let id = w.hold(2).await;
    let s = settled(w.settle(id, 10_000_000).await);
    assert_eq!(s.charged_2z, 3, "the price is the price");
    assert_eq!(s.collected_milli_2z, 2_400);
    assert_eq!(s.shortfall_milli_2z, 600);
    assert_eq!(s.provider_milli_2z, 1_000);
    assert_eq!(s.developer_milli_2z, 750);
    assert_eq!(s.platform_milli_2z, 650);
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(0), "never negative");
    let t = w.ledger.totals();
    assert_eq!(t.shortfall_milli_2z, 600);
    w.ledger.check_invariants().unwrap();
}

#[tokio::test]
async fn a_shortfall_falls_on_the_platform_then_the_developer_never_the_provider() {
    // Price 3 2Z (cost 1 000 m2Z, m = b = 50 %), 1 000 collectable: the
    // provider's 1 000 is whole, the developer gets 0, the platform 0.
    let w = World::new(1_000, Bps(5_000), Bps(5_000), 1, None);
    let id = w.hold(1).await;
    let s = settled(w.settle(id, 10_000_000).await);
    assert_eq!(s.collected_milli_2z, 1_000);
    assert_eq!(s.provider_milli_2z, 1_000);
    assert_eq!(s.developer_milli_2z, 0);
    assert_eq!(s.platform_milli_2z, 0);
    // §6.7's variant: 1 200 collectable → developer 200, platform 0.
    let w = World::new(1_200, Bps(5_000), Bps(5_000), 1, None);
    let id = w.hold(1).await;
    let s = settled(w.settle(id, 10_000_000).await);
    assert_eq!((s.developer_milli_2z, s.platform_milli_2z), (200, 0));
    // With a margin that leaves the provider's part above the collection the
    // platform goes negative: 0 % margin, 50 % markup, cost 1 500 m2Z
    // (price 3 2Z) with only 1 000 collectable.
    let w = World::new(1_000, Bps(0), Bps(5_000), 1, None);
    let id = w.hold(1).await;
    let s = settled(w.settle(id, 15_000_000).await);
    assert_eq!(s.provider_milli_2z, 1_500);
    assert_eq!(s.developer_milli_2z, 0);
    assert_eq!(s.platform_milli_2z, -500, "the platform's loss");
    assert_eq!(s.shortfall_milli_2z, 2_000);
    w.ledger.check_invariants().unwrap();
}

#[tokio::test]
async fn an_excess_is_bounded_by_the_holds_period_cap() {
    // Cap 3 2Z. Hold 1; the price is 5 2Z; balance is ample. Only the cap's
    // 2 000 remaining may be taken beyond the hold.
    let w = World::new(100_000, Bps(0), Bps(0), 1, Some(3));
    let id = w.hold(1).await;
    let s = settled(w.settle(id, 50_000_000).await);
    assert_eq!(s.charged_2z, 5);
    assert_eq!(s.collected_milli_2z, 3_000);
    assert_eq!(s.shortfall_milli_2z, 2_000);
    assert_eq!(s.cap_remaining_milli_2z, Some(0));
}

#[tokio::test]
async fn every_refusal_status() {
    let w = World::new(5_000, Bps(0), Bps(1_000), 1, Some(4));
    let r = |f: &dyn Fn(&mut HoldRequest)| {
        let mut req = w.request(1);
        f(&mut req);
        req
    };
    let hold = |req| async { w.ledger.hold(req).await.unwrap() };

    assert_eq!(hold(w.request(6)).await, HoldOutcome::InsufficientBalance);
    assert_eq!(hold(w.request(5)).await, HoldOutcome::CapExceeded);
    assert_eq!(
        hold(r(&|q| q.markup_bps = Bps(0))).await,
        HoldOutcome::MarkupMismatch
    );
    assert_eq!(
        hold(r(&|q| q.rate_card_version = 9)).await,
        HoldOutcome::UnknownRateCard
    );
    assert_eq!(
        hold(r(&|q| q.model_id = "other".into())).await,
        HoldOutcome::UnknownRateCard
    );
    assert_eq!(hold(r(&|q| q.agen += 1)).await, HoldOutcome::Revoked);
    assert_eq!(hold(r(&|q| q.aep += 1)).await, HoldOutcome::Revoked);
    assert_eq!(
        hold(r(&|q| q.app = "other-app".into())).await,
        HoldOutcome::Revoked
    );
    assert_eq!(hold(w.request(0)).await, HoldOutcome::InvalidAmount);
    assert_eq!(
        w.ledger
            .hold(r(&|q| q.user = "nobody".into()))
            .await
            .unwrap_err(),
        LedgerError::UnknownAccount
    );

    // A security event stales every outstanding token.
    let stale = w.request(1);
    w.ledger.bump_epoch("u");
    assert_eq!(hold(stale).await, HoldOutcome::Revoked);
    // Revocation.
    let live = w.request(1);
    w.ledger.revoke("u", "app");
    assert_eq!(hold(live).await, HoldOutcome::Revoked);
    // Frozen is checked before the grant.
    w.ledger.set_frozen("u", true);
    assert_eq!(hold(w.request(1)).await, HoldOutcome::Frozen);
    let inq = w.ledger.inquire("u", "app").await.unwrap();
    assert!(inq.frozen);
}

#[tokio::test]
async fn the_seventeenth_open_hold_is_refused() {
    let w = World::new(1_000_000, Bps(0), Bps(0), 1, None);
    let mut ids = Vec::new();
    for _ in 0..MAX_OPEN_HOLDS {
        ids.push(w.hold(1).await);
    }
    assert_eq!(
        w.ledger.hold(w.request(1)).await.unwrap(),
        HoldOutcome::TooManyHolds
    );
    assert_eq!(
        w.ledger.inquire("u", "app").await.unwrap().open_holds,
        MAX_OPEN_HOLDS
    );
    // Releasing one makes room.
    assert_eq!(
        w.ledger.release(ids[0]).await.unwrap(),
        ReleaseOutcome::Released
    );
    w.hold(1).await;
}

#[tokio::test]
async fn a_replayed_hold_key_returns_the_same_hold_in_its_current_state() {
    let w = World::new(10_000, Bps(0), Bps(0), 1, None);
    let req = w.request(2);
    let HoldOutcome::Held(first) = w.ledger.hold(req.clone()).await.unwrap() else {
        panic!()
    };
    assert_eq!(
        w.ledger.hold(req.clone()).await.unwrap(),
        HoldOutcome::Replayed {
            hold_id: first.hold_id,
            state: HoldState::Open
        }
    );
    assert_eq!(first.available_milli_2z, 8_000, "reserved once");
    w.ledger.release(first.hold_id).await.unwrap();
    assert_eq!(
        w.ledger.hold(req.clone()).await.unwrap(),
        HoldOutcome::Replayed {
            hold_id: first.hold_id,
            state: HoldState::Released
        }
    );
    // A fallback attempt is a different key.
    let mut fallback = req;
    fallback.hold_key.attempt = 2;
    assert!(matches!(
        w.ledger.hold(fallback).await.unwrap(),
        HoldOutcome::Held(_)
    ));
}

#[tokio::test]
async fn extend_sets_an_absolute_target_and_always_pushes_the_expiry() {
    let w = World::new(5_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(2).await;
    w.ledger.advance(Duration::from_secs(60));
    let e = w.ledger.extend(id, 3, TTL).await.unwrap();
    assert_eq!(
        e,
        ExtendOutcome::Held {
            reserved_2z: 3,
            expires_at_ms: 360_000
        }
    );
    // A retried extension whose first answer was lost reserves nothing twice.
    assert!(matches!(
        w.ledger.extend(id, 3, TTL).await.unwrap(),
        ExtendOutcome::Held { reserved_2z: 3, .. }
    ));
    // A lower target never lowers the reservation.
    assert!(matches!(
        w.ledger.extend(id, 1, TTL).await.unwrap(),
        ExtendOutcome::Held { reserved_2z: 3, .. }
    ));
    assert_eq!(
        w.ledger
            .inquire("u", "app")
            .await
            .unwrap()
            .available_milli_2z,
        2_000
    );
    // Unaffordable: reservation unchanged, expiry still pushed.
    w.ledger.advance(Duration::from_secs(60));
    assert_eq!(
        w.ledger.extend(id, 9, TTL).await.unwrap(),
        ExtendOutcome::InsufficientBalance {
            reserved_2z: 3,
            expires_at_ms: 420_000
        }
    );
    settled(w.settle(id, 0).await);
    assert_eq!(
        w.ledger.extend(id, 9, TTL).await.unwrap(),
        ExtendOutcome::NotOpen {
            state: HoldState::Settled
        }
    );
}

#[tokio::test]
async fn an_extension_past_the_cap_is_cap_exceeded() {
    let w = World::new(50_000, Bps(0), Bps(0), 1, Some(3));
    let id = w.hold(2).await;
    assert!(matches!(
        w.ledger.extend(id, 4, TTL).await.unwrap(),
        ExtendOutcome::CapExceeded { reserved_2z: 2, .. }
    ));
}

#[tokio::test]
async fn settle_is_idempotent_and_the_first_terminal_transition_wins() {
    let w = World::new(10_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(3).await;
    let first = settled(w.settle(id, 21_000_000).await);
    assert_eq!(first.charged_2z, 3);
    let again = settled(w.settle(id, 99_000_000).await);
    assert_eq!(again, first, "a second settle returns the first result");
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(7_000), "moved once");
    assert_eq!(w.ledger.release(id).await.unwrap(), ReleaseOutcome::Settled);
    assert_eq!(w.ledger.call(id).unwrap().settle_calls, 2);

    // Release first: a later settle charges nothing.
    let id = w.hold(2).await;
    assert_eq!(
        w.ledger.release(id).await.unwrap(),
        ReleaseOutcome::Released
    );
    assert_eq!(
        w.ledger.release(id).await.unwrap(),
        ReleaseOutcome::Released
    );
    assert_eq!(
        w.settle(id, 10_000_000).await,
        SettleOutcome::NotOpen {
            state: HoldState::Released
        }
    );
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(7_000));
    w.ledger.check_invariants().unwrap();
}

#[tokio::test]
async fn an_unsettled_hold_expires_and_a_late_settle_charges_nothing() {
    let w = World::new(10_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(4).await;
    w.ledger.advance(TTL - Duration::from_millis(1));
    assert_eq!(w.ledger.expire_due(), 0);
    w.ledger.advance(Duration::from_millis(1));
    assert_eq!(w.ledger.expire_due(), 1);
    assert_eq!(
        w.settle(id, 10_000_000).await,
        SettleOutcome::NotOpen {
            state: HoldState::Expired
        }
    );
    assert_eq!(w.ledger.release(id).await.unwrap(), ReleaseOutcome::Expired);
    assert_eq!(
        w.ledger
            .inquire("u", "app")
            .await
            .unwrap()
            .available_milli_2z,
        10_000
    );
    // Lazily, too: past its time, a hold is expired without the sweeper.
    let id = w.hold(1).await;
    w.ledger.advance(TTL);
    assert_eq!(
        w.settle(id, 0).await,
        SettleOutcome::NotOpen {
            state: HoldState::Expired
        }
    );
    assert_eq!(w.ledger.totals().expired, 2);
}

#[tokio::test]
async fn a_revocation_during_a_stream_does_not_stop_its_settlement() {
    let w = World::new(10_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(2).await;
    w.ledger.revoke("u", "app");
    w.ledger.bump_epoch("u");
    let s = settled(w.settle(id, 15_000_000).await);
    assert_eq!(s.charged_2z, 2);
    assert_eq!(
        w.ledger.hold(w.request(1)).await.unwrap(),
        HoldOutcome::Revoked
    );
}

#[tokio::test]
async fn a_hold_settles_against_the_period_it_was_taken_in() {
    let w = World::new(100_000, Bps(0), Bps(0), 1, Some(5));
    let id = w.hold(3).await;
    w.ledger.start_new_period("u", "app");
    // The new period's cap is untouched by the old period's open hold…
    assert_eq!(
        w.ledger
            .inquire("u", "app")
            .await
            .unwrap()
            .cap_remaining_milli_2z,
        Some(5_000)
    );
    // …and the old hold's excess is bounded by the OLD period's remainder.
    let s = settled(w.settle(id, 90_000_000).await);
    assert_eq!(s.collected_milli_2z, 5_000);
    assert_eq!(s.shortfall_milli_2z, 4_000);
    assert_eq!(
        w.ledger
            .inquire("u", "app")
            .await
            .unwrap()
            .cap_remaining_milli_2z,
        Some(5_000)
    );
    // Re-consent does not reset history: same period, same collections.
    let _ = w.ledger.grant(
        "u",
        "app",
        GrantConfig {
            markup_bps: Bps(0),
            spend_cap_2z: Some(5),
        },
    );
    assert_eq!(
        w.ledger
            .inquire("u", "app")
            .await
            .unwrap()
            .cap_remaining_milli_2z,
        Some(5_000)
    );
}

#[tokio::test]
async fn an_unavailable_ledger_answers_nothing_and_changes_nothing() {
    let w = World::new(10_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(2).await;
    w.ledger.fail_next(2);
    assert_eq!(
        w.settle_err(id).await,
        LedgerError::Unavailable,
        "first attempt"
    );
    assert_eq!(w.settle_err(id).await, LedgerError::Unavailable);
    assert_eq!(w.ledger.call(id).unwrap().state, HoldState::Open);
    settled(w.settle(id, 10_000_000).await);
}

impl World {
    async fn settle_err(&self, hold_id: HoldId) -> LedgerError {
        self.ledger
            .settle(SettleRequest {
                hold_id,
                cost_nusd: 1,
                usage: Usage::default(),
                source: UsageSource::Provider,
            })
            .await
            .unwrap_err()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_holds_never_overspend() {
    let ledger = Arc::new(InMemoryLedger::new());
    ledger.open_account("u", 10_000);
    let agen = ledger.grant("u", "app", GrantConfig::default());
    ledger.add_rate_card(RateCard {
        version: 1,
        platform_margin_bps: Bps(0),
        models: BTreeMap::from([(
            MODEL.to_owned(),
            RateCardModel {
                prices: ModelPrices::default(),
                min_charge_2z: 1,
            },
        )]),
    });
    let mut tasks = Vec::new();
    for i in 0..64 {
        let ledger = Arc::clone(&ledger);
        tasks.push(tokio::spawn(async move {
            ledger
                .hold(HoldRequest {
                    user: "u".into(),
                    app: "app".into(),
                    amount_2z: 1,
                    hold_key: HoldKey {
                        call_id: format!("k{i}"),
                        attempt: 1,
                    },
                    aep: 1,
                    agen,
                    model_id: MODEL.into(),
                    rate_card_version: 1,
                    catalog_version: 1,
                    markup_bps: Bps(0),
                    ttl: TTL,
                })
                .await
                .unwrap()
        }));
    }
    let mut held = 0;
    for t in tasks {
        match t.await.unwrap() {
            HoldOutcome::Held(_) => held += 1,
            HoldOutcome::InsufficientBalance => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(held, 10, "exactly the balance, never more");
    ledger.check_invariants().unwrap();
}

#[tokio::test]
async fn a_reversal_beyond_the_available_balance_is_debt_and_refuses_every_hold() {
    let w = World::new(5_000, Bps(0), Bps(0), 1, None);
    let open = w.hold(2).await;
    // A 4 000 m2Z refund: 3 000 is available (2 000 is under the open hold
    // and is not taken), so 1 000 becomes debt.
    w.ledger.reverse_credit("u", 4_000);
    assert_eq!(w.ledger.debt_milli_2z("u"), Some(1_000));
    let inq = w.ledger.inquire("u", "app").await.unwrap();
    assert_eq!(inq.debt_milli_2z, 1_000);
    assert_eq!(inq.available_milli_2z, 0, "available is 0 while in debt");
    // Debt is reported before any affordability arithmetic: a 99 2Z hold is
    // `in_debt`, never `insufficient_balance`.
    assert_eq!(
        w.ledger.hold(w.request(99)).await.unwrap(),
        HoldOutcome::InDebt
    );
    // The open hold settles normally; its excess cannot deepen the debt.
    let s = settled(w.settle(open, 25_000_000).await);
    assert_eq!(s.charged_2z, 3);
    assert_eq!(s.collected_milli_2z, 2_000, "only the hold: available is 0");
    assert_eq!(s.shortfall_milli_2z, 1_000);
    assert_eq!(w.ledger.debt_milli_2z("u"), Some(1_000));
    // A purchase repays the debt first; only the rest reaches the balance.
    w.ledger.credit("u", 1_500);
    assert_eq!(w.ledger.debt_milli_2z("u"), Some(0));
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(500));
    assert_eq!(
        w.ledger.hold(w.request(1)).await.unwrap(),
        HoldOutcome::InsufficientBalance
    );
    w.ledger.check_invariants().unwrap();
}

#[tokio::test]
async fn the_unused_remainder_of_a_hold_repays_debt_when_it_ends() {
    let w = World::new(3_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(3).await;
    w.ledger.reverse_credit("u", 2_500);
    assert_eq!(
        w.ledger.debt_milli_2z("u"),
        Some(2_500),
        "nothing was available"
    );
    // Settles for 1 2Z; the 2 000 released is then subject to the debt.
    settled(w.settle(id, 5_000_000).await);
    assert_eq!(w.ledger.debt_milli_2z("u"), Some(500));
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(0));
    w.ledger.check_invariants().unwrap();

    // The same through a release.
    let w = World::new(3_000, Bps(0), Bps(0), 1, None);
    let id = w.hold(3).await;
    w.ledger.reverse_credit("u", 1_000);
    w.ledger.release(id).await.unwrap();
    assert_eq!(w.ledger.debt_milli_2z("u"), Some(0));
    assert_eq!(w.ledger.balance_milli_2z("u"), Some(2_000));
    w.ledger.check_invariants().unwrap();
}
