//! The four account leaves — `ARCHITECTURE.md` §4.2's second table.
//!
//! `HKDF-Expand(PRK = ik_account, info = label, L)`, one call per leaf, four
//! distinct labels. Only the Expand half of HKDF is used: §4.2 says
//! `HKDF-Expand`, and an Extract over `ik_account` would buy nothing, because
//! `ik_account` is already half of a BLAKE2b-512 output and therefore already
//! uniform. Restating that here because "we skipped Extract" is the kind of
//! deviation a reader is right to stop at.
//!
//! # The separation this module exists to make structural
//!
//! §4.1: "Non-repudiation and deniable-style authentication never share a key",
//! and "`IdentitySigningKey` … **never signs message content**." A comment
//! saying so is worth nothing, so no key type here exposes a general
//! `sign(&[u8])`:
//!
//! | Key | What it will sign | And nothing else |
//! |---|---|---|
//! | [`IdentitySigningKey`] | a `DeviceCredentialTBS`, a `RotationProofTBS` | `KT.md` §4.4's narrowing of §4.2 |
//! | [`CeremonySigningKey`] | a FROST/DKG ceremony transcript (§11) | deliberately attributable |
//! | [`DirectoryAuthKey`] | a `DirectoryEntryTBS` | the envelope, never the credential |
//! | [`BackupWrapKey`] | — | not a signing key at all |
//!
//! A caller that wants an `IdentitySigningKey` to sign arbitrary bytes has to
//! change this file, which is exactly the amount of friction §4.1 is asking
//! for. `KT.md` §4.4 explains the blast-radius reason the last two rows are
//! different keys: a routine update — adding a device, moving a contact
//! endpoint — then never touches the key peers pin and display as a safety
//! number.

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::canonical::encode;
use f2z_codec::types::{PublicKey, Signature};
use f2z_kt_core::entry::{DirectoryEntryTBS, RotationProof, RotationProofTBS};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::IdentityError;
use crate::labels::{
    LABEL_BACKUP_WRAP, LABEL_CEREMONY_SIG, LABEL_DIRECTORY_AUTH, LABEL_IDENTITY_SIG,
};
use crate::node::{ExtendedNode, account_node};

/// `HKDF-Expand(PRK = ik_account, info = label, L = 32)`.
///
/// `L` is 32 for every leaf §4.2 defines: an Ed25519 secret scalar seed is 32
/// bytes (RFC 8032 §5.1.5) and the `BackupWrapKey` is declared "32 B".
fn expand(ik_account: &[u8; 32], label: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut okm = Zeroizing::new([0u8; 32]);
    // Both failure modes are unreachable, and neither is a *runtime* condition
    // — each is decided by a length the type system already fixes.
    // `Hkdf::from_prk` refuses a PRK shorter than SHA-256's 32-byte output and
    // this argument is a `&[u8; 32]`; `expand` refuses an output longer than
    // 255 × 32 bytes and this one is 32.
    //
    // The `if let` swallows what cannot happen rather than panicking, because
    // `panic` and `expect_used` are denied workspace-wide and an abort inside a
    // client's key derivation is worse than any diagnosis it would buy. What it
    // would *leave* is an all-zero key, so that outcome is asserted against
    // directly in `no_leaf_is_all_zero` below — a silent zero key must be a red
    // test rather than a comment claiming it would be.
    if let Ok(hkdf) = Hkdf::<Sha256>::from_prk(ik_account) {
        let _ = hkdf.expand(label, okm.as_mut_slice());
    }
    okm
}

