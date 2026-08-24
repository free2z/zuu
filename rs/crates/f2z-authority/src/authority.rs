//! The trust root: who may vouch, and the one door an assertion comes through.
//!
//! # The whole of it, in one function
//!
//! [`AuthorityConfig::admit`] is the only public verification path in this
//! crate. There is no `verify_assertion`, no `check_authority_signature`, no
//! `is_expired` — not because those would be hard to write, but because each
//! one would be a route to a *partly* verified assertion, and a caller that
//! reached the end of such a route would have something that looks like a
//! result and is not one. The single door is the design.
//!
//! In particular, **there is no path that checks an assertion without also
//! checking that the identity key it names signed for itself.** An assertion is
//! a bearer document (see [`crate::assertion`]); the binding signature is what
//! makes a stolen copy worthless. `admit` takes both or refuses.
//!
//! # Rotation is set membership
//!
//! [`AuthoritySet`] holds `(authority_id, public key)` entries and nothing
//! else. Adding a new issuing key is adding an entry; retiring one is removing
//! it. There is no rotation *protocol* here, no signed succession message and
//! no chain — deliberately. A rotation ceremony would be a second trust root
//! guarding the first, and this crate exists precisely because the trust root
//! should be the shortest thing in the system to read.
//!
//! # "No authority" is a configuration, and it is reported
//!
//! A self-hoster running a log with no user directory has nobody to vouch for
//! handles. That is a legitimate deployment, and [`AuthoritySet::none`] is how
//! it is spelled — *spelled*, not reached by leaving the set empty, which is
//! [`AuthorityError::EmptyAuthoritySet`] instead.
//!
//! It is not silent. Every admission on such a log returns
//! [`Vouch::Unvouched`], and [`AuthoritySet::status`] answers the same question
//! before a single submission arrives, so a client connecting to the log can
//! learn that `@alice` there means "whoever got there first" rather than
//! "whoever the directory says". A client that renders the two identically has
//! taken the assertion layer away from its user without telling them.
//!
//! What does **not** change on such a log is the identity self-signature. A
//! submitter still answers for its own key; all that is missing is anyone
//! saying which person that key belongs to.

use alloc::vec::Vec;
use core::fmt;

use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{Digest, PublicKey, Signature};

use crate::assertion::{AssertionBindingTBS, HandleAssertion};
use crate::error::{AuthorityError, Result};
use crate::key::VerifyingKey;
use crate::labels::LABEL_ASSERTION_TBS;
use crate::nonce::NonceSeen;
use crate::types::{AuthorityId, Handle, Intent, LogId, authority_id};

/// The default cap on `expires_ms - issued_ms`, in milliseconds: 15 minutes.
///
/// > **Invented here, and a proposed placeholder.** `KT.md` gives no value
/// > because it gives no assertion. The *structure* of the rule — that the log
/// > holds the cap, not the issuer — is what matters, and 15 minutes is chosen
/// > to be long enough for a user to complete a submission after the platform
/// > issued for them and short enough that a captured assertion is stale before
/// > it can be carried anywhere. Measure it before shipping.
pub const DEFAULT_MAX_VALIDITY_MS: u64 = 900_000;

/// The default clock skew allowed on `issued_ms`, in milliseconds: 2 minutes.
///
/// The same value `WIRE.md` §5.5 publishes for the relay's timestamp window,
/// restated rather than shared because it is a different clock relationship
/// between different parties.
pub const DEFAULT_CLOCK_SKEW_MS: u64 = 120_000;

/// One issuing key, and the id derived from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorityKey {
    id: AuthorityId,
    key: PublicKey,
}

impl AuthorityKey {
    /// Adopt an issuing public key, deriving its id.
    ///
    /// The key is not decompressed here. A configured key that is not a curve
    /// point fails at the point of use, as [`AuthorityError::BadAuthoritySignature`],
    /// because that is the only outcome it can ever produce and reporting it
    /// twice would give a caller two things to handle for one fact.
    #[must_use]
    pub fn new(key: PublicKey) -> Self {
        Self {
            id: authority_id(&key),
            key,
        }
    }

