// Wallet domain types — mirror the serde models exposed by
// tauri-plugin-zcash (see wallet/plugins/tauri-plugin-zcash). Field names are
// camelCase on both sides.

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
  value: number; // signed zatoshis
  memo: string | null;
  incoming: boolean;
}

export interface PaymentRequest {
  address: string;
  amount: number | null;
  memo: string | null;
  label: string | null;
}

export interface AddressValidation {
  valid: boolean;
  addressType: string | null;
  canReceiveMemo: boolean;
}

export interface SendProposal {
  proposalId: number;
  amount: number;
  fee: number;
  total: number;
}

/**
 * Result of signing a login challenge with the wallet's key. `address` is the
 * account's transparent P2PKH address (the identity subject); `signature` is a
 * base64 compact secp256k1 ECDSA sig; `pubkey` is the compressed pubkey (hex)
 * the server uses to verify the signature and bind it to `address`.
 */
export interface SignedChallenge {
  address: string;
  challenge: string;
  signature: string;
  pubkey?: string;
}
