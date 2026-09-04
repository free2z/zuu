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
