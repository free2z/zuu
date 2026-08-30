import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletInfo, WalletStatus } from "@/lib/wallet/types";

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

import { useWallet } from "@/store/wallet";
import WalletFeature from "./index";

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

async function installDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    getComputedStyle:
      window.getComputedStyle?.bind(window) ??
      (() => ({ animationName: "none", display: "block" })),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(Date.now()), 0);
    },
    cancelAnimationFrame: (handle: number) => window.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  restoreGlobals = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  container = document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
}

const cleanup = {
  pendingOperations: 0,
  blockedOperations: 0,
  pendingStages: 0,
  completedStages: 0,
  diagnostics: [],
};
const activeWallet: WalletInfo = {
  id: "wallet-existing",
  name: "Existing wallet",
  isActive: true,
  birthdayHeight: 1,
  createdAt: "2026-01-01T00:00:00Z",
};
const initializedStatus: WalletStatus = {
  initialized: true,
  hasSeed: true,
  syncedHeight: 1,
  chainTip: 2,
  activeWalletId: activeWallet.id,
  activeWalletName: activeWallet.name,
  walletCount: 1,
  backupRequired: false,
  cleanup,
  legacyAppData: {
    state: "none",
    legacyIdentifier: null,
    diagnostic: null,
  },
};

beforeEach(async () => {
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
  bridge.getWalletStatus.mockResolvedValue(initializedStatus);
  bridge.listWallets.mockResolvedValue([activeWallet]);
  bridge.getAccountBalance.mockRejectedValue(new Error("transient balance failure"));
  bridge.getUnifiedAddress.mockResolvedValue("u1-existing");
  bridge.getSyncStatus.mockResolvedValue({
    syncing: true,
    syncedHeight: 1,
    chainTip: 2,
    progressPercent: 50,
  });
  await installDom();
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
  useWallet.getState().stopSyncPolling();
});

describe("wallet identity failure boundary", () => {
  it("blocks create and restore after an existing wallet's first account read fails", async () => {
    await useWallet.getState().bootstrap();

    expect(useWallet.getState()).toMatchObject({
      status: null,
      wallets: [],
      activeWalletId: null,
      activeWallet: null,
      balance: null,
      sync: null,
      unifiedAddress: null,
      loading: false,
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/wallet"]}>
          <WalletFeature />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Wallet identity unavailable");
    expect(container.textContent).toContain("Retry wallet identity");
    expect(container.textContent).not.toContain("Create new");
    expect(container.textContent).not.toContain("Create wallet");
    expect(container.textContent).not.toContain("Restore wallet");
  });
});
