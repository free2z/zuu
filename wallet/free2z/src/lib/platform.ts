import { FORCE_MOCK } from "./env";

/** True when running inside the Tauri desktop shell (real Rust backend). */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // Tauri v2 injects this global.
    (("__TAURI_INTERNALS__" in window) || "__TAURI__" in window)
  );
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
