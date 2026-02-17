import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";
import { formatZecDisplay } from "../lib/format";

export function Send() {
  const { balance, setError } = useWalletStore();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [txid, setTxid] = useState<string | null>(null);

  const handleSend = async () => {
    if (!to || !amount) return;

    const zatoshis = Math.round(parseFloat(amount) * 1e8);
    if (isNaN(zatoshis) || zatoshis <= 0) {
      setError("Invalid amount");
      return;
    }

    setSending(true);
    try {
      const result = await api.sendTransaction(
        to,
        zatoshis,
        memo || undefined,
      );
      setTxid(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  if (txid) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center animate-fade-in">
        <div className="mb-4">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-emerald-400 mb-4">Sent!</h2>
        <p className="text-sm text-zinc-400 mb-2">Transaction ID:</p>
        <code className="text-xs text-white break-all font-mono">{txid}</code>
        <button
          onClick={() => {
            setTxid(null);
            setTo("");
            setAmount("");
            setMemo("");
          }}
          className="mt-6 w-full py-3 border-2 border-purple-500 text-purple-400 rounded-xl hover:bg-purple-500/10 transition-colors"
        >
          Send Another
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-lg mx-auto animate-fade-in">
      <h2 className="text-2xl font-bold text-white mb-6">Send ZEC</h2>

      {balance && (
        <p className="text-sm text-zinc-400 mb-4">
          Available: {formatZecDisplay(balance.spendable)}
        </p>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Recipient Address
          </label>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Unified, Sapling, or transparent address"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Amount (ZEC)
          </label>
          <input
            type="number"
            step="0.00000001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00000000"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Memo (optional)
          </label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Encrypted memo (up to 512 bytes)"
            rows={3}
            maxLength={512}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none resize-none"
          />
          <p className="text-xs text-zinc-500 mt-1">
            {memo.length}/512 characters
          </p>
        </div>
      </div>

      <button
        onClick={handleSend}
        disabled={!to || !amount || sending}
        className="mt-6 w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {sending ? "Sending..." : "Send Transaction"}
      </button>
    </div>
  );
}