/// Declare a seed-derived Ed25519 leaf: a redacting `Debug`, zeroization on
/// drop through dalek's `SigningKey`, and no general signing method.
macro_rules! ed25519_leaf {
    ($(#[$meta:meta])* $name:ident, $label:expr) => {
        $(#[$meta])*
        ///
        /// # Zeroization
        ///
        /// The secret lives in an [`ed25519_dalek::SigningKey`], which is
        /// `ZeroizeOnDrop`. See the crate-level note for the WASM caveat, which
        /// is real and is not this type's to fix.
        pub struct $name(SigningKey);

        impl $name {
            /// The `info` label §4.2 expands this leaf under.
            pub const LABEL: &'static [u8] = $label;

            /// Expand this leaf from `ik_account`.
            fn derive(ik_account: &[u8; 32]) -> Self {
                Self(SigningKey::from_bytes(&expand(ik_account, Self::LABEL)))
            }

            /// The public key, as the directory and the wire carry it.
            #[must_use]
            pub fn public(&self) -> PublicKey {
                PublicKey::new(self.0.verifying_key().to_bytes())
            }
        }

        /// Hand-written, never derived. `SigningKey`'s own `Debug` is upstream's
        /// and is not ours to trust; more to the point, `f2z-codec`'s documented
        /// trap is that a derived `Debug` over bytes prints them in **decimal**,
        /// so a redaction test that greps for hex passes while the key leaks.
        /// `tests/redaction.rs` checks the decimal spelling of every byte.
        impl core::fmt::Debug for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }
    };
}

ed25519_leaf!(
    /// `IdentitySigningKey` (ISK) — §4.2's long-term identity key.
    ///
    /// Signs device credentials and identity rotations, and **never signs
    /// message content**. It is the key a peer pins and renders as a safety
    /// number, so every signature it makes is one that changes what a peer
    /// trusts.
    IdentitySigningKey,
    LABEL_IDENTITY_SIG
);

ed25519_leaf!(
    /// `CeremonySigningKey` (CSK) — §4.2, signs **only** FROST/DKG payloads.
    ///
    /// `ARCHITECTURE.md` §11 and #305 §3.3: ceremony payloads are deliberately
    /// attributable, and conversational authentication is a different key
    /// context. Note what §5.6 says and this type does not claim: the
    /// separation buys blast-radius isolation and clean semantics. **It does
    /// not buy deniability.**
    CeremonySigningKey,
    LABEL_CEREMONY_SIG
);

ed25519_leaf!(
    /// `DirectoryAuthKey` — §4.2, authenticates directory updates and
    /// self-audit queries.
    ///
    /// `KT.md` §4.4 is the operative reading: this key signs the
    /// `DirectoryEntryTBS` **envelope**, and the `IdentitySigningKey` signs the
    /// credentials inside it. §4.2's table overlaps on this point and §4.4
    /// narrows it; the narrowing is what this crate implements.
    DirectoryAuthKey,
    LABEL_DIRECTORY_AUTH
);

impl IdentitySigningKey {
    /// The underlying signing key, for [`crate::credential`].
    ///
    /// `pub(crate)`, on this one type only, and it stays that way. Handing it
    /// out publicly would hand out a general `sign(&[u8])` on the key a peer
    /// pins as an identity, which is exactly what the module note says no key
    /// type here has. The `CeremonySigningKey` and the `DirectoryAuthKey` have
    /// no equivalent, because nothing outside this module signs with them.
    pub(crate) const fn signing_key(&self) -> &SigningKey {
        &self.0
    }

    /// Sign a `RotationProofTBS` — `KT.md` §4.4's `key_change` authorization,
    /// by the **outgoing** identity key.
    ///
    /// The other thing an ISK signs is a `DeviceCredential`, and that lives in
    /// [`crate::credential`] because it has fields to build rather than only
    /// bytes to sign.
    ///
    /// # Errors
    ///
    /// [`IdentityError::MalformedCredential`] if the structure cannot be
    /// encoded — in practice a field longer than its length prefix admits.
    pub fn sign_rotation_proof(
        &self,
        proof: &RotationProofTBS,
    ) -> Result<RotationProof, IdentityError> {
        let bytes = encode(proof).map_err(|_| IdentityError::MalformedCredential)?;
        Ok(RotationProof {
            proof: proof.clone(),
            signature: Signature::new(self.0.sign(&bytes).to_bytes()),
        })
    }
}

impl CeremonySigningKey {
    /// Sign a FROST/DKG ceremony transcript (`ARCHITECTURE.md` §11).
    ///
    /// The transcript's framing is §11's, not this crate's, so the argument is
    /// the exact bytes the ceremony protocol defines. What this method is for
    /// is making the *key choice* unambiguous: a ceremony payload is signed
    /// here and nowhere else, and nothing else is signed here.
    #[must_use]
    pub fn sign_ceremony_payload(&self, transcript: &[u8]) -> Signature {
        Signature::new(self.0.sign(transcript).to_bytes())
    }
}

impl DirectoryAuthKey {
    /// `auth_signature` over `tls_codec(DirectoryEntryTBS)` — `KT.md` §4.4.
    ///
    /// # Errors
    ///
    /// [`IdentityError::MalformedCredential`] if the entry cannot be encoded.
    pub fn sign_directory_entry(
        &self,
        entry: &DirectoryEntryTBS,
    ) -> Result<Signature, IdentityError> {
        let bytes = encode(entry).map_err(|_| IdentityError::MalformedCredential)?;
        Ok(Signature::new(self.0.sign(&bytes).to_bytes()))
    }
}

/// `BackupWrapKey` — §4.2, 32 bytes, wraps local encrypted history.
///
/// Not a signing key, and given no signing method, so that "wrap the history
/// archive" and "assert an identity" cannot be confused at a call site. What
/// AEAD consumes it is the storage layer's decision and is deliberately not
/// made here.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct BackupWrapKey([u8; 32]);

impl BackupWrapKey {
    /// The `info` label §4.2 expands this leaf under.
    pub const LABEL: &'static [u8] = LABEL_BACKUP_WRAP;

    /// Borrow the key bytes.
    ///
    /// The one accessor in this crate that hands out raw secret bytes, because
    /// a symmetric key has no public half to hand out instead. The caller owns
    /// what happens to the copy it makes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Hand-written for the reason the module note gives: a derived `Debug` over
/// `[u8; 32]` prints a decimal byte list containing no hex.
impl core::fmt::Debug for BackupWrapKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("BackupWrapKey(<redacted>)")
    }
}

