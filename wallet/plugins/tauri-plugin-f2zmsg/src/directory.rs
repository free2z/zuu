//! The key-transparency directory — **now real, and still fail-closed.**
//!
//! # What exists
//!
//! [`KtDirectory`] is `KT.md` §8 over HTTPS: it carries a `/kt/v1/lookup`
//! request to a real `f2z-kt` log, applies §6.3's monotonicity rules to the tree
//! head, applies §8.3's threshold over the client's **own** witness set,
//! verifies the inclusion proof with `f2z_kt_core::verify`, re-runs §4.4's
//! authorization where a predecessor is held, and pins. All of that lives in
//! `f2z-kt-client`; this file is the adapter between that crate's vocabulary and
//! `CLIENT-CONTRACT.md` §3.10's.
//!
//! # Why [`NoDirectory`] is still the default, and is not a placeholder
//!
//! A client cannot be configured without four values `KT.md` §12 has not
//! decided: the log's identity, the log's signing key, **the shipped witness
//! list, and the default *t*** ([§13-Q]). `f2z_kt_core::WitnessSet` has no
//! `Default` for exactly this reason — *"a default witness set would be this
//! crate inventing the answer §12 declines to invent"* — and a plugin that
//! invented one so the shipping build could resolve something would be
//! inventing it on everyone's behalf, silently, in the one place where getting
//! it wrong is the MITM.
//!
//! So the seam is now real and unused: `Engine::with_directory` takes a
//! [`KtDirectory`] the moment an operator has a [`DirectoryConfig`] to hand it,
//! and until then the shipping build gets [`NoDirectory`], which fails closed.
//! `CLIENT-CONTRACT.md` §6.4's matrix is what makes that the correct default
//! rather than a gap:
//!
//! > Resolving a **new** handle; creating a group with it; accepting a
//! > first-contact `Welcome` from it — **Refused.** This is the #133 moment: an
//! > unverified key here *is* the MITM.
//!
//! and §9 rule 5 forbids proceeding silently. The UI has somewhere correct to go
//! with that: §8 says never "proceed anyway", never a silent degrade, and offer
//! **manual safety-number verification**, which is always available and is the
//! strongest check in the system regardless of directory state.
//!
//! # The one thing a verified directory still cannot supply
//!
//! **An MLS `KeyPackage`.** `KT.md` §4.1 is explicit that a `DirectoryEntry`
//! carries *"no `KeyPackage`"*, and §1.2 lists `KeyPackage` publication and
//! exhaustion among what the document deliberately does not fix — deferred out
//! of `WIRE.md` §12.5 as "directory design" and still open, because a
//! `KeyPackage` is per-device, consumed on use and republished, which is the
//! wrong lifecycle for an append-only log.
//!
//! The consequence is precise and is worth stating where a reader will hit it:
//!
//! - [`Directory::resolve`] — **works.** Everything §3.10 shows a user.
//! - [`Directory::resolve_identity`] — **works.** Which is what
//!   `accept_contact_request` needs, because the `Welcome` and the queue advert
//!   arrive in the contact request itself and only the identity key has to be
//!   confirmed against the directory.
//! - [`Directory::resolve_peer`] — **cannot complete**, because
//!   `start_conversation` must address a `Welcome` to a `KeyPackage` the peer
//!   published, and no published `KeyPackage` exists to fetch. [`KtDirectory`]
//!   performs the whole verified lookup anyway — so the pin, the alarms and the
//!   threshold rule all still run — and then refuses, naming the gap.
//!
//! [§13-Q]: https://github.com/free2z/zuu/issues/311

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use f2z_kt_client::{
    ClientConfig, ClientError, HttpTransport, KtClient, Resolution, ResolvedHandle,
};
use f2z_kt_core::types::{Handle, LogId};
use f2z_kt_core::{ConfiguredWitness, KtError, WitnessSet};

use crate::error::Error;
use crate::models::{DirectoryResolution, ErrorCode};

