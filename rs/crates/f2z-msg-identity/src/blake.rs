//! Personalized BLAKE2b-512 — the one primitive the messaging tree is built
//! from, and the reason it is not spelled the obvious way.
//!
//! `ARCHITECTURE.md` §4.2 is written in ZIP 32's idiom: **BLAKE2b-512 with a
//! 16-byte personalization, unkeyed**, output split as `(I_L, I_R) = (key,
//! chain code)`. That is exactly what [`blake2b512_personal`] computes, and the
//! whole security of §4.2's domain separation rests on the personalization
//! being applied as a *parameter-block* field rather than as data.
//!
//! # The trap: `Blake2bMac512` is the wrong API, and it is wrong quietly
//!
//! `blake2 0.10`'s obvious spelling for "BLAKE2b-512 with a personalization" is
//!
//! ```text
//! Blake2bMac512::new_with_salt_and_personal(&[], &[], PERSONAL)
//! ```
//!
//! and it does **not** compute unkeyed BLAKE2b. The constructor pads the key to
//! a full 128-byte block and seeds the buffer with it unconditionally
//! (`blake2-0.10.6/src/macros.rs`, `LazyBuffer::new(&padded_key)`), so an empty
//! key still prepends 128 zero bytes to the message. The parameter block is
//! correct — `key_size` is 0 — so the digest looks right, verifies against
//! nothing, and disagrees with every other BLAKE2b implementation on earth. A
//! key hierarchy built on it would be self-consistent and interoperable with no
//! one, which for `#311` is the failure mode that matters: the point of the
//! committed test vectors is that a *second* implementation can agree.
//!
//! So this module drives `Blake2bVarCore` directly, which is the same code path
//! `Blake2bVar::new` takes (`new_with_params(&[], &[], 0, output_size)`) with
//! the personalization filled in. The committed vectors in
//! `tests/derivation_vectors.rs` were computed with Python's `hashlib.blake2b`,
//! which is not this code, and they agree.

use blake2::Blake2bVarCore;
use blake2::digest::core_api::{Buffer, UpdateCore, VariableOutputCore};
use zeroize::Zeroizing;

/// The width of a BLAKE2b-512 digest, and therefore of one node of the
/// messaging tree: 32 bytes of key followed by 32 bytes of chain code.
pub const DIGEST_LEN: usize = 64;

/// The exact width of a BLAKE2 personalization field.
///
/// Not a maximum. BLAKE2's parameter block reserves 16 bytes for it and pads a
/// shorter value with zeros, so `"Free2zMsg"` and `"Free2zMsg\0\0\0\0\0\0\0"`
/// are the *same* domain. `ARCHITECTURE.md` §4.2's two personalizations are
/// both exactly 16 bytes; [`labels::PERSONALIZATIONS`] asserts it so that a
/// future one cannot be short and collide with its own padding.
///
/// [`labels::PERSONALIZATIONS`]: crate::labels::PERSONALIZATIONS
pub const PERSONAL_LEN: usize = 16;

