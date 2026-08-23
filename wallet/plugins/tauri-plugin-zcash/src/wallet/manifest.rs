use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletEntry {
    pub id: String,
    pub name: String,
    pub db_filename: String,
    pub birthday_height: Option<u64>,
    pub created_at: String,
    /// A freshly generated identity cannot sign a login challenge until the
    /// user has explicitly completed the recovery-phrase backup ceremony.
    /// Legacy manifests and restored wallets predate/do not need this gate.
    #[serde(default)]
    pub backup_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletManifest {
    pub wallets: Vec<WalletEntry>,
    pub active_wallet_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeleteWalletError {
    LastWallet,
    NotFound,
    Persistence(String),
}

impl WalletManifest {
    fn manifest_path(data_dir: &Path) -> PathBuf {
        data_dir.join("wallets.json")
    }

    /// Load the manifest from disk, or create an empty one if none exists.
    ///
    /// A present but unreadable or invalid manifest is never treated as an
    /// empty wallet set. Doing so could make startup adopt a legacy database
    /// into a new manifest and silently discard the user's real wallet list.
    pub fn load(data_dir: &Path) -> std::io::Result<Self> {
        let path = Self::manifest_path(data_dir);
        #[cfg(windows)]
        recover_manifest_backup(&path, &manifest_backup_path(data_dir))?;
        match std::fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
            {
                let contents = std::fs::read_to_string(&path)?;
                let manifest: Self = serde_json::from_str(&contents)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
                manifest.validate()?;
                return Ok(manifest);
            }
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "wallets.json is not a regular file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Self {
            wallets: Vec::new(),
            active_wallet_id: None,
        })
    }

    pub(crate) fn validate(&self) -> std::io::Result<()> {
        let invalid =
            |message: String| std::io::Error::new(std::io::ErrorKind::InvalidData, message);
        let mut ids = std::collections::HashSet::new();
        let mut filenames = std::collections::HashSet::new();
        for wallet in &self.wallets {
            if wallet.id.is_empty() || !ids.insert(wallet.id.as_str()) {
                return Err(invalid(
                    "wallet manifest contains an empty or duplicate wallet ID".into(),
                ));
            }
            let path = Path::new(&wallet.db_filename);
            let single_normal_component = matches!(
                path.components().collect::<Vec<_>>().as_slice(),
                [std::path::Component::Normal(_)]
            );
            let expected_shape = wallet.db_filename == "wallet.sqlite"
                || (wallet.db_filename.starts_with("wallet_")
                    && wallet.db_filename.ends_with(".sqlite"));
            if !single_normal_component
                || !expected_shape
                || !filenames.insert(wallet.db_filename.as_str())
            {
                return Err(invalid(
                    "wallet manifest contains an unsafe or duplicate database filename".into(),
                ));
            }
        }
        match self.active_wallet_id.as_deref() {
            Some(active) if ids.contains(active) => Ok(()),
            None if self.wallets.is_empty() => Ok(()),
            _ => Err(invalid(
                "wallet manifest active identity is inconsistent with its wallet list".into(),
            )),
        }
    }

    /// Save manifest to disk.
    pub fn save(&self, data_dir: &Path) {
        if let Err(e) = self.save_atomic(data_dir) {
            tracing::error!("failed to save wallets.json atomically: {e}");
        }
    }

    /// Adopt a legacy `wallet.sqlite` into the manifest without renaming it.
    ///
    /// SQLite's `-wal` and `-shm` files are part of the live database state.
    /// Keeping the basename stable preserves the triplet atomically; only the
    /// new manifest needs to be committed. Persistence failure rolls back the
    /// in-memory mutation and leaves every legacy file untouched.
    pub fn migrate_legacy(&mut self, data_dir: &Path) -> std::io::Result<bool> {
        if !self.wallets.is_empty() {
            return Ok(false); // Already have wallets, no migration needed
        }

        let legacy_path = data_dir.join("wallet.sqlite");
        match std::fs::symlink_metadata(&legacy_path) {
            Ok(metadata)
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "legacy wallet.sqlite is not a regular file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
        for suffix in ["-wal", "-shm"] {
            let sidecar = data_dir.join(format!("wallet.sqlite{suffix}"));
            match std::fs::symlink_metadata(&sidecar) {
                Ok(metadata)
                    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("legacy SQLite sidecar {suffix} is not a regular file"),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }

        let previous_active = self.active_wallet_id.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let entry = WalletEntry {
            id: id.clone(),
            name: "Default".to_string(),
            db_filename: "wallet.sqlite".to_string(),
            birthday_height: None,
            created_at: chrono_now(),
            backup_required: false,
        };

        self.wallets.push(entry);
        self.active_wallet_id = Some(id);
        match self.save_atomic(data_dir) {
            Ok(_) => {
                tracing::info!("adopted legacy wallet.sqlite into the wallet manifest");
                Ok(true)
            }
            Err(error) => {
                self.wallets.clear();
                self.active_wallet_id = previous_active;
                Err(error)
            }
        }
    }

    /// Get the active wallet entry.
    pub fn get_active(&self) -> Option<&WalletEntry> {
        self.active_wallet_id
            .as_ref()
            .and_then(|id| self.wallets.iter().find(|w| &w.id == id))
    }

    pub(crate) fn active_backup_required(&self) -> bool {
        self.get_active()
            .is_some_and(|wallet| wallet.backup_required)
    }

    pub(crate) fn is_exact_active_backup_pending(&self, wallet_id: &str) -> bool {
        self.active_wallet_id.as_deref() == Some(wallet_id)
            && self
                .get_active()
                .is_some_and(|wallet| wallet.backup_required)
    }

    /// Allocate a wallet identity without making it visible or durable.
    ///
    /// Callers initialize the database and commit native seed custody before
    /// passing the entry to `commit_wallet`. This prevents a failed secure-store
    /// operation from leaving an active manifest entry with no spending key.
    pub fn prepare_wallet(name: String, birthday_height: Option<u64>) -> WalletEntry {
        let id = uuid::Uuid::new_v4().to_string();
        let db_filename = format!("wallet_{id}.sqlite");

        WalletEntry {
            id: id.clone(),
            name,
            db_filename,
            birthday_height,
            created_at: chrono_now(),
            backup_required: false,
        }
    }

    /// Mark a newly generated wallet's recovery phrase as requiring backup
    /// before the entry is ever published in the durable manifest.
    pub(crate) fn require_backup(entry: &mut WalletEntry) {
        entry.backup_required = true;
    }

    /// Atomically clear the backup gate for the exact active wallet.
    ///
    /// The wallet ID binding prevents a stale seed screen from acknowledging a
    /// different identity after a switch. Persistence failure restores memory
    /// so runtime and restart state cannot disagree.
    pub(crate) fn confirm_backup(
        &mut self,
        data_dir: &Path,
        wallet_id: &str,
    ) -> std::io::Result<bool> {
        if self.active_wallet_id.as_deref() != Some(wallet_id) {
            return Ok(false);
        }
        let Some(wallet) = self
            .wallets
            .iter_mut()
            .find(|wallet| wallet.id == wallet_id)
        else {
            return Ok(false);
        };
        if !wallet.backup_required {
            return Ok(true);
        }
        wallet.backup_required = false;
        if let Err(error) = self.save_atomic(data_dir) {
            self.wallets
                .iter_mut()
                .find(|wallet| wallet.id == wallet_id)
                .expect("active wallet remains present")
                .backup_required = true;
            return Err(error);
        }
        Ok(true)
    }

    /// Durably add a fully initialized wallet and set it active.
    ///
    /// An error rolls the in-memory mutation back. `false` means the manifest
    /// replacement is visible but directory durability could not be confirmed;
    /// the wallet remains committed so its database and native seed stay
    /// reachable on restart.
    pub(crate) fn commit_wallet(
        &mut self,
        data_dir: &Path,
        entry: WalletEntry,
    ) -> std::io::Result<bool> {
        let previous_active = self.active_wallet_id.clone();
        let id = entry.id.clone();
        self.wallets.push(entry);
        self.active_wallet_id = Some(id);
        match self.save_atomic(data_dir) {
            Ok(durable) => Ok(durable),
            Err(error) => {
                self.wallets.pop();
                self.active_wallet_id = previous_active;
                Err(error)
            }
        }
    }

    /// Durably set the active wallet by ID.
    ///
    /// Persistence failure restores the previous in-memory selection so the
    /// manifest can never advertise a context that was not committed on disk.
    pub fn set_active(&mut self, data_dir: &Path, wallet_id: &str) -> std::io::Result<bool> {
        if !self.wallets.iter().any(|w| w.id == wallet_id) {
            return Ok(false);
        }

        let previous_active = self.active_wallet_id.clone();
        self.active_wallet_id = Some(wallet_id.to_string());
        match self.save_atomic(data_dir) {
            Ok(_) => Ok(true),
            Err(error) => {
                self.active_wallet_id = previous_active;
                Err(error)
            }
        }
    }

    /// Rename a wallet.
    pub fn rename_wallet(&mut self, data_dir: &Path, wallet_id: &str, new_name: String) -> bool {
        if let Some(w) = self.wallets.iter_mut().find(|w| w.id == wallet_id) {
            w.name = new_name;
            self.save(data_dir);
            true
        } else {
            false
        }
    }

    /// Durably remove a wallet from the manifest and return cleanup authority.
    ///
    /// If manifest persistence fails, the in-memory mutation is rolled back and
    /// the DB remains in place. External state such as a keychain seed must not
    /// be deleted unless the returned cleanup authorization is true.
    pub(crate) fn delete_wallet_durable(
        &mut self,
        data_dir: &Path,
        wallet_id: &str,
    ) -> Result<(), DeleteWalletError> {
        let pos = self.validate_wallet_deletion(wallet_id)?;
        let previous_active = self.active_wallet_id.clone();
        let cleanup = super::cleanup::schedule_wallet_deletion(data_dir, &self.wallets[pos])
            .map_err(|error| DeleteWalletError::Persistence(error.to_string()))?;
        let entry = self.wallets.remove(pos);

        // If we deleted the active wallet, switch to the first remaining
        if self.active_wallet_id.as_deref() == Some(wallet_id) {
            self.active_wallet_id = self.wallets.first().map(|w| w.id.clone());
        }

        let cleanup_authorized = match self.save_atomic(data_dir) {
            Ok(cleanup_authorized) => cleanup_authorized,
            Err(e) => {
                self.wallets.insert(pos, entry);
                self.active_wallet_id = previous_active;
                if let Err(cleanup_error) = super::cleanup::cancel(data_dir, &cleanup) {
                    tracing::warn!(
                        "manifest deletion rolled back but cleanup tombstone cancellation failed: {cleanup_error}"
                    );
                }
                return Err(DeleteWalletError::Persistence(e.to_string()));
            }
        };

        if cleanup_authorized {
            if let Err(error) = super::cleanup::authorize_wallet_deletion(data_dir, &cleanup) {
                tracing::warn!(
                    "wallet deletion committed but cleanup authorization finalization failed; startup will retry: {error}"
                );
            }
        } else {
            tracing::warn!(
                "wallet manifest replacement was visible but not confirmed durable; cleanup awaits restart resolution"
            );
        }

        Ok(())
    }

    /// Validate deletion without changing the manifest or filesystem.
    ///
    /// Callers that also delete external state, such as a keychain seed, must
    /// call this before performing any irreversible cleanup.
    pub(crate) fn validate_wallet_deletion(
        &self,
        wallet_id: &str,
    ) -> Result<usize, DeleteWalletError> {
        let pos = self
            .wallets
            .iter()
            .position(|w| w.id == wallet_id)
            .ok_or(DeleteWalletError::NotFound)?;

        if self.wallets.len() <= 1 {
            return Err(DeleteWalletError::LastWallet);
        }

        Ok(pos)
    }

    fn save_atomic(&self, data_dir: &Path) -> std::io::Result<bool> {
        self.validate()?;
        let path = Self::manifest_path(data_dir);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "wallets.json replacement target is not a regular file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let temp_path = data_dir.join(format!(".wallets-{}.tmp", uuid::Uuid::new_v4()));
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        let result = (|| {
            let mut temp = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)?;
            temp.write_all(&json)?;
            temp.sync_all()?;
            #[cfg(not(windows))]
            std::fs::rename(&temp_path, &path)?;
            #[cfg(windows)]
            replace_manifest_with_backup(&temp_path, &path, &manifest_backup_path(data_dir))?;
            #[cfg(windows)]
            if let Err(e) = std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| file.sync_all())
            {
                tracing::warn!(
                    "wallet manifest replaced but file durability could not be confirmed: {e}"
                );
                return Ok(false);
            }
            #[cfg(unix)]
            if let Err(e) = std::fs::File::open(data_dir).and_then(|dir| dir.sync_all()) {
                tracing::warn!(
                    "wallet manifest replaced but directory durability could not be confirmed: {e}"
                );
                return Ok(false);
            }
            Ok(true)
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(temp_path);
        }
        result
    }
}

#[cfg(any(windows, test))]
fn manifest_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join("wallets.json.backup")
}

