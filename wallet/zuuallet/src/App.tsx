import { useEffect, useState } from "react";
import { useWalletStore } from "./store/wallet";
import { useWallet } from "./hooks/useWallet";
import { useSync } from "./hooks/useSync";
import { NavBar } from "./components/NavBar";
import { SyncBar } from "./components/SyncBar";
import { Welcome } from "./pages/Welcome";
import { CreateWallet } from "./pages/CreateWallet";
import { RestoreWallet } from "./pages/RestoreWallet";
import { Home } from "./pages/Home";
import { Send } from "./pages/Send";
import { Receive } from "./pages/Receive";
import { History } from "./pages/History";
import { Settings } from "./pages/Settings";
import { WalletPicker } from "./pages/WalletPicker";
import * as api from "./lib/tauri";

function App() {
  const { page, setPage, error, setError, syncStatus, walletStatus, setWalletStatus } = useWalletStore();
  const [cleanupRetrying, setCleanupRetrying] = useState(false);
  const { checkStatus } = useWallet();
  const { startSync } = useSync();

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Start sync globally once wallet is active
  const showNav = !["welcome", "create", "restore", "wallet-picker"].includes(page);
  useEffect(() => {
    if (showNav && !syncStatus?.syncing) {
      startSync();
    }
  }, [showNav]);

  const renderPage = () => {
    switch (page) {
      case "welcome":
        return <Welcome />;
      case "create":
        return <CreateWallet />;
      case "restore":
        return <RestoreWallet />;
      case "home":
        return <Home />;
      case "send":
        return <Send />;
      case "receive":
        return <Receive />;
      case "history":
        return <History />;
      case "settings":
        return <Settings />;
      case "wallet-picker":
        return <WalletPicker />;
    }
  };

  const retryCleanup = async () => {
    setCleanupRetrying(true);
    try {
      const cleanup = await api.retryWalletCleanup();
      if (walletStatus) setWalletStatus({ ...walletStatus, cleanup });
    } catch (e) {
      setError(String(e));
    } finally {
      setCleanupRetrying(false);
    }
  };

  return (
    <div className="flex h-screen bg-zuuallet-bg">
      {showNav && <NavBar currentPage={page} onNavigate={setPage} />}

      {showNav && <SyncBar syncStatus={syncStatus} />}

      <main id="main-content" className={`flex-1 overflow-y-auto ${showNav ? "pb-16 md:pb-0" : ""}`}>
        {walletStatus?.legacyAppData?.state === "importPending" && (
          <div
            role="status"
            aria-label="Preserved legacy wallet"
            className="bg-amber-900/25 border-b border-amber-700/40 px-4 py-3"
          >
            <p className="text-amber-300 text-sm font-medium">Earlier wallet preserved</p>
            <p className="text-amber-200/70 text-xs mt-1">
              {walletStatus.legacyAppData.diagnostic ??
                "An earlier ZUULI wallet remains safely preserved. This app opened only the current wallet; explicit import is pending."}
            </p>
          </div>
        )}
        {walletStatus?.cleanup &&
          (walletStatus.cleanup.pendingOperations > 0 ||
            walletStatus.cleanup.blockedOperations > 0 ||
            walletStatus.cleanup.diagnostics.length > 0) && (
            <div role="status" className="bg-amber-900/25 border-b border-amber-700/40 px-4 py-3 flex items-start justify-between gap-4">
              <div>
                <p className="text-amber-300 text-sm font-medium">
                  {walletStatus.cleanup.blockedOperations > 0
                    ? "Wallet maintenance needs attention"
                    : walletStatus.cleanup.pendingOperations > 0
                      ? "Wallet maintenance needs another pass"
                      : "Wallet maintenance completed with a recovery note"}
                </p>
                <p className="text-amber-200/70 text-xs mt-1">
                  {walletStatus.cleanup.blockedOperations > 0
                    ? walletStatus.cleanup.diagnostics[0]
                    : walletStatus.cleanup.pendingOperations > 0
                    ? `${walletStatus.cleanup.pendingOperations} cleanup operation(s) remain safely journaled.`
                    : walletStatus.cleanup.diagnostics[0]}
                </p>
              </div>
              {(walletStatus.cleanup.pendingOperations > 0 ||
                walletStatus.cleanup.blockedOperations > 0) && (
                <button
                  type="button"
                  onClick={() => void retryCleanup()}
                  disabled={cleanupRetrying}
                  className="shrink-0 rounded border border-amber-600/60 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-800/30 disabled:opacity-60"
                >
                  {cleanupRetrying ? "Retrying…" : "Retry now"}
                </button>
              )}
            </div>
          )}
        {error && (
          <div role="alert" className="bg-red-900/30 border-b border-red-800/50 px-4 py-2 flex items-center justify-between animate-slide-up">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300 ml-4 p-2.5 rounded hover:bg-red-900/30 transition-colors min-tap flex items-center justify-center"
              aria-label="Dismiss error"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        {renderPage()}
      </main>
    </div>
  );
}

export default App;
