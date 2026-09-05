//! Where a device's `DeviceWrapKey` lives, on each platform this ships to.
//!
//! [ADR 0016](../../../../docs/e2ee/decisions/0016-enrollment-sealing-boundary.md)
//! §3 decides that the app which generated a device's secrets seals them under
//! a `DeviceWrapKey` it samples from the OS CSPRNG and **holds in the OS secret
//! store**. That decision needs a secret store to exist. This module is the one
//! that exists, and it is the answer to #937: before it,
//! `tauri-plugin-zcash`'s `keychain.rs:332-352` was the only secret store in
//! the tree, it returns `UnavailableStore` for every non-desktop target, and
//! `cash.free2z.e2e2z` must not link that crate at all
//! (`wallet/e2e2z/scripts/authority-boundary.node-test.mjs`).
//!
//! So this is a second, deliberately *unprivileged* custody layer: it holds one
//! 32-byte device-local key, it knows nothing about seeds or mnemonics, and it
//! links no wallet crate. `tauri-plugin-zcash` keeps its own — the two answer
//! different questions and want opposite policies, which §2 below is about.
//!
//! # 1. The namespace comes from the host application, not from here
//!
//! ADR 0016 §3 is explicit about this and it is not tidiness. This plugin is
//! linked into **both** ZUULI and e2e2z. A plugin-level `const SERVICE` would
//! give the two apps the *same* item name, and on the freedesktop Secret
//! Service — which has no per-application isolation — that is either mutual
//! overwrite or one app silently opening the other's key. So
//! [`WrapKeyNamespace`] is supplied by the host at `init`, following
//! `tauri-plugin-zcash`'s `const SERVICE = "cash.free2z.zuuli.seed.v1"`
//! (`keychain.rs:17`): one app, one purpose, one version.
//!
//! [`WrapKeyNamespace::for_app`] additionally requires the namespace to begin
//! with the host's own bundle identifier. A constant is only reviewable if a
//! copy-paste between the two apps is *caught*, and this is what catches it:
//! e2e2z shipping `cash.free2z.zuuli.f2zmsg.wrap.v1` is precisely the bug the
//! per-app namespace exists to prevent, and it would otherwise be invisible.
//!
//! # 2. The accessibility policy, and why it is the opposite of the seed's
//!
//! `tauri-plugin-zcash` guards the mnemonic with
//! `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` plus `.userPresence` on iOS,
//! and `setUserAuthenticationRequired(true)` on Android. That is right for a
//! seed: spending is user-initiated, so a biometric prompt costs nothing and
//! buys a great deal.
//!
//! **It would be wrong here, and not by a little.** The `DeviceWrapKey` is
//! opened by the inbound poll (`lib.rs`'s `POLL_INTERVAL` loop) and by any
//! background delivery path — work that happens with no user present and often
//! with the screen locked. A wrap key behind a biometric prompt is a wrap key
//! that cannot be opened in the background, and per ADR 0016 §3.5 an engine
//! that cannot open its wrap key at launch is one launch away from
//! re-enrolling and minting a directory entry the user must be told about.
//!
//! So, deliberately, on both platforms:
//!
//! * **iOS — `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and no
//!   `SecAccessControl`.** `WhenUnlocked` would make the item unreadable
//!   whenever the screen is locked, which is most of when a messaging app has
//!   work to do. `AfterFirstUnlock` is readable from the first unlock after
//!   boot until power-off, which is the window background queue processing
//!   actually runs in. The cost is stated rather than hidden: between a reboot
//!   and the user's first unlock the key is unavailable and the engine is
//!   `locked` — which is correct, and is why ADR 0016 §3 requires `locked` to
//!   have a seed-free retry rather than an automatic re-enroll.
//!   `ThisDeviceOnly` is not the default and is chosen: `ARCHITECTURE.md`
//!   §4.2 says device keys are "never exported", so iCloud Keychain sync would
//!   be a protocol violation, and a device backup restoring onto new hardware
//!   would resurrect a device the directory believes is one machine.
//!
//! * **Android — an `AndroidKeyStore` AES-256-GCM key with neither
//!   `setUserAuthenticationRequired` nor `setUnlockedDeviceRequired`.**
//!   `setUnlockedDeviceRequired(true)` is the direct analogue of iOS
//!   `WhenUnlocked` and is refused for the same reason. StrongBox is requested
//!   where the device offers it and falls back to the TEE, and then to the
//!   software keystore; the actual backing is reported back and logged rather
//!   than assumed, because "hardware-backed" is a claim about a specific
//!   handset and this process cannot verify it. A software-backed keystore key
//!   is still meaningfully better than a file beside the store — it is not
//!   readable by copying the app's data directory — so it is accepted, and it
//!   is accepted *visibly*.
//!
//! # 3. What happens where there is no store at all: refuse
//!
//! ADR 0016 §3.5 proposes refusing to enroll, flags that the rule is inferred
//! from this tree's fail-closed doctrine rather than read anywhere, and §9
//! option F offers the alternative — hold the key in the app's data directory
//! and say so in the UI. **This module implements the refusal.** The reason is
//! the one §3.5 identifies as deciding, and it is not about the strength of the
//! seal:
//!
//! > If `DeviceWrapKey` is unretrievable at launch and the app re-enrolls
//! > automatically, every launch mints a new device, a new credential and a new
//! > directory entry — and `ARCHITECTURE.md:318-322` requires every one of
//! > those to be surfaced to the user as a possible wiretap.
//!
//! A wiretap notification the user sees once is protection. One they see on
//! every launch is training to dismiss the only signal that protects them, and
//! it is durable in a way the seal is not: the directory log is append-only and
//! public, so a phantom device is permanent. Refusing costs one refusal, at the
//! moment when a refusal is all it costs.
//!
//! Option F was not rejected, and is not rejected here — it is *not yet
//! needed*. It becomes the answer the day a real user is locked out by this
//! refusal, and its condition stands: a data-directory fallback must be visible
//! in the UI and in engine status, never silent. Taking it now would mean
//! shipping the weaker seal before anyone has demonstrated the stronger one
//! locks anybody out, and it cannot be un-shipped once devices hold keys under
//! it.
//!
//! The refusal is placed at [`crate::engine::Engine::prepare_device`], which is
//! the first step of enrollment in both apps and runs **before** any device
//! material is handed out — so nothing is minted, nothing is published, and
//! nothing has to be cleaned up.
//!
//! # 4. Why the check is a round trip and not a platform guess
//!
//! [`WrapKeyCustody::probe`] writes a random value under a probe account, reads
//! it back, compares it, and deletes it. It does not ask "is this a platform we
//! believe has a keychain" — that question has the wrong answer on a Linux box
//! with no Secret Service daemon, on a locked keychain, on an emulator with no
//! keystore, and on any handset whose vendor did something unexpected.
//!
//! What the probe proves is bounded and worth stating exactly: **the store
//! accepts a write and returns it, now.** It does not prove the value survives
//! a reboot — nothing in this process can prove that — and it does not prove
//! the item will still be readable when the accessibility class says it should
//! be. It catches the failure that actually happens, which is that there is no
//! backend at all.

