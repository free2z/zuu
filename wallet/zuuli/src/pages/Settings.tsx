import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import { SeedPhraseGrid } from "../components/SeedPhraseGrid";
import * as api from "../lib/tauri";

const SERVERS = [
  { label: "zec.rocks (default)", url: "https://zec.rocks:443" },
  { label: "na.zec.rocks (North America)", url: "https://na.zec.rocks:443" },
  { label: "eu.zec.rocks (Europe)", url: "https://eu.zec.rocks:443" },
  { label: "ap.zec.rocks (Asia Pacific)", url: "https://ap.zec.rocks:443" },
];

function RevealSection({
  title,
  description,
  onReveal,
  renderContent,
}: {
  title: string;
  description: string;
  onReveal: () => Promise<string>;
  renderContent?: (value: string) => JSX.Element;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReveal = async () => {
    if (value) {
      setValue(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await onReveal();
      setValue(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-white mb-1">{title}</h3>
      <p className="text-xs text-zinc-500 mb-3">{description}</p>
      <button
        onClick={handleReveal}
        disabled={loading}
        className="px-4 py-2 text-sm rounded-xl border border-zinc-700 text-zinc-300 hover:border-purple-500/50 hover:text-purple-400 transition-colors disabled:opacity-50"
      >
        {loading ? "Authenticating..." : value ? "Hide" : "Reveal"}
      </button>
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
      {value && (
        <div className="mt-3 animate-fade-in">
          {renderContent ? (
            renderContent(value)
          ) : (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
              <p className="text-xs text-white font-mono break-all select-all">
                {value}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SeedPhraseSection() {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockPhrase, setUnlockPhrase] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const wordCount = unlockPhrase.trim() ? unlockPhrase.trim().split(/\s+/).length : 0;
  const badgeClass =
    wordCount < 12
      ? "bg-red-500/10 text-red-400"
      : wordCount < 24
        ? "bg-amber-500/10 text-amber-400"
        : "bg-emerald-500/10 text-emerald-400";

  const handleReveal = async () => {
    if (phrase) {
      setPhrase(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.getSeedPhrase();
      setPhrase(result);
      setShowUnlock(false);
    } catch {
      setError(null);
      setShowUnlock(true);
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async () => {
    setUnlocking(true);
    setError(null);
    try {
      await api.unlockWallet(unlockPhrase.trim());
      const result = await api.getSeedPhrase();
      setPhrase(result);
      setShowUnlock(false);
      setUnlockPhrase("");
    } catch (e) {
      setError(String(e));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-white mb-1">Recovery Phrase</h3>
      <p className="text-xs text-zinc-500 mb-3">
        Your 24-word seed phrase. Device authentication required.
      </p>
      <button
        onClick={handleReveal}
        disabled={loading}
        className="px-4 py-2 text-sm rounded-xl border border-zinc-700 text-zinc-300 hover:border-purple-500/50 hover:text-purple-400 transition-colors disabled:opacity-50"
      >
        {loading ? "Authenticating..." : phrase ? "Hide" : "Reveal"}
      </button>

      {showUnlock && !phrase && (
        <div className="mt-3 animate-fade-in">
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl mb-3">
            <p className="text-amber-400 text-sm font-medium">
              Seed phrase not found in secure storage
            </p>
            <p className="text-amber-400/70 text-xs mt-1">
              Enter your recovery phrase to re-link it to this wallet.
              It will be validated against the wallet's viewing key.
            </p>
          </div>
          <textarea
            value={unlockPhrase}
            onChange={(e) => setUnlockPhrase(e.target.value)}
            placeholder="Enter your seed phrase words separated by spaces..."
            rows={3}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm font-mono focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none resize-none"
          />
          <div className="flex items-center gap-2 mt-1 mb-2">
            {wordCount > 0 ? (
              <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass}`}>
                {wordCount} words
              </span>
            ) : (
              <span className="text-xs text-zinc-500">0 words entered</span>
            )}
          </div>
          <button
            onClick={handleUnlock}
            disabled={unlocking || wordCount < 12}
            className="px-5 py-2 bg-purple-500 hover:bg-purple-600 text-white text-sm rounded-xl font-semibold transition-colors disabled:opacity-50"
          >
            {unlocking ? "Verifying..." : "Unlock"}
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

      {phrase && (
        <div className="mt-3 animate-fade-in">
          <SeedPhraseGrid phrase={phrase} />
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const { lightwalletdUrl, setLightwalletdUrl, setPage, setError, walletStatus } =
    useWalletStore();
  const [url, setUrl] = useState(lightwalletdUrl);
  const [saved, setSaved] = useState(false);
  const [useCustom, setUseCustom] = useState(
    !SERVERS.some((s) => s.url === lightwalletdUrl),
  );

  const handleSelect = (serverUrl: string) => {
    setUseCustom(false);
    setUrl(serverUrl);
  };

  const handleSave = async () => {
    try {
      await api.setLightwalletdUrl(url);
      setLightwalletdUrl(url);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  const isSelected = (serverUrl: string) => !useCustom && url === serverUrl;

  return (
    <div className="p-6 max-w-lg mx-auto animate-fade-in">
      <h2 className="text-2xl font-bold text-white mb-6">Settings</h2>

      <div className="space-y-6">
        {/* Wallet Management */}
        {(walletStatus?.walletCount ?? 0) > 0 && (
          <div>
            <h3 className="text-sm font-medium text-white mb-2">Wallet</h3>
            <p className="text-xs text-zinc-400 mb-3">
              Active: {walletStatus?.activeWalletName ?? "Unknown"}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage("wallet-picker")}
                className="px-4 py-2 text-sm rounded-xl border border-zinc-700 text-zinc-300 hover:border-purple-500/50 hover:text-purple-400 transition-colors"
              >
                Switch Wallet
              </button>
            </div>
          </div>
        )}

        {/* Recovery Phrase */}
        <div className="border-t border-zinc-800/50 pt-6">
          <SeedPhraseSection />
        </div>

        {/* Viewing Key */}
        <div className="border-t border-zinc-800/50 pt-6">
          <RevealSection
            title="Unified Full Viewing Key"
            description="Share to let others see your transaction history. Cannot spend funds."
            onReveal={() => api.getViewingKey(0)}
          />
        </div>

        {/* Spending Key Status */}
        <div className="border-t border-zinc-800/50 pt-6">
          <RevealSection
            title="Spending Key"
            description="Verify spending authority is available for this wallet."
            onReveal={async () => {
              const status = await api.getSpendingKey(0);
              return status.message;
            }}
          />
        </div>

        {/* Server Selection */}
        <div className="border-t border-zinc-800/50 pt-6">
          <label className="block text-sm text-zinc-400 mb-3">
            Lightwalletd Server
          </label>
          <div className="space-y-2">
            {SERVERS.map((server) => (
              <button
                key={server.url}
                onClick={() => handleSelect(server.url)}
                className={`w-full text-left p-3 rounded-xl border transition-colors ${
                  isSelected(server.url)
                    ? "bg-purple-500/5 border-purple-500/50"
                    : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isSelected(server.url)
                        ? "border-purple-500 bg-purple-500"
                        : "border-zinc-600"
                    }`}
                  >
                    {isSelected(server.url) && (
                      <div className="w-1.5 h-1.5 bg-white rounded-full" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-white">{server.label}</p>
                    <p className="text-xs text-zinc-500 font-mono">
                      {server.url}
                    </p>
                  </div>
                </div>
              </button>
            ))}

            <button
              onClick={() => setUseCustom(true)}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${
                useCustom
                  ? "bg-purple-500/5 border-purple-500/50"
                  : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    useCustom
                      ? "border-purple-500 bg-purple-500"
                      : "border-zinc-600"
                  }`}
                >
                  {useCustom && (
                    <div className="w-1.5 h-1.5 bg-white rounded-full" />
                  )}
                </div>
                <p className="text-sm text-white">Custom URL</p>
              </div>
            </button>

            {useCustom && (
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-server:443"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm font-mono focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none animate-fade-in"
              />
            )}
          </div>

          <p className="text-xs text-zinc-500 mt-2">
            gRPC endpoint for blockchain data
          </p>

          <button
            onClick={handleSave}
            className="mt-3 px-5 py-2 bg-purple-500 hover:bg-purple-600 text-white text-sm rounded-xl font-semibold transition-colors"
          >
            {saved ? (
              <span className="animate-fade-in">Saved!</span>
            ) : (
              "Save"
            )}
          </button>
        </div>

        <div className="border-t border-zinc-800/50 pt-6">
          <h3 className="text-sm font-medium text-white mb-2">Network</h3>
          <p className="text-xs text-zinc-400">Zcash Mainnet</p>
        </div>

        <div className="border-t border-zinc-800/50 pt-6">
          <h3 className="text-sm font-medium text-white mb-2">About</h3>
          <p className="text-xs text-zinc-400">ZUULI v0.1.0</p>
          <p className="text-xs text-zinc-500 mt-1">Shielded by default.</p>
        </div>
      </div>
    </div>
  );
}
