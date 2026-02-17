import { invoke } from "@tauri-apps/api/core";
import type {
  WalletCreated,
  WalletStatus,
  WalletInfo,
  AccountInfo,
  AccountBalance,
  SyncStatus,
  TransactionEntry,
  PaymentRequest,
  SpendingKeyStatus,
  AddressValidation,
} from "../types";

export async function createWallet(
  mnemonicWordCount?: number,
  name?: string,
): Promise<WalletCreated> {
  return invoke("plugin:zcash|create_wallet", {
    args: { mnemonicWordCount: mnemonicWordCount ?? 24, name },
  });
}

export async function restoreWallet(
  seedPhrase: string,
  birthdayHeight?: number,
  name?: string,
): Promise<{ success: boolean }> {
  return invoke("plugin:zcash|restore_wallet", {
    args: { seedPhrase, birthdayHeight, name },
  });
}

export async function getWalletStatus(): Promise<WalletStatus> {
  return invoke("plugin:zcash|get_wallet_status");
}

export async function getSeedPhrase(): Promise<string> {
  return invoke("plugin:zcash|get_seed_phrase");
}

export async function getViewingKey(accountIndex: number): Promise<string> {
  return invoke("plugin:zcash|get_viewing_key", {
    args: { accountIndex },
  });
}

export async function getSpendingKey(
  accountIndex: number,
): Promise<SpendingKeyStatus> {
  return invoke("plugin:zcash|get_spending_key", {
    args: { accountIndex },
  });
}

export async function listWallets(): Promise<WalletInfo[]> {
  return invoke("plugin:zcash|list_wallets");
}

export async function switchWallet(walletId: string): Promise<void> {
  return invoke("plugin:zcash|switch_wallet", {
    args: { walletId },
  });
}

export async function renameWallet(
  walletId: string,
  name: string,
): Promise<void> {
  return invoke("plugin:zcash|rename_wallet", {
    args: { walletId, name },
  });
}

export async function deleteWallet(walletId: string): Promise<void> {
  return invoke("plugin:zcash|delete_wallet", {
    args: { walletId },
  });
}

export async function createAccount(): Promise<AccountInfo> {
  return invoke("plugin:zcash|create_account");
}

export async function listAccounts(): Promise<AccountInfo[]> {
  return invoke("plugin:zcash|list_accounts");
}

export async function getAccountBalance(
  accountIndex: number,
): Promise<AccountBalance> {
  return invoke("plugin:zcash|get_account_balance", {
    args: { accountIndex },
  });
}

export async function getUnifiedAddress(
  accountIndex: number,
): Promise<string> {
  return invoke("plugin:zcash|get_unified_address", {
    args: { accountIndex },
  });
}

export async function startSync(): Promise<void> {
  return invoke("plugin:zcash|start_sync");
}

export async function stopSync(): Promise<void> {
  return invoke("plugin:zcash|stop_sync");
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke("plugin:zcash|get_sync_status");
}

export async function sendTransaction(
  to: string,
  amount: number,
  memo?: string,
): Promise<string> {
  return invoke("plugin:zcash|send_transaction", {
    args: { to, amount, memo },
  });
}

export async function getTransactionHistory(
  accountIndex: number,
  offset?: number,
  limit?: number,
): Promise<TransactionEntry[]> {
  return invoke("plugin:zcash|get_transaction_history", {
    args: { accountIndex, offset, limit },
  });
}

export async function setLightwalletdUrl(url: string): Promise<void> {
  return invoke("plugin:zcash|set_lightwalletd_url", { args: { url } });
}

export async function parsePaymentUri(uri: string): Promise<PaymentRequest> {
  return invoke("plugin:zcash|parse_payment_uri", { args: { uri } });
}

export async function validateAddress(
  address: string,
): Promise<AddressValidation> {
  return invoke("plugin:zcash|validate_address", {
    args: { address },
  });
}

export async function unlockWallet(
  seedPhrase: string,
  walletId?: string,
): Promise<void> {
  return invoke("plugin:zcash|unlock_wallet", {
    args: { seedPhrase, walletId },
  });
}
