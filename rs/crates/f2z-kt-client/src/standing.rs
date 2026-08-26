//! What the witness set actually establishes — and the number a UI is allowed
//! to show.
//!
//! # The requirement, stated where the type is
//!
//! `KT.md` §8.3, in full, because everything in this module is a consequence of
//! it:
//!
//! > At launch free2z operates the log and every witness. §9.3 already says
//! > that witnesses free2z operates are not independent witnesses; the
//! > consequence for this section is that **whatever *t* is configured, the
//! > cryptographic value of meeting it is zero** until at least two witnesses
//! > are run by parties outside free2z. A client that displays "3 of 3
//! > witnesses" in that state is displaying a reassuring number for a property
//! > it does not have, which is worse than displaying nothing.
//! >
//! > Therefore: **the UI MUST display the number of *independent* witnesses,
//! > not the number of configured witnesses**, and MUST state plainly when that
//! > number is zero.
//!
//! So [`WitnessStanding::independent`] is short, and the count that includes
//! witnesses the client itself operates is spelled
//! [`WitnessStanding::counted_including_dependent`]. That is not decoration:
//! the two are indistinguishable as `usize`s, a caller reaching for "the
//! witness count" will reach for whichever is easier to type, and the easier
//! one is the one §8.3 permits.
//!
//! # Independence is asserted, never inferred
//!
//! Whether a witness is operated by a party outside the log's operator is a
//! **social fact** (`THREAT-MODEL.md` §3.9). Nothing in a cosignature carries
//! it, nothing in this crate computes it, and a list of witnesses supplied by
//! the log is a list chosen by the party the witnesses exist to audit. It
//! arrives as [`f2z_kt_core::ConfiguredWitness::independent`], from the caller,
//! and travels through here unchanged.

use f2z_kt_core::{AcceptedRoot, WitnessSet};

/// What a client's own witness set established about one root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WitnessStanding {
    independent: usize,
    counted: usize,
    configured: usize,
    threshold: usize,
}

impl WitnessStanding {
    /// Read the standing off a root that met the threshold.
    #[must_use]
    pub fn of(root: &AcceptedRoot, set: &WitnessSet) -> Self {
        Self {
            independent: root.independent_cosignature_count(),
            counted: root.cosignature_count(),
            configured: set.len(),
            threshold: set.threshold(),
        }
    }

    /// The standing of a root that did **not** meet the threshold.
    ///
    /// Every count is zero except the configuration, because
    /// [`f2z_kt_core::verify_threshold`] carries no partial result and this
    /// crate does not invent one. A client that showed "1 of 3 witnesses, not
    /// enough" would be showing a number for a root it refused.
    #[must_use]
    pub fn unmet(set: &WitnessSet) -> Self {
        Self {
            independent: 0,
            counted: 0,
            configured: set.len(),
            threshold: set.threshold(),
        }
    }

    /// **The number a UI displays** — how many witnesses the client asserts are
    /// operated outside the log's operator, and that cosigned this exact root.
    ///
    /// §8.3 requires this and not [`WitnessStanding::configured`], and requires
    /// a client to *"state plainly when that number is zero"*.
    #[must_use]
    pub const fn independent(&self) -> usize {
        self.independent
    }

    /// How many distinct configured witnesses cosigned this root, independent
    /// or not.
    ///
    /// **Not for display.** Named at length so that a caller has to mean it:
    /// in the shipped configuration this number is greater than zero while
    /// [`WitnessStanding::independent`] is zero, and showing it is exactly the
    /// "3 of 3 witnesses" §8.3 forbids.
    #[must_use]
    pub const fn counted_including_dependent(&self) -> usize {
        self.counted
    }

    /// How many witnesses the client configured. Also not for display.
    #[must_use]
    pub const fn configured(&self) -> usize {
        self.configured
    }

    /// The client's own *t*.
    #[must_use]
    pub const fn threshold(&self) -> usize {
        self.threshold
    }

    /// Whether §8.3's threshold was met over the client's own set.
    #[must_use]
    pub const fn threshold_met(&self) -> bool {
        self.counted >= self.threshold
    }

    /// Whether this root carries **any** anti-equivocation value at all.
    ///
    /// Two independent witnesses, because that is what §8.3 says the property
    /// costs: *"the cryptographic value of meeting it is zero until at least
    /// two witnesses are run by parties outside free2z"*. One outside witness
    /// that colludes or is coerced leaves the log's operator able to show two
    /// histories with no second signer to contradict it.
    ///
    /// **In the shipped configuration this returns `false`, and it is meant
    /// to.** It exists so a UI has a boolean to gate reassuring language on
    /// rather than a count it will be tempted to render.
    #[must_use]
    pub const fn is_independently_witnessed(&self) -> bool {
        self.independent >= 2
    }
}

#[cfg(test)]
mod tests {
    use f2z_codec::types::PublicKey;
    use f2z_kt_core::{ConfiguredWitness, WitnessSet};

    use super::WitnessStanding;

    fn set() -> WitnessSet {
        WitnessSet::new(
            vec![
                ConfiguredWitness::dependent(PublicKey::new([1u8; 32])),
                ConfiguredWitness::dependent(PublicKey::new([2u8; 32])),
                ConfiguredWitness::dependent(PublicKey::new([3u8; 32])),
            ],
            2,
        )
        .unwrap()
    }

    #[test]
    fn a_set_run_entirely_by_the_log_operator_is_not_independently_witnessed() {
        // The shipped configuration, and the whole point of the type: three of
        // three cosigned, the threshold is met, and the anti-equivocation
        // property is still absent.
        let standing = WitnessStanding::unmet(&set());
        assert_eq!(standing.independent(), 0);
        assert!(!standing.is_independently_witnessed());
        assert_eq!(standing.configured(), 3);
        assert_eq!(standing.threshold(), 2);
    }

    #[test]
    fn an_unmet_threshold_reports_no_partial_count() {
        let standing = WitnessStanding::unmet(&set());
        assert_eq!(standing.counted_including_dependent(), 0);
        assert!(!standing.threshold_met());
    }
}
