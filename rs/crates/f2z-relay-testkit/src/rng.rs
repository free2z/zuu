//! The address and nonce source — deterministic on purpose, and **not**
//! cryptographically unpredictable.
//!
//! `WIRE.md` §7.1 requires a relay to generate both queue addresses "from its
//! own CSPRNG", and §7.1's whole argument for relay-chosen addresses is that a
//! client cannot predict or squat them. This type does not provide that
//! property and does not claim to: it is BLAKE2b in counter mode over a seed
//! the caller supplies, so a caller who knows the seed knows every address the
//! relay will ever hand out.
//!
//! That is deliberate, it is the right trade for a test harness, and it is the
//! single clearest reason `f2z-fakerelay` must never be deployed:
//!
//! - A conformance vector that produced different addresses on every run could
//!   not be a vector. Reproducibility is what lets a failure be replayed
//!   verbatim, in CI, six months later.
//! - Seeding it from the operating system would need `getrandom`, i.e. a
//!   dependency added to a crate whose randomness is documented not to matter.
//!
//! [`Csprng::from_clock`] exists so the binary does not hand every deployment
//! the same addresses; it is a *variety* source, not an entropy source, and the
//! difference is stated rather than blurred.

use f2z_codec::hash::hash;
use f2z_codec::types::{Challenge, QueueAddress};

/// The domain label for this generator's stream.
///
/// It is deliberately not one of `f2z_codec::hash::LABELS`: nothing in the
/// protocol hashes with it, and adding a testkit label to the protocol's
/// prefix-free set would put a test harness inside the domain separation
/// argument of `WIRE.md` §1.3.
const LABEL: &[u8] = b"f2z-relay-testkit/rng/v1";

/// A reproducible byte source for relay-generated addresses and challenges.
#[derive(Clone)]
pub struct Csprng {
    seed: [u8; 32],
    counter: u64,
}

// The seed is not secret in the sense a signing key is — the default is a
// constant in this repository — but printing it hands a reader every address
// the relay will ever produce, which is the one thing §7.1 wants withheld.
// Same rule as `f2z-codec`'s newtypes, and for the same reason: `--log-level
// trace` must not become a capability archive.
impl core::fmt::Debug for Csprng {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Csprng")
            .field("seed", &"<redacted>")
            .field("counter", &self.counter)
            .finish()
    }
}

impl Csprng {
    /// A stream fixed by `seed`. Two relays with the same seed hand out the
    /// same addresses in the same order.
    #[must_use]
    pub const fn from_seed(seed: [u8; 32]) -> Self {
        Self { seed, counter: 0 }
    }

    /// A stream varied by the wall clock.
    ///
    /// Read the module note before using this for anything: it is a variety
    /// source so two runs of `f2z-fakerelay` do not collide, not an entropy
    /// source, and the addresses it produces are guessable by anyone who knows
    /// roughly when the process started.
    #[must_use]
    pub fn from_clock() -> Self {
        let millis = core::time::Duration::from_secs(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(millis);
        let mut seed = [0u8; 32];
        let stamp = hash(LABEL, &now.as_nanos().to_be_bytes());
        seed.copy_from_slice(stamp.as_bytes());
        Self::from_seed(seed)
    }

    /// The next 32 bytes of the stream.
    #[must_use]
    pub fn next_block(&mut self) -> [u8; 32] {
        let mut input = [0u8; 40];
        let (seed, counter) = input.split_at_mut(32);
        seed.copy_from_slice(&self.seed);
        counter.copy_from_slice(&self.counter.to_be_bytes());
        self.counter = self.counter.wrapping_add(1);
        *hash(LABEL, &input).as_bytes()
    }

    /// The next `N` bytes, for the fixed-width newtypes of `f2z-codec`.
    #[must_use]
    pub fn next_bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        let mut written = 0usize;
        while written < N {
            let block = self.next_block();
            let take = core::cmp::min(32, N.saturating_sub(written));
            let end = written.saturating_add(take);
            match (out.get_mut(written..end), block.get(..take)) {
                (Some(slot), Some(source)) => slot.copy_from_slice(source),
                // Unreachable by the loop bound; the workspace forbids
                // indexing, so the impossible branch is written out rather
                // than asserted away.
                _ => break,
            }
            written = end;
        }
        out
    }

    /// A fresh 32-byte queue address (§7.1).
    #[must_use]
    pub fn next_address(&mut self) -> QueueAddress {
        QueueAddress::new(self.next_block())
    }

    /// A fresh 32-byte challenge (§6.1).
    #[must_use]
    pub fn next_challenge(&mut self) -> Challenge {
        Challenge::new(self.next_block())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_yields_the_same_stream() {
        let mut left = Csprng::from_seed([7u8; 32]);
        let mut right = Csprng::from_seed([7u8; 32]);
        for _ in 0..8 {
            assert_eq!(left.next_block(), right.next_block());
        }
    }

    #[test]
    fn different_seeds_diverge_immediately() {
        let mut left = Csprng::from_seed([7u8; 32]);
        let mut right = Csprng::from_seed([8u8; 32]);
        assert_ne!(left.next_block(), right.next_block());
    }

    #[test]
    fn successive_addresses_differ() {
        let mut rng = Csprng::from_seed([1u8; 32]);
        let first = rng.next_address();
        let second = rng.next_address();
        assert_ne!(first, second);
        assert!(!first.is_zero());
    }

    #[test]
    fn odd_widths_are_filled_completely() {
        let mut rng = Csprng::from_seed([2u8; 32]);
        let short: [u8; 16] = rng.next_bytes();
        let long: [u8; 48] = rng.next_bytes();
        assert!(short.iter().any(|byte| *byte != 0));
        assert!(long.iter().any(|byte| *byte != 0));
        assert!(long.iter().skip(32).any(|byte| *byte != 0));
    }
}
