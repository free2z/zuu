//! The messaging tree — `ARCHITECTURE.md` §4.2's `MSK`, `CKDh` and
//! `account_node`.
//!
//! ```text
//! S                     = BIP-39 seed
//! MSK  = (msk, cc_msk)  = BLAKE2b-512(personal = "Free2zMsg_MSTRv1", S)
//! CKDh(node, i)         = BLAKE2b-512(personal = "Free2zMsg_CKDv1_",
//!                                     cc_node || 0x11 || ik_node || I2LEOSP32(i))
//! account_node          = CKDh(CKDh(CKDh(MSK, 32'), 133'), account')
//! ```
//!
//! Hardened only. There is no non-hardened variant and no extended public key
//! at any level, which is why [`ExtendedNode`] has no `public()` and why
//! nothing in this module returns a chain code to a caller.
//!
//! # Two things a reader of §4.2 should notice
//!
//! **1. `CKDh` hashes *both* halves of the parent — and it did not always.**
//! The revision of §4.2 that #694 implemented had a preimage of
//! `cc_node || 0x11 || I2LEOSP32(i)`, with `ik_node` absent. `ARCHITECTURE.md`
//! §4.2 now carries a dated correction restoring it, and this module implements
//! the corrected form.
//!
//! The corrected preimage is **ZIP 32 §5.2's Sapling hardened derivation with
//! the personalization changed and nothing else**:
//!
//! ```text
//! ZIP 32:  I = PRF^expand(c_par, [0x11] || sk_par || I2LEOSP_32(i))
//!            = BLAKE2b-512("Zcash_ExpandSeed", c_par || 0x11 || sk_par || I2LEOSP_32(i))
//! here:    I = BLAKE2b-512("Free2zMsg_CKDv1_", cc_node || 0x11 || ik_node || I2LEOSP32(i))
//! ```
//!
//! That was the point of the idiom — §4.2 chose it "because ZUULI already
//! implements that shape and auditors already know it" — so the fix is to
//! restore the dropped term rather than to invent a third construction. All
//! four fields are fixed-width (32, 1, 32, 4 = 69 bytes), so the concatenation
//! is unambiguous without a separator.
//!
//! What the omission would have cost, kept here because the *reason* a
//! derivation looks the way it does is the part that stops someone
//! "simplifying" it back: with `ik_node` out of the preimage, the key half of
//! every node above the account level was dead weight, all secret entropy below
//! `MSK` reached `ik_account` through `cc_msk` **alone** — a two-part secret
//! collapsed into a one-part secret — and a bare chain code derived its entire
//! subtree, so any later construct treating a chain code as the
//! less-sensitive half of a node would have been catastrophically wrong.
//! `ckd_reads_both_halves_of_the_parent` asserts the corrected behaviour from
//! both directions.
//!
//! **2. `I2LEOSP32(i)` encodes the hardened index, not the ordinal.** §4.2
//! writes `32'`, `133'`, `account'` in ZIP 32's notation and says the tree is
//! "hardened only". ZIP 32 serializes a hardened child index as the full
//! `i + 2^31`, so `32'` is `0x8000_0020` and encodes little-endian as
//! `20 00 00 80`. That is what [`HardenedIndex`] does, and it is the choice the
//! committed test vectors pin. The alternative reading — encode the bare
//! ordinal and let "hardened only" be a property of the construction rather
//! than of the bytes — is self-consistent and produces a different tree, which
//! is precisely why the ambiguity had to be closed *before* anyone has an
//! identity to lose.

use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::blake::{DIGEST_LEN, blake2b512_personal};
use crate::error::IdentityError;
use crate::labels::{PERSONAL_CKD, PERSONAL_MASTER};

/// The `purpose'` level of §4.2's path: ZIP 32's idiom, `32'`.
pub const PURPOSE: u32 = 32;

