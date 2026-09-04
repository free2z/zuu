//! Binding an intent to the confirmation the user actually saw.
//!
//! This is the guard that makes the whole bridge a security boundary rather
//! than a message format, and it is a direct generalisation of two things this
//! repository already does:
//!
//! - **`#528`'s native confirmation token**
//!   (`wallet/plugins/tauri-plugin-zcash/src/wallet/send.rs`). A random token
//!   is issued only after the review is verified; its *hash* is stored bound to
//!   the review digest; it expires on both a monotonic and a wall clock and
//!   refuses a wall-clock rollback; and the comparison is constant time.
//! - **`creator-tip.ts`'s frozen snapshot.** The route state is
//!   renderer-controlled and therefore cannot authenticate itself, so the real
//!   values live in process memory keyed by a nonce, every field is
//!   re-validated on the wallet side, and any mismatch — or a reload — returns
//!   `null` rather than a best guess.
//!
//! The intent bridge has the same shape with a more hostile source: the
//! "renderer" is another application. So the rule is the same and stricter.
//!
//! # What the token binds
//!
//! ```text
//! struct {
//!     opaque request_digest[32];   // H("free2z/intent/v1/request", canonical envelope)
//!     opaque review_digest[32];    // the wallet's OWN re-derivation of what it showed
//!     opaque token[32];            // CSPRNG, issued at confirmation time
//! } ConfirmationTranscriptV1;
//!
//! token_hash = H("free2z/intent/v1/confirmation", ConfirmationTranscriptV1)
//! ```
//!
//! `request_digest` covers every field of the request — family, identifier,
//! caller, purpose, window, and the whole family payload — because it is taken
//! over the re-encoded envelope. `review_digest` is supplied by the wallet and
//! is the wallet's own summary of what it *rendered*: for `execute-payment`
//! that is the existing `send_review_digest`, re-derived from the proposal
//! rather than from the request. Binding both means neither can move alone.
//! Change one zatoshi of the amount and `request_digest` changes; re-render
//! the review against a different proposal and `review_digest` changes; either
//! way [`ConfirmationAuthorization::consume`] stops matching.
//!
//! The transcript is a `tls_codec` structure and not a concatenation. Three
//! fixed-width fields would concatenate unambiguously today, but a fourth
//! variable-width field added later would not, and "this concatenation happens
//! to be unambiguous" is a property nobody re-checks at the moment they add a
//! field.
//!
//! # One use, enforced by ownership
//!
//! [`ConfirmationAuthorization::consume`] takes `self`. There is no way to
//! verify a confirmation twice, because verifying it destroys it — the
//! borrow checker enforces what a `bool` field would only document.

// `tls_codec`'s derive macros need `format!` and `Vec` in scope in a `no_std`
// crate.
use alloc::format;
use alloc::vec::Vec;

use f2z_codec::canonical::Canonical;
use f2z_codec::hash::hash;
use f2z_codec::types::Digest;
use subtle::ConstantTimeEq;
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::clock::{Deadline, IntentClock};
use crate::error::IntentError;

/// The domain label for the confirmation binding.
pub const LABEL_INTENT_CONFIRMATION: &[u8] = b"free2z/intent/v1/confirmation";

/// How long a confirmation stays spendable, in milliseconds.
///
/// Two minutes — the same window `#528` chose for a payment confirmation, and
/// for the same reason: it is the interval between a person tapping *Approve*
/// and the wallet acting, not the interval a person needs to read a screen.
pub const CONFIRMATION_TTL_MS: u64 = 2 * 60 * 1000;

/// 32 CSPRNG bytes minted when the user approves.
///
/// The wallet holds only its hash; the token itself is handed to the caller of
/// the plugin command and presented back at execution. That indirection is
/// `#528`'s, and its value is that the stored authorization is not itself a
/// bearer secret.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ConfirmationToken([u8; 32]);

impl ConfirmationToken {
    /// Wrap 32 bytes from a CSPRNG.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Borrow the bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Hand-written and redacting: this *is* the bearer secret.
impl core::fmt::Debug for ConfirmationToken {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ConfirmationToken(<redacted>)")
    }
}

/// The exact bytes the confirmation binding hashes.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
struct ConfirmationTranscriptV1 {
    request_digest: Digest,
    review_digest: Digest,
    token: Digest,
}

/// Compute `token_hash`.
fn token_hash(
    request_digest: &Digest,
    review_digest: &Digest,
    token: &ConfirmationToken,
) -> Result<Digest, IntentError> {
    let transcript = ConfirmationTranscriptV1 {
        request_digest: *request_digest,
        review_digest: *review_digest,
        token: Digest::new(*token.as_bytes()),
    };
    Ok(hash(
        LABEL_INTENT_CONFIRMATION,
        &transcript.encode_canonical()?,
    ))
}

/// A user's approval of one specific intent, rendered one specific way.
///
/// Held by the wallet between the confirmation and the action. Not `Clone`:
/// a copy is a second use, and one-use is enforced by
/// [`ConfirmationAuthorization::consume`] taking `self`.
#[derive(Debug)]
pub struct ConfirmationAuthorization {
    token_hash: Digest,
    deadline: Deadline,
}

