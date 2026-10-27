import {
  currentNextPath,
  isDeletionPending,
  keepPageHref,
} from "$lib/account-keep";
import { writable, type Writable } from "svelte/store";
import {
  recordAccountBalanceRead,
  beginAccountBalanceRead,
  inheritAccountBalanceRead,
  balanceSnapshot,
  compareBalanceSnapshots,
  type BalanceOwner,
} from "$lib/account-balance";
import { browser } from "$app/env";
import { apiFetch, ensureCSRFToken } from "$lib/api/config";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { readApiError, serverErrorMessage } from "$lib/api/api-errors.js";
import {
  isRequestTimeout,
  requestTimeoutMessage,
} from "$lib/api/request-timeout.js";
import { logoutDestination } from "$lib/logout-destination";
import { defineMessage, translateMessage } from "$lib/i18n-message";
import { retireResolvedSubscribeIdempotencyKeys } from "$lib/subscribe-idempotency.js";

const AUTH_MESSAGES = {
  loginFailed: defineMessage("auth.errors.loginFailed", "Login failed"),
  signupFailed: defineMessage("auth.errors.signupFailed", "Sign-up failed"),
  accountCreatedLoginFailed: defineMessage(
    "auth.errors.accountCreatedLoginFailed",
    "Account created, but login failed",
  ),
  verificationCodeRequired: defineMessage(
    "auth.errors.verificationCodeRequired",
    "Please enter the verification code",
  ),
  invalidVerificationCode: defineMessage(
    "auth.errors.invalidVerificationCode",
    "Invalid verification code",
  ),
  recaptchaFailed: defineMessage(
    "auth.errors.recaptchaFailed",
    "reCAPTCHA verification failed. Please try again.",
  ),
  passwordResetFailed: defineMessage(
    "auth.errors.passwordResetFailed",
    "Password reset failed",
  ),
  //the request half is on the tight 'anon-recovery' throttle, so a
  // second click is the likeliest refusal it ever sees. "Password reset
  // failed" read as "this address has no account" and sent people to sign up.
  passwordResetThrottled: defineMessage(
    "auth.errors.passwordResetThrottled",
    "Too many password reset requests. Wait a few minutes, then check your inbox before requesting another.",
  ),
  verificationFailed: defineMessage(
    "auth.errors.verificationFailed",
    "Verification failed",
  ),
  //the credential throttles fail CLOSED -- a 503 when their Redis
  // is down. Our copy only when the server's own `detail` is unusable.
  signInUnavailable: defineMessage(
    "auth.errors.signInUnavailable",
    "Sign-in is temporarily unavailable. Please try again in a minute.",
  ),
};

/** `errorCode` of a result refused because sign-in is unavailable (503). */
export const AUTH_UNAVAILABLE_CODE = "auth_unavailable";

/**
 * A 503 from `/api/start/` or `/api/auth/login/`: the rate limiter
 * cannot count the attempt, so the server refuses it. Nothing about the
 * credentials is wrong, and "Login failed" / "Authentication failed" would
 * send the visitor to reset a password that is fine.
 */
class AuthUnavailableError extends Error {}

async function throwIfAuthUnavailable(response: Response): Promise<void> {
  if (response.status !== 503) return;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch (err) {
    // A body stalled past the bound is a timeout, not a refusal;
    // anything else (an HTML proxy page, no body) just has no sentence.
    if (isRequestTimeout(err)) throw err;
  }
  throw new AuthUnavailableError(
    serverErrorMessage(body) ||
      translateMessage(AUTH_MESSAGES.signInUnavailable),
  );
}

function authUnavailableResult(error: unknown) {
  return error instanceof AuthUnavailableError
    ? {
        success: false as const,
        error: error.message,
        errorCode: AUTH_UNAVAILABLE_CODE,
      }
    : null;
}

export const ACCOUNT_EXISTS_CODE = "ACCOUNT_EXISTS";

function isOtpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\botp\b|\b2fa\b|two[- ]factor/i.test(message);
}

function isCaptchaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /captcha|recaptcha/i.test(message);
}

/**
 * A sign-in, sign-up or recovery request that ended because a bound fired
 * says so, instead of "Login failed" -- which reads as a wrong password and
 * sends people to reset one. `null` when it was not a timeout.
 */
function timedOutResult(error: unknown) {
  const message = requestTimeoutMessage(error);
  return message
    ? {
        success: false as const,
        error: message,
        errorCode: REQUEST_TIMEOUT_CODE,
      }
    : null;
}

/** `errorCode` of a result whose request timed out; `error` is the sentence. */
export const REQUEST_TIMEOUT_CODE = "request_timeout";

function isAccountExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /already exists|username.+exists|unique/i.test(message);
}

// Types based on the React frontend
export interface Creator {
  id: number;
  username: string;
  full_name?: string;
  email?: string;
  avatar_image?: {
    url: string;
    thumbnail?: string;
  };
  banner_image?: {
    url: string;
    thumbnail?: string;
  };
  description?: string;
  p2paddr?: string;
  member_price?: string;
  is_verified?: boolean;
  can_stream?: boolean;
  tuzis?: string;
  balance_snapshot?: string;
  total?: string;
  zpages?: number;
  stars?: string[];
  star_ids?: number[];
  // The subscriber COUNT, not the roster. `fans` (every subscriber's username)
  // was removed from /api/auth/user/ in  -- it was an unbounded array on
  // a per-session endpoint whose only reader was `.length`. The roster itself
  // lives at GET /api/tuzis/my-subscribers, paginated.
  fans_count?: number;
  twitter?: any;
}

