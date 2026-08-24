//! Negative testing of the public API, which is NCC Group's own strategic
//! recommendation for `akd` and is cheap for us to actually do.
//!
//! ADR 0013 is blunt about where the risk sits: the audit covers `akd`, not our
//! use of `akd`, and NCC said so directly — *"the correct behavior of akd relies
//! on proper integration with an external application that authenticates users
//! and publishes updates to the directory. This integration must be done
//! properly."* [`f2z_kt_core::validate_submission`] **is** that integration, and
//! it is the first thing an unauthenticated submission reaches.
//!
//! So the property asserted here is the weakest interesting one, and the one a
//! log's availability depends on: **for arbitrary bytes, the submission path
//! returns a verdict.** It never panics, never overflows, never indexes out of
//! bounds, and never loops. The workspace already denies the arithmetic and
//! unwrap families precisely because a panic on the unauthenticated path is a
//! remote denial of service; this is the test that watches the denial hold.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::PublicKey;
use f2z_kt_core::submit::{LogPolicy, SubmissionContext, validate_submission};
use f2z_kt_core::types::LogId;
use f2z_kt_core::{DirectoryEntry, KtError};
use proptest::prelude::*;

fn policy() -> LogPolicy {
    LogPolicy::new(
        LogId::new([0x11; 32]),
        PublicKey::new([0x22; 32]),
        7 * 24 * 60 * 60,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Arbitrary bytes reach a verdict, never a panic.
    #[test]
    fn arbitrary_bytes_are_a_verdict_not_a_crash(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        let policy = policy();
        let context = SubmissionContext {
            policy: &policy,
            previous: None,
            pending_in_epoch: false,
            now_ms: 1_700_000_000_000,
        };
        // The only assertion that matters is that this returns at all. The
        // verdict itself is uninteresting: no random byte string is a validly
        // signed directory entry, so every case here is an `Err`.
        prop_assert!(validate_submission(&bytes, &context).is_err());
    }

    /// Structured noise — bytes that begin with the right label field, so the
    /// decoder gets further in before failing — also reaches a verdict.
    #[test]
    fn a_plausible_prefix_does_not_change_that(tail in prop::collection::vec(any::<u8>(), 0..2048)) {
        let mut bytes = vec![18u8];
        bytes.extend_from_slice(b"free2z/kt/v1/entry");
        bytes.extend_from_slice(&tail);
        let policy = policy();
        let context = SubmissionContext {
            policy: &policy,
            previous: None,
            pending_in_epoch: false,
            now_ms: 1_700_000_000_000,
        };
        prop_assert!(validate_submission(&bytes, &context).is_err());
    }

    /// The decoder itself is total: it either produces a `DirectoryEntry` whose
    /// re-encoding is byte-identical to its input, or it refuses.
    ///
    /// This is `WIRE.md` §3.3 stated as a property rather than as a handful of
    /// examples. There is no third outcome, and in particular no outcome in
    /// which a decoder is more permissive than its encoder.
    #[test]
    fn decoding_is_total_and_canonical(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        match decode_canonical::<DirectoryEntry>(&bytes) {
            Err(_) => {}
            Ok(decoded) => prop_assert_eq!(decoded.bytes(), bytes.as_slice()),
        }
    }
}

#[test]
fn an_empty_submission_is_malformed_rather_than_anything_else() {
    let policy = policy();
    let context = SubmissionContext {
        policy: &policy,
        previous: None,
        pending_in_epoch: false,
        now_ms: 0,
    };
    assert_eq!(validate_submission(&[], &context), Err(KtError::Malformed));
}
