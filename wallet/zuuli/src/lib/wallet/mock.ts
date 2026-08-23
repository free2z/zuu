// A self-contained in-memory mock wallet so ZUULI's UI runs (and screenshots)
// in a plain browser with no Rust backend and no chain sync. Balances, history
// and sync progress are believable and animate over time.

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
  WalletRestored,
  WalletStatus,
} from "./types";
import { parseZecToZatoshis } from "../format";

const MOCK_UA =
  "u1l8xunezsvpntq2snz67h6md2eq09u09vv3xh6z8kqvxg7pdvz4qc9x2u84kqmpc0mz0kmvexz";

const MOCK_SEED =
  "wisdom shadow orchard zebra pledge notice frost violet render " +
  "summer harvest mirror canyon velvet ranch fossil pupil sunset " +
  "quantum ledger prosper anchor beyond zephyr";

let created = true;
let tip = 2_612_004;
let synced = 2_612_004;
let syncing = false;
let sensitiveDisplayToken: string | null = null;

function requireSensitiveDisplay(token: string): void {
  if (!token || token !== sensitiveDisplayToken) {
    throw new Error("sensitive-display lease is missing or stale");
  }
  sensitiveDisplayToken = null;
}

/**
 * Browser-only scenarios for exercising states that otherwise require a
 * freshly installed device or a native wallet failure. Kept behind the mock
 * wallet boundary so production/native behavior cannot observe them.
 */
const MOCK_WALLET_SCENARIO_KEY = "zuuli.mock.wallet-scenario";
const MOCK_CREATED_WALLET_KEY = "zuuli.mock.created-wallet";
const MOCK_BACKUP_REQUIRED_KEY = "zuuli.mock.backup-required";
const MOCK_WALLET_ID = "mock-wallet-0";
function mockWalletScenario():
  | "empty"
  | "sign-error"
  | "identity-switch"
  | "wallet-switch"
  | "slow-restore"
  | "slow-restore-error"
  | null {
  try {
    const value = globalThis.localStorage?.getItem(MOCK_WALLET_SCENARIO_KEY);
    return value === "empty" ||
      value === "sign-error" ||
      value === "identity-switch" ||
      value === "wallet-switch" ||
      value === "slow-restore" ||
      value === "slow-restore-error"
      ? value
      : null;
  } catch {
    return null;
  }
}

const balance: AccountBalance = {
  accountIndex: 0,
  totalShielded: 137_400_000, // 1.374 ZEC
  spendable: 129_900_000,
  changePending: 0,
  valuePending: 7_500_000,
};

const history: TransactionEntry[] = [
  {
    txid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    blockHeight: 2_611_980,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    value: 50_000_000,
    memo: "Welcome to ZUULI 🎉 — this first note carries a memo long enough to prove a transaction row wraps instead of clipping it.",
    incoming: true,
  },
  {
    txid: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    blockHeight: 2_611_500,
    timestamp: Math.floor(Date.now() / 1000) - 86400,
    value: -12_000_000,
    memo: "Bought 2Zs — top-up settled against the shielded pool",
    incoming: false,
  },
  {
    txid: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4",
    blockHeight: 2_610_100,
    timestamp: Math.floor(Date.now() / 1000) - 3 * 86400,
    value: 100_000_000,
    memo: null,
    incoming: true,
  },
];

let proposalCounter = 1;
let pendingProposal: SendProposal | null = null;

function mockProposalDelay(): number {
  try {
    const value = Number(
      globalThis.localStorage?.getItem("zuuli.mock.send-proposal-delay-ms"),
    );
    return Number.isFinite(value) && value > 0 ? Math.min(value, 5_000) : 0;
  } catch {
    return 0;
  }
}

function proposalCredential(counter: number, marker: string): string {
  return `${counter.toString(16).padStart(8, "0")}${marker.repeat(56)}`;
}