/// `BLAKE2b-512(personal = P, data)`, unkeyed, in ZIP 32's idiom.
///
/// The result is returned in a [`Zeroizing`] wrapper because every call site in
/// this crate is producing secret key material. See the crate-level note on
/// what zeroization does and does not promise under WASM.
///
/// # Panics
///
/// Never. `personal` is a `[u8; 16]`, which is exactly the width BLAKE2b's
/// parameter block reserves, so the length assertions inside
/// `Blake2bVarCore::new_with_params` cannot fire; the type is what makes that
/// true, and it is why this function takes an array rather than a slice.
#[must_use]
pub fn blake2b512_personal(personal: &[u8; PERSONAL_LEN], data: &[u8]) -> Zeroizing<[u8; 64]> {
    // `key_size = 0` is the unkeyed parameter block; `output_size = 64` is
    // BLAKE2b-512. No salt: §4.2 uses the personalization field only.
    let mut core = Blake2bVarCore::new_with_params(&[], personal, 0, DIGEST_LEN);
    let mut buffer = Buffer::<Blake2bVarCore>::default();
    buffer.digest_blocks(data, |blocks| core.update_blocks(blocks));

    let mut out = blake2::digest::Output::<Blake2bVarCore>::default();
    core.finalize_variable_core(&mut buffer, &mut out);

    let mut digest = Zeroizing::new([0u8; DIGEST_LEN]);
    digest.copy_from_slice(&out);

    // `out` is a plain `GenericArray` on this crate's stack and holds a full
    // node — key half and chain code. Wiped here rather than left to the
    // caller, because the caller never sees it.
    zeroize::Zeroize::zeroize(out.as_mut_slice());

    // What is *not* wiped, stated rather than glossed: `buffer` still holds the
    // trailing partial block of the message. `block-buffer` 0.10 exposes no way
    // to clear it — `reset` moves the cursor and leaves the bytes — and there is
    // no `Zeroize` impl to reach for. It is not a new exposure: the bytes are a
    // stack copy of the message the caller passed in, which the caller already
    // holds and zeroizes on its own drop. It is written down because "we
    // zeroize" is the kind of claim that should name its edges.
    //
    // See the crate note for what any of this promises under WASM, which is
    // less.
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact hazard the module note describes, asserted rather than
    /// remembered: personalized BLAKE2b-512 of the empty message must be the
    /// unkeyed value, and this vector came from Python's `hashlib.blake2b`.
    ///
    /// ```text
    /// python3 -c 'import hashlib; print(hashlib.blake2b(b"", digest_size=64,
    ///     person=b"Free2zMsg_MSTRv1").hexdigest())'
    /// ```
    #[test]
    fn personalized_blake2b_matches_an_independent_implementation() {
        let expected = [
            0xde, 0x11, 0xcc, 0xc3, 0x54, 0xcc, 0xc9, 0xe8, 0xb4, 0x45, 0x38, 0xf9, 0x18, 0xe5,
            0x41, 0x09, 0xfb, 0xf5, 0x6e, 0x27, 0x60, 0x36, 0x56, 0x9f, 0x60, 0x0a, 0xdb, 0x16,
            0xa7, 0xda, 0x31, 0xeb, 0xc2, 0x7b, 0x7f, 0xdd, 0x59, 0x4d, 0x19, 0x79, 0xa0, 0x88,
            0xbc, 0x08, 0xb9, 0x36, 0x8b, 0xd5, 0xfb, 0xd4, 0xd2, 0xa7, 0x45, 0xb3, 0x27, 0x3c,
            0x5e, 0xd1, 0x7d, 0xa6, 0x40, 0x8e, 0xb6, 0xaa,
        ];
        assert_eq!(
            *blake2b512_personal(b"Free2zMsg_MSTRv1", b""),
            expected,
            "the personalization is not reaching the parameter block, or the message is \
             being prefixed with a padded key block — see the module note"
        );
    }

    #[test]
    fn a_different_personalization_is_a_different_domain() {
        let message = b"the same message";
        assert_ne!(
            *blake2b512_personal(b"Free2zMsg_MSTRv1", message),
            *blake2b512_personal(b"Free2zMsg_CKDv1_", message)
        );
    }

    #[test]
    fn the_digest_is_the_full_five_hundred_and_twelve_bits() {
        // A `finalize_variable_core` that truncated would leave the chain code
        // half zero, which would silently collapse the tree.
        let digest = blake2b512_personal(b"Free2zMsg_MSTRv1", b"seed");
        assert_eq!(digest.len(), 64);
        assert!(digest.iter().any(|byte| *byte != 0));
        assert!(
            digest
                .get(32..)
                .is_some_and(|tail| tail.iter().any(|b| *b != 0))
        );
    }
}
