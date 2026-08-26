//! Alarms — loud, non-dismissible, and typed so a dismissible one cannot be
//! written.
//!
//! `ARCHITECTURE.md` §9.2 and `KT.md` §8.2 require a client to raise a **loud,
//! non-dismissible alarm on any key change it did not initiate**, and
//! `CLIENT-CONTRACT.md` §9 rule 4 spells out what that forbids on the other
//! side of the boundary: never a toast, never an auto-dismiss, and
//! `Alarm.dismissible` typed `false` so that a component which hides one cannot
//! be written against the type.
//!
//! This module is that rule in Rust. [`Alarm::dismissible`] is a `const fn`
//! returning `false` — there is no field, so there is no value to set — and
//! [`Alarm::acknowledge`] records that a human saw it **without removing it**
//! from anything.
//!
//! # Acknowledging is not dismissing
//!
//! An acknowledged alarm stays in [`AlarmLog::alarms`] with
//! [`Alarm::acknowledged_at_ms`] set. `CLIENT-CONTRACT.md` §3.10: *"the alarm
//! stays in `list_alarms` with `acknowledgedAt` set, remains visible in the
//! conversation"*. There is deliberately no `remove`, no `clear` and no
//! `retain` on [`AlarmLog`].

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::Handle;

/// What was found. The wire names are `CLIENT-CONTRACT.md` §3.10's `AlarmKind`
/// union, so a frontend can switch on the same strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum AlarmKind {
    /// The identity key published for a handle changed (ADR 0014 case 2 or 3).
    /// `CLIENT-CONTRACT.md` §9 rule 4.
    IdentityKeyChanged,
    /// The change was made by the platform, **without the user's old key**
    /// (ADR 0014 case 3). §8.2 step 5 requires stating that explicitly rather
    /// than letting it read as an ordinary rotation.
    PlatformReset,
    /// §8.2 step 5 — an entry in the user's own history that this device did
    /// not submit.
    SelfAuditUnexpectedEntry,
    /// §8.3 — fewer than *t* of the client's own witnesses cosigned, at a
    /// moment where the client had to refuse.
    WitnessThresholdUnmet,
    /// §6.3 — monotonicity failed. **Fatal, and provable to a third party**:
    /// the two signed tree heads are the complete evidence (§8.4).
    DirectoryForkEvidence,
    /// §8.1's correction — the log asserts a handle this client holds a pin for
    /// is not registered.
    ///
    /// # This kind has no counterpart in `CLIENT-CONTRACT.md` §3.10, and it
    /// needs one
    ///
    /// §3.10's `AlarmKind` union predates the 2026-08-24 correction and has no
    /// member for it, while the correction itself is unambiguous that the case
    /// *"raises an alarm and fails closed"*. None of the existing members is
    /// honest about it: `directory-fork-evidence` is named for evidence, and
    /// the whole point of this case is that there **is** no evidence — the log
    /// signs tree heads, not lookup responses, so an absent answer is not a
    /// signed statement and cannot be published the way §7.3's reports can.
    ///
    /// The string is `handle-absent-contradicts-pin`. Reported rather than
    /// papered over; see this crate's pull request.
    HandleAbsentContradictsPin,
}

impl AlarmKind {
    /// Every kind, so a test can assert the mapping below is total.
    pub const ALL: [Self; 6] = [
        Self::IdentityKeyChanged,
        Self::PlatformReset,
        Self::SelfAuditUnexpectedEntry,
        Self::WitnessThresholdUnmet,
        Self::DirectoryForkEvidence,
        Self::HandleAbsentContradictsPin,
    ];

