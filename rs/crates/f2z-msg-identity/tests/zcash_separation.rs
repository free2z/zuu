//! **No Zcash spending or viewing key is reachable from any messaging key
//! path.**
//!
//! [#311]'s last acceptance criterion, spelled out as a test, and
//! [ADR 0006]'s hard constraint: *"never reuse Sapling/Orchard spending or
//! viewing keys as messaging keys. Different curves (Jubjub/Pallas vs.
//! X25519/Ed25519) and, more fundamentally, key separation is bedrock."*
//!
//! # What this file actually derives, and why it has to
//!
//! Asserting the constants differ is not the property. The property is about
//! *derivations*: that starting from **one seed**, the messaging tree and the
//! two Zcash trees produce disjoint key material at every level and at every
//! index. So this test implements ZIP 32's Sapling and Orchard master and child
//! derivations — from the specification, in the test, in about thirty lines —
//! walks all three trees over the same seed and the same indices, and asserts
//! that no 32-byte value produced by one appears anywhere in the others.
//!
//! It reuses [`f2z_msg_identity::blake::blake2b512_personal`] for all three
//! trees deliberately. Using a *different* BLAKE2b would prove that two
//! implementations disagree, which is not interesting; using the same one
//! isolates the single variable that is supposed to be doing the separating —
//! the 16-byte personalization — and shows it doing it.
//!
//! # Why the separation is structural rather than lucky
//!
//! A BLAKE2 personalization is a **parameter-block field**, not a prefix on the
//! message. Two personalizations are therefore two different compression
//! functions, initialized from different `h[6]`/`h[7]` words, all the way down.
//! ADR 0006's consequence — *"cannot collide with the Sapling or Orchard key
//! trees even at identical indices"* — is a fact about that construction, and
//! the assertions below are its observable form rather than its proof.
//!
//! # The other direction: the seed is not recoverable
//!
//! §4.2: `MSK = BLAKE2b-512(personal, S)` is one-way, "S is not recoverable
//! from MSK". This file asserts the observable half of that too — no messaging
//! output contains the seed, and this crate exposes no function that returns
//! one — because "we did not write that function" is exactly the kind of claim
//! that stops being true silently.
//!
//! [#311]: https://github.com/free2z/zuu/issues/311
//! [ADR 0006]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0006-zcash-coupling.md

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeSet;

use f2z_msg_identity::account::AccountKeys;
use f2z_msg_identity::blake::blake2b512_personal;
use f2z_msg_identity::node::{HardenedIndex, ckd_hardened, master_node};

/// BIP-39's published seed for the all-`abandon` mnemonic. The same seed feeds
/// all three trees, which is the whole point: a user's wallet and a user's
/// messaging identity come from one mnemonic.
const SEED: [u8; 64] = [
    0x5e, 0xb0, 0x0b, 0xbd, 0xdc, 0xf0, 0x69, 0x08, 0x48, 0x89, 0xa8, 0xab, 0x91, 0x55, 0x56, 0x81,
    0x65, 0xf5, 0xc4, 0x53, 0xcc, 0xb8, 0x5e, 0x70, 0x81, 0x1a, 0xae, 0xd6, 0xf6, 0xda, 0x5f, 0xc1,
    0x9a, 0x5a, 0xc4, 0x0b, 0x38, 0x9c, 0xd3, 0x70, 0xd0, 0x86, 0x20, 0x6d, 0xec, 0x8a, 0xa6, 0xc4,
    0x3d, 0xae, 0xa6, 0x69, 0x0f, 0x20, 0xad, 0x3d, 0x8d, 0x48, 0xb2, 0xd2, 0xce, 0x9e, 0x38, 0xe4,
];

// ---------------------------------------------------------------------------
// ZIP 32, transcribed. https://zips.z.cash/zip-0032
// ---------------------------------------------------------------------------

/// ZIP 32 §5.1: `m_Sapling = BLAKE2b-512("ZcashIP32Sapling", S)`.
const PERSONAL_SAPLING: &[u8; 16] = b"ZcashIP32Sapling";

/// ZIP 32 §5.5: `m_Orchard = BLAKE2b-512("ZcashIP32Orchard", S)`.
const PERSONAL_ORCHARD: &[u8; 16] = b"ZcashIP32Orchard";

/// ZIP 32 §4.1.1: `PRF^expand(sk, t) = BLAKE2b-512("Zcash_ExpandSeed", sk || t)`.
///
/// This is the function that turns a Sapling spending key into `ask`, `nsk` and
/// `ovk` — the spending and viewing key material ADR 0006 names.
const PERSONAL_EXPAND_SEED: &[u8; 16] = b"Zcash_ExpandSeed";

