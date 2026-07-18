// Runtime configuration for ZUULI.
//
// Everything is overridable via Vite env vars (VITE_*) so the same build can
// point at production free2z, a local dev backend, or run fully offline in
// mock mode for demos and screenshots.

function readEnv(key: string, fallback: string): string {
  const v = (import.meta as unknown as { env: Record<string, string> }).env?.[
    key
  ];
  return v && v.length > 0 ? v : fallback;
}

// In dev / `tauri dev` (import.meta.env.DEV), talk to the API via a same-origin
// relative base so the Vite proxy handles it (no CORS). In a production build
// use the absolute host (reached through tauri-plugin-http, which isn't subject
// to browser CORS). Override either with VITE_F2Z_API / VITE_F2Z_MEDIA.
const IS_DEV = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
);
const DEFAULT_API = IS_DEV ? "" : "https://free2z.cash";

/** Base URL of the free2z API (no trailing slash; "" means same-origin/proxied). */
export const API_BASE = readEnv("VITE_F2Z_API", DEFAULT_API).replace(/\/$/, "");

/** Host that serves uploaded media (relative `/uploadz/...` paths hang off this). */
export const MEDIA_BASE = readEnv("VITE_F2Z_MEDIA", DEFAULT_API).replace(/\/$/, "");

/**
 * Mock mode is OFF by default — ZUULI talks to the real free2z API. Set
 * VITE_MOCK=1 only to explore the UI offline with fixtures (e.g. screenshots
 * in a plain browser where CORS would otherwise block the real API).
 */
export const FORCE_MOCK = readEnv("VITE_MOCK", "") === "1";

/** Dyte SDK base — used to construct join URLs for livestreams. */
export const DYTE_BASE = readEnv("VITE_DYTE_BASE", "https://app.dyte.io");

export const APP_NAME = "ZUULI";
export const APP_TAGLINE = "Your Z. Your keys. Your universe.";
export const COMPANY = "2Z Inc";
