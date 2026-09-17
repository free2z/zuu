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
//! So the seam is real and conditional: `Engine::with_directory` takes a
//! [`BundledDirectory`] when the build's `internal-directory.conf` is filled in
//! (ADR 0017's disposable internal log, [`crate::internal_directory`]), and
//! otherwise the shipping build gets [`NoDirectory`], which fails closed.
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
//! # The one thing a directory deliberately still does not supply
//!
//! **An MLS `KeyPackage`.** `KT.md` §4.1 is explicit that a `DirectoryEntry`
//! carries *"no `KeyPackage`"*, and the 2026-08-26 note there affirms it rather
//! than reversing it: a key package is **consumed on use** and an append-only
//! log cannot express consumption, which is why §4.1 excluded them and why they
//! are still excluded.
//!
//! What changed is that there is now somewhere else for them to be.
//! `WIRE.md` §12.6 puts a device's pool at the **relay**, keyed by the
//! `contact_addr` this entry already publishes, and the fetcher authenticates
//! what it gets against this entry. So the directory's job at first contact is
//! to answer the question it was always the right thing to answer — *whose
//! keys are these* — and [`ResolvedPeer`] carries the verified entry rather
//! than a key package:
//!
//! - [`Directory::resolve`] — everything §3.10 shows a user.
//! - [`Directory::resolve_identity`] — what `accept_contact_request` needs:
//!   the `Welcome` and the queue advert arrived inside the contact request, so
//!   only the identity key has to be confirmed.
//! - [`Directory::resolve_peer`] — the same lookup, plus the **verified
//!   `DirectoryEntryTBS`**, which is what
//!   `f2z_msg_mls::VerifiedKeyPackage::verify` checks a claimed package
//!   against. Without it a relay would choose whose init key the `Welcome` is
//!   encrypted to, which is [#133] one level down.
//!
//! [§13-Q]: https://github.com/free2z/zuu/issues/311
//! [#133]: https://github.com/free2z/zuu/issues/133

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use f2z_codec::types::{Digest, RelayId};
use f2z_kt_client::{
    ClientConfig, ClientError, Expected, HttpTransport, KtClient, Opened, Resolution,
    ResolvedHandle,
};
use f2z_kt_core::entry::{DirectoryEntry, DirectoryEntryTBS};
use f2z_kt_core::policy::AuthorityPolicyTBS;
use f2z_kt_core::receipt::SubmissionReceipt;
use f2z_kt_core::types::{Handle, LogId};
use f2z_kt_core::{ConfiguredWitness, KtError, WitnessSet};

use crate::error::Error;
use crate::models::{DirectoryResolution, ErrorCode};

/// Everything the engine needs about a peer before it can reach them.
///
/// `DirectoryResolution` is the *frontend's* view — what §3.10 shows a user
/// about a lookup. This is the engine's, and it carries the three things first
/// contact cannot proceed without: where to reach the peer
/// (`contact_relay_url` + `contact_addr`, `WIRE.md` §12.2), who the peer is
/// (`identity_pk`), and **the verified entry itself**, which is what a claimed
/// key package is authenticated against (§12.6).
///
/// The entry is carried whole rather than reduced to an identity key on
/// purpose. `f2z_msg_mls::VerifiedKeyPackage::verify` needs the published
/// device set and the revocations too, and a caller that had to assemble those
/// separately could assemble them wrongly — which at this exact point is the
/// MITM.
#[derive(Clone, Debug)]
pub struct ResolvedPeer {
    /// What the UI is told (§3.10).
    pub resolution: DirectoryResolution,
    /// The peer's `identity_pk`, hex — the value a safety number is computed
    /// over and a key change is detected against.
    pub identity_pk: String,
    /// The `DirectoryEntryTBS` this lookup proved, against a witness-cosigned
    /// root. **Not a copy a caller built** — the one the log's inclusion proof
    /// covered.
    pub entry: DirectoryEntryTBS,
    /// The relay the peer's contact queue lives on.
    pub contact_relay_url: String,
    /// The relay identity committed beside the URL in the verified entry.
    /// On-demand first-contact connections pin this value during the handshake;
    /// retaining only the URL would discard the signed anti-substitution check.
    pub contact_relay_id: RelayId,
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
/// against a witnessed root. [`ResolvedPeer`] is this plus the whole verified
/// entry, which `accept_contact_request` does not need: the `Welcome` already
/// arrived, so there is no key package to authenticate.
#[derive(Clone, Debug)]
pub struct ResolvedIdentity {
    /// What the UI is told (§3.10).
    pub resolution: DirectoryResolution,
    /// The peer's `identity_pk`, hex — the value a safety number is computed
    /// over and a key change is detected against.
    pub identity_pk: String,
    /// The verified entry, needed to authenticate the active device that
    /// signed the first routing advert beside its `Welcome`.
    pub entry: DirectoryEntryTBS,
    /// The relay the peer's contact queue lives on.
    pub contact_relay_url: String,
    /// The relay identity committed beside the URL in the verified entry.
    pub contact_relay_id: RelayId,
    /// The published, never-bindable contact address, hex (`WIRE.md` §12.2).
    pub contact_addr: String,
}

/// The witness policy a configured directory is actually applying — what
/// `get_witness_set_state` must report when one is in effect (ADR 0017).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessPolicy {
    /// The configured witnesses, in order.
    pub witnesses: Vec<WitnessConfig>,
    /// *t*.
    pub threshold: u32,
}

impl WitnessPolicy {
    /// How many of the configured witnesses are asserted independent.
    #[must_use]
    pub fn independent(&self) -> u32 {
        u32::try_from(self.witnesses.iter().filter(|w| w.independent).count()).unwrap_or(u32::MAX)
    }
}

/// A handle's published entry, proved against a witnessed root — what the
/// enrolling device needs to chain its next entry and to learn that its own
/// submission merged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedEntry {
    /// The whole entry, authorization included: the next entry's
    /// `prev_entry_hash` is over these bytes (`KT.md` §4.2).
    pub entry: DirectoryEntry,
    /// The epoch of the root the inclusion proof was verified against.
    pub epoch: u64,
}

/// What a submission's receipt must promise, beside the log identity the
/// directory already pins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmissionExpectation {
    /// The handle submitted for.
    pub handle: String,
    /// The version submitted.
    pub entry_version: u32,
    /// `H("free2z/kt/v1/value", tls_codec(entry))`.
    pub entry_digest: [u8; 32],
}