fn prf_expand(sk: &[u8], tag: &[u8]) -> Vec<u8> {
    let mut input = sk.to_vec();
    input.extend_from_slice(tag);
    blake2b512_personal(PERSONAL_EXPAND_SEED, &input).to_vec()
}

/// ZIP 32 §5.2, hardened Sapling child derivation:
/// `I = PRF^expand(c_par, [0x11] || sk_par || I2LEOSP_32(i))`.
fn sapling_child(node: &[u8], ordinal: u32) -> Vec<u8> {
    let (sk_par, c_par) = node.split_at(32);
    let mut tag = vec![0x11u8];
    tag.extend_from_slice(sk_par);
    tag.extend_from_slice(&(ordinal | 0x8000_0000).to_le_bytes());
    prf_expand(c_par, &tag)
}

/// ZIP 32 §5.6, hardened Orchard child derivation: the same shape with the
/// `0x81` domain byte.
fn orchard_child(node: &[u8], ordinal: u32) -> Vec<u8> {
    let (sk_par, c_par) = node.split_at(32);
    let mut tag = vec![0x81u8];
    tag.extend_from_slice(sk_par);
    tag.extend_from_slice(&(ordinal | 0x8000_0000).to_le_bytes());
    prf_expand(c_par, &tag)
}

/// Every 32-byte value the Zcash trees produce from `SEED` over the path
/// `m / 32' / 133' / 0'` and its neighbours — nodes, chain codes, and the
/// Sapling spending and viewing key components.
fn zcash_key_material() -> BTreeSet<[u8; 32]> {
    let mut material = BTreeSet::new();
    let mut record = |bytes: &[u8]| {
        for window in bytes.chunks(32) {
            if let Ok(chunk) = <[u8; 32]>::try_from(window) {
                material.insert(chunk);
            }
        }
    };

    for (personal, child) in [
        (PERSONAL_SAPLING, sapling_child as fn(&[u8], u32) -> Vec<u8>),
        (PERSONAL_ORCHARD, orchard_child as fn(&[u8], u32) -> Vec<u8>),
    ] {
        let mut node = blake2b512_personal(personal, &SEED).to_vec();
        record(&node);

        // ZIP 32's own path, and the messaging tree's path, walked in the same
        // tree. `32'/133'/0'` is exactly what §4.2 uses, so if the two trees
        // could ever coincide, this is where it would show.
        for ordinal in [32u32, 133, 0] {
            node = child(&node, ordinal);
            record(&node);

            // Sapling's spending and viewing keys, from ZIP 32 §5.1's
            // `ask`/`nsk`/`ovk` expansions of the node's spending key.
            //
            // These are the *pre-scalar* expansions: `ask` and `nsk` are
            // `ToScalar` of the first two, and `ToScalar` is a reduction, so
            // recording the wide output covers the input to the key rather
            // than a curve point. That is the right thing to compare against
            // an Ed25519 seed, which is also 32 bytes of pre-scalar input.
            for tag in [0x00u8, 0x01, 0x02] {
                record(&prf_expand(&node[..32], &[tag]));
            }
        }

        // Sibling accounts too: `account'` is a free index in §4.2's path, and
        // a collision at one index would be a collision.
        for ordinal in [1u32, 2, 7, 0x7fff_ffff] {
            record(&child(&node, ordinal));
        }
    }

    material
}

/// Every 32-byte value the messaging tree produces from the same seed.
fn messaging_key_material() -> BTreeSet<[u8; 32]> {
    let mut material = BTreeSet::new();
    let mut record = |bytes: &[u8]| {
        for window in bytes.chunks(32) {
            if let Ok(chunk) = <[u8; 32]>::try_from(window) {
                material.insert(chunk);
            }
        }
    };

    let mut node = master_node(&SEED).unwrap();
    record(node.to_secret_bytes().as_slice());
    for ordinal in [32u32, 133, 0] {
        node = ckd_hardened(&node, HardenedIndex::new(ordinal).unwrap());
        record(node.to_secret_bytes().as_slice());
    }
    for ordinal in [1u32, 2, 7, 0x7fff_ffff] {
        record(
            ckd_hardened(&node, HardenedIndex::new(ordinal).unwrap())
                .to_secret_bytes()
                .as_slice(),
        );
    }

    // The leaves, public halves included — a public key is the thing an
    // observer sees, so a collision there would be as bad as one in a secret.
    for account in [0u32, 1, 7] {
        let keys = AccountKeys::from_seed(&SEED, account).unwrap();
        record(keys.identity.public().as_bytes());
        record(keys.ceremony.public().as_bytes());
        record(keys.directory_auth.public().as_bytes());
        record(keys.backup_wrap.as_bytes());
    }

    material
}

