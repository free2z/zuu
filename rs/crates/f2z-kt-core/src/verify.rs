//! The client verifier — `KT.md` §8.1 and §8.2, wrapping `akd_core`.
//!
//! This is the half of the crate that reaches `wasm32-unknown-unknown`. It is
//! behind the `verifier` feature, and the `auditor` feature — which pulls the
//! server crate — is deliberately **not** enabled by it: `akd::auditor`
//! hardcodes `AzksParallelismConfig::default()` and reaches
//! `tokio::task::spawn`, so it compiles for that target and then traps at
//! runtime (§11.3).
//!
//! # `akd`'s proof bytes are carried opaquely, and that is safe
//!
//! Proofs arrive as `akd_core::proto` protobuf. We do not re-encode them into
//! `tls_codec`, so re-encode equality **does not apply inside those bytes**, and
//! protobuf is not canonical. It is safe for a precise reason: **nothing we sign
//! is derived from a proof's encoding.** A proof is an *input to verification*,
//! never a signed object and never a committed value. The value compared against
//! is `H("free2z/kt/v1/value", tls_codec(DirectoryEntry))`, computed here from
//! entry bytes that **are** under re-encode equality, and the root comes from a
//! `tls_codec` tree head. The only thing a malleable proof encoding can produce
//! is a different verification *outcome*, and both outcomes are handled: verify,
//! or reject.
//!
//! Consequently nothing in this crate hashes a proof or compares two proofs for
//! equality.
//!
//! # What a client cannot verify, stated at the point of use (§8.5)
//!
//! Inclusion of a handle at a root: yes, about 1.1 ms. Non-membership: yes. Its
//! own key history, unbroken by version **and** by hash chain: yes, about
//! 2.6 ms. **Append-only consistency between roots: no.** The proof is
//! O(entries added) — 3.9 MB and 1–3 s for five epochs — so there is no cheap
//! check available to a client and therefore no fallback when the witness set is
//! absent, unreachable, or not independent. That is [`crate::auditor`], and it
//! is a witness's job.

use akd_core::configuration::WhatsAppV1Configuration;
use akd_core::verify::{HistoryVerificationParams, key_history_verify, lookup_verify};
use akd_core::{AkdLabel, HistoryProof, LookupProof};
use f2z_codec::canonical::decode_canonical;
use protobuf::Message as _;

use crate::entry::DirectoryEntry;
use crate::error::KtError;
use crate::labels::{akd_label, entry_value};
use crate::submit::{PublishedEntry, SubmissionContext, validate_submission};
use crate::types::Handle;
use crate::witness::AcceptedRoot;

/// The `akd` configuration this log is built on (§3.2). Fixed, and permanent:
/// it determines every label and every commitment in the tree.
pub type Configuration = WhatsAppV1Configuration;

/// An entry whose **inclusion** at a witnessed root has been proved.
///
/// Inclusion is not authorization. §8.1 is explicit about the difference at step
/// 6: *"the log's proof says the entry is **in the tree**, not that it was
/// **authorized**."* [`VerifiedEntry::verify_authorization`] is the second half,
/// and it runs the same §4.4 code the log runs — there is not a second
/// implementation to disagree with the first.
#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedEntry {
    entry: DirectoryEntry,
    canonical: Vec<u8>,
    epoch: u64,
    version: u64,
}

/// Hand-written, for [`AcceptedSubmission`]'s reason: `canonical` is a whole
/// `DirectoryEntry` and a derived `Debug` renders it as a decimal byte dump.
/// This one runs on the **client**, where a verbose log is a user's contact
/// graph rather than a server's.
///
/// [`AcceptedSubmission`]: crate::submit::AcceptedSubmission
impl core::fmt::Debug for VerifiedEntry {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VerifiedEntry")
            .field("entry", &self.entry)
            .field(
                "canonical",
                &format_args!("<redacted; {} bytes>", self.canonical.len()),
            )
            .field("epoch", &self.epoch)
            .field("version", &self.version)
            .finish()
    }
}

impl VerifiedEntry {
    /// The entry.
    #[must_use]
    pub const fn entry(&self) -> &DirectoryEntry {
        &self.entry
    }

