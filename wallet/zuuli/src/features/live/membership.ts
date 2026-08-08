import type {
  DyteJoinTicket,
  SubscribeResult,
  Subscription,
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
  loadMemberships: () => Promise<Subscription[]>;
  loadCurrentPrice: () => Promise<number | null>;
  subscribe: (
    username: string,
    idempotencyKey: string,
  ) => Promise<SubscribeResult>;
  reconcileBalance: () => Promise<void>;
  join: () => Promise<DyteJoinTicket>;
}

export interface SubscriberEntryResult {
  ticket: DyteJoinTicket;
  membership: Subscription;
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
 * Every attempt first checks the authoritative active-membership endpoint, so
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
  const before = await deps.loadMemberships();
  const existing = activeMembershipFor(before, deps.username);
  if (existing) {
    return {
      ticket: await deps.join(),
      membership: existing,
      purchase: null,
      recoveredAmbiguousPurchase: false,
    };
  }

  // The public live listing may be a few seconds old. Re-read the creator
  // immediately before the money POST and force a new confirmation if the
  // displayed terms changed. (The backend endpoint does not yet accept a
  // client price cap, so this is the strongest available client boundary.)
  const currentPrice = await deps.loadCurrentPrice();
  if (currentPrice !== deps.confirmedPrice) {
    throw new MembershipPriceChangedError(deps.confirmedPrice, currentPrice);
  }

  let purchase: SubscribeResult | null = null;
  let purchaseError: unknown = null;
  try {
    purchase = await deps.subscribe(deps.username, deps.idempotencyKey);
  } catch (error) {
    // A transport failure is ambiguous: the backend may have committed before
    // the response disappeared. Read back both facts before deciding whether
    // entry is safe, and keep the same idempotency key for any later retry.
    purchaseError = error;
  }

  let after: Subscription[];
  try {
    [after] = await Promise.all([
      deps.loadMemberships(),
      deps.reconcileBalance(),
    ]);
  } catch (error) {
    throw new MembershipReconciliationError(
      "The membership result could not be verified. No balance was debited optimistically; retry to reconcile it safely.",
      purchaseError ?? error,
    );
  }

  const membership = activeMembershipFor(after, deps.username);
  if (!membership) {
    if (purchaseError instanceof Error) throw purchaseError;
    throw new MembershipReconciliationError(
      "The backend did not confirm an active membership. The stream was not joined.",
    );
  }

  return {
    ticket: await deps.join(),
    membership,
    purchase,
    recoveredAmbiguousPurchase: purchaseError !== null,
  };
}

/** A cryptographically random, per-confirmation retry key for the money POST. */
export function newMembershipIdempotencyKey(username: string): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(random, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `zuuli-live:${username.toLowerCase()}:${nonce}`;
}
