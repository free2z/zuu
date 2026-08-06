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

pub(crate) struct DurableDeletion {
    pub(crate) entry: WalletEntry,
    pub(crate) cleanup_authorized: bool,
}

impl WalletManifest {
    fn manifest_path(data_dir: &Path) -> PathBuf {
        data_dir.join("wallets.json")
    }

    /// Load manifest from disk, or create empty if none exists.
    pub fn load(data_dir: &Path) -> Self {
        let path = Self::manifest_path(data_dir);
        #[cfg(windows)]
        if let Err(e) = recover_manifest_backup(&path, &manifest_backup_path(data_dir)) {
            tracing::error!("failed to recover wallet manifest backup: {e}");
        }
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(contents) => match serde_json::from_str(&contents) {
                    Ok(m) => return m,
                    Err(e) => tracing::error!("failed to parse wallets.json: {e}"),
                },
                Err(e) => tracing::error!("failed to read wallets.json: {e}"),
            }
        }
        Self {
            wallets: Vec::new(),
            active_wallet_id: None,
        }
    }

    /// Save manifest to disk.
    pub fn save(&self, data_dir: &Path) {
        if let Err(e) = self.save_atomic(data_dir) {
            tracing::error!("failed to save wallets.json atomically: {e}");
        }
    }

    /// Migrate legacy wallet.sqlite (no manifest) to the new format.
    pub fn migrate_legacy(&mut self, data_dir: &Path) {
        if !self.wallets.is_empty() {
            return; // Already have wallets, no migration needed
        }

        let legacy_path = data_dir.join("wallet.sqlite");
        if !legacy_path.exists() {
            return; // No legacy wallet
        }

        let id = uuid::Uuid::new_v4().to_string();
        let db_filename = format!("wallet_{id}.sqlite");
        let new_path = data_dir.join(&db_filename);

        // Rename the file
        if let Err(e) = std::fs::rename(&legacy_path, &new_path) {
            tracing::error!("failed to migrate legacy wallet.sqlite: {e}");
            return;
        }

        tracing::info!("migrated legacy wallet.sqlite -> {db_filename}");

        let entry = WalletEntry {
            id: id.clone(),
            name: "Default".to_string(),
            db_filename,
            birthday_height: None,
            created_at: chrono_now(),
        };

        self.wallets.push(entry);
        self.active_wallet_id = Some(id);
        self.save(data_dir);
    }

    /// Get the active wallet entry.
    pub fn get_active(&self) -> Option<&WalletEntry> {
        self.active_wallet_id
            .as_ref()
            .and_then(|id| self.wallets.iter().find(|w| &w.id == id))
    }

    /// Allocate a wallet identity without making it visible or durable.
    ///
    /// Callers initialize the database and commit native seed custody before
    /// passing the entry to `commit_wallet`. This prevents a failed secure-store
    /// operation from leaving an active manifest entry with no spending key.
    pub fn prepare_wallet(
        name: String,
        birthday_height: Option<u64>,
    ) -> WalletEntry {
        let id = uuid::Uuid::new_v4().to_string();
        let db_filename = format!("wallet_{id}.sqlite");
        let entry = WalletEntry {
            id: id.clone(),
            name,
            db_filename,
            birthday_height,
            created_at: chrono_now(),
        };
        entry
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
    pub fn set_active(
        &mut self,
        data_dir: &Path,
        wallet_id: &str,
    ) -> std::io::Result<bool> {
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
    ) -> Result<DurableDeletion, DeleteWalletError> {
        let pos = self.validate_wallet_deletion(wallet_id)?;
        let previous_active = self.active_wallet_id.clone();
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
                return Err(DeleteWalletError::Persistence(e.to_string()));
            }
        };

        if !cleanup_authorized {
            tracing::warn!(
                "wallet manifest replacement was visible but not confirmed durable; preserving database and seed"
            );
        }

        Ok(DurableDeletion {
            entry,
            cleanup_authorized,
        })
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
        let path = Self::manifest_path(data_dir);
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
            replace_manifest_with_backup(
                &temp_path,
                &path,
                &manifest_backup_path(data_dir),
            )?;
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
fn replace_manifest_with_backup(
    temp: &Path,
    path: &Path,
    backup: &Path,
) -> std::io::Result<()> {
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

    if had_manifest {
        if let Err(e) = std::fs::remove_file(backup) {
            tracing::warn!("wallet manifest replaced but backup cleanup failed: {e}");
        }
    }
    Ok(())
}

pub(crate) fn cleanup_wallet_database_files(data_dir: &Path, filename: &str) {
    for db_path in [
        data_dir.join(filename),
        data_dir.join(format!("{filename}-wal")),
        data_dir.join(format!("{filename}-shm")),
    ] {
        if db_path.exists() {
            if let Err(e) = std::fs::remove_file(&db_path) {
                tracing::warn!("wallet removed but database cleanup failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zuuli-manifest-{label}-{}",
            uuid::Uuid::new_v4()
        ));
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

        assert!(manifest.wallets.is_empty());
        assert!(manifest.active_wallet_id.is_none());
        assert!(!WalletManifest::manifest_path(&data_dir).exists());

        assert!(manifest.commit_wallet(&data_dir, entry.clone()).unwrap());
        assert_eq!(manifest.active_wallet_id.as_deref(), Some(entry.id.as_str()));
        assert_eq!(manifest.wallets.len(), 1);
        let reloaded = WalletManifest::load(&data_dir);
        assert_eq!(reloaded.active_wallet_id.as_deref(), Some(entry.id.as_str()));
        assert_eq!(reloaded.wallets.len(), 1);
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
        assert_eq!(manifest.active_wallet_id.as_deref(), Some(first.id.as_str()));
        std::fs::remove_dir_all(parent).expect("remove test directory");
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

        assert_eq!(std::fs::read(&path).expect("read manifest"), b"new manifest");
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

        assert_eq!(std::fs::read(&path).expect("read manifest"), b"old manifest");
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

        assert_eq!(std::fs::read(&path).expect("read manifest"), b"first manifest");
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
