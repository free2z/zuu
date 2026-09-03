//! `KtClient` — `KT.md` §8.1's verification and pinning steps, in order, with
//! no way to skip one. Device selection is exposed on the verified result so
//! callers apply §8.1 step 9 without reimplementing its policy.
//!
//! # The order is the security property
//!
//! §8.1 is a numbered list and the numbers matter:
//!
//! 1. fetch;
//! 2. **§6.3's monotonicity checks against the pinned view — any failure is
//!    fatal and is fork evidence**;
//! 3. **§8.3's threshold rule**;
//! 4. recompute the value from the returned entry bytes, never from a value the
//!    log asserts;
//! 5. `lookup_verify` against the root and VRF key **from the verified tree
//!    head**;
//! 6. the entry's own §4.4 authorization — which at version 1 establishes
//!    nothing;
//! 7. §4.6's signed authority policy;
//! 8. pin.
//!
//! Steps 3 through 5 cannot be reordered here even by mistake, because
//! `f2z-kt-core` makes the argument to each the output of the one before:
//! `verify_lookup` takes an [`AcceptedRoot`], and only
//! [`f2z_kt_core::verify_threshold`] constructs one. What this module adds is
//! steps 1, 2, 6, 7 and 8, and the state that makes step 2 mean anything.
//!
//! # What a client does not do
//!
//! It does not audit. §8.5: *"a client cannot substitute its own consistency
//! check for a witness's"* — `akd`'s `AppendOnlyProof` is O(entries added), 3.9
//! MB for five epochs, and there is no cheap alternative. There is no `audit`
//! method on [`crate::Transport`] and none here.
//!
//! It does not submit. `KT.md` §9.2's `/kt/v1/submit` needs the seed-derived
//! `DirectoryAuthKey`, which belongs to the application that owns the wallet
//! seed and not to a directory client.
//!
//! It does not gossip. §8.4 defines *what* two clients would exchange and is
//! explicit that the protocol which exchanges them *"is not specified here"*.
//! Inventing one would be worse than listing it, so it is listed:
//! [§13-R](https://github.com/free2z/zuu/issues/311).

use f2z_codec::types::PublicKey;
use f2z_kt_core::api::{Presence, TreeHeadBundle};
use f2z_kt_core::entry::EntryKind;
use f2z_kt_core::sth::{LogView, SignedTreeHead};
use f2z_kt_core::submit::{LogPolicy, PublishedEntry, SubmissionContext};
use f2z_kt_core::types::{Handle, LogId};
use f2z_kt_core::{AcceptedRoot, KtError, WitnessSet, verify, verify_threshold};

use crate::alarm::{AlarmKind, AlarmLog, RaiseAlarm};
use crate::audit::{SelfAuditReport, UnexpectedEntry};
use crate::error::{ClientError, Result};
use crate::pin::{HandlePin, PinStore};
use crate::resolve::{
    AbsentAnswer, Authorization, PinOutcome, Resolution, ResolvedHandle, Vouching,
};
use crate::standing::WitnessStanding;
use crate::transport::Transport;
use crate::wire;

/// How many tree heads a client will fetch to close a §6.3 rule 7 gap in one
/// call.
///
/// A number rather than "as many as it takes", because each one is a round
/// trip and a client that has been offline for a year would otherwise open
/// tens of thousands of them before answering a single lookup. Beyond it the
/// client fails with [`KtError::EpochGap`] rather than skipping: *a gap
/// accepted on trust is a branch accepted on trust*, so the fallback is a
/// slower catch-up and never a shortcut.
pub const MAX_EPOCH_CATCHUP: u64 = 256;

