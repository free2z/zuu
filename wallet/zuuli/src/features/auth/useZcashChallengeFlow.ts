// The shared Login-with-Zcash state machine.
//
// Drives the challenge/response flow end-to-end:
//   prepare identity → request challenge → sign (ZIP-304) → verify → done.
//
// The wallet key never leaves the device: free2z issues a one-time challenge
// for the wallet's address, the wallet signs that exact challenge, and only
// the { address, challenge, signature } triple is sent back. What differs
// between CALLERS is only the final network call and what happens after it
// succeeds:
//   - `useZcashLogin` — POSTs anonymously; the backend logs in (or creates)
//     the account for that address and mints a session.
//   - `useZcashAssociate` — POSTs WITH the current session's knox token
//     attached (not anonymous); the backend links the address to the
//     signed-in account instead.
// Both reuse this exact stepper so the crypto is never duplicated.

import { useCallback, useEffect, useRef, useState } from "react";
import { wallet } from "@/lib/wallet/bridge";
import type { SignedChallenge } from "@/lib/wallet/types";
import { auth } from "@/lib/api/free2z";
import type { AuthUser } from "@/lib/api/types";
import {
  useAttemptLease,
  type IsCurrentAttempt,
} from "@/hooks/useAttemptLease";
import { useWallet } from "@/store/wallet";
import {
  SensitiveSeedSession,
  walletSensitiveSeedAuthority,
} from "@/lib/wallet/sensitive-seed";

export type StepKey = "prepare" | "challenge" | "sign" | "verify";
export type StepStatus = "pending" | "active" | "done" | "error";

export type Phase =
  | "idle" // nothing started yet
  | "running" // walking the crypto steps
  | "needsWallet" // no wallet on device — choose restore or create
  | "restoreIdentity" // entering an existing recovery phrase
  | "restoring" // native restore is atomically publishing that identity
  | "creating" // minting a fresh identity
  | "backupRequired" // durable backup gate resumed from native custody
  | "loadingSeed" // authenticating native custody for an explicit reveal
  | "seedReveal" // showing the recovery phrase for backup
  | "confirmingBackup" // durably clearing the native backup gate
  | "success"
  | "error";

export const STEP_ORDER: StepKey[] = ["prepare", "challenge", "sign", "verify"];

export interface StepMeta {
  key: StepKey;
  title: string;
  /** One-line explainer of what is happening cryptographically. */
  detail: string;
}

type Steps = Record<StepKey, StepStatus>;

