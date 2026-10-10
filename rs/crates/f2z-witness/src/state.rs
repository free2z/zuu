//! Durable state — one file, one atomic replacement.
//!
//! # Why this is the load-bearing part of a witness
//!
//! `KT.md` §7.1 step 5 puts *persist* before *emit*, and says why:
//!
//! > A witness that emits first and crashes before persisting comes back
//! > believing it is still at the old epoch. It will then happily cosign
//! > whatever it is served for that epoch next — and if the log serves it a
//! > *different* root, the witness has now signed two contradictory statements
//! > for one epoch. That is exactly the non-repudiable evidence §7.2 is
//! > designed to produce, and the witness manufactured it against itself for a
//! > fault that was its own crash.
//!
//! A witness that forgets its last signed root will also happily cosign an
//! **older** one, which is the rollback attack it exists to prevent. So this
//! file is not a cache and losing it is not a fresh start: [`load`] on a
//! missing file returns `None`, and the daemon then refuses to run unless it
//! was explicitly told to pin a log for the first time.
//!
//! # The write
//!
//! Write a temporary file in the **same directory**, `fsync` it, `rename` it
//! over the target, then `fsync` the **directory**. All four steps matter: a
//! rename across filesystems is not atomic, an unsynced temporary can be a
//! whole file of zeroes after a power cut, and an unsynced directory can lose
//! the rename itself while keeping both files.
//!
//! # It is `tls_codec`, not a text format
//!
//! Same codec as everything else, so the state a witness holds is the same
//! shape as the bytes it verified — no second parser, no field that means
//! something slightly different once it has been through a serializer.

use std::path::{Path, PathBuf};

use f2z_codec::Canonical as _;
use f2z_codec::decode_canonical;
use f2z_codec::types::{Digest, PublicKey, ShortBytes};
use f2z_codec::vec::VecU24;
use f2z_kt_core::WitnessCosignature;
use f2z_kt_core::sth::{LogView, SignedTreeHead};
use f2z_kt_core::types::{LogId, check_label, label_field};
use f2z_kt_core::{FaultKind, KT_VERSION};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::{Result, WitnessError};

/// The legacy state tag, retained only for positively identified migration.
const LABEL_STATE: &[u8] = b"free2z/kt/v1/witness-state";
/// The current private state tag. Distinct from the legacy tag so truncation
/// can never make a current file eligible for the legacy decoder.
const LABEL_STATE_V2: &[u8] = b"free2z/kt/v1/witness-state/v2";
const STATE_FORMAT_VERSION: u16 = 2;

/// `KT.md` §7.5's durable state, plus the halt flag §7.1 requires to survive a
/// restart.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct WitnessState {
    /// Exactly [`LABEL_STATE_V2`].
    pub label: ShortBytes,
    /// Private state-file layout version.
    pub format_version: u16,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log being followed.
    pub log_id: LogId,
    /// The log signing key currently accepted for it (`KT.md` §6.4).
    pub accepted_log_pk: PublicKey,
    /// The last accepted tree head, whole.
    ///
    /// **Stored rather than reconstructed, because [`LogView`] has no public
    /// constructor** — the only way to obtain one is from a head whose
    /// signature verified. That is a deliberate choke point in `f2z-kt-core`
    /// and asserting the fields back into place on restart would be walking
    /// around it. Two hundred bytes is well inside §7.5's "a few hundred bytes
    /// in a file", and the derived fields below are kept beside it so that a
    /// file which disagrees with itself is caught rather than trusted.
    pub head: SignedTreeHead,
    /// The last accepted epoch.
    pub epoch: u64,
    /// Its `tree_size`.
    pub tree_size: u64,
    /// Its `root_hash`.
    pub root_hash: Digest,
    /// `H("free2z/kt/v1/tree-head-hash", tls_codec(that sth))`.
    pub sth_hash: Digest,
    /// The VRF key it carried. §6.1: a change within a `log_id` is a fork, not
    /// an update, so the last value seen has to be remembered to see a change
    /// at all.
    pub vrf_public_key: PublicKey,
    /// `published_at_ms` of the last accepted head, for §6.3 rule 5.
    pub published_at_ms: u64,
    /// The fault this witness halted on, as [`FaultKind::code`], or 0 if it is
    /// running.
    ///
    /// **Durable on purpose.** A halt that a restart clears is not a halt: the
    /// operator would find a witness that had quietly resumed cosigning a log
    /// it had already caught equivocating.
    pub halted: u8,
    /// Whether this state records delivery state: 0 only for migrated legacy
    /// files, 1 once delivery tracking is active.
    pub delivery_known: u8,
    /// The deterministic cosignature that still needs delivery, if any.
    /// This is staged in the same durable write as the verified head.
    pub pending_cosignatures: VecU24<WitnessCosignature>,
    /// When this file was last written.
    pub updated_at_ms: u64,
}