/// Restore the last complete manifest after interruption between the two
/// Windows replacement renames. If the new manifest is present, it wins.
#[cfg(any(windows, test))]
fn recover_manifest_backup(path: &Path, backup: &Path) -> std::io::Result<()> {
    if !path.exists() && backup.exists() {
        std::fs::rename(backup, path)?;
        tracing::warn!("recovered wallet manifest from interrupted replacement");
    }
    Ok(())
}

/// Windows cannot portably rename over an existing destination. Preserve the
/// old manifest, install the synced temp file, and restore the backup if the
/// second rename fails. This is compiled in tests on every host so the recovery
/// protocol does not rely on an untested `cfg(windows)` branch.
#[cfg(any(windows, test))]
fn replace_manifest_with_backup(temp: &Path, path: &Path, backup: &Path) -> std::io::Result<()> {
    recover_manifest_backup(path, backup)?;
    if backup.exists() {
        std::fs::remove_file(backup)?;
    }

    let had_manifest = path.exists();
    if had_manifest {
        std::fs::rename(path, backup)?;
    }

    if let Err(e) = std::fs::rename(temp, path) {
        if had_manifest {
            let _ = std::fs::rename(backup, path);
        }
        return Err(e);
    }

    if had_manifest && let Err(e) = std::fs::remove_file(backup) {
        tracing::warn!("wallet manifest replaced but backup cleanup failed: {e}");
    }
    Ok(())
}