    /// The `CLIENT-CONTRACT.md` §3.10 string.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::IdentityKeyChanged => "identity-key-changed",
            Self::PlatformReset => "platform-reset",
            Self::SelfAuditUnexpectedEntry => "self-audit-unexpected-entry",
            Self::WitnessThresholdUnmet => "witness-threshold-unmet",
            Self::DirectoryForkEvidence => "directory-fork-evidence",
            Self::HandleAbsentContradictsPin => "handle-absent-contradicts-pin",
        }
    }

    /// `critical` or `warning`, per §3.10.
    ///
    /// Everything a client raises about a *key* is critical, because the thing
    /// on the other side of the decision is who a message is encrypted to.
    #[must_use]
    pub const fn severity(self) -> Severity {
        match self {
            Self::IdentityKeyChanged
            | Self::PlatformReset
            | Self::SelfAuditUnexpectedEntry
            | Self::DirectoryForkEvidence
            | Self::HandleAbsentContradictsPin => Severity::Critical,
            // A witness outage is not a key substitution. It refuses an
            // operation and it must be surfaced, and calling it critical
            // alongside "somebody changed your key" would flatten the
            // difference a user needs to see.
            Self::WitnessThresholdUnmet => Severity::Warning,
        }
    }

    /// Whether a third party can be shown the evidence for this.
    ///
    /// **False for [`AlarmKind::HandleAbsentContradictsPin`]**, and that is the
    /// point of having the method at all. §8.1's correction: *"It must also be
    /// told plainly what it has: a contradiction it cannot prove to anyone."*
    /// A UI that offered a "report this" button on that alarm would be
    /// promising a report nobody can act on.
    #[must_use]
    pub const fn is_provable_to_a_third_party(self) -> bool {
        matches!(self, Self::DirectoryForkEvidence)
    }
}

/// §3.10's two severities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    /// Something about a key. Blocks.
    Critical,
    /// Something about the directory's health. Surfaced, does not block an
    /// established conversation (§8.3's table).
    Warning,
}

impl Severity {
    /// The §3.10 string.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::Warning => "warning",
        }
    }
}

/// One raised alarm.
///
/// A derived `Debug` would render `old`/`new` as decimal byte dumps; the
/// workspace scan forbids that and [`PublicKey`]'s own redacting `Debug` is
/// what makes deriving safe here. The handle is deliberately *not* redacted —
/// it is the one field a user has to read, its charset admits no control
/// characters, and it is public by construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alarm {
    id: u64,
    kind: AlarmKind,
    raised_at_ms: u64,
    handle: Option<Handle>,
    old_fingerprint: Option<PublicKey>,
    new_fingerprint: Option<PublicKey>,
    platform_assisted: bool,
    acknowledged_at_ms: Option<u64>,
}

impl Alarm {
    /// A stable identifier, unique within one [`AlarmLog`].
    #[must_use]
    pub const fn id(&self) -> u64 {
        self.id
    }

    /// What was found.
    #[must_use]
    pub const fn kind(&self) -> AlarmKind {
        self.kind
    }

    /// `critical` or `warning`.
    #[must_use]
    pub const fn severity(&self) -> Severity {
        self.kind.severity()
    }

    /// When it was raised, from the caller's clock.
    #[must_use]
    pub const fn raised_at_ms(&self) -> u64 {
        self.raised_at_ms
    }

    /// The handle it is about, where there is one.
    #[must_use]
    pub const fn handle(&self) -> Option<&Handle> {
        self.handle.as_ref()
    }

    /// The identity key that was in force before, where the alarm is about a
    /// change. §8.2 step 5 requires **both** fingerprints to be named.
    #[must_use]
    pub const fn old_fingerprint(&self) -> Option<&PublicKey> {
        self.old_fingerprint.as_ref()
    }

    /// The identity key in force now.
    #[must_use]
    pub const fn new_fingerprint(&self) -> Option<&PublicKey> {
        self.new_fingerprint.as_ref()
    }

    /// Whether the change was a `platform_reset` — made by the platform without
    /// the user's old key (ADR 0014 case 3).
    ///
    /// §8.2 step 5 requires saying so *explicitly*, so this is a separate
    /// question from the kind: a caller rendering
    /// [`AlarmKind::IdentityKeyChanged`] must still read this before choosing
    /// its words.
    #[must_use]
    pub const fn platform_assisted(&self) -> bool {
        self.platform_assisted
    }

    /// When a human acknowledged it, if one has.
    #[must_use]
    pub const fn acknowledged_at_ms(&self) -> Option<u64> {
        self.acknowledged_at_ms
    }

    /// **Always `false`.**
    ///
    /// There is no field behind this and there must never be one.
    /// `CLIENT-CONTRACT.md` §9 rule 4 requires the key-change alarm to be
    /// non-dismissible and types it `false` on the TypeScript side so a
    /// dismissible component cannot be written; this is the same statement on
    /// this side of the boundary.
    #[must_use]
    pub const fn dismissible(&self) -> bool {
        false
    }

    /// Whether the evidence for this alarm can be handed to somebody else.
    #[must_use]
    pub const fn is_provable_to_a_third_party(&self) -> bool {
        self.kind.is_provable_to_a_third_party()
    }
}