/// Everything a client must be told, and nothing it may infer.
///
/// There is no `Default`. `KT.md` §12 leaves the default *t* and the shipped
/// witness list open, and a default here would be this crate inventing the
/// answer the specification declines to invent — the same reason
/// [`WitnessSet`] has no `Default` either.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientConfig {
    /// The log's identifier, derived from its **genesis** signing key
    /// (§6.1) — not from its current one, which rotation changes.
    pub log_id: LogId,
    /// The log signing key this client trusts for `log_id`. §6.4's succession
    /// moves it, and only through
    /// [`f2z_kt_core::sth::LogView::accept_log_key_transition`].
    pub accepted_log_pk: PublicKey,
    /// The client's **own** witness set and threshold. A witness list supplied
    /// by the log is a list chosen by the party the witnesses exist to audit
    /// (§8.3), so this never comes from the wire.
    pub witnesses: WitnessSet,
    /// The reset authority key ADR 0014 requires be **pinned in clients**, for
    /// re-running §4.4 rule 7 on a `platform_reset`.
    ///
    /// A reset authority key a client learns from the log is a key the log
    /// chose, which is no authority at all (§9.1). How the pinned copy is
    /// distributed and rotated is `KT.md` §12's open gap; this crate takes it
    /// as a parameter and does not answer it.
    pub reset_authority_pk: PublicKey,
    /// The reset cooldown the client holds the log to (ADR 0014), in seconds.
    pub reset_cooldown_seconds: u32,
}

/// A key-transparency client for one log.
///
/// Holds the two pieces of state that make §8.1 step 2 and step 8 mean
/// anything: the pinned [`LogView`], and the [`PinStore`]. Both are readable
/// for persistence and neither is settable except through a constructor, so a
/// caller cannot rewind either by assignment.
pub struct KtClient<T> {
    transport: T,
    config: ClientConfig,
    view: LogView,
    pins: PinStore,
    alarms: AlarmLog,
    vouching: Vouching,
}

/// Hand-written: `T` is not required to be `Debug`, and the state worth
/// printing is a handful of scalars rather than a transport.
impl<T> core::fmt::Debug for KtClient<T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("KtClient")
            .field("epoch", &self.view.epoch())
            .field("tree_size", &self.view.tree_size())
            .field("pins", &self.pins.pins().len())
            .field("alarms", &self.alarms.alarms().len())
            .field("vouching", &self.vouching)
            .finish_non_exhaustive()
    }
}

impl<T: Transport> KtClient<T> {
    /// Fetch the log's latest tree head and pin it. **Trust on first use, and
    /// nothing more.**
    ///
    /// The first head cannot be checked against anything — §6.3's rules are all
    /// relative — so what this establishes is a starting point, not a fact. It
    /// is [`f2z_kt_core::sth::LogView::pin`]'s own caveat and it is repeated
    /// here because this is the function an integrator calls.
    ///
    /// A client that has run before must use [`KtClient::resume`] instead. A
    /// bootstrap on every start would discard exactly the history that makes a
    /// rollback detectable.
    ///
    /// # Errors
    ///
    /// [`ClientError::Unreachable`] if the log did not answer, or
    /// [`ClientError::Protocol`] if the bundle does not decode or the head's
    /// signature does not verify under `config.accepted_log_pk`.
    pub fn bootstrap(transport: T, config: ClientConfig) -> Result<Self> {
        let bundle = wire::decode_bundle(&transport.latest_sth()?)?;
        let view = LogView::pin(config.log_id, config.accepted_log_pk, &bundle.head)?;
        Ok(Self {
            transport,
            config,
            view,
            pins: PinStore::new(),
            alarms: AlarmLog::new(),
            vouching: Vouching::Unknown,
        })
    }

    /// Resume from persisted state.
    #[must_use]
    pub const fn resume(
        transport: T,
        config: ClientConfig,
        view: LogView,
        pins: PinStore,
        alarms: AlarmLog,
    ) -> Self {
        Self {
            transport,
            config,
            view,
            pins,
            alarms,
            vouching: Vouching::Unknown,
        }
    }

    /// The pinned view of the log — persist this.
    #[must_use]
    pub const fn view(&self) -> &LogView {
        &self.view
    }

    /// The pins — persist these.
    #[must_use]
    pub const fn pins(&self) -> &PinStore {
        &self.pins
    }

