import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountBalance,
  SyncStatus,
  WalletInfo,
  WalletStatus,
} from "@/lib/wallet/types";

const bridge = vi.hoisted(() => ({
  getWalletStatus: vi.fn(),
  listWallets: vi.fn(),
  switchWallet: vi.fn(),
  getAccountBalance: vi.fn(),
  getUnifiedAddress: vi.fn(),
  getSyncStatus: vi.fn(),
  startSync: vi.fn(),
  retryWalletCleanup: vi.fn(),
}));

vi.mock("@/lib/wallet/bridge", () => ({ wallet: bridge }));

import { useWallet } from "./wallet";

const cleanup = {
  pendingOperations: 0,
  blockedOperations: 0,
  pendingStages: 0,
  completedStages: 0,
  diagnostics: [],
};
const legacyAppData = {
  state: "none" as const,
  legacyIdentifier: null,
  diagnostic: null,
};

function inventory(activeId: string): WalletInfo[] {
  return [
    {
      id: "wallet-a",
      name: "Alpha",
      isActive: activeId === "wallet-a",
      birthdayHeight: 100,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "wallet-b",
      name: "Beta",
      isActive: activeId === "wallet-b",
      birthdayHeight: 200,
      createdAt: "2026-02-01T00:00:00Z",
    },
  ];
}

function status(activeId: string): WalletStatus {
  const active = inventory(activeId).find(({ isActive }) => isActive)!;
  return {
    initialized: true,
    hasSeed: true,
    syncedHeight: 1_000,
    chainTip: 1_001,
    activeWalletId: active.id,
    activeWalletName: active.name,
    walletCount: 2,
    backupRequired: false,
    cleanup,
    legacyAppData,
  };
}

function balance(marker: number): AccountBalance {
  return {
    accountIndex: 0,
    totalShielded: marker,
    spendable: marker,
    changePending: 0,
    valuePending: 0,
  };
}

function sync(marker: number): SyncStatus {
  return {
    syncing: true,
    syncedHeight: marker,
    chainTip: marker + 1,
    progressPercent: 99,
  };
}

function mockStableNative(activeId: () => string): void {
  bridge.getWalletStatus.mockImplementation(async () => status(activeId()));
  bridge.listWallets.mockImplementation(async () => inventory(activeId()));
  bridge.getAccountBalance.mockImplementation(async () =>
    balance(activeId() === "wallet-a" ? 11 : 22),
  );
  bridge.getUnifiedAddress.mockImplementation(async () =>
    activeId() === "wallet-a" ? "u1-alpha" : "u1-beta",
  );
  bridge.getSyncStatus.mockImplementation(async () =>
    sync(activeId() === "wallet-a" ? 111 : 222),
  );
  bridge.startSync.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  useWallet.getState().stopSyncPolling();
  useWallet.setState({
    status: null,
    wallets: [],
    activeWalletId: null,
    activeWallet: null,
    balance: null,
    sync: null,
    unifiedAddress: null,
    loading: true,
    switchingWalletId: null,
    identityError: null,
    cleanupRetrying: false,
    cleanupError: null,
  });
});

afterEach(() => useWallet.getState().stopSyncPolling());

