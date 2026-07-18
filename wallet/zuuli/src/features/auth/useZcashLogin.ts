// The Login-with-Zcash state machine.
//
// Drives the challenge/response flow end-to-end:
//   prepare identity → request challenge → sign (ZIP-304) → verify → session.
//
// The wallet key never leaves the device: we generate a challenge locally, the
// wallet signs it, and only the { address, challenge, signature } triple is
// sent to free2z, which verifies control of the address and mints a session.
// The seed phrase is treated as sensitive — held in state only while the user
// backs it up, then dropped, and never logged.

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { auth } from "@/lib/api/free2z";
import { wallet } from "@/lib/wallet/bridge";
import { useSession } from "@/store/session";

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

export const STEP_META: Record<StepKey, StepMeta> = {
  prepare: {
    key: "prepare",
    title: "Preparing your identity",
    detail: "Locating the Zcash key that will represent you. No key ever leaves this device.",
  },
  challenge: {
    key: "challenge",
    title: "Requesting a challenge",
    detail: "Minting a one-time, timestamped nonce for you to sign — it cannot be replayed.",
  },
  sign: {
    key: "sign",
    title: "Signing with your key",
    detail: "Producing a ZIP-304 signature over the challenge to prove you control the address.",
  },
  verify: {
    key: "verify",
    title: "Verifying",
    detail: "free2z checks the signature against your address and derives your W3C DID.",
  },
};

type Steps = Record<StepKey, StepStatus>;

const freshSteps = (): Steps => ({
  prepare: "pending",
  challenge: "pending",
  sign: "pending",
  verify: "pending",
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A one-time nonce, from the CSPRNG when available. */
function makeNonce(): string {
  const c = globalThis.crypto;
  if (c && "getRandomValues" in c) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "Something went wrong. Please try again.";
}

export interface ZcashLoginState {
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

export function useZcashLogin(): ZcashLoginState {
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);

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

  // The crypto half of the flow: challenge → sign → verify → session.
  const runCrypto = useCallback(async () => {
    try {
      // 2 — Request a challenge + resolve the address to sign with.
      setStep("challenge", "active");
      await wait(450);
      const challenge = `zuuli-login:${makeNonce()}:${Date.now()}`;
      const addr = await wallet.getUnifiedAddress(0);
      setAddress(addr);
      setStep("challenge", "done");

      // 3 — Sign the challenge with the wallet key (ZIP-304).
      setStep("sign", "active");
      await wait(500);
      const signed = await wallet.signChallenge(challenge);
      setStep("sign", "done");

      // 4 — Verify with free2z; it mints a session token as a side effect.
      setStep("verify", "active");
      await wait(400);
      const user = await auth.zcashLogin({
        address: signed.address,
        challenge: signed.challenge,
        signature: signed.signature,
      });
      setStep("verify", "done");

      // 5 — Land the session and go home.
      setUser(user);
      setPhase("success");
      toast.success("Welcome to ZUULI", {
        description: "Signed in with your Zcash key.",
      });
      await wait(700);
      navigate("/");
    } catch (e) {
      setError(errMessage(e));
      setSteps((prev) => {
        const active = STEP_ORDER.find((k) => prev[k] === "active");
        return active ? { ...prev, [active]: "error" } : prev;
      });
      setPhase("error");
    } finally {
      runningRef.current = false;
    }
  }, [navigate, setStep, setUser]);

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