/// The `coin_type'` level of §4.2's path: SLIP-44 Zcash, `133'`.
///
/// The **coin type only**. It selects a branch of a tree that shares no hash
/// function with any Zcash key tree, and reusing SLIP-44's registry number is
/// how the path stays legible to a wallet author. Nothing about it makes a
/// Zcash key reachable from here; `tests/zcash_separation.rs` is what proves
/// that, and it proves it about the derivation rather than about the number.
pub const COIN_TYPE: u32 = 133;

/// The default `account'` index, for the single account §4.2 assumes today.
pub const DEFAULT_ACCOUNT: u32 = 0;

/// The bit ZIP 32 sets on a hardened child index.
const HARDENED_BIT: u32 = 0x8000_0000;

/// The `0x11` separator byte §4.2 places between the chain code and the index.
///
/// ZIP 32 uses `0x11` for a hardened Sapling child and this tree keeps the
/// spelling. It is not doing domain-separation work here — the personalization
/// already does that, and there is no sibling derivation with a different tag
/// for it to separate from — but the byte is in the specification, it is in the
/// hash preimage, and removing it would change every key.
const HARDENED_TAG: u8 = 0x11;

/// A hardened child index, held as the **ordinal**.
///
/// `HardenedIndex::new(32)` is §4.2's `32'`. The `0x8000_0000` bit is set by
/// [`HardenedIndex::to_le_bytes`] and never by a caller, so there is exactly
/// one spelling of a path in this crate. Passing an ordinal that already has
/// the bit set is [`IdentityError::IndexOutOfRange`] rather than a silent
/// double-hardening.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct HardenedIndex(u32);

impl HardenedIndex {
    /// Wrap an ordinal below `2^31`.
    ///
    /// # Errors
    ///
    /// [`IdentityError::IndexOutOfRange`] if the hardening bit is already set.
    pub const fn new(ordinal: u32) -> Result<Self, IdentityError> {
        if ordinal >= HARDENED_BIT {
            return Err(IdentityError::IndexOutOfRange);
        }
        Ok(Self(ordinal))
    }

    /// The ordinal, as written in §4.2's path (`32` for `32'`).
    #[must_use]
    pub const fn ordinal(self) -> u32 {
        self.0
    }

    /// `I2LEOSP32(i)` for the *hardened* index — the ordinal with
    /// `0x8000_0000` set, little-endian.
    ///
    /// See the module note: this is the reading of §4.2 that the committed
    /// vectors pin.
    #[must_use]
    pub const fn to_le_bytes(self) -> [u8; 4] {
        (self.0 | HARDENED_BIT).to_le_bytes()
    }
}

/// One node of the messaging tree: `(key, chain_code)`, the two halves of a
/// BLAKE2b-512 output.
///
/// # `Debug` is hand-written, and the reason is not hex
///
/// `f2z-codec` states the trap and it applies with more force here than
/// anywhere: a derived `Debug` over `[u8; 32]` prints a **decimal** list, which
/// contains no hex at all, so a redaction test that greps for hex passes while
/// the whole key hierarchy is in the log. This type is the root of that
/// hierarchy. `tests/redaction.rs` checks the decimal spelling.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct ExtendedNode {
    key: [u8; 32],
    chain_code: [u8; 32],
}

impl core::fmt::Debug for ExtendedNode {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ExtendedNode(<redacted>)")
    }
}

impl ExtendedNode {
    /// Split a BLAKE2b-512 output into `(I_L, I_R) = (key, chain code)`.
    fn from_digest(digest: &Zeroizing<[u8; DIGEST_LEN]>) -> Self {
        let (left, right) = digest.split_at(32);
        let mut node = Self {
            key: [0u8; 32],
            chain_code: [0u8; 32],
        };
        // Both halves are exactly 32 bytes by construction of `split_at(32)`
        // on a `[u8; 64]`, so neither `copy_from_slice` can panic.
        node.key.copy_from_slice(left);
        node.chain_code.copy_from_slice(right);
        node
    }

