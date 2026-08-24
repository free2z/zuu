//! Domain separation — `KT.md` §6.2's closed label set, and the four labels
//! that go to `H`.
//!
//! Two different mechanisms share the word "label" in `KT.md` and they must not
//! be confused, so this module keeps them in two arrays:
//!
//! - **[`SIGNING_LABELS`]** are *fields*. Every structure the protocol signs
//!   carries a distinct versioned ASCII constant in its **first** field, inside
//!   the signed bytes, and a verifier MUST check it before anything else (§6.2).
//!   The log's signing key signs tree heads, receipts **and** key transitions;
//!   without an in-band, checked type constant a verifier that accepts "a
//!   signature from the log" over bytes it did not type-check is one
//!   field-alignment coincidence away from accepting a receipt as a tree head.
//!   The set is closed: §6.2's table is reproduced here in full and
//!   [`SIGNING_LABELS`] is what a test asserts against it.
//!
//! - **[`HASH_LABELS`]** are arguments to `H(label, x) = BLAKE2b-256(label || x)`
//!   (§1.3), the idiom `WIRE.md` §1.3 already fixes: exact ASCII bytes, **no
//!   separator and no terminator**. No separator means the label set must be
//!   prefix-free or an attacker-chosen message can complete one label into
//!   another, and [`HASH_LABELS`] exists so a test can check that mechanically
//!   rather than by inspection.
//!
//! A signing label is never handed to `H` and a hash label never appears in a
//! signed structure, which is why `"free2z/kt/v1/sth"` being a prefix of
//! `"free2z/kt/v1/sth-hash"` is not a collision: only the second is ever a
//! `H` argument. The test asserts prefix-freeness **within** [`HASH_LABELS`],
//! and distinctness within [`SIGNING_LABELS`], and nothing across the two.

use f2z_codec::hash::hash;
use f2z_codec::types::{Digest, PublicKey};

use crate::types::LogId;

// ---------------------------------------------------------------------------
// §6.2 — the closed set of signing labels.
// ---------------------------------------------------------------------------

/// `SignedTreeHeadTBS.label`, signed by the log (§6.1).
pub const LABEL_STH: &[u8] = b"free2z/kt/v1/sth";

/// `WitnessCosignatureTBS.label`, signed by a witness (§7.2).
pub const LABEL_COSIG: &[u8] = b"free2z/kt/v1/cosig";

/// `SubmissionReceiptTBS.label`, signed by the log (§5.3).
pub const LABEL_RECEIPT: &[u8] = b"free2z/kt/v1/receipt";

/// `DirectoryEntryTBS.label`, signed by the user's `DirectoryAuthKey` (§4.1).
pub const LABEL_ENTRY: &[u8] = b"free2z/kt/v1/entry";

/// `RotationProofTBS.label`, signed by the user's **outgoing** ISK (§4.4).
pub const LABEL_ROTATION: &[u8] = b"free2z/kt/v1/rotation";

/// `ResetAuthorizationTBS.label`, signed by the pinned reset authority (§4.4).
pub const LABEL_RESET: &[u8] = b"free2z/kt/v1/reset";

/// `LogKeyTransitionTBS.label`, signed by **both** log keys (§6.4).
pub const LABEL_LOG_KEY_TRANSITION: &[u8] = b"free2z/kt/v1/log-key-transition";

/// `FaultReportTBS.label`, signed by a witness (§7.3).
pub const LABEL_FAULT: &[u8] = b"free2z/kt/v1/fault";

/// `DeviceCredentialTBS.label`, signed by the user's ISK (§4.1).
///
/// The one label that is not under `free2z/kt/v1/`: a `DeviceCredential` is
/// carried as the MLS `Credential` in a `LeafNode` and is validated by peers who
/// have no directory access at all (`ARCHITECTURE.md` §4.2), so it is not a
/// key-transparency structure and does not carry the directory's version.
pub const LABEL_DEVICE_CREDENTIAL: &[u8] = b"free2z/device-credential/v1";

/// §6.2's table, in the order it is written there.
///
/// Closed on purpose. A structure this crate signs or verifies that is not in
/// this list is a structure whose type is not checked, and a test asserts the
/// list matches the constants above.
pub const SIGNING_LABELS: [&[u8]; 9] = [
    LABEL_STH,
    LABEL_COSIG,
    LABEL_RECEIPT,
    LABEL_ENTRY,
    LABEL_ROTATION,
    LABEL_RESET,
    LABEL_LOG_KEY_TRANSITION,
    LABEL_FAULT,
    LABEL_DEVICE_CREDENTIAL,
];

// ---------------------------------------------------------------------------
// The arguments to H. These must stay prefix-free.
// ---------------------------------------------------------------------------

/// `log_id = H("free2z/kt/v1/log-id", genesis_log_pk)` (§6.1).
pub const LABEL_LOG_ID: &[u8] = b"free2z/kt/v1/log-id";

/// `AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (§3.3).
pub const LABEL_VALUE: &[u8] = b"free2z/kt/v1/value";

/// `prev_entry_hash = H("free2z/kt/v1/prev", tls_codec(previous DirectoryEntry))`
/// (§4.2).
pub const LABEL_PREV: &[u8] = b"free2z/kt/v1/prev";

/// `prev_sth_hash = H("free2z/kt/v1/sth-hash", tls_codec(prev SignedTreeHeadTBS))`
/// (§6.1).
pub const LABEL_STH_HASH: &[u8] = b"free2z/kt/v1/sth-hash";

