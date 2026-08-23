// OAuth authorization-code callback transports. Desktop keeps RFC 8252
// loopback; iOS/Android use the canonical private-use callback registered by
// tauri-plugin-deep-link; plain web uses a same-origin popup.

import { getToken, onTokenChange } from "../api/http";
import type { SocialProvider } from "../api/types";
import { isTauri } from "../platform";
import {
  MOBILE_REDIRECT_URI,
  assertSessionBinding,
  buildSessionBinding,
  canResumeMobileOAuth,
  generatePkcePair,
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
  transport: OAuthCallbackTransport;
}

interface LoopbackStart {
  port: number;
  redirectPath: string;
}

interface LoopbackResult {
  code: string;
  state: string;
}

interface MobilePendingSummary {
  provider: SocialProvider;
  associate: boolean;
  phase: "armed" | "received";
  state: string;
}

type NativeOAuthCapture = Omit<OAuthCapture, "sessionBinding" | "transport">;

type MobileClaimResult =
  | { status: "ignored" }
  | { status: "captured"; capture: NativeOAuthCapture }
  | { status: "rejected" | "cancelled"; message: string };

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

const POPUP_POLL_MS = 350;
const OAUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const POPUP_FEATURES = "width=480,height=680,noopener=no,noreferrer=no";

const SESSION_CHANGED = "Your account session changed while the provider was open. Start again.";

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

let transportKind: Promise<"desktop" | "mobile"> | null = null;
async function nativeTransport(): Promise<"desktop" | "mobile"> {
  transportKind ??= invoke<"desktop" | "mobile">("oauth_callback_transport").catch(
    (error) => {
      transportKind = null;
      throw error;
    },
  );
  return transportKind;
}

export type OAuthCallbackTransport = "web" | "desktop" | "mobile";

/**
 * Resolve the callback transport from the native command rather than from a
 * user agent or the presence of Tauri alone. Provider discovery uses the same
 * decision as the actual OAuth flow, so desktop never consumes mobile rollout
 * readiness and mobile never falls back to desktop credential truth.
 */
export async function oauthCallbackTransport(): Promise<OAuthCallbackTransport> {
  return isTauri() ? nativeTransport() : "web";
}

/**
 * True only for a Tauri iOS/Android shell, never plain web or desktop.
 * Derived from `oauthCallbackTransport` so the checkout return bridge and the
 * OAuth flow can never disagree about what "mobile" means.
 */
export async function isMobileTauri(): Promise<boolean> {
  return (await oauthCallbackTransport()) === "mobile";
}

async function runDesktopLoopback(
  provider: SocialProvider,
  associate: boolean,
  sessionBinding: string,
  signal: AbortSignal,
  buildStart: (redirectUri: string) => Promise<OAuthStartResponse>,
): Promise<OAuthCapture> {
  try {
    const loopback = await abortable(
      invoke<LoopbackStart>("oauth_loopback_start"),
      signal,
    );
    const redirectUri = `http://127.0.0.1:${loopback.port}/${loopback.redirectPath}`;
    const start = await abortable(buildStart(redirectUri), signal);
    const authorizeUrl = validateAuthorizationStart(provider, start, redirectUri, false);
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await abortable(openUrl(authorizeUrl), signal);
    const result = await abortable(
      invoke<LoopbackResult>("oauth_loopback_wait", { expectedState: start.state }),
      signal,
    );
    return {
      provider,
      associate,
      code: result.code,
      state: result.state,
      redirectUri,
      sessionBinding,
      transport: "desktop",
    };
  } catch (error) {
    await invoke<void>("oauth_loopback_cancel").catch(() => undefined);
    throw error;
  }
}

function settleMobileResult(
  result: MobileClaimResult,
  resolve: (capture: NativeOAuthCapture) => void,
  reject: (error: Error) => void,
): boolean {
  if (result.status === "captured") {
    resolve(result.capture);
    return true;
  }
  if (result.status === "rejected" || result.status === "cancelled") {
    reject(new Error(result.message));
    return true;
  }
  return false;
}