    /// Adopt a key that already carries an id, checking that the two agree.
    ///
    /// For a config file that writes both, so that a typo in either is caught
    /// where it was typed.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::AuthorityIdNotDerived`] if `id` is not
    /// `H("free2z/kt/v1/authority-id", key)`.
    pub fn from_parts(id: AuthorityId, key: PublicKey) -> Result<Self> {
        let derived = authority_id(&key);
        if derived != id {
            return Err(AuthorityError::AuthorityIdNotDerived);
        }
        Ok(Self { id, key })
    }

    /// The key id.
    #[must_use]
    pub const fn id(&self) -> AuthorityId {
        self.id
    }

    /// The public key.
    #[must_use]
    pub const fn key(&self) -> PublicKey {
        self.key
    }
}

/// Whether a log has authorities at all, and how many — the answer a client
/// wants *before* it resolves a handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VouchingStatus {
    /// Handles on this log are vouched, by one of this many authorities.
    Vouched {
        /// How many issuing keys are configured.
        authorities: usize,
    },
    /// This log has no user directory. Handles on it are **unvouched**: a
    /// handle means whoever submitted it first, and no party has said which
    /// person that is.
    Unvouched,
}

impl fmt::Display for VouchingStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Vouched { authorities } => {
                write!(f, "handles are vouched by {authorities} authority key(s)")
            }
            Self::Unvouched => {
                f.write_str("handles on this log are UNVOUCHED: no authority attests who owns them")
            }
        }
    }
}

/// Private so that the only ways to build an [`AuthoritySet`] are the two
/// constructors, and "empty" and "no authority" cannot be confused.
#[derive(Clone, Debug, PartialEq, Eq)]
enum SetInner {
    Keys(Vec<AuthorityKey>),
    NoAuthority,
}

/// The configured issuing keys — or an explicit declaration that there are
/// none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthoritySet(SetInner);

impl AuthoritySet {
    /// A set of one or more issuing keys.
    ///
    /// # Errors
    ///
    /// - [`AuthorityError::EmptyAuthoritySet`] if `keys` is empty. An empty set
    ///   is not "no authority": one is a configuration mistake that would
    ///   refuse every submission, the other is a deployment choice that changes
    ///   what a handle *means*, and a constructor that quietly turned the first
    ///   into the second would downgrade a log by typo.
    /// - [`AuthorityError::DuplicateAuthority`] if two entries share an id.
    ///   Since the id is derived, that is the same key twice — harmless in
    ///   itself, and a sign that whoever wrote the config believes they
    ///   configured two independent issuers.
    pub fn new(keys: Vec<AuthorityKey>) -> Result<Self> {
        if keys.is_empty() {
            return Err(AuthorityError::EmptyAuthoritySet);
        }
        for (index, key) in keys.iter().enumerate() {
            if keys
                .iter()
                .skip(index.saturating_add(1))
                .any(|other| other.id() == key.id())
            {
                return Err(AuthorityError::DuplicateAuthority);
            }
        }
        Ok(Self(SetInner::Keys(keys)))
    }

    /// A set of one key. The common case.
    ///
    /// # Errors
    ///
    /// Never, in practice; it shares [`AuthoritySet::new`]'s signature so that
    /// switching between the two is not a refactor.
    pub fn single(key: PublicKey) -> Result<Self> {
        Self::new(alloc::vec![AuthorityKey::new(key)])
    }

    /// **This log has no user directory.** Handles on it are unvouched.
    ///
    /// See the module note: this must be chosen, and it is reported on every
    /// admission.
    #[must_use]
    pub const fn none() -> Self {
        Self(SetInner::NoAuthority)
    }

    /// What a client should be told about this log before it resolves anything.
    #[must_use]
    pub fn status(&self) -> VouchingStatus {
        match &self.0 {
            SetInner::Keys(keys) => VouchingStatus::Vouched {
                authorities: keys.len(),
            },
            SetInner::NoAuthority => VouchingStatus::Unvouched,
        }
    }

    /// Whether any authority vouches for handles here.
    #[must_use]
    pub fn vouches(&self) -> bool {
        matches!(self.0, SetInner::Keys(_))
    }

