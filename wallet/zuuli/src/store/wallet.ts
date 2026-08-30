import { create } from "zustand";
import { wallet } from "@/lib/wallet/bridge";
import type {
  AccountBalance,
  SyncStatus,
  WalletInfo,
  WalletStatus,
} from "@/lib/wallet/types";

export class WalletIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletIdentityError";
  }
}

interface WalletSnapshot {
  status: WalletStatus;
  wallets: WalletInfo[];
  activeWalletId: string | null;
  activeWallet: WalletInfo | null;
  balance: AccountBalance | null;
  sync: SyncStatus | null;
  unifiedAddress: string | null;
}

interface WalletState extends Omit<WalletSnapshot, "status"> {
  status: WalletStatus | null;
  loading: boolean;
  switchingWalletId: string | null;
  identityError: string | null;
  cleanupRetrying: boolean;
  cleanupError: string | null;

  bootstrap: () => Promise<void>;
  refreshWalletIdentity: (expectedWalletId: string) => Promise<void>;
  switchWallet: (walletId: string) => Promise<void>;
  retryCleanup: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  refreshSync: () => Promise<void>;
  startSyncPolling: () => void;
  stopSyncPolling: () => void;
}

// Every identity read and native switch shares one queue. Serializing only
// publication is insufficient: switch B could publish while switch A is still
// in native code, leaving the engine on A and the renderer claiming B. Native
// create/restore calls originate in protected UI flows; their exact-ID refresh
// is unconditional and enters this queue immediately after native success.
let identityQueue: Promise<void> = Promise.resolve();
let identityTransitionActive = false;

function enqueueIdentity<T>(operation: () => Promise<T>): Promise<T> {
  const result = identityQueue.then(operation);
  identityQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function activeWalletFrom(
  status: WalletStatus,
  wallets: readonly WalletInfo[],
): WalletInfo | null {
  if (new Set(wallets.map(({ id }) => id)).size !== wallets.length) {
    throw new WalletIdentityError("Wallet inventory contains duplicate identifiers.");
  }
  if (status.walletCount !== wallets.length) {
    throw new WalletIdentityError("Wallet inventory count changed during refresh.");
  }

  const activeWallets = wallets.filter(({ isActive }) => isActive);
  if (!status.initialized) {
    if (
      status.activeWalletId !== null ||
      status.activeWalletName !== null ||
      activeWallets.length !== 0
    ) {
      throw new WalletIdentityError("An uninitialized wallet cannot be active.");
    }
    return null;
  }

  if (
    activeWallets.length !== 1 ||
    !status.activeWalletId ||
    status.activeWalletName === null
  ) {
    throw new WalletIdentityError("Wallet inventory has no unique active identity.");
  }
  const activeWallet = activeWallets[0];
  if (
    activeWallet.id !== status.activeWalletId ||
    activeWallet.name !== status.activeWalletName
  ) {
    throw new WalletIdentityError("Wallet status and inventory disagree.");
  }
  return activeWallet;
}

function sameInventory(left: readonly WalletInfo[], right: readonly WalletInfo[]): boolean {
  return (
    left.length === right.length &&
    left.every((walletInfo, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        walletInfo.id === other.id &&
        walletInfo.name === other.name &&
        walletInfo.isActive === other.isActive &&
        walletInfo.birthdayHeight === other.birthdayHeight &&
        walletInfo.createdAt === other.createdAt
      );
    })
  );
}

async function readWalletSnapshot(
  expectedWalletId?: string,
): Promise<WalletSnapshot> {
  const [status, wallets] = await Promise.all([
    wallet.getWalletStatus(),
    wallet.listWallets(),
  ]);
  const activeWallet = activeWalletFrom(status, wallets);

  if (expectedWalletId && activeWallet?.id !== expectedWalletId) {
    throw new WalletIdentityError(
      "The selected Zcash identity is no longer active. Try again.",
    );
  }

  if (!activeWallet) {
    return {
      status,
      wallets,
      activeWalletId: null,
      activeWallet: null,
      balance: null,
      sync: null,
      unifiedAddress: null,
    };
  }

  const [balance, unifiedAddress, sync] = await Promise.all([
    wallet.getAccountBalance(0),
    wallet.getUnifiedAddress(0),
    wallet.getSyncStatus(),
  ]);
  const [verifiedStatus, verifiedWallets] = await Promise.all([
    wallet.getWalletStatus(),
    wallet.listWallets(),
  ]);
  const verifiedActiveWallet = activeWalletFrom(verifiedStatus, verifiedWallets);

  if (
    verifiedActiveWallet?.id !== activeWallet.id ||
    (expectedWalletId && verifiedActiveWallet.id !== expectedWalletId) ||
    !sameInventory(wallets, verifiedWallets)
  ) {
    throw new WalletIdentityError("Wallet identity changed during refresh.");
  }

  return {
    status: verifiedStatus,
    wallets: verifiedWallets,
    activeWalletId: verifiedActiveWallet.id,
    activeWallet: verifiedActiveWallet,
    balance,
    sync,
    unifiedAddress,
  };
}

