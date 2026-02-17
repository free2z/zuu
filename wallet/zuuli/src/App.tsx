import { useEffect } from "react";
import { useWalletStore } from "./store/wallet";
import { useWallet } from "./hooks/useWallet";
import { NavBar } from "./components/NavBar";
import { Welcome } from "./pages/Welcome";
import { CreateWallet } from "./pages/CreateWallet";
import { RestoreWallet } from "./pages/RestoreWallet";
import { Home } from "./pages/Home";
import { Send } from "./pages/Send";
import { Receive } from "./pages/Receive";
import { History } from "./pages/History";
import { Settings } from "./pages/Settings";

function App() {
  const { page, setPage, error, setError } = useWalletStore();
  const { checkStatus } = useWallet();

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const showNav = !["welcome", "create", "restore"].includes(page);

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
    }
  };

  return (
    <div className="flex h-screen bg-zuuli-bg">
      {showNav && <NavBar currentPage={page} onNavigate={setPage} />}

      <main className={`flex-1 overflow-y-auto ${showNav ? "pb-16 md:pb-0" : ""}`}>
        {error && (
          <div className="bg-red-900/30 border-b border-red-800/50 px-4 py-2 flex items-center justify-between animate-slide-up">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300 ml-4 p-1 rounded hover:bg-red-900/30 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
