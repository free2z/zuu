export type LoginDestination = "/" | "/wallet/fund";

export const DEFAULT_LOGIN_DESTINATION: LoginDestination = "/";

const PENDING_SOCIAL_LOGIN_DESTINATION =
  "zuuli.auth.pending-social-login-destination";

type DestinationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Resolve history state through a deliberately tiny allowlist. This must never
 * become a generic internal-URL redirect: login currently needs only Wallet's
 * exact funding route.
 */
export function loginDestinationFromState(state: unknown): LoginDestination {
  try {
    if (typeof state !== "object" || state === null) {
      return DEFAULT_LOGIN_DESTINATION;
    }

    const returnTo = (state as { returnTo?: unknown }).returnTo;
    if (returnTo === "/wallet/fund" || returnTo === "/buy") {
      return "/wallet/fund";
    }
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
    if (destination === "/wallet/fund") {
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
  return loginDestinationFromState({ returnTo: stored });
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
