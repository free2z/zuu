import { useCallback } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";

export function useBalance() {
  const { setBalance, setError } = useWalletStore();

  const refreshBalance = useCallback(
    async (accountIndex = 0) => {
      try {
        const balance = await api.getAccountBalance(accountIndex);
        setBalance(balance);
      } catch (e) {
        setError(String(e));
      }
    },
    [setBalance, setError],
  );

  return { refreshBalance };
}