use std::sync::Arc;

use rand::Rng as _;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::models::ErrorCode;

/// The account name the device wrap key is stored under.
///
/// Versioned because the *format* under it is a compatibility surface: a future
/// key that is not 32 raw bytes hex-encoded must not be handed to a build that
/// expects these. The service name carries its own `.v1` for the same reason at
/// a different granularity — that one versions the whole item namespace.
pub const WRAP_KEY_ACCOUNT: &str = "device-wrap-key.v1";

/// The account [`WrapKeyCustody::probe`] writes to and deletes.
///
/// Deliberately a *different* account from [`WRAP_KEY_ACCOUNT`]: a probe that
/// wrote to the real slot would destroy the wrap key of an enrolled device
/// every time enrollment was re-attempted.
pub const PROBE_ACCOUNT: &str = "device-wrap-key-probe.v1";

/// A wrap key is 32 bytes, hex-encoded for stores that hold strings.
const WRAP_KEY_LEN: usize = 32;

/// Why a secret-store operation did not succeed.
///
/// Structured rather than stringly, and for the same reason
/// `tauri-plugin-zcash`'s `SecureStoreError` is: the caller has to tell "there
/// is no key here" from "there is no store here", and flattening them would
/// make an absent backend look like a fresh install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyError {
    /// The store works and holds no such item. The only non-failure failure.
    NotFound,
    /// The store exists but will not answer right now — a locked keychain, a
    /// keystore that wants an unlocked device. Distinct from `Unavailable`
    /// because it may succeed later without anything being reinstalled.
    Locked,
    /// An item came back that is not a wrap key: wrong length, not hex, or a
    /// keystore key that was invalidated underneath us.
    Corrupt,
    /// There is no backend. No daemon, no keystore, an unsupported target.
    Unavailable,
    /// The backend answered with something this module does not classify.
    Backend(String),
}