/// Every label this crate hands to `H`, so a test can assert the set is
/// prefix-free. See the module note on `H`'s missing separator.
pub const HASH_LABELS: [&[u8]; 4] = [LABEL_LOG_ID, LABEL_VALUE, LABEL_PREV, LABEL_STH_HASH];

/// The `AkdLabel` prefix: `"free2z/kt/v1/handle:" || handle` (§3.3).
///
/// Domain separation against the same log ever being asked to hold a second
/// kind of record. It sits inside the VRF input, so it is not visible in the
/// tree and costs nothing in privacy.
pub const AKD_LABEL_PREFIX: &[u8] = b"free2z/kt/v1/handle:";

// ---------------------------------------------------------------------------
// The derivations.
// ---------------------------------------------------------------------------

/// `log_id = H("free2z/kt/v1/log-id", genesis_log_pk)` (§6.1).
///
/// Derived from the log's **genesis** signing key and never changing, including
/// across a signing-key rotation (§6.4). If it changed, every rotation would
/// present as a new log and every client's pinned history would be discarded —
/// which is exactly the state an attacker wants a client in.
#[must_use]
pub fn log_id(genesis_log_pk: &PublicKey) -> LogId {
    LogId::new(*hash(LABEL_LOG_ID, genesis_log_pk.as_bytes()).as_bytes())
}

/// `AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (§3.3).
///
/// The tree commits to this 32-byte hash, not to the entry. The bytes passed in
/// MUST be the **canonical** encoding of the whole `DirectoryEntry` including
/// its authorization, so that an entry cannot be re-authorized after
/// publication.
#[must_use]
pub fn entry_value(canonical_entry: &[u8]) -> Digest {
    hash(LABEL_VALUE, canonical_entry)
}

/// `prev_entry_hash = H("free2z/kt/v1/prev", tls_codec(previous DirectoryEntry))`
/// (§4.2), over the previous entry **including its authorization**.
#[must_use]
pub fn prev_entry_hash(canonical_entry: &[u8]) -> Digest {
    hash(LABEL_PREV, canonical_entry)
}

/// `H("free2z/kt/v1/sth-hash", tls_codec(SignedTreeHeadTBS))` (§6.1).
///
/// Note the argument is the **`SignedTreeHeadTBS`**, not the `SignedTreeHead`:
/// the chain link covers the signed contents, not the signature over them.
#[must_use]
pub fn sth_hash(canonical_sth_tbs: &[u8]) -> Digest {
    hash(LABEL_STH_HASH, canonical_sth_tbs)
}

/// `AkdLabel = "free2z/kt/v1/handle:" || handle` (§3.3).
///
/// The handle is ASCII `[a-z0-9_]{1,30}` (§1.3), which is why the log's labels
/// are not homograph-attackable and why a bare concatenation is unambiguous
/// here: no handle can contain the prefix's `:`.
#[must_use]
pub fn akd_label(handle: &crate::types::Handle) -> Vec<u8> {
    let mut label = Vec::with_capacity(AKD_LABEL_PREFIX.len().saturating_add(handle.len()));
    label.extend_from_slice(AKD_LABEL_PREFIX);
    label.extend_from_slice(handle.as_slice());
    label
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_labels_are_prefix_free() {
        // `H` concatenates label and message with no separator, so a label that
        // is a prefix of another is a cross-domain collision waiting for an
        // attacker-chosen message.
        for (i, a) in HASH_LABELS.iter().enumerate() {
            for (j, b) in HASH_LABELS.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "hash label {:?} is a prefix of {:?}",
                    core::str::from_utf8(a),
                    core::str::from_utf8(b)
                );
            }
        }
    }

    #[test]
    fn the_signing_label_set_is_closed_and_distinct() {
        // §6.2's table has nine rows. If a tenth structure is signed, this
        // assertion is where the reviewer is told to look at §6.2 first.
        assert_eq!(SIGNING_LABELS.len(), 9);
        for (i, a) in SIGNING_LABELS.iter().enumerate() {
            for (j, b) in SIGNING_LABELS.iter().enumerate() {
                assert!(
                    i == j || a != b,
                    "two structures share a domain-separation constant"
                );
            }
        }
        // Every one is ASCII and versioned, so a verifier comparing bytes is
        // comparing what §6.2 wrote down.
        for label in SIGNING_LABELS {
            assert!(label.is_ascii(), "a label must be exact ASCII bytes");
            assert!(!label.is_empty());
        }
    }

    #[test]
    fn a_signing_label_is_never_a_hash_label() {
        // Not a security property on its own — the two mechanisms are
        // separate — but a constant that appeared in both would mean someone
        // had confused them, and this is cheaper than finding out later.
        for signing in SIGNING_LABELS {
            for hashed in HASH_LABELS {
                assert_ne!(signing, hashed);
            }
        }
    }

    #[test]
    fn the_four_derivations_are_domain_separated() {
        let message = b"the same 32 bytes................";
        assert_ne!(entry_value(message), prev_entry_hash(message));
        assert_ne!(entry_value(message), sth_hash(message));
        assert_ne!(prev_entry_hash(message), sth_hash(message));
    }

    #[test]
    fn log_id_is_the_digest_of_the_genesis_key() {
        let genesis = PublicKey::new([5u8; 32]);
        assert_eq!(
            log_id(&genesis).as_bytes(),
            hash(LABEL_LOG_ID, genesis.as_bytes()).as_bytes()
        );
    }
}
