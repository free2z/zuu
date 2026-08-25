//! Fixtures for the tests, and only for the tests.
//!
//! Behind the `testing` feature so that nothing here is compiled into a
//! shipped `f2z-kt`. It is a feature rather than `#[cfg(test)]` because the
//! acceptance test for the **witness** needs to stand up a real log — a witness
//! verified against a mock is a witness that has not been tested — and an
//! integration test in another crate cannot see a `#[cfg(test)]` module.
//!
//! # The builders are deliberately capable of producing invalid entries
//!
//! Every adversarial test in this crate is a well-formed submission with one
//! thing wrong: a `prev_entry_hash` from the wrong entry, a rotation signed by
//! only one key, a reset inside its cooldown, a device credential signed by
//! somebody else's identity key, a first entry with no authority assertion. A
//! builder that could only produce correct entries could not write any of them,
//! so this one takes each field and signs whatever it is given.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::Canonical as _;
use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes, Signature};
use f2z_codec::vec::VecU16;
use f2z_kt_core::entry::{
    ContactEndpoint, DeviceCredential, DeviceCredentialTBS, DeviceRevocation, DirectoryEntry,
    DirectoryEntryTBS, EntryAuthorization, EntryKind, ResetAuthorization, ResetAuthorizationTBS,
    RotationProof, RotationProofTBS,
};
use f2z_kt_core::types::{Handle, KemPublicKey, LogId, label_field};
use f2z_kt_core::{KT_VERSION, labels};

use f2z_kt_core::api::{SubmissionEnvelope, TreeHeadBundle};

/// A unique scratch directory under the OS temporary directory.
///
/// Not `tempfile`: one more dependency in an AGPL binary's dev graph to do
/// something the standard library does in four lines. The counter makes
/// concurrent tests in one binary distinct, and the process id makes concurrent
/// test binaries distinct.
#[must_use]
pub fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("f2z-kt-{name}-{}-{unique}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

/// A deterministic Ed25519 key pair.
#[derive(Clone)]
pub struct Key {
    /// The signing half.
    pub signing: SigningKey,
    /// The public half, in this tree's newtype.
    pub public: PublicKey,
}

impl Key {
    /// Derive a key from a one-byte seed, so every test key is nameable.
    #[must_use]
    pub fn from_byte(seed: u8) -> Self {
        let signing = SigningKey::from_bytes(&[seed; 32]);
        let public = PublicKey::new(signing.verifying_key().to_bytes());
        Self { signing, public }
    }

    /// Sign a message.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> Signature {
        Signature::new(self.signing.sign(message).to_bytes())
    }
}

/// A user: an identity signing key and a directory-auth key (`KT.md` §4.4's
/// use-separation).
#[derive(Clone)]
pub struct Identity {
    /// Signs `DeviceCredential`s and `RotationProof`s.
    pub isk: Key,
    /// Signs the entry envelope.
    pub dak: Key,
}

impl Identity {
    /// Two keys derived from one seed byte, distinct from each other.
    #[must_use]
    pub fn from_byte(seed: u8) -> Self {
        Self {
            isk: Key::from_byte(seed),
            dak: Key::from_byte(seed.wrapping_add(0x80)),
        }
    }
}

/// Build a `DirectoryEntry`, correct or otherwise.
pub struct EntryBuilder {
    log_id: LogId,
    handle: Handle,
    entry_version: u32,
    kind: EntryKind,
    identity_pk: PublicKey,
    directory_auth_pk: PublicKey,
    devices: Vec<DeviceCredential>,
    revocations: Vec<DeviceRevocation>,
    endpoints: Vec<ContactEndpoint>,
    prev_entry_hash: Digest,
    no_reset: u8,
    created_at_ms: u64,
}

impl EntryBuilder {
    /// Start a first entry for a handle.
    ///
    /// # Panics
    ///
    /// If `handle` is not `[a-z0-9_]{1,30}`.
    #[must_use]
    pub fn first(log_id: LogId, handle: &str, identity: &Identity) -> Self {
        Self {
            log_id,
            handle: Handle::new(handle.as_bytes().to_vec()).unwrap(),
            entry_version: 1,
            kind: EntryKind::SameKey,
            identity_pk: identity.isk.public,
            directory_auth_pk: identity.dak.public,
            devices: Vec::new(),
            revocations: Vec::new(),
            endpoints: Vec::new(),
            prev_entry_hash: Digest::zero(),
            no_reset: 0,
            created_at_ms: 1_700_000_000_000,
        }
    }