fn no_directory(what: &str) -> Error {
    Error::new(
        ErrorCode::DirectoryUnreachable,
        format!("{what} needs a key-transparency log, and this build configures none (ADR 0017)"),
    )
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

    /// The same lookup, plus the verified entry first contact needs.
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

    /// Whether a real log is behind this directory at all.
    fn is_configured(&self) -> bool {
        false
    }

    /// The witness policy in effect, when this directory has one. `None` for
    /// [`NoDirectory`], whose state is whatever the user stored.
    fn witness_policy(&self) -> Option<WitnessPolicy> {
        None
    }

    /// Re-establish the root this directory stands on, so
    /// [`Directory::threshold_met`] is an answer from the log rather than a
    /// stale one. **Blocking**: call it off the async runtime.
    ///
    /// # Errors
    ///
    /// Why the directory is not usable right now — for `start_engine` to put
    /// in `EngineStatus.lastError`, so the UI can say it without a lookup
    /// having failed first.
    fn refresh(&self) -> crate::error::Result<()> {
        Ok(())
    }

    /// Why this directory is unusable until something outside the app
    /// changes — a log that does not vouch with the bundled authority, or
    /// saved state this device cannot trust (ADR 0017 §3).
    ///
    /// Separate from `EngineStatus.lastError` on purpose. `lastError` is the
    /// last thing that went wrong anywhere, and the inbound pump overwrites it
    /// every few seconds with the current relay weather; a UI that keyed a
    /// "this directory is not usable" banner on it would take the banner down
    /// while the condition still held. This is written by directory state and
    /// by nothing else, so it stays up until the state changes.
    fn directory_blocked(&self) -> Option<ErrorCode> {
        None
    }

    /// Give the directory the place this device keeps its last verified tree
    /// head, or take it away (`None`).
    ///
    /// The engine calls this when the device's secrets are unsealed — the
    /// store is keyed by them — and with `None` when they are dropped
    /// (shutdown, unenroll). A directory that persists nothing ignores it.
    fn attach_checkpoints(&self, store: Option<Arc<dyn CheckpointStore>>) {
        let _ = store;
    }

    /// Resolve a handle and hand back the whole verified entry, or `None` when
    /// the log asserts — unproved — that it is not registered.
    ///
    /// # Errors
    ///
    /// As [`Directory::resolve`]; `directory-unreachable` when no log is
    /// configured.
    fn lookup_entry(&self, handle: &str) -> crate::error::Result<Option<VerifiedEntry>> {
        let _ = handle;
        Err(no_directory("looking up this device's own entry"))
    }

    /// `POST /kt/v1/submit` with bytes the seed-holding app signed, and check
    /// the receipt against the pinned log key and against `expected`.
    ///
    /// # Errors
    ///
    /// `directory-unreachable` when no log is configured or it did not answer,
    /// the §9.5 mapping of a refusal, `directory-protocol-violation` for a
    /// receipt that does not verify or promises something else.
    fn submit(
        &self,
        envelope: &[u8],
        expected: &SubmissionExpectation,
    ) -> crate::error::Result<SubmissionReceipt> {
        let _ = (envelope, expected);
        Err(no_directory("submitting a directory entry"))
    }
}

/// Where a [`KtDirectory`] keeps the last tree head it verified — ADR 0017 §3.
///
/// The engine's implementation seals the head under a key derived from this
/// device's unsealed secrets and keeps it in the same SQLite store as the
/// identity (`engine::SealedCheckpoints`). Moving it there from a loose file
/// is what makes deleting or editing it something other than a way to make
/// the device trust the log's next head on first use.
pub trait CheckpointStore: Send + Sync + 'static {
    /// The stored checkpoint bytes.
    ///
    /// `Ok(None)` means **first use**: nothing is stored and this device has
    /// never relied on the directory, so trusting the log's current head is
    /// the only thing possible.
    ///
    /// # Errors
    ///
    /// `directory-state-invalid` when something is stored that does not
    /// authenticate or decode, or when nothing is stored although the device
    /// has already relied on the directory. Never "treat it as first use".
    fn load(&self) -> crate::error::Result<Option<Vec<u8>>>;

    /// Durably replace the stored checkpoint.
    ///
    /// # Errors
    ///
    /// The store's own refusal.
    fn save(&self, checkpoint: &[u8]) -> crate::error::Result<()>;
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    /// The log's ECVRF public key, when the configuration pins one. The first
    /// tree head this client accepts must carry it; §6.3 refuses a change
    /// after that. `None` trusts the first head's key on first use.
    pub vrf_public_key: Option<[u8; 32]>,
    /// The handle authority the log's signed §4.6 policy must list — alone,
    /// and vouched. `None` only reports vouching (§8.1 step 7); `Some` makes
    /// anything else [`ErrorCode::DirectoryUnvouched`] and the directory
    /// unusable (ADR 0017 §3). The bundled directory always sets it.
    pub required_authority: Option<[u8; 32]>,
    /// Genesis keys of log generations this client has deliberately left. A
    /// stored checkpoint from one of them is set aside; from any other log it
    /// is refused (`KtClient::open`).
    pub retired_log_public_keys: Vec<[u8; 32]>,
}

/// `KT.md` §8 against a real log.
///
/// The whole of the verification is `f2z-kt-client`'s and, beneath it,
/// `f2z-kt-core`'s. Nothing in this file decides a protocol outcome — §11.4's
/// *one crate, three consumers* is the rule, and a plugin that re-derived any
/// part of it would be the second implementation that rule exists to prevent.
pub struct KtDirectory {
    client: Mutex<KtClient<HttpTransport>>,
    /// A second socket to the same log, for `/kt/v1/submit`. `KtClient` owns
    /// its read transport and deliberately has no submit method.
    submitter: HttpTransport,
    log_id: LogId,
    log_pk: f2z_codec::types::PublicKey,
    policy: WitnessPolicy,
    checkpoints: Option<Arc<dyn CheckpointStore>>,
    independent_witnesses: u32,
    threshold_met: Mutex<bool>,
    required_authority: Option<f2z_codec::types::PublicKey>,
    /// The first authority policy this process verified, with its only
    /// time-varying field zeroed. A later one that differs is a policy change,
    /// and a bundled client refuses the log from then on.
    pinned_policy: Mutex<Option<AuthorityPolicyTBS>>,
    /// Once set, every operation fails with this. A log that stopped vouching,
    /// or started vouching differently, does not become trustworthy again by
    /// answering the next question.
    unusable: Mutex<Option<Error>>,
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
    /// Connect to a log and pin its current tree head, with no persistence:
    /// every process starts trust-on-first-use again. For tests and tools;
    /// a device uses [`KtDirectory::connect_with`].
    ///
    /// # Errors
    ///
    /// As [`KtDirectory::connect_with`].
    pub fn connect(config: &DirectoryConfig) -> crate::error::Result<Self> {
        Self::connect_with(config, None)
    }

