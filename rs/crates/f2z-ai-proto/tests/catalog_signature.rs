//! Catalogue signature verification against `fixtures/catalog/`.
//!
//! The fixture was signed by `fixtures/catalog/sign_fixture.py` — Python's
//! `cryptography` and `json.dumps(sort_keys=True, separators=(",", ":"))`, not
//! this crate — so these tests prove the Rust verifier accepts what an
//! independent signer produces, which is the property the platform's own
//! signer relies on. Each refusal test mutates one input and names the step
//! that must refuse it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use ed25519_dalek::{Signer, SigningKey};
use f2z_ai_proto::catalog::{
    ApiStyle, CATALOG_SIGNING_LABEL, CatalogError, DetachedSignature, TrustedKey,
    catalog_signing_message, verify_catalog,
};
use serde_json::Value;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/fixtures/catalog/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

struct Fixture {
    served: Vec<u8>,
    key: TrustedKey,
    sig: DetachedSignature,
}

fn load() -> Fixture {
    let meta: Value = serde_json::from_slice(&fixture("signature.json")).unwrap();
    let key_id = meta["key_id"].as_str().unwrap();
    assert_eq!(
        meta["signing_label"].as_str().unwrap().as_bytes(),
        CATALOG_SIGNING_LABEL
    );
    Fixture {
        served: fixture("catalog.json"),
        key: TrustedKey::from_hex(key_id, meta["public_key_hex"].as_str().unwrap()).unwrap(),
        sig: DetachedSignature::from_hex(key_id, meta["signature_hex"].as_str().unwrap()).unwrap(),
    }
}

#[test]
fn an_independently_signed_catalogue_verifies() {
    let f = load();
    let catalog = verify_catalog(&f.served, &f.sig, &[f.key]).unwrap();
    assert_eq!(catalog.version, 7);
    assert_eq!(catalog.platform_margin_bps.0, 5_000);
    let large = catalog.callable_model("example-large").unwrap();
    assert_eq!(large.api_style, ApiStyle::AnthropicMessages);
    assert_eq!(large.prices.output_nusd_per_mtok, 15_000_000_000);
    assert_eq!(large.safety_factor_bps.0, 11_500);
    // Enabled, but its provider is disabled by policy.
    assert!(
        catalog
            .callable_model("example-disabled-provider")
            .is_none()
    );
    assert!(catalog.callable_model("nope").is_none());
}

#[test]
fn the_signing_message_is_label_then_canonical_json() {
    let tree: Value = serde_json::from_slice(&fixture("catalog.json")).unwrap();
    let mut expected = CATALOG_SIGNING_LABEL.to_vec();
    expected.extend_from_slice(&fixture("catalog.canonical.json"));
    assert_eq!(catalog_signing_message(&tree).unwrap(), expected);
}

#[test]
fn reformatting_the_served_json_does_not_break_the_signature() {
    let f = load();
    // Canonical bytes, and a different whitespace, both verify.
    verify_catalog(
        &fixture("catalog.canonical.json"),
        &f.sig,
        std::slice::from_ref(&f.key),
    )
    .unwrap();
    let tree: Value = serde_json::from_slice(&f.served).unwrap();
    let compact = serde_json::to_vec(&tree).unwrap();
    verify_catalog(&compact, &f.sig, &[f.key]).unwrap();
}

#[test]
fn a_changed_price_is_refused() {
    let f = load();
    let tampered = String::from_utf8(f.served)
        .unwrap()
        .replacen("15000000000", "1500000000", 1);
    assert!(matches!(
        verify_catalog(tampered.as_bytes(), &f.sig, &[f.key]),
        Err(CatalogError::BadSignature)
    ));
}

#[test]
fn a_changed_ignored_member_is_still_refused() {
    // `note` is not a `Catalog` field, but it is inside the signed bytes.
    let f = load();
    let tampered = String::from_utf8(f.served)
        .unwrap()
        .replacen("fixture —", "fixture -", 1);
    assert!(matches!(
        verify_catalog(tampered.as_bytes(), &f.sig, &[f.key]),
        Err(CatalogError::BadSignature)
    ));
}

