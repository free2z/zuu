//! Padding enforcement — `WIRE.md` §9.
//!
//! A payload's length MUST be **exactly** one of the sizes in the relay's
//! published `padding_sizes`. Any other length is `ERR_BAD_SIZE`, non-fatal.
//!
//! Three things about this are easy to get backwards, and all three are
//! encoded here rather than left to a comment:
//!
//! 1. **The size set lives in the capability document, not in the protocol.**
//!    `ARCHITECTURE.md` §13-F records that the bucket sizes are placeholders
//!    chosen for arithmetic convenience and need a traffic study. Putting them
//!    in a versioned protocol structure would make the eventual measured answer
//!    maximally expensive to adopt, which is a good way to guarantee it never
//!    gets adopted. So [`PaddingBuckets`] is a runtime value, not a constant.
//! 2. **The relay's list is a filter, not the source of truth.** The security
//!    property comes from the *client* padding to its own configured set before
//!    the ciphertext ever leaves the device. The relay's rejection is a backstop
//!    against a sloppy client and against a malicious client trying to use
//!    length as a covert channel to a colluding relay. Hence
//!    [`PaddingBuckets::is_superset_of`]: a client MUST refuse a relay whose set
//!    is not a superset of what the client will emit.
//! 3. **An implausibly fine-grained set is itself the attack.** §9's v1 rule of
//!    thumb — more than 16 entries, or a spacing below 512 bytes between
//!    adjacent buckets — is [`PaddingBuckets::is_plausible`]. Such a set is
//!    indistinguishable from an attempt to let a colluding client leak length
//!    through size.

use alloc::vec::Vec;

use crate::error::{CodecError, ErrorCode};

/// `ARCHITECTURE.md` §6.5's proposed buckets: 1 KiB / 4 KiB / 16 KiB / 64 KiB.
///
/// Placeholders chosen for arithmetic convenience, not measurement — see
/// §13-F. Present so tests and examples have a concrete set, never as a
/// protocol constant.
pub const PROPOSED_BUCKETS: [u32; 4] = [1024, 4096, 16_384, 65_536];

/// The default `max_chunk_bytes` (§9): payloads larger than the largest bucket
/// are chunked client-side into units of this size.
pub const DEFAULT_MAX_CHUNK_BYTES: u32 = 65_536;

/// The most entries a plausible bucket set has (§9's v1 rule of thumb).
pub const MAX_PLAUSIBLE_BUCKETS: usize = 16;

/// The smallest plausible spacing between adjacent buckets, in bytes (§9's v1
/// rule of thumb).
pub const MIN_PLAUSIBLE_SPACING: u32 = 512;

/// A relay's published `padding_sizes`, validated as a set.
///
/// The `uint32 padding_sizes<1..2^16-1>` of §11.1 is declared **ascending**.
/// This type refuses to exist unless that holds, because "ascending" is what
/// makes [`PaddingBuckets::is_plausible`]'s spacing check mean anything and
/// what makes a duplicate detectable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaddingBuckets {
    sizes: Vec<u32>,
}

impl PaddingBuckets {
    /// Validate and adopt a published size set.
    ///
    /// # Errors
    ///
    /// - [`CodecError::InvalidValue`] if the set is empty, not strictly
    ///   ascending (which covers duplicates), or contains 0. A zero-length
    ///   bucket is not padding; it is a payload that carries its own absence.
    /// - [`CodecError::Overflow`] if the set has more entries than the
    ///   `<1..2^16-1>` length prefix can describe.
    pub fn new(sizes: impl Into<Vec<u32>>) -> Result<Self, CodecError> {
        let sizes = sizes.into();
        if sizes.is_empty() {
            return Err(CodecError::InvalidValue);
        }
        // The prefix counts bytes, and each entry is 4 of them.
        if sizes.len() > (u16::MAX as usize) / 4 {
            return Err(CodecError::Overflow);
        }
        let mut previous: Option<u32> = None;
        for size in &sizes {
            if *size == 0 {
                return Err(CodecError::InvalidValue);
            }
            if previous.is_some_and(|previous| *size <= previous) {
                return Err(CodecError::InvalidValue);
            }
            previous = Some(*size);
        }
        Ok(Self { sizes })
    }

    /// The sizes, ascending.
    #[must_use]
    pub fn sizes(&self) -> &[u32] {
        &self.sizes
    }

    /// The largest bucket. Payloads above this are chunked client-side (§9).
    #[must_use]
    pub fn largest(&self) -> u32 {
        self.sizes.last().copied().unwrap_or(0)
    }

    /// Whether `len` is exactly one of the buckets.
    #[must_use]
    pub fn accepts(&self, len: usize) -> bool {
        u32::try_from(len).is_ok_and(|len| self.sizes.binary_search(&len).is_ok())
    }

    /// Enforce §9 on a payload length.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::BadSize`] — non-fatal — when the length is not exactly one
    /// of the published sizes.
    pub fn validate_len(&self, len: usize) -> Result<(), ErrorCode> {
        if self.accepts(len) {
            Ok(())
        } else {
            Err(ErrorCode::BadSize)
        }
    }

    /// Enforce §9 on a payload.
    ///
    /// # Errors
    ///
    /// As [`PaddingBuckets::validate_len`].
    pub fn validate_payload(&self, payload: &crate::types::Payload) -> Result<(), ErrorCode> {
        self.validate_len(payload.len())
    }