    /// Connect to a log, resuming from this device's checkpoint when it has
    /// one.
    ///
    /// **Trust on first use, and nothing more, when there is no checkpoint.**
    /// The first head cannot be checked against anything — §6.3's rules are
    /// all relative — so what this establishes is a starting point. What makes
    /// the pin worth having is every head after it, and the checkpoint is what
    /// carries it across a restart.
    ///
    /// §8.1 step 7's authority policy is fetched here too. With
    /// [`DirectoryConfig::required_authority`] unset a failure is **not**
    /// fatal and leaves the client reporting `Unknown`. With it set, the policy
    /// must be fetched, verify, vouch, and list exactly that key, or the
    /// connection is refused.
    ///
    /// # Errors
    ///
    /// `directory-unreachable` if the log did not answer,
    /// `directory-state-invalid` if the checkpoint store refused or the
    /// stored head cannot be resumed or set aside, `directory-unvouched` for a
    /// policy that is not the required one, `directory-protocol-violation` if
    /// the tree head does not verify under the configured key, and `internal`
    /// for a configuration that cannot be used — a cleartext URL, a threshold
    /// of zero, a threshold larger than the witness list, or a duplicate
    /// witness key — or a checkpoint that could not be saved.
    pub fn connect_with(
        config: &DirectoryConfig,
        checkpoints: Option<Arc<dyn CheckpointStore>>,
    ) -> crate::error::Result<Self> {
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
        let submitter = HttpTransport::new(&config.base_url, config.timeout).map_err(map_error)?;
        let checkpoint = match &checkpoints {
            Some(store) => store.load()?,
            None => None,
        };
        let retired: Vec<f2z_codec::types::PublicKey> = config
            .retired_log_public_keys
            .iter()
            .map(|key| f2z_codec::types::PublicKey::new(*key))
            .collect();
        let resuming = checkpoint.is_some();
        let (mut client, opened) = KtClient::open(
            transport,
            ClientConfig {
                log_id: LogId::new(config.log_id),
                accepted_log_pk: f2z_codec::types::PublicKey::new(config.log_public_key),
                witnesses,
                reset_authority_pk: f2z_codec::types::PublicKey::new(config.reset_authority_pk),
                reset_cooldown_seconds: config.reset_cooldown_seconds,
            },
            checkpoint.as_deref(),
            &retired,
        )
        .map_err(|error| match error {
            // Bootstrapping talks to the log; its silence is not a verdict on
            // the stored state.
            ClientError::Unreachable(_) => map_error(error),
            // A stored head this build cannot resume and may not set aside.
            // Trusting the next head instead would discard what this device
            // saw before, so the directory stays unusable until the user
            // explicitly resets it by unenrolling (ADR 0017 §3).
            other if resuming => state_invalid(&format!(
                "the saved directory checkpoint cannot be used: {other}"
            )),
            other => {
                let mapped = map_error(other);
                Error::new(
                    ErrorCode::DirectoryProtocolViolation,
                    format!("opening the directory: {}", mapped.context()),
                )
            }
        })?;
        if opened == Opened::ReplacedRetiredLogsCheckpoint {
            tracing::warn!(
                "the configured key-transparency log changed; the retired log's checkpoint \
                 was set aside (ADR 0017)"
            );
        }
        if let Some(expected) = config.vrf_public_key
            && client.view().vrf_public_key().as_bytes() != &expected
        {
            return Err(Error::new(
                ErrorCode::DirectoryProtocolViolation,
                "the log's VRF key is not the one this build pins (ADR 0017)",
            ));
        }
        let required_authority = config
            .required_authority
            .map(f2z_codec::types::PublicKey::new);
        let pinned_policy = match &required_authority {
            // ADR 0017 §3: a bundled client does not resolve against a log
            // that does not vouch with the bundled authority — not even once.
            Some(authority) => {
                client
                    .require_authority_policy(std::slice::from_ref(authority))
                    .map_err(map_error)?;
                client.authority_policy().map(comparable_policy)
            }
            // §8.1 step 7, reported only. An unanswered question about who
            // may claim a handle is not a reassuring answer, so a failure here
            // is recorded (as `Unknown`) and not raised.
            None => {
                let _ = client.refresh_authority_policy();
                None
            }
        };

        // One §8.3 pass before anything asks, so `EngineStatus.witnessThresholdMet`
        // is an answer from the log rather than a `false` that only means "no
        // lookup has happened yet". A failure here is not fatal and must not be:
        // `false` is the correct, conservative report for a directory whose root
        // this client could not establish, and §6.4's matrix is keyed on exactly
        // that.
        let threshold_met = client.sync(now_ms()).is_ok();
        // The first save is not best-effort. A device that went on to rely on
        // this directory with nothing saved would, on its next start, find no
        // checkpoint beside evidence that it had one — and refuse.
        if let Some(store) = &checkpoints {
            save_checkpoint(store.as_ref(), &client)?;
        }

        Ok(Self {
            checkpoints,
            client: Mutex::new(client),
            submitter,
            log_id: LogId::new(config.log_id),
            log_pk: f2z_codec::types::PublicKey::new(config.log_public_key),
            policy: policy_of(config),
            independent_witnesses,
            threshold_met: Mutex::new(threshold_met),
            required_authority,
            pinned_policy: Mutex::new(pinned_policy),
            unusable: Mutex::new(None),
        })
    }

    /// One §8.3 pass over the latest head, recorded for
    /// [`Directory::threshold_met`], and — for a bundled client — the
    /// authority policy checked again. Blocking.
    ///
    /// # Errors
    ///
    /// The reason this directory is unusable, if it is.
    pub fn refresh_root(&self) -> crate::error::Result<()> {
        self.usable()?;
        let mut client = self.client.lock().map_err(|_| poisoned())?;
        let met = client.sync(now_ms()).is_ok();
        // After every call, error or not: a failed sync can still have
        // advanced the view through a verified prefix (`KtClient`'s note).
        self.persist(&client);
        if let Ok(mut slot) = self.threshold_met.lock() {
            *slot = met;
        }
        self.recheck_policy(&mut client)
    }

