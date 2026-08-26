//! Self-audit — `KT.md` §8.2, *"the check that makes the point of the whole
//! system"*.
//!
//! Every client monitors **its own** handle every epoch and raises a loud,
//! non-dismissible alarm on any key change it did not initiate. That is what
//! makes an attempted MITM detectable by the victim, and
//! `ARCHITECTURE.md` §9.2 is explicit that it is the only thing that does.
//!
//! # Why it keeps running when the threshold is unmet
//!
//! §8.3's table gives self-audit its own row: **continues, and reports**.
//!
//! > A client must keep looking at its own history even when it cannot
//! > establish the root, because a substitution it can see is worth more than
//! > one it cannot.
//!
//! That is a weaker check and it is reported as one.
//! [`SelfAuditReport::root_witnessed`] says which of the two ran:
//!
//! | | root witnessed | root not witnessed |
//! |---|---|---|
//! | the versions shown are in the tree | proved by `key_history_verify` | **not checked** |
//! | the versions shown are *all* of them | checked | checked |
//! | the `prev_entry_hash` chain holds | checked | checked |
//! | an entry this device did not submit | detected | detected |
//!
//! The unwitnessed column runs `f2z_kt_core::verify::check_entry_chain` — the
//! **same** function the witnessed column runs, because
//! `key_history_verify` proves inclusion and the chain check proves
//! completeness, and only the first of the two needs a root.

use f2z_codec::types::Digest;
use f2z_kt_core::entry::DirectoryEntry;
use f2z_kt_core::types::Handle;

use crate::alarm::Alarm;
use crate::standing::WitnessStanding;

/// An entry in the user's own history that this device did not submit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnexpectedEntry {
    pub(crate) entry: DirectoryEntry,
    pub(crate) chain_hash: Digest,
}

impl UnexpectedEntry {
    /// The entry.
    #[must_use]
    pub const fn entry(&self) -> &DirectoryEntry {
        &self.entry
    }

    /// `H("free2z/kt/v1/prev", …)` of the entry — the identifier a device
    /// records when it submits, and the one this check matches against.
    #[must_use]
    pub const fn chain_hash(&self) -> &Digest {
        &self.chain_hash
    }

    /// `entry_version` (§4.2).
    #[must_use]
    pub const fn entry_version(&self) -> u32 {
        self.entry.entry.entry_version
    }
}

/// What one pass of §8.2 found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelfAuditReport {
    pub(crate) handle: Handle,
    pub(crate) epoch: u64,
    pub(crate) root_witnessed: bool,
    pub(crate) standing: WitnessStanding,
    pub(crate) chain_intact: bool,
    pub(crate) versions_seen: usize,
    pub(crate) unexpected: Vec<UnexpectedEntry>,
    pub(crate) alarms: Vec<Alarm>,
}

impl SelfAuditReport {
    /// The handle audited.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        &self.handle
    }

    /// The epoch of the tree head the history was served against.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Whether the root met §8.3's threshold, and therefore whether the
    /// **inclusion** half of the audit ran at all.
    ///
    /// `false` does not mean the audit failed. It means the audit was the
    /// weaker of the two in the table above, and a caller must not report
    /// "history verified" on the strength of it.
    #[must_use]
    pub const fn root_witnessed(&self) -> bool {
        self.root_witnessed
    }

    /// What the client's own witness set established.
    #[must_use]
    pub const fn standing(&self) -> WitnessStanding {
        self.standing
    }

    /// Whether the `entry_version` sequence and the `prev_entry_hash` chain are
    /// unbroken from the client's pin (§8.2 step 4).
    ///
    /// This is `chainIntact` in `CLIENT-CONTRACT.md` §3.10's `SelfAuditState`.
    #[must_use]
    pub const fn chain_intact(&self) -> bool {
        self.chain_intact
    }

    /// How many versions the log returned.
    #[must_use]
    pub const fn versions_seen(&self) -> usize {
        self.versions_seen
    }

    /// Every entry this device did not submit — §3.10's `unexpectedEntries`.
    #[must_use]
    pub fn unexpected(&self) -> &[UnexpectedEntry] {
        &self.unexpected
    }

    /// The alarms this pass raised. They are also in the client's
    /// [`crate::AlarmLog`]; this is the subset attributable to this pass.
    #[must_use]
    pub fn alarms(&self) -> &[Alarm] {
        &self.alarms
    }

    /// Whether this pass found anything that needs a human.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.chain_intact && self.unexpected.is_empty()
    }
}
