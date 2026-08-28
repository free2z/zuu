//! **The one door into the log.** `KT.md` §4.4's submission rules, as the
//! single function a directory server calls before anything reaches `akd`.
//!
//! # Read this before changing anything in this file
//!
//! > **`akd` enforces none of it.** The library will happily commit any bytes to
//! > any label. Every rule below lives in our submission path, and a log that
//! > skips them produces inclusion, history and append-only proofs that verify
//! > **perfectly** for entries nobody authorized. The transparency machinery
//! > proves that the log did not *change its mind*; §4.4 is the only thing that
//! > proves the log did not *make it up*.
//!
//! That is why this module offers exactly one entry point,
//! [`validate_submission`], and no helpers. There is no `check_rotation`, no
//! `verify_device_credentials`, no "validate the easy parts now and the rest
//! later". A server cannot route around the rules because there is nothing to
//! route around them *to*: the only value that carries the bytes `akd` needs is
//! [`AcceptedSubmission`], it has no public constructor, and every accessor on
//! it — the canonical bytes, the `AkdValue`, the `AkdLabel` — exists only on
//! that type.
//!
//! The same reasoning shapes [`PublishedEntry`]. The log does not get to *assert*
//! what the previous entry's `prev_entry_hash` or `directory_auth_pk` were; it
//! must hold the previous `DirectoryEntry` and let
//! [`PublishedEntry::from_entry`] recompute them. A log that could pass in a
//! hash of its choosing could authorize any successor it liked.
//!
//! # Where this is stricter than §4.4's enumerated list, and why
//!
//! §4.4 enumerates nine rules and its table names three authorization shapes.
//! Four things follow from ADR 0014's case analysis but are not in the numbered
//! list, and this module enforces all four. They are called out at the point of
//! use below and repeated here so a reviewer sees them together:
//!
//! 1. **A `same_key` entry MUST NOT change `identity_pk`.** Without this the
//!    rule set has a hole large enough to drive ADR 0014 through: `same_key` is
//!    authorized by the *previous* `directory_auth_pk` alone, so a party holding
//!    only that key could publish a new `identity_pk` — a key change with one
//!    signature, which is exactly what ADR 0014 says the log MUST reject.
//! 2. **A `key_change` or `platform_reset` MUST change `identity_pk`.**
//!    Otherwise one operation has two encodings inside a structure that is
//!    hashed, signed and committed.
//! 3. **A `platform_reset` MUST be refused when the previous entry set
//!    `no_reset`.** That flag is a user's declaration that the reset path does
//!    not apply to their handle; a flag nothing enforces is a comment.
//! 4. **A `ResetAuthorization` is bound to its handle, log, version and
//!    outgoing key**, exactly as §4.4 rule 6 binds a `RotationProof`. §4.4
//!    rule 7 mentions only the signature and the cooldown, which would leave a
//!    reset signed for `@alice` at version 3 usable against `@bob`.

use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{Digest, PublicKey};

use crate::entry::{DirectoryEntry, EntryAuthorization};
use crate::error::KtError;
use crate::labels::{akd_label, entry_value, prev_entry_hash};
use crate::sig;
use crate::types::{Handle, LogId};

/// The published policy a submission is judged against (§9.1).
///
/// `reset_authority_pk` is here because the **log** must check a reset against
/// the same key clients pinned. That the log also publishes the key in its
/// descriptor is a convenience for humans comparing it; it is not where either
/// side gets the key it verifies with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogPolicy {
    log_id: LogId,
    reset_authority_pk: PublicKey,
    reset_cooldown_seconds: u32,
}

impl LogPolicy {
    /// Fix the policy a submission is judged against.
    #[must_use]
    pub const fn new(
        log_id: LogId,
        reset_authority_pk: PublicKey,
        reset_cooldown_seconds: u32,
    ) -> Self {
        Self {
            log_id,
            reset_authority_pk,
            reset_cooldown_seconds,
        }
    }

    /// The log this policy is for.
    #[must_use]
    pub const fn log_id(&self) -> &LogId {
        &self.log_id
    }

    /// The pinned reset authority key (ADR 0014).
    #[must_use]
    pub const fn reset_authority_pk(&self) -> &PublicKey {
        &self.reset_authority_pk
    }

    /// The published cooldown a `platform_reset` must observe.
    #[must_use]
    pub const fn reset_cooldown_seconds(&self) -> u32 {
        self.reset_cooldown_seconds
    }

    /// The cooldown in milliseconds, saturating.
    #[must_use]
    pub const fn reset_cooldown_ms(&self) -> u64 {
        (self.reset_cooldown_seconds as u64).saturating_mul(1_000)
    }
}

