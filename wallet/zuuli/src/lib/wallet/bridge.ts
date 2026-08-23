// Wallet bridge — the ONLY place the frontend talks to the Zcash engine.
//
// In the Tauri desktop build these call the real `tauri-plugin-zcash` commands
// (librustzcash under the hood). In a plain browser they transparently fall
// back to an in-memory mock so the whole UI is demoable offline. Features must
// import from here, never call `invoke()` directly.

import { useMock } from "../platform";
import { mockWallet } from "./mock";
import type {
  AccountBalance,
  AccountInfo,
  AddressValidation,
  ExecuteSendResult,
  PaymentRequest,
  PendingSendStatus,
  SendProposal,
  SensitiveDisplayLease,
  SaplingParamsStatus,
  SignedChallenge,
  SyncStatus,
  TransactionEntry,
  WalletCreated,
  WalletRestored,
  WalletCleanupStatus,
  WalletStatus,
} from "./types";

// Lazily import the Tauri API only when running under Tauri, so the browser
// bundle never requires it.
async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(`plugin:zcash|${cmd}`, args);
}

export const wallet = {
  async createWallet(
    mnemonicWordCount = 24,
    name?: string,
  ): Promise<WalletCreated> {
    if (useMock()) return mockWallet.createWallet();
    return invoke("create_wallet", { args: { mnemonicWordCount, name } });
  },

  restoreWallet(
    seedPhrase: string,
    birthdayHeight?: number,
    name?: string,
  ): Promise<WalletRestored> {
    if (useMock()) {
      try {
        return Promise.resolve(mockWallet.restoreWallet(seedPhrase));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return invoke("restore_wallet", {
      args: { seedPhrase, birthdayHeight, name },
    });
  },

  async getWalletStatus(): Promise<WalletStatus> {
    if (useMock()) return mockWallet.getWalletStatus();
    return invoke("get_wallet_status");
  },

  async retryWalletCleanup(): Promise<WalletCleanupStatus> {
    if (useMock()) return mockWallet.retryWalletCleanup();
    return invoke("retry_wallet_cleanup");
  },

  async getSeedPhrase(token: string): Promise<string> {
    if (useMock()) return mockWallet.getSeedPhrase(token);
    return invoke("get_seed_phrase", { args: { token } });
  },

  async getBackupSeedPhrase(walletId: string, token: string): Promise<string> {
    if (useMock()) return mockWallet.getBackupSeedPhrase(walletId, token);
    return invoke("get_backup_seed_phrase", { args: { walletId, token } });
  },

  async beginSensitiveDisplay(): Promise<SensitiveDisplayLease> {
    if (useMock()) return mockWallet.beginSensitiveDisplay();
    return invoke("begin_sensitive_display");
  },

  async endSensitiveDisplay(token: string): Promise<void> {
    if (useMock()) return mockWallet.endSensitiveDisplay(token);
    return invoke("end_sensitive_display", { args: { token } });
  },

  async confirmWalletBackup(walletId: string): Promise<void> {
    if (useMock()) return mockWallet.confirmWalletBackup(walletId);
    return invoke("confirm_wallet_backup", { args: { walletId } });
  },

  async listAccounts(): Promise<AccountInfo[]> {
    if (useMock()) return mockWallet.listAccounts();
    return invoke("list_accounts");
  },

  async getAccountBalance(accountIndex = 0): Promise<AccountBalance> {
    if (useMock()) return mockWallet.getAccountBalance();
    return invoke("get_account_balance", { args: { accountIndex } });
  },

  async getUnifiedAddress(accountIndex = 0): Promise<string> {
    if (useMock()) return mockWallet.getUnifiedAddress();
    return invoke("get_unified_address", { args: { accountIndex } });
  },

  async startSync(): Promise<void> {
    if (useMock()) return mockWallet.startSync();
    return invoke("start_sync");
  },

  async stopSync(): Promise<void> {
    if (useMock()) return mockWallet.stopSync();
    return invoke("stop_sync");
  },

  async getSyncStatus(): Promise<SyncStatus> {
    if (useMock()) return mockWallet.getSyncStatus();
    return invoke("get_sync_status");
  },

  async getTransactionHistory(
    accountIndex = 0,
    offset?: number,
    limit?: number,
  ): Promise<TransactionEntry[]> {
    if (useMock()) return mockWallet.getTransactionHistory();
    return invoke("get_transaction_history", {
      args: { accountIndex, offset, limit },
    });
  },

  async validateAddress(address: string): Promise<AddressValidation> {
    if (useMock()) return mockWallet.validateAddress(address);
    return invoke("validate_address", { args: { address } });
  },

  async parsePaymentUri(uri: string): Promise<PaymentRequest> {
    if (useMock()) return mockWallet.parsePaymentUri(uri);
    return invoke("parse_payment_uri", { args: { uri } });
  },

  async proposeSend(
    to: string,
    amount: number,
    memo?: string,
  ): Promise<SendProposal> {
    if (useMock()) return mockWallet.proposeSend(to, amount, memo);
    return invoke("propose_send", { args: { to, amount, memo } });
  },

  async ensureSaplingParams(): Promise<SaplingParamsStatus> {
    if (useMock()) return mockWallet.ensureSaplingParams();
    return invoke("ensure_sapling_params");
  },

  async executeSend(
    proposalId: number,
    reviewDigest: string,
    confirmationToken: string,
  ): Promise<ExecuteSendResult> {
    if (useMock())
      return mockWallet.executeSend(
        proposalId,
        reviewDigest,
        confirmationToken,
      );
    return invoke("execute_send", {
      args: { proposalId, reviewDigest, confirmationToken },
    });
  },

  async discardSendProposal(
    proposalId: number,
    reviewDigest: string,
    confirmationToken: string,
  ): Promise<void> {
    if (useMock()) {
      return mockWallet.discardSendProposal(
        proposalId,
        reviewDigest,
        confirmationToken,
      );
    }
    return invoke("discard_send_proposal", {
      args: { proposalId, reviewDigest, confirmationToken },
    });
  },

  async getPendingSend(): Promise<PendingSendStatus | null> {
    if (useMock()) return mockWallet.getPendingSend();
    return invoke("get_pending_send");
  },

  async retryPendingSend(): Promise<ExecuteSendResult> {
    if (useMock()) return mockWallet.retryPendingSend();
    return invoke("retry_pending_send");
  },

  async discardUnrecoverableSend(proposalId: number): Promise<void> {
    if (useMock()) return mockWallet.discardUnrecoverableSend();
    return invoke("discard_unrecoverable_send", {
      args: { proposalId, confirmation: "I CHECKED WALLET HISTORY" },
    });
  },

  /**
   * Sign a login challenge with the wallet key (ZIP-304 style). In Tauri this
   * routes to the plugin's signing command; in mock mode it returns a
   * believable signature so the login flow completes end-to-end.
   */
  async signChallenge(
    challenge: string,
    accountIndex = 0,
  ): Promise<SignedChallenge> {
    if (useMock()) return mockWallet.signChallenge(challenge);
    return invoke("sign_challenge", { args: { challenge, accountIndex } });
  },

  /**
   * The account's Login-with-Zcash identity: the transparent P2PKH t-address
   * the plugin signs challenges with and free2z verifies via zcashd
   * `verifymessage`. The plugin exposes this address only as a side effect of
   * signing, so we derive it by signing a local probe that is NEVER
   * transmitted. Callers MUST request the server challenge for exactly this
   * address — the returned value equals `signChallenge().address`, so the
   * challenge the server issues is keyed to the same address the login POST
   * carries.
   */
  async getLoginAddress(accountIndex = 0): Promise<string> {
    const probe = await wallet.signChallenge(
      "ZUULI-Login:identity-probe",
      accountIndex,
    );
    return probe.address;
  },
};