impl core::fmt::Display for CustodyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NotFound => f.write_str("no device wrap key is stored"),
            Self::Locked => f.write_str("the secret store is locked"),
            Self::Corrupt => f.write_str("the stored device wrap key is malformed"),
            Self::Unavailable => f.write_str("no OS secret store is available"),
            Self::Backend(detail) => write!(f, "the secret store failed: {detail}"),
        }
    }
}

/// The minimal adapter each platform backend implements.
///
/// String-valued rather than byte-valued because every backend underneath is:
/// `keyring` stores passwords, and the mobile bridge carries JSON. The
/// hex encode/decode and the zeroizing live in [`WrapKeyCustody`] so that no
/// backend can get them subtly different.
pub trait WrapKeyStore: Send + Sync {
    /// Write `value` under `account`, replacing any existing item.
    fn put(&self, account: &str, value: &str) -> core::result::Result<(), CustodyError>;
    /// Read the item at `account`.
    fn get(&self, account: &str) -> core::result::Result<Zeroizing<String>, CustodyError>;
    /// Remove the item at `account`. Removing an absent item is `NotFound`.
    fn delete(&self, account: &str) -> core::result::Result<(), CustodyError>;
}

/// A rejected [`WrapKeyNamespace`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceError {
    /// Empty, over-long, or containing something other than `[a-z0-9.-]`.
    Malformed(String),
    /// Well-formed, but not this application's. See the module header §1.
    ForeignApplication {
        namespace: String,
        identifier: String,
    },
}

impl core::fmt::Display for NamespaceError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Malformed(namespace) => write!(
                f,
                "{namespace:?} is not a usable secret-store service name: it must be 1..=128 \
                 characters of [a-z0-9.-], contain at least two dots, and neither begin nor end \
                 with one"
            ),
            Self::ForeignApplication {
                namespace,
                identifier,
            } => write!(
                f,
                "{namespace:?} is not this application's secret-store namespace: it must begin \
                 with {identifier:?} followed by a dot. A namespace copied from the other app \
                 would make both apps share one device wrap key (ADR 0016 §3)"
            ),
        }
    }
}

/// The secret-store service name for one application and one purpose.
///
/// See the module header §1 for why this is the host's to choose and not this
/// crate's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrapKeyNamespace(Arc<str>);

impl WrapKeyNamespace {
    /// The maximum length. Not a platform limit — a sanity bound, so a
    /// namespace built by accident from something unbounded is rejected here
    /// rather than truncated by a backend.
    const MAX_LEN: usize = 128;

    /// Validate the shape of a service name, without checking whose it is.
    ///
    /// # Errors
    ///
    /// [`NamespaceError::Malformed`] if it is not 1..=128 characters of
    /// `[a-z0-9.-]` with at least two interior dots.
    pub fn new(namespace: &str) -> core::result::Result<Self, NamespaceError> {
        let malformed = || NamespaceError::Malformed(namespace.to_owned());
        if namespace.is_empty() || namespace.len() > Self::MAX_LEN {
            return Err(malformed());
        }
        if !namespace.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        }) {
            return Err(malformed());
        }
        if namespace.starts_with('.') || namespace.ends_with('.') || namespace.contains("..") {
            return Err(malformed());
        }
        if namespace.matches('.').count() < 2 {
            return Err(malformed());
        }
        Ok(Self(Arc::from(namespace)))
    }

    /// Validate a service name *and* that it belongs to this application.
    ///
    /// `identifier` is the host's Tauri bundle identifier
    /// (`app.config().identifier`) — `cash.free2z.zuuli` or
    /// `cash.free2z.e2e2z`. Requiring the namespace to be a dotted extension of
    /// it is what makes a copy-pasted constant a startup failure instead of two
    /// apps quietly sharing one wrap key.
    ///
    /// # Errors
    ///
    /// [`NamespaceError::Malformed`] per [`Self::new`], or
    /// [`NamespaceError::ForeignApplication`] if it is not under `identifier`.
    pub fn for_app(
        namespace: &str,
        identifier: &str,
    ) -> core::result::Result<Self, NamespaceError> {
        let validated = Self::new(namespace)?;
        let prefix = format!("{}.", identifier.to_ascii_lowercase());
        if !namespace.starts_with(&prefix) {
            return Err(NamespaceError::ForeignApplication {
                namespace: namespace.to_owned(),
                identifier: identifier.to_owned(),
            });
        }
        Ok(validated)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Which backend a [`WrapKeyCustody`] is actually talking to.
///
/// Reported rather than inferred, because "which store is this" is the first
/// question a support log has to answer and the platform alone does not settle
/// it: a Linux desktop with no Secret Service daemon and an unsupported target
/// are both `Unavailable`, and they need different advice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyKind {
    /// The OS secret store: keychain, Secret Service, credential manager,
    /// iOS Keychain, or `AndroidKeyStore`.
    Platform,
    /// Process memory. Durable across nothing at all — tests and the relay
    /// harness only. See [`WrapKeyCustody::in_memory`].
    InMemory,
    /// No store. Every operation refuses, which is the module header §3 rule.
    Unavailable,
}

