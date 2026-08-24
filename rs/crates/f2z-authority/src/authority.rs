//! The trust root: who may vouch, and the one door an assertion comes through.
//!
//! # The whole of it, in one function
//!
//! [`AuthorityConfig::check_assertion_layer`] is the only public verification
//! path for this experimental assertion proposal. There is no
//! `verify_assertion`, no `check_authority_signature`, and no `is_expired`:
//! those narrower helpers would make it easy to mistake one successful rule
//! for the complete assertion-layer check. The single assertion-layer door is
//! the design. Even its result is explicitly partial with respect to the
//! directory's separate entry-authorization rules.
//!
//! In particular, **there is no path that checks an assertion without also
//! checking that the identity key it names signed for itself.** An assertion is
//! a bearer document (see [`crate::assertion`]); the binding signature is what
//! makes a stolen copy worthless. `check_assertion_layer` takes both or refuses.
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
//! This proposal models a self-hosted log with no user directory through
//! [`AuthoritySet::none`]. `KT.md` does not ratify that behavior; #594 remains
//! open. It is *spelled*, not reached by leaving the set empty, which is
//! [`AuthorityError::EmptyAuthoritySet`] instead.
//!
//! It is not silent. Every successful assertion-layer check on such a log returns
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

/// The exclusive upper bound on `account_epoch`: 2^20.
///
/// `KT.md` §4.5.4 requires `account_epoch` to be a **durable per-account
/// counter** and forbids deriving it from a clock, because a monotonic clock
/// satisfies A15's "strictly greater than the last one" unconditionally and
/// forever — which does not weaken A15, it deletes it while leaving a field in
/// place that looks like it is doing the work.
///
/// A15 alone cannot notice, so A18 refuses the value on its face. The ceiling
/// is what an account-ownership counter can plausibly reach: an account that
/// changed hands or was recovered a million times is not an account. Unix time
/// in whole seconds has exceeded this since 1970-01-13, and Unix milliseconds
/// do not fit a `uint32` at all, so the specific non-conformance §4.5.4 names
/// is refused at the first assertion an issuer mints — before any predecessor
/// exists to compare against.
///
/// **This is necessary, not sufficient, and the gap is stated rather than
/// papered over.** A clock at a coarse granularity — days since the epoch is
/// about 20,700 — passes the ceiling, and no check on a single `u32` can prove
/// the value came from durable storage. [`MAX_ACCOUNT_EPOCH_STEP`] closes most
/// of what is left; what remains is the issuer's obligation, stated in §4.5.4
/// and in this crate's module documentation.
pub const ACCOUNT_EPOCH_CEILING: u32 = 1 << 20;

/// The largest advance in `account_epoch` between two assertions admitted for
/// one handle: 16.
///
/// A counter increments once per account-ownership event, and only events whose
/// assertion never reached the log accumulate slack, so the gap between two
/// *admitted* assertions is a handful at most. A clock's gap is however much
/// time passed between the two issuances, at whatever granularity the clock
/// runs.
///
/// Together with [`ACCOUNT_EPOCH_CEILING`] this leaves a clock only one narrow
/// band to hide in — fine enough to tick between two issuances, coarse enough
/// that it ticks at most 16 times, and small enough in absolute terms to stay
/// under the ceiling. It is a fixed constant rather than a published policy
/// number deliberately: the same bound on every log is one a client can apply
/// without first fetching a policy document, and unlike
/// [`AuthorityConfig::max_validity_ms`] there is no operational reason for two
/// logs to disagree about it.
///
/// [`AuthorityConfig::max_validity_ms`]: AuthorityConfig::max_validity_ms
pub const MAX_ACCOUNT_EPOCH_STEP: u32 = 16;

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

    /// **Experimental proposal:** this log has no user directory, so handles
    /// on it are unvouched. `KT.md` has not ratified this mode (#594).
    ///
    /// See the module note: this must be chosen, and it is reported on every
    /// assertion-layer check.
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

/// The vouching state carried by this assertion-layer check.
///
/// For a routine entry this value is copied from [`Submission::previous_vouch`]
/// and is **not verified by this crate**. The directory integration must derive
/// it from the verified predecessor history; current authority configuration
/// is not evidence that this particular handle was ever vouched.
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