    /// Set the version.
    #[must_use]
    pub const fn version(mut self, version: u32) -> Self {
        self.entry_version = version;
        self
    }

    /// Set the kind.
    #[must_use]
    pub const fn kind(mut self, kind: EntryKind) -> Self {
        self.kind = kind;
        self
    }

    /// Set the identity key in force from this entry on.
    #[must_use]
    pub const fn identity_pk(mut self, key: PublicKey) -> Self {
        self.identity_pk = key;
        self
    }

    /// Set the directory-auth key published by this entry.
    #[must_use]
    pub const fn directory_auth_pk(mut self, key: PublicKey) -> Self {
        self.directory_auth_pk = key;
        self
    }

    /// Set `prev_entry_hash`.
    #[must_use]
    pub const fn prev_entry_hash(mut self, hash: Digest) -> Self {
        self.prev_entry_hash = hash;
        self
    }

    /// Set ADR 0014's `no_reset`.
    #[must_use]
    pub const fn no_reset(mut self, value: bool) -> Self {
        self.no_reset = if value { 1 } else { 0 };
        self
    }

    /// Set `created_at_ms`.
    #[must_use]
    pub const fn created_at_ms(mut self, value: u64) -> Self {
        self.created_at_ms = value;
        self
    }

    /// Add a device credential signed by `signer` — which is `identity` for a
    /// correct entry and somebody else for the adversarial case.
    ///
    /// # Panics
    ///
    /// If the KEM key will not fit, which it always will.
    #[must_use]
    pub fn device(mut self, device_seed: u8, signer: &Key) -> Self {
        let device = Key::from_byte(device_seed);
        let credential = DeviceCredentialTBS {
            label: label_field(labels::LABEL_DEVICE_CREDENTIAL).unwrap(),
            identity_pk: self.identity_pk,
            handle: self.handle.clone(),
            device_pk: device.public,
            device_kem_pk: KemPublicKey::new(vec![device_seed; 1216]).unwrap(),
            not_before_ms: 1_700_000_000_000,
            not_after_ms: 1_900_000_000_000,
        };
        let signature = signer.sign(&credential.signing_bytes().unwrap());
        self.devices.push(DeviceCredential {
            credential,
            signature,
        });
        self
    }

    /// Add a contact endpoint.
    ///
    /// # Panics
    ///
    /// If the URL will not fit, which it always will.
    #[must_use]
    pub fn endpoint(mut self, seed: u8) -> Self {
        self.endpoints.push(ContactEndpoint {
            relay_url: ShortBytes::new(b"wss://relay.free2z.cash/relay/v1".to_vec()).unwrap(),
            relay_id: RelayId::new([seed; 32]),
            contact_addr: QueueAddress::new([seed.wrapping_add(1); 32]),
        });
        self
    }

    /// The unsigned body.
    ///
    /// # Panics
    ///
    /// If a field will not encode, which it will.
    #[must_use]
    pub fn tbs(&self) -> DirectoryEntryTBS {
        DirectoryEntryTBS {
            label: label_field(labels::LABEL_ENTRY).unwrap(),
            kt_version: KT_VERSION,
            log_id: self.log_id,
            handle: self.handle.clone(),
            entry_version: self.entry_version,
            kind: self.kind,
            identity_pk: self.identity_pk,
            directory_auth_pk: self.directory_auth_pk,
            devices: VecU16::new(self.devices.clone()),
            revocations: VecU16::new(self.revocations.clone()),
            contact_endpoints: VecU16::new(self.endpoints.clone()),
            prev_entry_hash: self.prev_entry_hash,
            no_reset: self.no_reset,
            created_at_ms: self.created_at_ms,
        }
    }