    /// ADR 0017 §3, over time: the policy this process pinned must still be
    /// the one the log signs. A log that cannot be reached right now has not
    /// changed its policy; one that answers with anything else has, and the
    /// directory is unusable from then on.
    fn recheck_policy(&self, client: &mut KtClient<HttpTransport>) -> crate::error::Result<()> {
        let Some(authority) = self.required_authority else {
            return Ok(());
        };
        // Everything that talks to the log happens here; everything that
        // decides, and everything that remembers, is in the two functions
        // below, where a test can drive them without one.
        let checked = client.require_authority_policy(std::slice::from_ref(&authority));
        let now = client.authority_policy().map(comparable_policy);
        let pinned = self.pinned_policy.lock().map_err(|_| poisoned())?;
        let verdict = policy_verdict(checked, now, pinned.as_ref());
        apply_verdict(verdict, pinned, &self.unusable, &self.threshold_met)
    }

    fn usable(&self) -> crate::error::Result<()> {
        match self.unusable.lock().map_err(|_| poisoned())?.as_ref() {
            Some(refusal) => Err(refusal.clone()),
            None => Ok(()),
        }
    }

    /// Save the view after an operation. Best-effort past the first save in
    /// [`KtDirectory::connect_with`]: saving less is safe — the prefix is
    /// verified again after a restart — and only loses progress.
    fn persist(&self, client: &KtClient<HttpTransport>) {
        if let Some(store) = &self.checkpoints
            && let Err(error) = save_checkpoint(store.as_ref(), client)
        {
            tracing::warn!(
                code = %error.code(),
                "the directory checkpoint was not persisted"
            );
        }
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
        self.usable()?;
        let mut client = self.client.lock().map_err(|_| poisoned())?;
        let outcome = client.resolve(&parsed, now_ms());
        self.persist(&client);
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
        // ADR 0017 §3.
        ClientError::AuthorityPolicyMismatch => ErrorCode::DirectoryUnvouched,
        ClientError::UnrecognisedCheckpoint => ErrorCode::DirectoryStateInvalid,
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

/// §12.2's published contact endpoint, out of a verified entry.
///
/// `k = 1` here, as everywhere else in this build: the first endpoint wins.
/// `ARCHITECTURE.md` §13-G leaves the redundancy factor open, and a client that
/// picked among several would be answering it.
fn contact_endpoint(
    handle: &str,
    resolved: &ResolvedHandle,
) -> crate::error::Result<(String, RelayId, String)> {
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
    let relay_url = String::from_utf8(endpoint.relay_url.as_slice().to_vec()).map_err(|_| {
        Error::new(
            ErrorCode::DirectoryProtocolViolation,
            format!("{handle:?} publishes a contact relay URL that is not UTF-8"),
        )
    })?;
    Ok((
        relay_url,
        endpoint.relay_id,
        hex::encode(endpoint.contact_addr.as_bytes()),
    ))
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
        let (relay_url, relay_id, contact_addr) = contact_endpoint(handle, resolved)?;
        Ok(ResolvedIdentity {
            identity_pk: hex::encode(resolved.identity_pk().as_bytes()),
            entry: resolved.entry().entry.clone(),
            contact_relay_url: relay_url,
            contact_relay_id: relay_id,
            contact_addr,
            resolution: to_resolution(handle, &resolution),
        })
    }

    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer> {
        let resolution = self.lookup(handle)?;
        let resolved = resolution.resolved().ok_or_else(|| {
            // Absent, and **unproved** — the same reading `resolve_identity`
            // gives it, and for the same reason: a handshake cannot proceed
            // against a handle for which there is no entry to authenticate a
            // key package against.
            Error::new(
                ErrorCode::DirectoryProtocolViolation,
                format!(
                    "the log asserts — without proving — that {handle:?} is not registered, \
                     so there is nothing to authenticate a key package against"
                ),
            )
        })?;
        let endpoint = contact_endpoint(handle, resolved)?;
        Ok(ResolvedPeer {
            identity_pk: hex::encode(resolved.identity_pk().as_bytes()),
            // The entry the inclusion proof covered, cloned out whole. §12.6's
            // authentication is against *this*, and nothing between here and
            // `VerifiedKeyPackage::verify` may narrow it.
            entry: resolved.entry().entry.clone(),
            contact_relay_url: endpoint.0,
            contact_relay_id: endpoint.1,
            contact_addr: endpoint.2,
            resolution: to_resolution(handle, &resolution),
        })
    }

    fn independent_witnesses(&self) -> u32 {
        self.independent_witnesses
    }

    fn threshold_met(&self) -> bool {
        self.threshold_met.lock().is_ok_and(|met| *met)
    }

    fn is_configured(&self) -> bool {
        true
    }

    fn witness_policy(&self) -> Option<WitnessPolicy> {
        Some(self.policy.clone())
    }

    fn refresh(&self) -> crate::error::Result<()> {
        self.refresh_root()
    }

    fn directory_blocked(&self) -> Option<ErrorCode> {
        self.unusable
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Error::code))
    }

    fn lookup_entry(&self, handle: &str) -> crate::error::Result<Option<VerifiedEntry>> {
        Ok(self
            .lookup(handle)?
            .resolved()
            .map(|resolved| VerifiedEntry {
                entry: resolved.entry().clone(),
                epoch: resolved.epoch(),
            }))
    }

    fn submit(
        &self,
        envelope: &[u8],
        expected: &SubmissionExpectation,
    ) -> crate::error::Result<SubmissionReceipt> {
        // Publishing to a log this client refuses to resolve against would put
        // an entry where nobody this build talks to should look.
        self.usable()?;
        let handle = Handle::new(expected.handle.as_bytes().to_vec()).map_err(|_| {
            Error::new(
                ErrorCode::HandleIneligible,
                format!("{:?} is not a messaging handle", expected.handle),
            )
        })?;
        let digest = Digest::new(expected.entry_digest);
        f2z_kt_client::submit(
            &self.submitter,
            envelope,
            &Expected {
                log_id: &self.log_id,
                log_pk: &self.log_pk,
                handle: &handle,
                entry_version: expected.entry_version,
                entry_digest: &digest,
            },
        )
        .map_err(map_error)
    }
}

