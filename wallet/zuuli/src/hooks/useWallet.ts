import { useCallback } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";

export function useWallet() {
  const { setWalletStatus, setSeedPhrase, setPage, setError } =
    useWalletStore();

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

  const createWallet = useCallback(async () => {
    try {
      const result = await api.createWallet(24);
      setSeedPhrase(result.seedPhrase);
      setPage("create");
    } catch (e) {
      setError(String(e));
    }
  }, [setSeedPhrase, setPage, setError]);

  const restoreWallet = useCallback(
    async (phrase: string, birthday?: number) => {
      try {
        await api.restoreWallet(phrase, birthday);
        setPage("home");
      } catch (e) {
        setError(String(e));
      }
    },
    [setPage, setError],
  );

  return { checkStatus, createWallet, restoreWallet };
}
