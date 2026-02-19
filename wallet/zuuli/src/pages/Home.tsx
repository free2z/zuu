import { useEffect } from "react";
import { useWalletStore } from "../store/wallet";
import { useBalance } from "../hooks/useBalance";
import { BalanceDisplay } from "../components/BalanceDisplay";

export function Home() {
  const { balance, walletStatus, setPage } = useWalletStore();
  const { refreshBalance } = useBalance();

  useEffect(() => {
    refreshBalance();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 animate-fade-in">
      {walletStatus && !walletStatus.hasSeed && (
        <div className="w-full max-w-xs mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl" role="alert">
          <p className="text-amber-400 text-sm font-medium">View-only mode</p>
          <p className="text-amber-400/70 text-xs mt-1">
            Enter your recovery phrase in Settings to enable spending.
          </p>
          <button
            onClick={() => setPage("settings")}
            className="mt-2 w-full py-2.5 text-sm text-amber-400 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 transition-colors min-tap"
          >
            Go to Settings
          </button>
        </div>
      )}
      <BalanceDisplay balance={balance} />

      <div className="mt-8 grid grid-cols-2 gap-3 w-full max-w-xs">
        <button
          onClick={() => setPage("send")}
          className="flex items-center justify-center gap-2 py-4 bg-purple-500 hover:bg-purple-600 text-white rounded-xl transition-colors font-semibold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
          Send
        </button>
        <button
          onClick={() => setPage("receive")}
          className="flex items-center justify-center gap-2 py-4 bg-purple-500 hover:bg-purple-600 text-white rounded-xl transition-colors font-semibold"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
          Receive
        </button>
      </div>
    </div>
  );
}