/// Hand the last verified head to the store, which writes it in one SQLite
/// transaction under `synchronous = FULL`: durable once this returns, and
/// never torn.
fn save_checkpoint(
    store: &dyn CheckpointStore,
    client: &KtClient<HttpTransport>,
) -> crate::error::Result<()> {
    let bytes = client
        .checkpoint_bytes()
        .map_err(|error| Error::internal(format!("encoding the directory checkpoint: {error}")))?;
    store.save(&bytes)
}

/// A policy in the one shape two of them may be compared in: its only
/// time-varying field zeroed, and its lists **sorted**.
///
/// `AuthorityPolicyTBS` derives `PartialEq`, so its `VecU16` fields compare in
/// order. `KtClient::require_authority_policy` is deliberately order-blind —
/// it compares key *sets* — and a pinned copy that was order-sensitive would
/// make a log that merely reordered two authorities, or two
/// `asserted_versions`, look like a log that changed its policy. With one
/// authority the difference cannot show; the day there are two it would, and
/// it would show as a false alarm that makes the directory unusable.
fn comparable_policy(policy: &AuthorityPolicyTBS) -> AuthorityPolicyTBS {
    let mut authorities = policy.authorities.as_slice().to_vec();
    authorities.sort_unstable_by_key(|key| *key.as_bytes());
    let mut asserted_versions = policy.asserted_versions.as_slice().to_vec();
    asserted_versions.sort_unstable();
    AuthorityPolicyTBS {
        published_at_ms: 0,
        authorities: authorities.into(),
        asserted_versions: asserted_versions.into(),
        ..policy.clone()
    }
}

/// What a §4.6 policy check decides, before any state is touched.
///
/// Extracted from [`KtDirectory::recheck_policy`] so the decision can be
/// tested without a log: the call site is a match with one arm each, and the
/// rule that a transient failure is **not** remembered lives here where a test
/// can drive it (#1027 review, F1).
#[derive(Debug)]
enum PolicyVerdict {
    /// The policy is the one this connection pinned. Nothing to do.
    Unchanged,
    /// Nothing was pinned yet; pin this.
    Pin(AuthorityPolicyTBS),
    /// Report it and forget it: this says nothing about who may claim a handle
    /// on this log.
    Report(Error),
    /// Refuse this directory from now on.
    Latch(Error),
}

/// Decide, given the check's outcome, the policy that verified (in
/// [`comparable_policy`] form) and the one this connection pinned.
fn policy_verdict(
    checked: core::result::Result<(), ClientError>,
    now: Option<AuthorityPolicyTBS>,
    pinned: Option<&AuthorityPolicyTBS>,
) -> PolicyVerdict {
    match checked {
        Ok(()) => match (pinned, now) {
            (Some(before), Some(now)) if *before != now => PolicyVerdict::Latch(Error::new(
                ErrorCode::DirectoryUnvouched,
                "the log's signed authority policy changed since this directory was opened; \
                 refusing it from now on (ADR 0017)",
            )),
            (None, Some(now)) => PolicyVerdict::Pin(now),
            _ => PolicyVerdict::Unchanged,
        },
        Err(error) if latching(&error) => PolicyVerdict::Latch(map_error(error)),
        Err(error) => PolicyVerdict::Report(map_error(error)),
    }
}

/// Act on a [`PolicyVerdict`]: pin, do nothing, report, or **remember**.
///
/// The state a latch touches is passed in rather than reached through `self`
/// so that the one rule worth a test — a verdict that is only reported leaves
/// every piece of that state exactly as it was — is a test with no log, no
/// transport and no connection in it.
fn apply_verdict(
    verdict: PolicyVerdict,
    mut pinned: std::sync::MutexGuard<'_, Option<AuthorityPolicyTBS>>,
    unusable: &Mutex<Option<Error>>,
    threshold_met: &Mutex<bool>,
) -> crate::error::Result<()> {
    let refusal = match verdict {
        PolicyVerdict::Unchanged => return Ok(()),
        PolicyVerdict::Pin(policy) => {
            *pinned = Some(policy);
            return Ok(());
        }
        // Reported and forgotten: the directory is exactly as usable as it was
        // a moment ago, and the caller decides what to do about a log that did
        // not answer this question.
        PolicyVerdict::Report(error) => return Err(error),
        PolicyVerdict::Latch(refusal) => refusal,
    };
    drop(pinned);
    tracing::error!(
        code = %refusal.code(),
        context = %refusal.context(),
        "the directory is no longer usable"
    );
    if let Ok(mut slot) = unusable.lock() {
        *slot = Some(refusal.clone());
    }
    if let Ok(mut met) = threshold_met.lock() {
        *met = false;
    }
    Err(refusal)
}

/// Whether a failed authority-policy check is a **statement** about the log
/// rather than a bad moment.
///
/// Latching one is permanent for the process, so the set is small and each
/// member is non-transient by construction:
///
/// - [`ClientError::AuthorityPolicyMismatch`] — the log signed a policy that
///   does not vouch with exactly the bundled authority. Asking again cannot
///   change what it signed.
/// - [`KtError::BadSignature`] — something served a policy that does not
///   verify under the log key this client has already accepted. That is not a
///   log with a busy minute; it is either the log using a key it is not
///   entitled to, or a party on the path substituting the document.
/// - [`KtError::WrongLog`] — the policy names another `log_id`, which is a
///   replay of a different log's document.
///
/// Everything else — unreachable, refused (including `ERR_RATE_LIMITED`), an
/// answer that does not decode, a catch-up checkpoint — is transient or is
/// about the path, and is reported without being remembered.
fn latching(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::AuthorityPolicyMismatch
            | ClientError::Protocol(KtError::BadSignature | KtError::WrongLog)
    )
}

/// Which refusals a **status read** may keep showing: the two that say the
/// directory will not work until something outside the app changes. A
/// timeout, a rate limit or a proof failure is about this moment or about one
/// answer, and `EngineStatus.lastError` is where those belong.
fn blocking_code(code: ErrorCode) -> Option<ErrorCode> {
    matches!(
        code,
        ErrorCode::DirectoryUnvouched | ErrorCode::DirectoryStateInvalid
    )
    .then_some(code)
}

fn state_invalid(what: &str) -> Error {
    Error::new(
        ErrorCode::DirectoryStateInvalid,
        format!("{what}; unenroll this device and enroll again to reset it (ADR 0017 §3)"),
    )
}