    /// The configured keys. Empty when there is no authority.
    #[must_use]
    pub fn keys(&self) -> &[AuthorityKey] {
        match &self.0 {
            SetInner::Keys(keys) => keys,
            SetInner::NoAuthority => &[],
        }
    }

    /// The key with this id, if it is configured.
    #[must_use]
    pub fn find(&self, id: AuthorityId) -> Option<&AuthorityKey> {
        self.keys().iter().find(|key| key.id() == id)
    }
}

/// Who vouched for an admitted handle — or that nobody did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use]
pub enum Vouch {
    /// This authority signed for the handle.
    By(AuthorityId),
    /// The log has no authority. Nobody has said who owns this handle; the
    /// submitter proved only that it holds the identity key.
    Unvouched,
}

impl Vouch {
    /// Whether an authority actually vouched.
    #[must_use]
    pub const fn is_vouched(self) -> bool {
        matches!(self, Self::By(_))
    }

    /// The vouching authority, if there was one.
    #[must_use]
    pub const fn authority(self) -> Option<AuthorityId> {
        match self {
            Self::By(id) => Some(id),
            Self::Unvouched => None,
        }
    }
}

impl fmt::Display for Vouch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::By(_) => f.write_str("vouched"),
            Self::Unvouched => f.write_str("UNVOUCHED"),
        }
    }
}

/// A handle whose claim has been fully checked.
///
/// The only way to obtain one is [`AuthorityConfig::admit`], and it has no
/// public constructor and no public fields, so a value of this type in hand is
/// the argument that every rule below ran. It is the same shape `KT.md`'s own
/// implementation uses for `AcceptedSubmission`: the type *is* the proof, so
/// that a later step cannot be reached without it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[must_use]
pub struct AdmittedHandle {
    handle: Handle,
    identity_pk: PublicKey,
    vouch: Vouch,
    intent: Option<Intent>,
    account_epoch: Option<u32>,
}

impl AdmittedHandle {
    /// The handle.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        &self.handle
    }

    /// The identity key it is bound to.
    #[must_use]
    pub const fn identity_pk(&self) -> &PublicKey {
        &self.identity_pk
    }

    /// Who vouched — **check this.** [`Vouch::Unvouched`] is a normal, valid
    /// outcome on a log configured without an authority, and it means something
    /// materially weaker than [`Vouch::By`].
    ///
    /// No `#[must_use]` here: [`Vouch`] already carries one, and clippy's
    /// `double_must_use` is right that repeating it says nothing new.
    pub const fn vouch(&self) -> Vouch {
        self.vouch
    }

    /// The assertion's intent, when there was an assertion.
    #[must_use]
    pub const fn intent(&self) -> Option<Intent> {
        self.intent
    }

    /// The `account_epoch` to record against this handle, when there was an
    /// assertion. Feed it back as [`Submission::previous_account_epoch`] next
    /// time.
    #[must_use]
    pub const fn account_epoch(&self) -> Option<u32> {
        self.account_epoch
    }
}

/// Everything the log holds about one submission, presented together.
///
/// It is one structure rather than a list of arguments so that the
/// `identity_signature` field is *visible* beside the assertion — the pairing
/// is the security property, and an argument list is where a required argument
/// goes to look optional.
#[derive(Clone, Copy)]
pub struct Submission<'a> {
    /// The canonical `tls_codec` bytes of the [`HandleAssertion`], as they
    /// arrived.
    ///
    /// `None` only on a log configured [`AuthoritySet::none`]. On a log with an
    /// authority it is [`AuthorityError::MissingAssertion`]; on a log without
    /// one, `Some` is [`AuthorityError::UnexpectedAssertion`].
    pub assertion: Option<&'a [u8]>,
    /// The `handle` of the accompanying `DirectoryEntry`.
    pub handle: &'a Handle,
    /// The `identity_pk` of the accompanying `DirectoryEntry`.
    pub identity_pk: &'a PublicKey,
    /// The accompanying entry's `entry_version` (`KT.md` §4.2) — the sequence
    /// position the intent is checked against. 1 for a handle's first entry.
    pub entry_version: u32,
    /// The submission's `AkdValue`:
    /// `H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (`KT.md` §3.3).
    pub entry_digest: &'a Digest,
    /// Ed25519 over `tls_codec(AssertionBindingTBS)` by `identity_pk`.
    ///
    /// **Never optional, on any path.** See [`crate::assertion`].
    pub identity_signature: &'a Signature,
    /// The `identity_pk` of the handle's **published previous entry**, or
    /// `None` if this is its first.
    ///
    /// The log must *hold* the predecessor to fill this in; it cannot assert
    /// what the previous key was, exactly as `KT.md` §4.4 rule 4 requires it to
    /// hold the previous entry to check `prev_entry_hash`. It is what rule 14
    /// uses to refuse an assertion spent on an entry that changes nothing —
    /// see [`AuthorityError::IdentityUnchanged`].
    pub previous_identity_pk: Option<&'a PublicKey>,
    /// The `account_epoch` of the last assertion admitted for this handle, or
    /// `None` if this is the first.
    pub previous_account_epoch: Option<u32>,
}