/// Every alarm this client has raised.
///
/// **There is no way to remove one.** Not a `remove`, not a `clear`, not a
/// `retain`, and not a capacity bound that would drop the oldest: an alarm log
/// that forgets is a log that can be made to forget.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AlarmLog {
    alarms: Vec<Alarm>,
    next_id: u64,
}

impl AlarmLog {
    /// An empty log.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            alarms: Vec::new(),
            next_id: 1,
        }
    }

    /// Every alarm, oldest first, acknowledged ones included.
    #[must_use]
    pub fn alarms(&self) -> &[Alarm] {
        &self.alarms
    }

    /// Every alarm nobody has acknowledged yet.
    pub fn unacknowledged(&self) -> impl Iterator<Item = &Alarm> {
        self.alarms
            .iter()
            .filter(|alarm| alarm.acknowledged_at_ms.is_none())
    }

    /// Whether any critical alarm is outstanding.
    #[must_use]
    pub fn has_outstanding_critical(&self) -> bool {
        self.unacknowledged()
            .any(|alarm| alarm.severity() == Severity::Critical)
    }

    /// Record that a human saw an alarm. **This does not hide it.**
    ///
    /// Returns `false` for an id this log does not hold.
    pub fn acknowledge(&mut self, id: u64, now_ms: u64) -> bool {
        for alarm in &mut self.alarms {
            if alarm.id == id {
                alarm.acknowledged_at_ms = Some(now_ms);
                return true;
            }
        }
        false
    }

    /// Raise one, returning its id — or the id of the outstanding alarm that
    /// already says this, if there is one.
    ///
    /// # Why this coalesces, and exactly how far
    ///
    /// Nothing removes an alarm, which is the property this module exists for
    /// and is not negotiable. Left at that, a client polling a directory whose
    /// witnesses are unreachable raises one
    /// [`AlarmKind::WitnessThresholdUnmet`] per epoch, forever, and the log
    /// grows without bound on an ordinary network outage. That is a real
    /// defect and it is also self-defeating: an alarm list with nine thousand
    /// identical rows in it hides the one row that matters as effectively as
    /// deleting it would.
    ///
    /// So a repeat coalesces onto the alarm already standing, on the key
    /// `(kind, handle, new_fingerprint)` — and **only** while that one is
    /// unacknowledged. Two consequences, both deliberate:
    ///
    /// - Two *different* findings never merge. A second unexpected entry for
    ///   one handle carries a different `new_fingerprint` and gets its own
    ///   alarm, because it is a different thing that happened.
    /// - **Acknowledging does not silence the next one.** Once a human has
    ///   seen an alarm, the same condition arising again raises a fresh one
    ///   with a fresh timestamp, rather than being absorbed into a row already
    ///   marked as read. Coalescing onto an acknowledged alarm would be a way
    ///   to make an alarm disappear, which is what this module forbids.
    pub(crate) fn raise(&mut self, alarm: RaiseAlarm) -> u64 {
        if let Some(existing) = self.alarms.iter().find(|existing| {
            existing.acknowledged_at_ms.is_none()
                && existing.kind == alarm.kind
                && existing.handle == alarm.handle
                && existing.new_fingerprint == alarm.new_fingerprint
        }) {
            return existing.id;
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.alarms.push(Alarm {
            id,
            kind: alarm.kind,
            raised_at_ms: alarm.now_ms,
            handle: alarm.handle,
            old_fingerprint: alarm.old_fingerprint,
            new_fingerprint: alarm.new_fingerprint,
            platform_assisted: alarm.platform_assisted,
            acknowledged_at_ms: None,
        });
        id
    }
}

/// What [`AlarmLog::raise`] needs. Internal: an alarm is raised by this crate's
/// own rules and never by a caller deciding to.
pub(crate) struct RaiseAlarm {
    pub(crate) kind: AlarmKind,
    pub(crate) now_ms: u64,
    pub(crate) handle: Option<Handle>,
    pub(crate) old_fingerprint: Option<PublicKey>,
    pub(crate) new_fingerprint: Option<PublicKey>,
    pub(crate) platform_assisted: bool,
}

impl RaiseAlarm {
    pub(crate) const fn of(kind: AlarmKind, now_ms: u64) -> Self {
        Self {
            kind,
            now_ms,
            handle: None,
            old_fingerprint: None,
            new_fingerprint: None,
            platform_assisted: false,
        }
    }

    pub(crate) fn about(mut self, handle: &Handle) -> Self {
        self.handle = Some(handle.clone());
        self
    }