    /// Finish a `same_key` entry, signed by `auth`.
    ///
    /// # Panics
    ///
    /// If the body will not encode.
    #[must_use]
    pub fn same_key(self, auth: &Key) -> DirectoryEntry {
        let entry = self.tbs();
        let auth_signature = auth.sign(&entry.signing_bytes().unwrap());
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::SameKey { auth_signature },
        }
    }

    /// Finish a `key_change` entry.
    ///
    /// Every part of the `RotationProof` is a parameter so a test can produce
    /// the exact malformation it means to: a proof for another handle, a proof
    /// signed by the *new* key, a proof for the wrong version.
    ///
    /// # Panics
    ///
    /// If the body will not encode.
    #[must_use]
    pub fn key_change(
        self,
        rotation_signer: &Key,
        old_identity_pk: PublicKey,
        auth: &Key,
    ) -> DirectoryEntry {
        let entry = self.tbs();
        let proof = RotationProofTBS {
            label: label_field(labels::LABEL_ROTATION).unwrap(),
            log_id: entry.log_id,
            handle: entry.handle.clone(),
            entry_version: entry.entry_version,
            old_identity_pk,
            new_identity_pk: entry.identity_pk,
            prev_entry_hash: entry.prev_entry_hash,
            created_at_ms: entry.created_at_ms,
        };
        let signature = rotation_signer.sign(&proof.signing_bytes().unwrap());
        let auth_signature = auth.sign(&entry.signing_bytes().unwrap());
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::KeyChange {
                rotation: RotationProof { proof, signature },
                auth_signature,
            },
        }
    }

    /// Finish a `platform_reset` entry.
    ///
    /// # Panics
    ///
    /// If the body will not encode.
    #[must_use]
    pub fn platform_reset(
        self,
        reset_authority: &Key,
        old_identity_pk: PublicKey,
        effective_at_ms: u64,
        auth: &Key,
    ) -> DirectoryEntry {
        let entry = self.tbs();
        let reset = ResetAuthorizationTBS {
            label: label_field(labels::LABEL_RESET).unwrap(),
            log_id: entry.log_id,
            handle: entry.handle.clone(),
            entry_version: entry.entry_version,
            old_identity_pk,
            new_identity_pk: entry.identity_pk,
            created_at_ms: entry.created_at_ms,
            effective_at_ms,
        };
        let reset_signature = reset_authority.sign(&reset.signing_bytes().unwrap());
        let auth_signature = auth.sign(&entry.signing_bytes().unwrap());
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::PlatformReset {
                reset: ResetAuthorization {
                    reset,
                    reset_signature,
                },
                auth_signature,
            },
        }
    }
}

/// A per-assertion nonce derived from what the assertion is about.
fn nonce_for(handle: &[u8], identity_pk: &PublicKey) -> [u8; 16] {
    let mut input = handle.to_vec();
    input.extend_from_slice(identity_pk.as_bytes());
    let digest = f2z_codec::hash::hash(b"f2z-kt/testing/nonce", &input);
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(digest.as_bytes().get(..16).unwrap_or(&[0u8; 16]));
    nonce
}

/// The canonical bytes of an entry.
///
/// # Panics
///
/// If the entry will not encode.
#[must_use]
pub fn entry_bytes(entry: &DirectoryEntry) -> Vec<u8> {
    entry.encode_canonical().unwrap()
}

/// Wrap an entry in a submission envelope with **no** assertion and an all-zero
/// identity signature.
///
/// The shape a `same_key` or `key_change` submission has above version 1, and
/// simultaneously the adversarial shape for a first entry — which is exactly
/// zuu#594's hole, and is why this is one function rather than two.
///
/// # Panics
///
/// If the envelope will not encode.
#[must_use]
pub fn envelope_without_claim(entry: &DirectoryEntry) -> Vec<u8> {
    let bytes = entry_bytes(entry);
    SubmissionEnvelope::new(&bytes, None, Signature::zero())
        .unwrap()
        .encode_canonical()
        .unwrap()
}

/// A bundle with a placeholder head, for the shape tests in [`crate::wire`].
///
/// # Panics
///
/// If the bundle will not build.
#[must_use]
pub fn empty_bundle() -> TreeHeadBundle {
    let sth = f2z_kt_core::sth::SignedTreeHeadTBS {
        label: label_field(labels::LABEL_STH).unwrap(),
        kt_version: KT_VERSION,
        log_id: LogId::zero(),
        epoch: 1,
        tree_size: 1,
        root_hash: Digest::zero(),
        prev_sth_hash: Digest::zero(),
        vrf_public_key: PublicKey::zero(),
        published_at_ms: 1,
        reset_count: 0,
        epoch_interval_seconds: 600,
        max_merge_delay_seconds: 3_600,
        successor_log_pk: PublicKey::zero(),
    };
    TreeHeadBundle::new(
        f2z_kt_core::sth::SignedTreeHead {
            sth,
            signature: Signature::zero(),
        },
        Vec::new(),
    )
    .unwrap()
}

