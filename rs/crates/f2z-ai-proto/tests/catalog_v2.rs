//! Opt-in pricing math and signed-schema compatibility; no running gateway
//! consumes schema 2 until its ledger and model-list contracts adopt it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
use ed25519_dalek::{Signer, SigningKey};
use f2z_ai_proto::Usage;
use f2z_ai_proto::catalog::{
    CatalogError, DetachedSignature, TrustedKey, catalog_signing_message, verify_catalog,
};
use f2z_ai_proto::catalog_v2::{CatalogModelV2, verify_catalog_v2};
use serde_json::{Value, json};

fn payload() -> Value {
    let mut v: Value =
        serde_json::from_str(include_str!("../fixtures/catalog/catalog.json")).unwrap();
    v["schema"] = json!(2);
    v["models"].as_array_mut().unwrap().truncate(1);
    v["models"][0]["context_window"] = json!(1000);
    v["models"][0]["max_output_tokens"] = json!(100);
    v["models"][0]["prices"] = json!({
        "input_nusd_per_mtok":2_000_000_000u64,"cached_input_nusd_per_mtok":200_000_000,
        "cache_write_nusd_per_mtok":2_500_000_000u64,"output_nusd_per_mtok":10_000_000_000u64,
        "image_nusd":0,"tool_call_nusd":0
    });
    v["models"][0]["long_context_pricing"] = json!({"input_tokens_gt":100,"prices":{
        "input_nusd_per_mtok":4_000_000_000u64,"cached_input_nusd_per_mtok":400_000_000,
        "cache_write_nusd_per_mtok":5_000_000_000u64,"output_nusd_per_mtok":15_000_000_000u64,
        "image_nusd":0,"tool_call_nusd":0
    }});
    v
}
fn signed(v: &Value) -> (Vec<u8>, DetachedSignature, TrustedKey) {
    let key = SigningKey::from_bytes(&[73; 32]);
    (
        serde_json::to_vec(v).unwrap(),
        DetachedSignature {
            key_id: "test-only".into(),
            signature: key.sign(&catalog_signing_message(v).unwrap()),
        },
        TrustedKey {
            key_id: "test-only".into(),
            key: key.verifying_key(),
        },
    )
}
fn read(v: &Value) -> Result<f2z_ai_proto::catalog_v2::CatalogV2, CatalogError> {
    let (bytes, sig, key) = signed(v);
    verify_catalog_v2(&bytes, &sig, &[key], v["issued_at"].as_u64().unwrap())
}
fn model() -> CatalogModelV2 {
    read(&payload()).unwrap().models.remove(0)
}

#[test]
fn v2_is_explicit_and_v1_rejects_tier_presence_even_null() {
    let v = payload();
    let (bytes, sig, key) = signed(&v);
    assert!(verify_catalog(&bytes, &sig, &[key], 0).is_err());
    assert_eq!(read(&v).unwrap().schema, 2);
    for tier in [Value::Null, v["models"][0]["long_context_pricing"].clone()] {
        let mut old = v.clone();
        old["schema"] = json!(1);
        old["models"][0]["long_context_pricing"] = tier;
        let (bytes, sig, key) = signed(&old);
        assert!(matches!(
            verify_catalog(&bytes, &sig, &[key], 0),
            Err(CatalogError::Invalid(
                "context pricing requires catalogue schema 2"
            ))
        ));
    }
    for schema in [0, 1, 3] {
        let mut bad = v.clone();
        bad["schema"] = json!(schema);
        assert!(read(&bad).is_err());
    }
    let mut flat = v;
    flat["models"][0]
        .as_object_mut()
        .unwrap()
        .remove("long_context_pricing");
    assert!(
        read(&flat).unwrap().models[0]
            .long_context_pricing
            .is_none()
    );
}