/// Everything the engine needs about a peer before it can reach them.
///
/// `DirectoryResolution` is the *frontend's* view — what §3.10 shows a user
/// about a lookup. This is the engine's, and it carries the two things a
/// lookup has to produce for first contact to be possible at all: the peer's
/// current `KeyPackage`, and the `contact_addr` its `Welcome` is delivered to
/// (`WIRE.md` §12.2). Both are published by the peer through the directory;
/// neither is guessable.
#[derive(Clone, Debug)]
pub struct ResolvedPeer {
    /// What the UI is told (§3.10).
    pub resolution: DirectoryResolution,
    /// The peer's `identity_pk`, hex — the value a safety number is computed
    /// over and a key change is detected against.
    pub identity_pk: String,
    /// An MLS `KeyPackage` the peer published, to add them to a new group.
    pub key_package: Vec<u8>,
    /// The relay the peer's contact queue lives on.
    pub contact_relay_url: String,
    /// The published, never-bindable contact address, hex (§12.2).
    pub contact_addr: String,
}

/// What the engine needs from a key-transparency log.
///
/// Deliberately narrow. Submission is the app crate's (§2.2 — it needs the
/// seed-derived `DirectoryAuthKey`), and auditing is a witness's job, not a
/// phone's: append-only consistency proofs are O(entries added) and were
/// measured at 3.9 MB and 1–3 s for five epochs (`KT.md` §8.5).
/// What a directory can actually establish about a peer.
///
/// Everything here is published in a `DirectoryEntry` and therefore provable
/// against a witnessed root. [`ResolvedPeer`] is this plus an MLS `KeyPackage`,
/// which is **not** published anywhere (`KT.md` §4.1, §1.2) — so this is the
/// type that can be produced today and that is why it exists separately.
#[derive(Clone, Debug)]
pub struct ResolvedIdentity {
    /// What the UI is told (§3.10).
    pub resolution: DirectoryResolution,
    /// The peer's `identity_pk`, hex — the value a safety number is computed
    /// over and a key change is detected against.
    pub identity_pk: String,
    /// The relay the peer's contact queue lives on.
    pub contact_relay_url: String,
    /// The published, never-bindable contact address, hex (`WIRE.md` §12.2).
    pub contact_addr: String,
}

pub trait Directory: Send + Sync + 'static {
    /// Resolve a handle against a witness-cosigned root.
    ///
    /// An unregistered handle is an **answer, not a failure**: this succeeds
    /// with `found: false`, and there is no unknown-handle error code in either
    /// direction (§3.10). Per the 2026-08-24 correction that answer is the
    /// log's *assertion* and not a proof — `akd` 0.13 produces no
    /// non-membership proof — so no caller may present it as verified.
    ///
    /// # Errors
    ///
    /// `witness-threshold-unmet` when fewer than *t* independent witnesses have
    /// cosigned the root, `directory-unreachable` when the log does not answer,
    /// and `directory-proof-invalid` — which is **fork evidence**, not a
    /// network glitch — when a proof fails.
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution>;

    /// The same lookup, plus everything a `DirectoryEntry` publishes.
    ///
    /// This is what `accept_contact_request` needs: the `Welcome` and the
    /// peer's queue advert already arrived inside the contact request, and the
    /// only thing the directory has to settle is whether the identity key
    /// behind that handle is the one the request claims. Unlike
    /// [`Directory::resolve_peer`] it needs no `KeyPackage`, so it is the one
    /// first-contact path a verified directory can complete today.
    ///
    /// A `found: false` here is a refusal, not an answer — and per the
    /// 2026-08-24 correction it is an *unproved* refusal, so a caller must not
    /// record it as a fact about the directory.
    ///
    /// # Errors
    ///
    /// As [`Directory::resolve`].
    fn resolve_identity(&self, handle: &str) -> crate::error::Result<ResolvedIdentity>;

    /// The same lookup, plus the material first contact needs.
    ///
    /// Separate from [`Directory::resolve`] because `resolve_handle` is a
    /// *question a user asked* and answers `found: false` for a handle nobody
    /// has registered, while this is a step in a handshake that cannot proceed
    /// without a key. A `found: false` here is a refusal, not an answer.
    ///
    /// # Errors
    ///
    /// As [`Directory::resolve`], plus `witness-threshold-unmet` when §6.4's
    /// matrix refuses to resolve a **new** handle at all.
    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer>;

    /// How many of the client's own configured witnesses are independent
    /// (`KT.md` §8.3). The number the UI displays; the configured count is
    /// deliberately not the headline.
    fn independent_witnesses(&self) -> u32;

    /// Whether the threshold is met, which is what §6.4's matrix is keyed on.
    fn threshold_met(&self) -> bool;
}

