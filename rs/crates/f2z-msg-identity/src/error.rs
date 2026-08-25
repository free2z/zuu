//! The one error type, and the one thing it deliberately will not tell you.

use core::fmt;

/// What can go wrong deriving or issuing a messaging identity.
///
/// Deliberately coarse. Every variant below is a **programming** error or a
/// malformed caller input, never a secret-dependent verdict: nothing in this
/// crate takes a branch on a key's value, so there is no oracle for a
/// finer-grained error to leak. A caller that could ask "which byte of the
/// credential was wrong?" would be a caller that could ask it repeatedly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum IdentityError {
    /// The BIP-39 seed is outside BIP-39's 16..=64 byte range.
    ///
    /// [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
    /// produces a 64-byte seed; the shorter lengths exist because a caller may
    /// hold a truncated or non-standard one, and silently accepting a 4-byte
    /// "seed" is how a test fixture becomes a production identity.
    SeedLength,
    /// A hardened index was given with the `0x8000_0000` bit already set.
    ///
    /// [`HardenedIndex`](crate::node::HardenedIndex) takes the *ordinal* — `32`
    /// for §4.2's `32'` — and sets the hardening bit itself. Accepting both
    /// spellings would mean `32` and `0x8000_0020` derived different keys while
    /// reading as the same path.
    IndexOutOfRange,
    /// A `DeviceCredential` field is outside what `KT.md` §4.1 admits: an empty
    /// KEM key, a handle outside `[a-z0-9_]{1,30}`, or a validity window that
    /// is empty or inverted.
    ///
    /// Refused at issuance rather than at submission, because a credential that
    /// can never be valid is one an MLS peer would reject after it had already
    /// been published to an append-only log.
    MalformedCredential,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SeedLength => "the BIP-39 seed is not between 16 and 64 bytes",
            Self::IndexOutOfRange => "a hardened index ordinal must be below 2^31",
            Self::MalformedCredential => {
                "the device credential fields are not valid per KT.md §4.1"
            }
        })
    }
}

impl core::error::Error for IdentityError {}