    /// Every alarm raised, acknowledged or not. Persist these too: an alarm
    /// that a restart clears is an alarm an attacker can clear.
    #[must_use]
    pub const fn alarms(&self) -> &AlarmLog {
        &self.alarms
    }

    /// Record that a human saw an alarm. **This does not hide it.**
    pub fn acknowledge_alarm(&mut self, id: u64, now_ms: u64) -> bool {
        self.alarms.acknowledge(id, now_ms)
    }

    /// What §4.6's policy says about handle vouching, as far as this client
    /// knows.
    #[must_use]
    pub const fn vouching(&self) -> Vouching {
        self.vouching
    }

    /// The transport, for a caller that owns it.
    #[must_use]
    pub const fn transport(&self) -> &T {
        &self.transport
    }

    // -----------------------------------------------------------------------
    // §8.1
    // -----------------------------------------------------------------------

    /// Fetch the latest tree head, apply §6.3 and §8.3, and return the root.
    ///
    /// A client calls this once an epoch. It is also what [`KtClient::resolve`]
    /// does implicitly with the bundle carried inside a lookup response, so a
    /// caller that only resolves is not skipping it.
    ///
    /// # Errors
    ///
    /// [`ClientError::WitnessThresholdUnmet`] when §8.3's threshold is not met.
    /// Anything for which [`ClientError::is_fork_evidence`] holds has also
    /// raised a non-dismissible [`AlarmKind::DirectoryForkEvidence`].
    pub fn sync(&mut self, now_ms: u64) -> Result<AcceptedRoot> {
        let bundle = wire::decode_bundle(&self.transport.latest_sth()?)?;
        self.accept_bundle(&bundle, now_ms)
    }

    /// §8.1 step 7 — fetch §4.6's signed policy and verify it under the log key
    /// this client has already accepted.
    ///
    /// Cached after the first success: the document is signed once at startup
    /// by the log and its only time-varying field is `published_at_ms`.
    ///
    /// # Errors
    ///
    /// [`ClientError::Unreachable`], or [`ClientError::Protocol`] if the policy
    /// does not decode, is for another log, or its signature does not verify.
    /// **A failure here leaves [`KtClient::vouching`] at [`Vouching::Unknown`],
    /// which every caller treats as at least as loud as [`Vouching::Unvouched`]
    /// — an unanswered question about who may claim a handle is not a
    /// reassuring answer.**
    pub fn refresh_authority_policy(&mut self) -> Result<Vouching> {
        let policy = wire::decode_authority_policy(&self.transport.authority_policy()?)?;
        policy.verify(&self.config.log_id, self.view.accepted_log_pk())?;
        self.vouching = if policy.policy.vouches() {
            Vouching::Claimed
        } else {
            Vouching::Unvouched
        };
        Ok(self.vouching)
    }