/// Custody of this device's `DeviceWrapKey`.
///
/// Cheap to clone; the backend is shared.
#[derive(Clone)]
pub struct WrapKeyCustody {
    namespace: Option<WrapKeyNamespace>,
    store: Arc<dyn WrapKeyStore>,
    kind: CustodyKind,
}

impl core::fmt::Debug for WrapKeyCustody {
    /// Names the backend and the namespace and *never* anything under it.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("WrapKeyCustody")
            .field("kind", &self.kind)
            .field(
                "namespace",
                &self.namespace.as_ref().map(WrapKeyNamespace::as_str),
            )
            .finish()
    }
}

impl WrapKeyCustody {
    /// Custody that refuses everything, carrying why.
    ///
    /// This is [`crate::engine::Engine::new`]'s default on purpose: an engine
    /// that was never given a store must refuse to enroll, not enroll into a
    /// state it cannot reopen. A production path that forgets to install
    /// custody therefore fails loudly at the first enrollment rather than
    /// silently sealing under something it will not find again.
    #[must_use]
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            namespace: None,
            store: Arc::new(UnavailableStore {
                reason: reason.into(),
            }),
            kind: CustodyKind::Unavailable,
        }
    }

    /// Process-memory custody. **Durable across nothing.**
    ///
    /// The integration suites and the two-process relay harness need an
    /// enrollment that completes without a keychain on the machine running CI,
    /// and a Linux CI container has no Secret Service. This is that, and it is
    /// named so no shipping caller can reach for it by accident.
    #[doc(hidden)]
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            namespace: None,
            store: Arc::new(InMemoryStore::default()),
            kind: CustodyKind::InMemory,
        }
    }

    /// Custody over an arbitrary backend. The mobile bridge's entry point.
    #[must_use]
    pub fn with_store(namespace: WrapKeyNamespace, store: Arc<dyn WrapKeyStore>) -> Self {
        Self {
            namespace: Some(namespace),
            store,
            kind: CustodyKind::Platform,
        }
    }

    /// The desktop OS secret store for `namespace`.
    ///
    /// macOS keychain, freedesktop Secret Service, or Windows credential
    /// manager. On any other target this is [`Self::unavailable`] — including
    /// iOS and Android, which are reached through the mobile bridge in
    /// [`crate::custody_mobile`] rather than through `keyring`.
    #[must_use]
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "linux", target_os = "windows")),
        allow(unused_variables)
    )]
    pub fn desktop(namespace: WrapKeyNamespace) -> Self {
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        {
            let store = Arc::new(desktop::KeyringStore::new(namespace.as_str().to_owned()));
            Self::with_store(namespace, store)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            Self::unavailable("this target has no desktop secret-store backend")
        }
    }

    #[must_use]
    pub const fn kind(&self) -> CustodyKind {
        self.kind
    }

    #[must_use]
    pub fn namespace(&self) -> Option<&str> {
        self.namespace.as_ref().map(WrapKeyNamespace::as_str)
    }

    /// Store this device's wrap key, replacing any existing one.
    ///
    /// # Errors
    ///
    /// `durability-unavailable` when the store will not hold it. See
    /// [`Self::refusal`] for why that is the code.
    pub fn put_wrap_key(&self, key: &[u8; WRAP_KEY_LEN]) -> Result<()> {
        let encoded = Zeroizing::new(hex::encode(key));
        self.store
            .put(WRAP_KEY_ACCOUNT, &encoded)
            .map_err(|error| Self::refusal("storing the device wrap key", &error))
    }

    /// Read this device's wrap key back.
    ///
    /// # Errors
    ///
    /// `durability-unavailable` when the store will not answer, and when it
    /// holds no key — an absent key and an absent store are both "this device
    /// cannot open its seal", and ADR 0016 §3 makes both `locked`.
    pub fn wrap_key(&self) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>> {
        let encoded = self
            .store
            .get(WRAP_KEY_ACCOUNT)
            .map_err(|error| Self::refusal("reading the device wrap key", &error))?;
        let mut key = Zeroizing::new([0u8; WRAP_KEY_LEN]);
        hex::decode_to_slice(encoded.as_bytes(), key.as_mut_slice())
            .map_err(|_| Self::refusal("reading the device wrap key", &CustodyError::Corrupt))?;
        Ok(key)
    }

    /// Forget this device's wrap key. An already-absent key is success.
    ///
    /// # Errors
    ///
    /// `durability-unavailable` when the store will not answer. Note that a
    /// failure here leaves a key behind for a device that no longer exists,
    /// which is why `unenroll` must treat it as a refusal rather than ignore
    /// it.
    pub fn clear_wrap_key(&self) -> Result<()> {
        match self.store.delete(WRAP_KEY_ACCOUNT) {
            Ok(()) | Err(CustodyError::NotFound) => Ok(()),
            Err(error) => Err(Self::refusal("clearing the device wrap key", &error)),
        }
    }

    /// Prove this device can hold a wrap key, by holding one and reading it
    /// back.
    ///
    /// The enrollment precondition of the module header §3. What it does and
    /// does not prove is stated in §4 — in short, it proves the store answers
    /// now, not that the value survives a reboot.
    ///
    /// The probe value is random rather than fixed so that a backend which
    /// echoes the request, or a stale item left by an earlier probe, cannot be
    /// mistaken for a working round trip.
    ///
    /// # Errors
    ///
    /// `durability-unavailable` if the store refuses the write, refuses the
    /// read, or returns something other than what was written.
    pub fn probe(&self) -> Result<()> {
        let mut expected = Zeroizing::new([0u8; WRAP_KEY_LEN]);
        rand::rng().fill_bytes(expected.as_mut_slice());
        let encoded = Zeroizing::new(hex::encode(expected.as_slice()));

        self.store
            .put(PROBE_ACCOUNT, &encoded)
            .map_err(|error| Self::refusal("proving the device can hold a wrap key", &error))?;

        let read_back = self.store.get(PROBE_ACCOUNT);
        // Delete before judging the read: a probe that refused and left its
        // value behind would leave a random secret in the user's keychain
        // forever, and the delete's own outcome is not what is being measured.
        let _ = self.store.delete(PROBE_ACCOUNT);

        let observed = read_back
            .map_err(|error| Self::refusal("proving the device can hold a wrap key", &error))?;
        if observed.as_str() != encoded.as_str() {
            return Err(Self::refusal(
                "proving the device can hold a wrap key",
                &CustodyError::Corrupt,
            ));
        }
        Ok(())
    }

    /// Every custody refusal, as one §8 code.
    ///
    /// **`durability-unavailable`, and the choice is worth defending** — this
    /// is the same judgement `Error::store_did_not_open` makes about the
    /// message store, applied to the key store.
    ///
    /// `CLIENT-CONTRACT.md` §8 defines it as "storage durability was refused",
    /// non-retryable, and tells the UI there is no degraded mode to enter and
    /// to say what is unavailable. All three fit exactly: this device cannot
    /// durably hold what it must hold before it may enroll, retrying will not
    /// conjure a Secret Service daemon, and the user needs to be told plainly.
    ///
    /// The two codes it was weighed against, so the next reader does not have
    /// to redo it. `internal` — §8 says it "carries no detail by design" and
    /// directs the UI to offer a defect report; a missing OS secret store is
    /// not a defect in this program and the user cannot report it usefully.
    /// `engine-locked` — that is the state of an *enrolled* device whose seal
    /// is shut, and this refusal happens before enrollment, so it would report
    /// a device that does not exist.
    ///
    /// A dedicated `device-custody-unavailable` code would be more precise
    /// still, and is deliberately **not** added here: §8's union is a contract
    /// spanning `models.rs`, `types.ts` and `CLIENT-CONTRACT.md`, and ADR 0016
    /// §10 already requires §6.1's `locked` prose to be rewritten by the change
    /// that removes `IdentityInstall.wrap_key`. Both edits touch the same
    /// paragraphs and belong in one coherent revision of §8 rather than two
    /// that have to be reconciled.
    fn refusal(what: &str, error: &CustodyError) -> Error {
        Error::new(ErrorCode::DurabilityUnavailable, format!("{what}: {error}"))
    }
}

