import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import { SeedPhraseGrid } from "../components/SeedPhraseGrid";

export function CreateWallet() {
  const { seedPhrase, setPage } = useWalletStore();
  const [confirmed, setConfirmed] = useState(false);

  if (!seedPhrase) {
    return (
      <div className="p-8 text-center animate-fade-in">
        <p className="text-red-400">No seed phrase generated. Please go back.</p>
        <button
          onClick={() => setPage("welcome")}
          className="mt-4 text-purple-400 underline"
        >
          Back to Welcome
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-8 animate-fade-in">
      <h2 className="text-2xl font-bold text-white mb-2">
        Your Recovery Phrase
      </h2>
      <p className="text-zinc-400 text-sm mb-6">
        Write down these words in order and store them in a safe place. This is
        the only way to recover your wallet.
      </p>

      <SeedPhraseGrid phrase={seedPhrase} />

      <div className="mt-6">
        <label className="flex items-start gap-3 cursor-pointer group">
          <div
            onClick={() => setConfirmed(!confirmed)}
            className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              confirmed
                ? "bg-purple-500 border-purple-500"
                : "border-zinc-600 group-hover:border-zinc-500"
            }`}
          >
            {confirmed && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
          <span className="text-sm text-zinc-300">
            I have written down my recovery phrase and stored it securely. I
            understand that losing this phrase means losing access to my funds.
          </span>
        </label>
      </div>

      <button
        onClick={() => setPage("home")}
        disabled={!confirmed}
        className="mt-6 w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Continue to Wallet
      </button>

      <button
        onClick={() => setPage("welcome")}
        className="mt-3 w-full py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