impl WitnessState {
    /// Build the first state from a tree head this witness has verified.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if the label will not encode.
    pub fn pin(view: &LogView, head: &SignedTreeHead, now_ms: u64) -> Result<Self> {
        let published_at_ms = head.sth.published_at_ms;
        Ok(Self {
            label: label_field(LABEL_STATE_V2).map_err(|e| WitnessError::Local(e.to_string()))?,
            format_version: STATE_FORMAT_VERSION,
            kt_version: KT_VERSION,
            log_id: *view.log_id(),
            accepted_log_pk: *view.accepted_log_pk(),
            head: head.clone(),
            epoch: view.epoch(),
            tree_size: view.tree_size(),
            root_hash: *view.root_hash(),
            sth_hash: *view.sth_hash(),
            vrf_public_key: *view.vrf_public_key(),
            published_at_ms,
            halted: 0,
            delivery_known: 1,
            pending_cosignatures: VecU24::new(Vec::new()),
            updated_at_ms: now_ms,
        })
    }

    /// Refresh from an advanced view.
    pub fn advance_to(&mut self, view: &LogView, head: &SignedTreeHead, now_ms: u64) {
        let published_at_ms = head.sth.published_at_ms;
        self.head = head.clone();
        self.accepted_log_pk = *view.accepted_log_pk();
        self.epoch = view.epoch();
        self.tree_size = view.tree_size();
        self.root_hash = *view.root_hash();
        self.sth_hash = *view.sth_hash();
        self.vrf_public_key = *view.vrf_public_key();
        self.published_at_ms = published_at_ms;
        self.updated_at_ms = now_ms;
    }

    /// The fault this witness halted on, if any.
    #[must_use]
    pub fn halt_kind(&self) -> Option<FaultKind> {
        if self.halted == 0 {
            return None;
        }
        FaultKind::from_code(self.halted).ok()
    }

    /// Record a halt.
    pub fn halt(&mut self, kind: FaultKind, now_ms: u64) {
        if self.halted == 0 {
            self.halted = kind.code();
        }
        self.updated_at_ms = now_ms;
    }

    /// Rebuild the `f2z-kt-core` view this state describes.
    ///
    /// **There is no public constructor for a [`LogView`], and that is the
    /// point** — one is only obtainable from a tree head whose signature
    /// verified. So a restart re-derives the view the way it was first
    /// obtained: by verifying a head against the stored key and the stored
    /// chain position, rather than by asserting the fields back into place.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Fault`] if the stored head does not verify under the
    /// stored key, or if the file's derived fields disagree with it — a state
    /// file that contradicts itself has been edited, and continuing from it
    /// would mean cosigning from a position nobody verified.
    pub fn restore(&self) -> Result<LogView> {
        let head = &self.head;
        let view = LogView::pin(self.log_id, self.accepted_log_pk, head)
            .map_err(|error| WitnessError::Fault(FaultKind::BadSignature, error))?;
        if view.epoch() != self.epoch
            || view.root_hash() != &self.root_hash
            || view.tree_size() != self.tree_size
            || view.sth_hash() != &self.sth_hash
        {
            return Err(WitnessError::Fault(
                FaultKind::Fork,
                f2z_kt_core::KtError::Fork,
            ));
        }
        if view.vrf_public_key() != &self.vrf_public_key {
            return Err(WitnessError::Fault(
                FaultKind::VrfKeyChange,
                f2z_kt_core::KtError::VrfKeyChange,
            ));
        }
        Ok(view)
    }

