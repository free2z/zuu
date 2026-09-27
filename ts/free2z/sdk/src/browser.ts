import { SdkError, cancelled, failure } from "./error.js";
import { secureUrl } from "./http.js";

/** Browser authentication seam. A test or host can provide its own popup integration. */
export interface AuthorizationAttempt {
  authorize(
    url: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<string>;
  close(): void;
}
export interface BrowserAuthSession {
  /** Called synchronously on signIn, before discovery, to preserve the user gesture. */
  open(): AuthorizationAttempt;
}
export class PopupAuthSession implements BrowserAuthSession {
  constructor(private readonly timeoutMs = 120_000) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 3_600_000
    )
      failure("invalid_config");
  }
  open(): AuthorizationAttempt {
    if (typeof window === "undefined") failure("browser_unavailable");
    const popup = window.open(
      "about:blank",
      `f2z-${crypto.randomUUID()}`,
      "popup,width=520,height=720",
    );
    if (!popup) failure("popup_blocked");
    const timeoutMs = this.timeoutMs;
    return {
      close: () => popup.close(),
      authorize(url, redirectUri, signal) {
        cancelled(signal);
        const redirect = new URL(redirectUri);
        return new Promise<string>((resolve, reject) => {
          const finish = (error?: SdkError, callback?: string) => {
            clearInterval(closed);
            clearTimeout(timeout);
            window.removeEventListener("message", message);
            signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(callback!);
          };
          const message = (event: MessageEvent<unknown>) => {
            if (event.source !== popup || event.origin !== redirect.origin)
              return;
            const data = event.data as { type?: unknown; url?: unknown } | null;
            if (
              data &&
              data.type === "f2z_oauth_callback" &&
              typeof data.url === "string"
            )
              finish(undefined, data.url);
          };
          const abort = () => finish(new SdkError("cancelled"));
          const closed = setInterval(() => {
            if (popup.closed) finish(new SdkError("cancelled"));
          }, 250);
          const timeout = setTimeout(
            () => finish(new SdkError("auth_timeout")),
            timeoutMs,
          );
          window.addEventListener("message", message);
          signal?.addEventListener("abort", abort, { once: true });
          try {
            popup.location.href = url;
          } catch {
            finish(new SdkError("browser_unavailable"));
          }
        });
      },
    };
  }
}
/** Run only on the registered web callback page. No token is stored or passed. */
export function completeBrowserSignIn(
  openerOrigin = window.location.origin,
): void {
  const target = secureUrl(openerOrigin, true);
  if (target.origin !== openerOrigin || !window.opener)
    failure("invalid_callback");
  const url = window.location.href;
  window.history.replaceState(null, "", window.location.pathname);
  window.opener.postMessage({ type: "f2z_oauth_callback", url }, target.origin);
  window.close();
}
