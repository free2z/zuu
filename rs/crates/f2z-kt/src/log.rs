//! The log itself: the tree, the submission pipeline, the epoch scheduler and
//! the proof generators.
//!
//! # The one invariant this module exists to hold
//!
//! **Nothing reaches `akd::Directory::publish` except through
//! [`crate::admit::AdmittedSubmission`].** [`LogService::submit`] is the only
//! function that adds to the pending batch, it takes bytes and returns a
//! receipt, and the only thing it can put in that batch is what
//! [`crate::admit::admit_submission`] handed back — a type with no public
//! constructor. There is no `publish_raw`, no test hook, no bypass flag, and
//! [`tests/adversarial.rs`] is the test that watches it hold.
//!
//! # Heartbeat epochs — an invention, and the reason for it
//!
//! `KT.md` §5.1 requires an epoch **every interval, whether or not there is
//! anything to publish**, each incrementing `epoch` by exactly 1, with *"an
//! append-only proof over zero insertions"* for an empty one. That rule is
//! load-bearing: without it a witness that sees nothing for six hours cannot
//! distinguish "nobody changed a key" from "the log has stopped" from "the log
//! is serving me a stale branch."
//!
//! **`akd` cannot produce that.** `Directory::publish` with an empty update set
//! returns the *current* epoch and root unchanged — it does not advance the
//! epoch — and `audit_verify` requires exactly one proof segment per epoch
//! transition, with `AppendOnlyProof.epochs` matching the tree heads one for
//! one (which `f2z_kt_core::auditor::verify_append_only` also checks). An empty
//! `akd` epoch does not exist, so a `SignedTreeHead` numbering scheme decoupled
//! from `akd`'s would make every audit range unverifiable.
//!
//! This log therefore inserts **one heartbeat record per epoch**, at the fixed
//! label [`HEARTBEAT_LABEL`], whose value is derived from the epoch number. Two
//! consequences, both stated rather than discovered later:
//!
//! - Every epoch is a real `akd` epoch, so `SignedTreeHead.epoch` **is**
//!   `akd`'s epoch and `/kt/v1/audit` ranges verify with no translation.
//! - §5.1's "over zero insertions" becomes "over one insertion". The property
//!   that matters — a heartbeat epoch exists, is signed, is cosignable, and
//!   makes silence a detectable fault with a timestamp — is preserved exactly.
//!   The cost is one leaf per epoch: about 52,000 a year at the proposed 600 s
//!   cadence, against a directory sized in millions.
//!
//! The heartbeat label cannot collide with a handle label: `KT.md` §3.3's
//! handle labels are `"free2z/kt/v1/handle:" || handle` and this is not that
//! prefix. Reported as a specification defect rather than coded around
//! silently — see the pull request.
//!
//! # `tree_size`
//!
//! §6.1 defines it as *"total (label, version) insertions committed"*, and that
//! is what it is here — heartbeats included, because they are insertions and
//! the field describes the tree rather than the directory. §6.3 rule 4 only
//! requires monotonicity, which this satisfies.
//!
//! [`tests/adversarial.rs`]: https://github.com/free2z/zuu/blob/main/rs/crates/f2z-kt/tests/adversarial.rs

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use akd::storage::StorageManager;
use akd::storage::memory::AsyncInMemoryDatabase;
use akd::{AkdLabel, AkdValue, AzksParallelismConfig, Directory};
use akd_core::verify::history::HistoryParams;
use f2z_authority::authority::AuthorityConfig;
use f2z_authority::nonce::NonceLedger;
use f2z_codec::hash::hash;
use f2z_codec::types::{Digest, Payload, PublicKey};
use f2z_kt_core::sth::{SignedTreeHead, SignedTreeHeadTBS};
use f2z_kt_core::submit::{LogPolicy, PublishedEntry, SubmissionContext};
use f2z_kt_core::types::{Handle, LogId, label_field};
use f2z_kt_core::{
    KT_VERSION, KtError, SubmissionReceipt, SubmissionReceiptTBS, WitnessCosignature, labels,
};
use protobuf::Message as _;

use crate::admit::{AdmissionContext, AdmittedSubmission, HandleVouch, admit_submission};
use crate::config::LogSettings;
use crate::error::{LogError, Result};
use crate::signer::LogSigner;
use crate::store::{Journal, Store};
use crate::vrf::FileVrf;
use crate::wire::{
    AuditResponse, HistoryResponse, LABEL_AUDIT_RESPONSE, LABEL_HISTORY_RESPONSE,
    LABEL_LOOKUP_RESPONSE, LookupResponse, Presence, TreeHeadBundle,
};

/// The `akd` label of the per-epoch heartbeat record. See the module note.
///
/// Deliberately **not** of the form `"free2z/kt/v1/handle:" || handle`, so no
/// handle can ever address it and no client resolving a handle can ever be
/// served it.
/// The trailing `:` mirrors `KT.md` §3.3's `free2z/kt/v1/handle:` and is not
/// decoration: without it this label is a proper prefix of
/// [`HEARTBEAT_VALUE_LABEL`], and `H(label, x) = BLAKE2b-256(label || x)` has no
/// separator — so `H("…/heartbeat", "-value" || y)` would be bit-identical to
/// `H("…/heartbeat-value", y)`. That is zuu#602's defect in miniature, and
/// `scripts/check-hash-domain-labels.mjs` caught it here before it shipped.
pub const HEARTBEAT_LABEL: &[u8] = b"free2z/kt/v1/heartbeat:";