    /// Check the constants after decoding.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if the file is not a witness state file for this
    /// protocol version.
    pub fn validate(&self) -> Result<()> {
        check_label(&self.label, LABEL_STATE_V2)
            .map_err(|_| WitnessError::Local("state file: wrong label".to_owned()))?;
        if self.format_version != STATE_FORMAT_VERSION {
            return Err(WitnessError::Local(
                "state file: unsupported format_version".to_owned(),
            ));
        }
        if self.kt_version != KT_VERSION {
            return Err(WitnessError::Local(
                "state file: unsupported kt_version".to_owned(),
            ));
        }
        let mut last_pending_epoch = None;
        for pending in self.pending_cosignatures.as_slice() {
            if pending.statement.log_id != self.log_id
                || pending.statement.epoch > self.epoch
                || (pending.statement.epoch == self.epoch && !pending.covers(&self.head))
                || pending.verify().is_err()
                || last_pending_epoch.is_some_and(|epoch| pending.statement.epoch <= epoch)
            {
                return Err(WitnessError::Local(
                    "state file: pending cosignature does not verify for the held log position"
                        .to_owned(),
                ));
            }
            last_pending_epoch = Some(pending.statement.epoch);
        }
        if self.delivery_known > 1 {
            return Err(WitnessError::Local(
                "state file: unsupported delivery marker".to_owned(),
            ));
        }
        if self.delivery_known == 0 && !self.pending_cosignatures.is_empty() {
            return Err(WitnessError::Local(
                "state file: legacy delivery marker conflicts with pending cosignature".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Read the state file, or `None` if it does not exist.
///
/// # Errors
///
/// [`WitnessError::Local`] if the file exists and cannot be read or decoded. A
/// corrupt state file is **not** treated as an absent one: starting fresh from
/// a corrupt file is how a witness resumes at epoch zero and cosigns a
/// rollback.
pub fn load(path: &Path) -> Result<Option<WitnessState>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(WitnessError::Local(format!("{}: {error}", path.display())));
        }
    };
    let state = if starts_with_encoded_label(&bytes, LABEL_STATE_V2) {
        decode_canonical::<WitnessState>(&bytes)
            .map_err(|error| {
                WitnessError::Local(format!("{}: undecodable state: {error}", path.display()))
            })?
            .into_value()
    } else if starts_with_encoded_label(&bytes, LABEL_STATE) {
        decode_canonical::<LegacyWitnessState>(&bytes)
            .map_err(|error| {
                WitnessError::Local(format!(
                    "{}: undecodable legacy state: {error}",
                    path.display()
                ))
            })?
            .into_value()
            .into_current()?
    } else {
        return Err(WitnessError::Local(format!(
            "{}: unrecognized state format",
            path.display()
        )));
    };
    state.validate()?;
    Ok(Some(state))
}

/// Identify a TLS `opaque<0..255>` label before selecting a decoder. This is
/// intentionally checked before decoding so a truncated v2 file cannot fall
/// through to the shorter legacy layout.
fn starts_with_encoded_label(bytes: &[u8], label: &[u8]) -> bool {
    let Some((length, rest)) = bytes.split_first() else {
        return false;
    };
    usize::from(*length) == label.len() && rest.starts_with(label)
}

/// The state-file shape used before delivery tracking. Decode it only as a
/// compatibility migration; the first poll reconstructs and durably stages
/// its deterministic cosignature after re-verifying the held head.
#[derive(Clone, Debug, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
struct LegacyWitnessState {
    label: ShortBytes,
    kt_version: u16,
    log_id: LogId,
    accepted_log_pk: PublicKey,
    head: SignedTreeHead,
    epoch: u64,
    tree_size: u64,
    root_hash: Digest,
    sth_hash: Digest,
    vrf_public_key: PublicKey,
    published_at_ms: u64,
    halted: u8,
    updated_at_ms: u64,
}

impl LegacyWitnessState {
    fn into_current(self) -> Result<WitnessState> {
        Ok(WitnessState {
            label: label_field(LABEL_STATE_V2)
                .map_err(|error| WitnessError::Local(error.to_string()))?,
            format_version: STATE_FORMAT_VERSION,
            kt_version: self.kt_version,
            log_id: self.log_id,
            accepted_log_pk: self.accepted_log_pk,
            head: self.head,
            epoch: self.epoch,
            tree_size: self.tree_size,
            root_hash: self.root_hash,
            sth_hash: self.sth_hash,
            vrf_public_key: self.vrf_public_key,
            published_at_ms: self.published_at_ms,
            halted: self.halted,
            delivery_known: 0,
            pending_cosignatures: VecU24::new(Vec::new()),
            updated_at_ms: self.updated_at_ms,
        })
    }
}

/// Replace the state file atomically: temp, `fsync`, `rename`, `fsync` the
/// directory.
///
/// # Errors
///
/// [`WitnessError::Local`] on any step. **Every step is checked**, because a
/// silently ignored `fsync` failure is exactly the case this function exists
/// for.
pub fn store(path: &Path, state: &WitnessState) -> Result<()> {
    use std::io::Write as _;

    let bytes = state
        .encode_canonical()
        .map_err(|error| WitnessError::Local(format!("state will not encode: {error}")))?;

    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)
        .map_err(|error| WitnessError::Local(format!("{}: {error}", directory.display())))?;

    // In the same directory, so the rename is within one filesystem and is
    // therefore atomic. `/tmp` would not be.
    let temporary: PathBuf = path.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut file = std::fs::File::create(&temporary)
            .map_err(|error| WitnessError::Local(format!("{}: {error}", temporary.display())))?;
        file.write_all(&bytes)
            .map_err(|error| WitnessError::Local(format!("{}: {error}", temporary.display())))?;
        file.sync_all()
            .map_err(|error| WitnessError::Local(format!("{}: {error}", temporary.display())))?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| WitnessError::Local(format!("{}: {error}", path.display())))?;

