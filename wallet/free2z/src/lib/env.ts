// Runtime configuration for the free2z content surface.
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
// relative base so the Vite proxy handles it (no CORS). The proxy target
// defaults to staging (stage.free2z.cash) during development — see
// vite.config.ts / VITE_F2Z_PROXY. In a production build use the absolute host
// below (reached through tauri-plugin-http, which isn't subject to browser
// CORS). Override either with VITE_F2Z_API / VITE_F2Z_MEDIA.
const IS_DEV = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
);
const DEFAULT_API = IS_DEV ? "" : "https://free2z.cash";

/** Base URL of the free2z API (no trailing slash; "" means same-origin/proxied). */
export const API_BASE = readEnv("VITE_F2Z_API", DEFAULT_API).replace(/\/$/, "");

/** Host that serves uploaded media (relative `/uploadz/...` paths hang off this). */
export const MEDIA_BASE = readEnv("VITE_F2Z_MEDIA", DEFAULT_API).replace(/\/$/, "");

/**
 * Mock mode is OFF by default — this surface talks to the real free2z API. Set
 * VITE_MOCK=1 only to explore the UI offline with fixtures (e.g. screenshots
 * in a plain browser where CORS would otherwise block the real API).
 */
export const FORCE_MOCK = readEnv("VITE_MOCK", "") === "1";

/**
 * Mock-only: force the username/password path to require a 2FA (OTP) code so
 * the code-entry step can be exercised offline (VITE_MOCK_OTP=1). Even without
 * this flag, any mock username containing "otp" triggers the 2FA step. The mock
 * accepts the code `123456`.
 */
export const MOCK_OTP = readEnv("VITE_MOCK_OTP", "") === "1";

/**
 * Extra exact DNS names that may host Stripe Checkout, separated by commas.
 * `checkout.stripe.com` is always allowed. Add only a Stripe Custom Domain
 * configured for this account; schemes, paths, ports and wildcards are invalid.
 */
export const STRIPE_CHECKOUT_CUSTOM_HOSTS = readEnv(
  "VITE_STRIPE_CHECKOUT_HOSTS",
  "",
);

export const COMPANY = "2Z Inc";