/// The domain-separation label for a heartbeat's value.
const HEARTBEAT_VALUE_LABEL: &[u8] = b"free2z/kt/v1/heartbeat-value";

/// `akd`'s configuration, fixed permanently by `KT.md` §3.2.
pub type Configuration = f2z_kt_core::verify::Configuration;

type Tree = Directory<Configuration, AsyncInMemoryDatabase, FileVrf>;

/// A submission that has been admitted and is waiting for an epoch.
#[derive(Clone)]
struct Pending {
    canonical: Vec<u8>,
    akd_label: Vec<u8>,
    akd_value: Digest,
    handle: Vec<u8>,
    entry_version: u32,
    is_reset: bool,
    published: PublishedEntry,
    retained: HandleVouch,
}

/// Hand-written, and the workspace `Debug` scan is what insists on it.
///
/// `canonical` is a whole `DirectoryEntry` and `akd_label` embeds the handle; a
/// derived `Debug` renders both as decimal byte dumps. Worse, this is the type
/// that holds a submission **between acceptance and publication** — the one
/// window in which an entry is not yet public — so a dump here is a preview of
/// directory changes, including advance notice that a named handle is about to
/// change hands under `platform_reset`.
impl core::fmt::Debug for Pending {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Pending")
            .field("handle", &"<redacted>")
            .field("entry_version", &self.entry_version)
            .field("is_reset", &self.is_reset)
            .field(
                "canonical",
                &format_args!("<redacted; {} bytes>", self.canonical.len()),
            )
            .field(
                "akd_label",
                &format_args!("<redacted; {} bytes>", self.akd_label.len()),
            )
            .field("akd_value", &self.akd_value)
            .finish_non_exhaustive()
    }
}

/// A [`NonceSeen`] that accepts everything, for replay only.
///
/// A restart re-runs [`admit_submission`] over the whole journal, which means
/// it re-presents every assertion the log has ever admitted. Judging those
/// against a fresh ledger would make the log refuse its own history on the
/// first restart — the nonces were checked when they were first admitted, and
/// the record of that decision *is* the journal.
///
/// It does capture the nonce observation produced by that successful check.
/// [`readmit`] moves the captured values into the separate live ledger only
/// after admission succeeds, so startup both verifies its history without
/// rejecting it and closes the replay window that history already spent.
///
/// It is a distinct type rather than a flag so that it cannot be reached from
/// the live path: [`LogService::submit`] names [`NonceLedger`] and nothing
/// else.
struct ReplayedNonce {
    now_ms: u64,
    authority_id: f2z_authority::types::AuthorityId,
    nonce: f2z_authority::types::AssertionNonce,
    expires_ms: u64,
}

#[derive(Default)]
struct ReplayLedger {
    observed: Option<ReplayedNonce>,
}

impl ReplayLedger {
    fn take_observed(&mut self) -> Option<ReplayedNonce> {
        self.observed.take()
    }
}

impl f2z_authority::nonce::NonceSeen for ReplayLedger {
    fn observe(
        &mut self,
        now_ms: u64,
        authority_id: f2z_authority::types::AuthorityId,
        nonce: f2z_authority::types::AssertionNonce,
        expires_ms: u64,
    ) -> core::result::Result<(), f2z_authority::AuthorityError> {
        self.observed = Some(ReplayedNonce {
            now_ms,
            authority_id,
            nonce,
            expires_ms,
        });
        Ok(())
    }
}

/// Everything about the log that changes, behind one lock.
struct State {
    store: Store,
    /// Handle bytes → the state a next submission is judged against.
    published: BTreeMap<Vec<u8>, PublishedEntry>,
    /// Handle bytes → the vouch and `account_epoch` `f2z-authority` requires
    /// back on every non-initial submission.
    retained: BTreeMap<Vec<u8>, HandleVouch>,
    /// Handle bytes → canonical bytes of the newest published entry.
    latest_entry: BTreeMap<Vec<u8>, Vec<u8>>,
    /// (handle bytes, entry_version) → canonical entry bytes, for history.
    entries: BTreeMap<(Vec<u8>, u32), Vec<u8>>,
    /// Admitted, not yet in a tree.
    pending: Vec<Pending>,
    /// The handles already represented in the pending batch — `KT.md` §4.3.
    pending_handles: BTreeSet<Vec<u8>>,
    /// Every head the log has signed, in epoch order (index `n` is epoch
    /// `n + 1`).
    heads: Vec<SignedTreeHead>,
    /// Epoch → the cosignatures collected for it.
    cosignatures: BTreeMap<u64, Vec<WitnessCosignature>>,
    /// How many submission records each epoch covered.
    submissions_upto: u64,
    /// Replay protection for handle assertions.
    nonces: NonceLedger,
    /// Insertions committed so far — `SignedTreeHead.tree_size`.
    tree_size: u64,
}