fn poisoned() -> Error {
    Error::internal("the directory client's lock was poisoned by an earlier panic")
}

fn policy_of(config: &DirectoryConfig) -> WitnessPolicy {
    WitnessPolicy {
        witnesses: config.witnesses.clone(),
        threshold: u32::try_from(config.threshold).unwrap_or(u32::MAX),
    }
}

// ---------------------------------------------------------------------------
// The bundled one: a KtDirectory that connects when first needed.
// ---------------------------------------------------------------------------

/// ADR 0017's directory: [`KtDirectory`] over the build's
/// `internal-directory.conf`, connected on first use rather than at launch.
///
/// Lazily, because [`KtDirectory::connect`] is a blocking round trip to the log
/// and the plugin's `setup` hook must neither block a launch nor fail one
/// (#753). Until a connection succeeds this reports the threshold unmet — the
/// conservative answer §6.4's matrix is keyed on — and every lookup retries the
/// connection, so an offline launch recovers without a restart.
pub struct BundledDirectory {
    config: DirectoryConfig,
    policy: WitnessPolicy,
    /// The store a connection saves into, and its generation. Replaced by
    /// [`Directory::attach_checkpoints`]; the generation lets a connection
    /// made against an older store be dropped without waiting on it.
    checkpoints: Mutex<Option<Arc<dyn CheckpointStore>>>,
    generation: AtomicU64,
    connected: Mutex<Option<(u64, Arc<KtDirectory>)>>,
    /// The last **non-transient** reason a connection was refused, for
    /// [`Directory::directory_blocked`]. A connect that fails on the authority
    /// policy or on this device's saved state leaves no `KtDirectory` to hold
    /// the latch, and that is exactly the case the UI has to be able to
    /// explain. Cleared by a connection that succeeds.
    blocked: Mutex<Option<ErrorCode>>,
}

impl core::fmt::Debug for BundledDirectory {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("BundledDirectory")
            .field("base_url", &self.config.base_url)
            .finish_non_exhaustive()
    }
}

impl BundledDirectory {
    /// A directory over `config` that has not connected yet, and has nowhere
    /// to keep a checkpoint until the engine attaches one.
    #[must_use]
    pub fn new(config: DirectoryConfig) -> Self {
        Self {
            policy: policy_of(&config),
            config,
            checkpoints: Mutex::new(None),
            generation: AtomicU64::new(0),
            connected: Mutex::new(None),
            blocked: Mutex::new(None),
        }
    }

    fn connected(&self) -> crate::error::Result<Arc<KtDirectory>> {
        let mut slot = self.connected.lock().map_err(|_| {
            Error::internal("the bundled directory's lock was poisoned by an earlier panic")
        })?;
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some((made_for, directory)) = slot.as_ref()
            && *made_for == generation
        {
            return Ok(Arc::clone(directory));
        }
        *slot = None;
        let store = self
            .checkpoints
            .lock()
            .map_err(|_| poisoned())?
            .clone()
            .ok_or_else(|| {
                // Without the device's secrets there is nowhere to keep, or
                // read, what this device saw before — and a connection that
                // could not remember would be trust on first use every time.
                Error::new(
                    ErrorCode::EngineLocked,
                    "the directory's saved state is sealed under this device's keys; unlock \
                     the engine first",
                )
            })?;
        let directory = match KtDirectory::connect_with(&self.config, Some(store)) {
            Ok(directory) => Arc::new(directory),
            Err(error) => {
                if let Ok(mut blocked) = self.blocked.lock() {
                    *blocked = blocking_code(error.code());
                }
                return Err(error);
            }
        };
        if let Ok(mut blocked) = self.blocked.lock() {
            *blocked = None;
        }
        // Cached only if no attach happened meanwhile; either way this caller
        // gets the connection it asked for.
        if self.generation.load(Ordering::SeqCst) == generation {
            *slot = Some((generation, Arc::clone(&directory)));
        }
        Ok(directory)
    }
}

impl Directory for BundledDirectory {
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution> {
        self.connected()?.resolve(handle)
    }

    fn resolve_identity(&self, handle: &str) -> crate::error::Result<ResolvedIdentity> {
        self.connected()?.resolve_identity(handle)
    }

    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer> {
        self.connected()?.resolve_peer(handle)
    }

    fn independent_witnesses(&self) -> u32 {
        self.policy.independent()
    }