fn chrono_now() -> String {
    // ISO 8601 timestamp without pulling in chrono crate
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Convert to UTC components
    let days = secs / 86400;
    let time = secs % 86400;
    let hours = time / 3600;
    let mins = (time % 3600) / 60;
    let s = time % 60;
    // Days since 1970-01-01 to Y-M-D
    let (y, m, d) = days_to_ymd(days);
    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{mins:02}:{s:02}Z")
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Civil days algorithm
    let era_days = days + 719468;
    let era = era_days / 146097;
    let doe = era_days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod replacement_tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zuuli-manifest-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test directory");
        dir
    }

    #[test]
    fn prepared_wallet_is_invisible_until_durable_commit() {
        let data_dir = test_dir("staged-add");
        let mut manifest = WalletManifest {
            wallets: Vec::new(),
            active_wallet_id: None,
        };
        let entry = WalletManifest::prepare_wallet("Staged".into(), Some(42));

        assert!(!entry.backup_required);
        assert!(manifest.wallets.is_empty());
        assert!(manifest.active_wallet_id.is_none());
        assert!(!WalletManifest::manifest_path(&data_dir).exists());

        assert!(manifest.commit_wallet(&data_dir, entry.clone()).unwrap());
        assert_eq!(
            manifest.active_wallet_id.as_deref(),
            Some(entry.id.as_str())
        );
        assert_eq!(manifest.wallets.len(), 1);
        let reloaded = WalletManifest::load(&data_dir).expect("load committed manifest");
        assert_eq!(
            reloaded.active_wallet_id.as_deref(),
            Some(entry.id.as_str())
        );
        assert_eq!(reloaded.wallets.len(), 1);
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn new_wallet_backup_gate_is_published_and_cleared_durably() {
        let data_dir = test_dir("backup-gate");
        let mut manifest = WalletManifest {
            wallets: Vec::new(),
            active_wallet_id: None,
        };
        let mut entry = WalletManifest::prepare_wallet("New identity".into(), Some(42));
        WalletManifest::require_backup(&mut entry);
        let wallet_id = entry.id.clone();

        manifest.commit_wallet(&data_dir, entry).unwrap();
        assert!(manifest.active_backup_required());
        assert!(
            WalletManifest::load(&data_dir)
                .expect("reload required backup")
                .active_backup_required()
        );

        assert!(manifest.confirm_backup(&data_dir, &wallet_id).unwrap());
        assert!(!manifest.active_backup_required());
        assert!(
            !WalletManifest::load(&data_dir)
                .expect("reload confirmed backup")
                .active_backup_required()
        );
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn backup_confirmation_binds_active_wallet_and_rolls_back_on_write_failure() {
        let data_dir = test_dir("backup-confirm-rollback");
        let mut active = WalletManifest::prepare_wallet("Active".into(), Some(1));
        WalletManifest::require_backup(&mut active);
        let other = WalletManifest::prepare_wallet("Other".into(), Some(2));
        let mut manifest = WalletManifest {
            wallets: vec![active.clone(), other.clone()],
            active_wallet_id: Some(active.id.clone()),
        };
        manifest.save_atomic(&data_dir).unwrap();
        assert!(manifest.is_exact_active_backup_pending(&active.id));

        assert!(manifest.set_active(&data_dir, &other.id).unwrap());
        assert!(
            !manifest.is_exact_active_backup_pending(&active.id),
            "a switched-away seed screen cannot retrieve the prior wallet phrase"
        );
        assert!(
            !manifest.confirm_backup(&data_dir, &active.id).unwrap(),
            "a seed screen from the prior wallet cannot confirm after a switch"
        );
        assert!(
            manifest
                .wallets
                .iter()
                .find(|wallet| wallet.id == active.id)
                .unwrap()
                .backup_required
        );
        assert!(manifest.set_active(&data_dir, &active.id).unwrap());

        std::fs::remove_file(data_dir.join("wallets.json")).unwrap();
        std::fs::create_dir(data_dir.join("wallets.json")).unwrap();
        assert!(manifest.confirm_backup(&data_dir, &active.id).is_err());
        assert!(
            manifest.active_backup_required(),
            "failed persistence must restore the in-memory gate"
        );
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn legacy_manifest_without_backup_field_defaults_to_complete() {
        let data_dir = test_dir("legacy-backup-default");
        std::fs::write(
            data_dir.join("wallets.json"),
            r#"{
              "wallets": [{
                "id": "legacy",
                "name": "Legacy",
                "db_filename": "wallet.sqlite",
                "birthday_height": null,
                "created_at": "2025-01-01T00:00:00Z"
              }],
              "active_wallet_id": "legacy"
            }"#,
        )
        .unwrap();

        let manifest = WalletManifest::load(&data_dir).expect("load legacy manifest");
        assert!(!manifest.active_backup_required());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn active_wallet_persistence_failure_rolls_back_memory() {
        let parent = test_dir("activate-rollback");
        let invalid_data_dir = parent.join("not-a-directory");
        std::fs::write(&invalid_data_dir, b"file").expect("create invalid data directory");
        let first = WalletManifest::prepare_wallet("First".into(), Some(1));
        let second = WalletManifest::prepare_wallet("Second".into(), Some(2));
        let mut manifest = WalletManifest {
            wallets: vec![first.clone(), second.clone()],
            active_wallet_id: Some(first.id.clone()),
        };

        assert!(manifest.set_active(&invalid_data_dir, &second.id).is_err());
        assert_eq!(
            manifest.active_wallet_id.as_deref(),
            Some(first.id.as_str())
        );
        std::fs::remove_dir_all(parent).expect("remove test directory");
    }

    #[test]
    fn legacy_database_adoption_preserves_sqlite_triplet_byte_for_byte() {
        let data_dir = test_dir("legacy-adoption");
        let db = data_dir.join("wallet.sqlite");
        let wal = data_dir.join("wallet.sqlite-wal");
        let shm = data_dir.join("wallet.sqlite-shm");
        std::fs::write(&db, b"database bytes").expect("write legacy database");
        std::fs::write(&wal, b"uncheckpointed transactions").expect("write legacy WAL");
        std::fs::write(&shm, b"shared-memory index").expect("write legacy SHM");

        let mut manifest = WalletManifest {
            wallets: Vec::new(),
            active_wallet_id: None,
        };
        assert!(
            manifest
                .migrate_legacy(&data_dir)
                .expect("adopt legacy wallet")
        );

        assert_eq!(
            std::fs::read(&db).expect("read database"),
            b"database bytes"
        );
        assert_eq!(
            std::fs::read(&wal).expect("read WAL"),
            b"uncheckpointed transactions"
        );
        assert_eq!(
            std::fs::read(&shm).expect("read SHM"),
            b"shared-memory index"
        );
        let active = manifest.get_active().expect("active legacy wallet");
        assert_eq!(active.db_filename, "wallet.sqlite");
        let active_id = active.id.clone();
        let persisted = WalletManifest::load(&data_dir).expect("load legacy manifest");
        assert_eq!(persisted.get_active().unwrap().db_filename, "wallet.sqlite");
        assert!(
            !manifest
                .migrate_legacy(&data_dir)
                .expect("repeat legacy adoption")
        );
        assert!(!data_dir.join(format!("wallet_{active_id}.sqlite")).exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn failed_legacy_manifest_commit_leaves_files_and_memory_untouched() {
        let data_dir = test_dir("legacy-rollback");
        let db = data_dir.join("wallet.sqlite");
        let wal = data_dir.join("wallet.sqlite-wal");
        let shm = data_dir.join("wallet.sqlite-shm");
        std::fs::write(&db, b"database bytes").expect("write legacy database");
        std::fs::write(&wal, b"wal bytes").expect("write legacy WAL");
        std::fs::write(&shm, b"shm bytes").expect("write legacy SHM");
        std::fs::create_dir(data_dir.join("wallets.json"))
            .expect("block atomic manifest replacement");
        let mut manifest = WalletManifest {
            wallets: Vec::new(),
            active_wallet_id: None,
        };

        assert!(manifest.migrate_legacy(&data_dir).is_err());

        assert!(manifest.wallets.is_empty());
        assert!(manifest.active_wallet_id.is_none());
        assert_eq!(
            std::fs::read(&db).expect("read database"),
            b"database bytes"
        );
        assert_eq!(std::fs::read(&wal).expect("read WAL"), b"wal bytes");
        assert_eq!(std::fs::read(&shm).expect("read SHM"), b"shm bytes");
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn corrupt_manifest_fails_closed() {
        let data_dir = test_dir("corrupt-load");
        std::fs::write(data_dir.join("wallets.json"), b"not json").expect("write corrupt manifest");
        std::fs::write(data_dir.join("wallet.sqlite"), b"legacy database")
            .expect("write legacy database");

        let error = WalletManifest::load(&data_dir).expect_err("corrupt manifest must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(
            std::fs::read(data_dir.join("wallet.sqlite")).expect("read legacy database"),
            b"legacy database"
        );
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn manifest_database_path_escape_fails_closed() {
        let data_dir = test_dir("path-escape");
        let id = uuid::Uuid::new_v4().to_string();
        let manifest = WalletManifest {
            wallets: vec![WalletEntry {
                id: id.clone(),
                name: "Escaped".into(),
                db_filename: "../../outside.sqlite".into(),
                birthday_height: None,
                created_at: chrono_now(),
                backup_required: false,
            }],
            active_wallet_id: Some(id),
        };
        std::fs::write(
            WalletManifest::manifest_path(&data_dir),
            serde_json::to_vec(&manifest).expect("serialize unsafe manifest"),
        )
        .expect("write unsafe manifest");

        let error = WalletManifest::load(&data_dir).expect_err("reject path escape");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn backup_replacement_installs_new_manifest_and_removes_backup() {
        let data_dir = test_dir("replace");
        let path = WalletManifest::manifest_path(&data_dir);
        let backup = manifest_backup_path(&data_dir);
        let temp = data_dir.join("wallets.tmp");
        std::fs::write(&path, b"old manifest").expect("write old manifest");
        std::fs::write(&backup, b"stale backup").expect("write stale backup");
        std::fs::write(&temp, b"new manifest").expect("write new manifest");

        replace_manifest_with_backup(&temp, &path, &backup).expect("replace manifest");

        assert_eq!(
            std::fs::read(&path).expect("read manifest"),
            b"new manifest"
        );
        assert!(!temp.exists());
        assert!(!backup.exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn failed_install_restores_previous_manifest() {
        let data_dir = test_dir("rollback");
        let path = WalletManifest::manifest_path(&data_dir);
        let backup = manifest_backup_path(&data_dir);
        let missing_temp = data_dir.join("missing.tmp");
        std::fs::write(&path, b"old manifest").expect("write old manifest");

        assert!(replace_manifest_with_backup(&missing_temp, &path, &backup).is_err());

        assert_eq!(
            std::fs::read(&path).expect("read manifest"),
            b"old manifest"
        );
        assert!(!backup.exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn backup_replacement_installs_first_manifest() {
        let data_dir = test_dir("first");
        let path = WalletManifest::manifest_path(&data_dir);
        let backup = manifest_backup_path(&data_dir);
        let temp = data_dir.join("wallets.tmp");
        std::fs::write(&temp, b"first manifest").expect("write new manifest");

        replace_manifest_with_backup(&temp, &path, &backup).expect("install manifest");

        assert_eq!(
            std::fs::read(&path).expect("read manifest"),
            b"first manifest"
        );
        assert!(!backup.exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }

    #[test]
    fn interrupted_replacement_recovers_complete_backup() {
        let data_dir = test_dir("recover");
        let path = WalletManifest::manifest_path(&data_dir);
        let backup = manifest_backup_path(&data_dir);
        std::fs::write(&backup, b"complete old manifest").expect("write backup");

        recover_manifest_backup(&path, &backup).expect("recover manifest");

        assert_eq!(
            std::fs::read(&path).expect("read recovered manifest"),
            b"complete old manifest"
        );
        assert!(!backup.exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }
}
