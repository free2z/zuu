import { useEffect, useRef, useState } from "react";
import { useWalletStore } from "../store/wallet";
import { SeedPhraseGrid } from "../components/SeedPhraseGrid";
import { createdSeedSession } from "../lib/sensitive-seed";
import * as api from "../lib/tauri";

export function CreateWallet() {
  const { seedPhrase, setPage, setError } = useWalletStore();
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const operationInFlight = useRef(false);

  useEffect(() => {
    const clearSensitiveSeed = () => {
      if (createdSeedSession.hide()) setConfirmed(false);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") clearSensitiveSeed();
    };
    window.addEventListener("blur", clearSensitiveSeed);
    window.addEventListener("pagehide", clearSensitiveSeed);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", clearSensitiveSeed);
      window.removeEventListener("pagehide", clearSensitiveSeed);
      document.removeEventListener("visibilitychange", onVisibility);
      createdSeedSession.cancel();
    };
  }, [setPage]);

  const dismissSeed = (page: "home" | "welcome") => {
    if (operationInFlight.current) return;
    createdSeedSession.cancel();
    setPage(page);
  };

  const confirmBackup = async () => {
    const walletId = createdSeedSession.currentWalletId;
    if (
      !walletId ||
      operationInFlight.current ||
      confirming ||
      createdSeedSession.confirmationPending
    )
      return;
    operationInFlight.current = true;
    setConfirming(true);
    setError(null);
    try {
      const accepted = await createdSeedSession.confirm(
        walletId,
        api.confirmWalletBackup,
      );
      if (accepted) setPage("home");
    } catch (error) {
      // The session deliberately retains the exact identity, phrase, and
      // native protection so the user can retry this acknowledgement safely.
      setError(String(error));
    } finally {
      operationInFlight.current = false;
      setConfirming(false);
    }
  };

  const revealBackup = async () => {
    const walletId = createdSeedSession.currentWalletId;
    if (
      !walletId ||
      operationInFlight.current ||
      revealing ||
      createdSeedSession.confirmationPending
    )
      return;
    operationInFlight.current = true;
    setRevealing(true);
    setError(null);
    try {
      await createdSeedSession.reveal(walletId, (exactWalletId, token) =>
        api.getBackupSeedPhrase(exactWalletId, token),
      );
    } catch (error) {
      setError(String(error));
    } finally {
      operationInFlight.current = false;
      setRevealing(false);
    }
  };

  if (!createdSeedSession.currentWalletId) {
    return (
      <div className="p-8 text-center animate-fade-in">
        <p className="text-red-400">
          No seed phrase generated. Please go back.
        </p>
        <button
          onClick={() => dismissSeed("welcome")}
          className="mt-4 text-purple-400 underline"
        >
          Back to Welcome
        </button>
      </div>
    );
  }

  if (!seedPhrase) {
    return (
      <div className="max-w-lg mx-auto p-8 text-center animate-fade-in">
        <h2 className="text-2xl font-bold text-white mb-2">
          Back Up Your Wallet
        </h2>
        <p className="text-zinc-400 text-sm mb-6">
          Authenticate with your device to reveal this wallet&apos;s recovery
          phrase. The wallet remains marked as not backed up until you confirm
          that you saved it.
        </p>
        <button
          onClick={() => void revealBackup()}
          disabled={
            revealing || confirming || createdSeedSession.confirmationPending
          }
          className="w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-50 min-tap"
        >
          {revealing ? "Authenticating..." : "Authenticate to Reveal Phrase"}
        </button>
        <button
          onClick={() => dismissSeed("welcome")}
          disabled={
            revealing || confirming || createdSeedSession.confirmationPending
          }
          className="mt-3 w-full py-2.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50 min-tap"
        >
          Cancel
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
        the only way to recover your wallet. You can also view this later in
        Settings (device authentication required).
      </p>

      <div aria-hidden="true">
        <SeedPhraseGrid phrase={seedPhrase} />
      </div>

      <div className="mt-6">
        <label className="flex items-start gap-3 cursor-pointer group">
          <span className="relative mt-0.5 shrink-0">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={() => setConfirmed(!confirmed)}
              className="sr-only peer"
              aria-label="I have written down my recovery phrase and stored it securely"
            />
            <span
              className={`block w-6 h-6 rounded border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-purple-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-zinc-950 ${
                confirmed
                  ? "bg-purple-500 border-purple-500"
                  : "border-zinc-600 group-hover:border-zinc-500"
              }`}
            >
              {confirmed && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          </span>
          <span className="text-sm text-zinc-300">
            I have written down my recovery phrase and stored it securely. I
            understand that losing this phrase means losing access to my funds.
          </span>
        </label>
      </div>

      <button
        onClick={() => void confirmBackup()}
        disabled={
          !confirmed || confirming || createdSeedSession.confirmationPending
        }
        className="mt-6 w-full py-3 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {confirming ? "Confirming Backup..." : "Continue to Wallet"}
      </button>

      <button
        onClick={() => dismissSeed("welcome")}
        disabled={confirming || createdSeedSession.confirmationPending}
        className="mt-3 w-full py-2.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors min-tap"
      >
        Cancel
      </button>
    </div>
  );
}
