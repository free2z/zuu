//! Proof of work — `WIRE.md` §13.1.
//!
//! ```text
//! struct {
//!     uint8  algorithm;        /* 1 = blake2b-leading-zero-bits */
//!     uint8  difficulty_bits;
//!     uint32 challenge_ttl_ms;
//! } PowParams;
//!
//! struct {
//!     opaque challenge[32];    /* from GET_CHALLENGE; single-use, expiring */
//!     opaque salt[16];
//!     uint64 counter;
//! } PowStamp;
//! ```
//!
//! A stamp is valid iff `H("free2z/relay/v1/pow", challenge || salt || counter)`
//! has at least `difficulty_bits` leading zero bits, the challenge is unconsumed
//! and unexpired, and (for `contact_append`) the challenge was issued for that
//! `contact_addr`.
//!
//! This module checks the hash half only. Challenge issuance, expiry and
//! single-use consumption are relay state and live above this crate — §12.3 is
//! explicit that binding the stamp to a relay-issued, single-use challenge is
//! what stops precomputation, and none of that is expressible here.
//!
//! §12.4 states the honest limit plainly: a leading-zero-bit search taxes phones
//! far more than it taxes rented GPUs, and that is not fixable by tuning. The
//! function is chosen so that **verification is a single hash** — the relay's
//! own cost under flood is the thing that must stay near zero.

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;

use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::CodecError;
use crate::hash::{LABEL_POW, hash};
use crate::types::{Challenge, Salt};

/// The only PoW algorithm in v1: BLAKE2b with a leading-zero-bit target.
pub const ALGORITHM_BLAKE2B_LEADING_ZERO_BITS: u8 = 1;

/// The relay's current proof-of-work parameters.
///
/// `algorithm` is a raw `u8`: §13.1 says "no other value in v1", so an unknown
/// algorithm is a *policy* refusal by the client — it declines the relay — not
/// a decode failure. [`PowParams::validate`] is where that refusal lives.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes,
)]
pub struct PowParams {
    /// 1 = blake2b-leading-zero-bits. No other value in v1.
    pub algorithm: u8,
    /// How many leading zero bits the stamp hash must have.
    pub difficulty_bits: u8,
    /// How long a challenge stays usable.
    pub challenge_ttl_ms: u32,
}

impl PowParams {
    /// All-zero parameters, meaning "no PoW required" (§6.1: the field is
    /// zeroed when no PoW is required).
    #[must_use]
    pub const fn none() -> Self {
        Self {
            algorithm: 0,
            difficulty_bits: 0,
            challenge_ttl_ms: 0,
        }
    }

    /// Whether these parameters demand any work.
    #[must_use]
    pub const fn is_required(&self) -> bool {
        self.algorithm != 0
    }

    /// Check that the parameters are ones a v1 client can satisfy.
    ///
    /// `difficulty_bits` needs no bound: it is a `u8`, the digest is 256 bits,
    /// so every representable value is satisfiable. Whether it is *reachable*
    /// on a phone is §12.4's problem, not this function's.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] if `algorithm` is neither 0 ("not
    /// required") nor 1.
    pub const fn validate(&self) -> Result<(), CodecError> {
        if self.algorithm != 0 && self.algorithm != ALGORITHM_BLAKE2B_LEADING_ZERO_BITS {
            return Err(CodecError::InvalidValue);
        }
        Ok(())
    }
}

/// A proof-of-work stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct PowStamp {
    /// The relay-issued challenge this stamp was computed over.
    pub challenge: Challenge,
    /// Client-chosen salt, so two clients searching the same challenge do not
    /// collide.
    pub salt: Salt,
    /// The search counter.
    pub counter: u64,
}