/// What a test wants to say instead of the fixture's defaults, when the
/// assertion's own fields are the thing under test.
///
/// [`Harness::envelope`] derives every field from the entry so that a test
/// about §4.4 never accidentally trips over the assertion layer. The two rules
/// that only a *badly issued* assertion can exercise — A17's
/// `(authority_id, nonce)` ledger and §4.5.4's `account_epoch` — need the
/// opposite, so they get this.
#[derive(Clone, Copy, Default)]
pub struct AssertionOverrides {
    /// The 16-byte assertion nonce. Reusing one across two assertions is what
    /// A17 exists to refuse, and it is not otherwise producible.
    pub nonce: Option<[u8; 16]>,
    /// `account_epoch`, so a test can supply the clock-derived value `KT.md`
    /// §4.5.4 forbids.
    pub account_epoch: Option<u32>,
    /// `issued_ms`; defaults to the submission's `now_ms`.
    pub issued_ms: Option<u64>,
    /// `expires_ms`; defaults to `issued_ms + 60_000`.
    pub expires_ms: Option<u64>,
}

/// Hand-written, and the workspace `Debug` scan is what insists on it: a
/// derived `Debug` over `Option<[u8; 16]>` renders the nonce as a decimal byte
/// dump, which is a dump.
impl core::fmt::Debug for AssertionOverrides {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("AssertionOverrides")
            .field("nonce", &self.nonce.map(|_| "<redacted; 16 bytes>"))
            .field("account_epoch", &self.account_epoch)
            .field("issued_ms", &self.issued_ms)
            .field("expires_ms", &self.expires_ms)
            .finish()
    }
}

impl AssertionOverrides {
    /// Override only the nonce.
    #[must_use]
    pub const fn nonce(nonce: [u8; 16]) -> Self {
        Self {
            nonce: Some(nonce),
            account_epoch: None,
            issued_ms: None,
            expires_ms: None,
        }
    }

    /// Override only `account_epoch`.
    #[must_use]
    pub const fn account_epoch(epoch: u32) -> Self {
        Self {
            nonce: None,
            account_epoch: Some(epoch),
            issued_ms: None,
            expires_ms: None,
        }
    }

    /// Also override the nonce.
    #[must_use]
    pub const fn with_nonce(mut self, nonce: [u8; 16]) -> Self {
        self.nonce = Some(nonce);
        self
    }
}

/// A whole log, in-process, with everything the acceptance tests need to drive
/// it: keys, an authority, and a clock they control.
pub struct Harness {
    /// The service.
    pub log: Arc<crate::log::LogService>,
    /// The log signing key, so a test can verify what the log signed.
    pub log_key: Key,
    /// The pinned reset authority (ADR 0014).
    pub reset_authority: Key,
    /// The handle-assertion issuer, or `None` on a no-authority log.
    pub issuer: Option<f2z_authority::key::SigningKey>,
    /// The log's identifier.
    pub log_id: LogId,
    /// Where the journals are.
    pub dir: PathBuf,
}

impl Harness {
    /// Stand up a log with one handle authority.
    ///
    /// # Panics
    ///
    /// If the log will not start, which is a bug in the fixture.
    pub async fn vouched(name: &str) -> Self {
        Self::build(name, true, Vec::new()).await
    }

    /// Stand up a log in the explicit no-authority mode (zuu#594).
    ///
    /// # Panics
    ///
    /// If the log will not start.
    pub async fn unvouched(name: &str) -> Self {
        Self::build(name, false, Vec::new()).await
    }

    /// Stand up a log that **recognises** `witnesses` as cosigners.
    ///
    /// Separate from [`Harness::vouched`] on purpose: a log with no configured
    /// witness keys accepts no cosignatures at all (zuu#669), so a fixture that
    /// quietly configured one would hide the very rule that issue is about.
    /// A test that wants a cosignature stored has to say whose.
    ///
    /// # Panics
    ///
    /// If the log will not start.
    pub async fn vouched_with_witnesses(name: &str, witnesses: Vec<PublicKey>) -> Self {
        Self::build(name, true, witnesses).await
    }

