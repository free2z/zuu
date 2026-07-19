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
  PaymentRequest,
  SendProposal,
  SignedChallenge,
  SyncStatus,
  TransactionEntry,
  WalletCreated,
  WalletStatus,
} from "./types";

// Lazily import the Tauri API only when running under Tauri, so the browser
// bundle never requires it.
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(`plugin:zcash|${cmd}`, args);
}

export const wallet = {
  async createWallet(mnemonicWordCount = 24, name?: string): Promise<WalletCreated> {
    if (useMock()) return mockWallet.createWallet();
    return invoke("create_wallet", { args: { mnemonicWordCount, name } });
  },

  async restoreWallet(
    seedPhrase: string,
    birthdayHeight?: number,
    name?: string,
  ): Promise<{ success: boolean }> {
    if (useMock()) return mockWallet.restoreWallet();
    return invoke("restore_wallet", { args: { seedPhrase, birthdayHeight, name } });
  },

  async getWalletStatus(): Promise<WalletStatus> {
    if (useMock()) return mockWallet.getWalletStatus();
    return invoke("get_wallet_status");
  },

  async getSeedPhrase(): Promise<string> {
    if (useMock()) return mockWallet.getSeedPhrase();
    return invoke("get_seed_phrase");
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
    return invoke("get_transaction_history", { args: { accountIndex, offset, limit } });
  },

  async validateAddress(address: string): Promise<AddressValidation> {
    if (useMock()) return mockWallet.validateAddress(address);
    return invoke("validate_address", { args: { address } });
  },

  async parsePaymentUri(uri: string): Promise<PaymentRequest> {
    if (useMock()) return mockWallet.parsePaymentUri(uri);
    return invoke("parse_payment_uri", { args: { uri } });
  },

  async proposeSend(to: string, amount: number, memo?: string): Promise<SendProposal> {
    if (useMock()) return mockWallet.proposeSend(to, amount);
    return invoke("propose_send", { args: { to, amount, memo } });
  },

  async executeSend(proposalId: number): Promise<string> {
    if (useMock()) return mockWallet.executeSend();
    return invoke("execute_send", { args: { proposalId } });
  },

  /**
   * Sign a login challenge with the wallet key (ZIP-304 style). In Tauri this
   * routes to the plugin's signing command; in mock mode it returns a
   * believable signature so the login flow completes end-to-end.
   */
  async signChallenge(challenge: string, accountIndex = 0): Promise<SignedChallenge> {
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