/// What the log has already **published** for a handle.
///
/// Deliberately not constructible from loose fields. The only way to build one
/// is from the previous `DirectoryEntry` itself — [`PublishedEntry::from_entry`]
/// — or from the submission that produced it —
/// [`AcceptedSubmission::published`]. Everything in here is *derived* from bytes
/// the log committed to, so a log cannot hand [`validate_submission`] a
/// predecessor of its own invention.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedEntry {
    handle: Handle,
    entry_version: u32,
    chain_hash: Digest,
    identity_pk: PublicKey,
    directory_auth_pk: PublicKey,
    no_reset: bool,
}

impl PublishedEntry {
    /// Derive the published state from the previous entry's own bytes.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the entry cannot be re-encoded, and whatever
    /// [`DirectoryEntry::validate`] returns for an entry that never should have
    /// been published.
    pub fn from_entry(entry: &DirectoryEntry) -> Result<Self, KtError> {
        entry.validate()?;
        Ok(Self {
            handle: entry.entry.handle.clone(),
            entry_version: entry.entry.entry_version,
            chain_hash: entry.chain_hash()?,
            identity_pk: entry.entry.identity_pk,
            directory_auth_pk: entry.entry.directory_auth_pk,
            no_reset: entry.entry.no_reset != 0,
        })
    }

    /// The handle this state is for.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        &self.handle
    }

    /// The published `entry_version`.
    #[must_use]
    pub const fn entry_version(&self) -> u32 {
        self.entry_version
    }

    /// `H("free2z/kt/v1/prev", tls_codec(previous DirectoryEntry))` — what the
    /// next entry's `prev_entry_hash` must equal.
    #[must_use]
    pub const fn chain_hash(&self) -> &Digest {
        &self.chain_hash
    }

    /// The identity key in force.
    #[must_use]
    pub const fn identity_pk(&self) -> &PublicKey {
        &self.identity_pk
    }

    /// The directory-auth key in force — the key a `same_key` update must be
    /// signed by.
    #[must_use]
    pub const fn directory_auth_pk(&self) -> &PublicKey {
        &self.directory_auth_pk
    }

    /// Whether this handle has foreclosed the platform reset path (ADR 0014).
    #[must_use]
    pub const fn no_reset(&self) -> bool {
        self.no_reset
    }
}

/// Everything [`validate_submission`] needs that is not in the submitted bytes.
#[derive(Clone, Copy, Debug)]
pub struct SubmissionContext<'a> {
    /// The log's published policy.
    pub policy: &'a LogPolicy,
    /// The previously published entry for this handle, or `None` if the handle
    /// has never been registered.
    pub previous: Option<&'a PublishedEntry>,
    /// Whether an entry for this handle is already accepted into the epoch
    /// currently being assembled (§4.3).
    ///
    /// **This is the NCC Group finding.** `publish()` with duplicate labels in
    /// one batch left a dangling interior node and no valid key for the user.
    /// The library defect is fixed; the property that a caller must not hand
    /// `publish()` duplicate labels is a property of the *integration*, which is
    /// precisely the region NCC said its review did not cover.
    pub pending_in_epoch: bool,
    /// The log's clock, milliseconds since the Unix epoch.
    ///
    /// Passed in rather than read, so this crate has no clock and a test can
    /// stand at any instant. Used for exactly one thing: §4.4 rule 7's *"the log
    /// MUST NOT publish the entry before `effective_at_ms`."*
    pub now_ms: u64,
}

/// A submission that satisfied every rule in §4.4.
///
/// The only way to obtain the bytes and the label/value pair `akd` needs. No
/// public constructor, no `From`, no field access — because the point of this
/// crate is that a server holding a `DirectoryEntry` cannot get to `publish()`
/// without going through [`validate_submission`] first.
#[derive(Clone, PartialEq, Eq)]
pub struct AcceptedSubmission {
    entry: DirectoryEntry,
    canonical: Vec<u8>,
    akd_value: Digest,
    akd_label: Vec<u8>,
}

/// Hand-written: `canonical` is a whole `DirectoryEntry` and `akd_label`
/// embeds the handle, and a derived `Debug` renders each as a decimal byte
/// dump. One log line per submission, each carrying the full entry, is a
/// directory reconstructed out of a trace log.
impl core::fmt::Debug for AcceptedSubmission {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("AcceptedSubmission")
            .field("entry", &self.entry)
            .field(
                "canonical",
                &format_args!("<redacted; {} bytes>", self.canonical.len()),
            )
            .field("akd_value", &self.akd_value)
            .field(
                "akd_label",
                &format_args!("<redacted; {} bytes>", self.akd_label.len()),
            )
            .finish()
    }
}

impl AcceptedSubmission {
    /// The validated entry.
    #[must_use]
    pub const fn entry(&self) -> &DirectoryEntry {
        &self.entry
    }

