//! The relay's randomness: queue addresses (§7.1) and challenges (§6.1).
//!
//! §7.1 requires **both** queue addresses to come from the relay's own CSPRNG,
//! 32 uniformly random bytes each, independent of one another and of any key.
//! The reason is squatting: a client that names its own address lets an
//! adversary create queues at addresses it predicts a victim will want. So this
//! module has exactly one source — the operating system's — and no seedable
//! constructor at all.
//!
//! That absence is deliberate and it is the difference between this crate and
//! `f2z-relay-testkit`, whose addresses are a deterministic stream so that a
//! conformance vector can be a vector. Its README says plainly that this makes
//! `f2z-fakerelay` unsafe to deploy. A seeded constructor here, even behind a
//! test feature, would be a way for the same property to arrive in a real
//! relay by a build-flag mistake.

use f2z_codec::types::{Challenge, QueueAddress};
use rand::TryRngCore as _;

/// Fill a buffer from the operating system's CSPRNG.
///
/// # Errors
///
/// The OS refused to provide randomness. A relay that cannot draw an
/// unpredictable address must not invent one, so every caller propagates this
/// rather than falling back.
fn fill(buffer: &mut [u8; 32]) -> Result<(), rand::rand_core::OsError> {
    rand::rngs::OsRng.try_fill_bytes(buffer)
}

/// A fresh queue address (§7.1).
///
/// # Errors
///
/// [`rand::rand_core::OsError`] if the operating system refused. The caller
/// answers `ERR_INTERNAL`; §10 says that code carries no detail, ever.
pub fn queue_address() -> Result<QueueAddress, rand::rand_core::OsError> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(QueueAddress::new(bytes))
}

/// A fresh single-use challenge (§6.1, §13.1).
///
/// # Errors
///
/// As [`queue_address`].
pub fn challenge() -> Result<Challenge, rand::rand_core::OsError> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(Challenge::new(bytes))
}

/// A fresh 32-byte Ed25519 seed, for [`crate::identity`].
///
/// # Errors
///
/// As [`queue_address`].
pub fn seed() -> Result<[u8; 32], rand::rand_core::OsError> {
    let mut bytes = [0u8; 32];
    fill(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn addresses_do_not_repeat_and_are_not_zero() {
        let mut seen = BTreeSet::new();
        for _ in 0..256 {
            let address = queue_address().unwrap();
            assert!(!address.is_zero());
            assert!(seen.insert(*address.as_bytes()));
        }
    }

    #[test]
    fn a_challenge_is_drawn_from_the_same_source() {
        assert_ne!(challenge().unwrap(), challenge().unwrap());
    }
}
