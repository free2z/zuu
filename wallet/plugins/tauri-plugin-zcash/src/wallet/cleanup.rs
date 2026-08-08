//! Durable, idempotent cleanup for wallet deletion and failed creation.
//!
//! The journal is the authority to destroy state that is no longer reachable
//! from `wallets.json`. It is committed before a wallet deletion mutates the
//! manifest and before a staged create/restore writes any database or custody
//! record. Every destructive retry rechecks the current manifest so an old
//! journal entry can never target a live or reintroduced wallet identity.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::keychain::SeedStore;
use super::manifest::{WalletEntry, WalletManifest};

const JOURNAL_VERSION: u32 = 1;
const JOURNAL_FILENAME: &str = "wallet-cleanup.json";
#[cfg(any(windows, test))]
const JOURNAL_BACKUP_FILENAME: &str = "wallet-cleanup.json.backup";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetryMode {
    /// The manifest was just loaded from the filesystem. Its presence or
    /// absence resolves a deletion whose directory fsync was uncertain.
    Startup,
    /// The process that performed the transition is still running. An
    /// uncertain deletion must wait for restart rather than destroy data that
    /// an older manifest could make reachable after power loss.
    Runtime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CleanupReason {
    WalletDeletion,
    StagedWalletRollback,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum CleanupStage {
    Database,
    DatabaseWal,
    DatabaseShm,
    DatabaseRollbackJournal,
    PendingSendJournal,
    LegacyFileCustody,
    LegacyKeyringCustody,
    NativeCustody,
}

const ALL_STAGES: [CleanupStage; 8] = [
    CleanupStage::Database,
    CleanupStage::DatabaseWal,
    CleanupStage::DatabaseShm,
    CleanupStage::DatabaseRollbackJournal,
    CleanupStage::PendingSendJournal,
    CleanupStage::LegacyFileCustody,
    CleanupStage::LegacyKeyringCustody,
    CleanupStage::NativeCustody,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CleanupOperation {
    operation_id: String,
    wallet_id: String,
    /// `WalletEntry::created_at` is the immutable generation tag for the
    /// manifest schema that predates this journal.
    generation: String,
    db_filename: String,
    /// Present for journals written by this version so startup can restore a
    /// wallet that was published before an inconclusive manifest directory
    /// fsync. Older journals remain fail-closed instead of deleting its data.
    #[serde(default)]
    wallet_name: Option<String>,
    #[serde(default)]
    birthday_height: Option<u64>,
    reason: CleanupReason,
    /// Deletions are not executable until both the manifest and this flag are
    /// durably committed. Rollbacks are executable whenever the exact wallet
    /// generation is absent from the manifest.
    transition_confirmed: bool,
    /// A create/restore command was allowed to publish this wallet even though
    /// manifest directory durability was uncertain. If the manifest is absent
    /// after a crash, database files may be reclaimed, but custody must survive:
    /// the caller may already have displayed the address and accepted funds.
    #[serde(default)]
    preserve_custody_if_manifest_missing: bool,
    remaining: Vec<CleanupStage>,
    #[serde(default)]
    attempts: u64,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CleanupJournal {
    version: u32,
    operations: Vec<CleanupOperation>,
}

impl Default for CleanupJournal {
    fn default() -> Self {
        Self {
            version: JOURNAL_VERSION,
            operations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CleanupAuthorization {
    operation_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CleanupReport {
    pub(crate) pending_operations: u32,
    pub(crate) blocked_operations: u32,
    pub(crate) pending_stages: u32,
    pub(crate) completed_stages: u32,
    pub(crate) diagnostics: Vec<String>,
}

impl CleanupReport {
    pub(crate) fn journal_error(error: impl std::fmt::Display) -> Self {
        Self {
            // The journal could not be decoded, so its operation count is
            // unknown. Do not fabricate one; blocked + diagnostics carry the
            // actionable state without pretending to know its contents.
            pending_operations: 0,
            blocked_operations: 1,
            pending_stages: 0,
            completed_stages: 0,
            diagnostics: vec![format!("wallet cleanup journal unavailable: {error}")],
        }
    }
}

pub(crate) fn schedule_wallet_deletion(
    data_dir: &Path,
    entry: &WalletEntry,
) -> std::io::Result<CleanupAuthorization> {
    schedule(data_dir, entry, CleanupReason::WalletDeletion)
}

pub(crate) fn schedule_staged_wallet_rollback(
    data_dir: &Path,
    entry: &WalletEntry,
) -> std::io::Result<CleanupAuthorization> {
    schedule(data_dir, entry, CleanupReason::StagedWalletRollback)
}

fn schedule(
    data_dir: &Path,
    entry: &WalletEntry,
    reason: CleanupReason,
) -> std::io::Result<CleanupAuthorization> {
    validate_identity(&entry.id, &entry.created_at, &entry.db_filename)?;
    let mut journal = load(data_dir)?;

    if let Some(existing) = journal.operations.iter().find(|operation| {
        operation.wallet_id == entry.id
            && operation.generation == entry.created_at
            && operation.db_filename == entry.db_filename
            && operation.reason == reason
    }) {
        return Ok(CleanupAuthorization {
            operation_id: existing.operation_id.clone(),
        });
    }

    if journal.operations.iter().any(|operation| {
        operation.wallet_id == entry.id || operation.db_filename == entry.db_filename
    }) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup journal already binds this wallet identity or database to another generation",
        ));
    }

    let operation_id = uuid::Uuid::new_v4().to_string();
    journal.operations.push(CleanupOperation {
        operation_id: operation_id.clone(),
        wallet_id: entry.id.clone(),
        generation: entry.created_at.clone(),
        db_filename: entry.db_filename.clone(),
        wallet_name: Some(entry.name.clone()),
        birthday_height: entry.birthday_height,
        reason,
        transition_confirmed: false,
        preserve_custody_if_manifest_missing: false,
        remaining: ALL_STAGES.to_vec(),
        attempts: 0,
        last_error: None,
    });
    save_durable(data_dir, &journal)?;
    Ok(CleanupAuthorization { operation_id })
}

/// Mark a scheduled deletion executable only after the manifest replacement
/// was itself confirmed durable. Failure leaves the precommitted tombstone for
/// startup recovery, but withholds runtime destruction.
pub(crate) fn authorize_wallet_deletion(
    data_dir: &Path,
    authorization: &CleanupAuthorization,
) -> std::io::Result<()> {
    let mut journal = load(data_dir)?;
    let operation = journal
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == authorization.operation_id)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "wallet cleanup authorization is missing",
            )
        })?;
    if operation.reason != CleanupReason::WalletDeletion {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cleanup authorization is not a wallet deletion",
        ));
    }
    operation.transition_confirmed = true;
    operation.last_error = None;
    save_durable(data_dir, &journal)
}

