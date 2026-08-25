//! Domain separation — `ARCHITECTURE.md` §4.2's two personalizations and four
//! leaf labels.
//!
//! # Changing anything in this file changes every user's identity
//!
//! Say it once, loudly, because it is the property that makes this the least
//! editable file in the workspace. Every constant below is an input to a
//! one-way derivation from the user's BIP-39 seed. Altering one byte of one of
//! them moves that user's `IdentitySigningKey` to a different key, which means
//! their handle's directory entry no longer verifies, their peers' pinned
//! safety numbers no longer match, and — because `KT.md` §4.2's directory is
//! append-only and §4.4 requires the **outgoing** identity key to sign a
//! rotation — they cannot even rotate to the new key without still holding the
//! old one. There is no migration. These are the values that ship.
//!
//! # Two mechanisms, two arrays, and they are not the same kind of thing
//!
//! - **[`PERSONALIZATIONS`]** are BLAKE2's 16-byte parameter-block field. They
//!   are not concatenated with the message, so prefix-freeness is not the
//!   property that matters for them; **exact length is**. BLAKE2 zero-pads a
//!   short personalization into the same 16 bytes, so `"Free2zMsg"` and
//!   `"Free2zMsg\0…"` name one domain. The type is `[u8; 16]` and a test
//!   asserts the set is distinct.
//!
//! - **[`LEAF_LABELS`]** are HKDF-Expand `info` strings. HKDF-Expand appends a
//!   one-byte counter after `info` in every block, so it is not the
//!   separator-free concatenation that `WIRE.md` §1.3's `H(label, x)` is — but
//!   the labels are held to prefix-freeness anyway, for the reason
//!   `f2z-codec`'s `hash.rs` states: the set of constructions a label is reused
//!   in only ever grows, and a check that holds a subset of the namespace is
//!   how [zuu#602] happened. `scripts/check-hash-domain-labels.mjs` holds the
//!   union of these against every other `free2z/` label in the tree, including
//!   the ones minted in `ARCHITECTURE.md` and `KT.md` that no crate reads.
//!
//! [zuu#602]: https://github.com/free2z/zuu/issues/602

use crate::blake::PERSONAL_LEN;

// ---------------------------------------------------------------------------
// §4.2 — the two BLAKE2b personalizations.
// ---------------------------------------------------------------------------

/// `MSK = BLAKE2b-512(personal = "Free2zMsg_MSTRv1", S)` (§4.2).
///
/// The root of the messaging tree, and the reason ADR 0006's "cannot collide
/// with the Sapling or Orchard key trees even at identical indices" is a fact
/// about the construction rather than a hope: ZIP 32's trees are rooted at
/// `"ZcashIP32Sapling"` and `"ZcashIP32Orchard"`, and a BLAKE2b personalization
/// is a parameter-block field, so two trees under different personalizations
/// are two different hash functions all the way down.
pub const PERSONAL_MASTER: &[u8; PERSONAL_LEN] = b"Free2zMsg_MSTRv1";

/// `CKDh(node, i) = BLAKE2b-512(personal = "Free2zMsg_CKDv1_", cc_node || 0x11
/// || I2LEOSP32(i))` (§4.2).
///
/// The trailing underscore is not decoration: BLAKE2 pads to 16 bytes with
/// zeros, so a 15-byte `"Free2zMsg_CKDv1"` would be the personalization
/// `"Free2zMsg_CKDv1\0"`, and the version suffix would stop being able to grow
/// without ambiguity. §4.2 writes the underscore, and it is load-bearing.
pub const PERSONAL_CKD: &[u8; PERSONAL_LEN] = b"Free2zMsg_CKDv1_";

/// Every personalization this crate uses, so a test can assert the set.
pub const PERSONALIZATIONS: [&[u8; PERSONAL_LEN]; 2] = [PERSONAL_MASTER, PERSONAL_CKD];

// ---------------------------------------------------------------------------
// §4.2 — the four HKDF-Expand leaf labels.
// ---------------------------------------------------------------------------

/// `IdentitySigningKey` (ISK). Ed25519, long-term.
///
/// Signs `DeviceCredential`s and — per `KT.md` §4.4's narrowing of §4.2 —
/// `RotationProof`s. **Never signs message content**, and never signs a
/// directory entry envelope: that is [`LABEL_DIRECTORY_AUTH`]'s key, so a
/// routine update never touches the key peers pin as a safety number.
pub const LABEL_IDENTITY_SIG: &[u8] = b"free2z/msg/v1/identity-sig";

