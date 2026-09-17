//! **Contract C's shared test vectors** (zuu#1022, ADR 0017 §5).
//!
//! The free2z backend issues `HandleAssertion`s; this crate is the format.
//! `tests/fixtures/handle-assertion-v1.vectors` is the file both sides hold
//! themselves to: an issuer in another language is correct when, from the
//! inputs in that file, it produces the `tbs`, `signature` and `assertion`
//! bytes in that file exactly. Ed25519 (RFC 8032) is deterministic, so this is
//! a byte comparison, not a "verifies" check.
//!
//! This test regenerates every derived value with this crate and fails if the
//! file disagrees, so the vectors cannot drift from the code. After a
//! deliberate format change, rewrite the file with
//! `F2Z_BLESS_CONTRACT_C=1 cargo test -p f2z-authority --test contract_c_vectors`
//! and review the diff — a change here is a wire change for the backend.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use f2z_authority::{
    AssertionNonce, AuthorityConfig, AuthorityError, AuthoritySet, EntryKind, Handle,
    HandleAssertion, HandleAssertionTBS, Intent, LogId, NonceLedger, SigningKey, Submission,
    authority_id,
};
use f2z_codec::canonical::{Canonical as _, decode_canonical};
use f2z_codec::types::Digest;

const AUTHORITY_SEED: [u8; 32] = seq(0x00);
const IDENTITY_SEED: [u8; 32] = seq(0x40);
const STRANGER_SEED: [u8; 32] = seq(0x80);
const LOG_ID: [u8; 32] = seq(0x20);
const NONCE: [u8; 16] = [
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
];
const ENTRY_DIGEST: [u8; 32] = seq(0xc0);
const HANDLE: &str = "alice_01";
const ACCOUNT_EPOCH: u32 = 0;
const ISSUED_MS: u64 = 1_758_067_200_000;
const EXPIRES_MS: u64 = ISSUED_MS + 900_000;
/// Inside the validity window, for the acceptance check.
const CHECKED_AT_MS: u64 = ISSUED_MS + 1_000;

const fn seq(start: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut index = 0;
    while index < 32 {
        out[index] = start.wrapping_add(index as u8);
        index += 1;
    }
    out
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/handle-assertion-v1.vectors")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        write!(out, "{byte:02x}").unwrap();
        out
    })
}

fn body(authority: &SigningKey, identity: &SigningKey) -> HandleAssertionTBS {
    HandleAssertionTBS::new(
        &authority.public_key(),
        LogId::new(LOG_ID),
        Handle::parse(HANDLE.as_bytes()).unwrap(),
        identity.public_key(),
        Intent::Bind,
        ACCOUNT_EPOCH,
        ISSUED_MS,
        EXPIRES_MS,
        AssertionNonce::new(NONCE),
    )
    .unwrap()
}

/// Every line of the fixture, in order, regenerated.
fn render() -> String {
    let authority = SigningKey::from_seed(&AUTHORITY_SEED);
    let identity = SigningKey::from_seed(&IDENTITY_SEED);
    let stranger = SigningKey::from_seed(&STRANGER_SEED);

    let tbs = body(&authority, &identity);
    let signed = tbs.clone().sign(&authority).unwrap();
    let assertion = signed.encode_canonical().unwrap();

    let config = AuthorityConfig::with_defaults(
        LogId::new(LOG_ID),
        AuthoritySet::single(authority.public_key()).unwrap(),
    )
    .unwrap();
    let handle = Handle::parse(HANDLE.as_bytes()).unwrap();
    let binding = config
        .binding(
            &handle,
            &identity.public_key(),
            Some(&signed),
            &Digest::new(ENTRY_DIGEST),
        )
        .unwrap();

    let stranger_body = HandleAssertionTBS {
        authority_id: authority_id(&stranger.public_key()),
        ..tbs.clone()
    };
    let stranger_assertion = stranger_body.sign(&stranger).unwrap();

    let mut out = String::new();
    let mut line = |key: &str, value: String| writeln!(out, "{key} = {value}").unwrap();
    out_header(&mut line);
    line("authority_seed", hex(&AUTHORITY_SEED));
    line("authority_pk", hex(authority.public_key().as_bytes()));
    line("authority_id", hex(tbs.authority_id.as_bytes()));
    line("log_id", hex(&LOG_ID));
    line("handle", HANDLE.to_owned());
    line("handle_id", hex(tbs.handle_id.as_bytes()));
    line("identity_seed", hex(&IDENTITY_SEED));
    line("identity_pk", hex(identity.public_key().as_bytes()));
    line("intent", "1".to_owned());
    line("account_epoch", ACCOUNT_EPOCH.to_string());
    line("issued_ms", ISSUED_MS.to_string());
    line("expires_ms", EXPIRES_MS.to_string());
    line("nonce", hex(&NONCE));
    line("tbs", hex(&tbs.signing_bytes().unwrap()));
    line("signature", hex(signed.signature.as_bytes()));
    line("assertion", hex(&assertion));
    line("assertion_len", assertion.len().to_string());
    line("assertion_digest", hex(signed.digest().unwrap().as_bytes()));
    line("entry_digest", hex(&ENTRY_DIGEST));
    line("binding_tbs", hex(&binding.signing_bytes().unwrap()));
    line(
        "identity_signature",
        hex(binding.sign(&identity).unwrap().as_bytes()),
    );
    line("stranger_seed", hex(&STRANGER_SEED));
    line(
        "stranger_assertion",
        hex(&stranger_assertion.encode_canonical().unwrap()),
    );
    out
}

