use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCreated {
    pub wallet_id: String,
    pub birthday_height: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveDisplayLease {
    pub token: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SensitiveDisplayState {
    pub token: String,
    pub wallet_id: String,
    pub consumed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndSensitiveDisplayArgs {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveSeedArgs {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveBackupSeedArgs {
    pub wallet_id: String,
    pub token: String,
}

/// Result of atomically restoring and publishing a wallet.
///
/// `wallet_id` identifies the exact manifest entry committed by the native
/// transition. Callers must bind any follow-up identity operation to this ID
/// rather than re-reading whichever wallet happens to be active later.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WalletRestored {
    pub success: bool,
    pub wallet_id: String,
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
    fn wallet_creation_response_never_serializes_recovery_material() {
        let value = serde_json::to_value(WalletCreated {
            wallet_id: "wallet-new-123".to_owned(),
            birthday_height: 3_000_000,
        })
        .expect("serialize creation result");

        assert_eq!(value["walletId"], "wallet-new-123");
        assert_eq!(value["birthdayHeight"], 3_000_000);
        assert_eq!(value.as_object().expect("object").len(), 2);
        assert!(value.get("seedPhrase").is_none());
    }

    #[test]
    fn spending_key_status_never_serializes_secret_material() {
        let value = serde_json::to_value(SpendingKeyStatus {
            account_index: 0,
            available: true,
            message: "Spending authority verified.".to_owned(),
        })
        .expect("serialize spending authority status");

        assert_eq!(value.as_object().expect("object").len(), 3);
        assert_eq!(value["accountIndex"], 0);
        assert_eq!(value["available"], true);
        assert_eq!(value["message"], "Spending authority verified.");
        assert!(value.get("spendingKey").is_none());
        assert!(value.get("seedPhrase").is_none());
    }

    #[test]
    fn restored_wallet_result_binds_the_exact_manifest_identity() {
        let value = serde_json::to_value(WalletRestored {
            success: true,
            wallet_id: "wallet-restored-123".to_owned(),
        })
        .expect("serialize restore result");

        assert_eq!(value["success"], true);
        assert_eq!(value["walletId"], "wallet-restored-123");
        assert_eq!(value.as_object().expect("object").len(), 2);
    }

    #[test]
    fn restore_arguments_redact_recovery_material_from_debug_output() {
        let private_input = "private recovery material";
        let debug = format!(
            "{:?}",
            RestoreWalletArgs {
                seed_phrase: private_input.to_owned(),
                birthday_height: Some(2_600_000),
                name: Some("Recovered identity".to_owned()),
            }
        );

        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(private_input));
    }

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWalletArgs {
    pub seed_phrase: String,
    pub birthday_height: Option<u64>,
    pub name: Option<String>,
}

impl std::fmt::Debug for RestoreWalletArgs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RestoreWalletArgs")
            .field("seed_phrase", &"[REDACTED]")
            .field("birthday_height", &self.birthday_height)
            .field("name", &self.name)
            .finish()
    }
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

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendPaymentReview {
    pub recipient: String,
    pub amount: u64,
    pub memo: Option<String>,
}

// Deliberately omit `Debug`: an encrypted memo is still private plaintext in
// the review process and must not become convenient log material.
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendReview {
    pub version: u32,
    pub network: String,
    pub payments: Vec<SendPaymentReview>,
    pub fee_policy: String,
    pub fee: u64,
    pub total: u64,
    pub change_policy: String,
}

// Deliberately omit `Debug`: the opaque confirmation token must never reach a
// log through routine value formatting.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendProposal {
    pub proposal_id: u32,
    pub review: SendReview,
    pub review_digest: String,
    pub confirmation_token: String,
}

/// Result of broadcasting a locally-created transaction.
///
/// `Unknown` is deliberately distinct from failure: once a transaction has
/// been created, a transport error may mean the server accepted it but the
/// response was lost. `retry_pending_send` rebroadcasts the exact same bytes
/// instead of creating a second transaction. The reviewed confirmation is
/// one-use and cannot be replayed as the retry path.
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

// Deliberately omit `Debug`: confirmation credentials must not be loggable.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSendArgs {
    pub proposal_id: u32,
    pub review_digest: String,
    pub confirmation_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardSendProposalArgs {
    pub proposal_id: u32,
    pub review_digest: String,
    pub confirmation_token: String,
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