/**
 * Three states, not two.
 *
 * `isAuthenticated: false` used to mean both "the session came back 401" and
 * "we have not asked yet", so a signed-in visitor was shown a **Sign In**
 * button for as long as `/api/auth/user/` took to answer. `status` separates
 * them: only `anonymous` is an authoritative "not signed in", and only
 * `anonymous` may render a sign-in affordance.
 *
 * `unknown` is the *initial* value and is never re-entered: once a check has
 * resolved — success, 401, 500, or a network failure — the store settles on a
 * definite state. An affordance that can never resolve is worse than a wrong
 * one, so a check that fails for a non-auth reason settles on `anonymous`
 * (wrong but recoverable: the visitor can sign in) rather than parking the
 * navbar on a placeholder forever.
 */
export type AuthStatus = "unknown" | "authenticated" | "anonymous";

export interface AuthState {
  status: AuthStatus;
  isAuthenticated: boolean;
  creator: Creator | null;
  loading: boolean;
}

// Initial state
const initialState: AuthState = {
  status: "unknown",
  isAuthenticated: false,
  creator: null,
  loading: false,
};

const AUTH_CACHE_KEY = "auth";
const AUTH_REVALIDATE_WINDOW_MS = 15_000;

/**
 * Bootstrap retries for a session check that failed for a NON-auth reason —
 * a 5xx, a dropped connection, a rolling backend restart.
 *
 * Such a failure says nothing about the session, and the two ways of guessing
 * are both bad: claim anonymous and a signed-in creator loses Create, the
 * notification bell and their profile menu until something else happens to
 * trigger another check; stay unresolved and the navbar has a placeholder with
 * no way out. So retry a couple of times first — one flap costs the visitor
 * nothing — and only settle on `anonymous` (wrong, but recoverable: they can
 * sign in) once the backend has failed three times running.
 *
 * Worst case the placeholder is held for the sum of these plus three times
 * AUTH_CHECK_TIMEOUT_MS before Sign In appears. Keep it short: this is a
 * navbar, not a background sync.
 *
 * Only visitors who actually hold a `sessionid` retry: `applyServerSessionHint`
 * resolves everyone else from the SSR payload before the first check can fail,
 * so an auth outage does not turn every anonymous page view into three
 * requests.
 */
export const AUTH_BOOTSTRAP_RETRY_DELAYS_MS = [500, 1_500];

/**
 * Ceiling on a single session check.
 *
 * `fetch` has no default timeout, and nginx gives `/api` the server-level
 * 200-second read timeout — so a backend that accepts the connection and then
 * stops talking would otherwise hold the navbar placeholder for minutes, with
 * no Create, no notification bell and no profile menu. A hung check has to
 * become a *failed* check so the retry/settle path can run. Deliberately
 * generous: aborting a slow-but-healthy response costs the visitor a
 * needless round-trip.
 */
export const AUTH_CHECK_TIMEOUT_MS = 8_000;