    /// The canonical bytes, per re-encode equality (`WIRE.md` §3.3). These, and
    /// never the received bytes, are what was hashed.
    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical
    }

    /// `AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (§3.3) —
    /// the 32 bytes the tree commits to.
    #[must_use]
    pub const fn akd_value(&self) -> &Digest {
        &self.akd_value
    }

    /// `AkdLabel = "free2z/kt/v1/handle:" || handle` (§3.3).
    #[must_use]
    pub fn akd_label(&self) -> &[u8] {
        &self.akd_label
    }

    /// The published state this entry becomes once it is in a tree — the
    /// `previous` for the next submission.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the entry cannot be re-encoded, which it can:
    /// it was decoded from bytes.
    pub fn published(&self) -> Result<PublishedEntry, KtError> {
        PublishedEntry::from_entry(&self.entry)
    }
}

/// **Validate a submitted `DirectoryEntry` against every rule in `KT.md` §4.4.**
///
/// The rules are applied in §4.4's stated order. Each numbered comment in the
/// body is the corresponding numbered rule, and the four additional rules the
/// module note explains are marked where they run.
///
/// # Errors
///
/// - [`KtError::Malformed`] — rule 1: the bytes did not decode, or re-encoded
///   differently. Also a shape violation a decoder cannot express: a bad
///   `no_reset`, a duplicated `device_pk`, an empty KEM key.
/// - [`KtError::WrongLabel`] / [`KtError::UnsupportedVersion`] /
///   [`KtError::WrongLog`] — rule 2.
/// - [`KtError::BadHandle`] — rule 3's charset half.
/// - [`KtError::VersionConflict`] — rule 3's version half and rule 4.
/// - [`KtError::BadAuthorization`] — rule 5, and rules 6/7's structural halves.
///   The wire code is `ERR_BAD_AUTHORIZATION`: *structurally valid but §4.4's
///   rules unmet — e.g. a key change with one signature.*
/// - [`KtError::BadSignature`] — any signature that did not verify, including
///   rule 6's `RotationProof`, rule 7's reset and rule 8's device credentials.
/// - [`KtError::Cooldown`] — rule 7's timing half.
/// - [`KtError::DuplicateInEpoch`] — rule 9.
pub fn validate_submission(
    submitted: &[u8],
    context: &SubmissionContext<'_>,
) -> Result<AcceptedSubmission, KtError> {
    // ---- Rule 1. Re-encode equality (WIRE.md §3.3). --------------------------
    //
    // Delegated to `f2z-codec`, which is the only implementation of the rule in
    // this tree. It hands back the *re-encoded* bytes, never the received ones,
    // so everything hashed below is canonical by construction rather than by
    // discipline.
    let decoded = decode_canonical::<DirectoryEntry>(submitted)?;
    let entry = decoded.value().clone();
    let canonical = decoded.bytes().to_vec();

    // ---- Rules 2, 3 (charset), 5 (kind agreement) and 8 (duplicate device
    // ---- keys), plus the shape checks a decode cannot express. ---------------
    //
    // `DirectoryEntry::validate` checks the label first, per §6.2's "a verifier
    // MUST check it before anything else".
    entry.validate()?;

    // ---- Rule 2, the log_id half. -------------------------------------------
    if entry.entry.log_id != *context.policy.log_id() {
        return Err(KtError::WrongLog);
    }

    // ---- Rule 3, the version half, and rule 4. ------------------------------
    match context.previous {
        None => {
            // A handle nobody has registered. §4.2 fixes the version and the
            // all-zero `prev_entry_hash`; `DirectoryEntry::validate` has already
            // tied those two together, so only the version needs saying here.
            if entry.entry.entry_version != 1 {
                return Err(KtError::VersionConflict);
            }
        }
        Some(previous) => {
            if previous.handle() != &entry.entry.handle {
                // The caller looked up the wrong predecessor. Refusing rather
                // than trusting the lookup keeps the chain rules meaningful.
                return Err(KtError::VersionConflict);
            }
            if entry.entry.entry_version != previous.entry_version().saturating_add(1) {
                return Err(KtError::VersionConflict);
            }
            // Rule 4.
            if entry.entry.prev_entry_hash != *previous.chain_hash() {
                return Err(KtError::VersionConflict);
            }
        }
    }

    // ---- Rule 5. The authorization table of §4.4. ---------------------------
    //
    // `authorization.kind == entry.kind` was checked by `validate`. What is left
    // is the table itself: which key signs `auth_signature`, and what else must
    // be present.
    let entry_bytes = entry.entry.signing_bytes()?;
    match (&entry.authorization, context.previous) {
        // -- same_key ---------------------------------------------------------
        (EntryAuthorization::SameKey { auth_signature }, previous) => {
            let signing_key = match previous {
                // §4.4's table: the `directory_auth_pk` **published in the
                // previous entry**. The blast-radius argument in §4.4 depends on
                // this being the previous key and not this entry's: if a
                // submission could nominate the key that authorizes it, the
                // signature would prove only that whoever wrote the entry also
                // wrote the entry.
                Some(previous) => {
                    // ADDITIONAL RULE 1 (see the module note). ADR 0014 case 1
                    // is "the identity key is unchanged"; §4.4's numbered list
                    // does not restate it, and without it a party holding only
                    // the previous `DirectoryAuthKey` could install a new
                    // `identity_pk` — a key change with one signature, which
                    // ADR 0014 says the log MUST reject.
                    if entry.entry.identity_pk != *previous.identity_pk() {
                        return Err(KtError::BadAuthorization);
                    }
                    previous.directory_auth_pk()
                }
                // Version 1: there is no previous entry and therefore no
                // previously published key. AMBIGUITY CALL — §4.4's table has no
                // row for a handle's first entry. Read as trust-on-first-
                // registration: the entry is self-signed by the
                // `directory_auth_pk` it publishes. Nothing weaker is possible
                // (there is no earlier key) and nothing stronger is specified;
                // what makes it safe is that the *registration* is what a client
                // pins, and every later change is chained to it.
                None => &entry.entry.directory_auth_pk,
            };
            sig::verify(signing_key, &entry_bytes, auth_signature)?;
        }

        // -- key_change -------------------------------------------------------
        (
            EntryAuthorization::KeyChange {
                rotation,
                auth_signature,
            },
            previous,
        ) => {
            // AMBIGUITY CALL — a key change needs a key to change *from*. §4.4
            // rule 6 requires the `RotationProof`'s `old_identity_pk` to equal
            // "the previous entry's `identity_pk`", which does not exist at
            // version 1, so a version-1 key change cannot satisfy rule 6 and is
            // refused here rather than left to fail obscurely.
            let Some(previous) = previous else {
                return Err(KtError::BadAuthorization);
            };

            // ---- Rule 6, structural half. -----------------------------------
            //
            // "A key change carrying only one of the two signatures MUST be
            // rejected." That is enforced by the type: `EntryAuthorization`
            // has no key-change variant without a `RotationProof`, so a
            // submission carrying one signature does not decode as a key change
            // at all. What is left to check is that the proof is about *this*
            // rotation.
            let proof = &rotation.proof;
            if proof.log_id != *context.policy.log_id()
                || proof.handle != entry.entry.handle
                || proof.entry_version != entry.entry.entry_version
                || proof.prev_entry_hash != entry.entry.prev_entry_hash
                || proof.old_identity_pk != *previous.identity_pk()
                || proof.new_identity_pk != entry.entry.identity_pk
            {
                return Err(KtError::BadAuthorization);
            }
            // ADDITIONAL RULE 2. A "key change" that changes no key is a
            // `same_key` update wearing the wrong label, and would give one
            // operation two encodings inside a structure that is hashed and
            // signed.
            if proof.old_identity_pk == proof.new_identity_pk {
                return Err(KtError::BadAuthorization);
            }

            // ---- Rule 6, signature half: the OUTGOING identity key. ---------
            //
            // "The outgoing signature stops the log operator from swapping a
            // key" (ADR 0014).
            sig::verify(
                &proof.old_identity_pk,
                &proof.signing_bytes()?,
                &rotation.signature,
            )?;

            // ---- Rule 5, the table: the NEW `directory_auth_pk`. ------------
            //
            // "The incoming signature stops a stolen or mis-transcribed new key
            // from being installed without proof of possession" (ADR 0014).
            sig::verify(&entry.entry.directory_auth_pk, &entry_bytes, auth_signature)?;
        }

        // -- platform_reset ---------------------------------------------------
        (
            EntryAuthorization::PlatformReset {
                reset,
                auth_signature,
            },
            previous,
        ) => {
            // AMBIGUITY CALL, as for `key_change`: a reset displaces an existing
            // key, and §4.4 has no reading under which an unregistered handle
            // has one. A platform-authority registration of a fresh handle would
            // be a different operation with different consequences, and
            // inventing it here is not this crate's to do.
            let Some(previous) = previous else {
                return Err(KtError::BadAuthorization);
            };

            // ADDITIONAL RULE 3. ADR 0014: a user who sets `no_reset` is
            // declaring that the reset path does not apply to their handle —
            // "losing the key means losing the handle, permanently, with no
            // recovery." A flag nothing enforces is a comment, and this is the
            // strongest posture the system offers.
            if previous.no_reset() {
                return Err(KtError::BadAuthorization);
            }

            let authorization = &reset.reset;
            // ADDITIONAL RULE 4. §4.4 rule 7 names only the signature and the
            // cooldown. Binding the authorization to its handle, log, version
            // and outgoing key is what stops a reset signed for `@alice` at
            // version 3 from being replayed against `@bob` — exactly the
            // bindings rule 6 already demands of a `RotationProof`.
            if authorization.log_id != *context.policy.log_id()
                || authorization.handle != entry.entry.handle
                || authorization.entry_version != entry.entry.entry_version
                || authorization.old_identity_pk != *previous.identity_pk()
                || authorization.new_identity_pk != entry.entry.identity_pk
            {
                return Err(KtError::BadAuthorization);
            }
            // ADDITIONAL RULE 2 again, for the same reason.
            if authorization.old_identity_pk == authorization.new_identity_pk {
                return Err(KtError::BadAuthorization);
            }

            // ---- Rule 7, signature half: the PINNED reset authority. --------
            sig::verify(
                context.policy.reset_authority_pk(),
                &authorization.signing_bytes()?,
                &reset.reset_signature,
            )?;

            // ---- Rule 7, timing half. ---------------------------------------
            //
            // "The cooldown is the part that gives the victim something to do"
            // (ADR 0014). Two separate conditions and both are required: the
            // authorization must *declare* at least the published cooldown, and
            // the log must not publish before the declared instant.
            let declared = authorization
                .effective_at_ms
                .checked_sub(authorization.created_at_ms)
                .ok_or(KtError::Cooldown)?;
            if declared < context.policy.reset_cooldown_ms() {
                return Err(KtError::Cooldown);
            }
            if context.now_ms < authorization.effective_at_ms {
                return Err(KtError::Cooldown);
            }

            // ---- Rule 5, the table: this entry's `directory_auth_pk`. -------
            sig::verify(&entry.entry.directory_auth_pk, &entry_bytes, auth_signature)?;
        }
    }

    // ---- Rule 8. Device credentials. ----------------------------------------
    //
    // "Every `DeviceCredential` signature verifies under **this entry's**
    // `identity_pk`" — under the entry's key, not under the key the credential
    // carries, or a credential could authenticate itself. The two are then
    // required to be equal, because an MLS peer validating the credential in a
    // `LeafNode` has no directory access and will use the embedded key; if the
    // two could differ, the peer and the directory client would reach different
    // verdicts about the same device.
    //
    // The "no two credentials share a `device_pk`" half ran in `validate`.
    for credential in entry.entry.devices.as_slice() {
        if credential.credential.identity_pk != entry.entry.identity_pk {
            return Err(KtError::BadAuthorization);
        }
        sig::verify(
            &entry.entry.identity_pk,
            &credential.credential.signing_bytes()?,
            &credential.signature,
        )?;
    }

    // ---- Rule 9. §4.3's uniqueness rule. ------------------------------------
    //
    // "The log MUST accept at most one entry per handle per epoch." Last in
    // §4.4's order, and it is not a convenience rule: it is the mitigation for
    // NCC Group's Medium-severity finding against `akd`.
    if context.pending_in_epoch {
        return Err(KtError::DuplicateInEpoch);
    }

    let akd_value = entry_value(&canonical);
    let akd_label = akd_label(&entry.entry.handle);
    Ok(AcceptedSubmission {
        entry,
        canonical,
        akd_value,
        akd_label,
    })
}