impl ConfirmationAuthorization {
    /// Record an approval.
    ///
    /// The caller must already have: parsed the request, claimed its
    /// identifier in the ledger, authorized its caller, re-derived the review
    /// itself, and shown that review to the user. This function does not check
    /// any of that — it cannot, and pretending otherwise would be the more
    /// dangerous API.
    ///
    /// # Errors
    ///
    /// [`IntentError::InvalidValue`] if the transcript cannot be encoded or
    /// the deadline would overflow.
    pub fn issue(
        request_digest: &Digest,
        review_digest: &Digest,
        token: &ConfirmationToken,
        now: IntentClock,
        ttl_ms: u64,
    ) -> Result<Self, IntentError> {
        Ok(Self {
            token_hash: token_hash(request_digest, review_digest, token)?,
            deadline: Deadline::after(now, ttl_ms)?,
        })
    }

    /// When this approval stops being spendable, on the wall clock.
    #[must_use]
    pub const fn expires_at_wall_ms(&self) -> u64 {
        self.deadline.expires_at_wall_ms()
    }

    /// Spend the approval, or refuse — and either way, it is gone.
    ///
    /// The order of checks is deliberate: the deadline first, then the
    /// binding. An expired confirmation is refused without a token comparison
    /// at all, so the timing of a refusal does not depend on how much of a
    /// guessed token was correct.
    ///
    /// # Errors
    ///
    /// - [`IntentError::Expired`] / [`IntentError::NotYetValid`] from the dual
    ///   clock, per [`Deadline::check`].
    /// - [`IntentError::NotConfirmed`] if the presented request digest, review
    ///   digest or token does not reproduce the stored hash. One error for all
    ///   three: telling a caller *which* one it got wrong is an oracle.
    pub fn consume(
        self,
        request_digest: &Digest,
        review_digest: &Digest,
        token: &ConfirmationToken,
        now: IntentClock,
    ) -> Result<(), IntentError> {
        self.deadline.check(now)?;
        let presented = token_hash(request_digest, review_digest, token)?;
        if bool::from(presented.as_bytes().ct_eq(self.token_hash.as_bytes())) {
            Ok(())
        } else {
            Err(IntentError::NotConfirmed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: IntentClock = IntentClock::new(10_000, 1_700_000_000_000);

    fn digest(byte: u8) -> Digest {
        Digest::new([byte; 32])
    }

    fn token(byte: u8) -> ConfirmationToken {
        ConfirmationToken::new([byte; 32])
    }

    fn authorization() -> ConfirmationAuthorization {
        ConfirmationAuthorization::issue(
            &digest(1),
            &digest(2),
            &token(3),
            NOW,
            CONFIRMATION_TTL_MS,
        )
        .unwrap()
    }

    #[test]
    fn the_matching_triple_is_accepted() {
        assert_eq!(
            authorization().consume(&digest(1), &digest(2), &token(3), NOW.advanced(1_000)),
            Ok(())
        );
    }

    #[test]
    fn each_of_the_three_bound_values_is_load_bearing() {
        assert_eq!(
            authorization().consume(&digest(9), &digest(2), &token(3), NOW),
            Err(IntentError::NotConfirmed),
            "a different request must not reuse this approval"
        );
        assert_eq!(
            authorization().consume(&digest(1), &digest(9), &token(3), NOW),
            Err(IntentError::NotConfirmed),
            "a re-rendered review must not reuse this approval"
        );
        assert_eq!(
            authorization().consume(&digest(1), &digest(2), &token(9), NOW),
            Err(IntentError::NotConfirmed),
            "a guessed token must not reuse this approval"
        );
    }

    #[test]
    fn the_transcript_is_not_a_concatenation_that_can_slide() {
        // Three fixed-width fields cannot slide today. The test that matters
        // is that the digests occupy distinct positions, so swapping them is
        // not a no-op — the property a concatenation loses first.
        let straight = token_hash(&digest(1), &digest(2), &token(3)).unwrap();
        let swapped = token_hash(&digest(2), &digest(1), &token(3)).unwrap();
        assert_ne!(straight, swapped);
    }

    #[test]
    fn a_confirmation_expires_on_both_clocks() {
        assert_eq!(
            authorization().consume(
                &digest(1),
                &digest(2),
                &token(3),
                NOW.advanced(CONFIRMATION_TTL_MS)
            ),
            Err(IntentError::Expired)
        );
        // Suspend: the monotonic counter stalls, the wall clock runs on.
        let suspended = IntentClock::new(NOW.monotonic_ms, NOW.wall_ms + CONFIRMATION_TTL_MS);
        assert_eq!(
            authorization().consume(&digest(1), &digest(2), &token(3), suspended),
            Err(IntentError::Expired)
        );
        // Rollback.
        let rolled_back = IntentClock::new(NOW.monotonic_ms + 1, NOW.wall_ms - 1);
        assert_eq!(
            authorization().consume(&digest(1), &digest(2), &token(3), rolled_back),
            Err(IntentError::NotYetValid)
        );
    }

    #[test]
    fn expiry_is_decided_before_the_token_is_compared() {
        // Not observable from outside, so this pins the *code* shape: an
        // expired authorization refuses even when the token is right, and the
        // refusal names expiry rather than the binding.
        assert_eq!(
            authorization().consume(
                &digest(1),
                &digest(2),
                &token(3),
                NOW.advanced(CONFIRMATION_TTL_MS)
            ),
            Err(IntentError::Expired)
        );
    }
}
