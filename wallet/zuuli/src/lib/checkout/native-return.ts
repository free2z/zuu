import { isMobileTauri } from "@/lib/oauth/transport";

export const CHECKOUT_RETURN_URI = "cash.free2z.zuuli://checkout/return";
// Django's timestamp signer emits URL-safe base64 segments separated by
// colons, with an optional leading compression marker. Keep this bounded and
// fail closed before the value reaches the authenticated claim endpoint.
const CLAIM_CODE = /^[A-Za-z0-9_.:-]{16,2048}$/;
const STATUS_TOKEN = /^[A-Za-z0-9_.:-]{16,1024}$/;

export type CheckoutReturnMode = "web" | "zuuli_mobile";

export type CheckoutReturnClaim =
  | { outcome: "cancel"; status: "cancelled" }
  | {
      outcome: "processing";
      status: "processing";
      statusToken?: string;
    }
  | {
      outcome: "success";
      status: "processing";
      statusToken: string;
    };

export type CheckoutPaymentStatus =
  { status: "processing" } | { status: "credited"; tuzisCredited: number };

export type CheckoutRecoveryResult =
  | { status: "cancelled" }
  | { status: "processing" }
  | { status: "credited"; tuzisCredited: number };

interface RecoveryDependencies {
  claim: (code: string) => Promise<CheckoutReturnClaim>;
  status: (token: string) => Promise<CheckoutPaymentStatus>;
  refreshSession: () => Promise<void>;
  navigateToBuy: () => void;
  wait?: (milliseconds: number) => Promise<void>;
}

async function refreshSessionBestEffort(
  refreshSession: () => Promise<void>,
): Promise<void> {
  // The claim/status response remains the authoritative return outcome even
  // when a sibling balance refresh is temporarily unavailable. Preserve that
  // truth so users can retry the refresh without losing cancel/processing or
  // webhook-backed credit confirmation.
  await refreshSession().catch(() => undefined);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, i) => key === [...keys].sort()[i])
  );
}

/** Parse only the one native path registered in both mobile manifests. */
export function parseCheckoutReturnUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "cash.free2z.zuuli:" ||
    url.hostname !== "checkout" ||
    url.pathname !== "/return" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "code")
  ) {
    return null;
  }
  const codes = url.searchParams.getAll("code");
  return codes.length === 1 && CLAIM_CODE.test(codes[0]) ? codes[0] : null;
}

export function parseCheckoutReturnClaim(value: unknown): CheckoutReturnClaim {
  if (
    !record(value) ||
    typeof value.outcome !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error("free2z returned a malformed checkout claim.");
  }
  if (
    value.outcome === "cancel" &&
    value.status === "cancelled" &&
    exactKeys(value, ["outcome", "status"])
  ) {
    return { outcome: "cancel", status: "cancelled" };
  }
  if (
    value.outcome === "processing" &&
    value.status === "processing"
  ) {
    if (exactKeys(value, ["outcome", "status"])) {
      return { outcome: "processing", status: "processing" };
    }
    if (
      typeof value.status_token === "string" &&
      STATUS_TOKEN.test(value.status_token) &&
      exactKeys(value, ["outcome", "status", "status_token"])
    ) {
      return {
        outcome: "processing",
        status: "processing",
        statusToken: value.status_token,
      };
    }
  }
  if (
    value.outcome === "success" &&
    value.status === "processing" &&
    typeof value.status_token === "string" &&
    STATUS_TOKEN.test(value.status_token) &&
    exactKeys(value, ["outcome", "status", "status_token"])
  ) {
    return {
      outcome: "success",
      status: "processing",
      statusToken: value.status_token,
    };
  }
  throw new Error("free2z returned a malformed checkout claim.");
}

export function parseCheckoutPaymentStatus(
  value: unknown,
): CheckoutPaymentStatus {
  if (!record(value) || typeof value.status !== "string") {
    throw new Error("free2z returned a malformed checkout status.");
  }
  if (value.status === "processing" && exactKeys(value, ["status"])) {
    return { status: "processing" };
  }
  if (
    value.status === "credited" &&
    Number.isSafeInteger(value.tuzis_credited) &&
    Number(value.tuzis_credited) > 0 &&
    exactKeys(value, ["status", "tuzis_credited"])
  ) {
    return { status: "credited", tuzisCredited: Number(value.tuzis_credited) };
  }
  throw new Error("free2z returned a malformed checkout status.");
}

export async function checkoutReturnMode(): Promise<CheckoutReturnMode> {
  return (await isMobileTauri()) ? "zuuli_mobile" : "web";
}

const STATUS_DELAYS_MS = [0, 750, 1_500, 3_000];

/** Redeem once, then poll only the bounded server status token. */
export async function recoverCheckoutReturn(
  code: string,
  dependencies: RecoveryDependencies,
): Promise<CheckoutRecoveryResult> {
  if (!CLAIM_CODE.test(code))
    throw new Error("The checkout return code is invalid.");
  dependencies.navigateToBuy();
  const claim = await dependencies.claim(code);
  await refreshSessionBestEffort(dependencies.refreshSession);
  if (claim.outcome === "cancel") return { status: "cancelled" };
  // Older or deliberately uncorrelated processing claims have no status
  // token. Navigation plus the authoritative session/balance refresh remains
  // the only safe recovery action for them. A correlated processing token is
  // still non-authoritative: it enters the same bounded polling path as a
  // verified-success claim and becomes credited only when the webhook-backed
  // ledger status endpoint says so.
  if (!claim.statusToken) return { status: "processing" };

  const wait =
    dependencies.wait ??
    ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
  for (const delay of STATUS_DELAYS_MS) {
    if (delay) await wait(delay);
    const status = await dependencies.status(claim.statusToken);
    if (status.status === "credited") {
      await refreshSessionBestEffort(dependencies.refreshSession);
      return status;
    }
  }
  // The verified webhook may arrive later. Never promote a successful browser
  // return (or even Stripe's paid status) to credited without the ledger row.
  return { status: "processing" };
}

/** Deliver both cold-start getCurrent() and warm-start onOpenUrl() returns. */
export async function listenForCheckoutReturns(
  deliver: (code: string) => void | Promise<void>,
): Promise<() => void> {
  if (!(await isMobileTauri())) return () => undefined;
  const { getCurrent, onOpenUrl } =
    await import("@tauri-apps/plugin-deep-link");
  const seen = new Set<string>();
  const process = (urls: string[]) => {
    for (const value of urls) {
      const code = parseCheckoutReturnUrl(value);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const retry = () => {
        // The authenticated claim is deliberately retryable for its bounded
        // lifetime. Let a repeated OS delivery retry after a transient client
        // or network failure while still deduplicating successful delivery.
        seen.delete(code);
      };
      try {
        void Promise.resolve(deliver(code)).catch(retry);
      } catch {
        retry();
      }
    }
  };
  const unlisten = await onOpenUrl(process);
  try {
    const current = await getCurrent();
    if (current) process(current);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}
