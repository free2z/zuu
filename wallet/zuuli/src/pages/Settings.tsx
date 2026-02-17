import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";

const SERVERS = [
  { label: "zec.rocks (default)", url: "https://zec.rocks:443" },
  { label: "na.zec.rocks (North America)", url: "https://na.zec.rocks:443" },
  { label: "eu.zec.rocks (Europe)", url: "https://eu.zec.rocks:443" },
  { label: "ap.zec.rocks (Asia Pacific)", url: "https://ap.zec.rocks:443" },
];

export function Settings() {
  const { lightwalletdUrl, setLightwalletdUrl, setError } = useWalletStore();
  const [url, setUrl] = useState(lightwalletdUrl);
  const [saved, setSaved] = useState(false);
  const [useCustom, setUseCustom] = useState(
    !SERVERS.some((s) => s.url === lightwalletdUrl)
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
        <div>
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
                    <p className="text-xs text-zinc-500 font-mono">{server.url}</p>
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
          <p className="text-xs text-zinc-500 mt-1">
            Shielded by default.
          </p>
        </div>
      </div>
    </div>
  );
}