    fn threshold_met(&self) -> bool {
        // `try_lock`: a status read must never wait behind a connection
        // attempt. Busy or unconnected is "not met", which is the conservative
        // answer.
        let generation = self.generation.load(Ordering::SeqCst);
        self.connected
            .try_lock()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .filter(|(made_for, _)| *made_for == generation)
                    .map(|(_, directory)| directory.threshold_met())
            })
            .unwrap_or(false)
    }

    fn is_configured(&self) -> bool {
        true
    }

    fn witness_policy(&self) -> Option<WitnessPolicy> {
        Some(self.policy.clone())
    }

    fn refresh(&self) -> crate::error::Result<()> {
        match self.connected() {
            Ok(directory) => directory.refresh_root(),
            Err(error) => {
                tracing::info!(code = %error.code(), "the bundled directory did not connect");
                Err(error)
            }
        }
    }

    fn directory_blocked(&self) -> Option<ErrorCode> {
        // `try_lock` on the connection: a status read never waits behind a
        // connection attempt. The remembered connect refusal needs no
        // connection, so it answers either way.
        self.connected
            .try_lock()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .and_then(|(_, directory)| directory.directory_blocked())
            })
            .or_else(|| self.blocked.lock().ok().and_then(|slot| *slot))
    }

    fn attach_checkpoints(&self, store: Option<Arc<dyn CheckpointStore>>) {
        // Short critical sections only: this is called from async engine
        // code, and a connection attempt may hold `connected` for a network
        // timeout. Bumping the generation retires any cached connection.
        if let Ok(mut slot) = self.checkpoints.lock() {
            *slot = store;
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut slot) = self.connected.try_lock() {
            *slot = None;
        }
        // A new set of device secrets is a new question about this device's
        // saved state; the previous answer is not evidence about it.
        if let Ok(mut blocked) = self.blocked.lock() {
            *blocked = None;
        }
    }

    fn lookup_entry(&self, handle: &str) -> crate::error::Result<Option<VerifiedEntry>> {
        self.connected()?.lookup_entry(handle)
    }

    fn submit(
        &self,
        envelope: &[u8],
        expected: &SubmissionExpectation,
    ) -> crate::error::Result<SubmissionReceipt> {
        self.connected()?.submit(envelope, expected)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use f2z_kt_core::policy::AuthorityPolicyTBS;

    use super::{
        BundledDirectory, CheckpointStore, ClientError, Directory, DirectoryConfig, ErrorCode,
        LogId, PolicyVerdict, WitnessConfig, apply_verdict, blocking_code, comparable_policy,
        latching, policy_verdict,
    };
    use crate::error::Error;
    use crate::error::Result;

    /// A store that answers from memory, so nothing here touches a disk or a
    /// log.
    #[derive(Default)]
    struct InMemory(Mutex<Option<Vec<u8>>>);

    impl CheckpointStore for InMemory {
        fn load(&self) -> Result<Option<Vec<u8>>> {
            Ok(self.0.lock().expect("lock").clone())
        }

        fn save(&self, checkpoint: &[u8]) -> Result<()> {
            *self.0.lock().expect("lock") = Some(checkpoint.to_vec());
            Ok(())
        }
    }

    fn config() -> DirectoryConfig {
        DirectoryConfig {
            // Nothing below connects: every test here is refused before the
            // first byte would go out.
            base_url: "https://kt.invalid".to_owned(),
            log_id: [1; 32],
            log_public_key: [2; 32],
            reset_authority_pk: [3; 32],
            reset_cooldown_seconds: 604_800,
            witnesses: vec![WitnessConfig {
                public_key: [4; 32],
                independent: false,
            }],
            threshold: 1,
            timeout: std::time::Duration::from_millis(1),
            vrf_public_key: Some([5; 32]),
            required_authority: Some([6; 32]),
            retired_log_public_keys: Vec::new(),
        }
    }

    #[test]
    fn a_bundled_directory_with_no_sealed_state_refuses_instead_of_trusting_on_first_use() {
        // ADR 0017 §3: the checkpoint lives in the engine's store, sealed
        // under this device's secrets. Without them there is nowhere to read
        // what this device saw before — and a connection that could not
        // remember would be trust on first use on every launch.
        let directory = BundledDirectory::new(config());
        for code in [
            directory.resolve("alice").unwrap_err().code(),
            directory.resolve_identity("alice").unwrap_err().code(),
            directory.resolve_peer("alice").unwrap_err().code(),
            directory.lookup_entry("alice").unwrap_err().code(),
            directory.refresh().unwrap_err().code(),
        ] {
            assert_eq!(code, ErrorCode::EngineLocked);
        }
        assert!(!directory.threshold_met());
        assert!(directory.is_configured());
    }

    /// A §4.6 policy for `log_id` naming `authorities`, in whatever order.
    fn policy(log_id: [u8; 32], authorities: &[[u8; 32]], versions: &[u32]) -> AuthorityPolicyTBS {
        AuthorityPolicyTBS {
            label: f2z_kt_core::types::label_field(f2z_kt_core::policy::LABEL_AUTHORITY_POLICY)
                .expect("label"),
            kt_version: f2z_kt_core::KT_VERSION,
            log_id: LogId::new(log_id),
            vouching: f2z_kt_core::policy::VOUCHING_VOUCHED,
            authorities: authorities
                .iter()
                .map(|key| f2z_codec::types::PublicKey::new(*key))
                .collect::<Vec<_>>()
                .into(),
            max_validity_ms: 900_000,
            clock_skew_ms: 120_000,
            asserted_versions: versions.to_vec().into(),
            published_at_ms: 7,
        }
    }

    #[test]
    fn a_reordered_policy_is_the_same_policy() {
        // `require_authority_policy` compares key *sets*, so the pinned copy
        // must too: a log that reordered two authorities, or two
        // `asserted_versions`, has not changed its policy, and treating that
        // as a change would make the directory unusable for nothing
        // (#1027 review, F3).
        let one = policy([9; 32], &[[1; 32], [2; 32]], &[1, 3]);
        let other = policy([9; 32], &[[2; 32], [1; 32]], &[3, 1]);
        assert_ne!(one, other, "the derived comparison is order-sensitive");
        assert_eq!(comparable_policy(&one), comparable_policy(&other));

        // And it is still a comparison: a different authority, a different
        // set of asserted versions, and a different published time are not
        // all the same thing.
        assert_ne!(
            comparable_policy(&one),
            comparable_policy(&policy([9; 32], &[[1; 32], [3; 32]], &[1, 3]))
        );
        assert_ne!(
            comparable_policy(&one),
            comparable_policy(&policy([9; 32], &[[1; 32], [2; 32]], &[1]))
        );
        let mut later = policy([9; 32], &[[1; 32], [2; 32]], &[1, 3]);
        later.published_at_ms = 9_999;
        assert_eq!(
            comparable_policy(&one),
            comparable_policy(&later),
            "the one time-varying field is not a change"
        );
    }

    /// `policy_verdict`, as a pair of (what happened, what it decided).
    fn verdict(
        checked: core::result::Result<(), ClientError>,
        now: Option<AuthorityPolicyTBS>,
        pinned: Option<&AuthorityPolicyTBS>,
    ) -> PolicyVerdict {
        policy_verdict(checked, now, pinned)
    }

    #[test]
    fn a_policy_that_could_not_be_checked_is_reported_and_forgotten() {
        // #1027 review, F1, at the site that decides: an earlier version
        // latched EVERY failure, so one 429 from the log's own `/authority`
        // endpoint made the directory permanently unusable — under
        // `directory-rate-limited`, which §8's table tells the client to
        // retry, and with no UI anywhere to explain it.
        let pinned = comparable_policy(&policy([9; 32], &[[1; 32]], &[1]));
        for (error, expected) in [
            (
                ClientError::Refused(f2z_kt_core::ErrorCode::RateLimited),
                ErrorCode::DirectoryRateLimited,
            ),
            (
                ClientError::Unreachable("captive portal".to_owned()),
                ErrorCode::DirectoryUnreachable,
            ),
            (
                ClientError::Protocol(f2z_kt_core::KtError::Malformed),
                ErrorCode::DirectoryProtocolViolation,
            ),
        ] {
            match verdict(Err(error), None, Some(&pinned)) {
                PolicyVerdict::Report(reported) => assert_eq!(reported.code(), expected),
                other => panic!("{expected} must be reported, not {other:?}"),
            }
        }

        // And the statements still latch.
        for error in [
            ClientError::AuthorityPolicyMismatch,
            ClientError::Protocol(f2z_kt_core::KtError::BadSignature),
            ClientError::Protocol(f2z_kt_core::KtError::WrongLog),
        ] {
            assert!(
                matches!(
                    verdict(Err(error), None, Some(&pinned)),
                    PolicyVerdict::Latch(_)
                ),
                "a statement about vouching is remembered"
            );
        }

        // And what each verdict *does* to the state a lookup consults.
        let pin_slot = Mutex::new(None);
        let unusable = Mutex::new(None);
        let threshold_met = Mutex::new(true);
        let act = |verdict| {
            apply_verdict(
                verdict,
                pin_slot.lock().expect("pin"),
                &unusable,
                &threshold_met,
            )
        };
        let reported = act(PolicyVerdict::Report(Error::new(
            ErrorCode::DirectoryRateLimited,
            "the log is rate limiting its authority endpoint",
        )))
        .expect_err("a report is still an error to the caller");
        assert_eq!(reported.code(), ErrorCode::DirectoryRateLimited);
        assert!(
            unusable.lock().expect("unusable").is_none(),
            "a transient failure must leave the directory usable"
        );
        assert!(
            *threshold_met.lock().expect("threshold"),
            "and must not move the threshold either"
        );
        assert!(act(PolicyVerdict::Unchanged).is_ok());
        assert!(unusable.lock().expect("unusable").is_none());

        act(PolicyVerdict::Pin(pinned.clone())).expect("pinning is not a failure");
        assert_eq!(pin_slot.lock().expect("pin").as_ref(), Some(&pinned));

        let latched = act(PolicyVerdict::Latch(Error::new(
            ErrorCode::DirectoryUnvouched,
            "the policy changed",
        )))
        .expect_err("a latch is an error");
        assert_eq!(latched.code(), ErrorCode::DirectoryUnvouched);
        assert_eq!(
            unusable.lock().expect("unusable").as_ref().map(Error::code),
            Some(ErrorCode::DirectoryUnvouched)
        );
        assert!(!*threshold_met.lock().expect("threshold"));

        // A policy that verifies pins once, then agrees with itself, and a
        // change is a latch.
        assert!(matches!(
            verdict(Ok(()), Some(pinned.clone()), None),
            PolicyVerdict::Pin(_)
        ));
        assert!(matches!(
            verdict(Ok(()), Some(pinned.clone()), Some(&pinned)),
            PolicyVerdict::Unchanged
        ));
        let changed = comparable_policy(&policy([9; 32], &[[2; 32]], &[1]));
        match verdict(Ok(()), Some(changed), Some(&pinned)) {
            PolicyVerdict::Latch(refusal) => {
                assert_eq!(refusal.code(), ErrorCode::DirectoryUnvouched);
            }
            other => panic!("a changed policy is a latch, not {other:?}"),
        }
    }

    #[test]
    fn only_a_statement_about_vouching_is_latched() {
        // #1027 review, F1: an earlier version latched EVERY policy-fetch
        // failure, so one 429 from the log's own `/authority` endpoint made
        // the directory permanently unusable — under `directory-rate-limited`,
        // which §8's table tells the client to retry.
        for transient in [
            ClientError::Unreachable("timed out".to_owned()),
            ClientError::Refused(f2z_kt_core::ErrorCode::RateLimited),
            ClientError::Refused(f2z_kt_core::ErrorCode::Internal),
            ClientError::Protocol(f2z_kt_core::KtError::Malformed),
            ClientError::Protocol(f2z_kt_core::KtError::UnsupportedVersion),
            ClientError::CatchUpIncomplete {
                accepted_epoch: 1,
                target_epoch: 9,
            },
        ] {
            assert!(!latching(&transient), "{transient:?} must not be latched");
        }
        for statement in [
            ClientError::AuthorityPolicyMismatch,
            ClientError::Protocol(f2z_kt_core::KtError::BadSignature),
            ClientError::Protocol(f2z_kt_core::KtError::WrongLog),
        ] {
            assert!(latching(&statement), "{statement:?} must be latched");
        }
        // And only the two conditions that persist are ever shown as a
        // blocked directory.
        assert_eq!(
            blocking_code(ErrorCode::DirectoryUnvouched),
            Some(ErrorCode::DirectoryUnvouched)
        );
        assert_eq!(
            blocking_code(ErrorCode::DirectoryStateInvalid),
            Some(ErrorCode::DirectoryStateInvalid)
        );
        for other in [
            ErrorCode::DirectoryRateLimited,
            ErrorCode::DirectoryUnreachable,
            ErrorCode::DirectoryProofInvalid,
            ErrorCode::DirectoryProtocolViolation,
            ErrorCode::WitnessThresholdUnmet,
            ErrorCode::Internal,
        ] {
            assert_eq!(blocking_code(other), None, "{other} is not a blocked state");
        }
    }

    #[test]
    fn a_transient_refusal_leaves_nothing_blocked_and_a_later_success_recovers() {
        // The whole path, at the level this crate can drive without a log: a
        // connect that fails on the transport reports itself and blocks
        // nothing, so a retry — the next lookup — is free to succeed.
        let directory = BundledDirectory::new(config());
        directory.attach_checkpoints(Some(Arc::new(InMemory::default())));
        let first = directory.resolve("alice").unwrap_err();
        assert_ne!(first.code(), ErrorCode::EngineLocked);
        assert_eq!(
            directory.directory_blocked(),
            None,
            "an unreachable log is not a blocked directory"
        );
        // Nothing was remembered, so the state is exactly what it was: the
        // next call connects again rather than replaying a verdict.
        assert_eq!(
            directory.resolve("alice").unwrap_err().code(),
            first.code(),
            "the refusal is recomputed, not latched"
        );
        assert_eq!(directory.directory_blocked(), None);
    }

    #[test]
    fn detaching_the_store_puts_it_back_in_that_state() {
        let directory = BundledDirectory::new(config());
        directory.attach_checkpoints(Some(Arc::new(InMemory::default())));
        // `kt.invalid` does not resolve, so this is the transport's verdict
        // rather than the locked one: the store was accepted.
        assert_ne!(
            directory.resolve("alice").unwrap_err().code(),
            ErrorCode::EngineLocked
        );
        directory.attach_checkpoints(None);
        assert_eq!(
            directory.resolve("alice").unwrap_err().code(),
            ErrorCode::EngineLocked
        );
    }
}
