export interface WalletCreated {
  seedPhrase: string;
  birthdayHeight: number;
}

export interface WalletStatus {
  initialized: boolean;
  hasSeed: boolean;
  syncedHeight: number | null;
  chainTip: number | null;
  activeWalletId: string | null;
  activeWalletName: string | null;
  walletCount: number;
  cleanup: WalletCleanupStatus;
  legacyAppData: LegacyAppDataStatus;
}

export interface LegacyAppDataStatus {
  state: "none" | "importPending";
  legacyIdentifier: string | null;
  diagnostic: string | null;
}

export interface WalletCleanupStatus {
  pendingOperations: number;
  blockedOperations: number;
  pendingStages: number;
  completedStages: number;
  diagnostics: string[];
}

export interface WalletInfo {
  id: string;
  name: string;
  isActive: boolean;
  birthdayHeight: number | null;
  createdAt: string;
}

export interface AccountInfo {
  accountIndex: number;
  name: string | null;
  unifiedAddress: string;
}

export interface AccountBalance {
  accountIndex: number;
  totalShielded: number;
  spendable: number;
  changePending: number;
  valuePending: number;
}

export interface SyncStatus {
  syncing: boolean;
  syncedHeight: number;
  chainTip: number;
  progressPercent: number;
}

export interface TransactionEntry {
  txid: string;
  blockHeight: number | null;
  timestamp: number | null;
  value: number;
  memo: string | null;
  incoming: boolean;
}

export interface PaymentRequest {
  address: string;
  amount: number | null;
  memo: string | null;
  label: string | null;
}

export interface SpendingKeyStatus {
  accountIndex: number;
  available: boolean;
  message: string;
}

export interface AddressValidation {
  valid: boolean;
  addressType: string | null;
  canReceiveMemo: boolean;
  error?: string | null;
}

export interface SaplingParamsStatus {
  ready: boolean;
}

export interface SendProposal {
  proposalId: number;
  review: SendReview;
  reviewDigest: string;
  confirmationToken: string;
}

export interface SendPaymentReview {
  recipient: string;
  amount: number;
  memo: string | null;
}

export interface SendReview {
  version: number;
  network: string;
  payments: SendPaymentReview[];
  feePolicy: string;
  fee: number;
  total: number;
  changePolicy: string;
}

export type BroadcastStatus = "accepted" | "rejected" | "unknown";

export interface ExecuteSendResult {
  txid: string;
  status: BroadcastStatus;
  message: string | null;
}

export interface PendingSendStatus extends ExecuteSendResult {
  proposalId: number;
  recoveryRequired: boolean;
  canDiscard: boolean;
}

export interface TransactionHistoryState {
  transactions: TransactionEntry[];
  lastFetched: number | null;
}

export type Page =
  | "welcome"
  | "create"
  | "restore"
  | "home"
  | "send"
  | "receive"
  | "history"
  | "settings"
  | "wallet-picker";