/// The **default**, and it fails closed loudly every time.
///
/// Not a placeholder: [`KtDirectory`] is real and beside it. This is what an
/// engine gets until an operator hands it a [`DirectoryConfig`], because
/// `KT.md` §12 has decided neither the shipped witness list nor *t*, and a
/// default that resolved something would be inventing both on every user's
/// behalf. See the module note.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoDirectory;

impl Directory for NoDirectory {
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution> {
        Err(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            format!(
                "no key-transparency client is configured, so zero independent witnesses \
                 have cosigned any root; refusing to resolve {handle:?} rather than \
                 returning an unverified key"
            ),
        ))
    }

    fn resolve_identity(&self, handle: &str) -> crate::error::Result<ResolvedIdentity> {
        Err(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            format!(
                "accepting a first-contact Welcome from {handle:?} needs the directory to \
                 confirm whose identity key that handle publishes; no key-transparency \
                 client is configured"
            ),
        ))
    }

    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer> {
        // Written as an explicit refusal rather than as `resolve(..)?` plus an
        // `unreachable!()`: a panic in a crypto core is a crash of the client,
        // and "this branch cannot be taken" is exactly the kind of claim that
        // stops being true when somebody edits the function above it.
        Err(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            format!(
                "first contact with {handle:?} needs the peer's key and contact address \
                 established against a witness-cosigned root; no key-transparency client \
                 is configured"
            ),
        ))
    }

    fn independent_witnesses(&self) -> u32 {
        0
    }

    fn threshold_met(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// The real one.
// ---------------------------------------------------------------------------

/// One witness this client will count, and whether it is **independent**.
///
/// Independence is a social fact, not a cryptographic one
/// (`THREAT-MODEL.md` §3.9): nothing in a cosignature carries it and nothing
/// here infers it. It is the operator's assertion, and it is the number
/// `KT.md` §8.3 requires the UI to display — so asserting it wrongly is worse
/// than leaving it false.
#[derive(Clone, Copy, Debug)]
pub struct WitnessConfig {
    /// The witness's Ed25519 public key.
    pub public_key: [u8; 32],
    /// Whether this witness is operated by a party outside the log's operator.
    pub independent: bool,
}

/// Everything a [`KtDirectory`] must be told, and nothing it may infer.
///
/// There is no `Default`, deliberately, and no constant anywhere in this crate
/// that fills one in. `KT.md` §12 leaves the shipped witness list and the
/// default *t* open ([§13-Q](https://github.com/free2z/zuu/issues/311)), and a
/// plugin that shipped a guess would be answering that question for every user
/// at the one point where being wrong is the MITM.
#[derive(Clone, Debug)]
pub struct DirectoryConfig {
    /// The log's origin, e.g. `https://kt.free2z.cash`. **HTTPS** — a cleartext
    /// lookup lets anyone on the path choose which key this client is about to
    /// encrypt to, and a lookup response is not signed.
    pub base_url: String,
    /// The log's identifier, derived from its **genesis** signing key (§6.1).
    pub log_id: [u8; 32],
    /// The log signing key this client trusts for that `log_id`.
    pub log_public_key: [u8; 32],
    /// The reset authority key ADR 0014 requires be **pinned in clients**. One
    /// learned from the log is a key the log chose, which is no authority at
    /// all (§9.1).
    pub reset_authority_pk: [u8; 32],
    /// The reset cooldown this client holds the log to, in seconds.
    pub reset_cooldown_seconds: u32,
    /// The client's own witness set. Never the log's list: *"a witness list
    /// supplied by the log is a list chosen by the party the witnesses exist to
    /// audit"* (§8.3).
    pub witnesses: Vec<WitnessConfig>,
    /// *t*. A root is accepted only with at least this many valid cosignatures
    /// from **distinct** witnesses in the list above.
    pub threshold: usize,
    /// How long to wait for the log.
    pub timeout: Duration,
}

/// `KT.md` §8 against a real log.
///
/// The whole of the verification is `f2z-kt-client`'s and, beneath it,
/// `f2z-kt-core`'s. Nothing in this file decides a protocol outcome — §11.4's
/// *one crate, three consumers* is the rule, and a plugin that re-derived any
/// part of it would be the second implementation that rule exists to prevent.
pub struct KtDirectory {
    client: Mutex<KtClient<HttpTransport>>,
    independent_witnesses: u32,
    threshold_met: Mutex<bool>,
}

/// Hand-written: `KtClient`'s own `Debug` is a handful of scalars behind a
/// mutex, and a derived one here would try to render the transport.
impl core::fmt::Debug for KtDirectory {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("KtDirectory")
            .field("independent_witnesses", &self.independent_witnesses)
            .finish_non_exhaustive()
    }
}

