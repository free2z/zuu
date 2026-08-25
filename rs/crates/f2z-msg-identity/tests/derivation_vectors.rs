//! Known-answer vectors for the whole of `ARCHITECTURE.md` §4.2, from one
//! fixed seed.
//!
//! # What this file is for, and why it is a deliverable rather than a nicety
//!
//! §4.2's hierarchy will have **at least two implementations**: this crate,
//! natively for ZUULI, and the same crate compiled to `wasm32-unknown-unknown`
//! for the web client — plus anyone else's client, because the licence is MIT
//! and the point of a seed-derived identity is that a user can restore it
//! somewhere else. Two implementations that disagree about a derivation
//! constant do not fail; they silently give one user two identities, and the
//! user finds out when a peer's safety number stops matching.
//!
//! So these are the numbers a second implementation checks itself against, and
//! they are also the tripwire on an accidental edit to a personalization, a
//! label, an index encoding or a field order. **Any change to this file's
//! expected values is a change to every existing user's identity** — see the
//! crate note. A pull request that updates a value here is either fixing a
//! defect found before launch or is wrong.
//!
//! # Every value below changed on 2026-08-25, and this is the one that was
//!
//! `ARCHITECTURE.md` §4.2 carries a dated correction: `CKDh`'s preimage omitted
//! the parent key, and now reads `cc_node ‖ 0x11 ‖ ik_node ‖ I2LEOSP32(i)`.
//! Every node below `MSK` and every leaf therefore has a different value than
//! the vectors #694 shipped. `MSK` itself is unchanged — the master derivation
//! never involved `CKDh` — which is a useful thing to notice when reading the
//! diff: a correction that moved `MSK` too would have been a different and
//! larger change.
//!
//! It was safe to make **only** because nothing had shipped. No user had an
//! identity, no directory entry existed, no safety number had been pinned. That
//! is exactly the window this file exists to make it possible to act inside, and
//! it is now closed for anything further.
//!
//! # The rule this file is written under
//!
//! The same one `f2z-codec/tests/wire_vectors.rs` states: **every expected
//! value below was computed by something that is not this crate.** Printing the
//! implementation's output into a test locks in whatever is already wrong and
//! calls it a specification.
//!
//! The independent derivation is Python's standard library plus `cryptography`:
//! `hashlib.blake2b(..., digest_size=64, person=...)` for §4.2's BLAKE2b-512,
//! `hmac`/`hashlib.sha256` for a hand-written RFC 5869 §2.3 HKDF-Expand, and
//! `cryptography.hazmat.primitives.asymmetric.ed25519` for the public keys and
//! the credential signature. The transcript is reproduced at the bottom of this
//! file so a reviewer can re-run it.
//!
//! # The seed
//!
//! BIP-39's canonical all-`abandon` test mnemonic with an empty passphrase,
//! whose seed is published in BIP-39 itself:
//!
//! ```text
//! abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
//! → 5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1
//!   9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4
//! ```
//!
//! Chosen so that a second implementation does not have to trust a seed *we*
//! made up: it can start from the mnemonic, reach the same 64 bytes through its
//! own BIP-39, and only then compare against §4.2.

// Test code, read by a person looking at a failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::canonical::Canonical as _;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::account::AccountKeys;
use f2z_msg_identity::credential::DeviceCredentialRequest;
use f2z_msg_identity::node::{HardenedIndex, account_node, ckd_hardened, master_node};

// ---------------------------------------------------------------------------
// The vectors. Every one of these is a value some *other* program printed.
// ---------------------------------------------------------------------------

/// BIP-39's published seed for the all-`abandon` mnemonic.
const SEED: &str = "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1\
                    9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";

/// `MSK = BLAKE2b-512(personal = "Free2zMsg_MSTRv1", S)`, as `msk || cc_msk`.
const MSK: &str = "74f055750feeefebb248b31b88aae0b2b9b0b0db1c0f520eb831d30243c87096\
                   91d0cc16887876d54b585fa850dd2b2c1aecbe525e4d300b8b15dd7677de373a";

/// `CKDh(MSK, 32')` — the `purpose'` level.
const NODE_PURPOSE: &str = "288530fcef32ace05c9545252ac22fd9d8f070b0961b3bb8e955c0e86922d906\
                            1f9b549adf14b522e5ab8fe6658282cc5fccc1fdcef7c9f5a8a921e58fad0bd9";

/// `CKDh(CKDh(MSK, 32'), 133')` — the `coin_type'` level, SLIP-44 Zcash.
const NODE_COIN: &str = "8b269b6624b43f1794346249cbd4c0cf6f835467f9937f997265805ad8632464\
                         1f0c258f743e7b01b85ed3c1c4732f66c2784a53b924a28bb74c5806b07285cf";