const POLL_CATCHING_UP_MS = 6_000;
const POLL_CAUGHT_UP_MS = 30_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function isCaughtUp(sync: SyncStatus | null): boolean {
  if (!sync) return false;
  return sync.chainTip > 0 && sync.syncedHeight >= sync.chainTip;
}

const clearedIdentity: Pick<
  WalletState,
  | "status"
  | "wallets"
  | "activeWalletId"
  | "activeWallet"
  | "balance"
  | "sync"
  | "unifiedAddress"
> = {
  status: null,
  wallets: [],
  activeWalletId: null,
  activeWallet: null,
  balance: null,
  sync: null,
  unifiedAddress: null,
};

export const useWallet = create<WalletState>((set, get) => ({
  ...clearedIdentity,
  loading: true,
  switchingWalletId: null,
  identityError: null,
  cleanupRetrying: false,
  cleanupError: null,

  async bootstrap() {
    await enqueueIdentity(async () => {
      identityTransitionActive = true;
      try {
        const snapshot = await readWalletSnapshot();
        set({ ...snapshot, loading: false, identityError: null });
        if (snapshot.activeWalletId) {
          void wallet.startSync().catch(() => {
            /* already syncing / db not ready yet — ignore */
          });
          get().startSyncPolling();
        }
      } catch (error) {
        set({ loading: false, identityError: String(error) });
      } finally {
        identityTransitionActive = false;
      }
    });
  },

  async refreshWalletIdentity(expectedWalletId) {
    await enqueueIdentity(async () => {
      identityTransitionActive = true;
      get().stopSyncPolling();
      try {
        const snapshot = await readWalletSnapshot(expectedWalletId);
        set({ ...snapshot, loading: false, identityError: null });
        void wallet.startSync().catch(() => {
          /* already syncing / db not ready yet — ignore */
        });
        get().startSyncPolling();
      } catch (error) {
        set({ ...clearedIdentity, loading: false, identityError: String(error) });
        throw error;
      } finally {
        identityTransitionActive = false;
      }
    });
  },

  async switchWallet(walletId) {
    await enqueueIdentity(async () => {
      set({ switchingWalletId: walletId, identityError: null });
      if (!get().wallets.some(({ id }) => id === walletId)) {
        const error = new WalletIdentityError(
          "Wallet identifier is unknown or stale.",
        );
        set({ switchingWalletId: null, identityError: error.message });
        throw error;
      }

      identityTransitionActive = true;
      get().stopSyncPolling();
      let nativeSwitched = false;
      try {
        await wallet.switchWallet(walletId);
        nativeSwitched = true;
        const snapshot = await readWalletSnapshot(walletId);
        set({
          ...snapshot,
          loading: false,
          switchingWalletId: null,
          identityError: null,
        });
        void wallet.startSync().catch(() => {
          /* already syncing / db not ready yet — ignore */
        });
        get().startSyncPolling();
      } catch (error) {
        set({
          ...(nativeSwitched ? clearedIdentity : {}),
          loading: false,
          switchingWalletId: null,
          identityError: String(error),
        });
        if (!nativeSwitched && get().activeWalletId) {
          get().startSyncPolling();
        }
        throw error;
      } finally {
        identityTransitionActive = false;
      }
    });
  },

  async retryCleanup() {
    set({ cleanupRetrying: true, cleanupError: null });
    try {
      const cleanup = await wallet.retryWalletCleanup();
      const status = get().status;
      if (status) set({ status: { ...status, cleanup } });
    } catch (error) {
      set({ cleanupError: String(error) });
    } finally {
      set({ cleanupRetrying: false });
    }
  },

  async refreshBalance() {
    const activeWalletId = get().activeWalletId;
    if (!activeWalletId || identityTransitionActive) return;
    try {
      const balance = await wallet.getAccountBalance(0);
      if (!identityTransitionActive && get().activeWalletId === activeWalletId) {
        set({ balance });
      }
    } catch {
      /* ignore */
    }
  },

  async refreshSync() {
    const activeWalletId = get().activeWalletId;
    if (!activeWalletId || identityTransitionActive) return;
    try {
      const sync = await wallet.getSyncStatus();
      if (!identityTransitionActive && get().activeWalletId === activeWalletId) {
        set({ sync });
      }
    } catch {
      /* ignore */
    }
  },

  startSyncPolling() {
    if (pollTimer !== null) return;

    const tick = async () => {
      let caughtUp = false;
      const activeWalletId = get().activeWalletId;
      try {
        if (!activeWalletId || identityTransitionActive) return;
        const prev = get().sync;
        const sync = await wallet.getSyncStatus();
        if (identityTransitionActive || get().activeWalletId !== activeWalletId) {
          return;
        }
        set({ sync });
        caughtUp = isCaughtUp(sync);
        if (!prev || sync.syncedHeight !== prev.syncedHeight) {
          void get().refreshBalance();
        }
      } catch {
        /* transient error — keep polling */
      } finally {
        if (pollTimer !== null) {
          pollTimer = setTimeout(
            tick,
            caughtUp ? POLL_CAUGHT_UP_MS : POLL_CATCHING_UP_MS,
          );
        }
      }
    };

    pollTimer = setTimeout(tick, POLL_CATCHING_UP_MS);
  },

  stopSyncPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
}));