/// Hand-written, and this is the exact case `f2z-codec` documents.
///
/// Every typed field here is already a redacting newtype, so a derived `Debug`
/// looks safe — except `assertion`, which is a bare `&[u8]`. `Debug` for a byte
/// slice renders **a list of decimal integers**: a complete dump of the
/// assertion, containing no hex at all, so a hex-only redaction test passes
/// while every byte leaks. A decimal dump is a dump.
///
/// The bytes are public signed material rather than a secret, which is why this
/// prints a length rather than refusing to exist. What makes it worth redacting
/// anyway is volume and linkability: one log line per submission, each carrying
/// a full assertion naming a handle and an identity key, is a directory
/// reconstructed out of a trace log.
impl fmt::Debug for Submission<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Submission")
            .field(
                "assertion",
                &format_args!(
                    "{}",
                    match self.assertion {
                        Some(bytes) => alloc::format!("Some(<redacted; {} bytes>)", bytes.len()),
                        None => alloc::string::String::from("None"),
                    }
                ),
            )
            .field("handle", &self.handle)
            .field("identity_pk", &self.identity_pk)
            .field("entry_version", &self.entry_version)
            .field("entry_digest", &self.entry_digest)
            .field("identity_signature", &self.identity_signature)
            .field("previous_identity_pk", &self.previous_identity_pk)
            .field("previous_account_epoch", &self.previous_account_epoch)
            .finish()
    }
}

/// A log's assertion policy: which log it is, who may vouch, and how long an
/// assertion may live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityConfig {
    log_id: LogId,
    authorities: AuthoritySet,
    max_validity_ms: u64,
    clock_skew_ms: u64,
}

impl AuthorityConfig {
    /// Build a policy.
    ///
    /// `max_validity_ms` is **the log's own** cap on `expires_ms - issued_ms`.
    /// It is not read from the assertion and it is not negotiated: an issuer
    /// that could choose its own validity would, once compromised, mint one
    /// assertion good for a decade, and every later rotation of the authority
    /// set would leave that assertion working. Capping it here is what bounds
    /// the blast radius of a compromised issuer to the cap.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::InvalidPolicy`] if `max_validity_ms` is zero — which
    /// would refuse every assertion — or if the cap and the skew together
    /// cannot be represented.
    pub fn new(
        log_id: LogId,
        authorities: AuthoritySet,
        max_validity_ms: u64,
        clock_skew_ms: u64,
    ) -> Result<Self> {
        if max_validity_ms == 0 || max_validity_ms.checked_add(clock_skew_ms).is_none() {
            return Err(AuthorityError::InvalidPolicy);
        }
        Ok(Self {
            log_id,
            authorities,
            max_validity_ms,
            clock_skew_ms,
        })
    }

    /// A policy with [`DEFAULT_MAX_VALIDITY_MS`] and [`DEFAULT_CLOCK_SKEW_MS`].
    ///
    /// # Errors
    ///
    /// As [`AuthorityConfig::new`]; never, with these constants.
    pub fn with_defaults(log_id: LogId, authorities: AuthoritySet) -> Result<Self> {
        Self::new(
            log_id,
            authorities,
            DEFAULT_MAX_VALIDITY_MS,
            DEFAULT_CLOCK_SKEW_MS,
        )
    }