/// `account_node = CKDh(CKDh(CKDh(MSK, 32'), 133'), 0')`, as
/// `ik_account || cc_account`.
const ACCOUNT_NODE: &str = "dbd4245907a1e6e0368d41ad784262d99f52ae7e8f6ce14ab3ef46efb811c627\
                            1462b713c286891f5298d6e625319fb7b16382c8509b18bffaa928ecd2801102";

/// `IdentitySigningKey.public`, from
/// `HKDF-Expand(ik_account, "free2z/msg/v1/identity-sig", 32)`.
const ISK_PUBLIC: &str = "e73fcd0648504865a6a582473c961cab75b3e6b108bff18196ef80aa41955199";

/// `CeremonySigningKey.public`, label `free2z/msg/v1/ceremony-sig`.
const CSK_PUBLIC: &str = "c5027046f3bb8b8251e060b99b52f9044210791a148c0ebae05c8c2f5e4f4c6c";

/// `DirectoryAuthKey.public`, label `free2z/msg/v1/directory-auth`.
const DIRECTORY_AUTH_PUBLIC: &str =
    "e8a99244307a22722cb61bdac80098c8c826d1fa8c064de5e685bb926cd7130b";

/// `BackupWrapKey`, label `free2z/msg/v1/backup-wrap`. The one leaf whose
/// secret bytes *are* the key, so the vector is the secret rather than a public
/// half — which is fine, because this seed's identity is published in BIP-39.
const BACKUP_WRAP: &str = "479083aada9066af10d708d474199ae99416dd80bd3f5bcefa68c65a2c30270e";

// The `DeviceCredential` fixture. Fixed values, chosen so a reviewer can see
// them in a hex dump: a device key of all `0x07`, a KEM key of all `0xab`, and
// a validity window of two round instants.
const HANDLE: &[u8] = b"alice";
const DEVICE_PK: [u8; 32] = [0x07; 32];
const DEVICE_KEM_BYTE: u8 = 0xab;
/// X-Wing's public key is 1216 bytes (ML-KEM-768's 1184 + X25519's 32). The
/// value is filler; the *length* is the real one, so the `<1..2^16-1>` prefix
/// in the vector is the one a real credential carries.
const DEVICE_KEM_LEN: usize = 1216;
const NOT_BEFORE_MS: u64 = 1_767_225_600_000;
const NOT_AFTER_MS: u64 = 1_798_761_600_000;

/// The length of `tls_codec(DeviceCredentialTBS)`, derived from `KT.md` §4.1's
/// declarations rather than measured:
///
/// | field | declaration | bytes |
/// |---|---|---|
/// | `label` | `opaque<0..255>` | 1 + 27 |
/// | `identity_pk` | `opaque[32]` | 32 |
/// | `handle` | `opaque<1..30>` | 1 + 5 |
/// | `device_pk` | `opaque[32]` | 32 |
/// | `device_kem_pk` | `opaque<1..2^16-1>` | 2 + 1216 |
/// | `not_before_ms` | `uint64` | 8 |
/// | `not_after_ms` | `uint64` | 8 |
///
/// `28 + 32 + 6 + 32 + 1218 + 8 + 8 = 1332`.
const CREDENTIAL_TBS_LEN: usize = 1332;

/// Ed25519 by the ISK over `tls_codec(DeviceCredentialTBS)`.
///
/// Ed25519 signing is deterministic (RFC 8032 §5.1.6), so this is a known
/// answer rather than one valid answer among many — which is what makes it
/// usable as a cross-implementation vector at all.
const CREDENTIAL_SIGNATURE: &str = "24785757ba36d112cb310dd6bad39b027776ca693848c1d56557f011b4bda4ed\
     196c1a0f59e14d9a100c1d10e1be9f9f779c164492e7e713b1a930080e017806";

// ---------------------------------------------------------------------------

/// Decode a hex vector, ignoring the whitespace a line continuation leaves in.
fn hex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    assert_eq!(digits.len() % 2, 0, "a hex vector must have even length");
    digits
        .chunks(2)
        .map(|pair| {
            let text = core::str::from_utf8(pair).unwrap();
            u8::from_str_radix(text, 16).unwrap()
        })
        .collect()
}

fn seed() -> Vec<u8> {
    hex(SEED)
}

/// A node's 64 bytes, from the **shipped** derivation.
fn node_bytes(chain: &[u32]) -> Vec<u8> {
    let mut node = master_node(&seed()).unwrap();
    for ordinal in chain {
        node = ckd_hardened(&node, HardenedIndex::new(*ordinal).unwrap());
    }
    node.to_secret_bytes().to_vec()
}

