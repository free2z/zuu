//! External-consumer regression test for the API removed by #700.
//!
//! This deliberately makes one narrow claim: the former
//! `DeviceSignatureKey::sign_mls_content(&[u8])` API does not compile. It is
//! not a census of every name or wrapper by which a future signing oracle
//! could be exposed. A complete public-API policy needs compiler-derived data;
//! stable Rust 1.97.1 does not expose rustdoc JSON.
//!
//! Follow-up proposal: once rustdoc JSON is stable, snapshot the compiler's
//! externally reachable API for every supported target/feature combination,
//! normalize resolved type identities and re-exports, and mutation-test macro-
//! and cfg-generated signing surfaces. Until then this test must stay narrow.

#[test]
fn removed_mls_signing_method_is_not_callable_by_a_consumer() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/device_signature_key_has_no_mls_signing_method.rs");
}