/// The log server.
pub struct LogService {
    tree: Tree,
    vrf: FileVrf,
    vrf_public_key: PublicKey,
    signer: Arc<dyn LogSigner>,
    settings: LogSettings,
    log_id: LogId,
    kt_policy: LogPolicy,
    authority: AuthorityConfig,
    /// Cosigning keys this log recognises. Advisory only: `KT.md` §9.5 is
    /// explicit that the log's opinion of who is a witness has **no bearing**
    /// on a client's configured set, so this decides one thing — whether
    /// `/kt/v1/cosign` answers `ERR_NOT_A_WITNESS` — and nothing else.
    known_witnesses: Vec<PublicKey>,
    state: tokio::sync::Mutex<State>,
}

impl LogService {
    /// Open a log: read the journals, rebuild the tree, and re-derive every
    /// root the log ever signed.
    ///
    /// The replay is the integrity check. Each stored epoch's batch is
    /// re-published against a fresh tree and the resulting root hash is
    /// compared to the root in the head the log signed at the time. A journal
    /// that has been edited, truncated in the middle, or written by a version
    /// of `akd` that no longer produces the same tree fails here — loudly, at
    /// startup — rather than serving proofs against a root nobody cosigned.
    ///
    /// # Errors
    ///
    /// [`LogError::Storage`] for an unreadable or inconsistent journal,
    /// [`LogError::Akd`] if the tree cannot be rebuilt, [`LogError::Config`]
    /// for a configuration the journal contradicts.
    pub async fn open(
        dir: &Path,
        settings: LogSettings,
        signer: Arc<dyn LogSigner>,
        vrf: FileVrf,
        authority: AuthorityConfig,
        known_witnesses: Vec<PublicKey>,
    ) -> Result<Self> {
        let (store, journal) = Store::open(dir)?;
        let vrf_public_key = vrf.public_key().await?;
        let log_id = labels::log_id(&settings.genesis_log_pk);

        let db = AsyncInMemoryDatabase::new();
        let tree = Directory::<Configuration, _, _>::new(
            StorageManager::new_no_cache(db),
            vrf.clone(),
            AzksParallelismConfig::default(),
        )
        .await
        .map_err(|error| LogError::Akd(error.to_string()))?;

        let kt_policy = LogPolicy::new(
            log_id,
            settings.reset_authority_pk,
            settings.reset_cooldown_seconds,
        );

        let state = State {
            store,
            published: BTreeMap::new(),
            retained: BTreeMap::new(),
            latest_entry: BTreeMap::new(),
            entries: BTreeMap::new(),
            pending: Vec::new(),
            pending_handles: BTreeSet::new(),
            heads: Vec::new(),
            cosignatures: BTreeMap::new(),
            submissions_upto: 0,
            nonces: NonceLedger::new(settings.nonce_ledger_capacity, authority.clock_skew_ms()),
            tree_size: 0,
        };

        let service = Self {
            tree,
            vrf,
            vrf_public_key,
            signer,
            settings,
            log_id,
            kt_policy,
            authority,
            known_witnesses,
            state: tokio::sync::Mutex::new(state),
        };
        service.replay(journal).await?;
        Ok(service)
    }

    /// Rebuild the tree from the journals and check every recorded root.
    ///
    /// **The replay re-runs the whole admission**, not just the tree. Every
    /// stored envelope goes back through [`admit_submission`] — §4.4 and the
    /// assertion layer both — in the order it was accepted and at the clock it
    /// was accepted at. Three things fall out of that and each is worth having:
    ///
    /// - the per-handle `PublishedEntry` and [`HandleVouch`] are *re-derived*
    ///   rather than stored, so there is no second representation of the
    ///   directory's state to drift from the entries themselves;
    /// - a journal that has been edited fails here, loudly, at startup;
    /// - and the reconstructed `akd` root is compared to the root the log
    ///   signed at the time, so a divergence — corruption, an `akd` that is no
    ///   longer deterministic for our configuration — is a refusal to start
    ///   rather than a log serving proofs against a root nobody cosigned.
    async fn replay(&self, journal: Journal) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut ledger = ReplayLedger::default();

        let mut cursor = 0usize;
        for stored in &journal.epochs {
            let head = &stored.head;
            head.verify(&self.log_id, &self.signer.public_key())
                .map_err(|_| {
                    LogError::Storage(format!(
                        "epochs.log: the head for epoch {} does not verify under the configured \
                         log signing key",
                        head.sth.epoch
                    ))
                })?;

            let upto = usize::try_from(stored.submissions_upto)
                .map_err(|_| LogError::Storage("epochs.log: watermark out of range".to_owned()))?;
            let Some(batch) = journal.submissions.get(cursor..upto) else {
                return Err(LogError::Storage(
                    "epochs.log: watermark past the end of submissions.log".to_owned(),
                ));
            };
            cursor = upto;

            let mut updates = vec![heartbeat_update(head.sth.epoch)];
            for record in batch {
                let admitted = readmit(&mut state, self, record, &mut ledger)?;
                updates.push((
                    AkdLabel(admitted.accepted().akd_label().to_vec()),
                    AkdValue(admitted.accepted().akd_value().as_bytes().to_vec()),
                ));
                commit_published(&mut state, &admitted)?;
            }

            let inserted = u64::try_from(updates.len()).unwrap_or(0);
            let epoch_hash = self
                .tree
                .publish(updates)
                .await
                .map_err(|error| LogError::Akd(error.to_string()))?;

            if epoch_hash.epoch() != head.sth.epoch {
                return Err(LogError::Storage(format!(
                    "replay produced akd epoch {} where the log signed epoch {}",
                    epoch_hash.epoch(),
                    head.sth.epoch
                )));
            }
            if epoch_hash.hash() != *head.sth.root_hash.as_bytes() {
                return Err(LogError::Storage(format!(
                    "replay of epoch {} produced a different root hash than the log signed",
                    head.sth.epoch
                )));
            }
            state.tree_size = state.tree_size.saturating_add(inserted);
            if state.tree_size != head.sth.tree_size {
                return Err(LogError::Storage(format!(
                    "replay of epoch {} produced tree_size {} where the log signed {}",
                    head.sth.epoch, state.tree_size, head.sth.tree_size
                )));
            }
            state.heads.push(head.clone());
            state.submissions_upto = stored.submissions_upto;
        }

