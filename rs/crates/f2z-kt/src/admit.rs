//! **The only door into the tree.**
//!
//! `KT.md` §4.4 ends with the sentence this module exists for:
//!
//! > `akd` enforces none of it. The library will happily commit any bytes to
//! > any label. […] a log that skips them produces inclusion, history and
//! > append-only proofs that verify **perfectly** for entries nobody
//! > authorized. The transparency machinery proves that the log did not *change
//! > its mind*; §4.4 is the only thing that proves the log did not *make it
//! > up*.
//!
//! `f2z-kt-core` answers that with a choke point: [`AcceptedSubmission`] has no
//! public constructor, so the only way to hold an `AkdLabel`/`AkdValue` pair is
//! to have gone through [`f2z_kt_core::validate_submission`]. This module adds
//! the second half and keeps the same shape.
//!
//! # zuu#594 — what authorizes a handle's *first* entry
//!
//! §4.4's table authorizes `same_key` by *"the `directory_auth_pk` published in
//! the previous entry"*. At `entry_version == 1` there is no previous entry,
//! rule 3 explicitly permits that version, and **nothing in the numbered rules,
//! the table, or the prose says what authorizes it**. A literal implementation
//! of the merged specification therefore hands `@alice` to whoever submits a
//! first entry for it — first-come-first-served handle claiming, in the
//! document whose entire purpose is that the server cannot lie about who you
//! are talking to. That is [zuu#594], it is unresolved, and **this log does not
//! ship it.**
//!
//! [`admit_submission`] requires a `HandleAssertion` from a configured
//! authority for `entry_version == 1`, verified by [`f2z_authority`], which is
//! the crate proposal offered against #594 rather than ratified specification.
//! Self-hosters who have no authority configure
//! [`f2z_authority::AuthoritySet::none`] — and that mode is **reported**, in
//! the signed policy document [`crate::policy`] serves, so a client connecting
//! to such a log can see that handles there are unvouched rather than having to
//! infer it.
//!
//! # Where the assertion is admitted, and where it is refused
//!
//! Exactly at `entry_version == 1`, and nowhere else.
//!
//! Every later entry is authorized by §4.4's own chain: `same_key` by the
//! previously published `directory_auth_pk`, `key_change` by two signatures,
//! `platform_reset` by the pinned reset authority. Those rules are complete,
//! they are the user's own keys rather than the platform's, and admitting an
//! authority assertion alongside them would give the platform a second way to
//! authorize a change to a live handle — which is the power ADR 0014 spent a
//! cooldown, an alarm and a per-epoch counter to constrain. So a submission at
//! `entry_version > 1` carrying assertion bytes is **refused**, not ignored.
//!
//! The same rule runs in the other direction: the envelope's claim fields must
//! be *absent* — an empty assertion and an all-zero signature — above version 1.
//! A field the log skips reading is a field that eventually gets read.
//!
//! [zuu#594]: https://github.com/free2z/zuu/issues/594

use f2z_authority::authority::{AuthorityConfig, Submission, Vouch};
use f2z_authority::nonce::NonceSeen;
use f2z_codec::decode_canonical;
use f2z_codec::types::PublicKey;
use f2z_kt_core::submit::{AcceptedSubmission, PublishedEntry, SubmissionContext, validate_submission};
use f2z_kt_core::{KtError, sig};

use crate::error::{LogError, Result};
use crate::wire::SubmissionEnvelope;

/// A submission that satisfied `KT.md` §4.4 **and** whatever authorizes its
/// handle.
///
/// No public constructor, no `From`, no field access, no bypass flag. The
/// storage layer's publish path takes one of these and nothing else, so
/// "forgot to check the authority" is not a state the server can reach by
/// omission — it takes deleting a call, not failing to write one.
#[derive(Clone, Debug)]
pub struct AdmittedSubmission {
    accepted: AcceptedSubmission,
    vouch: Vouch,
    received_at_ms: u64,
}

impl AdmittedSubmission {
    /// The `f2z-kt-core` verdict, carrying the canonical bytes and the
    /// label/value pair `akd` needs.
    #[must_use]
    pub const fn accepted(&self) -> &AcceptedSubmission {
        &self.accepted
    }

    /// Who vouched for this handle, if anyone.
    ///
    /// [`Vouch::Unvouched`] on a log configured with no authority, and on every
    /// entry after the first — where the vouch that matters was recorded at
    /// version 1 and the chain has carried it since.
    #[must_use]
    pub const fn vouch(&self) -> Vouch {
        self.vouch
    }

    /// The log's clock when the submission was admitted — the receipt's
    /// `received_at_ms` (`KT.md` §5.3).
    #[must_use]
    pub const fn received_at_ms(&self) -> u64 {
        self.received_at_ms
    }
}

/// Everything [`admit_submission`] needs that is not in the submitted bytes.
pub struct AdmissionContext<'a> {
    /// §4.4's policy: the log id, the pinned reset authority key, the published
    /// cooldown.
    pub kt: SubmissionContext<'a>,
    /// Who may vouch for a handle's first entry, and for how long an assertion
    /// stays valid. [`f2z_authority::AuthoritySet::none`] is the explicit
    /// no-authority mode.
    pub authority: &'a AuthorityConfig,
}