    /// The smallest bucket that can hold `len` bytes, if any.
    ///
    /// This is what a client pads *to*. It returns `None` when `len` exceeds
    /// the largest bucket, which is the signal to chunk (§9).
    #[must_use]
    pub fn bucket_for(&self, len: usize) -> Option<u32> {
        let len = u32::try_from(len).ok()?;
        self.sizes.iter().copied().find(|size| *size >= len)
    }

    /// Whether this set contains every size in `other`.
    ///
    /// §11.3 step 4: a client MUST refuse a relay whose published set is not a
    /// superset of the sizes the client will emit. A relay that publishes a
    /// coarse set and a client that pads to a fine set simply fails at
    /// `ERR_BAD_SIZE`, loudly, which is the correct direction for the failure
    /// to point — but failing at connect time is better than failing per
    /// message.
    #[must_use]
    pub fn is_superset_of(&self, other: &Self) -> bool {
        other
            .sizes
            .iter()
            .all(|size| self.sizes.binary_search(size).is_ok())
    }

    /// Whether the set passes §9's plausibility rule of thumb.
    ///
    /// `false` means the relay published a set fine-grained enough to be
    /// indistinguishable from a covert length channel. §9 says a client SHOULD
    /// refuse such a relay; this crate reports, and the decision is the
    /// caller's.
    #[must_use]
    pub fn is_plausible(&self) -> bool {
        if self.sizes.len() > MAX_PLAUSIBLE_BUCKETS {
            return false;
        }
        self.sizes.windows(2).all(|pair| match pair {
            [low, high] => high.saturating_sub(*low) >= MIN_PLAUSIBLE_SPACING,
            _ => true,
        })
    }
}

impl Default for PaddingBuckets {
    /// `ARCHITECTURE.md` §6.5's proposed set. A placeholder, by §13-F.
    fn default() -> Self {
        Self {
            sizes: PROPOSED_BUCKETS.to_vec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn rejects_sets_that_are_not_strictly_ascending() {
        assert_eq!(PaddingBuckets::new(vec![]), Err(CodecError::InvalidValue));
        assert_eq!(
            PaddingBuckets::new(vec![4096, 1024]),
            Err(CodecError::InvalidValue)
        );
        assert_eq!(
            PaddingBuckets::new(vec![1024, 1024]),
            Err(CodecError::InvalidValue)
        );
        assert_eq!(
            PaddingBuckets::new(vec![0, 1024]),
            Err(CodecError::InvalidValue)
        );
        assert!(PaddingBuckets::new(PROPOSED_BUCKETS).is_ok());
    }

    #[test]
    fn only_exact_bucket_sizes_are_accepted() {
        let buckets = PaddingBuckets::default();
        for size in PROPOSED_BUCKETS {
            assert!(buckets.accepts(size as usize));
            assert!(buckets.validate_len(size as usize).is_ok());
        }
        for size in [0usize, 1, 100, 1023, 1025, 4095, 65_535, 65_537, 1 << 20] {
            assert!(!buckets.accepts(size), "{size} must not be accepted");
            assert_eq!(buckets.validate_len(size), Err(ErrorCode::BadSize));
        }
    }

    #[test]
    fn bad_size_is_not_fatal() {
        // §10: ERR_BAD_SIZE keeps the connection. A sloppy client is not an
        // attacker and must not be disconnected for one message.
        assert!(!ErrorCode::BadSize.is_fatal());
    }

    #[test]
    fn bucket_for_pads_up_and_signals_chunking() {
        let buckets = PaddingBuckets::default();
        assert_eq!(buckets.bucket_for(0), Some(1024));
        assert_eq!(buckets.bucket_for(1024), Some(1024));
        assert_eq!(buckets.bucket_for(1025), Some(4096));
        assert_eq!(buckets.bucket_for(65_536), Some(65_536));
        assert_eq!(buckets.bucket_for(65_537), None, "above the largest: chunk");
        assert_eq!(buckets.largest(), 65_536);
    }

    #[test]
    fn superset_is_what_a_client_checks_at_connect_time() {
        let relay = PaddingBuckets::default();
        let client = PaddingBuckets::new(vec![1024, 65_536]).unwrap();
        assert!(relay.is_superset_of(&client));
        let finer = PaddingBuckets::new(vec![1024, 2048]).unwrap();
        assert!(!relay.is_superset_of(&finer));
    }

    #[test]
    fn implausibly_fine_grained_sets_are_flagged() {
        assert!(PaddingBuckets::default().is_plausible());
        // Spacing below 512 bytes.
        assert!(
            !PaddingBuckets::new(vec![1024, 1280, 4096])
                .unwrap()
                .is_plausible()
        );
        // More than 16 entries.
        let many: Vec<u32> = (1..=17).map(|i| i * 1024).collect();
        assert!(!PaddingBuckets::new(many).unwrap().is_plausible());
        let sixteen: Vec<u32> = (1..=16).map(|i| i * 1024).collect();
        assert!(PaddingBuckets::new(sixteen).unwrap().is_plausible());
    }

    #[test]
    fn validate_payload_matches_validate_len() {
        let buckets = PaddingBuckets::default();
        let good = crate::types::Payload::new(vec![0u8; 4096]).unwrap();
        let bad = crate::types::Payload::new(vec![0u8; 4095]).unwrap();
        assert!(buckets.validate_payload(&good).is_ok());
        assert_eq!(buckets.validate_payload(&bad), Err(ErrorCode::BadSize));
    }
}