    /// The log this policy is for.
    #[must_use]
    pub const fn log_id(&self) -> LogId {
        self.log_id
    }

    /// The configured authorities.
    #[must_use]
    pub const fn authorities(&self) -> &AuthoritySet {
        &self.authorities
    }

    /// What a client should be told about this log. See [`VouchingStatus`].
    #[must_use]
    pub fn status(&self) -> VouchingStatus {
        self.authorities.status()
    }

    /// The log's cap on an assertion's validity window.
    #[must_use]
    pub const fn max_validity_ms(&self) -> u64 {
        self.max_validity_ms
    }

    /// The allowance on `issued_ms` being ahead of this clock.
    ///
    /// It is deliberately **not** applied to `expires_ms`: an assertion is
    /// refused the moment this clock reaches its expiry. The asymmetry is
    /// fail-closed — a verifier whose clock runs fast refuses a little early
    /// rather than accepting a little late — and it keeps the widest window any
    /// assertion can be accepted in at `max_validity_ms + clock_skew_ms`, which
    /// is a number an operator can state.
    #[must_use]
    pub const fn clock_skew_ms(&self) -> u64 {
        self.clock_skew_ms
    }

    /// The transcript the submitter's identity key must sign, built from this
    /// policy so that the signer and the verifier cannot disagree about it.
    ///
    /// Pass the assertion the submission carries, or `None` on a log with no
    /// authority.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the assertion cannot be encoded.
    pub fn binding(
        &self,
        handle: &Handle,
        identity_pk: &PublicKey,
        assertion: Option<&HandleAssertion>,
        entry_digest: &Digest,
    ) -> Result<AssertionBindingTBS> {
        let assertion_digest = match assertion {
            Some(assertion) => assertion.digest()?,
            None => Digest::zero(),
        };
        AssertionBindingTBS::for_assertion(
            self.log_id,
            handle.clone(),
            *identity_pk,
            assertion_digest,
            *entry_digest,
        )
    }