        // Anything past the last watermark was admitted and never published.
        // It is re-admitted the same way, and then queued: §5.2's merge promise
        // is signed, so a submission the log accepted and then forgot across a
        // restart is a broken promise with the victim holding the evidence.
        let Some(tail) = journal.submissions.get(cursor..) else {
            return Err(LogError::Storage("submissions.log: short read".to_owned()));
        };
        for record in tail {
            let admitted = readmit(&mut state, self, record, &mut ledger)?;
            enqueue_pending(&mut state, &admitted)?;
        }

        for cosignature in journal.cosignatures {
            let epoch = cosignature.statement.epoch;
            state
                .cosignatures
                .entry(epoch)
                .or_default()
                .push(cosignature);
        }

        log::info!(
            "replayed {} epochs and {} submissions; {} pending",
            state.heads.len(),
            journal.submissions.len(),
            state.pending.len()
        );
        Ok(())
    }

    /// The log's identifier, `H("free2z/kt/v1/log-id", genesis_log_pk)`.
    #[must_use]
    pub const fn log_id(&self) -> &LogId {
        &self.log_id
    }

    /// The VRF public key carried in every tree head.
    #[must_use]
    pub const fn vrf_public_key(&self) -> &PublicKey {
        &self.vrf_public_key
    }

    /// The published settings.
    #[must_use]
    pub const fn settings(&self) -> &LogSettings {
        &self.settings
    }

    /// The handle-authority policy this log applies.
    #[must_use]
    pub const fn authority(&self) -> &AuthorityConfig {
        &self.authority
    }

    /// The log signing key's public half.
    #[must_use]
    pub fn log_public_key(&self) -> PublicKey {
        self.signer.public_key()
    }

    /// **`POST /kt/v1/submit`.** Admit a submission or refuse it, and on
    /// success return the `KT.md` §5.3 receipt.
    ///
    /// The receipt is issued **after** the submission is durably journalled,
    /// never before. §5.3 says the log MUST return one on every accepted
    /// submission and MUST NOT return one for a rejected one; a receipt handed
    /// out before the `fsync` would be a signed promise about an entry a crash
    /// could still erase — the exact failure the receipt exists to make
    /// provable.
    ///
    /// # Errors
    ///
    /// Whatever [`crate::admit::admit_submission`] refused with, or
    /// [`LogError::Storage`] if the journal would not take it.
    pub async fn submit(&self, envelope: &[u8], now_ms: u64) -> Result<SubmissionReceipt> {
        if envelope.len() > self.settings.max_submission_bytes {
            return Err(LogError::Malformed);
        }
        let mut state = self.state.lock().await;
        state.nonces.expire(now_ms);

        // The handle is not known until the entry decodes, and the entry does
        // not decode outside the choke point. So peek at nothing: hand the
        // bytes over, and let `validate_submission` decide.
        //
        // `previous` and `pending_in_epoch` are per-handle and therefore must
        // be resolved from the entry — which means decoding it once here, for
        // routing only, and then handing the **original bytes** to the choke
        // point so that re-encode equality is applied to what arrived.
        let handle = peek_handle(envelope)?;
        let previous = state.published.get(&handle).cloned();
        let retained = state.retained.get(&handle).copied();
        let pending_in_epoch = state.pending_handles.contains(&handle);

        let context = AdmissionContext {
            kt: SubmissionContext {
                policy: &self.kt_policy,
                previous: previous.as_ref(),
                pending_in_epoch,
                now_ms,
            },
            authority: &self.authority,
            retained,
        };
        let admitted = admit_submission(envelope, &context, &mut state.nonces)?;
        self.journal_and_receipt(&mut state, &admitted, envelope, now_ms)
    }

    /// Journal an admitted submission and sign its receipt.
    ///
    /// Private, and takes an [`AdmittedSubmission`] rather than bytes: this is
    /// where the type-level guarantee is cashed in. The receipt is signed
    /// **after** the `fsync`, never before — a receipt handed out ahead of the
    /// durable write would be a signed promise about an entry a crash could
    /// still erase, which is the exact failure the receipt exists to make
    /// provable.
    fn journal_and_receipt(
        &self,
        state: &mut State,
        admitted: &AdmittedSubmission,
        envelope: &[u8],
        now_ms: u64,
    ) -> Result<SubmissionReceipt> {
        let accepted = admitted.accepted();
        let entry = accepted.entry();

        state.store.append_submission(envelope, now_ms)?;
        enqueue_pending(state, admitted)?;

        // The log is public by construction, so this is logged normally — but
        // never the entry bytes, never the assertion and never a key. A handle,
        // a version and who vouched is what an operator needs to correlate a
        // complaint with an epoch.
        log::info!(
            "admitted {}@v{} ({})",
            String::from_utf8_lossy(entry.entry.handle.as_slice()),
            entry.entry.entry_version,
            admitted.vouch().vouch
        );

        let merge_by_ms = now_ms
            .saturating_add(u64::from(self.settings.max_merge_delay_seconds).saturating_mul(1_000));
        let receipt = SubmissionReceiptTBS {
            label: label_field(f2z_kt_core::labels::LABEL_RECEIPT).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            log_id: self.log_id,
            handle: entry.entry.handle.clone(),
            entry_version: entry.entry.entry_version,
            entry_hash: *accepted.akd_value(),
            received_at_ms: admitted.received_at_ms(),
            merge_by_ms,
        };
        let signature = self
            .signer
            .sign(&receipt.signing_bytes().map_err(LogError::Kt)?)?;
        Ok(SubmissionReceipt { receipt, signature })
    }

    /// **The epoch scheduler's tick.** Publish an epoch — heartbeat plus
    /// whatever is pending — and sign its tree head.
    ///
    /// Called on the cadence whether or not anything is pending, which is
    /// `KT.md` §5.1's load-bearing rule.
    ///
    /// # Errors
    ///
    /// [`LogError::Akd`] if the tree refused the batch, [`LogError::Signer`] if
    /// the head could not be signed, [`LogError::Storage`] if it could not be
    /// journalled.
    pub async fn publish_epoch(&self, now_ms: u64) -> Result<SignedTreeHead> {
        let mut state = self.state.lock().await;
        let next_epoch = u64::try_from(state.heads.len())
            .map_err(|_| LogError::Storage("epoch counter overflow".to_owned()))?
            .saturating_add(1);

        let batch = core::mem::take(&mut state.pending);
        state.pending_handles.clear();

        let mut updates = vec![heartbeat_update(next_epoch)];
        let mut reset_count = 0u32;
        for pending in &batch {
            updates.push((
                AkdLabel(pending.akd_label.clone()),
                AkdValue(pending.akd_value.as_bytes().to_vec()),
            ));
            if pending.is_reset {
                reset_count = reset_count.saturating_add(1);
            }
        }
        let inserted = u64::try_from(updates.len()).unwrap_or(0);

        let epoch_hash = self
            .tree
            .publish(updates)
            .await
            .map_err(|error| LogError::Akd(error.to_string()))?;
        if epoch_hash.epoch() != next_epoch {
            return Err(LogError::Akd(format!(
                "akd advanced to epoch {} where the log expected {next_epoch}",
                epoch_hash.epoch()
            )));
        }

        state.tree_size = state.tree_size.saturating_add(inserted);
        let prev_sth_hash = match state.heads.last() {
            Some(previous) => previous.sth.chain_hash().map_err(LogError::Kt)?,
            None => Digest::zero(),
        };
        // §6.3 rule 5: `published_at_ms > last.published_at_ms`, strictly. A
        // clock that did not move — or moved backwards — would make the log's
        // own next head a rollback against itself, so it is nudged forward
        // rather than trusted.
        let published_at_ms = match state.heads.last() {
            Some(previous) => now_ms.max(previous.sth.published_at_ms.saturating_add(1)),
            None => now_ms,
        };

        let sth = SignedTreeHeadTBS {
            label: label_field(f2z_kt_core::labels::LABEL_STH).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            log_id: self.log_id,
            epoch: next_epoch,
            tree_size: state.tree_size,
            root_hash: Digest::new(epoch_hash.hash()),
            prev_sth_hash,
            vrf_public_key: self.vrf_public_key,
            published_at_ms,
            reset_count,
            epoch_interval_seconds: self.settings.epoch_interval_seconds,
            max_merge_delay_seconds: self.settings.max_merge_delay_seconds,
            successor_log_pk: self.settings.successor_log_pk,
        };
        let signature = self
            .signer
            .sign(&sth.signing_bytes().map_err(LogError::Kt)?)?;
        let head = SignedTreeHead { sth, signature };

        let upto = state
            .submissions_upto
            .saturating_add(u64::try_from(batch.len()).unwrap_or(0));
        state.store.append_epoch(&head, upto)?;
        state.submissions_upto = upto;

        for pending in batch {
            state.entries.insert(
                (pending.handle.clone(), pending.entry_version),
                pending.canonical.clone(),
            );
            state
                .latest_entry
                .insert(pending.handle.clone(), pending.canonical);
            state
                .published
                .insert(pending.handle.clone(), pending.published);
            // Carried forward, never re-derived: a routine update inherits the
            // vouch its first entry earned rather than silently upgrading or
            // dropping it.
            state.retained.insert(pending.handle, pending.retained);
        }
        state.heads.push(head.clone());

        log::info!(
            "published epoch {} (tree_size {}, {} resets)",
            head.sth.epoch,
            head.sth.tree_size,
            head.sth.reset_count
        );
        Ok(head)
    }

    /// **`GET /kt/v1/sth`** — the latest head with its cosignatures.
    ///
    /// # Errors
    ///
    /// [`LogError::EpochUnavailable`] before the genesis epoch has been
    /// published.
    pub async fn latest_bundle(&self) -> Result<TreeHeadBundle> {
        let state = self.state.lock().await;
        let head = state
            .heads
            .last()
            .cloned()
            .ok_or(LogError::EpochUnavailable)?;
        let cosignatures = state
            .cosignatures
            .get(&head.sth.epoch)
            .cloned()
            .unwrap_or_default();
        TreeHeadBundle::new(head, cosignatures).map_err(LogError::Kt)
    }

    /// **`GET /kt/v1/sth/{epoch}`.**
    ///
    /// # Errors
    ///
    /// [`LogError::EpochUnavailable`] for an epoch this log has not published.
    pub async fn bundle_at(&self, epoch: u64) -> Result<TreeHeadBundle> {
        let state = self.state.lock().await;
        let head = head_at(&state, epoch).ok_or(LogError::EpochUnavailable)?;
        let cosignatures = state.cosignatures.get(&epoch).cloned().unwrap_or_default();
        TreeHeadBundle::new(head, cosignatures).map_err(LogError::Kt)
    }

    /// **`POST /kt/v1/lookup`.**
    ///
    /// # Errors
    ///
    /// [`LogError::EpochUnavailable`] before genesis, [`LogError::Akd`] if the
    /// proof could not be produced.
    pub async fn lookup(&self, handle: &Handle) -> Result<LookupResponse> {
        let bundle = self.latest_bundle().await?;
        let akd_label = AkdLabel(labels::akd_label(handle));

        let entry_bytes = {
            let state = self.state.lock().await;
            state.latest_entry.get(handle.as_slice()).cloned()
        };

        let (presence, entry, proof) = match entry_bytes {
            Some(entry) => {
                let (proof, epoch_hash) = self
                    .tree
                    .lookup(akd_label)
                    .await
                    .map_err(|error| LogError::Akd(error.to_string()))?;
                if epoch_hash.epoch() != bundle.head.sth.epoch {
                    // The tree moved between taking the head and taking the
                    // proof. Refusing is correct: a proof against a root the
                    // client was not given is a proof it cannot check.
                    return Err(LogError::EpochUnavailable);
                }
                let bytes = akd_core::proto::specs::types::LookupProof::from(&proof)
                    .write_to_bytes()
                    .map_err(|error| LogError::Akd(error.to_string()))?;
                (Presence::Present, entry, bytes)
            }
            // `KT.md` §8.1 requires a **proof** of non-membership here and
            // `akd` 0.13 has no API that produces one. See `wire::Presence`:
            // this answer is labelled unproved rather than dressed up.
            None => (Presence::AbsentUnproved, Vec::new(), Vec::new()),
        };

        Ok(LookupResponse {
            label: label_field(LABEL_LOOKUP_RESPONSE).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            presence: presence.code(),
            entry: Payload::new(entry).map_err(|_| LogError::Malformed)?,
            proof: Payload::new(proof).map_err(|_| LogError::Malformed)?,
            bundle,
        })
    }

    /// **`POST /kt/v1/history`.**
    ///
    /// # Errors
    ///
    /// [`LogError::EpochUnavailable`] before genesis or for an unregistered
    /// handle, [`LogError::Akd`] if the proof could not be produced.
    pub async fn history(&self, handle: &Handle, params: HistoryParams) -> Result<HistoryResponse> {
        let bundle = self.latest_bundle().await?;
        let akd_label = AkdLabel(labels::akd_label(handle));

        let (proof, epoch_hash) = self
            .tree
            .key_history(&akd_label, params)
            .await
            .map_err(|error| LogError::Akd(error.to_string()))?;
        if epoch_hash.epoch() != bundle.head.sth.epoch {
            return Err(LogError::EpochUnavailable);
        }

        let entries = {
            let state = self.state.lock().await;
            let mut collected = Vec::new();
            for result in &proof.update_proofs {
                let version = u32::try_from(result.version).unwrap_or(u32::MAX);
                let Some(bytes) = state.entries.get(&(handle.as_slice().to_vec(), version)) else {
                    return Err(LogError::Storage(format!(
                        "history: no stored entry for version {version}"
                    )));
                };
                collected.push(Payload::new(bytes.clone()).map_err(|_| LogError::Malformed)?);
            }
            collected
        };

        let proof_bytes = akd_core::proto::specs::types::HistoryProof::from(&proof)
            .write_to_bytes()
            .map_err(|error| LogError::Akd(error.to_string()))?;

        Ok(HistoryResponse {
            label: label_field(LABEL_HISTORY_RESPONSE).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            entries: f2z_codec::vec::VecU24::new(entries),
            proof: Payload::new(proof_bytes).map_err(|_| LogError::Malformed)?,
            bundle,
        })
    }

    /// Remove the stored entry bytes while leaving the authenticated tree
    /// untouched, so an acceptance test can exercise the production history
    /// fault path through the HTTP error logger.
    ///
    /// This is available only to test builds. A real process can reach the
    /// same state after storage corruption; it must report that fault without
    /// turning the queried handle into operator-log data.
    #[cfg(any(test, feature = "testing"))]
    pub async fn forget_entry_bytes_for_test(&self, handle: &Handle, version: u32) {
        let mut state = self.state.lock().await;
        state.entries.remove(&(handle.as_slice().to_vec(), version));
    }

    /// **`GET /kt/v1/audit?from&to`.**
    ///
    /// Carries every head in `[from, to]` alongside the proof — see
    /// [`AuditResponse`].
    ///
    /// # Errors
    ///
    /// [`LogError::RangeTooWide`] above the published maximum,
    /// [`LogError::EpochUnavailable`] outside the served horizon,
    /// [`LogError::Akd`] if the proof could not be produced.
    pub async fn audit(&self, from: u64, to: u64) -> Result<AuditResponse> {
        if from >= to {
            return Err(LogError::EpochUnavailable);
        }
        let span = to.saturating_sub(from);
        if span > u64::from(self.settings.max_audit_span) {
            return Err(LogError::RangeTooWide);
        }

        let heads = {
            let state = self.state.lock().await;
            let mut collected = Vec::new();
            let mut epoch = from;
            while epoch <= to {
                collected.push(head_at(&state, epoch).ok_or(LogError::EpochUnavailable)?);
                epoch = epoch.saturating_add(1);
            }
            collected
        };

        let proof = self
            .tree
            .audit(from, to)
            .await
            .map_err(|error| LogError::Akd(error.to_string()))?;
        let proof_bytes = akd_core::proto::specs::types::AppendOnlyProof::from(&proof)
            .write_to_bytes()
            .map_err(|error| LogError::Akd(error.to_string()))?;

        Ok(AuditResponse {
            label: label_field(LABEL_AUDIT_RESPONSE).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            proof: Payload::new(proof_bytes).map_err(|_| LogError::Malformed)?,
            heads: f2z_codec::vec::VecU24::new(heads),
        })
    }

    /// **`POST /kt/v1/cosign`.** Accept a witness cosignature.
    ///
    /// Verified before it is stored — a cosignature the log cannot check is a
    /// cosignature the log would be publishing on a witness's behalf — and
    /// checked to cover a head this log actually signed.
    ///
    /// # Errors
    ///
    /// [`LogError::Kt`] if it does not verify or does not cover a known head,
    /// [`LogError::NotAWitness`] if the log does not recognise the key
    /// (advisory only; §9.5), [`LogError::Storage`] if it could not be
    /// journalled.
    pub async fn accept_cosignature(&self, cosignature: &WitnessCosignature) -> Result<()> {
        cosignature.verify().map_err(LogError::Kt)?;
        if cosignature.statement.log_id != self.log_id {
            return Err(LogError::Kt(KtError::WrongLog));
        }
        if !self.known_witnesses.is_empty()
            && !self
                .known_witnesses
                .contains(&cosignature.statement.witness_pk)
        {
            return Err(LogError::NotAWitness);
        }

        let mut state = self.state.lock().await;
        let head =
            head_at(&state, cosignature.statement.epoch).ok_or(LogError::EpochUnavailable)?;
        if !cosignature.covers(&head) {
            // The witness signed a different root for an epoch this log
            // published. That is the witness's business to explain, and it is
            // not something to file away as if it agreed with us.
            return Err(LogError::Kt(KtError::Fork));
        }

        let epoch = cosignature.statement.epoch;
        let existing = state.cosignatures.entry(epoch).or_default();
        if existing
            .iter()
            .any(|held| held.statement.witness_pk == cosignature.statement.witness_pk)
        {
            // Idempotent: a witness that retries after a timeout must not
            // appear twice and inflate the count a client applies a threshold
            // to.
            return Ok(());
        }
        existing.push(cosignature.clone());
        state.store.append_cosignature(cosignature)?;
        log::info!("cosignature accepted for epoch {epoch}");
        Ok(())
    }

    /// How many submissions are admitted but not yet published.
    ///
    /// Operational, and used by the acceptance tests to assert the scheduler
    /// actually drained a batch.
    pub async fn pending_count(&self) -> usize {
        self.state.lock().await.pending.len()
    }

    /// The current epoch, or 0 before genesis.
    pub async fn current_epoch(&self) -> u64 {
        u64::try_from(self.state.lock().await.heads.len()).unwrap_or(u64::MAX)
    }

    /// The VRF key, for the descriptor.
    #[must_use]
    pub const fn vrf(&self) -> &FileVrf {
        &self.vrf
    }

    /// The signer, for the descriptor and the policy document.
    #[must_use]
    pub fn signer(&self) -> &dyn LogSigner {
        self.signer.as_ref()
    }
}