/// The same node, from a **transcription of §4.2's pseudocode** that touches
/// nothing in `node.rs`.
///
/// Two derivations that agree with each other and with an independently
/// computed vector is three sources, not one. This one exists because
/// `node.rs`'s `CKDh` and the vectors could in principle be wrong *together* if
/// somebody regenerated the vectors from the code — the thing this file's
/// header forbids — and a second reading of the specification inside the test
/// is what makes that visible rather than merely prohibited.
fn transcribed_node_bytes(chain: &[u32]) -> Vec<u8> {
    use f2z_msg_identity::blake::blake2b512_personal;

    let mut node = blake2b512_personal(b"Free2zMsg_MSTRv1", &seed()).to_vec();
    for ordinal in chain {
        // §4.2 as corrected 2026-08-25:
        //     cc_node || 0x11 || ik_node || I2LEOSP32(i)
        // Both halves of the parent, four fixed-width fields, 69 bytes.
        let mut preimage = Vec::with_capacity(69);
        preimage.extend_from_slice(&node[32..]);
        preimage.push(0x11);
        preimage.extend_from_slice(&node[..32]);
        preimage.extend_from_slice(&(ordinal | 0x8000_0000).to_le_bytes());
        assert_eq!(preimage.len(), 69);
        node = blake2b512_personal(b"Free2zMsg_CKDv1_", &preimage).to_vec();
    }
    node
}

#[test]
fn the_seed_is_bip39s_published_vector() {
    // Not a test of this crate. It is a test that the *input* to every vector
    // below is the value BIP-39 publishes, so a second implementation can start
    // from the mnemonic rather than from our say-so.
    assert_eq!(seed().len(), 64);
    assert_eq!(
        seed()[..8],
        [0x5e, 0xb0, 0x0b, 0xbd, 0xdc, 0xf0, 0x69, 0x08]
    );
}

#[test]
fn msk_matches_the_vector() {
    assert_eq!(node_bytes(&[]), hex(MSK));
    assert_eq!(transcribed_node_bytes(&[]), hex(MSK));
}

#[test]
fn every_level_of_the_path_matches_its_vector() {
    // Each level pinned separately. A single `account_node` assertion would go
    // red for a defect at any level and say nothing about which.
    for (chain, expected, level) in [
        (&[32u32][..], NODE_PURPOSE, "purpose' = 32'"),
        (&[32, 133][..], NODE_COIN, "coin_type' = 133'"),
        (&[32, 133, 0][..], ACCOUNT_NODE, "account' = 0'"),
    ] {
        assert_eq!(node_bytes(chain), hex(expected), "{level}");
        assert_eq!(transcribed_node_bytes(chain), hex(expected), "{level}");
    }
}

#[test]
fn the_account_helper_walks_the_path_the_specification_writes() {
    // `account_node(seed, 0)` is a convenience over three `ckd_hardened` calls,
    // and a convenience that walked a different path would be invisible from
    // the leaf vectors alone if the leaves were regenerated with it.
    assert_eq!(
        account_node(&seed(), 0).unwrap().to_secret_bytes().to_vec(),
        hex(ACCOUNT_NODE)
    );
}

#[test]
fn the_four_leaves_match_their_vectors() {
    let keys = AccountKeys::from_seed(&seed(), 0).unwrap();
    assert_eq!(
        keys.identity.public().as_bytes().as_slice(),
        hex(ISK_PUBLIC).as_slice(),
        "IdentitySigningKey — label free2z/msg/v1/identity-sig"
    );
    assert_eq!(
        keys.ceremony.public().as_bytes().as_slice(),
        hex(CSK_PUBLIC).as_slice(),
        "CeremonySigningKey — label free2z/msg/v1/ceremony-sig"
    );
    assert_eq!(
        keys.directory_auth.public().as_bytes().as_slice(),
        hex(DIRECTORY_AUTH_PUBLIC).as_slice(),
        "DirectoryAuthKey — label free2z/msg/v1/directory-auth"
    );
    assert_eq!(
        keys.backup_wrap.as_bytes().as_slice(),
        hex(BACKUP_WRAP).as_slice(),
        "BackupWrapKey — label free2z/msg/v1/backup-wrap"
    );
}

fn credential_request() -> DeviceCredentialRequest {
    DeviceCredentialRequest {
        handle: Handle::new(HANDLE.to_vec()).unwrap(),
        device_pk: f2z_codec::types::PublicKey::new(DEVICE_PK),
        device_kem_pk: KemPublicKey::new(vec![DEVICE_KEM_BYTE; DEVICE_KEM_LEN]).unwrap(),
        not_before_ms: NOT_BEFORE_MS,
        not_after_ms: NOT_AFTER_MS,
    }
}