/// Everything §4.2 derives from one account node — the restorable half of a
/// messaging identity.
///
/// **Restorable, and only this.** §4.1: identity keys are seed-derived so that
/// restoring the wallet restores the identity; device keys are not, so that
/// seed compromise does not retroactively yield every device's MLS state.
/// [`crate::device::DeviceKeys`] is the other half, it comes from the OS
/// CSPRNG, and there is no function anywhere in this crate that produces one
/// from a seed.
pub struct AccountKeys {
    /// §4.2's `IdentitySigningKey`.
    pub identity: IdentitySigningKey,
    /// §4.2's `CeremonySigningKey`.
    pub ceremony: CeremonySigningKey,
    /// §4.2's `DirectoryAuthKey`.
    pub directory_auth: DirectoryAuthKey,
    /// §4.2's `BackupWrapKey`.
    pub backup_wrap: BackupWrapKey,
}

/// Hand-written so that a caller who logs the whole bundle logs nothing.
impl core::fmt::Debug for AccountKeys {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("AccountKeys(<redacted>)")
    }
}

impl AccountKeys {
    /// Derive all four leaves from a BIP-39 seed and an account index.
    ///
    /// This is the whole restorable identity: `S → MSK → account_node → the
    /// four leaves`, §4.2 end to end.
    ///
    /// # Errors
    ///
    /// [`IdentityError::SeedLength`] if the seed is outside 16..=64 bytes, or
    /// [`IdentityError::IndexOutOfRange`] if `account` already carries the
    /// hardening bit.
    pub fn from_seed(seed: &[u8], account: u32) -> Result<Self, IdentityError> {
        Ok(Self::from_account_node(&account_node(seed, account)?))
    }

