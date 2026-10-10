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
    let catalog = verify_now(&f.served, &f.sig, &[f.key]).unwrap();
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
    verify_now(
        &fixture("catalog.canonical.json"),
        &f.sig,
        std::slice::from_ref(&f.key),
    )
    .unwrap();
    let tree: Value = serde_json::from_slice(&f.served).unwrap();
    let compact = serde_json::to_vec(&tree).unwrap();
    verify_now(&compact, &f.sig, &[f.key]).unwrap();
}

#[test]
fn a_changed_price_is_refused() {
    let f = load();
    let tampered = String::from_utf8(f.served)
        .unwrap()
        .replacen("15000000000", "1500000000", 1);
    assert!(matches!(
        verify_now(tampered.as_bytes(), &f.sig, &[f.key]),
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
        verify_now(tampered.as_bytes(), &f.sig, &[f.key]),
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
        verify_now(&f.served, &f.sig, &[other]),
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
        verify_now(&f.served, &f.sig, &[key]),
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
        verify_now(&f.served, &sig, &[f.key]),
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
        verify_now(dup.as_bytes(), &f.sig, &[f.key]),
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
        verify_now(with_float.as_bytes(), &f.sig, &[f.key]),
        // `Canonical` normally; `Json` if a dependent unified serde_json's
        // `arbitrary_precision` on, where the float is refused at parse.
        Err(CatalogError::Canonical(_) | CatalogError::Json(_))
    ));
}

type Mutation = fn(&mut Value);

#[test]
fn a_validly_signed_but_invalid_catalogue_is_refused() {
    let cases: [(&str, Mutation); 9] = [
        ("schema", |t| t["schema"] = serde_json::json!(2)),
        ("duplicate", |t| {
            let first = t["models"][0].clone();
            t["models"] = serde_json::json!([first.clone(), first]);
        }),
        ("safety", |t| {
            t["models"][0]["safety_factor_bps"] = serde_json::json!(9_999);
        }),
        ("min_charge", |t| {
            t["models"][0]["min_charge_2z"] = serde_json::json!(0);
        }),
        ("context_window", |t| {
            t["models"][0]["max_output_tokens"] = serde_json::json!(200_001);
        }),
        ("zero", |t| {
            for (_, v) in t["models"][0]["prices"].as_object_mut().unwrap() {
                *v = serde_json::json!(0);
            }
        }),
        ("margin", |t| {
            t["platform_margin_bps"] = serde_json::json!(100_001);
        }),
        ("expires_at", |t| t["expires_at"] = t["issued_at"].clone()),
        ("empty model id", |t| {
            t["models"][0]["id"] = serde_json::json!("")
        }),
    ];
    for (why, mutate) in cases {
        let mut tree: Value = serde_json::from_slice(&fixture("catalog.json")).unwrap();
        mutate(&mut tree);
        let (body, sig) = sign_tree(&tree);
        match verify_now(&body, &sig, &[load().key]) {
            Err(CatalogError::Invalid(msg)) => assert!(msg.contains(why), "{why}: {msg}"),
            other => panic!("{why}: expected Invalid, got {other:?}"),
        }
    }
    // The unmutated tree, re-signed the same way, is accepted: every refusal
    // above is the mutation's, not the harness's.
    let tree: Value = serde_json::from_slice(&fixture("catalog.json")).unwrap();
    let (body, sig) = sign_tree(&tree);
    verify_now(&body, &sig, &[load().key]).unwrap();
}

#[test]
fn an_unknown_price_dimension_is_refused_not_priced_at_zero() {
    let mut tree: Value = serde_json::from_slice(&fixture("catalog.json")).unwrap();
    tree["models"][0]["prices"]["audio_nusd_per_mtok"] = serde_json::json!(5);
    let (body, sig) = sign_tree(&tree);
    assert!(matches!(
        verify_now(&body, &sig, &[load().key]),
        Err(CatalogError::Invalid("model prices"))
    ));
}

#[test]
fn an_unknown_api_style_disables_one_model_not_the_catalogue() {
    let f = load();
    let catalog = verify_now(&f.served, &f.sig, &[f.key]).unwrap();
    let future = catalog
        .models
        .iter()
        .find(|m| m.id == "example-future-style")
        .unwrap();
    assert_eq!(future.api_style, ApiStyle::Unknown);
    assert!(future.enabled);
    assert!(catalog.callable_model("example-future-style").is_none());
    assert!(catalog.callable_model("example-mini").is_some());
}

#[test]
fn an_expired_catalogue_is_refused() {
    let f = load();
    let expires_at = verify_now(&f.served, &f.sig, std::slice::from_ref(&f.key))
        .unwrap()
        .expires_at;
    verify_catalog(
        &f.served,
        &f.sig,
        std::slice::from_ref(&f.key),
        expires_at - 1,
    )
    .unwrap();
    for now in [expires_at, expires_at + 1, u64::MAX] {
        assert!(matches!(
            verify_catalog(&f.served, &f.sig, std::slice::from_ref(&f.key), now),
            Err(CatalogError::Expired)
        ));
    }
}

#[test]
fn a_small_order_key_is_refused_even_where_plain_verify_would_accept() {
    // The identity point as a public key, and the signature (R = identity,
    // s = 0). Plain `verify` checks [s]B == R + [k]A, i.e. 0 == 0 + 0, and so
    // accepts it for EVERY message. `verify_strict` refuses the weak key. If
    // verify_catalog were ever relaxed to `verify`, an attacker who got the
    // identity key trusted would forge any catalogue.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut sig_bytes = [0u8; 64];
    sig_bytes[0] = 1;
    let weak = ed25519_dalek::VerifyingKey::from_bytes(&identity).unwrap();
    let forged = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    // Precondition: the forgery really does pass non-strict verification.
    use ed25519_dalek::Verifier as _;
    assert!(weak.verify(b"anything", &forged).is_ok());

    let f = load();
    let key = TrustedKey {
        key_id: "weak".into(),
        key: weak,
    };
    let sig = DetachedSignature {
        key_id: "weak".into(),
        signature: forged,
    };
    assert!(matches!(
        verify_now(&f.served, &sig, &[key]),
        Err(CatalogError::BadSignature)
    ));
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

/// Fixture time: after `issued_at`, before `expires_at`.
const NOW: u64 = 1_790_000_100;

fn verify_now(
    payload: &[u8],
    sig: &DetachedSignature,
    trusted: &[TrustedKey],
) -> Result<f2z_ai_proto::catalog::Catalog, CatalogError> {
    verify_catalog(payload, sig, trusted, NOW)
}

/// Sign `tree` with the fixture key, exactly as the platform signer would.
fn sign_tree(tree: &Value) -> (Vec<u8>, DetachedSignature) {
    let secret = hex32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let signer = SigningKey::from_bytes(&secret);
    let sig = DetachedSignature {
        key_id: load().key.key_id,
        signature: signer.sign(&catalog_signing_message(tree).unwrap()),
    };
    (serde_json::to_vec(tree).unwrap(), sig)
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
