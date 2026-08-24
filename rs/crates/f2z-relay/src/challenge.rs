//! Relay-issued, single-use, expiring challenges (§6.1, §12.3, §13.1).
//!
//! # What the challenge is actually for
//!
//! A proof-of-work stamp that a client could compute at leisure is not a cost;
//! it is a one-off purchase. §12.3 is explicit about the three properties the
//! challenge has to deliver:
//!
//! > *Binding the stamp to the target address and to a relay-issued challenge
//! > means stamps cannot be precomputed at leisure before a campaign, cannot be
//! > reused, and cannot be computed for one victim and spent on another.*
//!
//! So a challenge is drawn from the relay's CSPRNG ([`crate::rng`]), carries a
//! purpose and — for `contact_append` — the target address as its scope, and is
//! **removed from the table when it is spent**, whether or not the stamp that
//! spent it turned out to be valid for its purpose.
//!
//! # Bounded, and refusing rather than evicting
//!
//! The table is the one structure an unauthenticated caller can make the relay
//! allocate: `GET_CHALLENGE` needs no signature. So it is capped, and on
//! reaching the cap the relay answers `ERR_BACKPRESSURE` rather than dropping
//! an existing entry. Evicting would invalidate a stamp a client had *already
//! paid for*, at exactly the moment the relay is under load — the same shape of
//! mistake §5.5 forbids for the seen-set, for the same reason.
//!
//! Issuance is additionally rate-limited per source ([`crate::abuse`]), because
//! §6.1 says so plainly: *"Challenge issuance is itself rate-limited per source,
//! or it becomes the cheapest way to make the relay do work."*

use std::collections::HashMap;

use f2z_codec::ErrorCode;
use f2z_codec::types::Challenge;
use f2z_relay_proto::ProtoError;

/// One issued challenge.
#[derive(Clone)]
struct Issued {
    /// `ChallengePurpose::code()` — a stamp for one purpose is not a stamp for
    /// another.
    purpose: u8,
    /// The target address for `contact_append`, empty otherwise.
    scope: Vec<u8>,
    /// When it stops being spendable.
    expires_at_ms: u64,
}

// The scope is a `contact_addr`: a published address, but an address. Nothing
// here renders it.
impl core::fmt::Debug for Issued {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Issued")
            .field("purpose", &self.purpose)
            .field(
                "scope",
                &format_args!("<redacted; {} bytes>", self.scope.len()),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// The relay's challenge table.
#[derive(Debug)]
pub struct Challenges {
    issued: HashMap<Challenge, Issued>,
    max_entries: usize,
}

impl Challenges {
    /// An empty table bounded at `max_entries`.
    #[must_use]
    pub fn new(max_entries: usize) -> Self {
        Self {
            issued: HashMap::new(),
            max_entries,
        }
    }

    /// How many challenges are outstanding. `/metrics` publishes this as a
    /// total, never per source.
    #[must_use]
    pub fn len(&self) -> usize {
        self.issued.len()
    }

    /// Whether nothing is outstanding.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.issued.is_empty()
    }

    /// Drop everything past its expiry.
    ///
    /// Returns how many went, so a sweep can be reported as a count.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let before = self.issued.len();
        self.issued
            .retain(|_, issued| issued.expires_at_ms > now_ms);
        before.saturating_sub(self.issued.len())
    }

    /// Record a freshly drawn challenge.
    ///
    /// # Errors
    ///
    /// `ERR_BACKPRESSURE` when the table is full. Never an eviction: see the
    /// module documentation.
    pub fn issue(
        &mut self,
        challenge: Challenge,
        purpose: u8,
        scope: &[u8],
        expires_at_ms: u64,
        now_ms: u64,
    ) -> Result<(), ProtoError> {
        if self.issued.len() >= self.max_entries {
            // One sweep before refusing, so a table full of dead entries is not
            // reported as load.
            self.expire(now_ms);
        }
        if self.issued.len() >= self.max_entries {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }
        self.issued.insert(
            challenge,
            Issued {
                purpose,
                scope: scope.to_vec(),
                expires_at_ms,
            },
        );
        Ok(())
    }

