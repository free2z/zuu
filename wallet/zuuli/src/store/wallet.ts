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
}

export const useWallet = create<WalletState>((set) => ({
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
}));