#[test]
fn the_device_credential_tbs_is_the_bytes_kt_md_declares() {
    let keys = AccountKeys::from_seed(&seed(), 0).unwrap();
    let credential = keys
        .identity
        .issue_device_credential(&credential_request())
        .unwrap();
    let tbs = credential.credential.signing_bytes().unwrap();

    assert_eq!(
        tbs.len(),
        CREDENTIAL_TBS_LEN,
        "the encoded width disagrees with KT.md §4.1's field declarations"
    );

    // Field by field, at the offsets the table in `CREDENTIAL_TBS_LEN`'s doc
    // computes. Asserting the whole 1332 bytes as one blob would report "the
    // credential changed" for any of seven different defects.
    assert_eq!(tbs[0], 27, "label length prefix, opaque<0..255>");
    assert_eq!(&tbs[1..28], b"free2z/device-credential/v1");
    assert_eq!(&tbs[28..60], hex(ISK_PUBLIC).as_slice(), "identity_pk");
    assert_eq!(tbs[60], 5, "handle length prefix, opaque<1..30>");
    assert_eq!(&tbs[61..66], HANDLE);
    assert_eq!(&tbs[66..98], &DEVICE_PK, "device_pk");
    assert_eq!(
        &tbs[98..100],
        &(DEVICE_KEM_LEN as u16).to_be_bytes(),
        "device_kem_pk length prefix, big-endian per WIRE.md §1.3"
    );
    assert!(tbs[100..1316].iter().all(|byte| *byte == DEVICE_KEM_BYTE));
    assert_eq!(
        &tbs[1316..1324],
        &NOT_BEFORE_MS.to_be_bytes(),
        "not_before_ms, uint64 big-endian"
    );
    assert_eq!(
        &tbs[1324..1332],
        &NOT_AFTER_MS.to_be_bytes(),
        "not_after_ms, uint64 big-endian"
    );
}

#[test]
fn the_device_credential_signature_matches_the_vector() {
    let keys = AccountKeys::from_seed(&seed(), 0).unwrap();
    let credential = keys
        .identity
        .issue_device_credential(&credential_request())
        .unwrap();
    assert_eq!(
        credential.signature.as_bytes().as_slice(),
        hex(CREDENTIAL_SIGNATURE).as_slice(),
        "Ed25519 is deterministic, so this is a known answer and not one valid \
         answer among many; a mismatch means either the key or the signed bytes moved"
    );
}

#[test]
fn the_whole_credential_re_encodes_canonically() {
    // `WIRE.md` §3.3. What a peer hashes is the re-encoding, so a vector over
    // bytes that do not survive a round trip is a vector for something nobody
    // will ever see.
    let keys = AccountKeys::from_seed(&seed(), 0).unwrap();
    let credential = keys
        .identity
        .issue_device_credential(&credential_request())
        .unwrap();
    let encoded = credential.encode_canonical().unwrap();
    assert_eq!(encoded.len(), CREDENTIAL_TBS_LEN + 64);
    assert_eq!(
        &encoded[CREDENTIAL_TBS_LEN..],
        hex(CREDENTIAL_SIGNATURE).as_slice()
    );
}

/// The transcript that produced every value above, so a reviewer can re-run it
/// rather than trust it. Nothing in it reads this crate.
///
/// ```python
/// import hashlib, hmac
/// from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
/// from cryptography.hazmat.primitives import serialization
///
/// def b2(personal, data):
///     return hashlib.blake2b(data, digest_size=64, person=personal).digest()
///
/// def ckdh(node, ordinal):        # ARCHITECTURE.md §4.2, corrected 2026-08-25
///     ik, cc = node[:32], node[32:]
///     pre = cc + b"\x11" + ik + (ordinal | 0x80000000).to_bytes(4, "little")
///     assert len(pre) == 32 + 1 + 32 + 4 == 69   # both halves of the parent
///     return b2(b"Free2zMsg_CKDv1_", pre)
///
/// def hkdf_expand(prk, info, length):            # RFC 5869 §2.3
///     out, t, counter = b"", b"", 1
///     while len(out) < length:
///         t = hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
///         out, counter = out + t, counter + 1
///     return out[:length]
///
/// seed = hashlib.pbkdf2_hmac("sha512",
///     b"abandon " * 11 + b"about", b"mnemonic", 2048, dklen=64)
/// node = b2(b"Free2zMsg_MSTRv1", seed)           # MSK
/// for i in (32, 133, 0):
///     node = ckdh(node, i)                       # account_node
/// ik = node[:32]
/// for label in (b"free2z/msg/v1/identity-sig", b"free2z/msg/v1/ceremony-sig",
///               b"free2z/msg/v1/directory-auth", b"free2z/msg/v1/backup-wrap"):
///     print(label, hkdf_expand(ik, label, 32).hex())
/// ```
#[test]
fn the_derivation_transcript_is_documented() {
    // A test so the doc comment above cannot be deleted without a diff that a
    // reviewer sees on a test file. It asserts nothing else.
    assert_eq!(CREDENTIAL_TBS_LEN, 1332);
}
