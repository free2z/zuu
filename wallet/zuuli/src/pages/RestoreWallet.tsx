import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import { useWallet } from "../hooks/useWallet";

export function RestoreWallet() {
  const { setPage, error, walletStatus } = useWalletStore();
  const { restoreWallet } = useWallet();
  const [phrase, setPhrase] = useState("");
  const [birthday, setBirthday] = useState("");
  const [name, setName] = useState("");

  const handleRestore = async () => {
    const height = birthday ? parseInt(birthday, 10) : undefined;
    await restoreWallet(phrase.trim(), height, name.trim() || undefined);
  };

  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const hasWallets = (walletStatus?.walletCount ?? 0) > 0;

  const badgeClass =
    wordCount < 12
      ? "bg-red-500/10 text-red-400"
      : wordCount < 24
        ? "bg-amber-500/10 text-amber-400"
        : "bg-emerald-500/10 text-emerald-400";

  return (
    <div className="max-w-lg mx-auto p-8 animate-fade-in">
      <h2 className="text-2xl font-bold text-white mb-2">Restore Wallet</h2>
      <p className="text-zinc-400 text-sm mb-6">
        Enter your 24-word recovery phrase to restore your wallet.
      </p>

      <div className="mb-4">
        <label className="block text-sm text-zinc-400 mb-1">
          Wallet Name (optional)
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Restored Wallet"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
        />
      </div>

      <div className="mb-4">
        <label className="block text-sm text-zinc-400 mb-1">
          Recovery Phrase
        </label>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="Enter your seed phrase words separated by spaces..."
          rows={4}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none resize-none"
        />
        <div className="flex items-center gap-2 mt-1">
          {wordCount > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass}`}>
              {wordCount} words
            </span>
          )}
          {wordCount === 0 && (
            <span className="text-xs text-zinc-500">0 words entered</span>
          )}
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm text-zinc-400 mb-1">
          Birthday Height (optional)
        </label>
        <input
          type="number"
          value={birthday}
          onChange={(e) => setBirthday(e.target.value)}
          placeholder="Block height when wallet was created"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
        />
        <p className="text-xs text-zinc-500 mt-1">
          Speeds up sync by skipping blocks before this height
        </p>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <button
        onClick={handleRestore}
        disabled={wordCount < 12}
        className="w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Restore Wallet
      </button>

      <button
        onClick={() => setPage(hasWallets ? "wallet-picker" : "welcome")}
        className="mt-3 w-full py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