/// Renders identifiers and nothing else.
///
/// Hand-written rather than derived, and it is not decoration: a derived
/// `Debug` here would reach the signer, the VRF key and — through `State` —
/// every pending submission the log is holding but has not published. `KT.md`
/// says the log is public by construction, but an *unpublished* submission is
/// not, and neither is a key. See `crate::logging`.
impl core::fmt::Debug for LogService {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("LogService")
            .field("log_id", &self.log_id)
            .field("vrf_public_key", &self.vrf_public_key)
            .field("log_signing_pk", &self.signer.public_key())
            .field("signer", &"<redacted>")
            .field("vrf", &"<redacted>")
            .field("state", &"<redacted>")
            .finish()
    }
}

/// Re-run a stored submission through the choke point during replay.
///
/// It takes the same route a network submission takes — the journal holds the
/// envelope exactly as it was canonicalised, so there is one admission path and
/// not a second, laxer one for startup.
fn readmit(
    state: &mut State,
    service: &LogService,
    record: &crate::store::StoredSubmission,
    replay: &mut ReplayLedger,
) -> Result<AdmittedSubmission> {
    let handle = peek_handle(record.envelope.as_slice())?;
    let previous = state.published.get(&handle).cloned();
    let retained = state.retained.get(&handle).copied();
    let context = AdmissionContext {
        kt: SubmissionContext {
            policy: &service.kt_policy,
            previous: previous.as_ref(),
            pending_in_epoch: state.pending_handles.contains(&handle),
            // Judged at the instant it was accepted, so the replay re-runs the
            // original decision rather than taking a new one at a different
            // time — which for a `platform_reset`'s `effective_at_ms` and for
            // an assertion's validity window would be a different decision.
            now_ms: record.received_at_ms,
        },
        authority: &service.authority,
        retained,
    };
    let admitted =
        admit_submission(record.envelope.as_slice(), &context, replay).map_err(|error| {
            LogError::Storage(format!(
                "submissions.log: record {} no longer admits ({error})",
                record.sequence
            ))
        })?;
    restore_replayed_nonce(&mut state.nonces, record, replay)?;
    Ok(admitted)
}