    /// Spend a challenge, once.
    ///
    /// The entry is removed **before** its purpose and scope are judged: a
    /// challenge presented for the wrong purpose has still been presented, and
    /// leaving it spendable would let an attacker probe the table without
    /// consuming anything.
    ///
    /// # Errors
    ///
    /// `ERR_POW_INVALID` if it was never issued, has expired, was issued for a
    /// different purpose, or was issued for a different target (§12.3).
    pub fn consume(
        &mut self,
        challenge: &Challenge,
        purpose: u8,
        scope: &[u8],
        now_ms: u64,
    ) -> Result<(), ProtoError> {
        let Some(issued) = self.issued.remove(challenge) else {
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        };
        if issued.purpose != purpose
            || issued.expires_at_ms <= now_ms
            || (!scope.is_empty() && issued.scope != scope)
        {
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::commands::ChallengePurpose;

    fn challenge(byte: u8) -> Challenge {
        Challenge::new([byte; 32])
    }

    #[test]
    fn a_challenge_is_spendable_exactly_once() {
        let mut table = Challenges::new(8);
        let purpose = ChallengePurpose::QueueCreate.code();
        table.issue(challenge(1), purpose, &[], 1_000, 0).unwrap();
        assert!(table.consume(&challenge(1), purpose, &[], 0).is_ok());
        assert!(table.consume(&challenge(1), purpose, &[], 0).is_err());
    }

    #[test]
    fn a_challenge_is_scoped_to_its_target() {
        let mut table = Challenges::new(8);
        let purpose = ChallengePurpose::ContactAppend.code();
        table
            .issue(challenge(2), purpose, b"victim", 1_000, 0)
            .unwrap();
        assert!(table.consume(&challenge(2), purpose, b"other", 0).is_err());
    }

    #[test]
    fn a_challenge_is_bound_to_its_purpose() {
        let mut table = Challenges::new(8);
        table
            .issue(challenge(3), ChallengePurpose::Clock.code(), &[], 1_000, 0)
            .unwrap();
        assert!(
            table
                .consume(&challenge(3), ChallengePurpose::QueueCreate.code(), &[], 0)
                .is_err()
        );
    }

    #[test]
    fn an_expired_challenge_is_refused_and_swept() {
        let mut table = Challenges::new(8);
        let purpose = ChallengePurpose::QueueCreate.code();
        table.issue(challenge(4), purpose, &[], 1_000, 0).unwrap();
        assert!(table.consume(&challenge(4), purpose, &[], 2_000).is_err());
        table.issue(challenge(5), purpose, &[], 1_000, 0).unwrap();
        assert_eq!(table.expire(2_000), 1);
        assert!(table.is_empty());
    }

    #[test]
    fn a_full_table_refuses_and_never_evicts() {
        let mut table = Challenges::new(2);
        let purpose = ChallengePurpose::QueueCreate.code();
        table.issue(challenge(6), purpose, &[], 10_000, 0).unwrap();
        table.issue(challenge(7), purpose, &[], 10_000, 0).unwrap();
        let error = table
            .issue(challenge(8), purpose, &[], 10_000, 0)
            .unwrap_err();
        assert_eq!(error.wire_code(), Some(ErrorCode::Backpressure));
        // The two a client may already have paid for are still spendable, which
        // is the whole point of refusing rather than making room.
        assert!(table.consume(&challenge(6), purpose, &[], 0).is_ok());
        assert!(table.consume(&challenge(7), purpose, &[], 0).is_ok());
    }

    #[test]
    fn a_full_table_of_dead_entries_sweeps_before_it_refuses() {
        let mut table = Challenges::new(2);
        let purpose = ChallengePurpose::QueueCreate.code();
        table.issue(challenge(9), purpose, &[], 1_000, 0).unwrap();
        table.issue(challenge(10), purpose, &[], 1_000, 0).unwrap();
        assert!(
            table
                .issue(challenge(11), purpose, &[], 9_000, 5_000)
                .is_ok()
        );
    }

    #[test]
    fn nothing_in_the_table_renders_its_scope() {
        let mut table = Challenges::new(4);
        table
            .issue(
                challenge(12),
                ChallengePurpose::ContactAppend.code(),
                &[0xde, 0xad, 0xbe, 0xef],
                1_000,
                0,
            )
            .unwrap();
        let rendered = format!("{table:?}");
        assert!(
            !rendered.contains("222"),
            "decimal byte list leaked: {rendered}"
        );
        assert!(!rendered.contains("deadbeef"));
    }
}