/// Why this directory entry exists.
///
/// The last three variants are `KT.md`'s `EntryKind`. [`InitialBind`] names
/// this crate's **unratified candidate** for the first-entry case that `KT.md`
/// and #594 deliberately leave open. It must not be read as merged protocol.
///
/// [`InitialBind`]: Self::InitialBind
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    /// The handle's first entry.
    InitialBind,
    /// A routine update that retains the identity key.
    SameKey,
    /// A user-authorized identity-key rotation.
    KeyChange,
    /// The exceptional platform-authorized reset path.
    PlatformReset,
}

/// The result of checking only this crate's experimental assertion layer.
///
/// This is deliberately **not** an authorization-to-publish token. In
/// particular, for `same_key` and `key_change` this crate does not parse or
/// verify `KT.md` §4.4's `EntryAuthorization`, the prior DirectoryAuthKey
/// signature, or a `RotationProof`. The directory integration must verify
/// those independently before accepting the entry. The type name keeps that
/// partial boundary visible at every call site.
#[derive(Clone, Debug, PartialEq, Eq)]
#[must_use]
pub struct AssertionLayerCheck {
    handle: Handle,
    identity_pk: PublicKey,
    kind: EntryKind,
    vouch: Vouch,
    intent: Option<Intent>,
    account_epoch: u32,
}

impl AssertionLayerCheck {
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

    /// The directory entry kind whose assertion-layer subset was checked.
    #[must_use]
    pub const fn kind(&self) -> EntryKind {
        self.kind
    }

    /// Who vouched — **check this.** [`Vouch::Unvouched`] is a normal, valid
    /// outcome on a log configured without an authority, and it means something
    /// materially weaker than [`Vouch::By`].
    ///
    /// On a routine entry this is the exact predecessor value supplied by the
    /// caller, not a fresh verdict from this crate.
    ///
    /// No `#[must_use]` here: [`Vouch`] already carries one, and clippy's
    /// `double_must_use` is right that repeating it says nothing new.
    pub const fn vouch(&self) -> Vouch {
        self.vouch
    }

    /// The assertion's intent, when this entry required a platform assertion.
    #[must_use]
    pub const fn intent(&self) -> Option<Intent> {
        self.intent
    }

