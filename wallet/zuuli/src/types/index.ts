export interface WalletCreated {
  seedPhrase: string;
  birthdayHeight: number;
}

export interface WalletStatus {
  initialized: boolean;
  syncedHeight: number | null;
  chainTip: number | null;
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
  | "settings";