    /// Judge a submission. **The only verification path in this crate.**
    ///
    /// The rules, in the order they run — cheap and flood-resistant first,
    /// signatures next, and the one rule that mutates state last, so that a
    /// submission which fails anything never burns a nonce:
    ///
    /// 1. An assertion is present iff this log has an authority.
    /// 2. The bytes decode **and re-encode identically** (`WIRE.md` §3.3).
    /// 3. `label` is exactly `free2z/kt/v1/handle-assertion`.
    /// 4. `log_id` is this log's.
    /// 5. `handle_id` is the digest of `handle` — the assertion agrees with
    ///    itself.
    /// 6. `handle` is the submission's handle, compared as bytes. Charset
    ///    conformance is a type invariant of [`Handle`]: bytes that are not
    ///    `[a-z0-9_]{1,30}` never decode into one, so there is no state in
    ///    which a non-conforming handle reaches this rule.
    /// 7. `identity_pk` is the submission's identity key. An assertion about
    ///    one key cannot authorize another.
    /// 8. `expires_ms > issued_ms`.
    /// 9. `expires_ms - issued_ms <= max_validity_ms`, **this log's** cap.
    /// 10. `issued_ms` is not further ahead than `clock_skew_ms`.
    /// 11. `now_ms < expires_ms`.
    /// 12. `authority_id` is in the configured set.
    /// 13. The authority's signature verifies, strictly, over the re-encoded
    ///     body.
    /// 14. `intent` matches the sequence position: `bind` iff
    ///     `entry_version == 1` and there is no predecessor, `reset` iff
    ///     `entry_version > 1` and there is one — **and a `reset` actually
    ///     replaces the predecessor's `identity_pk`.** That last clause is the
    ///     stricter reading of `KT.md` §4.4; see
    ///     [`AuthorityError::IdentityUnchanged`].
    /// 15. `account_epoch` is strictly greater than the last one admitted for
    ///     this handle.
    /// 16. **The identity key signed the binding.** Without this a stolen
    ///     assertion is usable by the thief; with it, it is useless.
    /// 17. `(authority_id, nonce)` has not been admitted before.
    ///
    /// On a log with no authority, rules 2–15 and 17 have nothing to run
    /// against and rule 16 is the whole check — the submitter proves it holds
    /// the identity key, and the result says [`Vouch::Unvouched`].
    ///
    /// # Errors
    ///
    /// One [`AuthorityError`] per rule; see that type for the `KT.md` §9.5 code
    /// each travels as.
    pub fn admit<S: NonceSeen + ?Sized>(
        &self,
        submission: &Submission<'_>,
        now_ms: u64,
        ledger: &mut S,
    ) -> Result<AdmittedHandle> {
        // 1. Presence, both directions.
        let Some(bytes) = submission.assertion else {
            if self.authorities.vouches() {
                return Err(AuthorityError::MissingAssertion);
            }
            return self.admit_unvouched(submission);
        };
        if !self.authorities.vouches() {
            return Err(AuthorityError::UnexpectedAssertion);
        }

        // 2. Re-encode equality. The re-encoded bytes — never the received
        //    ones — are what the signature is checked over.
        let decoded = decode_canonical::<HandleAssertion>(bytes)?;
        let assertion = decoded.value();
        let body = &assertion.assertion;

        // 3-7. The assertion agrees with itself and with the submission.
        if body.label.as_slice() != LABEL_ASSERTION_TBS {
            return Err(AuthorityError::WrongLabel);
        }
        if body.log_id != self.log_id {
            return Err(AuthorityError::WrongLog);
        }
        if body.handle_id != body.handle.handle_id() {
            return Err(AuthorityError::HandleIdMismatch);
        }
        if body.handle.as_bytes() != submission.handle.as_bytes() {
            return Err(AuthorityError::HandleMismatch);
        }
        if body.identity_pk != *submission.identity_pk {
            return Err(AuthorityError::IdentityMismatch);
        }

        // 8-11. Time.
        let Some(validity_ms) = body.expires_ms.checked_sub(body.issued_ms) else {
            return Err(AuthorityError::EmptyValidity);
        };
        if validity_ms == 0 {
            return Err(AuthorityError::EmptyValidity);
        }
        if validity_ms > self.max_validity_ms {
            return Err(AuthorityError::ValidityTooLong);
        }
        if body.issued_ms > now_ms.saturating_add(self.clock_skew_ms) {
            return Err(AuthorityError::NotYetIssued);
        }
        if now_ms >= body.expires_ms {
            return Err(AuthorityError::Expired);
        }

        // 12-13. The authority, and its signature over this exact body.
        let key = self
            .authorities
            .find(body.authority_id)
            .ok_or(AuthorityError::UnknownAuthority)?;
        VerifyingKey::from_public_key(&key.key(), AuthorityError::BadAuthoritySignature)?.verify(
            &body.signing_bytes()?,
            &assertion.signature,
            AuthorityError::BadAuthoritySignature,
        )?;

        // 14. Intent against the sequence position, and against the
        //     predecessor the log is holding.
        let expected = match submission.entry_version {
            0 => return Err(AuthorityError::IntentMismatch),
            1 => Intent::Bind,
            _ => Intent::Reset,
        };
        if body.intent != expected {
            return Err(AuthorityError::IntentMismatch);
        }
        match (expected, submission.previous_identity_pk) {
            // A first entry has no predecessor. If the log is holding one, the
            // version and the state disagree and nothing here can say which is
            // right.
            (Intent::Bind, None) => {}
            (Intent::Bind, Some(_)) | (Intent::Reset, None) => {
                return Err(AuthorityError::IntentMismatch);
            }
            // ADR 0014's reset replaces a key. One that does not is an
            // assertion spent on a no-op — the §4.4 boundary this crate takes
            // the stricter reading of.
            (Intent::Reset, Some(previous)) => {
                if *previous == body.identity_pk {
                    return Err(AuthorityError::IdentityUnchanged);
                }
            }
        }

        // 15. Account-epoch monotonicity. Strict: a reset is a distinct
        //     account-ownership event, so an assertion for an epoch already
        //     seen is one that has already been spent.
        if let Some(previous) = submission.previous_account_epoch
            && body.account_epoch <= previous
        {
            return Err(AuthorityError::AccountEpochRegression);
        }

        // 16. The rule that makes the whole thing sound.
        self.verify_binding(submission, Some(assertion))?;

        // 17. Last, and the only step that writes.
        ledger.observe(now_ms, body.authority_id, body.nonce, body.expires_ms)?;

        Ok(AdmittedHandle {
            handle: body.handle.clone(),
            identity_pk: body.identity_pk,
            vouch: Vouch::By(body.authority_id),
            intent: Some(body.intent),
            account_epoch: Some(body.account_epoch),
        })
    }