describe("wallet identity store", () => {
  it("publishes identity and account-scoped data in one coherent update", async () => {
    mockStableNative(() => "wallet-a");
    const publications: Array<{
      id: string | null;
      statusId: string | null | undefined;
      walletId: string | undefined;
      spendable: number | undefined;
      address: string | null;
      height: number | undefined;
    }> = [];
    const unsubscribe = useWallet.subscribe((state) => {
      publications.push({
        id: state.activeWalletId,
        statusId: state.status?.activeWalletId,
        walletId: state.activeWallet?.id,
        spendable: state.balance?.spendable,
        address: state.unifiedAddress,
        height: state.sync?.syncedHeight,
      });
    });

    await useWallet.getState().bootstrap();
    unsubscribe();

    expect(publications).toEqual([
      {
        id: "wallet-a",
        statusId: "wallet-a",
        walletId: "wallet-a",
        spendable: 11,
        address: "u1-alpha",
        height: 111,
      },
    ]);
    expect(bridge.getWalletStatus).toHaveBeenCalledTimes(2);
    expect(bridge.listWallets).toHaveBeenCalledTimes(2);
    expect(bridge.getAccountBalance).toHaveBeenCalledWith(0);
    expect(bridge.getUnifiedAddress).toHaveBeenCalledWith(0);
  });

  it("fails closed on incoherent inventory without partially publishing it", async () => {
    mockStableNative(() => "wallet-a");
    await useWallet.getState().bootstrap();
    const prior = useWallet.getState();

    bridge.getWalletStatus.mockResolvedValueOnce(status("wallet-b"));
    bridge.listWallets.mockResolvedValueOnce(inventory("wallet-a"));
    await useWallet.getState().bootstrap();

    const current = useWallet.getState();
    expect(current.activeWalletId).toBe(prior.activeWalletId);
    expect(current.balance).toBe(prior.balance);
    expect(current.unifiedAddress).toBe(prior.unifiedAddress);
    expect(current.identityError).toContain("disagree");
  });

  it.each([
    ["no active wallet", inventory("wallet-a").map((entry) => ({ ...entry, isActive: false }))],
    ["multiple active wallets", inventory("wallet-a").map((entry) => ({ ...entry, isActive: true }))],
    [
      "duplicate identifiers",
      [inventory("wallet-a")[0], { ...inventory("wallet-a")[1], id: "wallet-a" }],
    ],
  ])("rejects the %s inventory mutant", async (_label, mutatedInventory) => {
    mockStableNative(() => "wallet-a");
    bridge.listWallets.mockResolvedValueOnce(mutatedInventory);

    await useWallet.getState().bootstrap();

    expect(useWallet.getState()).toMatchObject({
      status: null,
      wallets: [],
      activeWalletId: null,
      activeWallet: null,
      balance: null,
      sync: null,
      unifiedAddress: null,
    });
    expect(useWallet.getState().identityError).not.toBeNull();
  });

  it("rejects an unknown identifier before invoking native switching", async () => {
    mockStableNative(() => "wallet-a");
    await useWallet.getState().bootstrap();

    await expect(useWallet.getState().switchWallet("wallet-unknown")).rejects.toThrow(
      "unknown or stale",
    );
    expect(bridge.switchWallet).not.toHaveBeenCalled();
    expect(useWallet.getState().activeWalletId).toBe("wallet-a");
  });

  it("preserves the prior coherent snapshot when a known identifier is stale natively", async () => {
    mockStableNative(() => "wallet-a");
    await useWallet.getState().bootstrap();
    const prior = useWallet.getState();
    bridge.switchWallet.mockRejectedValueOnce(new Error("native stale wallet"));

    await expect(useWallet.getState().switchWallet("wallet-b")).rejects.toThrow(
      "native stale wallet",
    );

    expect(bridge.switchWallet).toHaveBeenCalledWith("wallet-b");
    expect(useWallet.getState().activeWalletId).toBe(prior.activeWalletId);
    expect(useWallet.getState().balance).toBe(prior.balance);
    expect(useWallet.getState().unifiedAddress).toBe(prior.unifiedAddress);
  });

  it("serializes concurrent native switches and ends on the last requested identity", async () => {
    let nativeActiveId = "wallet-a";
    mockStableNative(() => nativeActiveId);
    let releaseFirst!: () => void;
    bridge.switchWallet
      .mockImplementationOnce(
        (walletId: string) =>
          new Promise<void>((resolve) => {
            releaseFirst = () => {
              nativeActiveId = walletId;
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async (walletId: string) => {
        nativeActiveId = walletId;
      });
    await useWallet.getState().bootstrap();

    const seen: Array<[string | null, number | undefined, string | null]> = [];
    const unsubscribe = useWallet.subscribe((state) => {
      if (state.activeWalletId) {
        seen.push([
          state.activeWalletId,
          state.balance?.spendable,
          state.unifiedAddress,
        ]);
      }
    });
    const first = useWallet.getState().switchWallet("wallet-b");
    const second = useWallet.getState().switchWallet("wallet-a");
    await vi.waitFor(() => expect(bridge.switchWallet).toHaveBeenCalledTimes(1));
    expect(bridge.switchWallet).toHaveBeenLastCalledWith("wallet-b");
    releaseFirst();
    await Promise.all([first, second]);
    unsubscribe();

    expect(bridge.switchWallet.mock.calls).toEqual([
      ["wallet-b"],
      ["wallet-a"],
    ]);
    expect(nativeActiveId).toBe("wallet-a");
    expect(useWallet.getState()).toMatchObject({
      activeWalletId: "wallet-a",
      wallets: inventory("wallet-a"),
      balance: { spendable: 11 },
      unifiedAddress: "u1-alpha",
      sync: { syncedHeight: 111 },
    });
    expect(seen).toContainEqual(["wallet-b", 22, "u1-beta"]);
    expect(seen[seen.length - 1]).toEqual(["wallet-a", 11, "u1-alpha"]);
    expect(seen.every(([id, amount]) => (id === "wallet-a" ? amount === 11 : amount === 22))).toBe(true);
  });

  it("clears identity data when native switches but the verification snapshot mutates", async () => {
    let nativeActiveId = "wallet-a";
    mockStableNative(() => nativeActiveId);
    bridge.switchWallet.mockImplementation(async (walletId: string) => {
      nativeActiveId = walletId;
    });
    await useWallet.getState().bootstrap();
    bridge.listWallets
      .mockResolvedValueOnce(inventory("wallet-b"))
      .mockResolvedValueOnce(inventory("wallet-a"));

    await expect(useWallet.getState().switchWallet("wallet-b")).rejects.toThrow(
      /disagree|changed during refresh/,
    );
    expect(useWallet.getState()).toMatchObject({
      status: null,
      wallets: [],
      activeWalletId: null,
      activeWallet: null,
      balance: null,
      sync: null,
      unifiedAddress: null,
    });
  });
});
