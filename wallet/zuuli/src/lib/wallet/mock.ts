// A self-contained in-memory mock wallet so ZUULI's UI runs (and screenshots)
// in a plain browser with no Rust backend and no chain sync. Balances, history
// and sync progress are believable and animate over time.

import type {
  AccountBalance,
  AccountInfo,
  AddressValidation,
  LegacyImportPreview,
  PaymentRequest,
  SendProposal,
  SignedChallenge,
  SyncStatus,
  TransactionEntry,
  WalletCreated,
  WalletInfo,
  WalletRestored,
  WalletStatus,
} from "./types";
import { parseZecToZatoshis } from "../format";
import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";

const MOCK_UA =
  "u1l8xunezsvpntq2snz67h6md2eq09u09vv3xh6z8kqvxg7pdvz4qc9x2u84kqmpc0mz0kmvexz";

// Produced by the native validator's transparent-only Unified Address test:
// P2PKH([0x24; 20]) plus an unknown receiver on mainnet.
const MOCK_TRANSPARENT_ONLY_UA =
  "u1nuyhyzu03pj30mmnehelkll26s0cxp8etqv2x29zfpjj6rfp4gdmm8wfas5hutkxprlerlv0d4yv87eqrh5nahdlaz2vj5tlxy676p7gzkpen6fy97vqk2kujr";

const MOCK_SEED =
  "wisdom shadow orchard zebra pledge notice frost violet render " +
  "summer harvest mirror canyon velvet ranch fossil pupil sunset " +
  "quantum ledger prosper anchor beyond zephyr";

let created = true;
let tip = 2_612_004;
let synced = 2_612_004;
let syncing = false;
let sensitiveDisplayToken: string | null = null;
let sensitiveDisplayPurpose: SensitiveEntryPurpose | "seedReveal" | null = null;