    /// The node's key half — `ik_node`. `ik_account` is what §4.2 expands the
    /// four leaves out of.
    ///
    /// `pub(crate)`: a caller has no use for raw key material, and every use
    /// this crate has for it is one of the four labelled expansions.
    pub(crate) const fn key(&self) -> &[u8; 32] {
        &self.key
    }

    /// The node's chain code — `cc_node`, the only half `CKDh` consumes.
    fn chain_code(&self) -> &[u8; 32] {
        &self.chain_code
    }

    /// The node's 64 secret bytes, `key || chain_code`, in a wrapper that
    /// clears them.
    ///
    /// **This is the whole subtree.** Anyone holding these bytes can derive
    /// every descendant of this node, which for an `account_node` means the
    /// entire messaging identity. It is exported for two reasons and no others:
    /// a wallet may want to persist an account node instead of the seed, and
    /// the committed vectors in `tests/derivation_vectors.rs` have to be able
    /// to pin the node itself — pinning only the leaves would let a wrong
    /// `I2LEOSP32` encoding hide behind HKDF, and the node is exactly where a
    /// derivation defect lives.
    ///
    /// Note what it is *not*: §4.2 has no extended **public** key at any level,
    /// and this is not one. There is no way to hand a third party something
    /// that derives public keys without also handing them the secrets.
    #[must_use]
    pub fn to_secret_bytes(&self) -> Zeroizing<[u8; DIGEST_LEN]> {
        let mut bytes = Zeroizing::new([0u8; DIGEST_LEN]);
        let (left, right) = bytes.split_at_mut(32);
        left.copy_from_slice(&self.key);
        right.copy_from_slice(&self.chain_code);
        bytes
    }
}

/// `MSK = BLAKE2b-512(personal = "Free2zMsg_MSTRv1", S)` (§4.2).
///
/// One-way: `S` is not recoverable from `MSK`, and this crate exposes no path
/// back — [`ExtendedNode`] does not store the seed, does not borrow it, and
/// zeroizes both halves on drop.
///
/// # Errors
///
/// [`IdentityError::SeedLength`] if the seed is outside BIP-39's 16..=64 bytes.
/// BIP-39 itself always produces 64; the range exists so that a caller holding
/// a shorter non-standard seed gets a verdict instead of an identity.
pub fn master_node(seed: &[u8]) -> Result<ExtendedNode, IdentityError> {
    if seed.len() < 16 || seed.len() > 64 {
        return Err(IdentityError::SeedLength);
    }
    Ok(ExtendedNode::from_digest(&blake2b512_personal(
        PERSONAL_MASTER,
        seed,
    )))
}

/// The width of a `CKDh` preimage: `cc_node ‖ 0x11 ‖ ik_node ‖ I2LEOSP32(i)`.
///
/// `32 + 1 + 32 + 4`. Every field is fixed-width, which is what makes the
/// concatenation unambiguous without a separator — and it is why this is a
/// `const` with the arithmetic written out rather than a magic number.
const CKD_PREIMAGE_LEN: usize = 32 + 1 + 32 + 4;

/// `CKDh(node, i) = BLAKE2b-512(personal = "Free2zMsg_CKDv1_", cc_node || 0x11
/// || ik_node || I2LEOSP32(i))` (§4.2, as corrected 2026-08-25).
///
/// **Both halves of the parent are in the preimage.** See the module note: an
/// earlier revision of §4.2 omitted `ik_node`, which is not ZIP 32's shape and
/// left the whole subtree derivable from a chain code alone. This is ZIP 32
/// §5.2's Sapling hardened derivation with the personalization changed.
///
/// Hardened only. There is no `CKDn`, and there will not be one: a non-hardened
/// variant would require an extended public key at some level, and §4.2 has
/// none at any level on purpose.
#[must_use]
pub fn ckd_hardened(node: &ExtendedNode, index: HardenedIndex) -> ExtendedNode {
    // A fixed-size buffer rather than a `Vec`: it is secret material — it now
    // carries the parent's key as well as its chain code — and it is zeroized
    // on the way out.
    let mut preimage = Zeroizing::new([0u8; CKD_PREIMAGE_LEN]);
    let (chain, rest) = preimage.split_at_mut(32);
    chain.copy_from_slice(node.chain_code());
    let (tag, rest) = rest.split_at_mut(1);
    // `rest` is exactly 37 bytes here, so every split below is the width
    // written in `CKD_PREIMAGE_LEN`.
    if let Some(slot) = tag.first_mut() {
        *slot = HARDENED_TAG;
    }
    let (key, index_bytes) = rest.split_at_mut(32);
    key.copy_from_slice(node.key());
    index_bytes.copy_from_slice(&index.to_le_bytes());

    ExtendedNode::from_digest(&blake2b512_personal(PERSONAL_CKD, preimage.as_slice()))
}