impl KtDirectory {
    /// Connect to a log and pin its current tree head.
    ///
    /// **Trust on first use, and nothing more.** The first head cannot be
    /// checked against anything — §6.3's rules are all relative — so what this
    /// establishes is a starting point. What makes the pin worth having is
    /// every head after it.
    ///
    /// § 8.1 step 7's authority policy is fetched here too, and a failure to
    /// fetch it is **not** fatal: it leaves the client reporting `Unknown`,
    /// which every caller treats as at least as loud as `unvouched`.
    ///
    /// # Errors
    ///
    /// `directory-unreachable` if the log did not answer,
    /// `directory-protocol-violation` if the tree head does not verify under
    /// the configured key, and `internal` for a configuration that cannot be
    /// used — a cleartext URL, a threshold of zero, a threshold larger than the
    /// witness list, or a duplicate witness key.
    pub fn connect(config: &DirectoryConfig) -> crate::error::Result<Self> {
        let witnesses: Vec<ConfiguredWitness> = config
            .witnesses
            .iter()
            .map(|witness| {
                let key = f2z_codec::types::PublicKey::new(witness.public_key);
                if witness.independent {
                    ConfiguredWitness::independent(key)
                } else {
                    ConfiguredWitness::dependent(key)
                }
            })
            .collect();
        let independent_witnesses =
            u32::try_from(witnesses.iter().filter(|w| w.independent).count()).unwrap_or(u32::MAX);
        let witnesses = WitnessSet::new(witnesses, config.threshold).map_err(map_kt_error)?;

        let transport = HttpTransport::new(&config.base_url, config.timeout).map_err(map_error)?;
        let mut client = KtClient::bootstrap(
            transport,
            ClientConfig {
                log_id: LogId::new(config.log_id),
                accepted_log_pk: f2z_codec::types::PublicKey::new(config.log_public_key),
                witnesses,
                reset_authority_pk: f2z_codec::types::PublicKey::new(config.reset_authority_pk),
                reset_cooldown_seconds: config.reset_cooldown_seconds,
            },
        )
        .map_err(map_error)?;
        // §8.1 step 7. An unanswered question about who may claim a handle is
        // not a reassuring answer, so a failure here is recorded and not raised.
        let _ = client.refresh_authority_policy();

        // One §8.3 pass before anything asks, so `EngineStatus.witnessThresholdMet`
        // is an answer from the log rather than a `false` that only means "no
        // lookup has happened yet". A failure here is not fatal and must not be:
        // `false` is the correct, conservative report for a directory whose root
        // this client could not establish, and §6.4's matrix is keyed on exactly
        // that.
        let threshold_met = client.sync(now_ms()).is_ok();

        Ok(Self {
            client: Mutex::new(client),
            independent_witnesses,
            threshold_met: Mutex::new(threshold_met),
        })
    }

    /// The client, for the app crate's self-audit loop (§8.2) and for
    /// persisting the pinned view and the alarms.
    ///
    /// Exposed rather than wrapped because §8.2 is the app's job on the app's
    /// schedule — *"every client monitors its own handle every epoch"* — and it
    /// needs the set of entries this device submitted, which only the crate
    /// that submitted them knows.
    #[must_use]
    pub const fn client(&self) -> &Mutex<KtClient<HttpTransport>> {
        &self.client
    }

    fn lookup(&self, handle: &str) -> crate::error::Result<Resolution> {
        let parsed = Handle::new(handle.as_bytes().to_vec()).map_err(|_| {
            // §11.3: the string cannot be a handle at all, so no lookup is made
            // and no answer exists to misreport.
            Error::new(
                ErrorCode::HandleIneligible,
                format!("{handle:?} is not a messaging handle"),
            )
        })?;
        let mut client = self.client.lock().map_err(|_| {
            Error::internal("the directory client's lock was poisoned by an earlier panic")
        })?;
        let outcome = client.resolve(&parsed, now_ms());
        if let Ok(resolution) = &outcome
            && let Ok(mut met) = self.threshold_met.lock()
        {
            *met = resolution.standing().threshold_met();
        }
        outcome.map_err(map_error)
    }
}

