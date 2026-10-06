import { FORCE_MOCK } from "./env";

/** True when running inside the Tauri desktop shell (real Rust backend). */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // Tauri v2 injects this global.
    (("__TAURI_INTERNALS__" in window) || "__TAURI__" in window)
  );
}

/** The two navigator fields {@link isMobileRuntime} reads. */
export interface RuntimeNavigator {
  readonly userAgent?: string;
  readonly maxTouchPoints?: number;
}

/**
 * True on iOS, iPadOS and Android.
 *
 * `tauri.conf.json` declares the App Link association under
 * `plugins.deep-link.mobile` only, so the verified links that carry an intent
 * to ZUULI and bring its answer back exist on those platforms and nowhere
 * else. A desktop build that dispatched anyway would open a browser tab and
 * wait out the request's whole lifetime for an answer with no way back.
 *
 * This reads the user agent, which is an availability hint and nothing more:
 * a wrong answer here changes which transport is tried, and every authority
 * check stays where it is (ZUULI's gate and native confirmation,
 * `IntentSession.accept`). iPadOS reports a desktop Safari user agent by
 * default, so a touch-capable "Macintosh" counts as mobile. A Mac has no touch
 * points. Same rule as e2e2z's `isMobileRuntime`.
 */
export function isMobileRuntime(
  runtime: RuntimeNavigator | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): boolean {
  const userAgent = runtime?.userAgent ?? "";
  if (/\b(Android|iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /\bMacintosh\b/.test(userAgent) && (runtime?.maxTouchPoints ?? 0) > 1;
}

/**
 * Whether the data layer should serve mock fixtures. ZUULI is real-first: this
 * is only true when explicitly forced with VITE_MOCK=1. In the Tauri desktop
 * build, API calls are routed through the native HTTP client (see api/http.ts)
 * so they are never blocked by browser CORS.
 */
export function useMock(): boolean {
  return FORCE_MOCK;
}