    async fn build(name: &str, vouched: bool, witnesses: Vec<PublicKey>) -> Self {
        let dir = temp_dir(name);
        let log_key = Key::from_byte(0xa1);
        let reset_authority = Key::from_byte(0xa2);
        let issuer = vouched.then(|| f2z_authority::key::SigningKey::from_seed(&[0xa3; 32]));

        let log_id = labels::log_id(&log_key.public);
        let mut settings =
            crate::config::LogSettings::defaults(log_key.public, reset_authority.public).unwrap();
        settings.reset_cooldown_seconds = 60;

        let set = match &issuer {
            Some(key) => f2z_authority::authority::AuthoritySet::single(key.public_key()).unwrap(),
            None => f2z_authority::authority::AuthoritySet::none(),
        };
        let authority = f2z_authority::authority::AuthorityConfig::with_defaults(
            f2z_authority::types::LogId::new(*log_id.as_bytes()),
            set,
        )
        .unwrap();

        let signer = Arc::new(crate::signer::FileSigner::from_seed(&[0xa1; 32]));
        let vrf = crate::vrf::FileVrf::from_seed([0xb0; 32]).unwrap();
        let log = crate::log::LogService::open(&dir, settings, signer, vrf, authority, witnesses)
            .await
            .unwrap();

        Self {
            log: Arc::new(log),
            log_key,
            reset_authority,
            issuer,
            log_id,
            dir,
        }
    }

    /// Build a submission envelope for `entry`, with whatever the assertion
    /// layer requires of it.
    ///
    /// An assertion is attached for a first entry and for a `platform_reset` on
    /// a vouched log, and for nothing else — `same_key` and `key_change` are
    /// user-authorized under `KT.md` §4.4 and reject a platform assertion as a
    /// category error. The identity binding is signed on **every** path.
    ///
    /// # Panics
    ///
    /// If any part will not encode.
    pub fn envelope(&self, entry: &DirectoryEntry, identity: &Identity, now_ms: u64) -> Vec<u8> {
        self.envelope_with(entry, identity, now_ms, true)
    }

    /// Attach an assertion **regardless of entry kind**, with a correctly
    /// derived binding signature.
    ///
    /// For the adversarial case where the only thing wrong is that a platform
    /// assertion is present on a user-authorized entry — `f2z-authority` calls
    /// that a category error, and this is how a test produces one without also
    /// breaking the binding.
    ///
    /// # Panics
    ///
    /// If any part will not encode.
    pub fn envelope_forcing_assertion(
        &self,
        entry: &DirectoryEntry,
        identity: &Identity,
        now_ms: u64,
    ) -> Vec<u8> {
        let bytes = entry_bytes(entry);
        let digest = labels::entry_value(&bytes);
        let handle = f2z_authority::types::Handle::parse(entry.entry.handle.as_slice()).unwrap();
        let issuer = self
            .issuer
            .as_ref()
            .expect("envelope_forcing_assertion needs a vouched harness");
        let intent = if entry.entry.entry_version == 1 {
            f2z_authority::types::Intent::Bind
        } else {
            f2z_authority::types::Intent::Reset
        };
        let assertion = f2z_authority::HandleAssertionTBS::new(
            &issuer.public_key(),
            f2z_authority::types::LogId::new(*self.log_id.as_bytes()),
            handle.clone(),
            entry.entry.identity_pk,
            intent,
            u32::from(entry.entry.entry_version > 1),
            now_ms,
            now_ms.saturating_add(60_000),
            f2z_authority::types::AssertionNonce::new(nonce_for(
                entry.entry.handle.as_slice(),
                &entry.entry.identity_pk,
            )),
        )
        .unwrap()
        .sign(issuer)
        .unwrap();

        let binding = self
            .log
            .authority()
            .binding(&handle, &entry.entry.identity_pk, Some(&assertion), &digest)
            .unwrap();
        let identity_signature = identity.isk.sign(&binding.signing_bytes().unwrap());
        SubmissionEnvelope::new(
            &bytes,
            Some(&assertion.encode_canonical().unwrap()),
            identity_signature,
        )
        .unwrap()
        .encode_canonical()
        .unwrap()
    }

