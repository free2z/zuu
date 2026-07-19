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

import { useCallback, useRef, useState } from "react";
import { wallet } from "@/lib/wallet/bridge";
import type { SignedChallenge } from "@/lib/wallet/types";
import { auth } from "@/lib/api/free2z";
import type { AuthUser } from "@/lib/api/types";

export type StepKey = "prepare" | "challenge" | "sign" | "verify";
export type StepStatus = "pending" | "active" | "done" | "error";

export type Phase =
  | "idle" // nothing started yet
  | "running" // walking the crypto steps
  | "needsWallet" // no wallet on device — offer to create one
  | "creating" // minting a fresh identity
  | "seedReveal" // showing the recovery phrase for backup
  | "success"
  | "error";

export const STEP_ORDER: StepKey[] = [
  "prepare",
  "challenge",
  "sign",
  "verify",
];

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
  createIdentity: () => Promise<void>;
  confirmSeedSaved: () => void;
  retry: () => void;
  reset: () => void;
}

export interface ChallengeFlowConfig {
  /**
   * The final network call once the wallet has signed the server's
   * challenge — either `auth.zcashLogin` (anonymous) or `auth.zcashAssociate`
   * (authenticated, attaches the current knox token).
   */
  verify: (signed: SignedChallenge) => Promise<AuthUser>;
  /** Friendly message shown when `verify` throws (a non-conflict error). */
  verifyErrorMessage: string;
  /** Called once `verify` resolves, so the caller can update its own state. */
  onVerified: (user: AuthUser, address: string) => void;
  /** Run after the phase flips to "success" (e.g. toast + navigate). */
  afterSuccess?: (user: AuthUser, address: string) => void | Promise<void>;
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
  const [error, setError] = useState<string | null>(null);

  // Guards against overlapping runs (e.g. an impatient double-click).
  const runningRef = useRef(false);

  const setStep = useCallback((key: StepKey, status: StepStatus) => {
    setSteps((prev) => ({ ...prev, [key]: status }));
  }, []);

  // The crypto half of the flow: challenge → sign → verify → done.
  const runCrypto = useCallback(async () => {
    // Track which step is in flight so a failure lands on the right row and
    // gets the right friendly message.
    let stage: StepKey = "prepare";
    try {
      // The identity is the wallet's transparent P2PKH t-address — the one
      // the plugin signs with and the one free2z verifies via zcashd
      // `verifymessage`. The server challenge MUST be requested for THIS
      // exact address: the backend keys the one-time nonce by address, so if
      // we asked for the challenge under a different address (e.g. the
      // unified u1… address) than the t1… address we sign with, the lookup
      // misses and fails as "challenge does not match".
      const addr = await wallet.getLoginAddress(0);
      setAddress(addr);

      // 2 — Ask the SERVER for the challenge to sign. The one-time,
      //     timestamped nonce must come from free2z so it can record/expire
      //     it and reject replays — a client-minted string would carry no
      //     such binding.
      stage = "challenge";
      setStep("challenge", "active");
      await wait(450);
      const { challenge } = await auth.zcashChallenge(addr);
      setStep("challenge", "done");

      // 3 — Sign the server's exact challenge with the wallet key. Send it
      //     promptly: server nonces expire.
      stage = "sign";
      setStep("sign", "active");
      await wait(500);
      const signed = await wallet.signChallenge(challenge);
      setStep("sign", "done");

      // 4 — Verify with free2z (login or associate — see `config.verify`).
      stage = "verify";
      setStep("verify", "active");
      await wait(400);
      const user = await verify(signed);
      setStep("verify", "done");

      // 5 — Land the result and let the caller react.
      onVerified(user, signed.address);
      setPhase("success");
      if (afterSuccess) await afterSuccess(user, signed.address);
    } catch (e) {
      setStep(stage, "error");
      setError(friendlyError(stage, e, verifyErrorMessage));
      setPhase("error");
    } finally {
      runningRef.current = false;
    }
  }, [afterSuccess, onVerified, setStep, verify, verifyErrorMessage]);

  // Step 1 — ensure a wallet exists, then either pause for creation or run.
  const prepareAndRun = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setSteps(freshSteps());
    setPhase("running");
    setStep("prepare", "active");
    try {
      await wait(400);
      const status = await wallet.getWalletStatus();
      if (!status.initialized) {
        // Pause the machine and hand control to the create-identity path.
        runningRef.current = false;
        setPhase("needsWallet");
        return;
      }
      setStep("prepare", "done");
      await runCrypto();
    } catch (e) {
      setStep("prepare", "error");
      setError(errMessage(e));
      setPhase("error");
      runningRef.current = false;
    }
  }, [runCrypto, setStep]);

  const start = useCallback(() => {
    void prepareAndRun();
  }, [prepareAndRun]);

  const createIdentity = useCallback(async () => {
    setPhase("creating");
    setError(null);
    try {
      const { seedPhrase: phrase } = await wallet.createWallet();
      setSeedPhrase(phrase);
      setPhase("seedReveal");
    } catch (e) {
      setError(errMessage(e));
      setPhase("error");
    }
  }, []);

  const confirmSeedSaved = useCallback(() => {
    // Drop the phrase from memory the moment backup is confirmed.
    setSeedPhrase(null);
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("running");
    setStep("prepare", "done");
    void runCrypto();
  }, [runCrypto, setStep]);

  const retry = useCallback(() => {
    void prepareAndRun();
  }, [prepareAndRun]);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setSteps(freshSteps());
    setAddress(null);
    setSeedPhrase(null);
    setError(null);
  }, []);

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
    createIdentity,
    confirmSeedSaved,
    retry,
    reset,
  };
}