/// `account_node = CKDh(CKDh(CKDh(MSK, 32'), 133'), account')` (§4.2).
///
/// The node whose key half is `ik_account`, from which
/// [`crate::account::AccountKeys`] expands the four leaves.
///
/// # Errors
///
/// [`IdentityError::SeedLength`] as [`master_node`], or
/// [`IdentityError::IndexOutOfRange`] if `account` has the hardening bit set.
pub fn account_node(seed: &[u8], account: u32) -> Result<ExtendedNode, IdentityError> {
    let purpose = HardenedIndex::new(PURPOSE)?;
    let coin = HardenedIndex::new(COIN_TYPE)?;
    let account = HardenedIndex::new(account)?;

    let master = master_node(seed)?;
    let purpose_node = ckd_hardened(&master, purpose);
    let coin_node = ckd_hardened(&purpose_node, coin);
    Ok(ckd_hardened(&coin_node, account))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    const SEED: [u8; 64] = [0x2a; 64];

    #[test]
    fn a_hardened_index_encodes_the_hardening_bit() {
        // §4.2's `32'` is 0x80000020, little-endian `20 00 00 80`. This is the
        // ambiguity call the module note names; if it is ever revisited, this
        // is the assertion that has to change and every user's identity with
        // it.
        assert_eq!(
            HardenedIndex::new(32).unwrap().to_le_bytes(),
            [0x20, 0x00, 0x00, 0x80]
        );
        assert_eq!(
            HardenedIndex::new(133).unwrap().to_le_bytes(),
            [0x85, 0x00, 0x00, 0x80]
        );
        assert_eq!(
            HardenedIndex::new(0).unwrap().to_le_bytes(),
            [0x00, 0x00, 0x00, 0x80]
        );
    }

    #[test]
    fn an_already_hardened_ordinal_is_refused() {
        assert_eq!(
            HardenedIndex::new(0x8000_0020),
            Err(IdentityError::IndexOutOfRange)
        );
        assert_eq!(
            HardenedIndex::new(u32::MAX),
            Err(IdentityError::IndexOutOfRange)
        );
        assert!(HardenedIndex::new(0x7fff_ffff).is_ok());
    }

    #[test]
    fn the_seed_length_range_is_enforced_at_both_ends() {
        assert_eq!(
            master_node(&[0u8; 15]).err(),
            Some(IdentityError::SeedLength)
        );
        assert!(master_node(&[0u8; 16]).is_ok());
        assert!(master_node(&[0u8; 64]).is_ok());
        assert_eq!(
            master_node(&[0u8; 65]).err(),
            Some(IdentityError::SeedLength)
        );
        assert_eq!(master_node(&[]).err(), Some(IdentityError::SeedLength));
    }

    #[test]
    fn sibling_indices_derive_different_nodes() {
        let master = master_node(&SEED).unwrap();
        let a = ckd_hardened(&master, HardenedIndex::new(0).unwrap());
        let b = ckd_hardened(&master, HardenedIndex::new(1).unwrap());
        assert_ne!(a.key(), b.key());
        assert_ne!(a.chain_code(), b.chain_code());
    }

    #[test]
    fn a_one_bit_seed_change_changes_the_account_node() {
        let mut other = SEED;
        other[63] ^= 0x01;
        let a = account_node(&SEED, 0).unwrap();
        let b = account_node(&other, 0).unwrap();
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn accounts_are_separate_subtrees() {
        let a = account_node(&SEED, 0).unwrap();
        let b = account_node(&SEED, 1).unwrap();
        assert_ne!(a.key(), b.key());
        assert_ne!(a.chain_code(), b.chain_code());
    }

    /// **The regression test for §4.2's 2026-08-25 correction.**
    ///
    /// Both halves of the parent must reach the child. The defect this replaces
    /// was the exact inverse assertion — that flipping a bit of the parent's
    /// *key* left the children unchanged — which was true, was what §4.2 then
    /// said, and meant a bare chain code derived the whole subtree.
    ///
    /// Asserted from both directions, because either one alone would pass for a
    /// `CKDh` that read the wrong single field.
    #[test]
    fn ckd_reads_both_halves_of_the_parent() {
        let master = master_node(&SEED).unwrap();
        let index = HardenedIndex::new(7).unwrap();
        let child = ckd_hardened(&master, index);

        // One bit of the parent's key half.
        let mut key_twin = master.clone();
        key_twin.key[0] ^= 0x01;
        assert_ne!(
            ckd_hardened(&key_twin, index).key(),
            child.key(),
            "CKDh is ignoring the parent key — this is the #694 defect returning, \
             and it means a chain code alone derives the whole subtree"
        );

        // One bit of the parent's chain code.
        let mut chain_twin = master.clone();
        chain_twin.chain_code[0] ^= 0x01;
        assert_ne!(
            ckd_hardened(&chain_twin, index).key(),
            child.key(),
            "CKDh is ignoring the parent chain code"
        );
    }

    /// The preimage is the four fixed-width fields §4.2 names, in order.
    ///
    /// Built here a second time, by hand, and compared against the shipped
    /// derivation. A field-order or width mistake inside `ckd_hardened` would
    /// otherwise be invisible to every other test in this file — they would all
    /// still see a deterministic, well-separated tree.
    #[test]
    fn the_ckd_preimage_is_chain_code_tag_key_index() {
        let master = master_node(&SEED).unwrap();
        let index = HardenedIndex::new(133).unwrap();

        let mut expected = alloc::vec::Vec::with_capacity(CKD_PREIMAGE_LEN);
        expected.extend_from_slice(master.chain_code());
        expected.push(0x11);
        expected.extend_from_slice(master.key());
        expected.extend_from_slice(&index.to_le_bytes());
        assert_eq!(expected.len(), CKD_PREIMAGE_LEN);

        let by_hand = ExtendedNode::from_digest(&blake2b512_personal(PERSONAL_CKD, &expected));
        assert_eq!(ckd_hardened(&master, index).key(), by_hand.key());
        assert_eq!(
            ckd_hardened(&master, index).chain_code(),
            by_hand.chain_code()
        );
    }

    #[test]
    fn the_node_debug_leaks_neither_hex_nor_decimal() {
        let node = master_node(&SEED).unwrap();
        let rendered = format!("{node:?}");
        assert_eq!(rendered, "ExtendedNode(<redacted>)");
        // The `f2z-codec` trap, restated as an assertion: a derived `Debug`
        // over `[u8; 32]` prints decimal, so checking for hex proves nothing.
        for byte in node.key().iter().chain(node.chain_code().iter()) {
            assert!(
                !rendered.contains(&alloc::format!("{byte}")),
                "decimal leak"
            );
        }
    }

    #[test]
    fn zeroizing_a_node_clears_both_halves() {
        let mut node = master_node(&SEED).unwrap();
        assert!(node.key().iter().any(|byte| *byte != 0));
        node.zeroize();
        assert_eq!(node.key(), &[0u8; 32]);
        assert_eq!(node.chain_code(), &[0u8; 32]);
    }
}