    /// §8.1 — resolve a handle.
    ///
    /// # What this refuses, and why refusing is the feature
    ///
    /// §8.3's table, first row: resolving a **new** handle with the threshold
    /// unmet is **refused**. *"This is the
    /// [#133](https://github.com/free2z/zuu/issues/133) moment; an unverified
    /// key here is the MITM."* An established conversation over already-pinned
    /// keys continues — nothing about a witness outage retroactively unverifies
    /// a key that was verified when it was pinned — but that is a decision for
    /// the layer holding the conversation, not for a lookup.
    ///
    /// # Errors
    ///
    /// - [`ClientError::WitnessThresholdUnmet`] — §8.3, fail closed.
    /// - [`ClientError::PinContradiction`] — the log asserts a **pinned** handle
    ///   does not exist. The pin stands, an alarm is raised, and the caller is
    ///   told plainly that this is not provable to anyone.
    /// - [`ClientError::PinConflict`] — the identity key changed, or the entry
    ///   chain moved in a way this client cannot accept without
    ///   [`KtClient::accept_key_change`]. The pin is **not** overwritten.
    /// - [`ClientError::Protocol`] — a proof, a signature or §6.3 failed.
    pub fn resolve(&mut self, handle: &Handle, now_ms: u64) -> Result<Resolution> {
        let request = wire::lookup_request(handle)?;
        let response = wire::decode_lookup(&self.transport.lookup(&request)?)?;
        // Step 2, before anything is read out of the body. A response standing
        // on a head that fails §6.3 is not an answer, it is evidence.
        self.advance_to(&response.bundle.head, now_ms)?;

        let presence = Presence::from_code(response.presence).map_err(ClientError::from)?;
        if presence == Presence::AbsentUnproved {
            // Deliberately BEFORE the threshold rule. The threshold decides
            // whether an answer may be acted on; this decides whether the
            // client has just been told something that contradicts what it
            // already holds, and that is worth catching under a root the client
            // could not witness as much as under one it could.
            //
            // The cost is stated rather than hidden: a network attacker who can
            // forge a lookup response can raise this alarm. That is acceptable
            // and the alternative is not — an attacker who can suppress the
            // alarm by keeping the witness set unreachable would have found a
            // way to make a pin quietly disappear.
            if let Some(pinned) = self.pins.get(handle) {
                let old = *pinned.identity_pk();
                self.alarms.raise(
                    RaiseAlarm::of(AlarmKind::HandleAbsentContradictsPin, now_ms)
                        .about(handle)
                        .keys(old, old),
                );
                return Err(ClientError::PinContradiction);
            }
        }

        let root = self.witnessed_root(&response.bundle, now_ms)?;
        let standing = WitnessStanding::of(&root, &self.config.witnesses);

        if presence == Presence::AbsentUnproved {
            return Ok(Resolution::AbsentUnproved(AbsentAnswer {
                handle: handle.clone(),
                epoch: root.epoch(),
                standing,
            }));
        }

        // Steps 4 and 5, in `f2z-kt-core`: the value is recomputed from the
        // returned entry bytes under re-encode equality and used as the value in
        // `lookup_verify`, never a value the log asserts.
        let verified = verify::verify_lookup(
            &root,
            handle,
            response.entry.as_slice(),
            response.proof.as_slice(),
        )
        .map_err(|error| self.on_protocol_error(error, now_ms))?;

        let published = verified.published()?;
        let authorization = self.check_authorization(&verified, now_ms)?;
        let pin = self.reconcile_pin(&published, verified.entry(), root.epoch(), now_ms)?;

        Ok(Resolution::Resolved(Box::new(ResolvedHandle {
            handle: handle.clone(),
            entry: verified.entry().clone(),
            epoch: root.epoch(),
            standing,
            authorization,
            vouching: self.vouching,
            pin,
        })))
    }

