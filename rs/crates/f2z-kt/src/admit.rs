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
//! # Two checks, and neither is sufficient alone
//!
//! | Layer | What it decides | What it explicitly does **not** |
//! |---|---|---|
//! | [`f2z_kt_core::validate_submission`] | every rule in `KT.md` §4.4 — the chain, the signatures, the rotation proof, the reset cooldown, the device credentials, §4.3's uniqueness | who is allowed to claim a handle that has no previous entry (zuu#594) |
//! | [`f2z_authority::AuthorityConfig::check_assertion_layer`] | the handle-ownership assertion, its authority, validity window, intent, nonce, and the identity key's signature over the binding | §4.4 itself — the crate's own documentation calls its result *"deliberately **not** an authorization-to-publish token"* |
//!
//! [`AdmittedSubmission`] is the conjunction, and it is the only thing
//! [`crate::log::LogService`] will publish. Running one check without the other
//! is not a state this server can reach by omission.
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
//! authority for a first entry. That is `f2z-authority`'s **unratified
//! candidate**, offered against #594 rather than merged protocol — the crate
//! says so of its own `EntryKind::InitialBind`, and this server says so too, in
//! the signed policy document [`crate::policy`] serves. Self-hosters who have
//! no authority configure [`f2z_authority::AuthoritySet::none`], and that mode
//! is **reported**, so a client connecting to such a log can see that handles
//! there are unvouched rather than having to infer it.
//!
//! # Where an assertion is required, and where it is a category error
//!
//! The boundary is `f2z-authority`'s, and this module's job is to hand it the
//! right [`AuthorityEntryKind`] rather than to re-decide it:
//!
//! | Entry | Assertion on a vouched log |
//! |---|---|
//! | first entry (`entry_version == 1`) | **required** — zuu#594's gap |
//! | `same_key`, `key_change` | **refused.** These are user-authorized under §4.4 by the previous `directory_auth_pk` and, for a rotation, the outgoing identity key. Admitting a platform assertion here would give the platform a second way to authorize a change to a live handle — the power ADR 0014 spent a cooldown, an alarm and a per-epoch counter to constrain. |
//! | `platform_reset` | **required**, alongside §4.4's `ResetAuthorization`. |
//!
//! [zuu#594]: https://github.com/free2z/zuu/issues/594

use f2z_authority::authority::{
    AuthorityConfig, EntryKind as AuthorityEntryKind, Submission, Vouch,
};
use f2z_authority::nonce::NonceSeen;
use f2z_codec::decode_canonical;
use f2z_codec::types::PublicKey;
use f2z_kt_core::api::SubmissionEnvelope;
use f2z_kt_core::entry::EntryKind;
use f2z_kt_core::submit::{
    AcceptedSubmission, PublishedEntry, SubmissionContext, validate_submission,
};
use f2z_kt_core::{KtError, sig};

use crate::error::{LogError, Result};

/// What the log retains about a handle between entries, beyond §4.4's own
/// `PublishedEntry`.
///
/// `f2z-authority` requires both of these back on every non-initial submission
/// — `previous_vouch` so that a routine entry carries its predecessor's
/// vouching state forward rather than silently upgrading it, and
/// `previous_account_epoch` so that a platform assertion cannot be spent twice
/// on one account-ownership event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HandleVouch {
    /// Who vouched for this handle, recorded at its first entry and carried
    /// forward unchanged by every routine update.
    pub vouch: Vouch,
    /// The `account_epoch` retained for this handle.
    pub account_epoch: u32,
}

/// A submission that satisfied `KT.md` §4.4 **and** the handle-assertion layer.
///
/// No public constructor, no `From`, no field access, no bypass flag. The
/// storage layer's publish path takes one of these and nothing else, so
/// "forgot to check the authority" is not a state the server can reach by
/// omission — it takes deleting a call, not failing to write one.
#[derive(Clone, Debug)]
pub struct AdmittedSubmission {
    accepted: AcceptedSubmission,
    vouch: HandleVouch,
    received_at_ms: u64,
}

impl AdmittedSubmission {
    /// The `f2z-kt-core` verdict, carrying the canonical bytes and the
    /// label/value pair `akd` needs.
    #[must_use]
    pub const fn accepted(&self) -> &AcceptedSubmission {
        &self.accepted
    }

