//! Two clocks, because one is not enough — the `#528` rule, generalised.
//!
//! `wallet/plugins/tauri-plugin-zcash/src/wallet/send.rs` states the problem
//! exactly, and the intent bridge inherits it unchanged:
//!
//! > Android/Linux monotonic clocks do not necessarily advance during suspend,
//! > while wall clocks can be adjusted backwards. Require both independent
//! > deadlines and reject rollback from issuance so neither clock behavior can
//! > extend this short-lived authority.
//!
//! A monotonic-only deadline is defeated by suspending the device: the counter
//! stops, so a two-minute window can span a night. A wall-only deadline is
//! defeated by setting the clock back — which, on a phone, an app with the
//! right permission or a user with the settings screen can simply do. Neither
//! failure requires an attacker to break anything; both are ordinary device
//! behaviour, and both extend an authority that was meant to last minutes.
//!
//! # Why this crate takes a clock rather than reading one
//!
//! `f2z-intent` is `no_std` with no I/O, so it *cannot* read a clock, and that
//! constraint is convenient rather than merely tolerable: every expiry rule
//! below is a pure function of its inputs, so the conformance suite can test
//! suspend, rollback and the exact boundary instant without sleeping and
//! without a fake-time framework. The caller — ZUULI's plugin — reads
//! `Instant::now()` and `SystemTime::now()` once and passes both.

use crate::error::IntentError;

/// One reading of both clocks, taken at the same instant.
///
/// `monotonic_ms` need not share an origin with `wall_ms`, and normally does
/// not: it is whatever the platform's steady clock counts from. Only
/// *differences* in it are ever used, which is the whole reason it is trusted
/// where the wall clock is not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IntentClock {
    /// A steady counter, in milliseconds. Never moves backwards; may stall
    /// across suspend on some platforms.
    pub monotonic_ms: u64,
    /// Milliseconds since the Unix epoch. May move in either direction.
    pub wall_ms: u64,
}

impl IntentClock {
    /// Take a reading.
    #[must_use]
    pub const fn new(monotonic_ms: u64, wall_ms: u64) -> Self {
        Self {
            monotonic_ms,
            wall_ms,
        }
    }

    /// Advance both clocks by `millis`, saturating.
    ///
    /// For tests and for callers that need a hypothetical later reading; the
    /// production path takes a fresh reading instead.
    #[must_use]
    pub const fn advanced(self, millis: u64) -> Self {
        Self {
            monotonic_ms: self.monotonic_ms.saturating_add(millis),
            wall_ms: self.wall_ms.saturating_add(millis),
        }
    }
}

/// A deadline on both clocks, plus the wall instant it was issued at.
///
/// Three facts, and all three are load-bearing:
///
/// - `expires_at_monotonic_ms` cannot be moved by changing the device clock.
/// - `expires_at_wall_ms` cannot be extended by suspending the device.
/// - `issued_at_wall_ms` makes a *backwards* wall-clock jump detectable, so
///   rolling the clock back does not reset the window — it voids it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadline {
    issued_at_wall_ms: u64,
    expires_at_monotonic_ms: u64,
    expires_at_wall_ms: u64,
}

impl Deadline {
    /// A deadline `ttl_ms` after `now` on both clocks.
    ///
    /// # Errors
    ///
    /// [`IntentError::InvalidValue`] if `ttl_ms` is zero, or if either
    /// deadline would overflow `u64`. Saturating here would silently mint an
    /// authority that never expires.
    pub const fn after(now: IntentClock, ttl_ms: u64) -> Result<Self, IntentError> {
        if ttl_ms == 0 {
            return Err(IntentError::InvalidValue);
        }
        let (Some(expires_at_monotonic_ms), Some(expires_at_wall_ms)) = (
            now.monotonic_ms.checked_add(ttl_ms),
            now.wall_ms.checked_add(ttl_ms),
        ) else {
            return Err(IntentError::InvalidValue);
        };
        Ok(Self {
            issued_at_wall_ms: now.wall_ms,
            expires_at_monotonic_ms,
            expires_at_wall_ms,
        })
    }

    /// Whether `now` is still inside the window on **both** clocks and has not
    /// rolled back past issuance.
    ///
    /// The comparison is `>=`, not `>`: the expiry instant itself is outside
    /// the window. A boundary that is inclusive on one side and exclusive on
    /// the other is the kind of detail a reader has to guess at, so it is
    /// stated here and pinned by a test.
    ///
    /// # Errors
    ///
    /// - [`IntentError::Expired`] if either deadline has passed.
    /// - [`IntentError::NotYetValid`] if the wall clock is earlier than
    ///   issuance.
    pub const fn check(self, now: IntentClock) -> Result<(), IntentError> {
        if now.wall_ms < self.issued_at_wall_ms {
            return Err(IntentError::NotYetValid);
        }
        if now.monotonic_ms >= self.expires_at_monotonic_ms
            || now.wall_ms >= self.expires_at_wall_ms
        {
            return Err(IntentError::Expired);
        }
        Ok(())
    }