/// The backend where there is none. Every call refuses, carrying the reason the
/// custody was built this way.
struct UnavailableStore {
    reason: String,
}

impl UnavailableStore {
    fn refuse<T>(&self) -> core::result::Result<T, CustodyError> {
        Err(CustodyError::Backend(self.reason.clone()))
    }
}

impl WrapKeyStore for UnavailableStore {
    fn put(&self, _: &str, _: &str) -> core::result::Result<(), CustodyError> {
        self.refuse()
    }
    fn get(&self, _: &str) -> core::result::Result<Zeroizing<String>, CustodyError> {
        self.refuse()
    }
    fn delete(&self, _: &str) -> core::result::Result<(), CustodyError> {
        self.refuse()
    }
}

/// Process memory. See [`WrapKeyCustody::in_memory`].
#[derive(Default)]
struct InMemoryStore {
    items: std::sync::Mutex<std::collections::HashMap<String, Zeroizing<String>>>,
}

impl WrapKeyStore for InMemoryStore {
    fn put(&self, account: &str, value: &str) -> core::result::Result<(), CustodyError> {
        let mut items = self.items.lock().map_err(|_| CustodyError::Unavailable)?;
        items.insert(account.to_owned(), Zeroizing::new(value.to_owned()));
        Ok(())
    }

