// Which data layer the messaging bridge serves.
//
// This is `wallet/zuuli/src/lib/platform.ts` reduced to the two answers e2e2z
// needs. ZUULI's version reads a whole runtime-configuration module because it
// also talks to the free2z HTTP API; this surface talks to nothing but
// `tauri-plugin-f2zmsg`, so the only knob is the mock flag.

function readEnv(key: string): string {
  const environment = (import.meta as unknown as { env?: Record<string, string> })
    .env;
  return environment?.[key] ?? "";
}

/** True when running inside the Tauri desktop shell (real Rust backend). */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // Tauri v2 injects this global.
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Mock mode is OFF by default — e2e2z talks to the real messaging engine. Set
 * `VITE_MOCK=1` only to explore the UI offline with fixtures (screenshots, and
 * the Playwright run, which has no Tauri host to invoke).
 */
export const FORCE_MOCK = readEnv("VITE_MOCK") === "1";

/** Whether the data layer should serve mock fixtures. */
export function useMock(): boolean {
  return FORCE_MOCK;
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
 * wait out the request's whole lifetime for an answer that has no way back.
 *
 * This reads the user agent, which is an availability hint and nothing more:
 * a wrong answer here makes a button appear or disappear, and the authority
 * checks all stay where they are (`transport.ts`, `IntentSession.accept`, the
 * engine's handle comparison). iPadOS reports a desktop Safari user agent by
 * default, so a touch-capable "Macintosh" counts as mobile. A Mac has no
 * touch points.
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