    /// §8.2 — audit the user's own handle.
    ///
    /// `submitted` is the set of entry chain hashes — `H("free2z/kt/v1/prev",
    /// …)` — that **this device** submitted. Anything in the returned history
    /// that is not in it raises [`AlarmKind::SelfAuditUnexpectedEntry`], which
    /// is §8.2 step 5 and is the check that makes an attempted MITM detectable
    /// by its victim.
    ///
    /// **This does not fail when the witness threshold is unmet.** §8.3's table
    /// gives self-audit its own row — *continues, and reports* — and
    /// [`SelfAuditReport::root_witnessed`] says which of the two checks ran.
    ///
    /// # Errors
    ///
    /// [`ClientError::Unreachable`], or [`ClientError::Protocol`] for a history
    /// that does not decode, does not verify, or is not an unbroken chain. A
    /// broken chain is reported through the error rather than through
    /// [`SelfAuditReport::chain_intact`] when the client could not even decode
    /// what it was shown.
    pub fn self_audit(
        &mut self,
        handle: &Handle,
        submitted: &[f2z_codec::types::Digest],
        now_ms: u64,
    ) -> Result<SelfAuditReport> {
        let request = wire::history_request(handle)?;
        let response = wire::decode_history(&self.transport.history(&request)?)?;
        self.advance_to(&response.bundle.head, now_ms)?;

        let entry_bytes: Vec<&[u8]> = response
            .entries
            .as_slice()
            .iter()
            .map(f2z_codec::types::Payload::as_slice)
            .collect();
        if entry_bytes.is_empty() {
            return Err(ClientError::Protocol(KtError::HistoryIncomplete));
        }

        let pinned = self.pins.get(handle).map(HandlePin::published).cloned();
        let root = self.witnessed_root(&response.bundle, now_ms);

        let (entries, root_witnessed, standing, epoch) = match root {
            Ok(root) => {
                let standing = WitnessStanding::of(&root, &self.config.witnesses);
                let epoch = root.epoch();
                // `wire::history_request` asks for the **complete** history and
                // `verify_key_history` verifies one — §8.2's `Complete` is
                // fixed inside it rather than passed, so this call cannot ask
                // for a weaker proof. The pin is deliberately not handed over
                // as a predecessor: a complete history begins at version 1, and
                // the pin is checked separately below and more strictly than a
                // predecessor argument would have — the entry at the pinned
                // version must be byte-for-byte the one that was pinned.
                let verified = verify::verify_key_history(
                    &root,
                    handle,
                    &entry_bytes,
                    response.proof.as_slice(),
                )
                .map_err(|error| self.on_protocol_error(error, now_ms))?;
                let entries = verified
                    .iter()
                    .map(|entry| entry.entry().clone())
                    .collect::<Vec<_>>();
                (entries, true, standing, epoch)
            }
            Err(ClientError::WitnessThresholdUnmet) => {
                // The weaker pass. `check_entry_chain` is the same function the
                // witnessed pass runs; what is missing is `key_history_verify`,
                // and its absence is reported rather than papered over.
                let mut entries = Vec::with_capacity(entry_bytes.len());
                for bytes in &entry_bytes {
                    let (entry, _) = verify::decode_entry(&self.config.log_id, handle, bytes)?;
                    entries.push(entry);
                }
                verify::check_entry_chain(&entries, None)
                    .map_err(|error| self.on_protocol_error(error, now_ms))?;
                (
                    entries,
                    false,
                    WitnessStanding::unmet(&self.config.witnesses),
                    response.bundle.head.sth.epoch,
                )
            }
            Err(other) => return Err(other),
        };

        // The pin must be *in* what was shown, at the version it was pinned at
        // and with the same bytes. A log that served a truthful-looking complete
        // history which simply does not contain the entry this client already
        // holds has substituted the user's key at the root of their own chain,
        // and the version sequence alone would not notice.
        if let Some(pinned) = pinned.as_ref() {
            Self::require_pin_in_history(&entries, pinned)
                .map_err(|error| self.on_protocol_error(error, now_ms))?;
        }

        let mut unexpected = Vec::new();
        let mut raised = Vec::new();
        for entry in &entries {
            let chain_hash = entry.chain_hash()?;
            if submitted.contains(&chain_hash) {
                continue;
            }
            let platform_assisted = matches!(entry.entry.kind, EntryKind::PlatformReset);
            let kind = if platform_assisted {
                AlarmKind::PlatformReset
            } else {
                AlarmKind::SelfAuditUnexpectedEntry
            };
            // Both fingerprints, per §8.2 step 5. The "old" one is the key this
            // client had pinned, which is the only prior key it can name.
            let old = pinned
                .as_ref()
                .map_or(entry.entry.identity_pk, |previous| *previous.identity_pk());
            let id = self.alarms.raise(
                RaiseAlarm::of(kind, now_ms)
                    .about(handle)
                    .keys(old, entry.entry.identity_pk)
                    .platform_assisted(platform_assisted),
            );
            if let Some(alarm) = self.alarms.alarms().iter().find(|alarm| alarm.id() == id) {
                raised.push(alarm.clone());
            }
            unexpected.push(UnexpectedEntry {
                entry: entry.clone(),
                chain_hash,
            });
        }

        Ok(SelfAuditReport {
            handle: handle.clone(),
            epoch,
            root_witnessed,
            standing,
            // The chain was checked above and any failure returned; reaching
            // here means it held.
            chain_intact: true,
            versions_seen: entries.len(),
            unexpected,
            alarms: raised,
        })
    }