    /// The canonical bytes the value commitment was computed over.
    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical
    }

    /// The epoch `akd` says this version entered the tree in.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The `akd` version, which is `DirectoryEntryTBS::entry_version` (§4.2).
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    /// §8.1 step 6 — verify the entry's own authorization under §4.4.
    ///
    /// This is [`validate_submission`], the same function the log calls, run
    /// with `pending_in_epoch: false` because §4.3's one-per-epoch rule is about
    /// a batch being assembled and has no meaning to a client reading a
    /// published entry. Everything else applies unchanged.
    ///
    /// A client that holds the previous entry passes it as
    /// `context.previous`; one that does not — a first lookup of a stranger —
    /// passes `None`, which is exactly right for a version-1 registration and
    /// which correctly **refuses** to bless a later entry it cannot chain.
    ///
    /// # Errors
    ///
    /// As [`validate_submission`].
    pub fn verify_authorization(
        &self,
        context: &SubmissionContext<'_>,
    ) -> Result<crate::submit::AcceptedSubmission, KtError> {
        validate_submission(&self.canonical, context)
    }

    /// The published state this entry represents, for chaining the next one.
    ///
    /// # Errors
    ///
    /// As [`PublishedEntry::from_entry`].
    pub fn published(&self) -> Result<PublishedEntry, KtError> {
        PublishedEntry::from_entry(&self.entry)
    }
}

/// Decode and bind an entry to the value a proof commits to (§8.1 step 4).
///
/// The value is **recomputed here from the returned entry bytes**, under
/// re-encode equality, and that is what goes into `lookup_verify` — never a
/// value the log asserts.
fn bind_entry(
    root: &AcceptedRoot,
    handle: &Handle,
    entry_bytes: &[u8],
) -> Result<(DirectoryEntry, Vec<u8>, akd_core::AkdValue), KtError> {
    let decoded = decode_canonical::<DirectoryEntry>(entry_bytes)?;
    let entry = decoded.value().clone();
    let canonical = decoded.bytes().to_vec();
    entry.validate()?;
    if entry.entry.log_id != *root.log_id() {
        return Err(KtError::WrongLog);
    }
    if entry.entry.handle != *handle {
        // The log answered about a different handle. A proof for `@mallory`
        // verifies perfectly; it just does not answer the question that was
        // asked, and accepting it is the whole of the substitution attack.
        return Err(KtError::BadHandle);
    }
    let value = akd_core::AkdValue(entry_value(&canonical).as_bytes().to_vec());
    Ok((entry, canonical, value))
}

/// §8.1 — resolve a handle at a witnessed root.
///
/// `root` is an [`AcceptedRoot`], which only
/// [`crate::witness::verify_threshold`] constructs, so §8.3's threshold rule
/// cannot be skipped on the way here. §6.3's monotonicity checks are
/// [`crate::sth::LogView`]'s and must already have passed — a client MUST make
/// them itself, and any failure is fatal and is fork evidence.
///
/// Returns the entry whose inclusion is proved. **Call
/// [`VerifiedEntry::verify_authorization`] next**; this function deliberately
/// does not, because the context it needs — the previous entry, the pinned reset
/// authority — is the caller's and cannot be guessed.
///
/// # Errors
///
/// - [`KtError::Malformed`] if the entry bytes are not canonical, or the proof
///   is not decodable protobuf.
/// - [`KtError::WrongLog`] / [`KtError::BadHandle`] if the log answered about
///   another log or another handle.
/// - [`KtError::ProofInvalid`] if `akd_core` rejected the proof.
/// - [`KtError::ValueMismatch`] if the proof commits to a different value than
///   the entry bytes hash to, or to a different version than the entry claims.
pub fn verify_lookup(
    root: &AcceptedRoot,
    handle: &Handle,
    entry_bytes: &[u8],
    lookup_proof: &[u8],
) -> Result<VerifiedEntry, KtError> {
    handle.validate()?;
    let (entry, canonical, value) = bind_entry(root, handle, entry_bytes)?;

    let proto = akd_core::proto::specs::types::LookupProof::parse_from_bytes(lookup_proof)
        .map_err(|_| KtError::Malformed)?;
    let proof = LookupProof::try_from(&proto).map_err(|_| KtError::Malformed)?;

    let result = lookup_verify::<Configuration>(
        root.vrf_public_key().as_bytes(),
        *root.root_hash().as_bytes(),
        root.epoch(),
        AkdLabel(akd_label(handle)),
        proof,
    )
    .map_err(|_| KtError::ProofInvalid)?;

    // The binding, and it is the point of the whole call: the tree commits to a
    // hash of the entry, so the proof is only about *this* entry if the hash the
    // proof carries is the hash of the bytes we were handed.
    if result.value != value {
        return Err(KtError::ValueMismatch);
    }
    if result.version != u64::from(entry.entry.entry_version) {
        return Err(KtError::ValueMismatch);
    }

    Ok(VerifiedEntry {
        entry,
        canonical,
        epoch: result.epoch,
        version: result.version,
    })
}

