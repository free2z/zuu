//! `H(label, x)` — the one hash the protocol uses, and the labels that
//! separate its domains.
//!
//! `WIRE.md` §1.3: `H(label, x)` is `BLAKE2b-256(label || x)` where `label` is
//! the exact ASCII bytes shown, **with no separator and no terminator**.
//!
//! No separator means the labels themselves have to be non-ambiguous, and they
//! are: every label below is a full path under `free2z/relay/v1/` and no label
//! is a prefix of another with a message that could complete it. That is a
//! property of *a set*, not of the construction, so a new label must be checked
//! against the same rule before it is added.
//!
//! **The set that matters is the union, not this array.** `WIRE.md` §1.3 now
//! states prefix-freeness as a normative requirement over every label in every
//! document that uses `H`, and `scripts/check-hash-domain-labels.mjs` enforces
//! it across the whole repository — the specifications under `docs/e2ee/` as
//! well as these constants. [`LABELS`] and the test below cover this crate's
//! own six, which is worth keeping and is not sufficient on its own: `KT.md`'s
//! labels were internally prefix-free too, and collided anyway
//! ([#602](https://github.com/free2z/zuu/issues/602)).

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};

use crate::types::Digest;

/// The transcript label. `WIRE.md` §5.1: `opaque label<0..255>` is exactly
/// these bytes. It is a *field* of the transcript, not a hash prefix.
pub const LABEL_COMMAND: &[u8] = b"free2z/relay/v1/cmd";

/// `body_hash = H("free2z/relay/v1/body", body)` (`WIRE.md` §5.1), computed
/// over the **re-encoded** body bytes of §3.3.
pub const LABEL_BODY: &[u8] = b"free2z/relay/v1/body";

/// `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`
/// (`WIRE.md` §5.2).
pub const LABEL_RELAY_ID: &[u8] = b"free2z/relay/v1/relay-id";

/// `capabilities_digest = H("free2z/relay/v1/caps", tls_codec(Capabilities))`
/// (`WIRE.md` §6.1).
pub const LABEL_CAPS: &[u8] = b"free2z/relay/v1/caps";

/// The first-field label of `HelloProofTranscript` (`WIRE.md` §5.2).
///
/// This one is a signing-transcript label, not an argument to `H`.
pub const LABEL_HELLO: &[u8] = b"free2z/relay/v1/hello";

/// The proof-of-work label. `WIRE.md` §13.1: a stamp is valid iff
/// `H("free2z/relay/v1/pow", challenge || salt || counter)` has at least
/// `difficulty_bits` leading zero bits.
pub const LABEL_POW: &[u8] = b"free2z/relay/v1/pow";

/// Every label this crate defines, so a test can assert the set stays
/// prefix-free (see the module note on `H`'s missing separator).
pub const LABELS: [&[u8]; 6] = [
    LABEL_COMMAND,
    LABEL_BODY,
    LABEL_RELAY_ID,
    LABEL_CAPS,
    LABEL_HELLO,
    LABEL_POW,
];

type Blake2b256 = Blake2b<U32>;

/// `H(label, x)` — `BLAKE2b-256(label || x)`, `WIRE.md` §1.3.
#[must_use]
pub fn hash(label: &[u8], data: &[u8]) -> Digest {
    let mut hasher = Blake2b256::new();
    hasher.update(label);
    hasher.update(data);
    Digest::new(hasher.finalize().into())
}

/// `H(label, a || b)`, for the two-part inputs of §5.2 and §13.1.
#[must_use]
pub fn hash2(label: &[u8], first: &[u8], second: &[u8]) -> Digest {
    let mut hasher = Blake2b256::new();
    hasher.update(label);
    hasher.update(first);
    hasher.update(second);
    Digest::new(hasher.finalize().into())
}

/// `body_hash` for a command body, over the re-encoded bytes (`WIRE.md` §5.1).
#[must_use]
pub fn body_hash(reencoded_body: &[u8]) -> Digest {
    hash(LABEL_BODY, reencoded_body)
}

/// `relay_id` from a relay's long-term Ed25519 public key (`WIRE.md` §5.2).
///
/// The client recomputes this from `relay_identity_pk` in `HelloResponse` and
/// compares it against the value it learned from an in-band queue advert. A
/// mismatch is fatal: the relay was substituted at the DNS or TLS layer.
#[must_use]
pub fn relay_id(relay_identity_pk: &crate::types::PublicKey) -> crate::types::RelayId {
    let digest = hash(LABEL_RELAY_ID, relay_identity_pk.as_bytes());
    crate::types::RelayId::new(*digest.as_bytes())
}

/// `capabilities_digest` over the canonical encoding of a `Capabilities`
/// structure (`WIRE.md` §6.1, §11.2).
#[must_use]
pub fn capabilities_digest(encoded_capabilities: &[u8]) -> Digest {
    hash(LABEL_CAPS, encoded_capabilities)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PublicKey;

    #[test]
    fn labels_are_prefix_free() {
        // `H` concatenates label and message with no separator, so a label that
        // is a prefix of another label is a cross-domain collision waiting for
        // an attacker-chosen message. Assert the property rather than trusting
        // that whoever adds the next label remembers it.
        //
        // Scope, stated because it is the part that was wrong before #602: this
        // ranges over this crate's `LABELS` and nothing else. The union with
        // `KT.md`'s and `ARCHITECTURE.md`'s labels — which is where the property
        // actually has to hold — is asserted by
        // `scripts/check-hash-domain-labels.mjs`, from a CI job that runs on
        // every pull request including the docs-only ones this test never sees.
        for (i, a) in LABELS.iter().enumerate() {
            for (j, b) in LABELS.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "label {:?} is a prefix of {:?}",
                    core::str::from_utf8(a),
                    core::str::from_utf8(b)
                );
            }
        }
    }

    #[test]
    fn domain_separation_actually_separates() {
        let message = b"the same message";
        assert_ne!(hash(LABEL_BODY, message), hash(LABEL_POW, message));
    }

    #[test]
    fn hash2_equals_hashing_the_concatenation() {
        let joined = [&b"aa"[..], &b"bb"[..]].concat();
        assert_eq!(hash2(LABEL_POW, b"aa", b"bb"), hash(LABEL_POW, &joined));
    }

    #[test]
    fn relay_id_is_the_digest_of_the_identity_key() {
        let key = PublicKey::new([3u8; 32]);
        assert_eq!(
            relay_id(&key).as_bytes(),
            hash(LABEL_RELAY_ID, key.as_bytes()).as_bytes()
        );
    }
}
