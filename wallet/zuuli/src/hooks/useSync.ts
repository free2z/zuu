import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";
import type { SyncStatus } from "../types";

export function useSync() {
  const { setSyncStatus, setBalance, setError } = useWalletStore();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const balance = await api.getAccountBalance(0);
      setBalance(balance);
    } catch (_) {
      // Ignore balance errors during polling
    }
  }, [setBalance]);

  const startSync = useCallback(async () => {
    try {
      await api.startSync();
    } catch (e) {
      setError(String(e));
    }
  }, [setError]);

  const stopSync = useCallback(async () => {
    try {
      await api.stopSync();
    } catch (e) {
      setError(String(e));
    }
  }, [setError]);

  const pollStatus = useCallback(async () => {
    try {
      const status = await api.getSyncStatus();
      setSyncStatus(status);
      refreshBalance();
    } catch (_) {
      // Ignore polling errors
    }
  }, [setSyncStatus, refreshBalance]);

  // Listen for sync progress events from the Rust backend
  useEffect(() => {
    const unlisten = listen<SyncStatus>("zcash://sync-progress", (event) => {
      setSyncStatus(event.payload);
      refreshBalance();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [setSyncStatus, refreshBalance]);

  // Poll sync status every 5 seconds as fallback
  useEffect(() => {
    pollRef.current = setInterval(pollStatus, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollStatus]);

  return { startSync, stopSync, pollStatus };
}