/// §8.2 — verify a handle's key history at a witnessed root.
///
/// `entries` are the full `DirectoryEntry` byte strings served alongside the
/// proof, in the **same order as the proof's update proofs**, which `akd` emits
/// in **decreasing** version order.
///
/// `pinned` is the client's last known published entry for this handle, or
/// `None` when it is starting from a complete history.
///
/// # Step 4 is not redundant with step 3
///
/// `key_history_verify` proves the versions returned are in the tree. The
/// `entry_version` sequence and the `prev_entry_hash` chain prove the client was
/// shown **all** of them: a log that omits a version from a history response is
/// otherwise serving a truthful subset, and every proof in it verifies.
///
/// # Errors
///
/// - [`KtError::Malformed`] if the proof or any entry is undecodable, or the
///   number of entries does not match the number of update proofs.
/// - [`KtError::ProofInvalid`] if `akd_core` rejected the proof.
/// - [`KtError::ValueMismatch`] if any proved value is not the hash of the entry
///   served for it.
/// - [`KtError::HistoryIncomplete`] if the versions are not contiguous, if the
///   `prev_entry_hash` chain breaks, or if the oldest entry shown is neither
///   version 1 nor a successor of `pinned`.
/// - [`KtError::WrongLog`] / [`KtError::BadHandle`] as [`verify_lookup`].
pub fn verify_key_history(
    root: &AcceptedRoot,
    handle: &Handle,
    entries: &[&[u8]],
    history_proof: &[u8],
    pinned: Option<&PublishedEntry>,
    params: HistoryVerificationParams,
) -> Result<Vec<VerifiedEntry>, KtError> {
    handle.validate()?;
    if entries.is_empty() {
        return Err(KtError::HistoryIncomplete);
    }

    let proto = akd_core::proto::specs::types::HistoryProof::parse_from_bytes(history_proof)
        .map_err(|_| KtError::Malformed)?;
    let proof = HistoryProof::try_from(&proto).map_err(|_| KtError::Malformed)?;
    if proof.update_proofs.len() != entries.len() {
        return Err(KtError::Malformed);
    }

    let results = key_history_verify::<Configuration>(
        root.vrf_public_key().as_bytes(),
        *root.root_hash().as_bytes(),
        root.epoch(),
        AkdLabel(akd_label(handle)),
        proof,
        params,
    )
    .map_err(|_| KtError::ProofInvalid)?;
    if results.len() != entries.len() {
        return Err(KtError::Malformed);
    }

    // Bind every proved value to the entry served for it, in the order `akd`
    // returned them (decreasing version).
    let mut verified = Vec::with_capacity(entries.len());
    for (result, bytes) in results.iter().zip(entries.iter()) {
        let (entry, canonical, value) = bind_entry(root, handle, bytes)?;
        if result.value != value {
            return Err(KtError::ValueMismatch);
        }
        if result.version != u64::from(entry.entry.entry_version) {
            return Err(KtError::ValueMismatch);
        }
        verified.push(VerifiedEntry {
            entry,
            canonical,
            epoch: result.epoch,
            version: result.version,
        });
    }

    // §8.2 step 4, walked oldest-first so the chain reads forwards.
    let mut previous: Option<PublishedEntry> = pinned.cloned();
    for current in verified.iter().rev() {
        match &previous {
            None => {
                // Nothing pinned and nothing shown before this: the only entry
                // that can legitimately start a history is the registration.
                if current.entry.entry.entry_version != 1
                    || !current.entry.entry.prev_entry_hash.is_zero()
                {
                    return Err(KtError::HistoryIncomplete);
                }
            }
            Some(previous) => {
                if current.entry.entry.entry_version != previous.entry_version().saturating_add(1) {
                    return Err(KtError::HistoryIncomplete);
                }
                if current.entry.entry.prev_entry_hash != *previous.chain_hash() {
                    return Err(KtError::HistoryIncomplete);
                }
            }
        }
        previous = Some(current.published()?);
    }

    Ok(verified)
}

/// Re-export so a caller does not have to depend on `akd_core` to name the
/// history parameters `KT.md` §8.2 hands to the verifier.
pub use akd_core::verify::history::HistoryParams;
