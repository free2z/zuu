import { useCallback } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";
import { createdSeedSession } from "../lib/sensitive-seed";

export function useWallet() {
  const { setWalletStatus, setPage, setError, setWallets, resetWalletState } =
    useWalletStore();

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.getWalletStatus();
      setWalletStatus(status);
      if (status.initialized) {
        if (status.backupRequired && status.activeWalletId) {
          createdSeedSession.prepare(status.activeWalletId);
          setPage("create");
        } else {
          setPage("home");
        }
      }
    } catch (e) {
      setError(String(e));
    }
  }, [setWalletStatus, setPage, setError]);

  const createWallet = useCallback(
    async (name?: string) => {
      try {
        const result = await api.createWallet(24, name);
        createdSeedSession.prepare(result.walletId);
        try {
          await createdSeedSession.reveal(result.walletId, (walletId, token) =>
            api.getBackupSeedPhrase(walletId, token),
          );
        } finally {
          // Authentication cancellation still enters the exact resumable
          // backup gate; it never strands the native backup-required wallet.
          if (createdSeedSession.currentWalletId === result.walletId) {
            setPage("create");
          }
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [setPage, setError],
  );

  const restoreWallet = useCallback(
    async (phrase: string, birthday?: number, name?: string) => {
      try {
        await api.restoreWallet(phrase, birthday, name);
        setPage("home");
      } catch (e) {
        setError(String(e));
      }
    },
    [setPage, setError],
  );

  const switchWallet = useCallback(
    async (walletId: string) => {
      try {
        resetWalletState();
        await api.switchWallet(walletId);
        const status = await api.getWalletStatus();
        setWalletStatus(status);
        setPage("home");
      } catch (e) {
        setError(String(e));
      }
    },
    [resetWalletState, setWalletStatus, setPage, setError],
  );

  const loadWallets = useCallback(async () => {
    try {
      const wallets = await api.listWallets();
      setWallets(wallets);
      return wallets;
    } catch (e) {
      setError(String(e));
      return [];
    }
  }, [setWallets, setError]);

  const unlockWallet = useCallback(
    async (seedPhrase: string, walletId?: string) => {
      await api.unlockWallet(seedPhrase, walletId);
      const status = await api.getWalletStatus();
      setWalletStatus(status);
    },
    [setWalletStatus],
  );

  return {
    checkStatus,
    createWallet,
    restoreWallet,
    switchWallet,
    loadWallets,
    unlockWallet,
  };
}