/// Restore a nonce that the canonical stored assertion presented while the
/// replay ledger re-ran admission. Replay itself must accept the log's own
/// history, but the separate live ledger must remember that history after
/// startup.
fn restore_replayed_nonce(
    live: &mut NonceLedger,
    record: &crate::store::StoredSubmission,
    replay: &mut ReplayLedger,
) -> Result<()> {
    let Some(observed) = replay.take_observed() else {
        return Ok(());
    };
    f2z_authority::nonce::NonceSeen::observe(
        live,
        observed.now_ms,
        observed.authority_id,
        observed.nonce,
        observed.expires_ms,
    )
    .map_err(|error| {
        LogError::Storage(format!(
            "submissions.log: record {} cannot restore the nonce ledger ({error})",
            record.sequence
        ))
    })
}

/// Record a submission as published: it becomes the predecessor for the next.
fn commit_published(state: &mut State, admitted: &AdmittedSubmission) -> Result<()> {
    let accepted = admitted.accepted();
    let entry = accepted.entry();
    let handle = entry.entry.handle.as_slice().to_vec();
    let published = accepted.published().map_err(LogError::Kt)?;
    state.entries.insert(
        (handle.clone(), entry.entry.entry_version),
        accepted.canonical_bytes().to_vec(),
    );
    state
        .latest_entry
        .insert(handle.clone(), accepted.canonical_bytes().to_vec());
    state.published.insert(handle.clone(), published);
    state.retained.insert(handle, admitted.vouch());
    Ok(())
}