// Create the auth store
function createAuthStore() {
  const { subscribe, set }: Writable<AuthState> = writable(initialState);
  let currentState = initialState;
  let authCheckPromise: Promise<boolean> | null = null;
  let authCheckGeneration = -1;
  let balanceSnapshotOrder = 0;
  let authCheckReadOrder = -1;
  let successfulAuthCheckReadOrder = -1;
  let logoutPromise: Promise<boolean> | null = null;
  // Cookie-setting responses must complete in request order. Canceling a
  // dialog cannot undo a credential exchange already sent to the server.
  let sessionMutationTail: Promise<void> = Promise.resolve();
  function serializeSessionMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = sessionMutationTail.then(operation);
    sessionMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  let lastValidatedAt = 0;
  let authGeneration = 0;
  // Fresh identity reads advance authGeneration to fence older responses, but
  // starting one does not retire same-owner expiry guidance. Only an explicit
  // clear or an account transition ends that anonymous guidance epoch.
  let authExpiryEpoch = 0;
  // Request ownership follows accounts/session transitions, rather than auth
  // read replacement: a normal balance refresh must preserve a paid attempt.
  let requestOwnershipGeneration = 0;
  // This attributes expiry to a session cohort, never to a unique request.
  // It permits generic feedback only; it cannot authorize a write or receipt.
  let ownedAuthExpiry: {
    ownerGeneration: number;
    resultGeneration: number;
    resultExpiryEpoch: number;
  } | null = null;
  const requestOwner = (state: AuthState) =>
    state.creator
      ? state.creator.id != null
        ? `id:${state.creator.id}`
        : `username:${state.creator.username}`
      : state.status;
  let bootstrapRetries = 0;
  let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function persistState(state: AuthState) {
    if (!browser) {
      return;
    }

    if (state.isAuthenticated && state.creator) {
      // Database visibility tokens belong to this in-memory connection epoch.
      // A restored cluster may restart below a token saved by an older cluster.
      const cachedCreator = { ...state.creator };
      delete cachedCreator.balance_snapshot;
      localStorage.setItem(
        AUTH_CACHE_KEY,
        JSON.stringify({ ...state, creator: cachedCreator }),
      );
      return;
    }

    localStorage.removeItem(AUTH_CACHE_KEY);
  }

  function applyState(state: AuthState) {
    if (requestOwner(state) !== requestOwner(currentState))
      requestOwnershipGeneration += 1;
    if (state.creator)
      inheritAccountBalanceRead(state.creator, currentState.creator);
    currentState = state;
    set(state);
    persistState(state);
  }

  function patchState(
    nextState: AuthState | ((state: AuthState) => AuthState),
  ) {
    const resolvedState =
      typeof nextState === "function" ? nextState(currentState) : nextState;
    applyState(resolvedState);
  }

  function cancelBootstrapRetry() {
    if (bootstrapRetryTimer !== null) {
      clearTimeout(bootstrapRetryTimer);
      bootstrapRetryTimer = null;
    }
  }

  // Every caller of this is an AUTHORITATIVE logged-out outcome: a 401/403
  // from the session endpoint, a confirmed logout, or an explicit clear().
  // "We have not checked yet" must never come through here — that is what
  // leaves `status` at `unknown`.
  function clearAuthState(keepLoading = false, invalidateOwnedExpiry = true) {
    authGeneration += 1;
    if (invalidateOwnedExpiry) authExpiryEpoch += 1;
    cancelBootstrapRetry();
    applyState({
      ...initialState,
      status: "anonymous",
      loading: keepLoading,
    });
  }

  // A successful credential exchange changes the cookie before the identity
  // lookup resolves. The previous creator cannot authorize work in that gap.
  function beginSessionIdentityLookup() {
    authGeneration += 1;
    requestOwnershipGeneration += 1;
    cancelBootstrapRetry();
    lastValidatedAt = 0;
    bootstrapRetries = 0;
    applyState({ ...initialState, loading: true });
    return authGeneration;
  }

  function setAuthenticatedState(
    creator: Creator,
    loading = false,
    readOrder?: number,
  ) {
    recordAccountBalanceRead(
      creator,
      readOrder,
      readOrder !== undefined,
      readOrder !== undefined,
    );
    cancelBootstrapRetry();
    applyState({
      status: "authenticated",
      isAuthenticated: true,
      creator,
      loading,
    });
    if (browser) {
      retireResolvedSubscribeIdempotencyKeys(
        creator.stars,
        creator.id,
        creator.star_ids,
        creator.username,
      );
    }
  }

  /**
   * Adopt the session established by a login or sign-up.
   *
   * Bumping `authGeneration` is the load-bearing part, and it mirrors what
   * logout does for the opposite reason. A session check started *before* the
   * login — a bootstrap retry armed while the backend was flapping, say —
   * carries the pre-login cookie and can come back 401 a moment after the new
   * creator has been applied. Without the bump it passes the staleness check
   * and `handleAuthFailure()` signs the visitor straight back out.
   */
  function adoptAuthenticatedSession(creator: Creator) {
    authGeneration += 1;
    requestOwnershipGeneration += 1;
    lastValidatedAt = Date.now();
    setAuthenticatedState(creator);
  }

  /**
   * A check that neither succeeded nor came back 401/403 tells us nothing
   * about the session. Retry a bounded number of times before guessing — see
   * AUTH_BOOTSTRAP_RETRY_DELAYS_MS. Only once the backend has failed every
   * attempt do we settle on `anonymous`, which is wrong for a signed-in
   * visitor but at least recoverable; an unresolved placeholder that never
   * clears is not.
   *
   * A no-op once any answer has landed: this only ever moves `unknown`
   * forward, so a network blip can never sign an authenticated store out.
   *
   * `retryable` is false when the backend told us to back off (429) or
   * rejected the request outright (any other 4xx). Retrying a 429 is the one
   * thing guaranteed to make an overloaded backend worse.
   */
  function settleUnresolvedState(retryable = true) {
    if (currentState.status !== "unknown") {
      return;
    }

    const delay = retryable
      ? AUTH_BOOTSTRAP_RETRY_DELAYS_MS[bootstrapRetries]
      : undefined;
    if (delay !== undefined) {
      bootstrapRetries += 1;
      cancelBootstrapRetry();
      bootstrapRetryTimer = setTimeout(() => {
        bootstrapRetryTimer = null;
        // Still unresolved? Another tab, a focus event or a navigation may
        // have answered the question while this timer was armed.
        if (currentState.status !== "unknown") return;
        void store.checkAuth({ force: true, silent: true });
      }, delay);
      return;
    }

    applyState({ ...currentState, status: "anonymous" });
  }

  const store = {
    subscribe,

    // Set loading state
    setLoading: (loading: boolean) => {
      patchState((state) => ({ ...state, loading }));
    },

    updateCreator: (creator: Creator) => {
      patchState((state) => ({
        ...state,
        status: "authenticated",
        isAuthenticated: true,
        creator,
      }));
    },

    setSubscription: (
      username: string,
      subscribed: boolean,
      creatorId?: number,
    ) => {
      patchState((state) => {
        if (!state.creator) {
          return state;
        }

        const stars = new Set(state.creator.stars ?? []);
        if (subscribed) {
          stars.add(username);
        } else {
          stars.delete(username);
        }

        const starIds = new Set(state.creator.star_ids ?? []);
        if (creatorId !== undefined) {
          if (subscribed) {
            starIds.add(creatorId);
          } else {
            starIds.delete(creatorId);
          }
        }

        return {
          ...state,
          creator: {
            ...state.creator,
            stars: [...stars],
            ...(creatorId !== undefined ? { star_ids: [...starIds] } : {}),
          },
        };
      });
    },

    isSubscribedTo: (username: string, creatorId?: number) => {
      if (creatorId !== undefined && currentState.creator?.star_ids) {
        return currentState.creator.star_ids.includes(creatorId);
      }
      return Boolean(currentState.creator?.stars?.includes(username));
    },

    hydrateFromSession: (creator: Creator | null) => {
      if (creator) {
        setAuthenticatedState(creator);
        return;
      }
      clearAuthState();
    },

    /**
     * Resolve the store from what the server already knew.
     *
     * `hasSession` is `+layout.server.ts`'s report of whether the request
     * carried a `sessionid` cookie. Django session auth cannot authenticate a
     * request without one, so `false` is authoritative and settles the store
     * with no round-trip at all: an anonymous visitor gets Sign In on the
     * first frame, and — the reason this is more than cosmetic — makes zero
     * bootstrap retries during a backend outage. Retries are then confined to
     * visitors who actually hold a session.
     *
     * `true` proves nothing (the session may be expired), so it is a no-op.
     * So is any call once the store has resolved: after a client-side login
     * the page data is stale, and a stale `false` must never sign anyone out.
     */
    applyServerSessionHint: (hasSession: boolean | undefined) => {
      if (hasSession !== false) return;
      if (currentState.status !== "unknown") return;
      lastValidatedAt = Date.now();
      clearAuthState();
    },

    captureRequestOwnership: () => {
      const generation = requestOwnershipGeneration;
      return Object.assign(() => generation === requestOwnershipGeneration, {
        wasExpired: () =>
          currentState.status === "anonymous" &&
          ownedAuthExpiry?.ownerGeneration === generation &&
          ownedAuthExpiry.resultGeneration === requestOwnershipGeneration &&
          ownedAuthExpiry.resultExpiryEpoch === authExpiryEpoch,
      });
    },

    handleAuthFailure: (status: number) => {
      if (status === 401 || status === 403) {
        lastValidatedAt = Date.now();
        const ownerGeneration = requestOwnershipGeneration;
        const hadAuthenticatedOwner =
          currentState.status === "authenticated" &&
          currentState.creator !== null;
        // An auth rejection is authoritative even if the store is already
        // anonymous: an identity read may have started in that state and its
        // delayed 200 must not restore the former account. Preserve only a
        // still-current expiry attribution from this same anonymous cohort;
        // explicit clears and account changes have already made its epochs
        // stale and cannot be revived here.
        const previousExpiry = ownedAuthExpiry;
        const preserveOwnedExpiry =
          currentState.status === "anonymous" &&
          previousExpiry !== null &&
          previousExpiry.resultGeneration === requestOwnershipGeneration &&
          previousExpiry.resultExpiryEpoch === authExpiryEpoch;
        // A 401/403 is a revocation result, not an explicit user clear. Keep
        // the anonymous expiry epoch stable so overlapping fresh checks do
        // not erase generic guidance for the same authenticated owner.
        clearAuthState(false, false);
        if (hadAuthenticatedOwner) {
          ownedAuthExpiry = {
            ownerGeneration,
            resultGeneration: requestOwnershipGeneration,
            resultExpiryEpoch: authExpiryEpoch,
          };
        } else if (preserveOwnedExpiry) {
          ownedAuthExpiry = previousExpiry;
        } else {
          ownedAuthExpiry = null;
        }
        return true;
      }
      return false;
    },

    ensureAuthenticated: async () => {
      return store.checkAuth({ silent: true });
    },

    // Pure login function (only hits login endpoint)
    loginOnly: async (
      username: string,
      password: string,
      recaptcha?: string,
      otpToken?: string,
      isCurrent: () => boolean = () => true,
    ) =>
      serializeSessionMutation(async () => {
        if (!isCurrent())
          return {
            success: false,
            error: translateMessage(AUTH_MESSAGES.loginFailed),
          };
        let loginGeneration: number | undefined;
        let retryIdentity = true;
        let identityAbort:
          ReturnType<typeof createAbortSignalWithTimeout> | undefined;
        try {
          patchState((state) => ({ ...state, loading: true }));

          const loginData: any = { username, password };
          if (recaptcha !== undefined) loginData.captcha_result = recaptcha;
          if (otpToken) loginData.otp_token = otpToken;

          // `apiFetch`: CSRF, credentials and the write bound.
          const response = await apiFetch("/api/auth/login/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(loginData),
          });

          await throwIfAuthUnavailable(response);
          if (!response.ok) {
            let errorMessage = "Login failed";
            try {
              const errorData = await response.json();
              // An account in its deletion grace period: no session yet --
              // the holder chooses "Keep my account" first.
              if (response.status === 409 && isDeletionPending(errorData)) {
                patchState((state) => ({ ...state, loading: false }));
                window.location.assign(
                  keepPageHref(errorData, currentNextPath()),
                );
                return { success: false, error: "" };
              }
              errorMessage =
                errorData?.message ||
                errorData?.non_field_errors?.[0] ||
                errorData?.detail ||
                (Object.values(errorData ?? {}) as string[][])?.[0]?.[0] ||
                errorMessage;
              if (errorData?.captcha_result && !/captcha/i.test(errorMessage)) {
                errorMessage = `captcha: ${errorMessage}`;
              }
            } catch (err) {
              // A body stalled past the bound is a timeout, not a refusal
              // (codex review): keep it recognisable to timedOutResult.
              if (isRequestTimeout(err)) throw err;
              console.error("Failed to parse JSON response in loginOnly:", err);
            }
            throw new Error(errorMessage);
          }

          loginGeneration = beginSessionIdentityLookup();
          // Bound the read through body consumption so a stalled identity
          // lookup cannot hold queued logout or the next credential exchange.
          identityAbort = createAbortSignalWithTimeout(
            null,
            AUTH_CHECK_TIMEOUT_MS,
          );
          // Get user data
          const userResponse = await fetch("/api/auth/user/", {
            signal: identityAbort.signal,
            method: "GET",
            credentials: "include",
          });

          if (!userResponse.ok) {
            retryIdentity = userResponse.status >= 500;
            if (loginGeneration === authGeneration) {
              store.handleAuthFailure(userResponse.status);
            }
            throw new Error("Failed to fetch user data");
          }

          const creator = await userResponse.json();
          if (loginGeneration !== authGeneration) {
            throw new Error("Session changed during identity lookup");
          }

          adoptAuthenticatedSession(creator);

          return { success: true, creator };
        } catch (error: any) {
          patchState((state) => ({ ...state, loading: false }));
          if (loginGeneration === authGeneration)
            settleUnresolvedState(retryIdentity);

          const unavailable = authUnavailableResult(error);
          if (unavailable) return unavailable;

          // Check if OTP is required
          if (isOtpError(error)) {
            const descriptor = otpToken
              ? AUTH_MESSAGES.invalidVerificationCode
              : AUTH_MESSAGES.verificationCodeRequired;
            return {
              success: false,
              requiresOTP: true,
              error: translateMessage(descriptor),
              errorCode: descriptor.key,
            };
          }

          if (isCaptchaError(error)) {
            return {
              success: false,
              error: translateMessage(AUTH_MESSAGES.recaptchaFailed),
              errorCode: AUTH_MESSAGES.recaptchaFailed.key,
            };
          }

          return (
            timedOutResult(error) ?? {
              success: false,
              error: translateMessage(AUTH_MESSAGES.loginFailed),
              errorCode: AUTH_MESSAGES.loginFailed.key,
            }
          );
        } finally {
          identityAbort?.cleanup();
        }
      }),

    // Combined login/signup function (auto-detects whether to create account or login)
    // Strategy: attempt signup first -> if user exists (409/400/422), fallback to login.
    login: async (
      username: string,
      password: string,
      recaptcha?: string,
      otpToken?: string,
      isCurrent: () => boolean = () => true,
    ) =>
      serializeSessionMutation(async () => {
        if (!isCurrent())
          return {
            success: false,
            error: translateMessage(AUTH_MESSAGES.loginFailed),
          };
        let loginGeneration: number | undefined;
        let retryIdentity = true;
        let identityAbort:
          ReturnType<typeof createAbortSignalWithTimeout> | undefined;
        try {
          patchState((state) => ({ ...state, loading: true }));

          const loginData: any = { username, password };
          if (recaptcha !== undefined) loginData.captcha_result = recaptcha;
          if (otpToken) loginData.otp_token = otpToken;
          // Attempt signup first (mirrors legacy React flow). If signup succeeds (201), perform explicit login.
          let signupResponse = await apiFetch("/api/start/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username,
              password,
              captcha_result: recaptcha,
            }),
          });

          let finalAuthResponse: Response | null = null;

          // Checked before the 4xx fallback: a 503 is not "the user exists",
          // and falling through to /api/auth/login/ would only be refused
          // again by the same unavailable throttle.
          await throwIfAuthUnavailable(signupResponse);
          if (signupResponse.ok) {
            // New account created -> must now call login to establish session (backend does not auto-auth on /api/start/)
            if (!isCurrent())
              return {
                success: false,
                error: translateMessage(AUTH_MESSAGES.loginFailed),
              };
            finalAuthResponse = await apiFetch("/api/auth/login/", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(loginData),
            });
          } else if (
            [400, 401, 403, 409, 422].includes(signupResponse.status)
          ) {
            // Existing user or validation style error -> try login directly
            if (!isCurrent())
              return {
                success: false,
                error: translateMessage(AUTH_MESSAGES.loginFailed),
              };
            finalAuthResponse = await apiFetch("/api/auth/login/", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(loginData),
            });
          } else {
            // Other failure from signup: surface error
            let errorMessage = "Authentication failed";
            try {
              const errorData = await signupResponse.json();
              if (errorData?.message) errorMessage = errorData.message;
            } catch (err) {
              // A body stalled past the bound is a timeout, not a refusal.
              if (isRequestTimeout(err)) throw err;
            }
            throw new Error(errorMessage);
          }

          if (finalAuthResponse)
            await throwIfAuthUnavailable(finalAuthResponse);
          if (!finalAuthResponse || !finalAuthResponse.ok) {
            let errorMessage = "Authentication failed";
            try {
              const errorData = await finalAuthResponse?.json();
              if (errorData?.message) errorMessage = errorData.message;
            } catch (err) {
              // A body stalled past the bound is a timeout, not a refusal.
              if (isRequestTimeout(err)) throw err;
            }
            throw new Error(errorMessage);
          }

          loginGeneration = beginSessionIdentityLookup();
          // Bound the read through body consumption so a stalled identity
          // lookup cannot hold queued logout or the next credential exchange.
          identityAbort = createAbortSignalWithTimeout(
            null,
            AUTH_CHECK_TIMEOUT_MS,
          );
          // Get user data
          const userResponse = await apiFetch("/api/auth/user/", {
            signal: identityAbort.signal,
            method: "GET",
          });

          if (!userResponse.ok) {
            retryIdentity = userResponse.status >= 500;
            if (loginGeneration === authGeneration) {
              store.handleAuthFailure(userResponse.status);
            }
            throw new Error("Failed to fetch user data");
          }

          const creator = await userResponse.json();
          if (loginGeneration !== authGeneration) {
            throw new Error("Session changed during identity lookup");
          }

          adoptAuthenticatedSession(creator);

          return { success: true, creator };
        } catch (error: any) {
          patchState((state) => ({ ...state, loading: false }));
          if (loginGeneration === authGeneration)
            settleUnresolvedState(retryIdentity);

          const unavailable = authUnavailableResult(error);
          if (unavailable) return unavailable;

          // Check if OTP is required
          if (isOtpError(error)) {
            const descriptor = otpToken
              ? AUTH_MESSAGES.invalidVerificationCode
              : AUTH_MESSAGES.verificationCodeRequired;
            return {
              success: false,
              requiresOTP: true,
              error: translateMessage(descriptor),
              errorCode: descriptor.key,
            };
          }

          if (isCaptchaError(error)) {
            return {
              success: false,
              error: translateMessage(AUTH_MESSAGES.recaptchaFailed),
              errorCode: AUTH_MESSAGES.recaptchaFailed.key,
            };
          }

          return (
            timedOutResult(error) ?? {
              success: false,
              error: translateMessage(AUTH_MESSAGES.loginFailed),
              errorCode: AUTH_MESSAGES.loginFailed.key,
            }
          );
        } finally {
          identityAbort?.cleanup();
        }
      }),

    // Explicit signup only (in case we add a dedicated Sign Up button later)
    signup: async (
      username: string,
      password: string,
      recaptcha?: string,
      isCurrent: () => boolean = () => true,
    ) =>
      serializeSessionMutation(async () => {
        if (!isCurrent())
          return {
            success: false,
            error: translateMessage(AUTH_MESSAGES.loginFailed),
          };
        let loginGeneration: number | undefined;
        let retryIdentity = true;
        let identityAbort:
          ReturnType<typeof createAbortSignalWithTimeout> | undefined;
        try {
          patchState((state) => ({ ...state, loading: true }));

          const response = await apiFetch("/api/start/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username,
              password,
              captcha_result: recaptcha,
            }),
          });

          await throwIfAuthUnavailable(response);
          if (!response.ok) {
            // /api/start/ reports "username already exists" as a DRF field
            // error (`{username: ["..."]}`), not as `message`. Extract the same
            // way loginOnly does, otherwise isAccountExistsError() below never
            // fires and the sign-up -> log-in fallback silently stops working.
            let errorMessage = "Signup failed";
            try {
              const errorData = await response.json();
              errorMessage =
                errorData?.message ||
                errorData?.error ||
                errorData?.non_field_errors?.[0] ||
                errorData?.detail ||
                (Object.values(errorData ?? {}) as string[][])?.[0]?.[0] ||
                errorMessage;
            } catch (err) {
              // A body stalled past the bound is a timeout, not a refusal.
              if (isRequestTimeout(err)) throw err;
            }
            throw new Error(errorMessage);
          }

          // Explicit login after successful signup to establish session
          const loginPayload: any = { username, password };
          if (recaptcha) loginPayload.captcha_result = recaptcha;
          if (!isCurrent())
            return {
              success: false,
              error: translateMessage(AUTH_MESSAGES.loginFailed),
            };
          const loginResponse = await apiFetch("/api/auth/login/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(loginPayload),
          });

          await throwIfAuthUnavailable(loginResponse);
          if (!loginResponse.ok) {
            let errorMessage = "Login after signup failed";
            try {
              const errorData = await loginResponse.json();
              if (errorData?.message) errorMessage = errorData.message;
            } catch (err) {
              // A body stalled past the bound is a timeout, not a refusal.
              if (isRequestTimeout(err)) throw err;
            }
            throw new Error(errorMessage);
          }

          loginGeneration = beginSessionIdentityLookup();
          // Bound the read through body consumption so a stalled identity
          // lookup cannot hold queued logout or the next credential exchange.
          identityAbort = createAbortSignalWithTimeout(
            null,
            AUTH_CHECK_TIMEOUT_MS,
          );
          // Fetch user after signup
          const userResponse = await fetch("/api/auth/user/", {
            signal: identityAbort.signal,
            method: "GET",
            credentials: "include",
          });

          if (!userResponse.ok) {
            retryIdentity = userResponse.status >= 500;
            if (loginGeneration === authGeneration) {
              store.handleAuthFailure(userResponse.status);
            }
            throw new Error("Failed to fetch user data after signup");
          }

          const creator = await userResponse.json();
          if (loginGeneration !== authGeneration) {
            throw new Error("Session changed during identity lookup");
          }
          adoptAuthenticatedSession(creator);
          return { success: true, creator };
        } catch (error: any) {
          patchState((state) => ({ ...state, loading: false }));
          if (loginGeneration === authGeneration)
            settleUnresolvedState(retryIdentity);
          const unavailable = authUnavailableResult(error);
          if (unavailable) return unavailable;
          if (isAccountExistsError(error)) {
            return {
              success: false,
              error: translateMessage(AUTH_MESSAGES.signupFailed),
              errorCode: ACCOUNT_EXISTS_CODE,
            };
          }
          return (
            timedOutResult(error) ?? {
              success: false,
              error: translateMessage(AUTH_MESSAGES.signupFailed),
              errorCode: AUTH_MESSAGES.signupFailed.key,
            }
          );
        } finally {
          identityAbort?.cleanup();
        }
      }),

    // Logout function
    logout: async () => {
      if (logoutPromise) {
        return logoutPromise;
      }

      logoutPromise = serializeSessionMutation(async () => {
        // Decided BEFORE the request, from the page the visitor is actually
        // on; re-checked after it. See the fail-safe note below.
        const startedAt = window.location.href;
        const destination = logoutDestination(window.location.pathname);
        try {
          patchState((state) => ({ ...state, loading: true }));

          // `apiFetch`: CSRF, credentials and the write bound. A
          // logout that never answers must not hold the session mutex (and
          // every sign-in queued behind it) forever.
          const response = await apiFetch("/api/auth/logout/", {
            method: "POST",
          });

          // A CSRF or upstream failure can leave the server session valid. Do
          // not present a logged-out UI on a shared device unless Django
          // confirmed logout (or already reports that the session is gone).
          if (!response.ok && response.status !== 401) {
            throw new Error(`Logout failed with status ${response.status}`);
          }

          // Any auth check that started before this point authenticated the
          // old session and must not be allowed to repopulate the store.
          authGeneration += 1;
          lastValidatedAt = Date.now();
          clearAuthState();

          // Force a new document — ALWAYS. The homepage derives several
          // display lists once when its component mounts, and an
          // authenticated response can include private drafts; client-side
          // invalidation alone must not leave those snapshots visible after
          // logout. A client-side navigation or an invalidation is not a
          // substitute here.
          //
          // Which document is the only question. A page that reads
          // perfectly well logged out — a zPage, a Converse thread — keeps
          // its URL and is reloaded; a page that needs a session (or one we
          // do not recognise: fail-safe) leaves for the homepage as before.
          // The verdict was taken before the request and applies only if the
          // URL has not moved since: a navigation that lands mid-logout must
          // not be reloaded under a stale classification.
          if (destination === "reload" && window.location.href === startedAt) {
            window.location.reload();
          } else {
            window.location.assign("/");
          }
          return true;
        } catch (error) {
          console.error("Logout error:", error);
          patchState((state) => ({ ...state, loading: false }));
          return false;
        } finally {
          logoutPromise = null;
        }
      });

      return logoutPromise;
    },

    // Check if user is authenticated (for guards)
    checkAuth: async (
      options: { force?: boolean; silent?: boolean; fresh?: boolean } = {},
    ) => {
      const { force = false, silent = false, fresh = false } = options;
      if (fresh) {
        // Recovery must observe a response that started after the receipt was
        // reconciled. Do not reuse a pre-existing in-flight check whose 200 or
        // cached failure predates that settlement.
        authGeneration += 1;
        authCheckPromise = null;
        authCheckGeneration = -1;
      }
      if (
        authCheckPromise &&
        authCheckGeneration === authGeneration &&
        authCheckReadOrder > balanceSnapshotOrder
      ) {
        return authCheckPromise;
      }

      if (
        !force &&
        !fresh &&
        Date.now() - lastValidatedAt < AUTH_REVALIDATE_WINDOW_MS
      ) {
        return currentState.isAuthenticated;
      }

      if (authCheckPromise && authCheckGeneration === authGeneration) {
        // A replacement read owns session truth, including identity and401.
        // Retire the fenced request before dispatching another check.
        authGeneration += 1;
        authCheckPromise = null;
        authCheckGeneration = -1;
      }

      const checkGeneration = authGeneration;
      const checkOwner = requestOwnershipGeneration;
      const checkReadOrder = beginAccountBalanceRead();
      authCheckGeneration = checkGeneration;
      authCheckReadOrder = checkReadOrder;
      authCheckPromise = (async () => {
        if (!silent) {
          patchState((state) => ({ ...state, loading: true }));
        }

        // `fetch` never times out on its own and nginx lets /api run to its
        // 200s read timeout, so without this a hung backend holds the navbar
        // placeholder for minutes. AbortSignal.timeout() is above the client
        // browser baseline — see $lib/abort-signal.js.
        const abort = createAbortSignalWithTimeout(null, AUTH_CHECK_TIMEOUT_MS);

        const supersededResult = async () => {
          // A retired response cannot authorize a write. Let the
          // newer check settle session truth before its caller attributes a
          // refusal to expiry; otherwise that check can clear the refusal toast
          // just after the caller displayed it. Never wait across account owners
          // or beyond this request's original deadline.
          let observedReadOrder = checkReadOrder;
          while (
            checkOwner === requestOwnershipGeneration &&
            !abort.signal.aborted &&
            authCheckPromise &&
            authCheckGeneration > checkGeneration &&
            authCheckReadOrder > observedReadOrder
          ) {
            observedReadOrder = authCheckReadOrder;
            const replacement = authCheckPromise;
            let onAbort: () => void = () => {};
            const deadline = new Promise<void>((resolve) => {
              onAbort = resolve;
              abort.signal.addEventListener("abort", onAbort, { once: true });
            });
            const unsubscribe = { current: () => {} };
            const ownerChanged = new Promise<void>((resolve) => {
              unsubscribe.current = subscribe(() => {
                if (checkOwner !== requestOwnershipGeneration) resolve();
              });
            });
            try {
              await Promise.race([
                ownerChanged,
                replacement.then(
                  () => {},
                  () => {},
                ),
                deadline,
              ]);
            } finally {
              abort.signal.removeEventListener("abort", onAbort);
              unsubscribe.current();
            }
          }
          // The replacement may have completed before the stale response
          // arrived. Only its exact current, successful read can satisfy an
          // ordinary guard; a later pending or failed read cannot reuse it.
          return (
            !fresh &&
            !abort.signal.aborted &&
            !authCheckPromise &&
            checkOwner === requestOwnershipGeneration &&
            authCheckGeneration > checkGeneration &&
            authCheckGeneration === authGeneration &&
            successfulAuthCheckReadOrder === authCheckReadOrder
          );
        };

        try {
          const response = await fetch("/api/auth/user/", {
            method: "GET",
            credentials: "include",
            cache: fresh ? "no-store" : undefined,
            signal: abort.signal,
          });

          if (response.ok) {
            const creator = await response.json();
            if (checkGeneration !== authGeneration) {
              return await supersededResult();
            }
            const observed = balanceSnapshot(creator.balance_snapshot);
            const currentObserved = balanceSnapshot(
              currentState.creator?.balance_snapshot,
            );
            if (
              observed &&
              currentObserved &&
              compareBalanceSnapshots(
                creator.balance_snapshot,
                currentState.creator?.balance_snapshot,
              ) === -1 &&
              creator.username === currentState.creator?.username &&
              creator.id === currentState.creator?.id
            ) {
              successfulAuthCheckReadOrder = checkReadOrder;
              lastValidatedAt = Date.now();
              return fresh ? false : currentState.isAuthenticated;
            }
            if (
              checkReadOrder <= balanceSnapshotOrder &&
              creator.username === currentState.creator?.username &&
              creator.id === currentState.creator?.id
            ) {
              // Preserve a newer balance snapshot, while still allowing a changed
              // authenticated identity or an auth failure to resolve normally.
              successfulAuthCheckReadOrder = checkReadOrder;
              lastValidatedAt = Date.now();
              return fresh ? false : currentState.isAuthenticated;
            }
            setAuthenticatedState(creator, false, checkReadOrder);
            successfulAuthCheckReadOrder = checkReadOrder;
            lastValidatedAt = Date.now();
            return true;
          }

          if (checkGeneration !== authGeneration) {
            return await supersededResult();
          }

          if (store.handleAuthFailure(response.status)) {
            return false;
          }

          // A 5xx (or anything else non-auth) tells us nothing about the
          // session, but the navbar still has to render something the visitor
          // can act on. See settleUnresolvedState(). A 429 is the backend
          // asking for less traffic, not a transient blip — do not retry it.
          lastValidatedAt = Date.now();
          settleUnresolvedState(response.status >= 500);
          return fresh ? false : currentState.isAuthenticated;
        } catch (error) {
          console.error("Auth check failed:", error);
          if (checkGeneration !== authGeneration) {
            return await supersededResult();
          }
          lastValidatedAt = Date.now();
          settleUnresolvedState();
          return fresh ? false : currentState.isAuthenticated;
        } finally {
          abort.cleanup();
          // A previous session's request must not clear a newer check.
          if (
            authCheckGeneration === checkGeneration &&
            authCheckReadOrder === checkReadOrder
          ) {
            authCheckPromise = null;
            if (!silent) {
              patchState((state) => ({ ...state, loading: false }));
            }
          }
        }
      })();

      return authCheckPromise;
    },

    /** Adopt only a demonstrably newer balance, preserving profile/form metadata. */
    observeAccountBalanceSnapshot: (owner: BalanceOwner) => {
      const current = currentState.creator;
      if (
        !current ||
        current.username !== owner.username ||
        (owner.id !== undefined && current.id !== owner.id)
      )
        return;
      const observed = balanceSnapshot(owner.balance_snapshot);
      const currentObserved = balanceSnapshot(current.balance_snapshot);
      if (observed && currentObserved) {
        if (
          compareBalanceSnapshots(
            owner.balance_snapshot,
            current.balance_snapshot,
          ) === 1
        ) {
          patchState({
            ...currentState,
            creator: {
              ...current,
              tuzis: String(owner.tuzis ?? current.tuzis ?? "0"),
              balance_snapshot: owner.balance_snapshot,
            },
          });
        }
        return;
      }
      // Legacy payloads cannot prove read ordering. The layout coalesces and
      // retries an authoritative read instead of fencing at render time.
      if (browser)
        window.dispatchEvent(
          new CustomEvent("account-balance-reconcile", {
            detail: owner.username,
          }),
        );
    },

    /** Ignore checks begun before a newer server balance snapshot was displayed. */
    fenceAccountSnapshot: (username: string, readOrder?: number) => {
      if (currentState.creator?.username !== username) return;
      balanceSnapshotOrder = Math.max(
        balanceSnapshotOrder,
        readOrder ?? beginAccountBalanceRead(),
      );
    },

    /**
     * Exposes ensureCSRFToken for other UI modules to obtain a CSRF token.
     * you can make a GET request to /api/auth/user/ to allow the backend to set the csrftoken cookie if needed.
     * @returns {Promise<string | null>} The CSRF token string if available, or null if not in browser environment or after failed attempts.
     * @throws {never} Does not throw errors; network failures are handled internally.
     */
    ensureCSRFToken,

    // Clear auth state (for errors)
    clear: () => {
      lastValidatedAt = Date.now();
      clearAuthState();
    },

    // Password reset function
    resetPassword: async (email: string) => {
      try {
        patchState((state) => ({ ...state, loading: true }));

        const response = await apiFetch("/api/emails/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        patchState((state) => ({ ...state, loading: false }));

        if (!response.ok) {
          const message =
            response.status === 429
              ? AUTH_MESSAGES.passwordResetThrottled
              : AUTH_MESSAGES.passwordResetFailed;
          return {
            success: false,
            error: translateMessage(message),
            errorCode: message.key,
          };
        }

        return { success: true };
      } catch (error: any) {
        patchState((state) => ({ ...state, loading: false }));
        return (
          timedOutResult(error) ?? {
            success: false,
            error: translateMessage(AUTH_MESSAGES.passwordResetFailed),
            errorCode: AUTH_MESSAGES.passwordResetFailed.key,
          }
        );
      }
    },

    // Send email verification
    sendEmailVerification: async (email: string) => {
      try {
        const response = await apiFetch("/api/emails/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          // The server's own sentence, e.g. an address that is
          // already on the account; our copy when it gave none.
          const { message } = await readApiError(response);
          return {
            success: false,
            error:
              message || translateMessage(AUTH_MESSAGES.verificationFailed),
            errorCode: AUTH_MESSAGES.verificationFailed.key,
          };
        }

        return { success: true };
      } catch (error: any) {
        return (
          timedOutResult(error) ?? {
            success: false,
            error: translateMessage(AUTH_MESSAGES.verificationFailed),
            errorCode: AUTH_MESSAGES.verificationFailed.key,
          }
        );
      }
    },
  };

  if (browser) {
    const stored = localStorage.getItem(AUTH_CACHE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as AuthState;
        if (parsed.isAuthenticated && parsed.creator) {
          const cachedCreator = { ...parsed.creator };
          delete cachedCreator.balance_snapshot;
          store.hydrateFromSession(cachedCreator);
        } else {
          localStorage.removeItem(AUTH_CACHE_KEY);
        }
      } catch {
        localStorage.removeItem(AUTH_CACHE_KEY);
      }
    }
  }

  return store;
}

export const authStore = createAuthStore();

// Derived stores for convenience
export const isAuthenticated = {
  subscribe: (callback: (value: boolean) => void) =>
    authStore.subscribe((state) => callback(state.isAuthenticated)),
};

export const currentUser = {
  subscribe: (callback: (value: Creator | null) => void) =>
    authStore.subscribe((state) => callback(state.creator)),
};

export const authLoading = {
  subscribe: (callback: (value: boolean) => void) =>
    authStore.subscribe((state) => callback(state.loading)),
};

/**
 * `unknown` until the session has been resolved once. Read this rather
 * than `isAuthenticated` anywhere a *signed-out* affordance is rendered:
 * `!isAuthenticated` is true during bootstrap too, and telling a signed-in
 * creator they are logged out is the single most alarming thing the UI can do.
 *
 * On the server this store is module-scoped and shared by every concurrent SSR
 * request, so nothing ever writes to it there and it always reads
 * `unknown` during SSR. The per-request server signal is `page.data.hasSession`
 * from `+layout.server.ts`.
 */
export const authStatus = {
  subscribe: (callback: (value: AuthStatus) => void) =>
    authStore.subscribe((state) => callback(state.status)),
};
