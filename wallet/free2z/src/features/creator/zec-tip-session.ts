/** UI recovery only. No spending authority or payment details enter storage. */
import { useSyncExternalStore } from "react";
import {
  requestCreatorTipPayment,
  recordCreatorTipIntent,
  type CreatorTipIntent,
  type CreatorTipOutcome,
} from "@/lib/bridge/creator-tip";
import { creatorTipCopy } from "./tip-copy";

const RECOVERY_KEY = "free2z.zec-tip-needs-wallet-check";
export interface TipAttempt {
  readonly source: CreatorTipIntent;
  readonly amountZatoshis: number;
  readonly outcome: CreatorTipOutcome | null;
}
interface TipSession {
  readonly attempt: TipAttempt | null;
  readonly blocked: boolean;
}
const listeners = new Set<() => void>();
let current: TipSession | null = null;
function recoveryRequired(): boolean {
  try {
    return localStorage.getItem(RECOVERY_KEY) !== null;
  } catch {
    return true;
  }
}
function snapshot(): TipSession {
  return (current ??= Object.freeze({
    attempt: null,
    blocked: recoveryRequired(),
  }));
}
function publish(value: TipSession): void {
  current = Object.freeze(value);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useZecTipSession(): TipSession {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Synchronous lock before the first await: rapid taps and remounts cannot dispatch twice.
 * A crash after this point leaves only an anonymous recovery latch, never a
 * retryable payment. Exact-byte rebroadcast belongs exclusively to ZUULI.
 */
export async function startZecTip(
  source: CreatorTipIntent,
  amountZatoshis: number,
): Promise<void> {
  if (snapshot().blocked || snapshot().attempt) return;
  const frozen = recordCreatorTipIntent(source);
  try {
    localStorage.setItem(RECOVERY_KEY, "1");
  } catch {
    publish({ attempt: null, blocked: true });
    return;
  }
  const attempt = Object.freeze({
    source: frozen,
    amountZatoshis,
    outcome: null,
  });
  publish({ attempt, blocked: true });
  let outcome: CreatorTipOutcome;
  try {
    outcome = await requestCreatorTipPayment(frozen, amountZatoshis);
  } catch {
    // Never turn an unexpected exception after dispatch into "bad address".
    outcome = { kind: "transport-failed", detail: "unexpected" };
  }
  // Even an accepted response can be lost before the payer reads the receipt.
  // Keep crash protection until explicit acknowledgement of that payment.
  const needsWalletCheck = !creatorTipCopy(outcome).certainNothingWasSent;
  if (!needsWalletCheck) {
    try {
      localStorage.removeItem(RECOVERY_KEY);
    } catch {
      /* retain fail-closed latch */
    }
  }
  publish({
    attempt: Object.freeze({ ...attempt, outcome: Object.freeze(outcome) }),
    blocked: needsWalletCheck || recoveryRequired(),
  });
}

/** Explicitly start a NEW payment after reading the receipt/checking ZUULI.
 * This never retries an old request, and cannot clear a running exchange.
 */
export function acknowledgeZecTip(): void {
  if (snapshot().attempt?.outcome === null) return;
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch {
    return;
  }
  publish({ attempt: null, blocked: recoveryRequired() });
}