    fn get(&self, account: &str) -> core::result::Result<Zeroizing<String>, CustodyError> {
        let items = self.items.lock().map_err(|_| CustodyError::Unavailable)?;
        items.get(account).cloned().ok_or(CustodyError::NotFound)
    }

    fn delete(&self, account: &str) -> core::result::Result<(), CustodyError> {
        let mut items = self.items.lock().map_err(|_| CustodyError::Unavailable)?;
        items
            .remove(account)
            .map(|_| ())
            .ok_or(CustodyError::NotFound)
    }
}

/// The desktop OS secret stores, through `keyring`.
///
/// Its per-platform feature matrix is pinned in this crate's `Cargo.toml`
/// rather than inherited from `tauri-plugin-zcash`, because e2e2z must not link
/// that crate — which is the whole of #937. The features are the same ones,
/// and `linux-native-sync-persistent` matters for the same reason it does
/// there: `linux-native` alone is kernel keyutils and does not survive a
/// reboot, which for a wrap key means re-enrollment on every boot.
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
mod desktop {
    use super::{CustodyError, WrapKeyStore};
    use zeroize::Zeroizing;

    pub(super) struct KeyringStore {
        service: String,
    }

    impl KeyringStore {
        pub(super) const fn new(service: String) -> Self {
            Self { service }
        }

        fn entry(&self, account: &str) -> Result<keyring::Entry, CustodyError> {
            keyring::Entry::new(&self.service, account).map_err(map_error)
        }
    }

    impl WrapKeyStore for KeyringStore {
        fn put(&self, account: &str, value: &str) -> Result<(), CustodyError> {
            self.entry(account)?.set_password(value).map_err(map_error)
        }

        fn get(&self, account: &str) -> Result<Zeroizing<String>, CustodyError> {
            self.entry(account)?
                .get_password()
                .map(Zeroizing::new)
                .map_err(map_error)
        }

        fn delete(&self, account: &str) -> Result<(), CustodyError> {
            self.entry(account)?.delete_credential().map_err(map_error)
        }
    }