    /// Cross an identity key change for a pinned handle, deliberately.
    ///
    /// §8.3's table: accepting a key change for a handle already pinned is
    /// **refused** when the threshold is unmet, *"and surfaced. The old pin
    /// stays in force."* When it is met, this is what accepts one — and it is a
    /// separate call from [`KtClient::resolve`] on purpose, because a pin that
    /// moved across a key change without a caller asking for it is the silent
    /// overwrite `CLIENT-CONTRACT.md` §9 rule 9 forbids.
    ///
    /// It fetches the handle's **complete history**, verifies it against a
    /// witnessed root, requires an unbroken chain from the pin, re-runs §4.4 on
    /// every entry after the pin, raises the non-dismissible
    /// [`AlarmKind::IdentityKeyChanged`] (or [`AlarmKind::PlatformReset`]), and
    /// only then advances the pin.
    ///
    /// # Errors
    ///
    /// [`ClientError::WitnessThresholdUnmet`], [`ClientError::PinConflict`] if
    /// no pin is held or the history does not move it forward, and
    /// [`ClientError::Protocol`] if the history or any authorization failed.
    pub fn accept_key_change(&mut self, handle: &Handle, now_ms: u64) -> Result<HandlePin> {
        let Some(pinned) = self.pins.get(handle).map(HandlePin::published).cloned() else {
            return Err(ClientError::PinConflict);
        };

        let request = wire::history_request(handle)?;
        let response = wire::decode_history(&self.transport.history(&request)?)?;
        self.advance_to(&response.bundle.head, now_ms)?;
        let root = self.witnessed_root(&response.bundle, now_ms)?;

        let entry_bytes: Vec<&[u8]> = response
            .entries
            .as_slice()
            .iter()
            .map(f2z_codec::types::Payload::as_slice)
            .collect();
        let verified =
            verify::verify_key_history(&root, handle, &entry_bytes, response.proof.as_slice())
                .map_err(|error| self.on_protocol_error(error, now_ms))?;
        let entries: Vec<_> = verified
            .iter()
            .map(|entry| entry.entry().clone())
            .collect::<Vec<_>>();
        Self::require_pin_in_history(&entries, &pinned)
            .map_err(|error| self.on_protocol_error(error, now_ms))?;

        // `akd` serves decreasing version order; walk forwards from the pin.
        let mut previous = pinned;
        let mut newest: Option<HandlePin> = None;
        for entry in verified.iter().rev() {
            if u64::from(entry.entry().entry.entry_version) <= u64::from(previous.entry_version()) {
                continue;
            }
            entry.verify_authorization(&SubmissionContext {
                policy: &self.policy(),
                previous: Some(&previous),
                pending_in_epoch: false,
                now_ms,
            })?;
            if entry.entry().entry.identity_pk != *previous.identity_pk() {
                let platform_assisted =
                    matches!(entry.entry().entry.kind, EntryKind::PlatformReset);
                self.alarms.raise(
                    RaiseAlarm::of(
                        if platform_assisted {
                            AlarmKind::PlatformReset
                        } else {
                            AlarmKind::IdentityKeyChanged
                        },
                        now_ms,
                    )
                    .about(handle)
                    .keys(*previous.identity_pk(), entry.entry().entry.identity_pk)
                    .platform_assisted(platform_assisted),
                );
            }
            previous = entry.published()?;
            newest = Some(HandlePin::new(
                previous.clone(),
                entry.entry().entry.prev_entry_hash,
                entry.epoch(),
            ));
        }

        let Some(next) = newest else {
            return Err(ClientError::PinConflict);
        };
        self.pins.accept_key_change(next.clone())?;
        Ok(next)
    }

    // -----------------------------------------------------------------------
    // Steps that are this crate's rather than `f2z-kt-core`'s.
    // -----------------------------------------------------------------------