    /// What to retain for this handle, to be fed back as
    /// [`Submission::previous_vouch`] and
    /// [`Submission::previous_account_epoch`] next time.
    #[must_use]
    pub const fn vouch(&self) -> HandleVouch {
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
    /// cooldown, and what the log has already published for this handle.
    pub kt: SubmissionContext<'a>,
    /// Who may vouch for a handle, and for how long an assertion stays valid.
    /// [`f2z_authority::AuthoritySet::none`] is the explicit no-authority mode.
    pub authority: &'a AuthorityConfig,
    /// What the log retained for this handle, or `None` if it has never been
    /// registered. Must agree with [`SubmissionContext::previous`]: both are
    /// derived from the same published entry.
    pub retained: Option<HandleVouch>,
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
/// 3. The assertion layer, via
///    [`f2z_authority::AuthorityConfig::check_assertion_layer`], against the
///    entry kind and predecessor state **as validated**, never as claimed.
///
/// Step 2 before step 3 matters twice over: the assertion is checked against an
/// `entry_version`, an `identity_pk` and a predecessor that §4.4 has already
/// agreed to, and a submission that fails §4.4 never reaches the nonce ledger
/// and so cannot burn somebody else's nonce.
///
/// # Errors
///
/// - [`LogError::Malformed`] — the envelope did not decode or did not re-encode
///   identically.
/// - [`LogError::Kt`] — any of §4.4's rules. The §9.5 code is
///   `f2z-kt-core`'s.
/// - [`LogError::Authority`] — the assertion, its binding, or its nonce.
/// - [`LogError::Config`] — the log's own retained state disagrees with what it
///   published, which is a bug here rather than a fault of the submitter.
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

    // The two views of "what came before" must agree. They are both derived
    // from the same published entry, so a disagreement is this server losing
    // track of its own state — never something a submitter can cause, and
    // never something to resolve by picking one.
    if context.kt.previous.is_some() != context.retained.is_some() {
        return Err(LogError::Config(
            "the retained vouch and the published predecessor disagree about whether this handle \
             exists"
                .to_owned(),
        ));
    }

    // 3. The assertion layer. The kind it is told is the kind §4.4 validated,
    //    and `entry_version == 1` is what makes it an initial bind — the case
    //    KT.md does not specify (zuu#594).
    let kind = if entry.entry.entry_version == 1 {
        AuthorityEntryKind::InitialBind
    } else {
        match entry.entry.kind {
            EntryKind::SameKey => AuthorityEntryKind::SameKey,
            EntryKind::KeyChange => AuthorityEntryKind::KeyChange,
            EntryKind::PlatformReset => AuthorityEntryKind::PlatformReset,
            // `EntryKind` is `#[non_exhaustive]`. A kind added to KT.md §4.4
            // later must not silently fall through to the routine path, which
            // is the one that requires no platform assertion — so it is a
            // refusal until this match is updated deliberately.
            _ => return Err(LogError::Kt(KtError::BadAuthorization)),
        }
    };

    let handle = f2z_authority::types::Handle::parse(entry.entry.handle.as_slice())
        .map_err(|_| LogError::Kt(KtError::BadHandle))?;
    let identity_pk = entry.entry.identity_pk;
    let entry_digest = *accepted.akd_value();
    let previous_identity_pk = context.kt.previous.map(PublishedEntry::identity_pk);

    let submission = Submission {
        assertion: envelope.assertion_bytes(),
        kind,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: entry.entry.entry_version,
        entry_digest: &entry_digest,
        identity_signature: &envelope.identity_signature,
        previous_identity_pk,
        previous_vouch: context.retained.map(|retained| retained.vouch),
        previous_account_epoch: context.retained.map(|retained| retained.account_epoch),
    };
    let checked =
        context
            .authority
            .check_assertion_layer(&submission, context.kt.now_ms, ledger)?;

    Ok(AdmittedSubmission {
        accepted,
        vouch: HandleVouch {
            vouch: checked.vouch(),
            account_epoch: checked.account_epoch(),
        },
        received_at_ms: context.kt.now_ms,
    })
}

/// Build the binding an `identity_pk` must sign for a submission.
///
/// A client needs this to *construct* a submission and the log needs it to
/// check one, so it is derived from the same [`AuthorityConfig`] on both sides
/// rather than restated. `assertion` is the decoded assertion, or `None` where
/// the entry kind does not carry one.
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
/// Not used on the admission path — `check_assertion_layer` does it there, on
/// every path, and doing it twice would invite the two to drift. It is here for
/// the *client* half and for tests, which need to check a binding they did not
/// construct.
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