export const mockWallet = {
  getWalletStatus(): WalletStatus {
    const persistedCreated =
      globalThis.localStorage?.getItem(MOCK_CREATED_WALLET_KEY) === "1";
    const scenario = mockWalletScenario();
    const needsRestore = [
      "empty",
      "identity-switch",
      "wallet-switch",
      "slow-restore",
      "slow-restore-error",
    ].includes(scenario ?? "");
    const initialized =
      needsRestore && !persistedCreated ? false : created || persistedCreated;
    return {
      initialized,
      hasSeed: initialized,
      syncedHeight: synced,
      chainTip: tip,
      activeWalletId:
        initialized && scenario === "wallet-switch"
          ? "mock-wallet-switched-after-restore"
          : initialized
            ? MOCK_WALLET_ID
            : null,
      activeWalletName: "Main",
      walletCount: 1,
      backupRequired:
        initialized &&
        globalThis.localStorage?.getItem(MOCK_BACKUP_REQUIRED_KEY) ===
          MOCK_WALLET_ID,
      cleanup: {
        pendingOperations: 0,
        blockedOperations: 0,
        pendingStages: 0,
        completedStages: 0,
        diagnostics: [],
      },
      legacyAppData: {
        state: "none",
        legacyIdentifier: null,
        diagnostic: null,
      },
    };
  },
  retryWalletCleanup() {
    return {
      pendingOperations: 0,
      blockedOperations: 0,
      pendingStages: 0,
      completedStages: 0,
      diagnostics: [],
    };
  },
  createWallet(): WalletCreated {
    created = true;
    globalThis.localStorage?.setItem(MOCK_CREATED_WALLET_KEY, "1");
    globalThis.localStorage?.setItem(MOCK_BACKUP_REQUIRED_KEY, MOCK_WALLET_ID);
    return { walletId: MOCK_WALLET_ID, birthdayHeight: tip - 100 };
  },
  beginSensitiveDisplay() {
    sensitiveDisplayToken = crypto.randomUUID();
    return { token: sensitiveDisplayToken };
  },
  endSensitiveDisplay(token: string) {
    if (sensitiveDisplayToken === token) sensitiveDisplayToken = null;
  },
  restoreWallet(seedPhrase: string): WalletRestored | Promise<WalletRestored> {
    if (mockWalletScenario() === "slow-restore-error") {
      return new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Recovery phrase is not a valid supported BIP39 mnemonic.",
              ),
            ),
          250,
        ),
      );
    }
    if (seedPhrase.trim().replace(/\s+/g, " ") !== MOCK_SEED) {
      throw new Error(
        "Recovery phrase is not a valid supported BIP39 mnemonic.",
      );
    }
    const publish = (): WalletRestored => {
      created = true;
      globalThis.localStorage?.setItem(MOCK_CREATED_WALLET_KEY, "1");
      globalThis.localStorage?.removeItem(MOCK_BACKUP_REQUIRED_KEY);
      return { success: true, walletId: MOCK_WALLET_ID };
    };
    if (mockWalletScenario() === "slow-restore") {
      return new Promise((resolve) =>
        setTimeout(() => resolve(publish()), 750),
      );
    }
    return publish();
  },
  getSeedPhrase(token: string): string {
    requireSensitiveDisplay(token);
    return MOCK_SEED;
  },
  getBackupSeedPhrase(walletId: string, token: string): string {
    requireSensitiveDisplay(token);
    if (
      walletId !== MOCK_WALLET_ID ||
      globalThis.localStorage?.getItem(MOCK_BACKUP_REQUIRED_KEY) !== walletId
    ) {
      throw new Error(
        "backup phrase request does not match the active pending wallet",
      );
    }
    return MOCK_SEED;
  },
  confirmWalletBackup(walletId: string): void {
    if (walletId !== MOCK_WALLET_ID) {
      throw new Error("backup confirmation does not match the active wallet");
    }
    globalThis.localStorage?.removeItem(MOCK_BACKUP_REQUIRED_KEY);
  },
  listAccounts(): AccountInfo[] {
    return [{ accountIndex: 0, name: "Main", unifiedAddress: MOCK_UA }];
  },
  getAccountBalance(): AccountBalance {
    return balance;
  },
  getUnifiedAddress(): string {
    return MOCK_UA;
  },
  getSyncStatus(): SyncStatus {
    // creep toward tip while "syncing"
    if (syncing && synced < tip) synced = Math.min(tip, synced + 400);
    return {
      syncing,
      syncedHeight: synced,
      chainTip: tip,
      progressPercent: tip ? Math.min(100, (synced / tip) * 100) : 100,
    };
  },
  startSync() {
    // Idempotent, like the real engine: resuming an already-caught-up wallet
    // keeps it synced (it just watches for new blocks) rather than rewinding.
    // Only rewind for a fresh wallet that has never synced.
    syncing = true;
    if (synced >= tip) synced = tip;
  },
  stopSync() {
    syncing = false;
    synced = tip;
  },
  getTransactionHistory(): TransactionEntry[] {
    return history;
  },
  validateAddress(address: string): AddressValidation {
    const valid =
      address.startsWith("u1") ||
      address.startsWith("zs1") ||
      address.startsWith("t1") ||
      address.startsWith("t3");
    return {
      valid,
      addressType: valid
        ? address.startsWith("u1")
          ? "unified"
          : address.startsWith("zs1")
            ? "sapling"
            : "transparent"
        : null,
      canReceiveMemo: address.startsWith("u1") || address.startsWith("zs1"),
    };
  },
  parsePaymentUri(uri: string): PaymentRequest {
    const [addr, qs = ""] = uri.replace(/^zcash:/, "").split("?");
    const params = new URLSearchParams(qs);
    const rawAmount = params.get("amount");
    const amount = rawAmount === null ? null : parseZecToZatoshis(rawAmount);
    if (rawAmount !== null && amount === null) {
      throw new Error("Invalid ZEC amount in payment URI");
    }
    return {
      address: addr,
      amount,
      memo: params.get("memo"),
      label: params.get("label"),
    };
  },
  async proposeSend(
    to: string,
    amount: number,
    memo?: string,
  ): Promise<SendProposal> {
    const delay = mockProposalDelay();
    if (delay)
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
    const proposalId = proposalCounter++;
    const proposal: SendProposal = {
      proposalId,
      review: {
        version: 1,
        network: "mainnet",
        payments: [{ recipient: to, amount, memo: memo ?? null }],
        feePolicy: "zip317-standard",
        fee: 10_000,
        total: amount + 10_000,
        changePolicy: "zip317-shielded-auto",
      },
      reviewDigest: proposalCredential(proposalId, "d"),
      confirmationToken: proposalCredential(proposalId, "c"),
    };
    pendingProposal = proposal;
    return proposal;
  },
  ensureSaplingParams() {
    return { ready: true };
  },
  executeSend(
    proposalId: number,
    reviewDigest: string,
    confirmationToken: string,
  ) {
    if (
      !pendingProposal ||
      pendingProposal.proposalId !== proposalId ||
      pendingProposal.reviewDigest !== reviewDigest ||
      pendingProposal.confirmationToken !== confirmationToken
    ) {
      throw new Error("Send confirmation does not match the reviewed proposal");
    }
    pendingProposal = null;
    return {
      txid: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
      status: "accepted" as const,
      message: null,
    };
  },
  discardSendProposal(
    proposalId: number,
    reviewDigest: string,
    confirmationToken: string,
  ) {
    if (
      !pendingProposal ||
      pendingProposal.proposalId !== proposalId ||
      pendingProposal.reviewDigest !== reviewDigest ||
      pendingProposal.confirmationToken !== confirmationToken
    ) {
      throw new Error("Send confirmation does not match the reviewed proposal");
    }
    pendingProposal = null;
  },
  getPendingSend() {
    return null;
  },
  retryPendingSend() {
    return {
      txid: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
      status: "accepted" as const,
      message: null,
    };
  },
  discardUnrecoverableSend() {},
  signChallenge(challenge: string): SignedChallenge {
    if (globalThis.localStorage?.getItem(MOCK_BACKUP_REQUIRED_KEY)) {
      throw new Error(
        "Recovery phrase backup must be confirmed before signing.",
      );
    }
    if (mockWalletScenario() === "sign-error") {
      throw new Error("The mock wallet could not sign this challenge.");
    }
    if (
      mockWalletScenario() === "identity-switch" &&
      challenge !== "ZUULI-Login:identity-probe"
    ) {
      return {
        address: `${MOCK_UA}-different-identity`,
        challenge,
        signature: "must-not-reach-backend",
      };
    }
    // A believable-looking signature. Real signing happens in the Rust plugin
    // (ZIP-304); this keeps the browser demo flowing.
    const sig = btoa(`${MOCK_UA}:${challenge}`).replace(/=+$/, "");
    return { address: MOCK_UA, challenge, signature: `zip304:${sig}` };
  },
};
