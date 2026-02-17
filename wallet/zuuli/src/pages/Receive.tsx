import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AddressCard } from "../components/AddressCard";
import { useWalletStore } from "../store/wallet";
import * as api from "../lib/tauri";

export function Receive() {
  const { unifiedAddress, setUnifiedAddress } = useWalletStore();
  const [error, setError] = useState<string | null>(null);

  const fetchAddress = () => {
    setError(null);
    api
      .getUnifiedAddress(0)
      .then((addr) => {
        setUnifiedAddress(addr);
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    if (!unifiedAddress) {
      fetchAddress();
    }
  }, []);

  return (
    <div className="p-6 max-w-lg mx-auto animate-fade-in">
      <h2 className="text-2xl font-bold text-white mb-6">Receive ZEC</h2>

      <p className="text-sm text-zinc-400 mb-4">
        Share your unified address to receive shielded Zcash payments.
      </p>

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 mb-4">
          <p className="text-red-400 text-sm mb-3">{error}</p>
          <button
            onClick={fetchAddress}
            className="text-sm text-purple-400 hover:text-purple-300 transition-colors py-2 px-3 rounded-lg min-tap"
          >
            Retry
          </button>
        </div>
      )}

      {unifiedAddress ? (
        <>
          <div className="flex justify-center mb-4">
            <div
              className="bg-white p-6 rounded-2xl shadow-glow-purple"
              role="img"
              aria-label="QR code for Zcash address"
            >
              <QRCodeSVG value={unifiedAddress} size={200} />
            </div>
          </div>
          <AddressCard address={unifiedAddress} label="Unified Address" />
        </>
      ) : !error ? (
        <div className="flex justify-center mb-4" role="status" aria-label="Loading address">
          <div className="bg-zinc-800 p-6 rounded-2xl animate-pulse">
            <div className="w-[200px] h-[200px] rounded-lg bg-zinc-700" />
          </div>
        </div>
      ) : null}

      <div className="mt-6 bg-zuuli-surface border border-zinc-800/50 rounded-xl p-4">
        <h3 className="text-sm font-medium text-white mb-2">About Unified Addresses</h3>
        <p className="text-xs text-zinc-400">
          Unified addresses contain receivers for multiple Zcash pools
          (Orchard, Sapling, and optionally transparent). Senders will
          automatically use the most private pool available.
        </p>
      </div>
    </div>
  );
}
