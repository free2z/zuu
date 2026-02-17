import { useEffect } from "react";
import { useWalletStore } from "../store/wallet";
import { useSync } from "../hooks/useSync";
import { useBalance } from "../hooks/useBalance";
import { BalanceDisplay } from "../components/BalanceDisplay";
import { SyncProgress } from "../components/SyncProgress";

export function Home() {
  const { balance, syncStatus, walletStatus, setPage } = useWalletStore();
  const { startSync } = useSync();
  const { refreshBalance } = useBalance();

  useEffect(() => {
    if (!syncStatus?.syncing) {
      startSync();
    }
    refreshBalance();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 animate-fade-in">
      {walletStatus && !walletStatus.hasSeed && (
        <div className="w-full max-w-xs mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
          <p className="text-amber-400 text-sm font-medium">View-only mode</p>
          <p className="text-amber-400/70 text-xs mt-1">
            Enter your recovery phrase in Settings to enable spending.
          </p>
          <button
            onClick={() => setPage("settings")}
            className="mt-2 text-xs text-amber-400 underline hover:text-amber-300"
          >
            Go to Settings
          </button>
        </div>
      )}
      <BalanceDisplay balance={balance} />

      <div className="mt-4">
        <SyncProgress syncStatus={syncStatus} />
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3 w-full max-w-xs">
        <button
          onClick={() => setPage("send")}
          className="flex items-center justify-center gap-2 py-4 bg-purple-500 hover:bg-purple-600 text-white rounded-xl transition-colors font-semibold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
          Send
        </button>
        <button
          onClick={() => setPage("receive")}
          className="flex items-center justify-center gap-2 py-4 bg-purple-500 hover:bg-purple-600 text-white rounded-xl transition-colors font-semibold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
          Receive
        </button>
      </div>
    </div>
  );
}