#[test]
fn an_untrusted_key_id_is_refused() {
    let f = load();
    let other = TrustedKey {
        key_id: "another".into(),
        key: f.key.key,
    };
    assert!(matches!(
        verify_catalog(&f.served, &f.sig, &[other]),
        Err(CatalogError::UnknownKey)
    ));
}

#[test]
fn a_trusted_id_with_the_wrong_key_is_refused() {
    let f = load();
    let wrong = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
    let key = TrustedKey {
        key_id: f.key.key_id.clone(),
        key: wrong,
    };
    assert!(matches!(
        verify_catalog(&f.served, &f.sig, &[key]),
        Err(CatalogError::BadSignature)
    ));
}

#[test]
fn a_signature_without_the_label_is_refused() {
    // Same key, same canonical JSON, but signed without domain separation.
    let secret: [u8; 32] =
        hex32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let signer = SigningKey::from_bytes(&secret);
    let f = load();
    let bare = signer.sign(&fixture("catalog.canonical.json"));
    let sig = DetachedSignature {
        key_id: f.key.key_id.clone(),
        signature: bare,
    };
    assert!(matches!(
        verify_catalog(&f.served, &sig, &[f.key]),
        Err(CatalogError::BadSignature)
    ));
}

#[test]
fn a_duplicate_member_is_refused_even_though_the_signature_would_verify() {
    // `serde_json` keeps the last duplicate, so prepending `"version": 999`
    // leaves a tree that still verifies. A first-wins parser elsewhere would
    // read 999. Refuse the ambiguity.
    let f = load();
    let dup = String::from_utf8(f.served)
        .unwrap()
        .replacen("{", "{\"version\": 999,", 1);
    assert!(matches!(
        verify_catalog(dup.as_bytes(), &f.sig, &[f.key]),
        Err(CatalogError::Json(_))
    ));
}

#[test]
fn a_float_is_refused_before_verification() {
    let f = load();
    let with_float =
        String::from_utf8(f.served)
            .unwrap()
            .replacen("\"version\": 7", "\"version\": 7.0", 1);
    assert!(matches!(
        verify_catalog(with_float.as_bytes(), &f.sig, &[f.key]),
        Err(CatalogError::Canonical(_))
    ));
}

#[test]
fn a_validly_signed_but_invalid_catalogue_is_refused() {
    let secret: [u8; 32] =
        hex32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let signer = SigningKey::from_bytes(&secret);
    let f = load();
    let mut tree: Value = serde_json::from_slice(&f.served).unwrap();
    for (field, value, why) in [
        ("schema", serde_json::json!(2), "schema"),
        ("models", dup_models(&tree), "duplicate"),
        ("models", low_safety(&tree), "safety"),
    ] {
        let original = tree[field].clone();
        tree[field] = value;
        let message = catalog_signing_message(&tree).unwrap();
        let sig = DetachedSignature {
            key_id: f.key.key_id.clone(),
            signature: signer.sign(&message),
        };
        let body = serde_json::to_vec(&tree).unwrap();
        match verify_catalog(&body, &sig, std::slice::from_ref(&f.key)) {
            Err(CatalogError::Invalid(msg)) => assert!(msg.contains(why), "{why}: {msg}"),
            other => panic!("{why}: expected Invalid, got {other:?}"),
        }
        tree[field] = original;
    }
}

#[test]
fn malformed_hex_is_refused() {
    assert!(matches!(
        DetachedSignature::from_hex("k", "00"),
        Err(CatalogError::BadSignatureEncoding)
    ));
    assert!(matches!(
        TrustedKey::from_hex("k", &"G".repeat(64)),
        Err(CatalogError::BadKey)
    ));
}

fn dup_models(tree: &Value) -> Value {
    let first = tree["models"][0].clone();
    serde_json::json!([first.clone(), first])
}

fn low_safety(tree: &Value) -> Value {
    let mut models = tree["models"].clone();
    models[0]["safety_factor_bps"] = serde_json::json!(9_999);
    models
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
