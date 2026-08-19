use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCreated {
    pub wallet_id: String,
    pub seed_phrase: String,
    pub birthday_height: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    pub initialized: bool,
    pub has_seed: bool,
    pub synced_height: Option<u64>,
    pub chain_tip: Option<u64>,
    pub active_wallet_id: Option<String>,
    pub active_wallet_name: Option<String>,
    pub wallet_count: u32,
    pub backup_required: bool,
    /// Durable orphan cleanup state. This is additive so older frontends can
    /// ignore it while operators still receive startup diagnostics.
    #[serde(default)]
    pub cleanup: WalletCleanupStatus,
    /// Identifier-cutover state. A pending import is deliberately separate
    /// from destructive cleanup: both wallet trees remain untouched until the
    /// user invokes a future explicit importer.
    #[serde(default)]
    pub legacy_app_data: LegacyAppDataStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAppDataStatus {
    pub state: LegacyAppDataState,
    pub legacy_identifier: Option<String>,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LegacyAppDataState {
    #[default]
    None,
    ImportPending,
}

impl From<crate::app_data_migration::MigrationOutcome> for LegacyAppDataStatus {
    fn from(outcome: crate::app_data_migration::MigrationOutcome) -> Self {
        if outcome == crate::app_data_migration::MigrationOutcome::LegacyImportPending {
            Self {
                state: LegacyAppDataState::ImportPending,
                legacy_identifier: Some("com.2zinc.zuuli".to_owned()),
                diagnostic: Some(
                    "An earlier ZUULI wallet is safely preserved. The current canonical wallet was opened; no wallet data or seed custody was merged, moved, or deleted. Explicit legacy-wallet import is pending."
                        .to_owned(),
                ),
            }
        } else {
            Self::default()
        }
    }
}

#[cfg(test)]
mod legacy_app_data_tests {
    use super::*;

    #[test]
    fn preserved_conflict_serializes_as_structured_import_pending_status() {
        let status = LegacyAppDataStatus::from(
            crate::app_data_migration::MigrationOutcome::LegacyImportPending,
        );
        let value = serde_json::to_value(status).expect("serialize migration status");

        assert_eq!(value["state"], "importPending");
        assert_eq!(value["legacyIdentifier"], "com.2zinc.zuuli");
        assert!(
            value["diagnostic"]
                .as_str()
                .is_some_and(|message| message.contains("no wallet data or seed custody"))
        );
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WalletCleanupStatus {
    pub pending_operations: u32,
    pub blocked_operations: u32,
    pub pending_stages: u32,
    pub completed_stages: u32,
    pub diagnostics: Vec<String>,
}

impl From<crate::wallet::cleanup::CleanupReport> for WalletCleanupStatus {
    fn from(report: crate::wallet::cleanup::CleanupReport) -> Self {
        Self {
            pending_operations: report.pending_operations,
            blocked_operations: report.blocked_operations,
            pending_stages: report.pending_stages,
            completed_stages: report.completed_stages,
            diagnostics: report.diagnostics,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub birthday_height: Option<u64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub account_index: u32,
    pub name: Option<String>,
    pub unified_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub account_index: u32,
    pub total_shielded: u64,
    pub spendable: u64,
    pub change_pending: u64,
    pub value_pending: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub syncing: bool,
    pub synced_height: u64,
    pub chain_tip: u64,
    pub progress_percent: f32,
    /// Most recent sync error surfaced to the UI, or `None` when the last pass
    /// succeeded. This is **additive/optional**: consumers that predate the
    /// field (e.g. zuuallet) simply ignore it, so adding it does not break them.
    /// Serializes to `lastError` (camelCase); `#[serde(default)]` keeps
    /// deserialization tolerant of payloads that omit it.
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionEntry {
    pub txid: String,
    pub block_height: Option<u64>,
    pub timestamp: Option<i64>,
    pub value: i64,
    pub memo: Option<String>,
    pub incoming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequest {
    pub address: String,
    pub amount: Option<u64>,
    pub memo: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingKeyStatus {
    pub account_index: u32,
    pub available: bool,
    pub message: String,
}

// Command argument types

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWalletArgs {
    pub mnemonic_word_count: Option<u32>,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWalletArgs {
    pub seed_phrase: String,
    pub birthday_height: Option<u64>,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmWalletBackupArgs {
    pub wallet_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdArgs {
    pub account_index: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaplingParamsStatus {
    pub ready: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeSendArgs {
    pub to: String,
    pub amount: u64,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendProposal {
    pub proposal_id: u32,
    pub amount: u64,
    pub fee: u64,
    pub total: u64,
}

/// Result of broadcasting a locally-created transaction.
///
/// `Unknown` is deliberately distinct from failure: once a transaction has
/// been created, a transport error may mean the server accepted it but the
/// response was lost. Callers may retry the same `proposal_id`; the plugin
/// will rebroadcast the exact same transaction bytes instead of creating a
/// second transaction.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BroadcastStatus {
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSendResult {
    pub txid: String,
    pub status: BroadcastStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSendStatus {
    pub proposal_id: u32,
    pub txid: String,
    pub status: BroadcastStatus,
    pub message: Option<String>,
    pub recovery_required: bool,
    pub can_discard: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardUnrecoverableSendArgs {
    pub proposal_id: u32,
    pub confirmation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeSendAllArgs {
    pub to: String,
    pub memo: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSendArgs {
    pub proposal_id: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionHistoryArgs {
    pub account_index: u32,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLightwalletdUrlArgs {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsePaymentUriArgs {
    pub uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWalletArgs {
    pub wallet_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWalletArgs {
    pub wallet_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWalletArgs {
    pub wallet_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockWalletArgs {
    pub seed_phrase: String,
    pub wallet_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateAddressArgs {
    pub address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignChallengeArgs {
    pub challenge: String,
    pub account_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedChallenge {
    pub address: String,
    pub challenge: String,
    pub signature: String,
    pub pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressValidation {
    pub valid: bool,
    pub address_type: Option<String>,
    pub can_receive_memo: bool,
    #[serde(default)]
    pub error: Option<String>,
}
