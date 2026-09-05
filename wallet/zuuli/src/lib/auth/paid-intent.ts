import {
  safeLoginDestination,
  type LoginDestination,
} from "./login-destination";
import { MAX_TUZIS } from "@/lib/format";

const STORAGE_KEY = "zuuli.auth.pending-paid-intent";
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_FIELD = 128;
const MAX_USERNAME = 150;

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * #904 phase 4 removed the `ai`, `article-tip`, `creator-tip`,
 * `creator-subscription` and `live-entry` kinds along with the routes that
 * issued and consumed them. A kind whose `returnTo` no longer resolves can
 * only ever be dropped by `consumePaidIntent`, so keeping it would preserve a
 * private draft in session storage that nothing can ever hand back.
 */
export type PaidIntent = {
  kind: "send";
  query: string;
  amount: number | string;
};

interface StoredPaidIntent {
  returnTo: LoginDestination;
  createdAt: number;
  intent: PaidIntent;
}

function sessionIntentStorage(): IntentStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function shortString(value: unknown, maximum = MAX_FIELD): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function usernameString(value: unknown): value is string {
  return typeof value === "string" && [...value].length <= MAX_USERNAME;
}

function sendAmount(value: unknown): value is number | string {
  // Strings are the one-release migration shape and deliberately remain
  // permissive: malformed legacy input must restore as invalid UI text rather
  // than being coerced into a different amount. New valid drafts use numbers.
  return (
    shortString(value, 32) ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_TUZIS)
  );
}

function validIntent(value: unknown): value is PaidIntent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "send":
      return usernameString(record.query) && sendAmount(record.amount);
    default:
      return false;
  }
}

/**
 * Save only a bounded UI draft in session storage. It survives the in-app
 * login route but not a durable browser/device restart, which is intentional
 * for potentially private AI prompts.
 */
export function preservePaidIntent(
  returnToValue: unknown,
  intent: PaidIntent,
  storage: IntentStorage | null = sessionIntentStorage(),
  now = Date.now(),
): LoginDestination {
  const returnTo = safeLoginDestination(returnToValue);
  if (!storage) return returnTo;
  try {
    // One intent owns this slot. Clear it first so an invalid replacement or a
    // failed write cannot leave a private draft available for a later visit.
    storage.removeItem(STORAGE_KEY);
    if (returnTo !== "/" && validIntent(intent)) {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ returnTo, createdAt: now, intent }),
      );
    }
  } catch {
    // Storage failure may lose convenience, but must never block sign-in.
  }
  return returnTo;
}

/** Drop any draft when its login attempt is abandoned. */
export function discardPaidIntent(
  storage: Pick<IntentStorage, "removeItem"> | null = sessionIntentStorage(),
): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // A blocked storage implementation is already inaccessible to the app.
  }
}

/**
 * A first login may consume the guest's draft, but no draft may cross a
 * logout or an already-established account switch.
 */
export function discardPaidIntentForAccountTransition(
  previousUsername: string | null,
  nextUsername: string | null,
  storage: Pick<IntentStorage, "removeItem"> | null = sessionIntentStorage(),
): void {
  if (
    nextUsername === null ||
    (previousUsername !== null && previousUsername !== nextUsername)
  ) {
    discardPaidIntent(storage);
  }
}

/** Read once, validate again, and bind the draft to the exact returned route. */
export function consumePaidIntent(
  returnToValue: unknown,
  expectedKinds: PaidIntent["kind"] | readonly PaidIntent["kind"][],
  storage: IntentStorage | null = sessionIntentStorage(),
  now = Date.now(),
): PaidIntent | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Consumption is destructive even when the record is expired, malformed,
    // routed elsewhere, or the wrong kind. Private drafts must not replay on a
    // later visit. If removal fails, fail closed rather than return a value we
    // cannot prove was consumed.
    storage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as Partial<StoredPaidIntent>;
    const acceptedKinds = Array.isArray(expectedKinds)
      ? expectedKinds
      : [expectedKinds];
    if (
      safeLoginDestination(parsed.returnTo) !==
        safeLoginDestination(returnToValue) ||
      safeLoginDestination(parsed.returnTo) === "/" ||
      typeof parsed.createdAt !== "number" ||
      now - parsed.createdAt < 0 ||
      now - parsed.createdAt > MAX_AGE_MS ||
      !validIntent(parsed.intent) ||
      !acceptedKinds.includes(parsed.intent.kind)
    ) {
      return null;
    }
    return parsed.intent;
  } catch {
    return null;
  }
}