    /// Derive the four leaves from an already-derived `account_node`.
    ///
    /// `pub(crate)`: the node is raw key material and the public entry point is
    /// [`AccountKeys::from_seed`]. Split out so the test vectors can pin the
    /// node and the leaves independently.
    pub(crate) fn from_account_node(node: &ExtendedNode) -> Self {
        let ik_account = node.key();
        Self {
            identity: IdentitySigningKey::derive(ik_account),
            ceremony: CeremonySigningKey::derive(ik_account),
            directory_auth: DirectoryAuthKey::derive(ik_account),
            backup_wrap: BackupWrapKey(*expand(ik_account, LABEL_BACKUP_WRAP)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    const SEED: [u8; 64] = [0x2a; 64];

    fn keys() -> AccountKeys {
        AccountKeys::from_seed(&SEED, 0).unwrap()
    }

    #[test]
    fn the_four_leaves_are_four_different_keys() {
        let keys = keys();
        let publics = [
            keys.identity.public(),
            keys.ceremony.public(),
            keys.directory_auth.public(),
        ];
        for (i, a) in publics.iter().enumerate() {
            for (j, b) in publics.iter().enumerate() {
                assert!(i == j || a != b, "two leaves expanded to the same key");
            }
            assert_ne!(
                a.as_bytes(),
                keys.backup_wrap.as_bytes(),
                "a signing key's public half collided with the backup key"
            );
        }
    }

    /// The failure mode [`expand`]'s `if let` leaves behind, asserted against.
    ///
    /// If `Hkdf::from_prk` or `expand` ever started failing — a dependency bump
    /// that changed a length rule, a refactor that passed a shorter PRK — every
    /// leaf would silently become 32 zero bytes and `SigningKey::from_bytes`
    /// would accept it. This is the test that turns that into a failure.
    #[test]
    fn no_leaf_is_all_zero() {
        let node = account_node(&SEED, 0).unwrap();
        for label in crate::labels::LEAF_LABELS {
            let leaf = expand(node.key(), label);
            assert_ne!(
                *leaf,
                [0u8; 32],
                "HKDF-Expand produced nothing for {:?}; see `expand`'s note",
                core::str::from_utf8(label)
            );
        }
    }

    #[test]
    fn derivation_is_deterministic() {
        assert_eq!(keys().identity.public(), keys().identity.public());
        assert_eq!(keys().backup_wrap.as_bytes(), keys().backup_wrap.as_bytes());
    }

    #[test]
    fn a_different_account_is_a_different_identity() {
        let zero = AccountKeys::from_seed(&SEED, 0).unwrap();
        let one = AccountKeys::from_seed(&SEED, 1).unwrap();
        assert_ne!(zero.identity.public(), one.identity.public());
    }

    #[test]
    fn every_key_debug_is_redacted_in_hex_and_in_decimal() {
        let keys = keys();
        for rendered in [
            format!("{:?}", keys.identity),
            format!("{:?}", keys.ceremony),
            format!("{:?}", keys.directory_auth),
            format!("{:?}", keys.backup_wrap),
            format!("{keys:?}"),
        ] {
            assert!(rendered.contains("<redacted>"), "{rendered}");
            for byte in keys.backup_wrap.as_bytes() {
                assert!(
                    !rendered.contains(&format!("{byte}")),
                    "decimal leak: {rendered}"
                );
            }
        }
    }

    #[test]
    fn the_backup_key_zeroizes() {
        let mut key = keys().backup_wrap;
        assert!(key.as_bytes().iter().any(|byte| *byte != 0));
        key.zeroize();
        assert_eq!(key.as_bytes(), &[0u8; 32]);
    }

    /// The labels are what separate the leaves, so swapping one has to change
    /// the key. A leaf derived under the wrong label would still be a valid
    /// Ed25519 key and every other test in this file would pass.
    #[test]
    fn the_label_is_what_separates_the_leaves() {
        let node = account_node(&SEED, 0).unwrap();
        let ik = node.key();
        let identity = expand(ik, LABEL_IDENTITY_SIG);
        let ceremony = expand(ik, LABEL_CEREMONY_SIG);
        let directory = expand(ik, LABEL_DIRECTORY_AUTH);
        let backup = expand(ik, LABEL_BACKUP_WRAP);
        assert_ne!(*identity, *ceremony);
        assert_ne!(*identity, *directory);
        assert_ne!(*identity, *backup);
        assert_ne!(*ceremony, *directory);
        assert_ne!(*ceremony, *backup);
        assert_ne!(*directory, *backup);
        // And none of them is the account key itself.
        assert_ne!(*identity, *ik);
    }
}