    /// As [`Harness::envelope`], but with the assertion's own fields chosen by
    /// the caller.
    ///
    /// The one way to produce a **badly issued** assertion: a reused nonce
    /// (A17) or a clock-derived `account_epoch` (§4.5.4). Both rules are about
    /// what the issuer *supplied*, and a fixture that always supplies a
    /// conforming value cannot exercise either — which is exactly how both
    /// defects survived review.
    ///
    /// # Panics
    ///
    /// If any part will not encode, or if the harness has no issuer.
    #[must_use]
    pub fn envelope_overriding(
        &self,
        entry: &DirectoryEntry,
        identity: &Identity,
        now_ms: u64,
        overrides: AssertionOverrides,
    ) -> Vec<u8> {
        self.build_envelope(entry, identity, now_ms, true, overrides)
    }

    /// As [`Harness::envelope`], but optionally omitting the assertion — the
    /// adversarial case zuu#594 is about.
    ///
    /// # Panics
    ///
    /// If any part will not encode.
    pub fn envelope_with(
        &self,
        entry: &DirectoryEntry,
        identity: &Identity,
        now_ms: u64,
        with_assertion: bool,
    ) -> Vec<u8> {
        self.build_envelope(
            entry,
            identity,
            now_ms,
            with_assertion,
            AssertionOverrides::default(),
        )
    }

    fn build_envelope(
        &self,
        entry: &DirectoryEntry,
        identity: &Identity,
        now_ms: u64,
        with_assertion: bool,
        overrides: AssertionOverrides,
    ) -> Vec<u8> {
        let bytes = entry_bytes(entry);
        let digest = labels::entry_value(&bytes);
        let handle = f2z_authority::types::Handle::parse(entry.entry.handle.as_slice()).unwrap();

        let wants_assertion =
            entry.entry.entry_version == 1 || matches!(entry.entry.kind, EntryKind::PlatformReset);
        let assertion = match (&self.issuer, with_assertion && wants_assertion) {
            (Some(issuer), true) => {
                let intent = if entry.entry.entry_version == 1 {
                    f2z_authority::types::Intent::Bind
                } else {
                    f2z_authority::types::Intent::Reset
                };
                let issued_ms = overrides.issued_ms.unwrap_or(now_ms);
                // Built field by field rather than through
                // `HandleAssertionTBS::new`, which refuses a clock-shaped
                // `account_epoch` outright — a real issuer should, and a test
                // standing in for a non-conforming one must be able to mint
                // what that issuer mints.
                let tbs = f2z_authority::HandleAssertionTBS {
                    label: ShortBytes::new(f2z_authority::labels::LABEL_ASSERTION_TBS.to_vec())
                        .unwrap(),
                    authority_id: f2z_authority::authority_id(&issuer.public_key()),
                    log_id: f2z_authority::types::LogId::new(*self.log_id.as_bytes()),
                    handle_id: handle.handle_id(),
                    handle: handle.clone(),
                    identity_pk: entry.entry.identity_pk,
                    intent,
                    // Strictly greater than the predecessor's retained epoch;
                    // a reset is a distinct account-ownership event.
                    account_epoch: overrides
                        .account_epoch
                        .unwrap_or_else(|| u32::from(entry.entry.entry_version > 1)),
                    issued_ms,
                    expires_ms: overrides
                        .expires_ms
                        .unwrap_or_else(|| issued_ms.saturating_add(60_000)),
                    // Derived from the handle and the identity key rather than
                    // from the clock: two registrations in one millisecond are
                    // ordinary, and a fixture that reused a nonce would be
                    // testing the nonce ledger instead of whatever the test is
                    // about. (It caught exactly that the first time.)
                    nonce: f2z_authority::types::AssertionNonce::new(
                        overrides.nonce.unwrap_or_else(|| {
                            nonce_for(entry.entry.handle.as_slice(), &entry.entry.identity_pk)
                        }),
                    ),
                };
                Some(tbs.sign(issuer).unwrap())
            }
            _ => None,
        };

        let binding = self
            .log
            .authority()
            .binding(
                &handle,
                &entry.entry.identity_pk,
                assertion.as_ref(),
                &digest,
            )
            .unwrap();
        let identity_signature = identity.isk.sign(&binding.signing_bytes().unwrap());

        let assertion_bytes = assertion.as_ref().map(|a| a.encode_canonical().unwrap());
        SubmissionEnvelope::new(&bytes, assertion_bytes.as_deref(), identity_signature)
            .unwrap()
            .encode_canonical()
            .unwrap()
    }
}