#[test]
fn signatures_cover_tier_and_expiry_and_reject_duplicate_members() {
    let v = payload();
    let (bytes, sig, key) = signed(&v);
    let mut changed = v.clone();
    changed["models"][0]["long_context_pricing"]["input_tokens_gt"] = json!(101);
    assert!(matches!(
        verify_catalog_v2(
            &serde_json::to_vec(&changed).unwrap(),
            &sig,
            std::slice::from_ref(&key),
            0
        ),
        Err(CatalogError::BadSignature)
    ));
    assert!(matches!(
        verify_catalog_v2(
            &bytes,
            &sig,
            std::slice::from_ref(&key),
            v["expires_at"].as_u64().unwrap()
        ),
        Err(CatalogError::Expired)
    ));
    let duplicate =
        String::from_utf8(bytes)
            .unwrap()
            .replacen("\"schema\":2", "\"schema\":2,\"schema\":2", 1);
    assert!(matches!(
        verify_catalog_v2(duplicate.as_bytes(), &sig, &[key], 0),
        Err(CatalogError::Json(_))
    ));
}

#[test]
fn invalid_tiers_fail_closed_but_zero_dimensions_are_valid() {
    assert!(read(&payload()).is_ok()); // zero image/tool prices are intentional
    for threshold in [0, 1000, 1001] {
        let mut v = payload();
        v["models"][0]["long_context_pricing"]["input_tokens_gt"] = json!(threshold);
        assert!(read(&v).is_err());
    }
    for dimension in [
        "input_nusd_per_mtok",
        "cached_input_nusd_per_mtok",
        "cache_write_nusd_per_mtok",
        "output_nusd_per_mtok",
    ] {
        let mut v = payload();
        v["models"][0]["long_context_pricing"]["prices"][dimension] = json!(0);
        assert!(read(&v).is_err());
    }
    for field in ["discount", "another_tier"] {
        let mut v = payload();
        v["models"][0]["long_context_pricing"][field] = Value::Null;
        assert!(read(&v).is_err());
    }
    let mut v = payload();
    v["models"][0]["long_context_pricing"]["prices"]["new_money_dimension"] = json!(1);
    assert!(read(&v).is_err());
}

#[test]
fn threshold_uses_all_exclusive_input_and_amplifies_the_whole_output() {
    let m = model();
    for (ordinary, cost) in [(49, 217000), (50, 219000), (51, 422000)] {
        let usage = Usage {
            input_tokens: ordinary,
            cached_input_tokens: 20,
            cache_write_tokens: 30,
            output_tokens: 4,
            ..Usage::default()
        };
        assert_eq!(m.cost_nusd(&usage).unwrap().get(), cost);
    }
    let output = Usage {
        input_tokens: 100,
        output_tokens: 10_000,
        reasoning_tokens: 10_000,
        ..Usage::default()
    };
    assert_eq!(m.cost_nusd(&output).unwrap().get(), 100_200_000);
    assert!(
        m.cost_nusd(&Usage {
            input_tokens: u64::MAX,
            cached_input_tokens: 1,
            ..Usage::default()
        })
        .is_err()
    );
    assert!(
        m.cost_nusd(&Usage {
            cached_input_tokens: u64::MAX,
            cache_write_tokens: 1,
            ..Usage::default()
        })
        .is_err()
    );
}

#[test]
fn reservation_covers_cache_write_premium_and_output_tier() {
    let m = model();
    assert_eq!(m.token_reservation_cost_nusd(100, 4).unwrap().get(), 290000);
    let held = m.token_reservation_cost_nusd(101, 4).unwrap();
    assert_eq!(held.get(), 565000);
    // Every possible cache composition at and below the certified input bound.
    for input in 0..=101 {
        for cached in 0..=input {
            let written = input - cached;
            for output in 0..=4 {
                let usage = Usage {
                    cached_input_tokens: cached,
                    cache_write_tokens: written,
                    output_tokens: output,
                    ..Usage::default()
                };
                assert!(m.cost_nusd(&usage).unwrap() <= held);
            }
        }
    }
    let mut flat = m.clone();
    flat.long_context_pricing = None;
    let usage = Usage {
        input_tokens: 101,
        output_tokens: 4,
        ..Usage::default()
    };
    assert_eq!(
        flat.cost_nusd(&usage).unwrap(),
        f2z_ai_proto::metered_cost_nusd(&usage, &flat.base.prices).unwrap()
    );
}
