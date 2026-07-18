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
  WalletStatus,
} from "./types";

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
    memo: "Welcome to ZUULI 🎉",
    incoming: true,
  },
  {
    txid: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    blockHeight: 2_611_500,
    timestamp: Math.floor(Date.now() / 1000) - 86400,
    value: -12_000_000,
    memo: "Bought 2Zs",
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

export const mockWallet = {
  getWalletStatus(): WalletStatus {
    return {
      initialized: created,
      hasSeed: created,
      syncedHeight: synced,
      chainTip: tip,
      activeWalletId: "mock-wallet-0",
      activeWalletName: "Main",
      walletCount: 1,
    };
  },
  createWallet(): WalletCreated {
    created = true;
    return { seedPhrase: MOCK_SEED, birthdayHeight: tip - 100 };
  },
  restoreWallet() {
    created = true;
    return { success: true };
  },
  getSeedPhrase(): string {
    return MOCK_SEED;
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
    return {
      address: addr,
      amount: params.get("amount")
        ? Math.round(Number(params.get("amount")) * 1e8)
        : null,
      memo: params.get("memo"),
      label: params.get("label"),
    };
  },
  proposeSend(_to: string, amount: number): SendProposal {
    return {
      proposalId: proposalCounter++,
      amount,
      fee: 10_000,
      total: amount + 10_000,
    };
  },
  executeSend(): string {
    return "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
  },
  signChallenge(challenge: string): SignedChallenge {
    // A believable-looking signature. Real signing happens in the Rust plugin
    // (ZIP-304); this keeps the browser demo flowing.
    const sig = btoa(`${MOCK_UA}:${challenge}`).replace(/=+$/, "");
    return { address: MOCK_UA, challenge, signature: `zip304:${sig}` };
  },
};
