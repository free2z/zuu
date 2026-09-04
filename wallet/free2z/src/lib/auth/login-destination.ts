export type LoginDestination =
  | "/"
  | "/ai"
  | "/wallet/fund"
  | "/wallet/fund/activity"
  | "/wallet/fund/send"
  | `/articles/${string}`
  | `/creator/${string}`
  | `/live/${string}`;

export const DEFAULT_LOGIN_DESTINATION: LoginDestination = "/";

const PENDING_SOCIAL_LOGIN_DESTINATION =
  "zuuli.auth.pending-social-login-destination";

type DestinationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Redirect input crosses history and storage boundaries. Match each dynamic
// segment to its backend schema, while accepting only canonical percent
// encoding for non-ASCII usernames. ASCII escapes such as `%61` stay rejected
// so one identity cannot have ambiguous redirect spellings.
const USERNAME = /^[\p{L}\p{N}_.@+-]+$/u;
const ARTICLE_VANITY = /^[-A-Za-z0-9_]+$/;

function decodedCanonicalSegment(segment: string): string | null {
  if (!segment.includes("%")) {
    return /^[\x00-\x7F]*$/.test(segment) ? segment : null;
  }
  try {
    const decoded = decodeURIComponent(segment);
    if (/^[\x00-\x7F]*$/.test(decoded)) return null;
    // Browser pathnames encode Unicode while retaining these valid username
    // punctuation characters when they were written literally. Keep that one
    // spelling canonical; accepting `%2B`/`%40` as well would give one route
    // two persisted redirect spellings.
    const canonical = encodeURIComponent(decoded)
      .replace(/%2B/g, "+")
      .replace(/%40/g, "@");
    return canonical === segment ? decoded : null;
  } catch {
    return null;
  }
}

function dynamicPaidDestination(value: string): LoginDestination | null {
  // React Router accepts one trailing slash on these leaf routes. Collapse it
  // to the canonical spelling before validation and persistence so a valid
  // paid flow returns to the same resource instead of falling back home.
  const canonicalValue = value.endsWith("/") ? value.slice(0, -1) : value;
  const match = /^\/(articles|creator|live)\/([^/]+)$/.exec(canonicalValue);
  if (!match) return null;
  const [, route, encodedSegment] = match;
  const segment = decodedCanonicalSegment(encodedSegment);
  if (!segment) return null;
  const length = [...segment].length;
  const valid =
    route === "articles"
      ? length <= 128 && ARTICLE_VANITY.test(segment)
      : length <= 150 && USERNAME.test(segment);
  return valid ? (canonicalValue as LoginDestination) : null;
}

export function safeLoginDestination(value: unknown): LoginDestination {
  if (value === "/buy") return "/wallet/fund";
  if (value === "/buy/send") return "/wallet/fund/send";
  if (
    value === "/ai" ||
    value === "/wallet/fund" ||
    value === "/wallet/fund/activity" ||
    value === "/wallet/fund/send"
  ) {
    return value;
  }
  return typeof value === "string"
    ? (dynamicPaidDestination(value) ?? DEFAULT_LOGIN_DESTINATION)
    : DEFAULT_LOGIN_DESTINATION;
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