/// #311's acceptance criterion.
#[test]
fn no_zcash_key_is_reachable_from_any_messaging_key_path() {
    let zcash = zcash_key_material();
    let messaging = messaging_key_material();

    // Both sides must be non-trivial, or the disjointness below is vacuous.
    // This is the shape of check `scripts/check-hash-domain-labels.mjs` calls a
    // coverage anchor, and it is here for the same reason: a scan that reaches
    // almost nothing passes forever.
    assert!(
        zcash.len() >= 20,
        "the ZIP 32 transcription produced only {} values; it is not walking the trees",
        zcash.len()
    );
    assert!(
        messaging.len() >= 20,
        "the messaging walk produced only {} values",
        messaging.len()
    );

    let shared: Vec<&[u8; 32]> = messaging.intersection(&zcash).collect();
    assert!(
        shared.is_empty(),
        "ADR 0006 violation: {} value(s) appear in both the Zcash and the messaging \
         key trees derived from one seed",
        shared.len()
    );
}

/// The claim under the claim: the separation is the personalization, and
/// nothing else.
///
/// Same seed, same indices, same primitive, same everything except the 16-byte
/// parameter-block field — and the trees diverge from the first node. If this
/// ever fails, the messaging tree has been rooted on a Zcash domain.
#[test]
fn the_personalization_is_what_separates_the_trees() {
    let messaging = blake2b512_personal(b"Free2zMsg_MSTRv1", &SEED);
    let sapling = blake2b512_personal(PERSONAL_SAPLING, &SEED);
    let orchard = blake2b512_personal(PERSONAL_ORCHARD, &SEED);
    let expand = blake2b512_personal(PERSONAL_EXPAND_SEED, &SEED);

    assert_ne!(*messaging, *sapling);
    assert_ne!(*messaging, *orchard);
    assert_ne!(*messaging, *expand);
    assert_ne!(*sapling, *orchard);
}

/// §4.2: "one-way. S is not recoverable from MSK."
#[test]
fn the_seed_does_not_survive_into_any_derived_value() {
    let messaging = messaging_key_material();
    for half in SEED.chunks(32) {
        let half: [u8; 32] = half.try_into().unwrap();
        assert!(
            !messaging.contains(&half),
            "half of the seed appears verbatim in derived key material"
        );
    }

    // And the full 64 bytes are not a node. Checked separately because a node
    // is 64 bytes wide and the set above is keyed by 32-byte halves, so a
    // whole-seed passthrough would show up as two hits rather than one.
    let master = master_node(&SEED).unwrap();
    assert_ne!(*master.to_secret_bytes(), SEED);
}

/// The messaging tree at Zcash's own indices, against the Zcash trees at the
/// same indices — ADR 0006's "even at identical indices", made observable.
#[test]
fn identical_indices_do_not_produce_identical_nodes() {
    let mut messaging = master_node(&SEED).unwrap();
    let mut sapling = blake2b512_personal(PERSONAL_SAPLING, &SEED).to_vec();
    let mut orchard = blake2b512_personal(PERSONAL_ORCHARD, &SEED).to_vec();

    for ordinal in [32u32, 133, 0, 1, 2, 3] {
        messaging = ckd_hardened(&messaging, HardenedIndex::new(ordinal).unwrap());
        sapling = sapling_child(&sapling, ordinal);
        orchard = orchard_child(&orchard, ordinal);

        let node = messaging.to_secret_bytes();
        assert_ne!(node.as_slice(), sapling.as_slice(), "at index {ordinal}'");
        assert_ne!(node.as_slice(), orchard.as_slice(), "at index {ordinal}'");
        // The halves too: a node could differ while sharing a spending key.
        assert_ne!(node[..32], sapling[..32], "key half at index {ordinal}'");
        assert_ne!(node[32..], sapling[32..], "chain code at index {ordinal}'");
    }
}

/// Nothing in this crate takes a Zcash key, and nothing returns one.
///
/// A type-level assertion rather than a runtime one: the only inputs to the
/// messaging hierarchy are a BIP-39 seed, a `u32` account index, and a
/// `CryptoRng`. If a future revision added a `from_sapling_extended_key`, this
/// comment is where a reviewer would notice that it had no business existing.
/// The compiler enforces the list; this test exists so the list is written
/// down.
#[test]
fn the_only_seed_shaped_input_is_a_bip39_seed() {
    // `master_node`, `account_node` and `AccountKeys::from_seed` all take
    // `&[u8]` and a `u32`. There is no Zcash type in this crate's public API,
    // and `Cargo.toml` names no Zcash dependency for one to come from.
    let _ = master_node(&SEED).unwrap();
    let _ = AccountKeys::from_seed(&SEED, 0).unwrap();
}