/// `CeremonySigningKey` (CSK). Ed25519, long-term.
///
/// Signs **only** FROST/DKG payloads (`ARCHITECTURE.md` §11), which are
/// deliberately attributable. §4.1: "Non-repudiation and deniable-style
/// authentication never share a key." This one is the non-repudiable half, and
/// it exists as a separate leaf so that the blast radius of a ceremony
/// signature is a ceremony.
pub const LABEL_CEREMONY_SIG: &[u8] = b"free2z/msg/v1/ceremony-sig";

/// `DirectoryAuthKey`. Ed25519, long-term.
///
/// Authenticates directory updates and self-audit queries (`KT.md` §4.4, §8.2).
pub const LABEL_DIRECTORY_AUTH: &[u8] = b"free2z/msg/v1/directory-auth";

/// `BackupWrapKey`. 32 raw bytes, long-term.
///
/// Wraps local encrypted history so it survives a reinstall on the same seed.
/// Not a signing key and deliberately not typed as one.
pub const LABEL_BACKUP_WRAP: &[u8] = b"free2z/msg/v1/backup-wrap";

/// §4.2's leaf table, in the order it is written there.
///
/// Closed on purpose, exactly as `f2z-kt-core`'s `SIGNING_LABELS` is: a fifth
/// key expanded out of `ik_account` under a label that is not in this list is a
/// key whose domain nobody checked.
pub const LEAF_LABELS: [&[u8]; 4] = [
    LABEL_IDENTITY_SIG,
    LABEL_CEREMONY_SIG,
    LABEL_DIRECTORY_AUTH,
    LABEL_BACKUP_WRAP,
];

#[cfg(test)]
mod tests {
    use super::*;

    /// ZIP 32's personalizations, and `zcash_primitives`' expand-seed PRF.
    ///
    /// Restated here as *forbidden* values, not as an implementation. See
    /// `tests/zcash_separation.rs` for the derivation-level assertion; this one
    /// is the cheap constant-level half, and it is the one that fires first if
    /// somebody ever "simplifies" the messaging tree onto a Zcash domain.
    const ZCASH_PERSONALIZATIONS: [&[u8; PERSONAL_LEN]; 3] = [
        b"ZcashIP32Sapling",
        b"ZcashIP32Orchard",
        b"Zcash_ExpandSeed",
    ];

    #[test]
    fn every_personalization_is_exactly_sixteen_bytes() {
        // Guaranteed by the type. Asserted anyway, because the *reason* it is a
        // `[u8; 16]` is that BLAKE2 pads a shorter one into the same domain,
        // and a reader who changes the type should meet this line.
        for personal in PERSONALIZATIONS {
            assert_eq!(personal.len(), PERSONAL_LEN);
            assert!(personal.is_ascii());
        }
    }

    #[test]
    fn the_personalizations_are_distinct_and_none_is_a_zcash_domain() {
        assert_ne!(PERSONAL_MASTER, PERSONAL_CKD);
        for personal in PERSONALIZATIONS {
            for zcash in ZCASH_PERSONALIZATIONS {
                assert_ne!(
                    personal, zcash,
                    "ADR 0006: the messaging tree must be rooted in its own personalization"
                );
            }
        }
    }

    #[test]
    fn the_leaf_labels_are_prefix_free_and_distinct() {
        // HKDF-Expand frames `info` with a counter, so this is defence in
        // depth rather than the load-bearing property — see the module note.
        assert_eq!(LEAF_LABELS.len(), 4);
        for (i, a) in LEAF_LABELS.iter().enumerate() {
            for (j, b) in LEAF_LABELS.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert_ne!(a, b, "two leaves share a label");
                assert!(
                    !b.starts_with(a),
                    "leaf label {:?} is a prefix of {:?}",
                    core::str::from_utf8(a),
                    core::str::from_utf8(b)
                );
            }
        }
        for label in LEAF_LABELS {
            assert!(label.is_ascii(), "a label must be exact ASCII bytes");
            assert!(label.starts_with(b"free2z/msg/v1/"), "unversioned label");
        }
    }
}
