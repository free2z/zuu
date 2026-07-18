import { create } from "zustand";
import { wallet } from "@/lib/wallet/bridge";
import type {
  AccountBalance,
  SyncStatus,
  WalletStatus,
} from "@/lib/wallet/types";

interface WalletState {
  status: WalletStatus | null;
  balance: AccountBalance | null;
  sync: SyncStatus | null;
  unifiedAddress: string | null;
  loading: boolean;

  bootstrap: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  refreshSync: () => Promise<void>;
  startSyncPolling: () => void;
  stopSyncPolling: () => void;
}

// Background sync poll — a single self-scheduling timer shared app-wide, so the
// balance and sync chip update on their own with no user action ("no fanfare").
// Fast cadence while catching up, relaxed cadence once caught up. Note the
// engine reports `syncing: true` even at the chain tip (it keeps watching for
// new blocks), so "caught up" is judged by height, not the syncing flag.
const POLL_CATCHING_UP_MS = 6_000;
const POLL_CAUGHT_UP_MS = 30_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function isCaughtUp(sync: SyncStatus | null): boolean {
  if (!sync) return false;
  return sync.chainTip > 0 && sync.syncedHeight >= sync.chainTip;
}

export const useWallet = create<WalletState>((set, get) => ({
  status: null,
  balance: null,
  sync: null,
  unifiedAddress: null,
  loading: true,

  async bootstrap() {
    try {
      const status = await wallet.getWalletStatus();
      set({ status, loading: false });
      if (status.initialized) {
        const [balance, address, sync] = await Promise.all([
          wallet.getAccountBalance(0),
          wallet.getUnifiedAddress(0),
          wallet.getSyncStatus(),
        ]);
        set({ balance, unifiedAddress: address, sync });
        // Resume syncing automatically on every launch. `start_sync` is
        // idempotent on the backend (a no-op when a sync is already running),
        // so this is safe to fire-and-forget and tolerant of "already syncing".
        void wallet.startSync().catch(() => {
          /* already syncing / db not ready yet — ignore */
        });
        // Keep a quiet background poll running so the UI stays live.
        get().startSyncPolling();
      }
    } catch {
      set({ loading: false });
    }
  },

  async refreshBalance() {
    try {
      const balance = await wallet.getAccountBalance(0);
      set({ balance });
    } catch {
      /* ignore */
    }
  },

  async refreshSync() {
    try {
      const sync = await wallet.getSyncStatus();
      set({ sync });
    } catch {
      /* ignore */
    }
  },

  startSyncPolling() {
    if (pollTimer !== null) return; // already polling — keep the singleton

    const tick = async () => {
      let caughtUp = false;
      try {
        const prev = get().sync;
        const sync = await wallet.getSyncStatus();
        set({ sync });
        caughtUp = isCaughtUp(sync);
        // When new blocks land, refresh the balance so it updates on its own.
        if (!prev || sync.syncedHeight !== prev.syncedHeight) {
          void get().refreshBalance();
        }
      } catch {
        /* transient error — keep polling */
      }
      pollTimer = setTimeout(
        tick,
        caughtUp ? POLL_CAUGHT_UP_MS : POLL_CATCHING_UP_MS,
      );
    };

    // bootstrap already fetched an initial status; schedule the next check.
    pollTimer = setTimeout(tick, POLL_CATCHING_UP_MS);
  },

  stopSyncPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
}));