/// Milliseconds since the Unix epoch.
///
/// The clock is read **here** and not inside `f2z-kt-client`, which has none:
/// every time-dependent decision in that crate is a `now_ms` parameter so it
/// can be tested at an instant and can compile for a target with no clock.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// `KT.md` §9.5 and `f2z-kt-client`'s verdicts, onto §8's `ErrorCode`.
///
/// The rule that decides the hard cases is `CLIENT-CONTRACT.md` §8.1's default:
/// a condition neither table names maps to the **protocol violation** member
/// for whichever peer produced it, never to `internal`, which means our own
/// engine faulted.
fn map_error(error: ClientError) -> Error {
    let text = error.to_string();
    let code = match &error {
        ClientError::Unreachable(_) => ErrorCode::DirectoryUnreachable,
        ClientError::WitnessThresholdUnmet => ErrorCode::WitnessThresholdUnmet,
        ClientError::Refused(refused) => match refused {
            f2z_kt_core::ErrorCode::RateLimited => ErrorCode::DirectoryRateLimited,
            f2z_kt_core::ErrorCode::EpochUnavailable | f2z_kt_core::ErrorCode::RangeTooWide => {
                ErrorCode::DirectoryEpochUnavailable
            }
            f2z_kt_core::ErrorCode::VersionConflict => ErrorCode::DirectoryVersionConflict,
            f2z_kt_core::ErrorCode::Cooldown => ErrorCode::DirectoryCooldown,
            _ => ErrorCode::DirectoryProtocolViolation,
        },
        ClientError::Protocol(kt) => map_kt_code(*kt),
        // A pin contradiction and a pin conflict are **not** proof failures:
        // nothing was disproved, and in the contradiction case nothing can even
        // be shown to a third party, because the log signs tree heads and not
        // lookup responses. `directory-proof-invalid` would overstate what the
        // client has, so §8.1's default rule applies instead.
        ClientError::PinContradiction | ClientError::PinConflict => {
            ErrorCode::DirectoryProtocolViolation
        }
        // A misconfigured client is our fault, not the log's.
        ClientError::Configuration(_) => ErrorCode::Internal,
        // `ClientError` is `#[non_exhaustive]`. §8.1's default rule decides what
        // an unrecognised condition becomes, and it is emphatically NOT
        // `internal`: a future variant will be something the *log* did, and
        // reporting it as our own fault would send whoever reads the error to
        // the wrong place.
        _ => ErrorCode::DirectoryProtocolViolation,
    };
    Error::new(code, text)
}

fn map_kt_error(error: KtError) -> Error {
    Error::new(map_kt_code(error), error.to_string())
}

fn map_kt_code(error: KtError) -> ErrorCode {
    match error {
        // Everything §6.3 rejects, plus a proof that did not verify. All of it
        // is evidence about the log rather than about the network, and §8's
        // retryable table deliberately excludes it: a client that retried these
        // would convert an attack indicator into a flaky-network indicator.
        KtError::Fork
        | KtError::Rollback
        | KtError::ChainBreak
        | KtError::VrfKeyChange
        | KtError::ProofInvalid
        | KtError::ValueMismatch
        | KtError::HistoryIncomplete => ErrorCode::DirectoryProofInvalid,
        KtError::VersionConflict | KtError::DuplicateInEpoch => ErrorCode::DirectoryVersionConflict,
        KtError::Cooldown => ErrorCode::DirectoryCooldown,
        KtError::BadHandle => ErrorCode::HandleIneligible,
        KtError::ThresholdUnmet => ErrorCode::WitnessThresholdUnmet,
        _ => ErrorCode::DirectoryProtocolViolation,
    }
}