    pub(crate) const fn keys(mut self, old: PublicKey, new: PublicKey) -> Self {
        self.old_fingerprint = Some(old);
        self.new_fingerprint = Some(new);
        self
    }

    pub(crate) const fn platform_assisted(mut self, value: bool) -> Self {
        self.platform_assisted = value;
        self
    }
}

#[cfg(test)]
mod tests {
    use f2z_codec::types::PublicKey;
    use f2z_kt_core::types::Handle;

    use super::{AlarmKind, AlarmLog, RaiseAlarm, Severity};

    #[test]
    fn no_alarm_is_dismissible_and_acknowledging_does_not_hide_one() {
        let mut log = AlarmLog::new();
        let id = log.raise(RaiseAlarm::of(AlarmKind::IdentityKeyChanged, 10));
        assert!(!log.alarms()[0].dismissible());
        assert!(log.has_outstanding_critical());

        assert!(log.acknowledge(id, 20));
        assert_eq!(log.alarms().len(), 1, "an acknowledged alarm is still here");
        assert_eq!(log.alarms()[0].acknowledged_at_ms(), Some(20));
        assert!(!log.alarms()[0].dismissible());
        assert!(!log.has_outstanding_critical());
    }

    #[test]
    fn only_a_fork_is_claimed_to_be_provable_to_a_third_party() {
        for kind in AlarmKind::ALL {
            assert_eq!(
                kind.is_provable_to_a_third_party(),
                kind == AlarmKind::DirectoryForkEvidence,
                "{}: the log signs tree heads, not lookup responses",
                kind.name()
            );
        }
    }

    #[test]
    fn a_repeated_condition_coalesces_onto_the_alarm_already_standing() {
        // The failure this prevents: a directory whose witnesses are
        // unreachable raises one alarm per poll, forever, and an alarm list
        // with nine thousand identical rows hides the one that matters as
        // effectively as deleting it would.
        let mut log = AlarmLog::new();
        let first = log.raise(RaiseAlarm::of(AlarmKind::WitnessThresholdUnmet, 10));
        for tick in 11..1_000 {
            assert_eq!(
                log.raise(RaiseAlarm::of(AlarmKind::WitnessThresholdUnmet, tick)),
                first
            );
        }
        assert_eq!(log.alarms().len(), 1);
        assert_eq!(log.alarms()[0].raised_at_ms(), 10, "the first sighting");
    }

    #[test]
    fn acknowledging_does_not_silence_the_next_one() {
        // Coalescing onto an ACKNOWLEDGED alarm would be a way to make an alarm
        // disappear, which is the one thing this module exists to forbid.
        let mut log = AlarmLog::new();
        let first = log.raise(RaiseAlarm::of(AlarmKind::WitnessThresholdUnmet, 10));
        assert!(log.acknowledge(first, 20));
        let second = log.raise(RaiseAlarm::of(AlarmKind::WitnessThresholdUnmet, 30));
        assert_ne!(second, first);
        assert_eq!(log.alarms().len(), 2);
        assert_eq!(log.alarms()[1].raised_at_ms(), 30);
    }

    #[test]
    fn two_different_findings_never_merge() {
        let mut log = AlarmLog::new();
        let handle = Handle::new(b"alice".to_vec()).unwrap();
        let one = log.raise(
            RaiseAlarm::of(AlarmKind::SelfAuditUnexpectedEntry, 10)
                .about(&handle)
                .keys(PublicKey::new([1u8; 32]), PublicKey::new([2u8; 32])),
        );
        // A second unexpected entry for the same handle: a different thing
        // happened, so it gets its own alarm even though the kind matches.
        let two = log.raise(
            RaiseAlarm::of(AlarmKind::SelfAuditUnexpectedEntry, 11)
                .about(&handle)
                .keys(PublicKey::new([1u8; 32]), PublicKey::new([3u8; 32])),
        );
        assert_ne!(one, two);
        assert_eq!(log.alarms().len(), 2);
    }

    #[test]
    fn every_kind_has_a_client_contract_name_and_a_severity() {
        let mut names: Vec<&str> = AlarmKind::ALL.iter().map(|kind| kind.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), AlarmKind::ALL.len(), "names must be distinct");
        assert_eq!(
            AlarmKind::WitnessThresholdUnmet.severity(),
            Severity::Warning
        );
        assert_eq!(
            AlarmKind::HandleAbsentContradictsPin.severity(),
            Severity::Critical
        );
    }
}
