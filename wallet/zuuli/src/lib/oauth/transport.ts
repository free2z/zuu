// Desktop/web transport for the OAuth authorization-code round trip that
// backs social login (X / Google / GitHub). This module owns ONLY how the
// `{code, state}` pair gets captured after the user approves in the system
// browser (or a popup) — it knows nothing about free2z, tokens, or accounts.
// See `auth.socialProviders` / `auth.socialLogin` in `../api/free2z.ts` for
// the orchestration that calls this.
//
// One flow, two transports, chosen by `isTauri()`:
//
//   - Desktop (Tauri): the RFC 8252 "loopback redirect" pattern. A Rust
//     command (`wallet/zuuli/src-tauri/src/oauth.rs`) binds an ephemeral
//     `127.0.0.1` listener and hands back its port + a random one-time path
//     nonce; we build `redirect_uri = http://127.0.0.1:<port>/<nonce>`, open
//     the system browser at `authorize_url` via `@tauri-apps/plugin-opener`,
//     then await the Rust command that blocks until the provider's single
//     redirect lands, parses `code`/`state`, and serves a static "you can
//     close this tab" page.
//   - Web (plain browser / `npm run dev`): a popup window, with
//     `redirect_uri = window.location.origin`. We poll the popup's location
//     (readable once it navigates back same-origin) for the `code`/`state`
//     query params the backend's redirect carries.
//
// Neither transport is ever exercised with real credentials today — the
// backend reports every provider as unconfigured (`socialProviders()` returns
// all-false), so nothing calls into this module in practice yet.

import { isTauri } from "../platform";

export interface OAuthCapture {
  code: string;
  state: string;
  redirectUri: string;
}

interface LoopbackStart {
  port: number;
  redirectPath: string;
}
interface LoopbackResult {
  code: string;
  state: string;
}

async function invokeLoopback<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

/** Milliseconds between polls of the web popup's location. */
const POPUP_POLL_MS = 350;
/** Popup window features (roughly matches other providers' OAuth popups). */
const POPUP_FEATURES = "width=480,height=680,noopener=no,noreferrer=no";

async function runDesktopLoopback(
  buildAuthorizeUrl: (redirectUri: string) => Promise<string>,
): Promise<OAuthCapture> {
  const start = await invokeLoopback<LoopbackStart>("oauth_loopback_start");
  const redirectUri = `http://127.0.0.1:${start.port}/${start.redirectPath}`;

  const authorizeUrl = await buildAuthorizeUrl(redirectUri);

  // The system browser, not an in-app webview — the whole point of the
  // loopback pattern is that the user authenticates in their normal browser
  // (existing sessions, password manager, 2FA), never inside the app.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(authorizeUrl);

  const result = await invokeLoopback<LoopbackResult>("oauth_loopback_wait");
  return { code: result.code, state: result.state, redirectUri };
}

function runWebPopup(
  authorizeUrl: string,
  redirectUri: string,
): Promise<OAuthCapture> {
  return new Promise((resolve, reject) => {
    const popup = window.open(authorizeUrl, "zuuli-oauth", POPUP_FEATURES);
    if (!popup) {
      reject(
        new Error(
          "The sign-in popup was blocked. Allow popups for this site and try again.",
        ),
      );
      return;
    }

    const stop = () => window.clearInterval(timer);

    const timer = window.setInterval(() => {
      if (popup.closed) {
        stop();
        reject(new Error("Sign-in was cancelled."));
        return;
      }
      // Reading `.location.href` throws while the popup is still on the
      // provider's cross-origin page — that's expected, just keep polling
      // until it navigates back to our own origin (the redirect_uri).
      let href: string;
      try {
        href = popup.location.href;
      } catch {
        return;
      }
      if (!href || !href.startsWith(redirectUri)) return;

      stop();
      const url = new URL(href);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      popup.close();
      if (code && state) {
        resolve({ code, state, redirectUri });
      } else {
        reject(
          new Error("The provider redirect was missing `code` or `state`."),
        );
      }
    }, POPUP_POLL_MS);
  });
}

/**
 * Run the OAuth authorization-code round trip end to end and resolve with
 * the captured `{code, state, redirectUri}`. `buildAuthorizeUrl` is called
 * with the transport's `redirect_uri` and must return the provider's
 * `authorize_url` (i.e. it should call `auth.socialStart`).
 */
export async function captureOAuthCode(
  buildAuthorizeUrl: (redirectUri: string) => Promise<string>,
): Promise<OAuthCapture> {
  if (isTauri()) return runDesktopLoopback(buildAuthorizeUrl);

  const redirectUri = window.location.origin;
  const authorizeUrl = await buildAuthorizeUrl(redirectUri);
  return runWebPopup(authorizeUrl, redirectUri);
}