const freshSteps = (): Steps => ({
  prepare: "pending",
  challenge: "pending",
  sign: "pending",
  verify: "pending",
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "Something went wrong. Please try again.";
}

export interface ZcashChallengeFlowState {
  phase: Phase;
  steps: Steps;
  /** The unified address in play (full, for truncation at the call site). */
  address: string | null;
  /** The recovery phrase, present ONLY during the seedReveal phase. */
  seedPhrase: string | null;
  error: string | null;
  /** Convenience: 0-based index of the currently active/next step. */
  activeIndex: number;
  start: () => void;
  showRestoreIdentity: () => void;
  cancelRestoreIdentity: () => void;
  restoreIdentity: (
    seedPhrase: string,
    birthdayHeight: number | undefined,
    clearPhrase: () => void,
  ) => Promise<void>;
  createIdentity: () => Promise<void>;
  revealSeedBackup: () => Promise<void>;
  confirmSeedSaved: () => Promise<void>;
  hideSeedBackup: () => void;
  retry: () => void;
  reset: () => void;
}

export interface ChallengeFlowConfig {
  /**
   * The final network call once the wallet has signed the server's
   * challenge — either `auth.zcashLogin` (anonymous) or `auth.zcashAssociate`
   * (authenticated, attaches the current knox token).
   */
  verify: (signed: SignedChallenge) => Promise<ChallengeVerification>;
  /** Friendly message shown when `verify` throws (a non-conflict error). */
  verifyErrorMessage: string;
  /** Called once `verify` resolves, so the caller can update its own state. */
  onVerified: (result: ChallengeVerification, address: string) => void;
  /** Run after the phase flips to "success" (e.g. toast + navigate). */
  afterSuccess?: (
    result: ChallengeVerification,
    address: string,
    isCurrent: IsCurrentAttempt,
  ) => void | Promise<void>;
}

export interface ChallengeVerification {
  user: AuthUser;
  /** Present only for login. Association never replaces the current token. */
  token?: string;
}

// A friendly, step-aware message for the user. We NEVER surface the raw
// backend string (e.g. "Challenge is missing, expired or does not match") —
// it leaks server internals and doesn't tell the user what to do. Local
// wallet/key errors ("prepare"/"sign") carry actionable messages we author,
// so we keep those; server errors ("challenge"/"verify") get a clean, generic
// message. The raw error is always logged for debugging.
function friendlyError(
  stage: StepKey,
  e: unknown,
  verifyErrorMessage: string,
): string {
  console.error(`Zcash challenge flow failed at "${stage}":`, e);
  switch (stage) {
    case "prepare":
    case "sign":
      return errMessage(e);
    case "challenge":
      return "Couldn't reach free2z to start the Zcash challenge. Check your connection and try again.";
    case "verify":
      // `verify` errors (e.g. a 409 conflict) already carry a caller-authored,
      // user-safe message (see auth.zcashAssociate) — surface it as-is.
      return errMessage(e) || verifyErrorMessage;
  }
}

export function useZcashChallengeFlow(
  config: ChallengeFlowConfig,
): ZcashChallengeFlowState {
  const { verify, verifyErrorMessage, onVerified, afterSuccess } = config;

  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<Steps>(freshSteps);
  const [address, setAddress] = useState<string | null>(null);
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [backupWalletId, setBackupWalletId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sensitiveSeed = useRef<SensitiveSeedSession | null>(null);
  if (!sensitiveSeed.current) {
    sensitiveSeed.current = new SensitiveSeedSession(
      walletSensitiveSeedAuthority,
      setSeedPhrase,
    );
  }

  // Guards against overlapping runs (e.g. an impatient double-click).
  const runningRef = useRef(false);
  const attempt = useAttemptLease();

  const hideSeedBackup = useCallback(() => {
    if (!sensitiveSeed.current?.clear()) return;
    attempt.invalidate();
    runningRef.current = false;
    setPhase((current) =>
      current === "loadingSeed" ||
      current === "seedReveal" ||
      current === "confirmingBackup"
        ? "backupRequired"
        : current,
    );
  }, [attempt]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") hideSeedBackup();
    };
    window.addEventListener("blur", hideSeedBackup);
    window.addEventListener("pagehide", hideSeedBackup);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", hideSeedBackup);
      window.removeEventListener("pagehide", hideSeedBackup);
      document.removeEventListener("visibilitychange", onVisibility);
      sensitiveSeed.current?.clear();
    };
  }, [hideSeedBackup]);

  const setStep = useCallback((key: StepKey, status: StepStatus) => {
    setSteps((prev) => ({ ...prev, [key]: status }));
  }, []);

  // The crypto half of the flow: challenge → sign → verify → done.
  const runCrypto = useCallback(
    async (isCurrent: IsCurrentAttempt, expectedWalletId?: string) => {
      // Track which step is in flight so a failure lands on the right row and
      // gets the right friendly message.
      let stage: StepKey = "prepare";
      try {
        if (expectedWalletId) {
          const status = await wallet.getWalletStatus();
          if (!isCurrent()) return;
          if (
            !status.initialized ||
            status.activeWalletId !== expectedWalletId ||
            status.backupRequired
          ) {
            throw new Error(
              "The selected Zcash identity is no longer active. Try again.",
            );
          }
        }

        // The identity is the wallet's transparent P2PKH t-address — the one
        // the plugin signs with and the one free2z verifies via zcashd
        // `verifymessage`. The server challenge MUST be requested for THIS
        // exact address: the backend keys the one-time nonce by address, so if
        // we asked for the challenge under a different address (e.g. the
        // unified u1… address) than the t1… address we sign with, the lookup
        // misses and fails as "challenge does not match".
        const addr = await wallet.getLoginAddress(0);
        if (!isCurrent()) return;

        // Restore returns the exact manifest identity committed by native code.
        // Recheck after deriving the address, immediately before the first
        // network operation, so a concurrent wallet switch cannot substitute a
        // different local identity into the original login attempt.
        if (expectedWalletId) {
          const status = await wallet.getWalletStatus();
          if (!isCurrent()) return;
          if (
            !status.initialized ||
            status.activeWalletId !== expectedWalletId ||
            status.backupRequired
          ) {
            throw new Error(
              "The selected Zcash identity is no longer active. Try again.",
            );
          }
        }
        setAddress(addr);

        // 2 — Ask the SERVER for the challenge to sign. The one-time,
        //     timestamped nonce must come from free2z so it can record/expire
        //     it and reject replays — a client-minted string would carry no
        //     such binding.
        stage = "challenge";
        setStep("challenge", "active");
        await wait(450);
        if (!isCurrent()) return;
        const { challenge } = await auth.zcashChallenge(addr);
        if (!isCurrent()) return;
        setStep("challenge", "done");

        // 3 — Sign the server's exact challenge with the wallet key. Send it
        //     promptly: server nonces expire.
        stage = "sign";
        setStep("sign", "active");
        await wait(500);
        if (!isCurrent()) return;
        const signed = await wallet.signChallenge(challenge);
        if (!isCurrent()) return;
        if (signed.address !== addr || signed.challenge !== challenge) {
          throw new Error(
            "The active Zcash identity changed before signing. No login was sent.",
          );
        }
        setStep("sign", "done");

        // 4 — Verify with free2z (login or associate — see `config.verify`).
        stage = "verify";
        setStep("verify", "active");
        await wait(400);
        if (!isCurrent()) return;
        const result = await verify(signed);
        if (!isCurrent()) return;
        setStep("verify", "done");

        // 5 — Land the result and let the caller react.
        onVerified(result, signed.address);
        if (!isCurrent()) return;
        setPhase("success");
        if (afterSuccess) await afterSuccess(result, signed.address, isCurrent);
      } catch (e) {
        if (!isCurrent()) return;
        setStep(stage, "error");
        setError(friendlyError(stage, e, verifyErrorMessage));
        setPhase("error");
      } finally {
        if (isCurrent()) runningRef.current = false;
      }
    },
    [afterSuccess, onVerified, setStep, verify, verifyErrorMessage],
  );

  // Step 1 — ensure a wallet exists, then either pause for creation or run.
  const prepareAndRun = useCallback(async () => {
    if (runningRef.current) return;
    const isCurrent = attempt.begin();
    runningRef.current = true;
    setError(null);
    setSteps(freshSteps());
    setPhase("running");
    setStep("prepare", "active");
    try {
      await wait(400);
      if (!isCurrent()) return;
      const status = await wallet.getWalletStatus();
      if (!isCurrent()) return;
      if (!status.initialized) {
        // Pause the machine and hand control to the create-identity path.
        runningRef.current = false;
        setPhase("needsWallet");
        return;
      }
      if (!status.activeWalletId) {
        throw new Error("The active Zcash identity is unavailable.");
      }
      if (status.backupRequired) {
        runningRef.current = false;
        setBackupWalletId(status.activeWalletId);
        setPhase("backupRequired");
        return;
      }
      setStep("prepare", "done");
      await runCrypto(isCurrent, status.activeWalletId);
    } catch (e) {
      if (!isCurrent()) return;
      setStep("prepare", "error");
      setError(errMessage(e));
      setPhase("error");
      runningRef.current = false;
    }
  }, [attempt, runCrypto, setStep]);

  const start = useCallback(() => {
    void prepareAndRun();
  }, [prepareAndRun]);

  const showRestoreIdentity = useCallback(() => {
    attempt.invalidate();
    runningRef.current = false;
    setError(null);
    setPhase("restoreIdentity");
  }, [attempt]);

  const cancelRestoreIdentity = useCallback(() => {
    attempt.invalidate();
    runningRef.current = false;
    setError(null);
    setPhase("needsWallet");
  }, [attempt]);

  const restoreIdentity = useCallback(
    async (
      seedPhrase: string,
      birthdayHeight: number | undefined,
      clearPhrase: () => void,
    ) => {
      if (runningRef.current) return;
      const isCurrent = attempt.begin();
      runningRef.current = true;
      setError(null);
      setPhase("restoring");
      try {
        const restoration = wallet.restoreWallet(
          seedPhrase,
          birthdayHeight,
          "Recovered identity",
        );
        // Drop this flow-local binding before waiting on native I/O. JavaScript
        // strings cannot be zeroized, and the IPC argument object may retain its
        // immutable copy until serialization; the renderer guarantee is no
        // persistence, logging, toast, URL, or network transport, plus clearing
        // the editable state immediately after native custody succeeds.
        seedPhrase = "";
        const restored = await restoration;
        if (!isCurrent()) {
          clearPhrase();
          return;
        }
        if (!restored.success || !restored.walletId) {
          throw new Error("The recovery phrase could not be restored.");
        }
        // Clear the editable renderer state immediately after successful native
        // custody, before any identity/network continuation.
        clearPhrase();
        // The app-level bootstrap may already have cached `initialized: false`.
        // Publish the restored wallet to the shared renderer store before login
        // continues so Wallet does not show onboarding until the next reload.
        await useWallet.getState().bootstrap();
        if (!isCurrent()) return;
        setPhase("running");
        setStep("prepare", "done");
        await runCrypto(isCurrent, restored.walletId);
      } catch {
        if (!isCurrent()) return;
        // Native mnemonic diagnostics are intentionally content-free. Keep the
        // renderer message fixed as a second defense against phrase leakage,
        // while acknowledging that words, birthday, network, or native custody
        // can each prevent restoration.
        setError(
          "Couldn't restore this identity. Check the recovery words, birthday, and connection, then try again.",
        );
        setPhase("restoreIdentity");
      } finally {
        if (isCurrent()) runningRef.current = false;
      }
    },
    [attempt, runCrypto, setStep],
  );

  const createIdentity = useCallback(async () => {
    if (runningRef.current) return;
    const isCurrent = attempt.begin();
    runningRef.current = true;
    setPhase("creating");
    setError(null);
    try {
      const { walletId } = await wallet.createWallet();
      if (!isCurrent()) return;
      setBackupWalletId(walletId);
      // Creation returns no mnemonic to the renderer. The explicit reveal
      // below first acquires native capture protection, then performs a fresh
      // user-presence-bound custody read.
      setPhase("backupRequired");
    } catch (e) {
      if (!isCurrent()) return;
      setError(errMessage(e));
      setPhase("error");
    } finally {
      if (isCurrent()) runningRef.current = false;
    }
  }, [attempt]);

  const revealSeedBackup = useCallback(async () => {
    if (runningRef.current) return;
    const isCurrent = attempt.begin();
    runningRef.current = true;
    setError(null);
    setPhase("loadingSeed");
    try {
      const status = await wallet.getWalletStatus();
      if (!isCurrent()) return;
      if (!status.initialized || !status.activeWalletId) {
        throw new Error("The Zcash identity is no longer available.");
      }
      if (!status.backupRequired) {
        setStep("prepare", "done");
        await runCrypto(isCurrent, status.activeWalletId);
        return;
      }
      const revealed = await sensitiveSeed.current!.reveal((token) =>
        wallet.getBackupSeedPhrase(status.activeWalletId!, token),
      );
      if (!isCurrent() || !revealed) return;
      setBackupWalletId(status.activeWalletId);
      setPhase("seedReveal");
    } catch (e) {
      if (!isCurrent()) return;
      setError(errMessage(e));
      setPhase("backupRequired");
    } finally {
      if (isCurrent()) runningRef.current = false;
    }
  }, [attempt, runCrypto, setStep]);

  const confirmSeedSaved = useCallback(async () => {
    if (runningRef.current || !backupWalletId) return;
    const isCurrent = attempt.begin();
    runningRef.current = true;
    setError(null);
    setPhase("confirmingBackup");
    // The acknowledgement does not need the mnemonic. Clear it synchronously
    // before the durable native operation or any network continuation.
    sensitiveSeed.current?.clear();
    try {
      await wallet.confirmWalletBackup(backupWalletId);
      if (!isCurrent()) return;
      setPhase("running");
      setStep("prepare", "done");
      await runCrypto(isCurrent, backupWalletId);
    } catch (e) {
      if (!isCurrent()) return;
      setError(errMessage(e));
      // The phrase was already cleared before acknowledgement. Require a new
      // protected, presence-bound reveal instead of resurrecting stale state.
      setPhase("backupRequired");
    } finally {
      if (isCurrent()) runningRef.current = false;
    }
  }, [attempt, backupWalletId, runCrypto, setStep]);

  const retry = useCallback(() => {
    void prepareAndRun();
  }, [prepareAndRun]);

  const reset = useCallback(() => {
    attempt.invalidate();
    runningRef.current = false;
    setPhase("idle");
    setSteps(freshSteps());
    setAddress(null);
    sensitiveSeed.current?.clear();
    setBackupWalletId(null);
    setError(null);
  }, [attempt]);

  const activeIndex = (() => {
    const idx = STEP_ORDER.findIndex(
      (k) => steps[k] === "active" || steps[k] === "error",
    );
    if (idx >= 0) return idx;
    const done = STEP_ORDER.filter((k) => steps[k] === "done").length;
    return Math.min(done, STEP_ORDER.length - 1);
  })();

  return {
    phase,
    steps,
    address,
    seedPhrase,
    error,
    activeIndex,
    start,
    showRestoreIdentity,
    cancelRestoreIdentity,
    restoreIdentity,
    createIdentity,
    revealSeedBackup,
    confirmSeedSaved,
    hideSeedBackup,
    retry,
    reset,
  };
}