    /// §8.1 step 2, plus §6.3 rule 7's *"fetch every intervening tree head and
    /// check the chain link by link"*.
    fn advance_to(&mut self, head: &SignedTreeHead, now_ms: u64) -> Result<()> {
        match self.view.accept(head) {
            Ok(()) => Ok(()),
            Err(KtError::EpochGap) => self.close_gap(head, now_ms),
            Err(error) => Err(self.on_protocol_error(error, now_ms)),
        }
    }

    fn close_gap(&mut self, head: &SignedTreeHead, now_ms: u64) -> Result<()> {
        let from = self.view.epoch().saturating_add(1);
        let to = head.sth.epoch;
        if to < from || to.saturating_sub(from) > MAX_EPOCH_CATCHUP {
            // Fail closed rather than skip. The remedy is more round trips, and
            // a caller that wants them calls again.
            return Err(self.on_protocol_error(KtError::EpochGap, now_ms));
        }
        for epoch in from..to {
            let bundle = wire::decode_bundle(&self.transport.sth_at(epoch)?)?;
            self.view
                .accept(&bundle.head)
                .map_err(|error| self.on_protocol_error(error, now_ms))?;
        }
        self.view
            .accept(head)
            .map_err(|error| self.on_protocol_error(error, now_ms))
    }

    /// §8.1 step 3 — §8.3's threshold, over the client's **own** set.
    fn witnessed_root(&mut self, bundle: &TreeHeadBundle, now_ms: u64) -> Result<AcceptedRoot> {
        match verify_threshold(
            &bundle.head,
            bundle.cosignatures.as_slice(),
            &self.config.witnesses,
            &self.config.log_id,
        ) {
            Ok(root) => Ok(root),
            Err(KtError::ThresholdUnmet) => {
                self.alarms
                    .raise(RaiseAlarm::of(AlarmKind::WitnessThresholdUnmet, now_ms));
                Err(ClientError::WitnessThresholdUnmet)
            }
            Err(error) => Err(self.on_protocol_error(error, now_ms)),
        }
    }

    /// Apply the same bundle handling `resolve` does, for a caller that fetched
    /// the tree head itself.
    fn accept_bundle(&mut self, bundle: &TreeHeadBundle, now_ms: u64) -> Result<AcceptedRoot> {
        self.advance_to(&bundle.head, now_ms)?;
        self.witnessed_root(bundle, now_ms)
    }

    /// §8.1 step 6, and its honest answer at version 1.
    fn check_authorization(
        &mut self,
        verified: &verify::VerifiedEntry,
        now_ms: u64,
    ) -> Result<Authorization> {
        if verified.entry().entry.entry_version == 1 {
            // §4.7's last paragraph: what authorizes a first entry is checked by
            // the log at submission and is not committed to the tree, so a
            // client is served no artefact to check. Running
            // `validate_submission` here would *succeed* and would mean nothing;
            // reporting that it succeeded would be the overclaim §8.1 forbids.
            return Ok(Authorization::FirstEntryUnverifiable);
        }
        let Some(previous) = self
            .pins
            .get(&verified.entry().entry.handle)
            .map(HandlePin::published)
            .cloned()
        else {
            return Ok(Authorization::NoPredecessorHeld);
        };
        if previous.entry_version().saturating_add(1) != verified.entry().entry.entry_version {
            // §4.4 is a rule about an entry and its immediate predecessor. With
            // a gap, the client holds no predecessor for *this* entry.
            return Ok(Authorization::NoPredecessorHeld);
        }
        verified
            .verify_authorization(&SubmissionContext {
                policy: &self.policy(),
                previous: Some(&previous),
                pending_in_epoch: false,
                now_ms,
            })
            .map_err(|error| self.on_protocol_error(error, now_ms))?;
        Ok(Authorization::CheckedAgainstPredecessor)
    }