/// `H("free2z/kt/v1/prev", …)` of an entry the caller already holds.
///
/// A thin convenience for a log that is rebuilding its index from stored bytes.
/// It is *not* a way around [`validate_submission`]: it produces a hash, not an
/// [`AcceptedSubmission`], and nothing downstream accepts a bare hash.
#[must_use]
pub fn chain_hash_of(canonical_entry: &[u8]) -> Digest {
    prev_entry_hash(canonical_entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TestDirectory, signing_key};
    use f2z_codec::canonical::Canonical as _;
    use f2z_codec::types::Signature;

    fn accept(
        directory: &TestDirectory,
        entry: &DirectoryEntry,
        previous: Option<&PublishedEntry>,
        now_ms: u64,
    ) -> Result<AcceptedSubmission, KtError> {
        let policy = directory.policy();
        let context = SubmissionContext {
            policy: &policy,
            previous,
            pending_in_epoch: false,
            now_ms,
        };
        validate_submission(&entry.encode_canonical().unwrap(), &context)
    }

    #[test]
    fn the_happy_path_registers_a_handle_and_then_updates_it() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let accepted = accept(&directory, &genesis, None, 0).expect("a valid registration");
        // Composed from the prefix rather than written out as one literal.
        // `scripts/check-hash-domain-labels.mjs` reads every tracked file, and
        // a fixture that spells the whole composed label mints a token that is
        // not prefix-free against the prefix constant itself — a finding about
        // a test string rather than about the protocol. The assertion is
        // unchanged; it just no longer coins a domain.
        let mut expected = crate::labels::AKD_LABEL_PREFIX.to_vec();
        expected.extend_from_slice(b"alice");
        assert_eq!(
            accepted.akd_label(),
            expected.as_slice(),
            "§3.3's label shape"
        );
        assert_eq!(
            accepted.akd_value(),
            &entry_value(&genesis.encode_canonical().unwrap()),
        );

        let published = accepted.published().unwrap();
        let update = directory.same_key_update(&genesis);
        let accepted = accept(&directory, &update, Some(&published), 0).expect("a valid update");
        assert_eq!(accepted.entry().entry.entry_version, 2);
    }

    #[test]
    fn a_wrong_prev_entry_hash_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();

        let mut update = directory.same_key_update(&genesis);
        update.entry.prev_entry_hash = Digest::new([0x5a; 32]);
        let update = directory.reauthorize_same_key(update, &genesis);
        assert_eq!(
            accept(&directory, &update, Some(&published), 0),
            Err(KtError::VersionConflict),
            "a truncated or substituted history has to break a hash, not merely omit a proof",
        );
    }

    #[test]
    fn a_version_gap_or_repeat_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();

        let mut skipped = directory.same_key_update(&genesis);
        skipped.entry.entry_version = 3;
        let skipped = directory.reauthorize_same_key(skipped, &genesis);
        assert_eq!(
            accept(&directory, &skipped, Some(&published), 0),
            Err(KtError::VersionConflict),
        );

        // And a replay of the entry that is already published.
        assert_eq!(
            accept(&directory, &genesis, Some(&published), 0),
            Err(KtError::VersionConflict),
        );
    }

    #[test]
    fn a_registration_must_be_version_one() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        entry.entry.entry_version = 2;
        entry.entry.prev_entry_hash = Digest::new([1u8; 32]);
        let entry = directory.reauthorize_genesis(entry);
        assert_eq!(
            accept(&directory, &entry, None, 0),
            Err(KtError::VersionConflict),
        );
    }

    #[test]
    fn a_key_change_signed_by_only_the_new_key_is_rejected() {
        // ADR 0014: "The log MUST reject a key change carrying only one."
        // A key change whose RotationProof does not verify is exactly that:
        // the new key's signature is present and valid, and the outgoing key's
        // is not.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let new_isk = signing_key(60);
        let new_auth = signing_key(61);

        let mut rotated = directory.key_change(&genesis, &new_isk, &new_auth);
        if let EntryAuthorization::KeyChange { rotation, .. } = &mut rotated.authorization {
            rotation.signature = Signature::new([0u8; 64]);
        }
        assert_eq!(
            accept(&directory, &rotated, Some(&published), 0),
            Err(KtError::BadSignature),
        );
    }

    #[test]
    fn a_key_change_signed_by_only_the_old_key_is_rejected() {
        // The mirror image: a valid RotationProof by the outgoing ISK, and no
        // valid proof of possession of the new key.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let new_isk = signing_key(60);
        let new_auth = signing_key(61);

        let mut rotated = directory.key_change(&genesis, &new_isk, &new_auth);
        if let EntryAuthorization::KeyChange { auth_signature, .. } = &mut rotated.authorization {
            *auth_signature = Signature::new([0u8; 64]);
        }
        assert_eq!(
            accept(&directory, &rotated, Some(&published), 0),
            Err(KtError::BadSignature),
        );
    }

    #[test]
    fn a_key_change_authorized_by_a_rotation_proof_for_another_handle_is_rejected() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let new_isk = signing_key(60);
        let new_auth = signing_key(61);

        let mut rotated = directory.key_change(&genesis, &new_isk, &new_auth);
        if let EntryAuthorization::KeyChange { rotation, .. } = &mut rotated.authorization {
            rotation.proof.handle = Handle::new(b"mallory".to_vec()).unwrap();
            // Re-sign, so this is a *correctly signed* proof about a different
            // handle rather than a signature failure.
            *rotation = directory.sign_rotation(rotation.proof.clone(), &directory.identity_key());
        }
        assert_eq!(
            accept(&directory, &rotated, Some(&published), 0),
            Err(KtError::BadAuthorization),
        );
    }

    #[test]
    fn a_same_key_entry_must_not_change_the_identity_key() {
        // The hole in §4.4's numbered list. `same_key` is authorized by the
        // PREVIOUS directory_auth_pk alone, so without this rule a party holding
        // only that key rotates the identity with one signature.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();

        let mut smuggled = directory.same_key_update(&genesis);
        smuggled.entry.identity_pk = crate::testing::public_key_of(&signing_key(70));
        let smuggled = directory.reauthorize_same_key(smuggled, &genesis);
        assert_eq!(
            accept(&directory, &smuggled, Some(&published), 0),
            Err(KtError::BadAuthorization),
            "a key change with one signature, wearing a same_key label",
        );
    }

    #[test]
    fn a_same_key_update_signed_by_anything_but_the_current_directory_key_is_refused() {
        // zuu#692. §4.4's `same_key` row is the ONLY thing standing between an
        // ordinary entry — adding a device, removing a device, changing an
        // endpoint, rotating a KEM key — and the directory, and it is the
        // most-travelled rule in §4.4. Every other `BadSignature` test in this
        // file targets an *exceptional* authorization path.
        //
        // The signature here is genuine: a real Ed25519 signature over the real
        // entry bytes, by a key that is simply not the one the previous entry
        // published. A corrupted-bytes fixture would be refused by the same
        // call for a weaker reason.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();

        let update = directory.same_key_update(&genesis);
        let impostor = signing_key(0x9a);
        let signed_by_a_stranger = DirectoryEntry {
            authorization: EntryAuthorization::SameKey {
                auth_signature: crate::testing::sign(
                    &impostor,
                    &update.entry.signing_bytes().unwrap(),
                ),
            },
            entry: update.entry.clone(),
        };
        assert_eq!(
            accept(&directory, &signed_by_a_stranger, Some(&published), 0),
            Err(KtError::BadSignature),
            "the previous entry's directory_auth_pk is what authorizes an ordinary update",
        );

        // The positive control, in the same test so a fix that broke ordinary
        // submissions could not hide behind the refusal above.
        assert!(accept(&directory, &update, Some(&published), 0).is_ok());
    }

    #[test]
    fn a_registration_not_self_signed_by_the_key_it_publishes_is_refused() {
        // The version-1 half of the same call site, and the AMBIGUITY CALL
        // §4.4's table has no row for: a registration is self-signed by the
        // `directory_auth_pk` it publishes. Nothing weaker is possible, and
        // "nothing weaker" is only true if the self-signature is checked.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let impostor = signing_key(0x9b);
        let not_self_signed = DirectoryEntry {
            authorization: EntryAuthorization::SameKey {
                auth_signature: crate::testing::sign(
                    &impostor,
                    &genesis.entry.signing_bytes().unwrap(),
                ),
            },
            entry: genesis.entry.clone(),
        };
        assert_eq!(
            accept(&directory, &not_self_signed, None, 0),
            Err(KtError::BadSignature),
            "trust-on-first-registration still requires the registration to be signed",
        );
        assert!(accept(&directory, &genesis, None, 0).is_ok());
    }

    #[test]
    fn a_reset_entry_not_signed_by_its_own_directory_key_is_refused() {
        // zuu#692. §4.4 rule 5 for `platform_reset`: the entry's OWN
        // `directory_auth_pk` signs it. The reset authority's signature (rule 7)
        // covers the `ResetAuthorization`, which names the incoming *identity*
        // key and says nothing at all about the incoming directory-auth key —
        // so without this signature the platform authority's approval of a
        // recovery would install a directory-auth key nobody proved possession
        // of. `a_reset_signed_by_anything_but_the_pinned_authority_is_refused`
        // covers rule 7 and cannot cover this.
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let new_isk = signing_key(0x80);
        let new_auth = signing_key(0x81);
        let cooldown_ms = directory.policy().reset_cooldown_ms();

        let reset = directory.platform_reset(&genesis, &new_isk, &new_auth, 0);
        // Genuine signature, wrong key: neither the directory-auth key this
        // entry publishes nor any key the entry mentions.
        let stranger_signed = directory.reauthorize_reset(reset.clone(), &signing_key(0x9c));
        assert_eq!(
            accept(&directory, &stranger_signed, Some(&published), cooldown_ms),
            Err(KtError::BadSignature),
        );

        // And specifically not the *outgoing* directory-auth key either: a
        // reset exists because that key is gone.
        let old_auth_signed = directory.reauthorize_reset(reset.clone(), &signing_key(0x42));
        assert_eq!(
            accept(&directory, &old_auth_signed, Some(&published), cooldown_ms),
            Err(KtError::BadSignature),
        );

        assert!(
            accept(&directory, &reset, Some(&published), cooldown_ms).is_ok(),
            "the correctly signed reset is still accepted",
        );
    }

    #[test]
    fn a_reset_before_its_cooldown_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let new_isk = signing_key(80);
        let new_auth = signing_key(81);
        let cooldown_ms = directory.policy().reset_cooldown_ms();

        // Declares the full cooldown, submitted one millisecond early.
        let reset = directory.platform_reset(&genesis, &new_isk, &new_auth, 0);
        assert_eq!(
            accept(
                &directory,
                &reset,
                Some(&published),
                cooldown_ms.saturating_sub(1)
            ),
            Err(KtError::Cooldown),
        );
        assert!(accept(&directory, &reset, Some(&published), cooldown_ms).is_ok());

        // Declares a shorter cooldown than the log published: refused whenever
        // it is submitted, including long afterwards.
        let mut short = directory.platform_reset(&genesis, &new_isk, &new_auth, 0);
        if let EntryAuthorization::PlatformReset { reset, .. } = &mut short.authorization {
            reset.reset.effective_at_ms = reset.reset.created_at_ms.saturating_add(1_000);
            *reset = directory.sign_reset(reset.reset.clone());
        }
        let short = directory.reauthorize_reset(short, &new_auth);
        assert_eq!(
            accept(&directory, &short, Some(&published), u64::MAX),
            Err(KtError::Cooldown),
        );
    }

    #[test]
    fn a_reset_signed_by_anything_but_the_pinned_authority_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let cooldown_ms = directory.policy().reset_cooldown_ms();

        let mut reset = directory.platform_reset(&genesis, &signing_key(80), &signing_key(81), 0);
        if let EntryAuthorization::PlatformReset { reset, .. } = &mut reset.authorization {
            // A valid signature by a key that is not the pinned authority.
            reset.reset_signature =
                crate::testing::sign(&signing_key(99), &reset.reset.signing_bytes().unwrap());
        }
        assert_eq!(
            accept(&directory, &reset, Some(&published), cooldown_ms),
            Err(KtError::BadSignature),
        );
    }

    #[test]
    fn a_reset_is_refused_against_a_handle_that_set_no_reset() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis_no_reset();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        assert!(published.no_reset());
        let cooldown_ms = directory.policy().reset_cooldown_ms();

        let reset = directory.platform_reset(&genesis, &signing_key(80), &signing_key(81), 0);
        assert_eq!(
            accept(&directory, &reset, Some(&published), cooldown_ms),
            Err(KtError::BadAuthorization),
            "ADR 0014: losing the key means losing the handle, permanently",
        );
    }

    #[test]
    fn a_device_credential_signed_by_the_wrong_identity_key_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.wrong_signer_credential();
        assert_eq!(
            accept(&directory, &genesis, None, 0),
            Err(KtError::BadSignature),
        );
    }

    #[test]
    fn a_device_credential_naming_another_identity_key_is_refused() {
        // Self-consistent — signed by the key it names — and still refused: an
        // MLS peer would validate it against the embedded key and reach a
        // different verdict from the directory client.
        let directory = TestDirectory::new();
        let genesis = directory.foreign_identity_credential();
        assert_eq!(
            accept(&directory, &genesis, None, 0),
            Err(KtError::BadAuthorization),
        );
    }

    #[test]
    fn a_second_entry_for_a_handle_in_one_epoch_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let update = directory.same_key_update(&genesis);
        let policy = directory.policy();
        let context = SubmissionContext {
            policy: &policy,
            previous: Some(&published),
            pending_in_epoch: true,
            now_ms: 0,
        };
        assert_eq!(
            validate_submission(&update.encode_canonical().unwrap(), &context),
            Err(KtError::DuplicateInEpoch),
            "NCC Group's Medium finding: publish() must never see duplicate labels",
        );
    }

    #[test]
    fn an_entry_for_another_log_is_refused() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        entry.entry.log_id = LogId::new([0x77; 32]);
        let entry = directory.reauthorize_genesis(entry);
        assert_eq!(accept(&directory, &entry, None, 0), Err(KtError::WrongLog));
    }

    #[test]
    fn trailing_bytes_are_refused_before_any_signature_is_checked() {
        let directory = TestDirectory::new();
        let policy = directory.policy();
        let context = SubmissionContext {
            policy: &policy,
            previous: None,
            pending_in_epoch: false,
            now_ms: 0,
        };
        let mut bytes = directory.genesis().encode_canonical().unwrap();
        bytes.push(0);
        assert_eq!(
            validate_submission(&bytes, &context),
            Err(KtError::Malformed),
        );
    }

    #[test]
    fn a_key_change_or_reset_at_version_one_is_refused() {
        // AMBIGUITY CALL, tested: §4.4's table has no row for a handle's first
        // entry, and rules 6 and 7 both bind the authorization to "the previous
        // entry's identity_pk", which does not exist. A registration is a
        // `same_key` entry; nothing else.
        let directory = TestDirectory::new();
        assert_eq!(
            accept(&directory, &directory.key_change_at_version_one(), None, 0),
            Err(KtError::BadAuthorization),
        );
        assert_eq!(
            accept(
                &directory,
                &directory.platform_reset_at_version_one(),
                None,
                u64::MAX,
            ),
            Err(KtError::BadAuthorization),
        );
    }

    #[test]
    fn a_later_version_with_no_published_predecessor_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let update = directory.same_key_update(&genesis);
        assert_eq!(
            accept(&directory, &update, None, 0),
            Err(KtError::VersionConflict),
        );
    }

    #[test]
    fn a_key_change_that_changes_no_key_is_refused() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let published = PublishedEntry::from_entry(&genesis).unwrap();
        let rotated = directory.key_change(&genesis, &directory.identity_key(), &signing_key(61));
        assert_eq!(
            accept(&directory, &rotated, Some(&published), 0),
            Err(KtError::BadAuthorization),
        );
    }

    #[test]
    fn the_previous_entry_must_be_the_one_for_this_handle() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let other = TestDirectory::for_handle(b"bob");
        let published = PublishedEntry::from_entry(&other.genesis()).unwrap();
        let update = directory.same_key_update(&genesis);
        assert_eq!(
            accept(&directory, &update, Some(&published), 0),
            Err(KtError::VersionConflict),
        );
    }
}