impl PowStamp {
    /// An all-zero stamp, for the `queue_creation_mode = open` case where
    /// §6.2's `CreateQueueRequest` carries an "empty" stamp.
    ///
    /// The specification says "empty" but the structure is fixed-width, so
    /// "empty" can only mean a zero-valued stamp: `PowStamp` has no
    /// variable-length field and §3.3 forbids omitting bytes. This is the
    /// reading this crate implements.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            challenge: Challenge::zero(),
            salt: Salt::zero(),
            counter: 0,
        }
    }

    /// Whether this is the zero stamp of [`PowStamp::empty`].
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.challenge.is_zero() && self.salt.is_zero() && self.counter == 0
    }

    /// `H("free2z/relay/v1/pow", challenge || salt || counter)`.
    ///
    /// `counter` is big-endian, like every other integer in this protocol
    /// (§1.3).
    #[must_use]
    pub fn digest(&self) -> crate::types::Digest {
        let mut input = [0u8; Challenge::LEN + Salt::LEN + 8];
        let (challenge_part, rest) = input.split_at_mut(Challenge::LEN);
        challenge_part.copy_from_slice(self.challenge.as_bytes());
        let (salt_part, counter_part) = rest.split_at_mut(Salt::LEN);
        salt_part.copy_from_slice(self.salt.as_bytes());
        counter_part.copy_from_slice(&self.counter.to_be_bytes());
        hash(LABEL_POW, &input)
    }

    /// Whether the stamp's hash meets `difficulty_bits` (§13.1).
    ///
    /// This is the hash half of validity only. The relay must still check that
    /// the challenge is unconsumed, unexpired, and — for `contact_append` —
    /// issued for the target `contact_addr`.
    #[must_use]
    pub fn meets_difficulty(&self, difficulty_bits: u8) -> bool {
        leading_zero_bits(self.digest().as_bytes()) >= u32::from(difficulty_bits)
    }
}

/// Count leading zero bits of a digest.
#[must_use]
pub fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut total = 0u32;
    for byte in digest {
        let zeros = byte.leading_zeros();
        total = total.saturating_add(zeros);
        if *byte != 0 {
            break;
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_zero_bits_counts_across_bytes() {
        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
        let mut digest = [0u8; 32];
        digest[0] = 0b0000_0001;
        assert_eq!(leading_zero_bits(&digest), 7);
        let mut digest = [0u8; 32];
        digest[1] = 0b0100_0000;
        assert_eq!(leading_zero_bits(&digest), 9);
        let mut digest = [0xffu8; 32];
        digest[0] = 0x80;
        assert_eq!(leading_zero_bits(&digest), 0);
    }

    #[test]
    fn a_search_finds_a_stamp_and_verification_is_one_hash() {
        let mut stamp = PowStamp {
            challenge: Challenge::new([0x5a; 32]),
            salt: Salt::new([0x0f; 16]),
            counter: 0,
        };
        // 12 bits is ~4096 hashes: fast enough for a unit test, real enough to
        // prove the search and the check agree.
        while !stamp.meets_difficulty(12) {
            stamp.counter = stamp.counter.saturating_add(1);
            assert!(stamp.counter < 1_000_000, "search did not converge");
        }
        assert!(stamp.meets_difficulty(12));
        assert!(stamp.meets_difficulty(0));

        // A different challenge does not inherit the work: this is why §12.3
        // requires the stamp to be bound to a relay-issued challenge.
        let elsewhere = PowStamp {
            challenge: Challenge::new([0xa5; 32]),
            ..stamp
        };
        assert_ne!(elsewhere.digest(), stamp.digest());
    }

    #[test]
    fn empty_stamp_is_all_zero() {
        assert!(PowStamp::empty().is_empty());
        assert!(
            !PowStamp {
                counter: 1,
                ..PowStamp::empty()
            }
            .is_empty()
        );
    }

    #[test]
    fn params_reject_an_algorithm_v1_does_not_define() {
        assert!(PowParams::none().validate().is_ok());
        assert!(!PowParams::none().is_required());
        assert!(
            PowParams {
                algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
                difficulty_bits: 20,
                challenge_ttl_ms: 60_000,
            }
            .validate()
            .is_ok()
        );
        assert_eq!(
            PowParams {
                algorithm: 2,
                difficulty_bits: 20,
                challenge_ttl_ms: 60_000,
            }
            .validate(),
            Err(CodecError::InvalidValue)
        );
    }
}
