//! `WIRE.md` §9 — the relay rejects a payload whose length is not exactly one
//! of its published `padding_sizes`.
//!
//! The interesting cases are the near misses. A length one byte off a bucket is
//! what a sloppy client produces; a length one byte off *every* bucket is what a
//! malicious client uses to signal to a colluding relay. Both must fail, and
//! both must fail non-fatally so a single bad message does not tear down a
//! connection carrying good ones.

// See the note in tests/redaction.rs.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use f2z_codec::error::ErrorCode;
use f2z_codec::padding::{PROPOSED_BUCKETS, PaddingBuckets};
use f2z_codec::types::Payload;
use proptest::prelude::*;

#[test]
fn conforming_lengths_pass_and_everything_else_does_not() {
    let buckets = PaddingBuckets::new(PROPOSED_BUCKETS).unwrap();

    for size in PROPOSED_BUCKETS {
        let payload = Payload::new(vec![0u8; size as usize]).unwrap();
        assert!(
            buckets.validate_payload(&payload).is_ok(),
            "{size} is a published bucket"
        );
    }

    // One byte either side of every bucket, plus the boundaries a naive
    // implementation gets wrong: zero, and one past the largest.
    let mut rejected: Vec<usize> = vec![0, 1, 65_537, 1 << 20];
    for size in PROPOSED_BUCKETS {
        rejected.push(size as usize - 1);
        rejected.push(size as usize + 1);
    }
    for size in rejected {
        let payload = Payload::new(vec![0u8; size]).unwrap();
        assert_eq!(
            buckets.validate_payload(&payload),
            Err(ErrorCode::BadSize),
            "{size} is not a published bucket"
        );
    }
}

#[test]
fn bad_size_is_non_fatal_by_rule() {
    // §10's table. A relay that closes the connection on ERR_BAD_SIZE turns one
    // client bug into a reconnect storm.
    assert!(!ErrorCode::BadSize.is_fatal());
    assert_eq!(ErrorCode::BadSize.code(), 12);
}

#[test]
fn a_relay_set_that_is_not_a_superset_is_refused_at_connect_time() {
    // §11.3 step 4. Better to refuse the relay once than to fail per message.
    let relay = PaddingBuckets::new([1024u32, 65_536]).unwrap();
    let client = PaddingBuckets::new(PROPOSED_BUCKETS).unwrap();
    assert!(!relay.is_superset_of(&client));
    assert!(client.is_superset_of(&relay));
}

#[test]
fn an_implausibly_fine_grained_relay_set_is_flagged() {
    // §9: a set with more than 16 entries, or spacing below 512 bytes, is
    // indistinguishable from a covert length channel.
    let covert: Vec<u32> = (1..=64u32).map(|i| i * 64).collect();
    let buckets = PaddingBuckets::new(covert).unwrap();
    assert!(!buckets.is_plausible());
    assert!(
        PaddingBuckets::new(PROPOSED_BUCKETS)
            .unwrap()
            .is_plausible()
    );
}

proptest! {
    /// Exactly the published sizes, and nothing else, for arbitrary lengths.
    #[test]
    fn acceptance_is_exactly_set_membership(len in 0usize..200_000) {
        let buckets = PaddingBuckets::new(PROPOSED_BUCKETS).unwrap();
        let expected = PROPOSED_BUCKETS.iter().any(|size| *size as usize == len);
        prop_assert_eq!(buckets.validate_len(len).is_ok(), expected);
    }

    /// A client pads *up* to the smallest bucket that fits, and what it pads to
    /// is always accepted. Above the largest bucket there is no answer, which is
    /// the signal to chunk (§9).
    #[test]
    fn padding_up_always_produces_an_accepted_length(len in 0usize..200_000) {
        let buckets = PaddingBuckets::new(PROPOSED_BUCKETS).unwrap();
        match buckets.bucket_for(len) {
            Some(bucket) => {
                prop_assert!(bucket as usize >= len);
                prop_assert!(buckets.validate_len(bucket as usize).is_ok());
            }
            None => prop_assert!(len > buckets.largest() as usize),
        }
    }

    /// An arbitrary ascending set is adopted; anything else is refused. The
    /// ascending requirement is what makes the spacing rule meaningful.
    #[test]
    fn only_strictly_ascending_sets_are_adopted(
        sizes in proptest::collection::vec(1u32..100_000, 1..12)
    ) {
        let ascending = sizes.windows(2).all(|pair| pair[0] < pair[1]);
        prop_assert_eq!(PaddingBuckets::new(sizes).is_ok(), ascending);
    }
}