/// §3.10's view of a resolution.
fn to_resolution(handle: &str, resolution: &Resolution) -> DirectoryResolution {
    let standing = resolution.standing();
    let resolved = resolution.resolved();
    DirectoryResolution {
        handle: handle.to_owned(),
        // §9 rule 9 and §3.10's correction: `false` is the log's word for it and
        // nothing more. It is never presented as verified, and the engine never
        // lets it overwrite a pin — `f2z-kt-client` refuses to produce the
        // absent variant at all for a handle this client holds a pin for.
        found: resolved.is_some(),
        identity_fingerprint: resolved.map(|entry| hex::encode(entry.identity_pk().as_bytes())),
        device_count: resolved.map_or(0, |entry| {
            u32::try_from(entry.entry().entry.devices.len()).unwrap_or(u32::MAX)
        }),
        entry_version: resolved.map(|entry| i64::from(entry.entry_version())),
        epoch: resolved.map_or_else(
            || match resolution {
                Resolution::AbsentUnproved(answer) => answer.epoch(),
                _ => 0,
            },
            ResolvedHandle::epoch,
        ),
        witness_cosignatures: u32::try_from(standing.counted_including_dependent())
            .unwrap_or(u32::MAX),
        // §8.3: *"the UI MUST display the number of independent witnesses, not
        // the number of configured witnesses"*, and MUST state plainly when it
        // is zero.
        independent_witnesses: u32::try_from(standing.independent()).unwrap_or(u32::MAX),
        threshold_met: standing.threshold_met(),
    }
}

impl Directory for KtDirectory {
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution> {
        Ok(to_resolution(handle, &self.lookup(handle)?))
    }

    fn resolve_identity(&self, handle: &str) -> crate::error::Result<ResolvedIdentity> {
        let resolution = self.lookup(handle)?;
        let resolved = resolution.resolved().ok_or_else(|| {
            // Absent, and **unproved**. `resolve_handle` reports this as an
            // answer with `found: false`; here it is a refusal, because a
            // handshake cannot proceed against a handle for which there is no
            // identity key to compare the request to.
            //
            // The code is `CLIENT-CONTRACT.md` §8.1's **default rule** — a
            // condition neither §9.5's table nor §8's union names maps to the
            // protocol-violation member for the peer that produced it — and it
            // is deliberately not `witness-threshold-unmet`, which would be a
            // lie about a threshold that was met, nor `internal`, which would
            // send a reader to our own engine. §8's union having no member for
            // "the directory says this handle does not exist" is a real gap and
            // is reported rather than papered over.
            //
            // What this must NOT do, and does not, is record the absence: the
            // engine keeps no state from a failed `accept_contact_request`, and
            // `f2z-kt-client` refuses to produce the absent variant at all for a
            // handle this client holds a pin for (§9 rule 9).
            Error::new(
                ErrorCode::DirectoryProtocolViolation,
                format!(
                    "the log asserts — without proving — that {handle:?} is not registered, \
                     so there is no identity key to confirm this contact request against"
                ),
            )
        })?;
        let endpoint = resolved
            .entry()
            .entry
            .contact_endpoints
            .as_slice()
            .first()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::DirectoryProtocolViolation,
                    format!("{handle:?} publishes no contact endpoint (WIRE.md §12.2)"),
                )
            })?;
        let relay_url =
            String::from_utf8(endpoint.relay_url.as_slice().to_vec()).map_err(|_| {
                Error::new(
                    ErrorCode::DirectoryProtocolViolation,
                    format!("{handle:?} publishes a contact relay URL that is not UTF-8"),
                )
            })?;
        Ok(ResolvedIdentity {
            identity_pk: hex::encode(resolved.identity_pk().as_bytes()),
            contact_relay_url: relay_url,
            contact_addr: hex::encode(endpoint.contact_addr.as_bytes()),
            resolution: to_resolution(handle, &resolution),
        })
    }

    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer> {
        // The lookup runs in full first, deliberately. Everything it does is
        // worth doing even though this call is about to fail: §6.3's checks,
        // §8.3's threshold, the inclusion proof, the pin, and any alarm a key
        // change would raise. Refusing before the lookup would mean a user who
        // tries to start a conversation learns nothing about the peer's key
        // having changed.
        let _identity = self.resolve_identity(handle)?;
        Err(Error::internal(format!(
            "resolved {handle:?} against the directory, but starting a conversation needs an \
             MLS KeyPackage and no directory publishes one: KT.md §4.1 states a DirectoryEntry \
             carries \"no KeyPackage\", and §1.2 leaves KeyPackage publication and exhaustion \
             open — deferred out of WIRE.md §12.5 as directory design. accept_contact_request \
             is unaffected: it needs only the identity key, and that is verified"
        )))
    }

    fn independent_witnesses(&self) -> u32 {
        self.independent_witnesses
    }

    fn threshold_met(&self) -> bool {
        self.threshold_met.lock().is_ok_and(|met| *met)
    }
}