function requireSensitiveDisplay(token: string): void {
  if (
    !token ||
    token !== sensitiveDisplayToken ||
    sensitiveDisplayPurpose !== "seedReveal"
  ) {
    throw new Error("sensitive-display lease is missing or stale");
  }
  sensitiveDisplayToken = null;
  sensitiveDisplayPurpose = null;
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
const MOCK_SECONDARY_WALLET_ID = "mock-wallet-1";
const MOCK_SWITCHED_WALLET_ID = "mock-wallet-switched-after-restore";
let activeMockWalletId = MOCK_WALLET_ID;

const MOCK_WALLETS: readonly Omit<WalletInfo, "isActive">[] = [
  {
    id: MOCK_WALLET_ID,
    name: "Main",
    birthdayHeight: 2_611_904,
    createdAt: "2026-01-02T03:04:05Z",
  },
  {
    id: MOCK_SECONDARY_WALLET_ID,
    name: "Savings",
    birthdayHeight: 2_600_000,
    createdAt: "2026-02-03T04:05:06Z",
  },
];

function activeMockWallet(
  scenario: ReturnType<typeof mockWalletScenario>,
): Omit<WalletInfo, "isActive"> {
  if (scenario === "wallet-switch") {
    return {
      id: MOCK_SWITCHED_WALLET_ID,
      name: "Switched identity",
      birthdayHeight: 2_600_100,
      createdAt: "2026-03-04T05:06:07Z",
    };
  }
  return (
    MOCK_WALLETS.find((wallet) => wallet.id === activeMockWalletId) ??
    MOCK_WALLETS[0]
  );
}

function availableMockWallets(
  scenario: ReturnType<typeof mockWalletScenario>,
): readonly Omit<WalletInfo, "isActive">[] {
  return scenario === "wallet-switch"
    ? [MOCK_WALLETS[0], activeMockWallet(scenario)]
    : MOCK_WALLETS;
}
function mockWalletScenario():
  | "empty"
  | "sign-error"
  | "identity-switch"
  | "legacy-import"
  | "wallet-switch"
  | "slow-restore"
  | "slow-restore-error"
  | null {
  try {
    const value = globalThis.localStorage?.getItem(MOCK_WALLET_SCENARIO_KEY);
    return value === "empty" ||
      value === "sign-error" ||
      value === "identity-switch" ||
      value === "legacy-import" ||
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
  // A wallet with three transactions is not a wallet anyone has. Pad the
  // fixture to a realistic ledger so History is a route that actually
  // scrolls — `tests/scroll-restoration.pw.ts` drives the scroll-owner
  // contract off it, which it could not do against a three-row list, and
  // #904 phase 4 left the app with no other long surface.
  ...Array.from({ length: 21 }, (_, index) => {
    const age = 4 + index;
    const incoming = index % 3 !== 0;
    return {
      txid: `${(index + 16).toString(16).repeat(2)}${"d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1".slice(0, 60)}`,
      blockHeight: 2_610_000 - index * 720,
      timestamp: Math.floor(Date.now() / 1000) - age * 86400,
      value: incoming ? 3_000_000 + index * 110_000 : -(1_500_000 + index * 90_000),
      memo: index % 4 === 0 ? null : `Settled ledger entry ${index + 4}`,
      incoming,
    };
  }),
];

let proposalCounter = 1;
let pendingProposal: SendProposal | null = null;
let pendingConfirmation: {
  proposalId: number;
  reviewDigest: string;
  confirmationToken: string;
  expiresAt: number;
} | null = null;

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
    const active = activeMockWallet(scenario);
    const wallets = initialized ? availableMockWallets(scenario) : [];
    return {
      initialized,
      hasSeed: initialized,
      syncedHeight: synced,
      chainTip: tip,
      activeWalletId: initialized ? active.id : null,
      activeWalletName: initialized ? active.name : null,
      walletCount: wallets.length,
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
        state: scenario === "legacy-import" ? "importPending" : "none",
        legacyIdentifier:
          scenario === "legacy-import" ? "com.2zinc.zuuli" : null,
        diagnostic:
          scenario === "legacy-import"
            ? "An earlier ZUULI wallet remains safely preserved."
            : null,
      },
    };
  },
  listWallets(): WalletInfo[] {
    const status = this.getWalletStatus();
    if (!status.initialized || !status.activeWalletId) return [];
    return availableMockWallets(mockWalletScenario()).map((wallet) => ({
      ...wallet,
      isActive: wallet.id === status.activeWalletId,
    }));
  },
  switchWallet(walletId: string): void {
    if (!MOCK_WALLETS.some((wallet) => wallet.id === walletId)) {
      throw new Error("wallet identifier is unknown or stale");
    }
    activeMockWalletId = walletId;
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
  previewLegacyWalletImport(): LegacyImportPreview {
    if (mockWalletScenario() === "legacy-import") {
      return {
        state: "ready",
        layout: "multi",
        wallets: [
          {
            walletId: "browser-fixture-secret-wallet-a",
            walletName: "browser-fixture-secret-name-a",
            dbFilename: "browser-fixture-secret-a.sqlite",
            accountCount: 2,
            ufvkFingerprints: ["browser-fixture-secret-fingerprint-a"],
            walPresent: true,
            shmPresent: true,
            encryptedCustodyPresent: true,
          },
          {
            walletId: "browser-fixture-secret-wallet-b",
            walletName: "browser-fixture-secret-name-b",
            dbFilename: "browser-fixture-secret-b.sqlite",
            accountCount: 1,
            ufvkFingerprints: ["browser-fixture-secret-fingerprint-b"],
            walPresent: false,
            shmPresent: false,
            encryptedCustodyPresent: false,
          },
        ],
        diagnostics: ["Browser fixture preview is read-only."],
      };
    }
    return {
      state: "absent",
      layout: null,
      wallets: [],
      diagnostics: ["No preserved wallet data is available in browser demo mode."],
    };
  },
  createWallet(): WalletCreated {
    created = true;
    activeMockWalletId = MOCK_WALLET_ID;
    globalThis.localStorage?.setItem(MOCK_CREATED_WALLET_KEY, "1");
    globalThis.localStorage?.setItem(MOCK_BACKUP_REQUIRED_KEY, MOCK_WALLET_ID);
    return { walletId: MOCK_WALLET_ID, birthdayHeight: tip - 100 };
  },
  beginSensitiveDisplay(
    purpose: SensitiveEntryPurpose | "seedReveal",
  ) {
    if (sensitiveDisplayToken) {
      throw new Error("another sensitive-display lease is already active");
    }
    sensitiveDisplayToken = crypto.randomUUID();
    sensitiveDisplayPurpose = purpose;
    return { token: sensitiveDisplayToken };
  },
  endSensitiveDisplay(
    token: string,
    purpose: SensitiveEntryPurpose | "seedReveal",
  ) {
    if (
      sensitiveDisplayToken === token &&
      sensitiveDisplayPurpose === purpose
    ) {
      sensitiveDisplayToken = null;
      sensitiveDisplayPurpose = null;
    }
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
      activeMockWalletId = MOCK_WALLET_ID;
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
    const wrongNetwork =
      address.startsWith("utest") ||
      address.startsWith("ztestsapling") ||
      address.startsWith("tm") ||
      address.startsWith("t2");
    if (wrongNetwork) {
      return {
        valid: false,
        addressType: null,
        canReceiveMemo: false,
        error: "Address belongs to a different Zcash network",
      };
    }
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
      canReceiveMemo:
        (address.startsWith("u1") && address !== MOCK_TRANSPARENT_ONLY_UA) ||
        address.startsWith("zs1"),
    };
  },
  parsePaymentUri(uri: string): PaymentRequest {
    if (!uri.startsWith("zcash:")) {
      throw new Error("Invalid Zcash payment URI");
    }
    const [leadAddress, qs = ""] = uri.slice("zcash:".length).split("?", 2);
    const params = new URLSearchParams(qs);
    const payments: Array<{ index: number; address: string }> = [];
    if (leadAddress) payments.push({ index: 0, address: leadAddress });
    for (const [name, address] of params) {
      const match = /^address(?:\.(\d+))?$/.exec(name);
      if (!match) continue;
      payments.push({ index: match[1] === undefined ? 0 : Number(match[1]), address });
    }
    if (payments.length !== 1) {
      throw new Error(
        `Payment URI must contain exactly one payment; found ${payments.length}`,
      );
    }
    const [{ index, address }] = payments;
    const validation = mockWallet.validateAddress(address);
    if (!validation.valid) {
      throw new Error(validation.error ?? "Invalid Zcash recipient address");
    }
    const suffix = index === 0 ? "" : `.${index}`;
    const rawAmount = params.get(`amount${suffix}`);
    const amount = rawAmount === null ? null : parseZecToZatoshis(rawAmount);
    if (rawAmount !== null && amount === null) {
      throw new Error("Invalid ZEC amount in payment URI");
    }
    return {
      address,
      amount,
      memo: params.get(`memo${suffix}`),
      label: params.get(`label${suffix}`),
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
        version: 2,
        network: "mainnet",
        payments: [{ recipient: to, amount, memo: memo ?? null }],
        feePolicy: "zip317-standard",
        fee: 10_000,
        total: amount + 10_000,
        changePolicy: "zip317-shielded-auto",
      },
      reviewDigest: proposalCredential(proposalId, "d"),
      proposalToken: proposalCredential(proposalId, "a"),
    };
    pendingProposal = proposal;
    pendingConfirmation = null;
    return proposal;
  },
  ensureSaplingParams() {
    return { ready: true };
  },
  confirmSend(proposalId: number, reviewDigest: string, proposalToken: string) {
    if (
      !pendingProposal ||
      pendingProposal.proposalId !== proposalId ||
      pendingProposal.reviewDigest !== reviewDigest ||
      pendingProposal.proposalToken !== proposalToken
    ) {
      throw new Error(
        "Send proposal credentials do not match the reviewed payment",
      );
    }
    if (
      globalThis.localStorage?.getItem("zuuli.mock.send-confirmation-result") ===
      "cancel"
    ) {
      throw new Error("Native payment confirmation was cancelled");
    }
    const expiresAt = Date.now() + 2 * 60 * 1000;
    pendingConfirmation = {
      proposalId,
      reviewDigest,
      confirmationToken: proposalCredential(proposalId, "c"),
      expiresAt,
    };
    return {
      confirmationToken: pendingConfirmation.confirmationToken,
      expiresAt,
    };
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
      !pendingConfirmation ||
      pendingConfirmation.proposalId !== proposalId ||
      pendingConfirmation.reviewDigest !== reviewDigest ||
      pendingConfirmation.confirmationToken !== confirmationToken ||
      Date.now() >= pendingConfirmation.expiresAt
    ) {
      throw new Error("Native payment confirmation is absent, stale, or mismatched");
    }
    pendingProposal = null;
    pendingConfirmation = null;
    return {
      txid: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
      status: "accepted" as const,
      message: null,
    };
  },
  discardSendProposal(
    proposalId: number,
    reviewDigest: string,
    proposalToken: string,
  ) {
    if (
      !pendingProposal ||
      pendingProposal.proposalId !== proposalId ||
      pendingProposal.reviewDigest !== reviewDigest ||
      pendingProposal.proposalToken !== proposalToken
    ) {
      throw new Error("Send proposal credentials do not match the reviewed payment");
    }
    pendingProposal = null;
    pendingConfirmation = null;
  },
  getPendingSend() {
    if (globalThis.localStorage?.getItem("zuuli.mock.pending-send") === "unknown") {
      return {
        proposalId: 41,
        txid: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
        status: "unknown" as const,
        message: null,
        recoveryRequired: false,
        canDiscard: false,
      };
    }
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
