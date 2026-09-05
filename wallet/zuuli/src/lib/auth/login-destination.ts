/**
 * Where a completed sign-in is allowed to land.
 *
 * #904 phase 4 deleted ZUULI's content routes, and this allowlist went with
 * them. It has to: a persisted `returnTo` of `/creator/zooko` survives an app
 * restart in `localStorage`, and once the route is gone the "successful" login
 * lands the user on a NotFound with no way to see what went wrong. Every value
 * here is a route `App.tsx` still mounts.
 */
export type LoginDestination =
  | "/"
  | "/wallet/fund"
  | "/wallet/fund/activity"
  | "/wallet/fund/send";

export const DEFAULT_LOGIN_DESTINATION: LoginDestination = "/";

const PENDING_SOCIAL_LOGIN_DESTINATION =
  "zuuli.auth.pending-social-login-destination";

type DestinationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function safeLoginDestination(value: unknown): LoginDestination {
  if (value === "/buy") return "/wallet/fund";
  if (value === "/buy/send") return "/wallet/fund/send";
  if (
    value === "/wallet/fund" ||
    value === "/wallet/fund/activity" ||
    value === "/wallet/fund/send"
  ) {
    return value;
  }
  return DEFAULT_LOGIN_DESTINATION;
}

/** Resolve history state through the paid-route allowlist. */
export function loginDestinationFromState(state: unknown): LoginDestination {
  try {
    if (typeof state !== "object" || state === null) {
      return DEFAULT_LOGIN_DESTINATION;
    }
    return safeLoginDestination((state as { returnTo?: unknown }).returnTo);
  } catch {
    // Treat proxies/getters like any other malformed navigation state.
  }
  return DEFAULT_LOGIN_DESTINATION;
}

function localDestinationStorage(): DestinationStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Preserve the allowlisted destination if mobile OAuth cold-starts the app.
 * The value is revalidated when consumed; `/` needs no persistence.
 */
export function rememberPendingSocialLoginDestination(
  destination: LoginDestination,
  storage: DestinationStorage | null = localDestinationStorage(),
): void {
  if (!storage) return;
  try {
    if (destination !== DEFAULT_LOGIN_DESTINATION) {
      storage.setItem(PENDING_SOCIAL_LOGIN_DESTINATION, destination);
    } else {
      storage.removeItem(PENDING_SOCIAL_LOGIN_DESTINATION);
    }
  } catch {
    // Restricted storage must not prevent login.
  }
}

export function consumePendingSocialLoginDestination(
  storage: DestinationStorage | null = localDestinationStorage(),
): LoginDestination {
  if (!storage) return DEFAULT_LOGIN_DESTINATION;
  let stored: unknown;
  try {
    stored = storage.getItem(PENDING_SOCIAL_LOGIN_DESTINATION);
    storage.removeItem(PENDING_SOCIAL_LOGIN_DESTINATION);
  } catch {
    return DEFAULT_LOGIN_DESTINATION;
  }
  return safeLoginDestination(stored);
}

export function clearPendingSocialLoginDestination(
  storage: DestinationStorage | null = localDestinationStorage(),
): void {
  try {
    storage?.removeItem(PENDING_SOCIAL_LOGIN_DESTINATION);
  } catch {
    // Restricted storage must not prevent login cleanup.
  }
}