    /// The no-authority path. Private, and reachable only when
    /// [`AuthoritySet::none`] was configured *and* no assertion was presented,
    /// so it is not a bypass of the vouched path — it is the other half of rule
    /// 1.
    fn admit_unvouched(&self, submission: &Submission<'_>) -> Result<AdmittedHandle> {
        self.verify_binding(submission, None)?;
        Ok(AdmittedHandle {
            handle: submission.handle.clone(),
            identity_pk: *submission.identity_pk,
            vouch: Vouch::Unvouched,
            intent: None,
            account_epoch: None,
        })
    }

    /// Rule 16, shared by both paths so that neither can be written without it.
    fn verify_binding(
        &self,
        submission: &Submission<'_>,
        assertion: Option<&HandleAssertion>,
    ) -> Result<()> {
        let binding = self.binding(
            submission.handle,
            submission.identity_pk,
            assertion,
            submission.entry_digest,
        )?;
        VerifyingKey::from_public_key(submission.identity_pk, AuthorityError::BadIdentitySignature)?
            .verify(
                &binding.signing_bytes()?,
                submission.identity_signature,
                AuthorityError::BadIdentitySignature,
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SigningKey;
    use crate::nonce::NonceLedger;
    use crate::types::AuthorityId;

    #[test]
    fn an_empty_set_is_not_no_authority() {
        assert_eq!(
            AuthoritySet::new(Vec::new()).unwrap_err(),
            AuthorityError::EmptyAuthoritySet
        );
        assert_eq!(AuthoritySet::none().status(), VouchingStatus::Unvouched);
        assert!(!AuthoritySet::none().vouches());
    }

    #[test]
    fn the_same_key_twice_is_a_duplicate() {
        let key = SigningKey::from_seed(&[1u8; 32]).public_key();
        assert_eq!(
            AuthoritySet::new(alloc::vec![AuthorityKey::new(key), AuthorityKey::new(key)])
                .unwrap_err(),
            AuthorityError::DuplicateAuthority
        );
    }

    #[test]
    fn rotation_is_set_membership_and_nothing_else() {
        let old = SigningKey::from_seed(&[1u8; 32]).public_key();
        let new = SigningKey::from_seed(&[2u8; 32]).public_key();
        let both =
            AuthoritySet::new(alloc::vec![AuthorityKey::new(old), AuthorityKey::new(new)]).unwrap();
        assert_eq!(both.status(), VouchingStatus::Vouched { authorities: 2 });
        assert!(both.find(authority_id(&old)).is_some());
        assert!(both.find(authority_id(&new)).is_some());

        let retired = AuthoritySet::single(new).unwrap();
        assert!(retired.find(authority_id(&old)).is_none());
    }

    #[test]
    fn a_mistyped_key_id_is_caught_where_it_was_typed() {
        let key = SigningKey::from_seed(&[1u8; 32]).public_key();
        assert!(AuthorityKey::from_parts(authority_id(&key), key).is_ok());
        assert_eq!(
            AuthorityKey::from_parts(AuthorityId::new([0u8; 32]), key).unwrap_err(),
            AuthorityError::AuthorityIdNotDerived
        );
    }

    #[test]
    fn a_zero_validity_cap_is_refused() {
        let set = AuthoritySet::none();
        assert_eq!(
            AuthorityConfig::new(LogId::new([1u8; 32]), set.clone(), 0, 0).unwrap_err(),
            AuthorityError::InvalidPolicy
        );
        assert_eq!(
            AuthorityConfig::new(LogId::new([1u8; 32]), set, u64::MAX, 1).unwrap_err(),
            AuthorityError::InvalidPolicy
        );
    }

    #[test]
    fn a_log_with_no_authority_refuses_an_assertion_rather_than_ignoring_it() {
        let config =
            AuthorityConfig::with_defaults(LogId::new([1u8; 32]), AuthoritySet::none()).unwrap();
        let handle = Handle::parse(b"alice").unwrap();
        let identity = SigningKey::from_seed(&[3u8; 32]);
        let mut ledger = NonceLedger::new(8, DEFAULT_CLOCK_SKEW_MS);
        let submission = Submission {
            assertion: Some(&[0u8; 4]),
            handle: &handle,
            identity_pk: &identity.public_key(),
            entry_version: 1,
            entry_digest: &Digest::new([7u8; 32]),
            identity_signature: &Signature::new([0u8; 64]),
            previous_identity_pk: None,
            previous_account_epoch: None,
        };
        assert_eq!(
            config.admit(&submission, 0, &mut ledger).unwrap_err(),
            AuthorityError::UnexpectedAssertion
        );
    }

    #[test]
    fn a_log_with_an_authority_refuses_a_submission_with_no_assertion() {
        let authority = SigningKey::from_seed(&[1u8; 32]);
        let config = AuthorityConfig::with_defaults(
            LogId::new([1u8; 32]),
            AuthoritySet::single(authority.public_key()).unwrap(),
        )
        .unwrap();
        let handle = Handle::parse(b"alice").unwrap();
        let identity = SigningKey::from_seed(&[3u8; 32]);
        let mut ledger = NonceLedger::new(8, DEFAULT_CLOCK_SKEW_MS);
        let submission = Submission {
            assertion: None,
            handle: &handle,
            identity_pk: &identity.public_key(),
            entry_version: 1,
            entry_digest: &Digest::new([7u8; 32]),
            identity_signature: &Signature::new([0u8; 64]),
            previous_identity_pk: None,
            previous_account_epoch: None,
        };
        assert_eq!(
            config.admit(&submission, 0, &mut ledger).unwrap_err(),
            AuthorityError::MissingAssertion
        );
    }

    #[test]
    fn an_unvouched_log_still_requires_the_identity_to_answer_for_itself() {
        let config =
            AuthorityConfig::with_defaults(LogId::new([1u8; 32]), AuthoritySet::none()).unwrap();
        let handle = Handle::parse(b"alice").unwrap();
        let identity = SigningKey::from_seed(&[3u8; 32]);
        let entry_digest = Digest::new([7u8; 32]);
        let mut ledger = NonceLedger::new(8, DEFAULT_CLOCK_SKEW_MS);

        let binding = config
            .binding(&handle, &identity.public_key(), None, &entry_digest)
            .unwrap();
        let signature = binding.sign(&identity).unwrap();

        let admitted = config
            .admit(
                &Submission {
                    assertion: None,
                    handle: &handle,
                    identity_pk: &identity.public_key(),
                    entry_version: 1,
                    entry_digest: &entry_digest,
                    identity_signature: &signature,
                    previous_identity_pk: None,
                    previous_account_epoch: None,
                },
                0,
                &mut ledger,
            )
            .unwrap();
        assert_eq!(admitted.vouch(), Vouch::Unvouched);
        assert!(!admitted.vouch().is_vouched());
        assert_eq!(admitted.intent(), None);

        // …and a wrong signature is still fatal there.
        assert_eq!(
            config
                .admit(
                    &Submission {
                        assertion: None,
                        handle: &handle,
                        identity_pk: &identity.public_key(),
                        entry_version: 1,
                        entry_digest: &entry_digest,
                        identity_signature: &Signature::new([0u8; 64]),
                        previous_identity_pk: None,
                        previous_account_epoch: None,
                    },
                    0,
                    &mut ledger,
                )
                .unwrap_err(),
            AuthorityError::BadIdentitySignature
        );
    }
}
