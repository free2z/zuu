//! The gateway's metering loop end to end, with no gateway: hold, stream from
//! the mock provider, read usage the way an adapter must, meter with
//! `f2z-ai-proto`, settle — or release when the provider fails before output.
//! This is the shape of test `f2z-ai` is expected to write against its own
//! adapters.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod common;

use core::time::Duration;
use std::collections::BTreeMap;

use common::adapter_usage;
use f2z_ai_proto::chat::UsageSource;
use f2z_ai_proto::pricing::{Bps, ModelPrices, metered_cost_nusd, price_2z};
use f2z_ai_testkit::ledger::{
    GrantConfig, HoldKey, HoldOutcome, HoldRequest, InMemoryLedger, LedgerContract, RateCard,
    RateCardModel, ReleaseOutcome, SettleOutcome, SettleRequest,
};
use f2z_ai_testkit::mock::{ChatFlavor, Fault, MockProvider, ProviderStyle, Scenario};
use serde_json::json;

const PRICES: ModelPrices = ModelPrices {
    input_nusd_per_mtok: 3_000_000_000,
    cached_input_nusd_per_mtok: 300_000_000,
    cache_write_nusd_per_mtok: 3_750_000_000,
    output_nusd_per_mtok: 15_000_000_000,
    image_nusd: 0,
    tool_call_nusd: 0,
};

fn ledger() -> (InMemoryLedger, u64) {
    let l = InMemoryLedger::new();
    l.open_account("u", 1_000_000);
    let agen = l.grant(
        "u",
        "app",
        GrantConfig {
            markup_bps: Bps(2_000),
            spend_cap_2z: None,
        },
    );
    l.add_rate_card(RateCard {
        version: 3,
        platform_margin_bps: Bps(5_000),
        models: BTreeMap::from([(
            "claude-test".to_owned(),
            RateCardModel {
                prices: PRICES,
                min_charge_2z: 1,
            },
        )]),
    });
    (l, agen)
}

fn hold_request(agen: u64, key: &str, amount_2z: u64) -> HoldRequest {
    HoldRequest {
        user: "u".into(),
        app: "app".into(),
        amount_2z,
        hold_key: HoldKey {
            call_id: key.into(),
            attempt: 1,
        },
        aep: 1,
        agen,
        model_id: "claude-test".into(),
        rate_card_version: 3,
        catalog_version: 1,
        markup_bps: Bps(2_000),
        ttl: Duration::from_secs(300),
    }
}

async fn stream(mock: &MockProvider) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!(
            "{}{}",
            mock.base_url(),
            ProviderStyle::AnthropicMessages.path()
        ))
        .header("content-type", "application/json")
        .body(json!({"model": "claude-test", "stream": true, "max_tokens": 900}).to_string())
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn hold_stream_meter_settle() {
    let scenario = Scenario::default()
        .with_input_tokens(1_200)
        .with_cache(5_000, 800)
        .with_output_tokens(350)
        .with_reasoning_tokens(100);
    let mock = MockProvider::start(scenario.clone()).await.unwrap();
    let (ledger, agen) = ledger();

    let HoldOutcome::Held(held) = ledger.hold(hold_request(agen, "call-1", 10)).await.unwrap()
    else {
        panic!()
    };
    let body = stream(&mock).await.bytes().await.unwrap();
    let usage = adapter_usage(ProviderStyle::AnthropicMessages, ChatFlavor::OpenAi, &body)
        .expect("a complete stream reports usage");
    assert_eq!(
        Some(usage),
        scenario.expected_usage(ProviderStyle::AnthropicMessages, true)
    );
    let cost = metered_cost_nusd(&usage, &PRICES).unwrap();
    let SettleOutcome::Settled(s) = ledger
        .settle(SettleRequest {
            hold_id: held.hold_id,
            cost_nusd: cost,
            usage,
            source: UsageSource::Provider,
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    // The gateway's own estimate and the ledger's charge agree exactly.
    let estimate = price_2z(&usage, &PRICES, Bps(5_000), Bps(2_000), 1).unwrap();
    assert_eq!(s.charged_2z, estimate.total_2z());
    assert_eq!(s.developer_milli_2z, estimate.developer_milli);
    assert_eq!(
        ledger.balance_milli_2z("u"),
        Some(1_000_000 - estimate.total_milli)
    );
    ledger.check_invariants().unwrap();
    mock.shutdown().await;
}

#[tokio::test]
async fn a_provider_error_before_output_releases_the_hold() {
    let mock = MockProvider::start(Scenario::default().with_fault(Fault::Status { status: 529 }))
        .await
        .unwrap();
    let (ledger, agen) = ledger();
    let HoldOutcome::Held(held) = ledger.hold(hold_request(agen, "call-2", 5)).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(stream(&mock).await.status().as_u16(), 529);
    // metering.md §5.2: nothing charged, hold released.
    assert_eq!(
        ledger.release(held.hold_id).await.unwrap(),
        ReleaseOutcome::Released
    );
    assert_eq!(ledger.balance_milli_2z("u"), Some(1_000_000));
    ledger.check_invariants().unwrap();
    mock.shutdown().await;
}
