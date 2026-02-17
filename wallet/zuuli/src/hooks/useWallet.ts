import { useCallback } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";

export function useWallet() {
  const {
    setWalletStatus,
    setSeedPhrase,
    setPage,
    setError,
    setWallets,
    resetWalletState,
  } = useWalletStore();

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.getWalletStatus();
      setWalletStatus(status);
      if (status.initialized) {
        setPage("home");
      }
    } catch (e) {
      setError(String(e));
    }
  }, [setWalletStatus, setPage, setError]);

  const createWallet = useCallback(
    async (name?: string) => {
      try {
        const result = await api.createWallet(24, name);
        setSeedPhrase(result.seedPhrase);
        setPage("create");
      } catch (e) {
        setError(String(e));
      }
    },
    [setSeedPhrase, setPage, setError],
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

  return { checkStatus, createWallet, restoreWallet, switchWallet, loadWallets, unlockWallet };
}