async function waitForMobileCallback(
  associate: boolean,
  expectedState: string,
  signal?: AbortSignal,
): Promise<NativeOAuthCapture> {
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  let finished = false;
  let unlisten: (() => void) | undefined;
  let timer: number | undefined;

  const promise = new Promise<NativeOAuthCapture>((resolve, reject) => {
    const finishResolve = (capture: NativeOAuthCapture) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
      signal?.removeEventListener("abort", abort);
      resolve(capture);
    };
    const finishReject = (error: Error) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => finishReject(new Error("Sign-in was cancelled."));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const processUrls = async (urls: string[]) => {
      for (const callbackUrl of urls) {
        if (finished) return;
        try {
          // Re-read the session at delivery time. Using only the binding from
          // start would let a sign-out/account switch while Safari/Chrome is
          // open associate the returning identity with the wrong account.
          const currentBinding = await buildSessionBinding(associate, getToken());
          const result = await invoke<MobileClaimResult>("oauth_mobile_claim", {
            args: { callbackUrl, sessionBinding: currentBinding, expectedState },
          });
          if (settleMobileResult(result, finishResolve, finishReject)) return;
        } catch (error) {
          await invoke<void>("oauth_mobile_cancel", {
            args: { state: expectedState },
          }).catch(() => undefined);
          finishReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    };

    void onOpenUrl((urls) => void processUrls(urls))
      .then((stop) => {
        unlisten = stop;
        return getCurrent();
      })
      .then((urls) => {
        if (urls) void processUrls(urls);
      })
      .catch((error) =>
        finishReject(error instanceof Error ? error : new Error(String(error))),
      );

    timer = window.setTimeout(() => {
      void invoke<void>("oauth_mobile_cancel", { args: { state: expectedState } }).finally(() =>
        finishReject(new Error("Timed out waiting for the OAuth redirect.")),
      );
    }, OAUTH_TIMEOUT_MS);
  });
  return promise;
}

async function runMobileDeepLink(
  provider: SocialProvider,
  associate: boolean,
  sessionBinding: string,
  outerSignal: AbortSignal,
  buildStart: (
    redirectUri: string,
    codeChallenge?: string,
  ) => Promise<OAuthStartResponse>,
): Promise<OAuthCapture> {
  const pkce = await abortable(generatePkcePair(), outerSignal);
  const start = await abortable(
    buildStart(MOBILE_REDIRECT_URI, pkce.challenge),
    outerSignal,
  );
  const authorizeUrl = validateAuthorizationStart(
    provider,
    start,
    MOBILE_REDIRECT_URI,
    true,
    pkce.challenge,
  );
  await abortable(
    invoke<void>("oauth_mobile_arm", {
      args: {
        provider,
        state: start.state,
        associate,
        sessionBinding,
        codeVerifier: pkce.verifier,
      },
    }),
    outerSignal,
  );
  recoveryController?.abort();
  recoveryController = null;
  const controller = new AbortController();
  const abortFromSessionChange = () => controller.abort();
  outerSignal.addEventListener("abort", abortFromSessionChange, { once: true });
  if (outerSignal.aborted) controller.abort();
  const callback = waitForMobileCallback(associate, start.state, controller.signal);
  // Observe listener/setup failures immediately; the original promise is
  // still awaited below so the caller receives the same rejection.
  void callback.catch(() => undefined);
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await abortable(openUrl(authorizeUrl), outerSignal);
    return {
      ...(await callback),
      sessionBinding,
      transport: "mobile",
    };
  } catch (error) {
    controller.abort();
    await invoke<void>("oauth_mobile_cancel", {
      args: { state: start.state },
    }).catch(() => undefined);
    await callback.catch(() => undefined);
    throw error;
  } finally {
    outerSignal.removeEventListener("abort", abortFromSessionChange);
  }
}

