import { create } from "zustand";
import type {
  Page,
  WalletStatus,
  WalletInfo,
  AccountBalance,
  SyncStatus,
  TransactionEntry,
} from "../types";

interface WalletStore {
  page: Page;
  setPage: (page: Page) => void;

  walletStatus: WalletStatus | null;
  setWalletStatus: (status: WalletStatus) => void;

  wallets: WalletInfo[];
  setWallets: (wallets: WalletInfo[]) => void;

  balance: AccountBalance | null;
  setBalance: (balance: AccountBalance) => void;

  syncStatus: SyncStatus | null;
  setSyncStatus: (status: SyncStatus) => void;

  seedPhrase: string | null;
  setSeedPhrase: (phrase: string | null) => void;

  error: string | null;
  setError: (error: string | null) => void;

  lightwalletdUrl: string;
  setLightwalletdUrl: (url: string) => void;

  unifiedAddress: string | null;
  setUnifiedAddress: (address: string | null) => void;

  transactions: TransactionEntry[];
  mergeTransactions: (incoming: TransactionEntry[]) => void;

  resetWalletState: () => void;
}

export const useWalletStore = create<WalletStore>((set) => ({
  page: "welcome",
  setPage: (page) => set({ page }),

  walletStatus: null,
  setWalletStatus: (walletStatus) => set({ walletStatus }),

  wallets: [],
  setWallets: (wallets) => set({ wallets }),

  balance: null,
  setBalance: (balance) => set({ balance }),

  syncStatus: null,
  setSyncStatus: (syncStatus) => set({ syncStatus }),

  seedPhrase: null,
  setSeedPhrase: (seedPhrase) => set({ seedPhrase }),

  error: null,
  setError: (error) => set({ error }),

  lightwalletdUrl: "https://zec.rocks:443",
  setLightwalletdUrl: (lightwalletdUrl) => set({ lightwalletdUrl }),

  unifiedAddress: null,
  setUnifiedAddress: (unifiedAddress) => set({ unifiedAddress }),

  transactions: [],
  mergeTransactions: (incoming) =>
    set((state) => {
      const byTxid = new Map(state.transactions.map((tx) => [tx.txid, tx]));
      for (const tx of incoming) {
        byTxid.set(tx.txid, tx);
      }
      const merged = Array.from(byTxid.values()).sort((a, b) => {
        if (a.blockHeight === null && b.blockHeight === null) return 0;
        if (a.blockHeight === null) return -1;
        if (b.blockHeight === null) return 1;
        return b.blockHeight - a.blockHeight;
      });
      return { transactions: merged };
    }),

  resetWalletState: () =>
    set({
      balance: null,
      syncStatus: null,
      unifiedAddress: null,
      transactions: [],
      seedPhrase: null,
    }),
}));