/// Confirm that a staged create/restore became durably reachable. A retry can
/// then cancel its rollback tombstone in the same process. Without this bit,
/// an exact active manifest is resolved only after restart, because the
/// directory fsync may have failed after replacement became visible.
pub(crate) fn confirm_staged_wallet_commit(
    data_dir: &Path,
    authorization: &CleanupAuthorization,
) -> std::io::Result<()> {
    let mut journal = load(data_dir)?;
    let operation = journal
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == authorization.operation_id)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "staged wallet cleanup authorization is missing",
            )
        })?;
    if operation.reason != CleanupReason::StagedWalletRollback {
        return Err(invalid(
            "cleanup authorization is not a staged wallet rollback",
        ));
    }
    operation.transition_confirmed = true;
    operation.last_error = None;
    save_durable(data_dir, &journal)
}

/// Protect recovery material before an uncertainty-durable staged wallet is
/// exposed to its caller. The marker itself must be durable before the command
/// can install the live context or return the generated mnemonic.
pub(crate) fn protect_staged_wallet_custody(
    data_dir: &Path,
    authorization: &CleanupAuthorization,
) -> std::io::Result<()> {
    let mut journal = load(data_dir)?;
    let operation = journal
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == authorization.operation_id)
        .ok_or_else(|| invalid("staged wallet cleanup authorization is missing"))?;
    if operation.reason != CleanupReason::StagedWalletRollback {
        return Err(invalid(
            "cleanup authorization is not a staged wallet rollback",
        ));
    }
    operation.preserve_custody_if_manifest_missing = true;
    operation.last_error = None;
    save_durable(data_dir, &journal)
}

/// Re-arm custody cleanup after manifest publication failed before the wallet
/// was exposed. Failure remains safe: the durable protection marker wins and
/// may leak an orphan custody record, but it cannot destroy a published key.
pub(crate) fn rearm_staged_wallet_custody_cleanup(
    data_dir: &Path,
    authorization: &CleanupAuthorization,
) -> std::io::Result<()> {
    let mut journal = load(data_dir)?;
    let operation = journal
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == authorization.operation_id)
        .ok_or_else(|| invalid("staged wallet cleanup authorization is missing"))?;
    if operation.reason != CleanupReason::StagedWalletRollback {
        return Err(invalid(
            "cleanup authorization is not a staged wallet rollback",
        ));
    }
    operation.preserve_custody_if_manifest_missing = false;
    operation.last_error = None;
    save_durable(data_dir, &journal)
}

/// Best-effort rollback for a transition that never became visible. Failure is
/// safe: startup sees the exact active generation and cancels the tombstone.
pub(crate) fn cancel(data_dir: &Path, authorization: &CleanupAuthorization) -> std::io::Result<()> {
    let mut journal = load(data_dir)?;
    let original_len = journal.operations.len();
    journal
        .operations
        .retain(|operation| operation.operation_id != authorization.operation_id);
    if journal.operations.len() != original_len {
        save_durable(data_dir, &journal)?;
    }
    Ok(())
}

