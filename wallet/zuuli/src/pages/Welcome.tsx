import { useWalletStore } from "../store/wallet";
import { useWallet } from "../hooks/useWallet";

export function Welcome() {
  const { setPage } = useWalletStore();
  const { createWallet } = useWallet();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 animate-fade-in">
      <h1
        className="text-6xl font-bold text-white mb-4 tracking-tight"
        style={{ textShadow: "0 0 40px rgba(168, 85, 247, 0.2)" }}
      >
        ZUULI
      </h1>
      <p className="text-zinc-400 text-center mb-16 max-w-md">
        A private, cross-platform Zcash wallet.
      </p>

      <div className="flex flex-col gap-4 w-full max-w-xs">
        <button
          onClick={createWallet}
          className="w-full py-3.5 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors"
        >
          Create New Wallet
        </button>
        <button
          onClick={() => setPage("restore")}
          className="w-full py-3.5 border-2 border-purple-500/50 text-purple-400 rounded-xl hover:bg-purple-500/10 transition-colors"
        >
          Restore from Seed Phrase
        </button>
      </div>

      <p className="text-xs text-zinc-600 mt-12">
        Shielded by default
      </p>
    </div>
  );
}