    /// `keyring`'s errors, classified.
    ///
    /// `NoStorageAccess` is the one that carries #937's Linux case: no D-Bus,
    /// or no Secret Service daemon behind it. It is `Unavailable` and not
    /// `Backend` so the refusal reads as "this machine has no secret store"
    /// rather than as an opaque fault.
    fn map_error(error: keyring::Error) -> CustodyError {
        match error {
            keyring::Error::NoEntry => CustodyError::NotFound,
            keyring::Error::BadEncoding(_) | keyring::Error::TooLong(_, _) => CustodyError::Corrupt,
            keyring::Error::NoStorageAccess(inner) => {
                tracing::debug!(%inner, "no secret-store access");
                CustodyError::Unavailable
            }
            other => CustodyError::Backend(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store that fails every call, standing in for a machine with no
    /// backend. The fail-closed path's fixture.
    struct DeadStore;

    impl WrapKeyStore for DeadStore {
        fn put(&self, _: &str, _: &str) -> core::result::Result<(), CustodyError> {
            Err(CustodyError::Unavailable)
        }
        fn get(&self, _: &str) -> core::result::Result<Zeroizing<String>, CustodyError> {
            Err(CustodyError::Unavailable)
        }
        fn delete(&self, _: &str) -> core::result::Result<(), CustodyError> {
            Err(CustodyError::Unavailable)
        }
    }

    /// A store that accepts writes and loses them — a plausible broken backend,
    /// and the one a "did the write return Ok" check would wave through.
    struct AmnesiacStore;

    impl WrapKeyStore for AmnesiacStore {
        fn put(&self, _: &str, _: &str) -> core::result::Result<(), CustodyError> {
            Ok(())
        }
        fn get(&self, _: &str) -> core::result::Result<Zeroizing<String>, CustodyError> {
            Err(CustodyError::NotFound)
        }
        fn delete(&self, _: &str) -> core::result::Result<(), CustodyError> {
            Ok(())
        }
    }

    /// A store that returns a *different* value than was written. Catches a
    /// backend keyed on something the account name does not distinguish.
    struct WrongValueStore;

    impl WrapKeyStore for WrongValueStore {
        fn put(&self, _: &str, _: &str) -> core::result::Result<(), CustodyError> {
            Ok(())
        }
        fn get(&self, _: &str) -> core::result::Result<Zeroizing<String>, CustodyError> {
            Ok(Zeroizing::new(hex::encode([0x11u8; WRAP_KEY_LEN])))
        }
        fn delete(&self, _: &str) -> core::result::Result<(), CustodyError> {
            Ok(())
        }
    }

    fn namespace() -> WrapKeyNamespace {
        WrapKeyNamespace::new("cash.free2z.e2e2z.f2zmsg.wrap.v1").expect("a valid namespace")
    }

    #[test]
    fn a_namespace_must_belong_to_the_application_that_supplied_it() {
        // The bug this exists to catch: e2e2z shipping ZUULI's constant, which
        // on a shared Secret Service is one wrap key for two apps.
        let stolen =
            WrapKeyNamespace::for_app("cash.free2z.zuuli.f2zmsg.wrap.v1", "cash.free2z.e2e2z");
        assert_eq!(
            stolen,
            Err(NamespaceError::ForeignApplication {
                namespace: "cash.free2z.zuuli.f2zmsg.wrap.v1".to_owned(),
                identifier: "cash.free2z.e2e2z".to_owned(),
            })
        );

        // And each app's own is accepted.
        for (namespace, identifier) in [
            ("cash.free2z.zuuli.f2zmsg.wrap.v1", "cash.free2z.zuuli"),
            ("cash.free2z.e2e2z.f2zmsg.wrap.v1", "cash.free2z.e2e2z"),
        ] {
            assert!(
                WrapKeyNamespace::for_app(namespace, identifier).is_ok(),
                "{namespace} is {identifier}'s own"
            );
        }
    }

    #[test]
    fn a_prefix_that_is_not_a_dotted_component_is_not_this_application() {
        // `cash.free2z.e2e2zEVIL` starts with the identifier as a *string* and
        // is a different application. The trailing dot is what makes the check
        // a component boundary rather than a substring match.
        assert!(matches!(
            WrapKeyNamespace::for_app("cash.free2z.e2e2z-evil.wrap.v1", "cash.free2z.e2e2z"),
            Err(NamespaceError::ForeignApplication { .. })
        ));
    }

    #[test]
    fn malformed_namespaces_are_refused() {
        for candidate in [
            "",
            "nodots",
            "one.dot",
            ".leading.dot.v1",
            "trailing.dot.v1.",
            "double..dot.v1",
            "Upper.Case.v1",
            "has space.in.it",
        ] {
            assert!(
                matches!(
                    WrapKeyNamespace::new(candidate),
                    Err(NamespaceError::Malformed(_))
                ),
                "{candidate:?} should be refused"
            );
        }
    }

    #[test]
    fn a_round_trip_stores_reads_and_clears() {
        let custody = WrapKeyCustody::in_memory();
        let key = [0x5au8; WRAP_KEY_LEN];

        custody.put_wrap_key(&key).expect("store");
        assert_eq!(*custody.wrap_key().expect("read"), key);

        custody.clear_wrap_key().expect("clear");
        assert!(custody.wrap_key().is_err(), "a cleared key must not read");

        // Clearing twice is success: an absent key is the state `clear` wants.
        custody.clear_wrap_key().expect("clearing an absent key");
    }

    #[test]
    fn the_probe_leaves_an_enrolled_devices_key_alone() {
        // The probe writes to its own account. If it shared one with the real
        // key, re-attempting enrollment would destroy the seal of a device that
        // was already working.
        let custody = WrapKeyCustody::in_memory();
        let key = [0xa5u8; WRAP_KEY_LEN];
        custody.put_wrap_key(&key).expect("store");

        custody.probe().expect("probe");

        assert_eq!(*custody.wrap_key().expect("read"), key);
    }

    #[test]
    fn the_probe_refuses_every_shape_of_broken_store() {
        for (name, store) in [
            ("no backend", Arc::new(DeadStore) as Arc<dyn WrapKeyStore>),
            ("accepts and forgets", Arc::new(AmnesiacStore)),
            ("returns something else", Arc::new(WrongValueStore)),
        ] {
            let custody = WrapKeyCustody::with_store(namespace(), store);
            let error = custody.probe().expect_err(name);
            assert_eq!(
                error.code(),
                ErrorCode::DurabilityUnavailable,
                "{name} must refuse as durability-unavailable, not {:?}",
                error.code()
            );
        }
    }

    #[test]
    fn the_default_custody_refuses() {
        // `Engine::new`'s default. An engine nobody gave a store to must not be
        // able to enroll (ADR 0016 §3.5).
        let custody = WrapKeyCustody::unavailable("no custody was installed");
        assert_eq!(custody.kind(), CustodyKind::Unavailable);
        assert!(custody.probe().is_err());
        assert!(custody.put_wrap_key(&[0u8; WRAP_KEY_LEN]).is_err());
        assert!(custody.wrap_key().is_err());
    }

    #[test]
    fn a_stored_value_that_is_not_a_wrap_key_is_refused() {
        // A backend holding a truncated or non-hex item must read as a refusal
        // and never as 32 bytes of something else.
        let custody = WrapKeyCustody::in_memory();
        for bad in ["", "zz", &hex::encode([0u8; 16])] {
            custody
                .store
                .put(WRAP_KEY_ACCOUNT, bad)
                .expect("the in-memory store accepts anything");
            let error = custody.wrap_key().expect_err("must refuse");
            assert_eq!(error.code(), ErrorCode::DurabilityUnavailable);
        }
    }

    /// The **real** OS secret store on this machine, not a fake.
    ///
    /// `#[ignore]` because it needs a logged-in desktop session with an
    /// unlocked keychain: a Linux CI container has no Secret Service daemon and
    /// would fail here for a reason that has nothing to do with this code —
    /// which is, pointedly, the very condition [`WrapKeyCustody::probe`]
    /// exists to detect. Run it by hand on a desktop with:
    ///
    /// ```console
    /// cargo +1.97.1 test --locked platform_custody -- --ignored --nocapture
    /// ```
    ///
    /// It writes and deletes items under a `.test.v1` namespace, never the
    /// namespace either shipping app uses.
    #[test]
    #[ignore = "needs a real desktop keychain session; see the doc comment"]
    fn platform_custody_round_trips_against_the_real_store() {
        let custody = WrapKeyCustody::desktop(
            WrapKeyNamespace::new("cash.free2z.f2zmsg.test.v1").expect("namespace"),
        );
        assert_eq!(custody.kind(), CustodyKind::Platform);

        custody.probe().expect("the real store must hold a probe");

        let key = [0x3cu8; WRAP_KEY_LEN];
        custody.put_wrap_key(&key).expect("store");
        assert_eq!(*custody.wrap_key().expect("read"), key);
        custody.clear_wrap_key().expect("clear");
        assert!(
            custody.wrap_key().is_err(),
            "a cleared key must not read back"
        );
    }

    #[test]
    fn debug_never_prints_a_key() {
        let custody = WrapKeyCustody::with_store(namespace(), Arc::new(InMemoryStore::default()));
        custody
            .put_wrap_key(&[0x7eu8; WRAP_KEY_LEN])
            .expect("store");
        let rendered = format!("{custody:?}");
        assert!(rendered.contains("cash.free2z.e2e2z.f2zmsg.wrap.v1"));
        assert!(
            !rendered.contains(&hex::encode([0x7eu8; WRAP_KEY_LEN])),
            "custody Debug leaked the wrap key: {rendered}"
        );
    }
}
