// OAuth authorization-code callback transport for the content surface.
//
// There is exactly one: a same-origin web popup. ZUULI's two native transports
// — the RFC 8252 loopback listener and the private-use deep-link relay — are
// deliberately absent here, and so are the ten `oauth_*` commands they call.
//
// WHY THEY ARE ABSENT (#918). Porting them was the alternative, and it is not a
// small privilege question dressed up as a big one. `oauth_loopback_wait`,
// `oauth_mobile_claim` and `oauth_mobile_resume` each RETURN an authorization
// code — and, on mobile, the PKCE verifier minted for it — to whatever called
// them. That pair is a sign-in credential: anything holding it can complete the
// exchange and take the account. Registering them here would put that credential
// behind an `invoke()` in the one process of the three-app split that renders
// third-party markup, remote media and a livestream SDK, and #367 is the defect
// that makes "whatever called them" undecidable: Wry injects Tauri's bridge into
// every frame and its Android IPC reports the top-level URL as the origin, so a
// remote subframe resolves as the trusted main window. A capability file cannot
// separate the two callers, because there is only one window label. The only
// durable answer is that the command does not exist, so the code was deleted
// rather than gated — `wallet/zuuli/scripts/surface-capability-authority.mjs`
// now fails this tree if `@tauri-apps/api/core` is imported at all.
//
// The consequence is honest and closed: in a packaged build this app offers no
// social sign-in, rather than offering a button that cannot finish. Password and
// already-linked accounts are unaffected. Bringing it back is a bridge grant
// issued by the wallet authority (#905), not an invoke handler here.

import {
  getTokenSnapshot,
  onTokenChange,
  type TokenSnapshot,
} from "../api/http";
import type { SocialProvider } from "../api/types";
import { isTauri } from "../platform";
import {
  assertSessionBinding,
  buildSessionBinding,
  validateAuthorizationStart,
  type OAuthStartResponse,
} from "./protocol";

export interface OAuthCapture {
  provider: SocialProvider;
  associate: boolean;
  code: string;
  state: string;
  redirectUri: string;
  codeVerifier?: string;
  /** One-way binding to the exact session present before provider navigation. */
  sessionBinding: string;
  /** Detects token changes even when a later token has the same value. */
  sessionGeneration: number;
  transport: OAuthCallbackTransport;
}

const POPUP_POLL_MS = 350;
const OAUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const POPUP_FEATURES = "width=480,height=680,noopener=no,noreferrer=no";

const SESSION_CHANGED = "Your account session changed while the provider was open. Start again.";

/** Said when a caller reaches a transport this surface does not have. */
export const SOCIAL_SIGN_IN_UNAVAILABLE =
  "Social sign-in is not available in the free2z app yet. Sign in with your free2z username and password, or continue at free2z.cash in a browser.";

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(SESSION_CHANGED));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(SESSION_CHANGED));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

interface OAuthSessionLease {
  initiatingToken: string | null;
  generation: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  stop: () => void;
}

export interface OAuthCompletionLease {
  initiatingToken: string | null;
  sessionGeneration: number;
  signal: AbortSignal;
  assertCurrent: () => void;
}

function sessionChanged(): Error {
  return new Error(SESSION_CHANGED);
}

function tokenSnapshotIsCurrent(snapshot: TokenSnapshot): boolean {
  const current = getTokenSnapshot();
  return current.generation === snapshot.generation && current.token === snapshot.token;
}

function watchTokenSnapshot(snapshot: TokenSnapshot): OAuthSessionLease {
  const controller = new AbortController();
  const stop = onTokenChange(() => controller.abort());
  const assertCurrent = () => {
    if (controller.signal.aborted || !tokenSnapshotIsCurrent(snapshot)) {
      controller.abort();
      throw sessionChanged();
    }
  };
  // Close the snapshot -> listener-registration edge before the first await.
  try {
    assertCurrent();
  } catch (error) {
    stop();
    throw error;
  }
  return {
    initiatingToken: snapshot.token,
    generation: snapshot.generation,
    signal: controller.signal,
    assertCurrent,
    stop,
  };
}

/** Last synchronous fence used by UI callers immediately before publishing an
 * OAuth result into global session/user state. */
export function assertOAuthResultCurrent(sessionGeneration: number): void {
  if (getTokenSnapshot().generation !== sessionGeneration) throw sessionChanged();
}

export type OAuthCallbackTransport = "web" | "unavailable";

/**
 * Resolve the callback transport for this surface.
 *
 * Deliberately NOT derived from a native command: this app registers none. A
 * plain browser gets the same-origin popup. A packaged Tauri shell gets
 * `"unavailable"` — its document origin is `tauri://localhost`, which is not a
 * registered redirect URI at any provider and never will be, so there is no
 * transport rather than a broken one. Provider discovery reads this so the
 * login screen never advertises a method it cannot finish.
 */
export async function oauthCallbackTransport(): Promise<OAuthCallbackTransport> {
  return isTauri() ? "unavailable" : "web";
}