pub(crate) fn retry_pending(
    data_dir: &Path,
    manifest: &WalletManifest,
    seed_store: &SeedStore,
    mode: RetryMode,
) -> std::io::Result<CleanupReport> {
    retry_pending_with_scope(
        data_dir,
        manifest,
        mode,
        RetryScope::All,
        |operation, stage| execute_stage(data_dir, seed_store, operation, stage),
    )
}

/// Resolve manifest uncertainty and reclaim filesystem artifacts before live
/// database handles are opened, while deferring potentially prompting native
/// custody APIs to the asynchronous post-setup pass.
pub(crate) fn retry_pending_filesystem(
    data_dir: &Path,
    manifest: &WalletManifest,
    seed_store: &SeedStore,
    mode: RetryMode,
) -> std::io::Result<CleanupReport> {
    retry_pending_with_scope(
        data_dir,
        manifest,
        mode,
        RetryScope::FilesystemOnly,
        |operation, stage| execute_stage(data_dir, seed_store, operation, stage),
    )
}

/// Restore a wallet whose create/restore command was published to the caller,
/// but whose manifest rename did not survive an inconclusive directory fsync.
/// Reinstating reachability is safer than deleting either the database or key.
pub(crate) fn recover_published_wallets(
    data_dir: &Path,
    manifest: &mut WalletManifest,
) -> std::io::Result<Vec<String>> {
    let journal = load(data_dir)?;
    let mut diagnostics = Vec::new();
    let recoverable: Vec<CleanupOperation> = journal
        .operations
        .iter()
        .filter(|operation| {
            operation.reason == CleanupReason::StagedWalletRollback
                && operation.preserve_custody_if_manifest_missing
                && matches!(manifest_binding(manifest, operation), ManifestBinding::Absent)
        })
        .cloned()
        .collect();
    for operation in recoverable {
        let Some(name) = operation.wallet_name.clone() else {
            diagnostics.push(format!(
                "cleanup {} wallet {} is preserved but requires manual manifest recovery",
                operation.operation_id, operation.wallet_id
            ));
            continue;
        };
        let entry = WalletEntry {
            id: operation.wallet_id.clone(),
            name,
            db_filename: operation.db_filename.clone(),
            birthday_height: operation.birthday_height,
            created_at: operation.generation.clone(),
        };
        match manifest.commit_wallet(data_dir, entry) {
            Ok(true) => diagnostics.push(format!(
                "restored published wallet {} after an interrupted manifest commit",
                operation.wallet_id
            )),
            Ok(false) => {
                return Err(std::io::Error::other(format!(
                    "restored wallet {} is visible but manifest durability remains uncertain",
                    operation.wallet_id
                )));
            }
            Err(error) => {
                return Err(std::io::Error::other(format!(
                    "could not restore published wallet {}: {error}",
                    operation.wallet_id
                )));
            }
        }
    }
    Ok(diagnostics)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RetryScope {
    FilesystemOnly,
    All,
}

#[cfg(test)]
fn retry_pending_with<F>(
    data_dir: &Path,
    manifest: &WalletManifest,
    mode: RetryMode,
    execute: F,
) -> std::io::Result<CleanupReport>
where
    F: FnMut(&CleanupOperation, CleanupStage) -> Result<(), String>,
{
    retry_pending_with_scope(data_dir, manifest, mode, RetryScope::All, execute)
}

fn retry_pending_with_scope<F>(
    data_dir: &Path,
    manifest: &WalletManifest,
    mode: RetryMode,
    scope: RetryScope,
    mut execute: F,
) -> std::io::Result<CleanupReport>
where
    F: FnMut(&CleanupOperation, CleanupStage) -> Result<(), String>,
{
    let mut journal = load(data_dir)?;
    let operation_ids: Vec<String> = journal
        .operations
        .iter()
        .map(|operation| operation.operation_id.clone())
        .collect();
    let mut report = CleanupReport::default();

    for operation_id in operation_ids {
        let Some(snapshot) = journal
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .cloned()
        else {
            continue;
        };

        match manifest_binding(manifest, &snapshot) {
            ManifestBinding::ExactGeneration
                if snapshot.reason == CleanupReason::StagedWalletRollback
                    && mode == RetryMode::Runtime
                    && !snapshot.transition_confirmed =>
            {
                let diagnostic = format!(
                    "cleanup {} for wallet {} awaits restart to resolve staged manifest durability",
                    snapshot.operation_id, snapshot.wallet_id
                );
                if let Some(operation) = journal
                    .operations
                    .iter_mut()
                    .find(|operation| operation.operation_id == operation_id)
                {
                    operation.attempts = operation.attempts.saturating_add(1);
                    operation.last_error = Some(diagnostic.clone());
                }
                save_durable(data_dir, &journal)?;
                report.blocked_operations = report.blocked_operations.saturating_add(1);
                report.diagnostics.push(diagnostic);
                continue;
            }
            ManifestBinding::ExactGeneration => {
                journal
                    .operations
                    .retain(|operation| operation.operation_id != operation_id);
                save_durable(data_dir, &journal)?;
                continue;
            }
            ManifestBinding::ConflictingIdentity(message) => {
                let diagnostic = format!(
                    "cleanup {} for wallet {} blocked: {message}",
                    snapshot.operation_id, snapshot.wallet_id
                );
                if let Some(operation) = journal
                    .operations
                    .iter_mut()
                    .find(|operation| operation.operation_id == operation_id)
                {
                    operation.attempts = operation.attempts.saturating_add(1);
                    operation.last_error = Some(diagnostic.clone());
                }
                save_durable(data_dir, &journal)?;
                report.blocked_operations = report.blocked_operations.saturating_add(1);
                report.diagnostics.push(diagnostic);
                continue;
            }
            ManifestBinding::Absent => {}
        }

        if snapshot.reason == CleanupReason::StagedWalletRollback
            && snapshot.preserve_custody_if_manifest_missing
        {
            let diagnostic = format!(
                "cleanup {} wallet {} preserved its published database and recovery custody pending manifest recovery",
                snapshot.operation_id, snapshot.wallet_id
            );
            if let Some(operation) = journal
                .operations
                .iter_mut()
                .find(|operation| operation.operation_id == operation_id)
            {
                operation.attempts = operation.attempts.saturating_add(1);
                operation.last_error = Some(diagnostic.clone());
            }
            save_durable(data_dir, &journal)?;
            report.blocked_operations = report.blocked_operations.saturating_add(1);
            report.diagnostics.push(diagnostic);
            continue;
        }

        if snapshot.reason == CleanupReason::WalletDeletion && !snapshot.transition_confirmed {
            if mode == RetryMode::Startup {
                if let Some(operation) = journal
                    .operations
                    .iter_mut()
                    .find(|operation| operation.operation_id == operation_id)
                {
                    operation.transition_confirmed = true;
                    operation.last_error = None;
                }
                // Persist startup's resolution before consuming any stage.
                save_durable(data_dir, &journal)?;
            } else {
                let diagnostic = format!(
                    "cleanup {} for wallet {} awaits restart to resolve manifest durability",
                    snapshot.operation_id, snapshot.wallet_id
                );
                if let Some(operation) = journal
                    .operations
                    .iter_mut()
                    .find(|operation| operation.operation_id == operation_id)
                {
                    operation.attempts = operation.attempts.saturating_add(1);
                    operation.last_error = Some(diagnostic.clone());
                }
                save_durable(data_dir, &journal)?;
                report.blocked_operations = report.blocked_operations.saturating_add(1);
                report.diagnostics.push(diagnostic);
                continue;
            }
        }

        let stages = journal
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .map(|operation| operation.remaining.clone())
            .unwrap_or_default();
        for stage in stages {
            if scope == RetryScope::FilesystemOnly
                && matches!(
                    stage,
                    CleanupStage::LegacyFileCustody
                        | CleanupStage::LegacyKeyringCustody
                        | CleanupStage::NativeCustody
                )
            {
                continue;
            }
            let Some(snapshot) = journal
                .operations
                .iter()
                .find(|operation| operation.operation_id == operation_id)
                .cloned()
            else {
                return Err(invalid(
                    "cleanup operation disappeared before its progress was persisted",
                ));
            };
            match execute(&snapshot, stage) {
                Ok(()) => {
                    if let Some(operation) = journal
                        .operations
                        .iter_mut()
                        .find(|operation| operation.operation_id == operation_id)
                    {
                        operation.remaining.retain(|candidate| *candidate != stage);
                        operation.attempts = operation.attempts.saturating_add(1);
                        operation.last_error = None;
                    }
                    // If a crash happened just before this write, the stage is
                    // repeated idempotently while the authorization survives.
                    save_durable(data_dir, &journal)?;
                    report.completed_stages = report.completed_stages.saturating_add(1);
                }
                Err(error) => {
                    let diagnostic = format!(
                        "cleanup {} wallet {} stage {stage:?} failed: {error}",
                        snapshot.operation_id, snapshot.wallet_id
                    );
                    if let Some(operation) = journal
                        .operations
                        .iter_mut()
                        .find(|operation| operation.operation_id == operation_id)
                    {
                        operation.attempts = operation.attempts.saturating_add(1);
                        operation.last_error = Some(diagnostic.clone());
                    }
                    save_durable(data_dir, &journal)?;
                    report.diagnostics.push(diagnostic);
                }
            }
        }

        let completed = journal
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .is_some_and(|operation| operation.remaining.is_empty());
        if completed {
            journal
                .operations
                .retain(|operation| operation.operation_id != operation_id);
            save_durable(data_dir, &journal)?;
        }
    }

    report.pending_operations = journal.operations.len() as u32;
    report.pending_stages = journal
        .operations
        .iter()
        .map(|operation| operation.remaining.len() as u32)
        .sum();
    for diagnostic in journal
        .operations
        .iter()
        .filter_map(|operation| operation.last_error.clone())
    {
        if !report.diagnostics.contains(&diagnostic) {
            report.diagnostics.push(diagnostic);
        }
    }
    Ok(report)
}

enum ManifestBinding {
    ExactGeneration,
    ConflictingIdentity(String),
    Absent,
}

fn manifest_binding(manifest: &WalletManifest, operation: &CleanupOperation) -> ManifestBinding {
    if let Some(wallet) = manifest
        .wallets
        .iter()
        .find(|wallet| wallet.id == operation.wallet_id)
    {
        if wallet.created_at == operation.generation && wallet.db_filename == operation.db_filename
        {
            return ManifestBinding::ExactGeneration;
        }
        return ManifestBinding::ConflictingIdentity(
            "wallet UUID was reintroduced with a different generation or database".into(),
        );
    }
    if manifest
        .wallets
        .iter()
        .any(|wallet| wallet.db_filename == operation.db_filename)
    {
        return ManifestBinding::ConflictingIdentity(
            "database filename is now owned by another wallet".into(),
        );
    }
    ManifestBinding::Absent
}

fn execute_stage(
    data_dir: &Path,
    seed_store: &SeedStore,
    operation: &CleanupOperation,
    stage: CleanupStage,
) -> Result<(), String> {
    match stage {
        CleanupStage::Database => {
            remove_regular_file(&data_dir.join(&operation.db_filename)).map_err(|e| e.to_string())
        }
        CleanupStage::DatabaseWal => {
            remove_regular_file(&data_dir.join(format!("{}-wal", operation.db_filename)))
                .map_err(|e| e.to_string())
        }
        CleanupStage::DatabaseShm => {
            remove_regular_file(&data_dir.join(format!("{}-shm", operation.db_filename)))
                .map_err(|e| e.to_string())
        }
        CleanupStage::DatabaseRollbackJournal => {
            remove_regular_file(&data_dir.join(format!("{}-journal", operation.db_filename)))
                .map_err(|e| e.to_string())
        }
        CleanupStage::PendingSendJournal => super::send::clear_pending_broadcast(
            data_dir,
            &operation.wallet_id,
        )
        .map_err(|e| e.to_string()),
        CleanupStage::LegacyFileCustody => seed_store
            .delete_legacy_file_record(&operation.wallet_id)
            .map_err(|e| e.to_string()),
        CleanupStage::LegacyKeyringCustody => seed_store
            .delete_legacy_keyring_record(&operation.wallet_id)
            .map_err(|e| e.to_string()),
        CleanupStage::NativeCustody => seed_store
            .delete_native_record(&operation.wallet_id)
            .map_err(|e| e.to_string()),
    }
}

fn remove_regular_file(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            std::fs::remove_file(path)
        }
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("cleanup target is not a regular file: {}", path.display()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join(JOURNAL_FILENAME)
}

#[cfg(any(windows, test))]
fn journal_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(JOURNAL_BACKUP_FILENAME)
}