/// Queue an admitted submission for the next epoch.
fn enqueue_pending(state: &mut State, admitted: &AdmittedSubmission) -> Result<()> {
    let accepted = admitted.accepted();
    let entry = accepted.entry();
    let handle = entry.entry.handle.as_slice().to_vec();
    state.pending_handles.insert(handle.clone());
    state.pending.push(Pending {
        canonical: accepted.canonical_bytes().to_vec(),
        akd_label: accepted.akd_label().to_vec(),
        akd_value: *accepted.akd_value(),
        handle,
        entry_version: entry.entry.entry_version,
        is_reset: matches!(entry.entry.kind, f2z_kt_core::EntryKind::PlatformReset),
        published: accepted.published().map_err(LogError::Kt)?,
        retained: admitted.vouch(),
    });
    Ok(())
}

/// The heartbeat insertion for an epoch. See the module note.
fn heartbeat_update(epoch: u64) -> (AkdLabel, AkdValue) {
    let value = hash(HEARTBEAT_VALUE_LABEL, &epoch.to_be_bytes());
    (
        AkdLabel(HEARTBEAT_LABEL.to_vec()),
        AkdValue(value.as_bytes().to_vec()),
    )
}

fn head_at(state: &State, epoch: u64) -> Option<SignedTreeHead> {
    let index = usize::try_from(epoch.checked_sub(1)?).ok()?;
    state.heads.get(index).cloned()
}

/// Read just the handle out of a submission envelope, for routing.
///
/// This decodes; it does not decide. Everything it learns is re-derived inside
/// [`admit_submission`] from the same bytes, so a discrepancy between what this
/// saw and what the choke point saw cannot produce an accepted submission — it
/// produces a rejected one, because the choke point is the only thing that
/// accepts.
fn peek_handle(envelope: &[u8]) -> Result<Vec<u8>> {
    let decoded = f2z_codec::decode_canonical::<crate::wire::SubmissionEnvelope>(envelope)?;
    let entry = f2z_codec::decode_canonical::<f2z_kt_core::DirectoryEntry>(
        decoded.value().entry.as_slice(),
    )?;
    Ok(entry.value().entry.handle.as_slice().to_vec())
}
