use serde::{Deserialize, Serialize};
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

impl WalletManifest {
    fn manifest_path(data_dir: &Path) -> PathBuf {
        data_dir.join("wallets.json")
    }

    /// Load manifest from disk, or create empty if none exists.
    pub fn load(data_dir: &Path) -> Self {
        let path = Self::manifest_path(data_dir);
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
        let path = Self::manifest_path(data_dir);
        match serde_json::to_string_pretty(self) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    tracing::error!("failed to write wallets.json: {e}");
                }
            }
            Err(e) => tracing::error!("failed to serialize wallets.json: {e}"),
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

    /// Add a new wallet and set it as active.
    pub fn add_wallet(
        &mut self,
        data_dir: &Path,
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
        self.wallets.push(entry.clone());
        self.active_wallet_id = Some(id);
        self.save(data_dir);
        entry
    }

    /// Set the active wallet by ID.
    pub fn set_active(&mut self, data_dir: &Path, wallet_id: &str) -> bool {
        if self.wallets.iter().any(|w| w.id == wallet_id) {
            self.active_wallet_id = Some(wallet_id.to_string());
            self.save(data_dir);
            true
        } else {
            false
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

    /// Delete a wallet. Returns the entry if removed.
    pub fn delete_wallet(&mut self, data_dir: &Path, wallet_id: &str) -> Option<WalletEntry> {
        if self.wallets.len() <= 1 {
            return None; // Can't delete the last wallet
        }
        let pos = self.wallets.iter().position(|w| w.id == wallet_id)?;
        let entry = self.wallets.remove(pos);

        // If we deleted the active wallet, switch to the first remaining
        if self.active_wallet_id.as_deref() == Some(wallet_id) {
            self.active_wallet_id = self.wallets.first().map(|w| w.id.clone());
        }

        // Delete the DB file
        let db_path = data_dir.join(&entry.db_filename);
        if db_path.exists() {
            let _ = std::fs::remove_file(&db_path);
        }

        self.save(data_dir);
        Some(entry)
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