fn load(data_dir: &Path) -> std::io::Result<CleanupJournal> {
    let path = journal_path(data_dir);
    #[cfg(windows)]
    recover_backup(&path, &journal_backup_path(data_dir))?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            let bytes = std::fs::read(path)?;
            let journal: CleanupJournal = serde_json::from_slice(&bytes)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            validate_journal(&journal)?;
            Ok(journal)
        }
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "wallet-cleanup.json is not a regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CleanupJournal::default()),
        Err(error) => Err(error),
    }
}

fn validate_journal(journal: &CleanupJournal) -> std::io::Result<()> {
    if journal.version != JOURNAL_VERSION {
        return Err(invalid("unsupported wallet cleanup journal version"));
    }
    let mut operation_ids = HashSet::new();
    let mut wallet_ids = HashSet::new();
    let mut db_filenames = HashSet::new();
    for operation in &journal.operations {
        validate_identity(
            &operation.wallet_id,
            &operation.generation,
            &operation.db_filename,
        )?;
        let operation_uuid = uuid::Uuid::parse_str(&operation.operation_id)
            .map_err(|_| invalid("cleanup operation ID is not a UUID"))?;
        if operation_uuid.hyphenated().to_string() != operation.operation_id
            || !operation_ids.insert(operation.operation_id.as_str())
            || !wallet_ids.insert(operation.wallet_id.as_str())
            || !db_filenames.insert(operation.db_filename.as_str())
        {
            return Err(invalid(
                "cleanup journal contains duplicate or noncanonical identities",
            ));
        }
        let mut stages = HashSet::new();
        if operation
            .remaining
            .iter()
            .any(|stage| !stages.insert(*stage))
        {
            return Err(invalid("cleanup journal contains duplicate stages"));
        }
        if operation.preserve_custody_if_manifest_missing
            && operation.reason != CleanupReason::StagedWalletRollback
        {
            return Err(invalid(
                "only staged wallet rollback may preserve published custody",
            ));
        }
    }
    Ok(())
}