function runWebPopup(
  provider: SocialProvider,
  associate: boolean,
  start: OAuthStartResponse,
  redirectUri: string,
  sessionBinding: string,
  signal: AbortSignal,
): Promise<OAuthCapture> {
  const authorizeUrl = validateAuthorizationStart(provider, start, redirectUri, false);
  return new Promise((resolve, reject) => {
    const popup = window.open(authorizeUrl, "zuuli-oauth", POPUP_FEATURES);
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
  const initiatingToken = getToken();
  const sessionBinding = await buildSessionBinding(associate, initiatingToken);
  const controller = new AbortController();
  const stopWatching = onTokenChange((token) => {
    if (token !== initiatingToken) controller.abort();
  });
  try {
    const transport = await abortable(oauthCallbackTransport(), controller.signal);
    if (transport !== "web") {
      return transport === "mobile"
        ? runMobileDeepLink(
            provider,
            associate,
            sessionBinding,
            controller.signal,
            buildStart,
          )
        : runDesktopLoopback(
            provider,
            associate,
            sessionBinding,
            controller.signal,
            buildStart,
          );
    }
    const redirectUri = window.location.origin;
    const start = await abortable(buildStart(redirectUri), controller.signal);
    return runWebPopup(
      provider,
      associate,
      start,
      redirectUri,
      sessionBinding,
      controller.signal,
    );
  } finally {
    stopWatching();
  }
}

let recovery: Promise<OAuthCapture | null> | null = null;
let recoveryController: AbortController | null = null;

/** Recover a received cold-start callback (or claim getCurrent()) once. */
export function recoverMobileOAuth(): Promise<OAuthCapture | null> {
  recovery ??= (async () => {
    if (!isTauri() || (await nativeTransport()) !== "mobile") return null;
    const pending = await invoke<MobilePendingSummary | null>("oauth_mobile_pending");
    if (!pending) return null;
    const token = getToken();
    if (!canResumeMobileOAuth(pending.associate, token)) {
      // Session bootstrap may have signed in, signed out, or invalidated a
      // token while the app was away. Consume the now-impossible flow instead
      // of throwing on every cold start until its TTL expires.
      await invoke<void>("oauth_mobile_cancel", {
        args: { state: pending.state },
      }).catch(() => undefined);
      return null;
    }
    const sessionBinding = await buildSessionBinding(pending.associate, token);
    const result = await invoke<MobileClaimResult>("oauth_mobile_resume", {
      args: { sessionBinding, expectedState: pending.state },
    });
    if (result.status === "ignored" && pending.phase === "armed") {
      // The app may have been reopened manually while the system browser is
      // still active. Keep a warm-start listener alive; getCurrent() inside
      // the waiter also closes the cold-start race.
      const controller = new AbortController();
      recoveryController = controller;
      const stopWatching = onTokenChange((current) => {
        if (current !== token) controller.abort();
      });
      try {
        const capture = await waitForMobileCallback(
          pending.associate,
          pending.state,
          controller.signal,
        );
        return { ...capture, sessionBinding, transport: "mobile" };
      } catch (error) {
        if (controller.signal.aborted) return null;
        throw error;
      } finally {
        stopWatching();
        if (recoveryController === controller) recoveryController = null;
      }
    }
    if (result.status === "captured") {
      return { ...result.capture, sessionBinding, transport: "mobile" };
    }
    if (result.status === "rejected" || result.status === "cancelled") {
      throw new Error(result.message);
    }
    return null;
  })();
  return recovery;
}

export async function finishMobileOAuth(state: string): Promise<void> {
  if (!isTauri() || (await nativeTransport()) !== "mobile") return;
  await invoke<void>("oauth_mobile_finish", { args: { state } });
}

/** Revalidate every transport's initiating session immediately before backend
 * exchange and return the exact token that passed the binding check. */
export async function assertOAuthSession(
  capture: OAuthCapture,
): Promise<string | null> {
  const token = getToken();
  let verifiedToken: string | null;
  try {
    verifiedToken = await assertSessionBinding(
      capture.sessionBinding,
      capture.associate,
      token,
    );
  } catch (error) {
    if (capture.transport === "mobile") {
      await invoke<void>("oauth_mobile_cancel", {
        args: { state: capture.state },
      }).catch(() => undefined);
    }
    throw error;
  }
  if (capture.transport !== "mobile") return verifiedToken;

  const result = await invoke<MobileClaimResult>("oauth_mobile_resume", {
    args: { sessionBinding: capture.sessionBinding, expectedState: capture.state },
  });
  if (
    result.status !== "captured" ||
    result.capture.state !== capture.state ||
    result.capture.provider !== capture.provider ||
    result.capture.associate !== capture.associate
  ) {
    await invoke<void>("oauth_mobile_cancel", {
      args: { state: capture.state },
    }).catch(() => undefined);
    throw new Error(
      result.status === "rejected" || result.status === "cancelled"
        ? result.message
        : "The mobile sign-in session no longer matches this callback.",
    );
  }
  return verifiedToken;
}

export async function cancelMobileOAuth(state: string): Promise<void> {
  if (!isTauri() || (await nativeTransport()) !== "mobile") return;
  await invoke<void>("oauth_mobile_cancel", { args: { state } });
}