    // The rename itself is metadata on the directory. Without this the file can
    // survive a power cut while the directory entry pointing at it does not.
    let handle = std::fs::File::open(directory)
        .map_err(|error| WitnessError::Local(format!("{}: {error}", directory.display())))?;
    handle
        .sync_all()
        .map_err(|error| WitnessError::Local(format!("{}: {error}", directory.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use f2z_codec::Canonical as _;
    use f2z_codec::types::{Digest, PublicKey, ShortBytes};
    use f2z_kt_core::FaultKind;
    use f2z_kt_core::types::{LogId, label_field};

    use super::{
        LABEL_STATE, LABEL_STATE_V2, LegacyWitnessState, STATE_FORMAT_VERSION, VecU24,
        WitnessCosignature, WitnessState, load, store,
    };

    fn head() -> f2z_kt_core::sth::SignedTreeHead {
        f2z_kt_core::sth::SignedTreeHead {
            sth: f2z_kt_core::sth::SignedTreeHeadTBS {
                label: label_field(f2z_kt_core::labels::LABEL_STH).unwrap(),
                kt_version: f2z_kt_core::KT_VERSION,
                log_id: LogId::new([1u8; 32]),
                epoch: 7,
                tree_size: 40,
                root_hash: Digest::new([3u8; 32]),
                prev_sth_hash: Digest::new([9u8; 32]),
                vrf_public_key: PublicKey::new([5u8; 32]),
                published_at_ms: 1_700,
                reset_count: 0,
                epoch_interval_seconds: 600,
                max_merge_delay_seconds: 3_600,
                successor_log_pk: PublicKey::zero(),
            },
            signature: f2z_codec::types::Signature::zero(),
        }
    }

    fn state() -> WitnessState {
        WitnessState {
            label: label_field(LABEL_STATE_V2).unwrap(),
            format_version: STATE_FORMAT_VERSION,
            kt_version: f2z_kt_core::KT_VERSION,
            log_id: LogId::new([1u8; 32]),
            accepted_log_pk: PublicKey::new([2u8; 32]),
            head: head(),
            epoch: 7,
            tree_size: 40,
            root_hash: Digest::new([3u8; 32]),
            sth_hash: Digest::new([4u8; 32]),
            vrf_public_key: PublicKey::new([5u8; 32]),
            published_at_ms: 1_700,
            halted: 0,
            delivery_known: 1,
            pending_cosignatures: VecU24::new(Vec::new()),
            updated_at_ms: 1_800,
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("f2z-witness-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn state_round_trips_through_the_file() {
        let path = temp("state-roundtrip").join("state.bin");
        assert!(load(&path).unwrap().is_none(), "no file is not an error");
        let original = state();
        store(&path, &original).unwrap();
        assert_eq!(load(&path).unwrap().as_ref(), Some(&original));
    }

    #[test]
    fn a_halt_survives_a_restart() {
        // The whole point: an operator must not find a witness that quietly
        // resumed cosigning a log it had already caught equivocating.
        let path = temp("state-halt").join("state.bin");
        let mut original = state();
        original.halt(FaultKind::Fork, 2_000);
        store(&path, &original).unwrap();

        let reloaded = load(&path).unwrap().unwrap();
        assert_eq!(reloaded.halt_kind(), Some(FaultKind::Fork));
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_rather_than_a_fresh_start() {
        // Starting fresh from a corrupt file is how a witness resumes at epoch
        // zero and cosigns a rollback.
        let path = temp("state-corrupt").join("state.bin");
        std::fs::write(&path, b"not a witness state").unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn a_legacy_state_file_is_loaded_with_delivery_recovery_required() {
        let path = temp("state-legacy").join("state.bin");
        let current = state();
        let legacy = LegacyWitnessState {
            label: label_field(LABEL_STATE).unwrap(),
            kt_version: current.kt_version,
            log_id: current.log_id,
            accepted_log_pk: current.accepted_log_pk,
            head: current.head,
            epoch: current.epoch,
            tree_size: current.tree_size,
            root_hash: current.root_hash,
            sth_hash: current.sth_hash,
            vrf_public_key: current.vrf_public_key,
            published_at_ms: current.published_at_ms,
            halted: current.halted,
            updated_at_ms: current.updated_at_ms,
        };
        let bytes = legacy.encode_canonical().unwrap();
        std::fs::write(&path, bytes).unwrap();

        let migrated = load(&path).unwrap().unwrap();
        assert_eq!(migrated.delivery_known, 0);
        assert!(migrated.pending_cosignatures.is_empty());
        assert_eq!(migrated.epoch, 7);
    }

    #[test]
    fn truncated_current_state_never_falls_back_to_legacy_layout() {
        for (name, halted) in [("active", false), ("halted", true)] {
            let path = temp(&format!("state-v2-truncated-{name}")).join("state.bin");
            let mut current = state();
            if halted {
                current.halt(FaultKind::Fork, 2_000);
            }
            let mut bytes = current.encode_canonical().unwrap();
            let truncated_len = bytes.len().saturating_sub(4);
            bytes.truncate(truncated_len);
            std::fs::write(&path, bytes).unwrap();

            assert!(load(&path).is_err(), "{name} v2 state must fail closed");
        }
    }

    #[test]
    fn a_state_file_with_an_invalid_pending_cosignature_is_refused() {
        let path = temp("state-pending-invalid").join("state.bin");
        let mut stored = state();
        let held = stored.head.clone();
        stored.pending_cosignatures = VecU24::new(vec![WitnessCosignature {
            statement: f2z_kt_core::WitnessCosignatureTBS {
                label: label_field(f2z_kt_core::labels::LABEL_COSIG).unwrap(),
                kt_version: f2z_kt_core::KT_VERSION,
                log_id: held.sth.log_id,
                epoch: held.sth.epoch,
                tree_size: held.sth.tree_size,
                root_hash: held.sth.root_hash,
                witness_pk: PublicKey::new([6u8; 32]),
                observed_at_ms: 1_800,
            },
            signature: f2z_codec::types::Signature::zero(),
        }]);
        let bytes = stored.encode_canonical().unwrap();
        std::fs::write(&path, bytes).unwrap();

        assert!(load(&path).is_err());
    }

    #[test]
    fn a_file_with_the_wrong_label_is_refused() {
        let path = temp("state-label").join("state.bin");
        let mut wrong = state();
        wrong.label = ShortBytes::new(b"free2z/kt/v1/sth".to_vec()).unwrap();
        // Written by hand, because `store` would happily write it: the check is
        // on the way in, where a file swapped underneath the daemon arrives.
        let bytes = {
            use f2z_codec::Canonical as _;
            wrong.encode_canonical().unwrap()
        };
        std::fs::write(&path, bytes).unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let dir = temp("state-temp");
        let path = dir.join("state.bin");
        store(&path, &state()).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "state.bin")
            .collect();
        assert!(leftovers.is_empty(), "left behind {leftovers:?}");
    }
}