fn validate_identity(wallet_id: &str, generation: &str, db_filename: &str) -> std::io::Result<()> {
    let wallet_uuid =
        uuid::Uuid::parse_str(wallet_id).map_err(|_| invalid("cleanup wallet ID is not a UUID"))?;
    if wallet_uuid.hyphenated().to_string() != wallet_id {
        return Err(invalid("cleanup wallet ID is not canonical"));
    }
    if generation.is_empty() || generation.len() > 256 {
        return Err(invalid("cleanup wallet generation is invalid"));
    }
    let path = Path::new(db_filename);
    let single_component = matches!(
        path.components().collect::<Vec<_>>().as_slice(),
        [std::path::Component::Normal(_)]
    );
    let expected_shape = db_filename == "wallet.sqlite"
        || (db_filename.starts_with("wallet_") && db_filename.ends_with(".sqlite"));
    if !single_component || !expected_shape {
        return Err(invalid("cleanup database filename is unsafe"));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

fn save_durable(data_dir: &Path, journal: &CleanupJournal) -> std::io::Result<()> {
    validate_journal(journal)?;
    let path = journal_path(data_dir);
    validate_replacement_target(&path)?;
    let temp = data_dir.join(format!(".wallet-cleanup-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;

    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);

        #[cfg(not(windows))]
        std::fs::rename(&temp, &path)?;
        #[cfg(windows)]
        replace_with_backup(&temp, &path, &journal_backup_path(data_dir))?;

        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)?
            .sync_all()?;
        #[cfg(unix)]
        std::fs::File::open(data_dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn validate_replacement_target(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(())
        }
        Ok(_) => Err(invalid(format!(
            "journal replacement target is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(any(windows, test))]
fn recover_backup(path: &Path, backup: &Path) -> std::io::Result<()> {
    validate_replacement_target(path)?;
    validate_replacement_target(backup)?;
    if !path.exists() && backup.exists() {
        replacement_rename(backup, path)?;
        tracing::warn!("recovered wallet cleanup journal from interrupted replacement");
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn replace_with_backup(temp: &Path, path: &Path, backup: &Path) -> std::io::Result<()> {
    recover_backup(path, backup)?;
    if backup.exists() {
        std::fs::remove_file(backup)?;
    }
    let had_journal = path.exists();
    if had_journal {
        replacement_rename(path, backup)?;
    }
    if let Err(error) = replacement_rename(temp, path) {
        if had_journal {
            let _ = replacement_rename(backup, path);
        }
        return Err(error);
    }
    if had_journal {
        std::fs::remove_file(backup)?;
    }
    Ok(())
}

#[cfg(windows)]
fn replacement_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Destinations are validated absent by the backup protocol, so no replace
    // flag is permitted. WRITE_THROUGH waits for the move to reach storage.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(all(test, not(windows)))]
fn replacement_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Windows-style replacement destination already exists",
        ));
    }
    std::fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("zuuli-cleanup-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wallet() -> WalletEntry {
        let id = uuid::Uuid::new_v4().to_string();
        WalletEntry {
            id: id.clone(),
            name: "test".into(),
            db_filename: format!("wallet_{id}.sqlite"),
            birthday_height: Some(1),
            created_at: "2026-08-06T00:00:00Z".into(),
        }
    }

    fn empty_manifest() -> WalletManifest {
        WalletManifest {
            wallets: Vec::new(),
            active_wallet_id: None,
        }
    }

    #[test]
    fn rollback_journal_retries_every_partial_failure_stage() {
        for failed_stage in ALL_STAGES {
            let dir = TestDir::new("partial-stage");
            let entry = wallet();
            schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
            let mut failed_once = false;
            let report =
                retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Runtime, |_, stage| {
                    if stage == failed_stage && !failed_once {
                        failed_once = true;
                        Err("injected stage failure".into())
                    } else {
                        Ok(())
                    }
                })
                .unwrap();
            assert_eq!(report.pending_operations, 1, "stage {failed_stage:?}");
            assert_eq!(report.pending_stages, 1, "stage {failed_stage:?}");

            let mut retried = Vec::new();
            let report =
                retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Runtime, |_, stage| {
                    retried.push(stage);
                    Ok(())
                })
                .unwrap();
            assert_eq!(retried, vec![failed_stage]);
            assert_eq!(report.pending_operations, 0);
        }
    }

    #[test]
    fn crash_after_every_external_stage_preserves_retry_authority() {
        for crash_stage in ALL_STAGES {
            let dir = TestDir::new("crash-stage");
            let entry = wallet();
            schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
            let mut externally_completed = HashSet::new();
            let crashed = catch_unwind(AssertUnwindSafe(|| {
                let _ = retry_pending_with(
                    &dir.0,
                    &empty_manifest(),
                    RetryMode::Runtime,
                    |_, stage| {
                        externally_completed.insert(stage);
                        if stage == crash_stage {
                            panic!("injected crash after external cleanup");
                        }
                        Ok(())
                    },
                );
            }));
            assert!(crashed.is_err());
            assert!(externally_completed.contains(&crash_stage));
            assert!(
                load(&dir.0).unwrap().operations[0]
                    .remaining
                    .contains(&crash_stage),
                "stage remains authorized across crash: {crash_stage:?}"
            );

            let report =
                retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Runtime, |_, _| Ok(()))
                    .unwrap();
            assert_eq!(report.pending_operations, 0);
        }
    }

    #[test]
    fn uncertain_deletion_waits_at_runtime_and_startup_promotes_it_durably() {
        let dir = TestDir::new("uncertain-delete");
        let entry = wallet();
        schedule_wallet_deletion(&dir.0, &entry).unwrap();
        let mut calls = 0;
        let runtime = retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Runtime, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 0);
        assert_eq!(runtime.blocked_operations, 1);

        let startup = retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Startup, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, ALL_STAGES.len());
        assert_eq!(startup.pending_operations, 0);
    }

    #[test]
    fn startup_filesystem_pass_defers_every_custody_backend() {
        let dir = TestDir::new("deferred-custody");
        let entry = wallet();
        let authorization = schedule_wallet_deletion(&dir.0, &entry).unwrap();
        authorize_wallet_deletion(&dir.0, &authorization).unwrap();
        let mut first_pass = Vec::new();
        let report = retry_pending_with_scope(
            &dir.0,
            &empty_manifest(),
            RetryMode::Startup,
            RetryScope::FilesystemOnly,
            |_, stage| {
                first_pass.push(stage);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            first_pass,
            vec![
                CleanupStage::Database,
                CleanupStage::DatabaseWal,
                CleanupStage::DatabaseShm,
                CleanupStage::DatabaseRollbackJournal,
                CleanupStage::PendingSendJournal,
            ]
        );
        assert_eq!(report.pending_operations, 1);
        assert_eq!(report.pending_stages, 3);

        let mut deferred = Vec::new();
        let report = retry_pending_with(
            &dir.0,
            &empty_manifest(),
            RetryMode::Runtime,
            |_, stage| {
                deferred.push(stage);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            deferred,
            vec![
                CleanupStage::LegacyFileCustody,
                CleanupStage::LegacyKeyringCustody,
                CleanupStage::NativeCustody,
            ]
        );
        assert_eq!(report.pending_operations, 0);
    }

    #[test]
    fn exact_active_generation_waits_if_uncertain_then_startup_cancels_without_cleanup() {
        let dir = TestDir::new("active-cancel");
        let entry = wallet();
        schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        let manifest = WalletManifest {
            wallets: vec![entry.clone()],
            active_wallet_id: Some(entry.id),
        };
        let runtime = retry_pending_with(&dir.0, &manifest, RetryMode::Runtime, |_, _| {
            panic!("active generation must never be cleaned")
        })
        .unwrap();
        assert_eq!(runtime.pending_operations, 1);
        assert_eq!(runtime.blocked_operations, 1);

        let report = retry_pending_with(&dir.0, &manifest, RetryMode::Startup, |_, _| {
            panic!("active generation must never be cleaned")
        })
        .unwrap();
        assert_eq!(report.pending_operations, 0);
    }

    #[test]
    fn durably_confirmed_active_generation_cancels_at_runtime() {
        let dir = TestDir::new("confirmed-active-cancel");
        let entry = wallet();
        let authorization = schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        confirm_staged_wallet_commit(&dir.0, &authorization).unwrap();
        let manifest = WalletManifest {
            wallets: vec![entry.clone()],
            active_wallet_id: Some(entry.id),
        };
        let report = retry_pending_with(&dir.0, &manifest, RetryMode::Runtime, |_, _| {
            panic!("active generation must never be cleaned")
        })
        .unwrap();
        assert_eq!(report.pending_operations, 0);
    }

    #[test]
    fn published_uncertain_wallet_never_destroys_database_or_custody_if_manifest_is_lost() {
        let dir = TestDir::new("published-uncertain");
        let entry = wallet();
        let authorization = schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        protect_staged_wallet_custody(&dir.0, &authorization).unwrap();

        let mut executed = Vec::new();
        let report = retry_pending_with(
            &dir.0,
            &empty_manifest(),
            RetryMode::Startup,
            |_, stage| {
                executed.push(stage);
                Ok(())
            },
        )
        .unwrap();
        assert!(executed.is_empty());
        assert_eq!(report.pending_operations, 1);
        assert_eq!(report.blocked_operations, 1);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains("preserved its published database"))
        );
    }

    #[test]
    fn startup_restores_a_published_wallet_before_cancelling_rollback() {
        let dir = TestDir::new("published-recovery");
        let entry = wallet();
        let authorization = schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        protect_staged_wallet_custody(&dir.0, &authorization).unwrap();
        let mut manifest = empty_manifest();

        let diagnostics = recover_published_wallets(&dir.0, &mut manifest).unwrap();
        assert_eq!(manifest.wallets.len(), 1);
        assert_eq!(manifest.wallets[0].id, entry.id);
        assert_eq!(manifest.wallets[0].created_at, entry.created_at);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains("restored published wallet"))
        );

        let report = retry_pending_with(&dir.0, &manifest, RetryMode::Startup, |_, _| {
            panic!("a restored manifest generation must never be cleaned")
        })
        .unwrap();
        assert_eq!(report.pending_operations, 0);
    }

    #[test]
    fn unpublished_wallet_rearms_every_custody_stage_after_manifest_failure() {
        let dir = TestDir::new("unpublished-rearm");
        let entry = wallet();
        let authorization = schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        protect_staged_wallet_custody(&dir.0, &authorization).unwrap();
        rearm_staged_wallet_custody_cleanup(&dir.0, &authorization).unwrap();

        let mut executed = Vec::new();
        let report = retry_pending_with(
            &dir.0,
            &empty_manifest(),
            RetryMode::Runtime,
            |_, stage| {
                executed.push(stage);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(executed, ALL_STAGES);
        assert_eq!(report.pending_operations, 0);
    }

    #[test]
    fn stale_generation_and_reused_database_are_blocked() {
        for reuse_database in [false, true] {
            let dir = TestDir::new("identity-conflict");
            let original = wallet();
            schedule_staged_wallet_rollback(&dir.0, &original).unwrap();
            let mut reintroduced = wallet();
            if reuse_database {
                reintroduced.db_filename = original.db_filename.clone();
            } else {
                reintroduced.id = original.id.clone();
                reintroduced.created_at = "different-generation".into();
            }
            let manifest = WalletManifest {
                active_wallet_id: Some(reintroduced.id.clone()),
                wallets: vec![reintroduced],
            };
            let report = retry_pending_with(&dir.0, &manifest, RetryMode::Startup, |_, _| {
                panic!("reintroduced identity must never be cleaned")
            })
            .unwrap();
            assert_eq!(report.pending_operations, 1);
            assert_eq!(report.blocked_operations, 1);
        }
    }

    #[test]
    fn nonregular_database_target_fails_closed_and_remains_pending() {
        let dir = TestDir::new("nonregular-db");
        let entry = wallet();
        std::fs::create_dir(dir.0.join(&entry.db_filename)).unwrap();
        let authorization = schedule_wallet_deletion(&dir.0, &entry).unwrap();
        authorize_wallet_deletion(&dir.0, &authorization).unwrap();
        let report = retry_pending_with(
            &dir.0,
            &empty_manifest(),
            RetryMode::Runtime,
            |operation, stage| {
                if stage == CleanupStage::Database {
                    remove_regular_file(&dir.0.join(&operation.db_filename))
                        .map_err(|error| error.to_string())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(report.pending_operations, 1);
        assert_eq!(report.pending_stages, 1);
        assert!(dir.0.join(entry.db_filename).is_dir());
    }

    #[test]
    fn corrupt_or_nonregular_journal_never_authorizes_cleanup() {
        for as_directory in [false, true] {
            let dir = TestDir::new("corrupt-journal");
            let path = journal_path(&dir.0);
            if as_directory {
                std::fs::create_dir(path).unwrap();
            } else {
                std::fs::write(path, b"not json").unwrap();
            }
            assert!(
                retry_pending_with(&dir.0, &empty_manifest(), RetryMode::Startup, |_, _| {
                    panic!("invalid journal must not authorize cleanup")
                })
                .is_err()
            );
        }
    }

    #[test]
    fn interrupted_windows_replacement_recovers_complete_journal() {
        let dir = TestDir::new("backup-recovery");
        let entry = wallet();
        schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        let path = journal_path(&dir.0);
        let backup = journal_backup_path(&dir.0);
        std::fs::rename(&path, &backup).unwrap();
        recover_backup(&path, &backup).unwrap();
        assert_eq!(load(&dir.0).unwrap().operations.len(), 1);
    }

    #[test]
    fn windows_style_replacement_installs_complete_new_journal() {
        let dir = TestDir::new("backup-replacement");
        let entry = wallet();
        schedule_staged_wallet_rollback(&dir.0, &entry).unwrap();
        let path = journal_path(&dir.0);
        let backup = journal_backup_path(&dir.0);
        let temp = dir.0.join("replacement.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(&CleanupJournal::default()).unwrap(),
        )
        .unwrap();

        replace_with_backup(&temp, &path, &backup).unwrap();
        assert!(load(&dir.0).unwrap().operations.is_empty());
        assert!(!backup.exists());
    }
}
