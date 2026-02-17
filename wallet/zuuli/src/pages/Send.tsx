import { useState, useEffect, useCallback, useRef } from "react";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";
import { formatZecDisplay, formatZec, truncateAddress } from "../lib/format";
import type { AddressValidation } from "../types";
import { QrScanner } from "../components/QrScanner";

const STANDARD_FEE = 10000; // 0.0001 ZEC (zip317 standard)

type SendStep = "form" | "review" | "sending" | "success" | "error";

export function Send() {
  const { balance } = useWalletStore();

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [step, setStep] = useState<SendStep>("form");
  const [txid, setTxid] = useState<string | null>(null);
  const [sendingStatus, setSendingStatus] = useState("Creating transaction...");
  const [sendError, setSendError] = useState<string | null>(null);

  // Address validation
  const [addressValidation, setAddressValidation] =
    useState<AddressValidation | null>(null);
  const [validatingAddress, setValidatingAddress] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // QR scanner
  const [showScanner, setShowScanner] = useState(false);

  // ZIP-321 indicator
  const [filledFromUri, setFilledFromUri] = useState(false);

  const spendable = balance?.spendable ?? 0;

  // Validate address with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!to.trim()) {
      setAddressValidation(null);
      setValidatingAddress(false);
      return;
    }

    setValidatingAddress(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.validateAddress(to.trim());
        setAddressValidation(result);
      } catch {
        setAddressValidation({ valid: false, addressType: null, canReceiveMemo: false });
      }
      setValidatingAddress(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [to]);

  // Parse amount to zatoshis
  const zatoshis = Math.round(parseFloat(amount) * 1e8);
  const validAmount = !isNaN(zatoshis) && zatoshis > 0;
  const exceedsBalance = validAmount && zatoshis > spendable;
  const memoBytes = new TextEncoder().encode(memo).length;
  const showMemo = addressValidation?.canReceiveMemo !== false;

  const canSend =
    addressValidation?.valid &&
    validAmount &&
    !exceedsBalance &&
    memoBytes <= 512;

  // Handle pasting — detect zcash: URIs
  const handleAddressChange = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.startsWith("zcash:")) {
        try {
          const parsed = await api.parsePaymentUri(trimmed);
          setTo(parsed.address);
          if (parsed.amount) {
            setAmount(formatZec(parsed.amount));
          }
          if (parsed.memo) {
            setMemo(parsed.memo);
          }
          setFilledFromUri(true);
          return;
        } catch {
          // Not a valid URI, treat as raw text
        }
      }
      setTo(trimmed);
      setFilledFromUri(false);
    },
    [],
  );

  const handleMax = () => {
    const maxAmount = spendable - STANDARD_FEE;
    if (maxAmount > 0) {
      setAmount(formatZec(maxAmount));
    }
  };

  const handleSend = async () => {
    if (!canSend) return;
    setStep("sending");
    setSendingStatus("Creating transaction...");
    setSendError(null);

    try {
      setSendingStatus("Broadcasting...");
      const result = await api.sendTransaction(
        to.trim(),
        zatoshis,
        memo || undefined,
      );
      setTxid(result);
      setStep("success");
    } catch (e) {
      setSendError(String(e));
      setStep("error");
    }
  };

  const resetForm = () => {
    setTo("");
    setAmount("");
    setMemo("");
    setTxid(null);
    setStep("form");
    setSendError(null);
    setFilledFromUri(false);
    setAddressValidation(null);
  };

  const handleQrScan = useCallback(
    (data: string) => {
      setShowScanner(false);
      handleAddressChange(data);
    },
    [handleAddressChange],
  );

  // --- Success state ---
  if (step === "success") {
    return (
      <div className="p-6 max-w-lg mx-auto text-center animate-fade-in">
        <div className="mb-4">
          <svg
            width="56"
            height="56"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto"
          >
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-emerald-400 mb-2">Sent!</h2>
        <p className="text-sm text-zinc-400 mb-2">Transaction ID:</p>
        <button
          onClick={() => {
            if (txid) navigator.clipboard.writeText(txid);
          }}
          className="text-xs text-zinc-300 break-all font-mono bg-zinc-900 px-3 py-2 rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer border border-zinc-800 inline-block max-w-full"
          title="Click to copy"
        >
          {txid}
        </button>
        <div className="flex gap-3 mt-6">
          <button
            onClick={resetForm}
            className="flex-1 py-3 border-2 border-purple-500 text-purple-400 rounded-xl hover:bg-purple-500/10 transition-colors"
          >
            Send Another
          </button>
          <button
            onClick={() => useWalletStore.getState().setPage("home")}
            className="flex-1 py-3 bg-zinc-800 text-zinc-300 rounded-xl hover:bg-zinc-700 transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (step === "error") {
    return (
      <div className="p-6 max-w-lg mx-auto text-center animate-fade-in">
        <div className="mb-4">
          <svg
            width="56"
            height="56"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f87171"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-red-400 mb-2">
          Transaction Failed
        </h2>
        <p className="text-sm text-zinc-400 break-all mb-6">{sendError}</p>
        <div className="flex gap-3">
          <button
            onClick={() => setStep("form")}
            className="flex-1 py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={resetForm}
            className="flex-1 py-3 bg-zinc-800 text-zinc-300 rounded-xl hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --- Sending state ---
  if (step === "sending") {
    return (
      <div className="p-6 max-w-lg mx-auto flex flex-col items-center justify-center min-h-[300px] animate-fade-in">
        <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-6" />
        <p className="text-lg text-white font-medium">{sendingStatus}</p>
        <p className="text-sm text-zinc-500 mt-2">
          This may take a moment...
        </p>
      </div>
    );
  }

  // --- Review step ---
  if (step === "review") {
    return (
      <div className="p-6 max-w-lg mx-auto animate-fade-in">
        <h2 className="text-2xl font-bold text-white mb-6">
          Review Transaction
        </h2>

        <div className="space-y-4 bg-zinc-900 rounded-xl p-4 border border-zinc-800">
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Recipient
            </p>
            <p className="text-sm text-white font-mono break-all">
              {truncateAddress(to, 16)}
            </p>
            {addressValidation?.addressType && (
              <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 capitalize">
                {addressValidation.addressType}
              </span>
            )}
          </div>

          <div className="border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Amount
            </p>
            <p className="text-lg text-white font-semibold">
              {formatZecDisplay(zatoshis)}
            </p>
          </div>

          {memo && (
            <div className="border-t border-zinc-800 pt-3">
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
                Memo
              </p>
              <p className="text-sm text-zinc-300 break-words">{memo}</p>
            </div>
          )}

          <div className="border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Network Fee
            </p>
            <p className="text-sm text-zinc-300">
              {formatZecDisplay(STANDARD_FEE)}
            </p>
          </div>

          <div className="border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Total Deducted
            </p>
            <p className="text-lg text-white font-bold">
              {formatZecDisplay(zatoshis + STANDARD_FEE)}
            </p>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={handleSend}
            className="flex-1 py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors"
          >
            Confirm Send
          </button>
          <button
            onClick={() => setStep("form")}
            className="flex-1 py-3 bg-zinc-800 text-zinc-300 rounded-xl hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --- Form step ---
  return (
    <div className="p-6 max-w-lg mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">Send ZEC</h2>
        {balance && (
          <span className="text-sm px-3 py-1 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
            {formatZecDisplay(spendable)}
          </span>
        )}
      </div>

      {filledFromUri && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 text-sm">
          Filled from payment request
        </div>
      )}

      <div className="space-y-4">
        {/* Address input */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Recipient Address
          </label>
          <div className="relative">
            <input
              type="text"
              value={to}
              onChange={(e) => handleAddressChange(e.target.value)}
              placeholder="Unified, Sapling, or transparent address"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 pr-20 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    handleAddressChange(text);
                  } catch {
                    // Clipboard permission denied — ignore silently
                  }
                }}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Paste"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
              <button
                onClick={() => setShowScanner(true)}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Scan QR code"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7V5a2 2 0 012-2h2" />
                  <path d="M17 3h2a2 2 0 012 2v2" />
                  <path d="M21 17v2a2 2 0 01-2 2h-2" />
                  <path d="M7 21H5a2 2 0 01-2-2v-2" />
                  <rect x="7" y="7" width="10" height="10" rx="1" />
                </svg>
              </button>
            </div>
          </div>

          {/* Validation indicator */}
          {to.trim() && (
            <div className="flex items-center gap-2 mt-1.5">
              {validatingAddress ? (
                <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              ) : addressValidation?.valid ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#34d399"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f87171"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              )}
              {!validatingAddress && addressValidation?.valid && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 capitalize">
                  {addressValidation.addressType}
                </span>
              )}
              {!validatingAddress && !addressValidation?.valid && (
                <span className="text-xs text-red-400">Invalid address</span>
              )}
            </div>
          )}
        </div>

        {/* Amount input */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            Amount (ZEC)
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.00000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00000000"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 pr-16 text-white text-sm font-mono placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none"
            />
            <button
              onClick={handleMax}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-semibold text-purple-400 bg-purple-500/10 rounded-lg hover:bg-purple-500/20 transition-colors"
            >
              MAX
            </button>
          </div>
          {validAmount && (
            <p className="text-xs text-zinc-500 mt-1">
              = {zatoshis.toLocaleString()} zatoshis
            </p>
          )}
          {exceedsBalance && (
            <p className="text-xs text-red-400 mt-1">
              Exceeds spendable balance ({formatZecDisplay(spendable)})
            </p>
          )}
        </div>

        {/* Memo */}
        {showMemo && (
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Memo (optional)
            </label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Encrypted memo (up to 512 bytes)"
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-white text-sm placeholder-zinc-600 focus:ring-2 focus:ring-purple-500 focus:border-transparent focus:outline-none resize-none"
            />
            <p
              className={`text-xs mt-1 ${memoBytes > 512 ? "text-red-400" : "text-zinc-500"}`}
            >
              {memoBytes}/512 bytes
            </p>
          </div>
        )}

        {/* Fee display */}
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/50 rounded-lg border border-zinc-800/50">
          <span className="text-xs text-zinc-500">Network fee</span>
          <span className="text-xs text-zinc-400">
            {formatZecDisplay(STANDARD_FEE)}
          </span>
        </div>
      </div>

      <button
        onClick={() => setStep("review")}
        disabled={!canSend}
        className="mt-6 w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Review & Send
      </button>

      {showScanner && (
        <QrScanner
          onScan={handleQrScan}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