function runWebPopup(
  provider: SocialProvider,
  associate: boolean,
  start: OAuthStartResponse,
  redirectUri: string,
  sessionBinding: string,
  sessionGeneration: number,
  signal: AbortSignal,
): Promise<OAuthCapture> {
  const authorizeUrl = validateAuthorizationStart(provider, start, redirectUri, false);
  return new Promise((resolve, reject) => {
    const popup = window.open(authorizeUrl, "free2z-oauth", POPUP_FEATURES);
    if (!popup) {
      reject(new Error("The sign-in popup was blocked. Allow popups and try again."));
      return;
    }
    const expected = new URL(redirectUri);
    let deadline: number | undefined;
    let poll: number | undefined;
    let abort = () => undefined;
    const finish = () => {
      if (deadline !== undefined) window.clearTimeout(deadline);
      if (poll !== undefined) window.clearInterval(poll);
      popup.close();
      signal.removeEventListener("abort", abort);
    };
    deadline = window.setTimeout(() => {
      finish();
      reject(new Error("Timed out waiting for the OAuth redirect."));
    }, OAUTH_TIMEOUT_MS);
    poll = window.setInterval(() => {
      if (popup.closed) {
        finish();
        reject(new Error("Sign-in was cancelled."));
        return;
      }
      let url: URL;
      try {
        url = new URL(popup.location.href);
      } catch {
        return;
      }
      if (
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        url.username ||
        url.password ||
        url.hash
      ) {
        return;
      }
      const states = url.searchParams.getAll("state");
      const codes = url.searchParams.getAll("code");
      const errors = url.searchParams.getAll("error");
      if (states.length !== 1 || states[0] !== start.state) {
        finish();
        reject(new Error("The provider callback did not match this sign-in attempt."));
      } else if (codes.length === 1 && errors.length === 0 && codes[0]) {
        finish();
        resolve({
          provider,
          associate,
          code: codes[0],
          state: states[0],
          redirectUri,
          sessionBinding,
          sessionGeneration,
          transport: "web",
        });
      } else if (errors.length === 1 && codes.length === 0) {
        finish();
        reject(new Error("Sign-in was cancelled."));
      } else {
        finish();
        reject(new Error("The provider callback was malformed."));
      }
    }, POPUP_POLL_MS);
    abort = () => {
      finish();
      reject(new Error(SESSION_CHANGED));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function captureOAuthCode(
  provider: SocialProvider,
  associate: boolean,
  buildStart: (
    redirectUri: string,
    codeChallenge?: string,
  ) => Promise<OAuthStartResponse>,
): Promise<OAuthCapture> {
  const lease = watchTokenSnapshot(getTokenSnapshot());
  try {
    const sessionBinding = await abortable(
      buildSessionBinding(associate, lease.initiatingToken),
      lease.signal,
    );
    lease.assertCurrent();
    const transport = await abortable(oauthCallbackTransport(), lease.signal);
    lease.assertCurrent();
    // Fail closed rather than opening a popup that cannot come back. The login
    // screen already hides the affordance; this is the second, load-bearing
    // refusal for any caller that reaches the API directly.
    if (transport !== "web") throw new Error(SOCIAL_SIGN_IN_UNAVAILABLE);
    const redirectUri = window.location.origin;
    const start = await abortable(buildStart(redirectUri), lease.signal);
    lease.assertCurrent();
    // `return await` is intentional: a bare returned promise executes this
    // function's finally immediately and silently removes the session watch.
    return await runWebPopup(
      provider,
      associate,
      start,
      redirectUri,
      sessionBinding,
      lease.generation,
      lease.signal,
    );
  } finally {
    lease.stop();
  }
}

/**
 * There is no native callback for this surface to recover.
 *
 * ZUULI's version invokes `oauth_mobile_pending` / `_resume` / `_cancel`, which
 * do not exist in this binary — and must not, because `_resume` returns an
 * authorization code and its PKCE verifier to the renderer (#367, #918). Before
 * #918 this rejected on every launch of a packaged build, and `App.tsx` calls it
 * unconditionally on mount behind a `.catch` that toasts "Couldn't finish
 * sign-in", so the first thing a user saw was a sign-in failure they had not
 * asked for.
 *
 * It resolves `null` — "nothing to finish" — rather than being deleted, so the
 * one mount-time call site stays put for the day a native return arrives as a
 * wallet-authority bridge grant (#905).
 */
export function recoverMobileOAuth(): Promise<OAuthCapture | null> {
  return Promise.resolve(null);
}

/** Hold the initiating session across the backend exchange, profile read, and
 * the final post-await generation check. */
export async function withOAuthSession<T>(
  capture: OAuthCapture,
  complete: (lease: OAuthCompletionLease) => Promise<T>,
): Promise<T> {
  const snapshot = getTokenSnapshot();
  if (snapshot.generation !== capture.sessionGeneration) throw sessionChanged();
  const lease = watchTokenSnapshot(snapshot);
  try {
    const verifiedToken = await abortable(
      assertSessionBinding(
        capture.sessionBinding,
        capture.associate,
        lease.initiatingToken,
      ),
      lease.signal,
    );
    lease.assertCurrent();

    const completed = await complete({
      initiatingToken: verifiedToken,
      sessionGeneration: lease.generation,
      signal: lease.signal,
      assertCurrent: lease.assertCurrent,
    });
    lease.assertCurrent();
    return completed;
  } catch (error) {
    if (lease.signal.aborted) throw sessionChanged();
    throw error;
  } finally {
    lease.stop();
  }
}
