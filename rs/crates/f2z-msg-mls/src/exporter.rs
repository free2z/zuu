//! The `ARCHITECTURE.md` §5.4 exporter labels, as a closed set.
//!
//! RFC 9420 §8.5's `MLS-Exporter(Label, Context, Length)` yields forward-secret,
//! epoch-bound key material bound to the exact membership of the epoch. §5.4
//! hands four consumers their key material this way rather than inventing a
//! derivation per consumer, and this module is that table in code:
//!
//! | Consumer | Label | Context |
//! |---|---|---|
//! | FROST/DKG (§11) | `free2z/frost/v1` | `ceremony_id` |
//! | WebRTC binding (§10) | `free2z/webrtc/v1` | `session_id` |
//! | Queue rotation (§6.2) | `free2z/queue/v1` | reserved; not shipping |
//! | Local history wrap | `free2z/history/v1` | `conversation_id` |
//!
//! # Why an enum and not four `&str` constants
//!
//! Because a caller who can pass an arbitrary string can pass another
//! component's label, and the *whole* value of exporter-derived secrets is that
//! two components cannot end up with the same key material. A closed enum makes
//! the FROST label unreachable from the WebRTC code path without an edit that
//! shows up in review.
//!
//! # On prefix-freeness
//!
//! These four are swept up by `scripts/check-hash-domain-labels.mjs` along with
//! every other `free2z/` label in the tree, and they are prefix-free within the
//! set. They are **not** arguments to `WIRE.md` §1.3's `H(label, x)` — MLS's
//! exporter frames its own label, so the property is not load-bearing for these
//! four today. The checker's own note says the same thing and includes them
//! anyway, for the reason that matters: the set of constructions a label gets
//! reused in only ever grows, and a check that holds a subset of the namespace
//! is how [#602](https://github.com/free2z/zuu/issues/602) happened.
//!
//! # What §5.4's correction changed, and did not
//!
//! An earlier revision of §5.4 said the queue exporter "derives the next queue
//! addresses without a round trip". [ADR 0009][adr9] has the **relay** generate
//! both addresses from its own CSPRNG, because client-chosen addresses permit
//! squatting and collisions. Queue capability signing keys are endpoint-owned
//! and independently generated or derived; they are not shared exporter output.
//! The authenticated advert carries relay/address/rotation intent, never a
//! private key. `free2z/queue/v1` remains reserved for a future synchronized
//! schedule, but no durable counter or advert field synchronizes such an
//! exporter schedule in v1 and the shipping queue path does not call it.
//! Keeping the enum member reserves the domain; it does not claim the schedule
//! exists.
//!
//! [adr9]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0009-queue-addressing-and-binding.md

/// A consumer entitled to exporter-derived key material, per §5.4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum ExportLabel {
    /// FROST/DKG (§11). Context: `ceremony_id`. Session domain separator,
    /// transcript binding, and the outer AEAD for part-2 shares.
    Frost,
    /// WebRTC binding (§10). Context: `session_id`. Binds DTLS fingerprints to
    /// the group.
    Webrtc,
    /// Queue rotation (§6.2), reserved for a future synchronized schedule.
    /// Neither a context format nor a shipping use is defined in v1; see the
    /// module note.
    Queue,
    /// Local history wrap. Context: `conversation_id`. The at-rest key for
    /// retained plaintext.
    History,
}

impl ExportLabel {
    /// Every label, for the tests that hold the set's properties.
    pub const ALL: &'static [Self] = &[Self::Frost, Self::Webrtc, Self::Queue, Self::History];

    /// The exact string handed to `MLS-Exporter`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Frost => "free2z/frost/v1",
            Self::Webrtc => "free2z/webrtc/v1",
            Self::Queue => "free2z/queue/v1",
            Self::History => "free2z/history/v1",
        }
    }
}

impl core::fmt::Display for ExportLabel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_labels_are_exactly_the_ones_in_the_specification() {
        let labels: Vec<&str> = ExportLabel::ALL.iter().map(|l| l.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "free2z/frost/v1",
                "free2z/webrtc/v1",
                "free2z/queue/v1",
                "free2z/history/v1",
            ]
        );
    }

    /// Not load-bearing for MLS's exporter, which frames its own label — see the
    /// module note. Asserted anyway, because the tree-wide checker asserts it
    /// too and a local test says *why* when it fails.
    #[test]
    fn no_label_is_a_prefix_of_another() {
        for a in ExportLabel::ALL {
            for b in ExportLabel::ALL {
                if a == b {
                    continue;
                }
                assert!(
                    !b.as_str().starts_with(a.as_str()),
                    "{a} is a prefix of {b}"
                );
            }
        }
    }

    #[test]
    fn every_label_is_distinct() {
        for (i, a) in ExportLabel::ALL.iter().enumerate() {
            for (j, b) in ExportLabel::ALL.iter().enumerate() {
                assert_eq!(i == j, a.as_str() == b.as_str());
            }
        }
    }
}