    /// The `account_epoch` to retain for this handle. A platform assertion
    /// advances it; a routine entry carries the required previous value
    /// forward. The experimental unvouched initial path starts at zero. Feed
    /// it back as [`Submission::previous_account_epoch`] next time.
    #[must_use]
    pub const fn account_epoch(&self) -> u32 {
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
    /// Present only for [`EntryKind::InitialBind`] or
    /// [`EntryKind::PlatformReset`] on a vouched log. Routine
    /// [`EntryKind::SameKey`] and [`EntryKind::KeyChange`] entries are
    /// user-authorized and reject a platform assertion as a category error.
    pub assertion: Option<&'a [u8]>,
    /// The authorization case this submission's directory entry declares.
    pub kind: EntryKind,
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
    /// The vouching state recorded with the verified predecessor, or `None`
    /// only for the first entry.
    ///
    /// This crate checks presence and preserves the exact value on routine
    /// entries; it cannot verify predecessor history itself.
    pub previous_vouch: Option<Vouch>,
    /// The predecessor's retained `account_epoch`, or `None` only if this is
    /// the first entry. Every non-initial entry must carry it, including an
    /// unvouched history whose experimental baseline is zero.
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
            .field("kind", &self.kind)
            .field("entry_version", &self.entry_version)
            .field("entry_digest", &self.entry_digest)
            .field("identity_signature", &self.identity_signature)
            .field("previous_identity_pk", &self.previous_identity_pk)
            .field("previous_vouch", &self.previous_vouch)
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
    /// Pass the assertion the submission carries, or `None` for an unvouched
    /// initial bind and for `same_key`/`key_change`; their separate user
    /// authorization is outside this crate.
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

    /// Check this crate's experimental assertion layer.
    ///
    /// The returned [`AssertionLayerCheck`] is partial, not permission to
    /// publish a directory entry. `same_key` and `key_change` still require the
    /// caller to verify all of `KT.md` §4.4, including the prior
    /// DirectoryAuthKey signature and (for `key_change`) the outgoing identity
    /// key's `RotationProof`. This crate has neither structure and cannot judge
    /// either one.
    ///
    /// The rules, in the order they run — cheap and flood-resistant first,
    /// signatures next, and the one rule that mutates state last, so that a
    /// submission which fails anything never burns a nonce:
    ///
    /// 1. An assertion is present iff this is an initial bind or platform
    ///    reset on a vouched log. `same_key` and `key_change` must be
    ///    authorized separately under `KT.md` §4.4 and must not require the
    ///    platform here.
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
    /// 14. `intent` matches the entry kind: `bind` for an initial claim and
    ///     `reset` for `platform_reset`; the discriminator's separate shape
    ///     check holds both to the sequence and predecessor, including that a
    ///     reset actually replaces the predecessor's `identity_pk`.
    /// 15. Every non-initial entry supplies its predecessor's retained
    ///     `account_epoch`; a platform assertion's epoch is strictly greater.
    /// 16. **The identity key signed the binding.** Without this a stolen
    ///     assertion is usable by the thief; with it, it is useless.
    /// 17. `(authority_id, nonce)` has not been admitted before.
    /// 18. **`account_epoch` moved like a counter, not like a clock** — it is
    ///     below [`ACCOUNT_EPOCH_CEILING`] and, where there is a predecessor,
    ///     advanced by at most [`MAX_ACCOUNT_EPOCH_STEP`]. Rule 15 is
    ///     satisfiable *unconditionally* by any monotonic clock, so without
    ///     this rule the field is present and enforcing nothing. Run with rule
    ///     15 rather than after rule 17, because it costs nothing and a
    ///     submission that fails it must not burn a nonce.
    ///
    /// On a path without an assertion, rules 2–15, 17 and 18 have nothing to run
    /// against and rule 16 is the whole check in this layer — the submitter
    /// proves it holds the identity key. The caller remains responsible for
    /// `KT.md` §4.4's directory signature and rotation proof on routine entries.
    ///
    /// # Errors
    ///
    /// One [`AuthorityError`] per rule; see that type for the `KT.md` §9.5 code
    /// each travels as.
    pub fn check_assertion_layer<S: NonceSeen + ?Sized>(
        &self,
        submission: &Submission<'_>,
        now_ms: u64,
        ledger: &mut S,
    ) -> Result<AssertionLayerCheck> {
        // 1. Presence, both directions, selected by entry kind rather than by
        //    the mere existence of an authority configuration.
        let Some(bytes) = submission.assertion else {
            return match submission.kind {
                EntryKind::SameKey | EntryKind::KeyChange => {
                    self.check_routine_assertion_layer(submission)
                }
                EntryKind::InitialBind if !self.authorities.vouches() => {
                    let _ = self.check_entry_shape(submission)?;
                    self.check_unvouched_initial(submission)
                }
                EntryKind::InitialBind | EntryKind::PlatformReset => {
                    Err(AuthorityError::MissingAssertion)
                }
            };
        };
        if matches!(submission.kind, EntryKind::SameKey | EntryKind::KeyChange)
            || !self.authorities.vouches()
        {
            return Err(AuthorityError::UnexpectedAssertion);
        }

        let previous_account_epoch = self.check_entry_shape(submission)?;

        let expected_intent = match submission.kind {
            EntryKind::InitialBind => Intent::Bind,
            EntryKind::PlatformReset => Intent::Reset,
            EntryKind::SameKey | EntryKind::KeyChange => {
                return Err(AuthorityError::EntryKindMismatch);
            }
        };

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

        // 14. Intent against the declared authorization case.
        if body.intent != expected_intent {
            return Err(AuthorityError::IntentMismatch);
        }

        // 15, 18. Account-epoch monotonicity, and the rule that keeps rule 15
        //     from being satisfiable unconditionally by a clock.
        check_account_epoch(body.account_epoch, previous_account_epoch)?;

        // 16. The rule that makes the whole thing sound.
        self.verify_binding(submission, Some(assertion))?;

        // 17. Last, and the only step that writes.
        ledger.observe(now_ms, body.authority_id, body.nonce, body.expires_ms)?;

        Ok(AssertionLayerCheck {
            handle: body.handle.clone(),
            identity_pk: body.identity_pk,
            kind: submission.kind,
            vouch: Vouch::By(body.authority_id),
            intent: Some(body.intent),
            account_epoch: body.account_epoch,
        })
    }

    /// The assertion-layer subset for two routine §4.4 paths. This is not the
    /// routine authorization verdict; the caller still verifies §4.4 itself.
    fn check_routine_assertion_layer(
        &self,
        submission: &Submission<'_>,
    ) -> Result<AssertionLayerCheck> {
        let Some(previous_account_epoch) = self.check_entry_shape(submission)? else {
            // `check_entry_shape` returns `None` only for InitialBind, which
            // cannot reach this routine-only helper.
            return Err(AuthorityError::EntryKindMismatch);
        };
        let previous_vouch = submission
            .previous_vouch
            .ok_or(AuthorityError::MissingPriorVouch)?;
        self.verify_binding(submission, None)?;
        Ok(AssertionLayerCheck {
            handle: submission.handle.clone(),
            identity_pk: *submission.identity_pk,
            kind: submission.kind,
            vouch: previous_vouch,
            intent: None,
            account_epoch: previous_account_epoch,
        })
    }

    /// Hold the `EntryKind` discriminator to the sequence and predecessor.
    fn check_entry_shape(&self, submission: &Submission<'_>) -> Result<Option<u32>> {
        match (submission.kind, submission.previous_vouch) {
            (EntryKind::InitialBind, Some(_)) => {
                return Err(AuthorityError::UnexpectedPriorVouch);
            }
            (EntryKind::PlatformReset, None) => {
                return Err(AuthorityError::MissingPriorVouch);
            }
            _ => {}
        }
        if matches!(submission.kind, EntryKind::InitialBind)
            && submission.previous_account_epoch.is_some()
        {
            return Err(AuthorityError::UnexpectedPriorAccountEpoch);
        }
        let previous_account_epoch = match submission.kind {
            EntryKind::InitialBind => None,
            EntryKind::SameKey | EntryKind::KeyChange | EntryKind::PlatformReset => Some(
                submission
                    .previous_account_epoch
                    .ok_or(AuthorityError::MissingPriorAccountEpoch)?,
            ),
        };
        match (
            submission.kind,
            submission.entry_version,
            submission.previous_identity_pk,
        ) {
            (EntryKind::InitialBind, 1, None) => Ok(previous_account_epoch),
            (EntryKind::SameKey, version, Some(previous)) if version > 1 => {
                if previous == submission.identity_pk {
                    Ok(previous_account_epoch)
                } else {
                    Err(AuthorityError::EntryKindMismatch)
                }
            }
            (EntryKind::KeyChange | EntryKind::PlatformReset, version, Some(previous))
                if version > 1 =>
            {
                if previous != submission.identity_pk {
                    Ok(previous_account_epoch)
                } else {
                    Err(AuthorityError::IdentityUnchanged)
                }
            }
            _ => Err(AuthorityError::EntryKindMismatch),
        }
    }

    /// The no-authority path. Private, and reachable only when
    /// [`AuthoritySet::none`] was configured *and* no assertion was presented,
    /// so it is not a bypass of the vouched path — it is the other half of rule
    /// 1.
    fn check_unvouched_initial(&self, submission: &Submission<'_>) -> Result<AssertionLayerCheck> {
        self.verify_binding(submission, None)?;
        Ok(AssertionLayerCheck {
            handle: submission.handle.clone(),
            identity_pk: *submission.identity_pk,
            kind: submission.kind,
            vouch: Vouch::Unvouched,
            intent: None,
            account_epoch: 0,
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
        let identity_key = VerifyingKey::from_public_key(
            submission.identity_pk,
            AuthorityError::BadIdentitySignature,
        )?;
        identity_key.verify(
            &binding.signing_bytes()?,
            submission.identity_signature,
            AuthorityError::BadIdentitySignature,
        )
    }
}

/// Rules 15 and 18: `account_epoch` advanced, **and it moved like a counter**.
///
/// Free rather than a method because it takes no policy: both bounds are fixed
/// constants ([`ACCOUNT_EPOCH_CEILING`], [`MAX_ACCOUNT_EPOCH_STEP`]), so a
/// client applying them needs nothing from the log.
///
/// # What each half catches, and what neither can
///
/// | | Rule 15 alone | With rule 18 |
/// |---|---|---|
/// | a durable counter, replayed | refused | refused |
/// | Unix **seconds** in a `uint32` | **accepted, always** | refused on its face — over the ceiling |
/// | a coarser clock (days, hours) | **accepted, always** | refused as soon as two issuances are more than [`MAX_ACCOUNT_EPOCH_STEP`] ticks apart |
/// | a clock ticking 1–16 times between two issuances, under the ceiling | accepted | **accepted** |
///
/// The last row is the residue, and it is stated rather than hidden: **no check
/// on a single `u32` can prove the value came from durable storage.** What the
/// issuer must guarantee, and what `KT.md` §4.5.4 requires of it, is that
/// `account_epoch` is read from and written to a per-account column that
/// survives a process restart, and is incremented **only** on the events that
/// justify invalidating outstanding assertions — account recovery and account
/// transfer. An issuer that cannot read that column MUST refuse to issue
/// `intent = reset` rather than substitute a clock.
fn check_account_epoch(account_epoch: u32, previous: Option<u32>) -> Result<()> {
    // 18a. Before anything relative: a value this large is not a count of what
    //      one account did. Checked on every path — including a first `bind`,
    //      which has no predecessor and is therefore the only place a
    //      clock-derived epoch can be caught the first time an issuer mints
    //      one.
    if account_epoch >= ACCOUNT_EPOCH_CEILING {
        return Err(AuthorityError::AccountEpochNotACounter);
    }
    let Some(previous) = previous else {
        return Ok(());
    };
    // 15. Strict: a reset is a distinct account-ownership event, so an
    //     assertion for an epoch already seen is one that has already been
    //     spent.
    if account_epoch <= previous {
        return Err(AuthorityError::AccountEpochRegression);
    }
    // 18b. …and it advanced by an amount a counter could have advanced by.
    //      `previous` is below the ceiling because it was admitted under 18a,
    //      so this cannot overflow.
    if account_epoch > previous.saturating_add(MAX_ACCOUNT_EPOCH_STEP) {
        return Err(AuthorityError::AccountEpochStepTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_bounds_are_the_ones_this_crate_applies() {
        // KT.md §4.5.4 states these to clients as fixed constants. A client
        // that hard-codes the specification and a log that applies something
        // else disagree about admissibility, not merely about an encoding.
        assert_eq!(ACCOUNT_EPOCH_CEILING, 1 << 20, "KT.md §4.5.4 A18a");
        assert_eq!(MAX_ACCOUNT_EPOCH_STEP, 16, "KT.md §4.5.4 A18b");
    }
    use crate::assertion::HandleAssertionTBS;
    use crate::key::SigningKey;
    use crate::nonce::NonceLedger;
    use crate::types::{AssertionNonce, AuthorityId, HandleId};
    use f2z_codec::canonical::Canonical as _;
    use f2z_codec::types::ShortBytes;

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
    fn binding_maps_every_nonuniform_input_to_the_literal_canonical_transcript() {
        const CONFIG_LOG_ID: [u8; 32] = [
            0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd,
            0xde, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb,
            0xec, 0xed, 0xee, 0xef,
        ];
        const MAPPED_IDENTITY_PK: [u8; 32] = [
            0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d,
            0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b,
            0x4c, 0x4d, 0x4e, 0x4f,
        ];
        const ENTRY_DIGEST_BYTES: [u8; 32] = [
            0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d,
            0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b,
            0x6c, 0x6d, 0x6e, 0x6f,
        ];
        // This independently hashed 265-byte vector is built field-by-field,
        // so the mapper test does not depend on signing or verification as its
        // oracle.
        let assertion = HandleAssertion {
            assertion: HandleAssertionTBS {
                label: ShortBytes::new(LABEL_ASSERTION_TBS).unwrap(),
                authority_id: AuthorityId::new([
                    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
                    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
                    0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
                ]),
                log_id: LogId::new([
                    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c,
                    0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
                    0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
                ]),
                handle: Handle::parse(b"a1_b2").unwrap(),
                handle_id: HandleId::new([
                    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c,
                    0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
                    0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
                ]),
                identity_pk: PublicKey::new([
                    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c,
                    0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
                    0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
                ]),
                intent: Intent::Reset,
                account_epoch: 0x0123_4567,
                issued_ms: 0x0102_0304_0506_0708,
                expires_ms: 0x1112_1314_1516_1718,
                nonce: AssertionNonce::new([
                    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c,
                    0x8d, 0x8e, 0x8f,
                ]),
            },
            signature: Signature::new([
                0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d,
                0x9e, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab,
                0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
                0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
                0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
            ]),
        };

        let config =
            AuthorityConfig::with_defaults(LogId::new(CONFIG_LOG_ID), AuthoritySet::none())
                .unwrap();
        let handle = Handle::parse(b"map_7").unwrap();
        let identity_pk = PublicKey::new(MAPPED_IDENTITY_PK);
        let entry_digest = Digest::new(ENTRY_DIGEST_BYTES);
        let binding = config
            .binding(&handle, &identity_pk, Some(&assertion), &entry_digest)
            .unwrap();

        let mut expected = b"\x1efree2z/kt/v1/assertion-binding".to_vec();
        expected.extend_from_slice(&CONFIG_LOG_ID);
        expected.extend_from_slice(b"\x05map_7");
        expected.extend_from_slice(&MAPPED_IDENTITY_PK);
        expected.extend_from_slice(&[
            0x1e, 0x3f, 0x8c, 0x54, 0x9c, 0x81, 0x6a, 0xbd, 0x45, 0x0a, 0xe7, 0x9a, 0xbb, 0xac,
            0x86, 0xcc, 0xa7, 0xda, 0x04, 0xd9, 0x3e, 0x47, 0x89, 0x1e, 0xc8, 0x6a, 0x5c, 0x1e,
            0x1e, 0xc1, 0x00, 0x67,
        ]);
        expected.extend_from_slice(&ENTRY_DIGEST_BYTES);
        assert_eq!(binding.encode_canonical().unwrap(), expected);
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
            kind: EntryKind::InitialBind,
            handle: &handle,
            identity_pk: &identity.public_key(),
            entry_version: 1,
            entry_digest: &Digest::new([7u8; 32]),
            identity_signature: &Signature::new([0u8; 64]),
            previous_identity_pk: None,
            previous_vouch: None,
            previous_account_epoch: None,
        };
        assert_eq!(
            config
                .check_assertion_layer(&submission, 0, &mut ledger)
                .unwrap_err(),
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
            kind: EntryKind::InitialBind,
            handle: &handle,
            identity_pk: &identity.public_key(),
            entry_version: 1,
            entry_digest: &Digest::new([7u8; 32]),
            identity_signature: &Signature::new([0u8; 64]),
            previous_identity_pk: None,
            previous_vouch: None,
            previous_account_epoch: None,
        };
        assert_eq!(
            config
                .check_assertion_layer(&submission, 0, &mut ledger)
                .unwrap_err(),
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

        let checked = config
            .check_assertion_layer(
                &Submission {
                    assertion: None,
                    kind: EntryKind::InitialBind,
                    handle: &handle,
                    identity_pk: &identity.public_key(),
                    entry_version: 1,
                    entry_digest: &entry_digest,
                    identity_signature: &signature,
                    previous_identity_pk: None,
                    previous_vouch: None,
                    previous_account_epoch: None,
                },
                0,
                &mut ledger,
            )
            .unwrap();
        assert_eq!(checked.vouch(), Vouch::Unvouched);
        assert!(!checked.vouch().is_vouched());
        assert_eq!(checked.intent(), None);

        // …and a wrong signature is still fatal there.
        assert_eq!(
            config
                .check_assertion_layer(
                    &Submission {
                        assertion: None,
                        kind: EntryKind::InitialBind,
                        handle: &handle,
                        identity_pk: &identity.public_key(),
                        entry_version: 1,
                        entry_digest: &entry_digest,
                        identity_signature: &Signature::new([0u8; 64]),
                        previous_identity_pk: None,
                        previous_vouch: None,
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