    /// §8.1 step 8, and `CLIENT-CONTRACT.md` §9 rule 9.
    fn reconcile_pin(
        &mut self,
        published: &PublishedEntry,
        entry: &f2z_kt_core::entry::DirectoryEntry,
        epoch: u64,
        now_ms: u64,
    ) -> Result<PinOutcome> {
        let handle = published.handle().clone();
        let next = HandlePin::new(published.clone(), entry.entry.prev_entry_hash, epoch);

        let Some(existing) = self.pins.get(&handle) else {
            self.pins.establish(next)?;
            return Ok(PinOutcome::Established);
        };

        let pinned_version = existing.entry_version();
        let pinned_identity = *existing.identity_pk();
        let pinned_chain = *existing.chain_hash();
        let version = published.entry_version();

        if version < pinned_version {
            // The directory went backwards for this handle. The pin stands.
            self.alarms.raise(
                RaiseAlarm::of(AlarmKind::DirectoryForkEvidence, now_ms)
                    .about(&handle)
                    .keys(pinned_identity, entry.entry.identity_pk),
            );
            return Err(ClientError::PinConflict);
        }
        if version == pinned_version {
            if published.chain_hash() == &pinned_chain {
                return Ok(PinOutcome::Unchanged);
            }
            // One version, two entries. The log committed to two values for one
            // label, which is what a fork looks like from a client's seat.
            self.alarms.raise(
                RaiseAlarm::of(AlarmKind::DirectoryForkEvidence, now_ms)
                    .about(&handle)
                    .keys(pinned_identity, entry.entry.identity_pk),
            );
            return Err(ClientError::PinConflict);
        }
        if entry.entry.identity_pk != pinned_identity {
            // §8.2 step 5's alarm, raised here because a key change seen through
            // a lookup is exactly as much of a MITM as one seen through a
            // history. The pin is NOT moved: `accept_key_change` is.
            let platform_assisted = matches!(entry.entry.kind, EntryKind::PlatformReset);
            self.alarms.raise(
                RaiseAlarm::of(
                    if platform_assisted {
                        AlarmKind::PlatformReset
                    } else {
                        AlarmKind::IdentityKeyChanged
                    },
                    now_ms,
                )
                .about(&handle)
                .keys(pinned_identity, entry.entry.identity_pk)
                .platform_assisted(platform_assisted),
            );
            return Err(ClientError::PinConflict);
        }
        if version == pinned_version.saturating_add(1)
            && entry.entry.prev_entry_hash == pinned_chain
        {
            self.pins.advance(next)?;
            return Ok(PinOutcome::Advanced);
        }
        Ok(PinOutcome::AheadOfPin)
    }

    /// The pinned entry must appear in a complete history, at its version and
    /// with its bytes.
    ///
    /// `f2z-kt-core`'s chain check proves the run it was shown is internally
    /// consistent and reaches version 1. It cannot know what this client
    /// pinned, so this is the client's own half of §8.2 step 4: a log serving a
    /// perfectly-formed history that replaces the entry the client is holding
    /// would otherwise pass every check above it.
    fn require_pin_in_history(
        entries: &[f2z_kt_core::entry::DirectoryEntry],
        pinned: &PublishedEntry,
    ) -> core::result::Result<(), KtError> {
        for entry in entries {
            if entry.entry.entry_version != pinned.entry_version() {
                continue;
            }
            return if PublishedEntry::from_entry(entry)?.chain_hash() == pinned.chain_hash() {
                Ok(())
            } else {
                Err(KtError::HistoryIncomplete)
            };
        }
        Err(KtError::HistoryIncomplete)
    }

    fn policy(&self) -> LogPolicy {
        LogPolicy::new(
            self.config.log_id,
            self.config.reset_authority_pk,
            self.config.reset_cooldown_seconds,
        )
    }

    /// Raise the fork alarm for the failures that are evidence, and pass
    /// everything else through untouched.
    fn on_protocol_error(&mut self, error: KtError, now_ms: u64) -> ClientError {
        let converted = ClientError::from(error);
        if converted.is_fork_evidence() {
            self.alarms
                .raise(RaiseAlarm::of(AlarmKind::DirectoryForkEvidence, now_ms));
        }
        converted
    }
}
