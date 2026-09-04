import type {
  DyteJoinTicket,
  SubscribeResult,
  Subscription,
  SubscriptionStatus,
} from "@/lib/api/types";

/**
 * The endpoint already filters with `expires__gt=server_now`. Presence in that
 * list is the entitlement fact; re-checking its timestamp against a possibly
 * skewed device clock could misclassify a real member and recharge them.
 */
export function activeMembershipFor(
  subscriptions: Subscription[],
  username: string,
): Subscription | null {
  return (
    subscriptions.find(
      (subscription) =>
        subscription.star.username.toLowerCase() === username.toLowerCase(),
    ) ?? null
  );
}

export class MembershipReconciliationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MembershipReconciliationError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class MembershipPriceChangedError extends Error {
  readonly currentPrice: number | null;

  constructor(confirmedPrice: number, currentPrice: number | null) {
    super(
      currentPrice === null
        ? "This creator no longer offers a paid membership. Review the updated details before continuing."
        : `The membership price changed from ${confirmedPrice.toLocaleString()} 2Z to ${currentPrice.toLocaleString()} 2Z. Review the updated price before confirming.`,
    );
    this.name = "MembershipPriceChangedError";
    this.currentPrice = currentPrice;
  }
}

export interface EnterSubscriberStreamDeps {
  username: string;
  idempotencyKey: string;
  confirmedPrice: number;
  /**
   * The exact money authority granted by the UI that launched this attempt.
   * A join-only click must never be promoted into a purchase when entitlement
   * expires between render and the authoritative preflight.
   */
  authorization: "join-only" | "purchase-approved";
  loadMembership: () => Promise<SubscriptionStatus>;
  subscribe: (
    username: string,
    idempotencyKey: string,
    expectedPrice: number,
  ) => Promise<SubscribeResult>;
  reconcileBalance: () => Promise<void>;
  join: () => Promise<DyteJoinTicket>;
}

export interface SubscriberEntryResult {
  ticket: DyteJoinTicket;
  membership: SubscriptionStatus;
  /** Null when the viewer was already entitled and no purchase was attempted. */
  purchase: SubscribeResult | null;
  /** True when a failed/ambiguous POST was proven successful by the read-back. */
  recoveredAmbiguousPurchase: boolean;
}

/** Close the synchronous gap before React can render a disabled button. */
export async function runSingleFlight<T>(
  lock: { current: boolean },
  operation: () => Promise<T>,
): Promise<T | null> {
  if (lock.current) return null;
  lock.current = true;
  try {
    return await operation();
  } finally {
    lock.current = false;
  }
}

/**
 * Cross the subscriber-room money boundary safely.
 *
 * Every attempt first checks the target-specific membership endpoint, so
 * an existing member (including one with auto-renew disabled) is never POSTed
 * merely for entering a room. A new purchase is joined only after BOTH the
 * membership and account balance have been read back from the backend.
 *
 * The caller owns a stable idempotency key and must reuse it when retrying an
 * ambiguous attempt. The backend then replays the first result instead of
 * extending another month.
 */
export async function enterSubscriberStream(
  deps: EnterSubscriberStreamDeps,
): Promise<SubscriberEntryResult> {
  const before = await deps.loadMembership();
  if (before.active) {
    try {
      // This is deliberately required even for an already-active membership.
      // A prior POST may have committed while its response/reconciliation was
      // lost; joining directly here would leave the displayed balance stale.
      await deps.reconcileBalance();
    } catch (error) {
      throw new MembershipReconciliationError(
        "Your account balance could not be reconciled. The stream was not joined.",
        error,
      );
    }
    return {
      ticket: await deps.join(),
      membership: before,
      purchase: null,
      recoveredAmbiguousPurchase: false,
    };
  }

  if (deps.authorization === "join-only") {
    throw new MembershipReconciliationError(
      "Your membership expired before entry. Review the current membership price before purchasing.",
    );
  }

  let purchase: SubscribeResult | null = null;
  let purchaseError: unknown = null;
  try {
    purchase = await deps.subscribe(
      deps.username,
      deps.idempotencyKey,
      deps.confirmedPrice,
    );
  } catch (error) {
    // A transport failure is ambiguous: the backend may have committed before
    // the response disappeared. Read back both facts before deciding whether
    // entry is safe, and keep the same idempotency key for any later retry.
    purchaseError = error;
  }

  let after: SubscriptionStatus;
  try {
    [after] = await Promise.all([
      deps.loadMembership(),
      deps.reconcileBalance(),
    ]);
  } catch (error) {
    throw new MembershipReconciliationError(
      "The membership result could not be verified. No balance was debited optimistically; retry to reconcile it safely.",
      purchaseError ?? error,
    );
  }

  if (!after.active) {
    if (purchaseError instanceof Error) throw purchaseError;
    throw new MembershipReconciliationError(
      "The backend did not confirm an active membership. The stream was not joined.",
    );
  }

  return {
    ticket: await deps.join(),
    membership: after,
    purchase,
    recoveredAmbiguousPurchase: purchaseError !== null,
  };
}

/** A cryptographically random, per-confirmation retry key for the money POST. */
export function newMembershipIdempotencyKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 UUIDv4 bits; the username belongs in the backend request
  // fingerprint, not in this opaque retry key.
  random[6] = (random[6]! & 0x0f) | 0x40;
  random[8] = (random[8]! & 0x3f) | 0x80;
  const hex = Array.from(random, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