fn out_header(line: &mut impl FnMut(&str, String)) {
    // Written as ordinary keys so the file stays one grammar: `key = value`,
    // `#` comments, nothing else.
    line("format", "free2z/kt/v1/handle-assertion".to_owned());
    line(
        "encoding",
        "tls-presentation-language, big-endian".to_owned(),
    );
}

fn parse(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(|line| line.split('#').next().unwrap().trim())
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (key, value) = line.split_once(" = ").expect("`key = value`");
            (key.to_owned(), value.to_owned())
        })
        .collect()
}

const PREAMBLE: &str = "\
# Contract C shared test vectors — HandleAssertion, KT protocol v1 (zuu#1022).
#
# Generated and checked by rs/crates/f2z-authority/tests/contract_c_vectors.rs.
# An issuer is conformant when, from authority_seed, log_id, handle,
# identity_pk, intent, account_epoch, issued_ms, expires_ms and nonce, it
# produces `tbs`, `signature` and `assertion` byte for byte. All byte values
# are lowercase hex. `handle` is ASCII. Ed25519 is RFC 8032 (deterministic).
#
# `assertion`, base64url-encoded, is the `assertion` field of a successful
# POST /api/kt/handle-assertion/ response (ADR 0017 §5).
#
# `stranger_assertion` is the same body under another key and its own
# authority_id; a log configured with `authority_pk` MUST refuse it
# (ERR_BAD_AUTHORIZATION). `binding_tbs` / `identity_signature` are what the
# enrolling device adds beside the assertion; the backend never produces them.
#
# DO NOT use these seeds for anything real.

";

#[test]
fn the_contract_c_vectors_match_this_crate_byte_for_byte() {
    let rendered = format!("{PREAMBLE}{}", render());
    if std::env::var_os("F2Z_BLESS_CONTRACT_C").is_some() {
        std::fs::write(fixture_path(), &rendered).unwrap();
    }
    let on_disk = std::fs::read_to_string(fixture_path())
        .expect("tests/fixtures/handle-assertion-v1.vectors is checked in");
    assert_eq!(
        parse(&on_disk),
        parse(&rendered),
        "the checked-in Contract C vectors no longer match f2z-authority; this is a wire change \
         for the backend issuer"
    );
    assert_eq!(on_disk, rendered, "the fixture's comments or order drifted");
}

#[test]
fn the_vector_assertion_passes_the_logs_check_and_the_stranger_does_not() {
    let vectors = parse(&std::fs::read_to_string(fixture_path()).unwrap());
    let bytes = |key: &str| -> Vec<u8> {
        let text = &vectors[key];
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    };
    let authority_pk: [u8; 32] = bytes("authority_pk").try_into().unwrap();
    let config = AuthorityConfig::with_defaults(
        LogId::new(bytes("log_id").try_into().unwrap()),
        AuthoritySet::single(f2z_codec::types::PublicKey::new(authority_pk)).unwrap(),
    )
    .unwrap();
    let handle = Handle::parse(vectors["handle"].as_bytes()).unwrap();
    let identity_pk = f2z_codec::types::PublicKey::new(bytes("identity_pk").try_into().unwrap());
    let entry_digest = Digest::new(bytes("entry_digest").try_into().unwrap());
    let signature =
        f2z_codec::types::Signature::new(bytes("identity_signature").try_into().unwrap());

    let check = |assertion: &[u8]| {
        let mut ledger = NonceLedger::new(16, config.clock_skew_ms());
        config.check_assertion_layer(
            &Submission {
                assertion: Some(assertion),
                kind: EntryKind::InitialBind,
                handle: &handle,
                identity_pk: &identity_pk,
                entry_version: 1,
                entry_digest: &entry_digest,
                identity_signature: &signature,
                previous_identity_pk: None,
                previous_vouch: None,
                previous_account_epoch: None,
            },
            CHECKED_AT_MS,
            &mut ledger,
        )
    };

    let assertion = bytes("assertion");
    assert_eq!(assertion.len().to_string(), vectors["assertion_len"]);
    let decoded = decode_canonical::<HandleAssertion>(&assertion)
        .unwrap()
        .into_value();
    assert_eq!(decoded.assertion.signing_bytes().unwrap(), bytes("tbs"));
    assert!(check(&assertion).unwrap().vouch().is_vouched());
    assert_eq!(
        check(&bytes("stranger_assertion")).unwrap_err(),
        AuthorityError::UnknownAuthority
    );
}