    /// The wall-clock expiry, for a client that has to display one.
    #[must_use]
    pub const fn expires_at_wall_ms(self) -> u64 {
        self.expires_at_wall_ms
    }
}

/// Judge a request's own declared window against a clock reading.
///
/// The request carries wall-clock milliseconds only — the caller's monotonic
/// counter is meaningless in the wallet's process — so this is the one place
/// where a single clock decides. That is why [`crate::wire::IntentRequest`]'s
/// window is *also* bounded at parse time by
/// [`crate::wire::MAX_INTENT_LIFETIME_MS`]: a caller whose clock is wrong, or
/// who lies, still cannot declare a window longer than the ceiling, and the
/// dual-clock [`Deadline`] then governs the far more sensitive interval —
/// between the user's approval and the wallet's action.
///
/// # Errors
///
/// - [`IntentError::Expired`] if the request's expiry has passed.
/// - [`IntentError::NotYetValid`] if the request is dated in the future by
///   more than `skew_ms`.
pub const fn check_request_window(
    issued_at_ms: u64,
    expires_at_ms: u64,
    now: IntentClock,
    skew_ms: u64,
) -> Result<(), IntentError> {
    if now.wall_ms >= expires_at_ms {
        return Err(IntentError::Expired);
    }
    let Some(earliest) = issued_at_ms.checked_sub(skew_ms) else {
        // Issuance is within `skew_ms` of the epoch; nothing can precede it.
        return Ok(());
    };
    if now.wall_ms < earliest {
        return Err(IntentError::NotYetValid);
    }
    Ok(())
}

/// The clock skew a request's issuance timestamp is allowed, in milliseconds.
///
/// Two minutes, matching `WIRE.md` §5.5's posture towards a peer's clock: a
/// caller's device is not synchronised with the wallet's, and refusing a
/// request because the two disagree by seconds would make the bridge
/// unreliable for no security gain. It is a tolerance on *issuance*, never on
/// expiry — an expired intent is expired at zero tolerance.
pub const DEFAULT_CLOCK_SKEW_MS: u64 = 2 * 60 * 1000;

#[cfg(test)]
mod tests {
    use super::*;

    const START: IntentClock = IntentClock::new(1_000, 1_700_000_000_000);

    #[test]
    fn the_expiry_instant_itself_is_outside_the_window() {
        let deadline = Deadline::after(START, 60_000).unwrap();
        assert_eq!(deadline.check(START.advanced(59_999)), Ok(()));
        assert_eq!(
            deadline.check(START.advanced(60_000)),
            Err(IntentError::Expired)
        );
    }

    #[test]
    fn suspend_cannot_extend_the_window() {
        // The monotonic counter stalls across suspend; the wall clock does not.
        let deadline = Deadline::after(START, 60_000).unwrap();
        let after_suspend = IntentClock::new(START.monotonic_ms, START.wall_ms + 3_600_000);
        assert_eq!(
            deadline.check(after_suspend),
            Err(IntentError::Expired),
            "a monotonic-only deadline would have accepted this"
        );
    }

    #[test]
    fn winding_the_wall_clock_back_voids_rather_than_extends() {
        let deadline = Deadline::after(START, 60_000).unwrap();
        let rolled_back = IntentClock::new(START.monotonic_ms + 1, START.wall_ms - 1);
        assert_eq!(
            deadline.check(rolled_back),
            Err(IntentError::NotYetValid),
            "a wall-only deadline would have accepted this"
        );
    }

    #[test]
    fn a_zero_or_overflowing_ttl_is_refused_rather_than_saturated() {
        assert_eq!(Deadline::after(START, 0), Err(IntentError::InvalidValue));
        assert_eq!(
            Deadline::after(START, u64::MAX),
            Err(IntentError::InvalidValue)
        );
    }

    #[test]
    fn a_request_window_tolerates_issuance_skew_but_never_expiry() {
        let issued = START.wall_ms;
        let expires = issued + 60_000;
        // One second in the caller's future: accepted inside the skew.
        let early = IntentClock::new(START.monotonic_ms, issued - 1_000);
        assert_eq!(
            check_request_window(issued, expires, early, DEFAULT_CLOCK_SKEW_MS),
            Ok(())
        );
        // Ten minutes in the caller's future: refused.
        let far_early = IntentClock::new(START.monotonic_ms, issued - 600_000);
        assert_eq!(
            check_request_window(issued, expires, far_early, DEFAULT_CLOCK_SKEW_MS),
            Err(IntentError::NotYetValid)
        );
        // Expiry has no tolerance at all.
        let late = IntentClock::new(START.monotonic_ms, expires);
        assert_eq!(
            check_request_window(issued, expires, late, DEFAULT_CLOCK_SKEW_MS),
            Err(IntentError::Expired)
        );
    }
}
