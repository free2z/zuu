import { useEffect, useState } from "react";
import { useWalletStore } from "../store/wallet";
import { useWallet } from "../hooks/useWallet";
import * as api from "../lib/tauri";
import type { WalletInfo } from "../types";

export function WalletPicker() {
  const { setPage, setError, walletStatus } = useWalletStore();
  const { switchWallet, loadWallets } = useWallet();
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadWallets().then(setWallets);
  }, [loadWallets]);

  const handleSwitch = async (walletId: string) => {
    await switchWallet(walletId);
  };

  const handleRename = async (walletId: string) => {
    if (!renameValue.trim()) return;
    try {
      await api.renameWallet(walletId, renameValue.trim());
      const updated = await api.listWallets();
      setWallets(updated);
      setRenamingId(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (walletId: string) => {
    try {
      await api.deleteWallet(walletId);
      const updated = await api.listWallets();
      setWallets(updated);
      setDeletingId(null);
      if (updated.length === 0) {
        setPage("welcome");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="max-w-lg mx-auto p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">Wallets</h2>
        <button
          onClick={() => setPage("welcome")}
          className="px-4 py-2 text-sm bg-purple-500 hover:bg-purple-600 text-white rounded-xl font-semibold transition-colors"
        >
          + Add Wallet
        </button>
      </div>

      <div className="space-y-3">
        {wallets.map((wallet) => (
          <div
            key={wallet.id}
            className={`p-4 rounded-xl border transition-colors ${
              wallet.isActive
                ? "bg-purple-500/5 border-purple-500/50"
                : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
            }`}
          >
            <div className="flex items-start justify-between">
              <button
                onClick={() => !wallet.isActive && handleSwitch(wallet.id)}
                className="flex-1 text-left"
                aria-label={`${wallet.isActive ? "Active wallet" : "Switch to"}: ${wallet.name}`}
                disabled={wallet.isActive}
              >
                <div className="flex items-center gap-2">
                  {wallet.isActive && (
                    <div className="w-2 h-2 bg-purple-500 rounded-full shrink-0" aria-hidden="true" />
                  )}
                  {renamingId === wallet.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(wallet.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm text-white focus:ring-1 focus:ring-purple-500 focus:outline-none"
                    />
                  ) : (
                    <span className="text-sm font-medium text-white">
                      {wallet.name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 mt-1">
                  Created {(() => {
                    const d = /^\d+$/.test(wallet.createdAt)
                      ? new Date(Number(wallet.createdAt) * 1000)
                      : new Date(wallet.createdAt);
                    return isNaN(d.getTime()) ? "Unknown" : d.toLocaleDateString();
                  })()}
                  {wallet.birthdayHeight != null &&
                    ` \u00b7 Birthday: ${wallet.birthdayHeight.toLocaleString()}`}
                </p>
              </button>

              <div className="flex items-center gap-1 ml-2 shrink-0">
                <button
                  onClick={() => {
                    setRenamingId(wallet.id);
                    setRenameValue(wallet.name);
                  }}
                  className="p-2.5 text-zinc-500 hover:text-white rounded transition-colors min-tap flex items-center justify-center"
                  aria-label={`Rename wallet ${wallet.name}`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
                  </svg>
                </button>
                {!wallet.isActive && wallets.length > 1 && (
                  <>
                    {deletingId === wallet.id ? (
                      <div className="flex items-center gap-1 animate-fade-in">
                        <button
                          onClick={() => handleDelete(wallet.id)}
                          className="px-3 py-2 text-sm bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors min-tap"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          className="px-3 py-2 text-sm text-zinc-500 rounded hover:text-white transition-colors min-tap"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingId(wallet.id)}
                        className="p-2.5 text-zinc-500 hover:text-red-400 rounded transition-colors min-tap flex items-center justify-center"
                        aria-label={`Delete wallet ${wallet.name}`}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {walletStatus?.initialized && (
        <button
          onClick={() => setPage("home")}
          className="mt-6 w-full py-2.5 text-sm text-zinc-500 hover:text-white transition-colors min-tap"
        >
          Back to Wallet
        </button>
      )}
    </div>
  );
}
