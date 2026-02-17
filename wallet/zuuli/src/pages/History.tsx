import { useEffect, useState } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";
import { formatZecDisplay, formatDate, formatHeight } from "../lib/format";

export function History() {
  const { transactions, mergeTransactions } = useWalletStore();
  const [refreshing, setRefreshing] = useState(false);
  const [expandedTxid, setExpandedTxid] = useState<string | null>(null);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const hasCached = transactions.length > 0;

  useEffect(() => {
    setRefreshing(true);
    api
      .getTransactionHistory(0, 0, 50)
      .then(mergeTransactions)
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);

  const copyTxid = async (txid: string) => {
    await navigator.clipboard.writeText(txid);
    setCopiedTxid(txid);
    setTimeout(() => setCopiedTxid(null), 2000);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">
          Transaction History
        </h2>
        {refreshing && hasCached && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse-dot" aria-hidden="true" />
            Updating
          </span>
        )}
      </div>

      {!hasCached && refreshing ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4 animate-pulse">
              <div className="h-4 w-32 bg-zinc-800 rounded" />
              <div className="h-3 w-48 bg-zinc-800 rounded mt-2" />
            </div>
          ))}
        </div>
      ) : transactions.length === 0 ? (
        <div className="text-center py-16">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3f3f46" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p className="text-zinc-400">No transactions yet</p>
          <p className="text-zinc-500 text-sm mt-1">
            Transactions will appear here after syncing
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {transactions.map((tx) => {
            const isExpanded = expandedTxid === tx.txid;
            const dirLabel = tx.incoming ? "Received" : "Sent";
            const txLabel = `${dirLabel} ${formatZecDisplay(Math.abs(tx.value))} on ${formatDate(tx.timestamp)}`;

            return (
              <div
                key={tx.txid}
                className="bg-zinc-900 border border-zinc-800/50 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => setExpandedTxid(isExpanded ? null : tx.txid)}
                  className="w-full p-4 flex items-center justify-between text-left"
                  aria-expanded={isExpanded}
                  aria-label={txLabel}
                >
                  <div className="flex items-center gap-3">
                    {tx.incoming ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                        <line x1="7" y1="17" x2="17" y2="7" />
                        <polyline points="7 7 7 17 17 17" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                        <line x1="7" y1="17" x2="17" y2="7" />
                        <polyline points="7 7 17 7 17 17" />
                      </svg>
                    )}
                    <div>
                      <p
                        className={`font-medium ${tx.incoming ? "text-emerald-400" : "text-white"}`}
                      >
                        {tx.incoming ? "+" : "-"}
                        {formatZecDisplay(Math.abs(tx.value))}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {formatDate(tx.timestamp)}
                        {tx.blockHeight &&
                          ` · Block ${formatHeight(tx.blockHeight)}`}
                      </p>
                      {tx.memo && !isExpanded && (
                        <p className="text-xs text-zinc-400 mt-1 truncate max-w-xs">
                          {tx.memo}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-zinc-600 font-mono">
                      {tx.txid.slice(0, 8)}...
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`text-zinc-600 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 animate-fade-in border-t border-zinc-800/50">
                    {tx.memo && (
                      <div className="mt-3">
                        <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Memo</p>
                        <p className="text-sm text-zinc-300 break-words">{tx.memo}</p>
                      </div>
                    )}
                    <div className="mt-3">
                      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Transaction ID</p>
                      <button
                        onClick={() => copyTxid(tx.txid)}
                        className="text-xs text-zinc-400 font-mono break-all text-left hover:text-zinc-300 transition-colors min-tap"
                        aria-label="Copy transaction ID"
                      >
                        {tx.txid}
                        {copiedTxid === tx.txid && (
                          <span className="ml-2 text-emerald-400">Copied!</span>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