/// **Admit a submission, or refuse it.** The only producer of
/// [`AdmittedSubmission`].
///
/// The order is deliberate and it is the order of increasing cost:
///
/// 1. The envelope decodes and re-encodes identically, and its constants are
///    this protocol's.
/// 2. `KT.md` §4.4, in full, via [`f2z_kt_core::validate_submission`] — nine
///    numbered rules over the **bytes that arrived**, not over a structure this
///    module decoded and handed on.
/// 3. The claim fields are populated exactly at `entry_version == 1`.
/// 4. At `entry_version == 1`, [`f2z_authority::AuthorityConfig::admit`] — the
///    assertion, its authority, its validity window, its intent, its nonce, and
///    the identity key's own signature over the binding, which is what makes a
///    stolen assertion useless.
///
/// Step 2 before step 4 matters: the assertion is checked against
/// `entry_version` and `identity_pk` *as validated*, never as claimed, and a
/// submission that fails §4.4 never reaches the nonce ledger and so cannot burn
/// somebody else's nonce.
///
/// # Errors
///
/// - [`LogError::Malformed`] — the envelope did not decode or did not re-encode
///   identically.
/// - [`LogError::Kt`] — any of §4.4's rules. The §9.5 code is
///   `f2z-kt-core`'s.
/// - [`LogError::AssertionOutOfPlace`] — claim fields above version 1, or
///   missing at version 1 on a log that has an authority.
/// - [`LogError::Authority`] — the assertion, its binding, or its nonce.
pub fn admit_submission<S: NonceSeen + ?Sized>(
    envelope_bytes: &[u8],
    context: &AdmissionContext<'_>,
    ledger: &mut S,
) -> Result<AdmittedSubmission> {
    // 1. The envelope itself, under re-encode equality like everything else.
    let decoded = decode_canonical::<SubmissionEnvelope>(envelope_bytes)?;
    let envelope = decoded.value();
    envelope.validate()?;

    // 2. KT.md §4.4, over the bytes that arrived.
    let accepted = validate_submission(envelope.entry.as_slice(), &context.kt)?;
    let entry = accepted.entry();
    let entry_version = entry.entry.entry_version;

    // 3. The claim fields are populated exactly at version 1 — checked in both
    //    directions, so neither a smuggled assertion nor a silently skipped one
    //    is reachable.
    let has_assertion = envelope.assertion_bytes().is_some();
    let has_signature = !envelope.identity_signature.is_zero();
    if entry_version != 1 {
        if has_assertion || has_signature {
            return Err(LogError::AssertionOutOfPlace);
        }
        // §4.4's chain is the authorization from here on. The vouch recorded at
        // version 1 is what the chain has been carrying forward.
        return Ok(AdmittedSubmission {
            accepted,
            vouch: Vouch::Unvouched,
            received_at_ms: context.kt.now_ms,
        });
    }

    // 4. Version 1 — the case KT.md does not specify (zuu#594).
    let handle = f2z_authority::types::Handle::parse(entry.entry.handle.as_slice())
        .map_err(|_| LogError::Kt(KtError::BadHandle))?;
    let identity_pk = entry.entry.identity_pk;
    let entry_digest = *accepted.akd_value();
    let submission = Submission {
        assertion: envelope.assertion_bytes(),
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version,
        entry_digest: &entry_digest,
        identity_signature: &envelope.identity_signature,
        // A first entry has no predecessor, and `validate_submission` has
        // already refused the case where the log is holding one — rule 3's
        // "`entry_version` is `previous + 1` (or 1)". Passing `None` here is a
        // consequence of that check, not an assumption alongside it.
        previous_identity_pk: None,
        previous_account_epoch: None,
    };
    let admitted = context
        .authority
        .admit(&submission, context.kt.now_ms, ledger)?;

    Ok(AdmittedSubmission {
        accepted,
        vouch: admitted.vouch(),
        received_at_ms: context.kt.now_ms,
    })
}

/// Build the binding an `identity_pk` must sign for a first-entry submission.
///
/// A client needs this to *construct* a submission and the log needs it to
/// check one, so it is derived from the same [`AuthorityConfig`] on both sides
/// rather than restated. `assertion` is the decoded assertion, or `None` on a
/// log with no authority.
///
/// # Errors
///
/// [`LogError::Authority`] if the assertion cannot be encoded.
pub fn binding_bytes(
    authority: &AuthorityConfig,
    handle: &f2z_authority::types::Handle,
    identity_pk: &PublicKey,
    assertion: Option<&f2z_authority::HandleAssertion>,
    entry_digest: &f2z_codec::types::Digest,
) -> Result<Vec<u8>> {
    let binding = authority.binding(handle, identity_pk, assertion, entry_digest)?;
    Ok(binding.signing_bytes()?)
}

/// Verify that `identity_pk` really signed the binding for this submission.
///
/// Not used on the admission path — [`f2z_authority::AuthorityConfig::admit`]
/// does it there, and doing it twice would invite the two to drift. It is here
/// for the *client* half and for tests, which need to check a binding they did
/// not construct.
///
/// # Errors
///
/// [`LogError::Kt`] with [`KtError::BadSignature`] if it did not.
pub fn verify_binding(
    authority: &AuthorityConfig,
    handle: &f2z_authority::types::Handle,
    identity_pk: &PublicKey,
    assertion: Option<&f2z_authority::HandleAssertion>,
    entry_digest: &f2z_codec::types::Digest,
    signature: &f2z_codec::types::Signature,
) -> Result<()> {
    let message = binding_bytes(authority, handle, identity_pk, assertion, entry_digest)?;
    sig::verify(identity_pk, &message, signature)?;
    Ok(())
}

/// A previously published entry, in the shape `f2z-kt-core` wants it.
///
/// Re-exported so the storage layer's callers do not have to reach across two
/// crates for the type the choke point takes.
pub type Previous = PublishedEntry;
