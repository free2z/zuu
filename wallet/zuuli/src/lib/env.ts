// Runtime configuration for ZUULI.
//
// Development is overridable via Vite env vars (VITE_*) so a local build can
// point at staging or a local backend. Production bundles are deliberately
// pinned to the canonical Free2Z origin: an ambient .env or CI variable must
// never turn a signed store build into a staging client.

function readEnv(key: string, fallback: string): string {
  const v = (import.meta as unknown as { env: Record<string, string> }).env?.[
    key
  ];
  return v && v.length > 0 ? v : fallback;
}

// This exact marker is consumed by the production program, so Rollup retains
// it in the shipping JavaScript. scripts/runtime-target.mjs verifies the
// packaged frontend contains exactly this production provenance record.
export const FREE2Z_PRODUCTION_ARTIFACT_TARGET =
  "zuuli-runtime-target-v1|api=https://free2z.cash|media=https://free2z.cash";

interface Free2zRuntimeEnvironment {
  DEV?: boolean;
  VITE_F2Z_API?: string;
  VITE_F2Z_MEDIA?: string;
}

export interface Free2zRuntimeOrigins {
  api: string;
  media: string;
}

export function parseFree2zArtifactTarget(
  target: string,
): Free2zRuntimeOrigins {
  const [schema, apiField, mediaField, ...extra] =
    target.split("|");
  if (
    schema !== "zuuli-runtime-target-v1" ||
    !apiField?.startsWith("api=") ||
    !mediaField?.startsWith("media=") ||
    extra.length !== 0
  ) {
    throw new Error("ZUULI production runtime target is malformed.");
  }
  return Object.freeze({
    api: apiField.slice("api=".length),
    media: mediaField.slice("media=".length),
  });
}

function productionFree2zOrigins(): Free2zRuntimeOrigins {
  return parseFree2zArtifactTarget(FREE2Z_PRODUCTION_ARTIFACT_TARGET);
}

function developmentFree2zOrigins(
  runtime: Free2zRuntimeEnvironment,
): Free2zRuntimeOrigins {
  const normalize = (value: string | undefined): string =>
    value && value.length > 0 ? value.replace(/\/$/, "") : "";
  return {
    api: normalize(runtime.VITE_F2Z_API),
    media: normalize(runtime.VITE_F2Z_MEDIA),
  };
}

/**
 * Resolve the only two origins that can receive Free2Z API and media traffic.
 *
 * Production ignores overrides rather than merely documenting that CI should
 * omit them. This makes the invariant part of the shipped program: a release
 * built in a shell containing a stale staging override still talks only to
 * production. Development keeps the existing proxy/override behavior.
 */
export function free2zRuntimeOrigins(
  runtime: Free2zRuntimeEnvironment,
): Free2zRuntimeOrigins {
  return runtime.DEV
    ? developmentFree2zOrigins(runtime)
    : productionFree2zOrigins();
}

// In dev / `tauri dev` (import.meta.env.DEV), talk to the API via a same-origin
// relative base so the Vite proxy handles it (no CORS). The proxy target
// defaults to staging (stage.free2z.cash) during development — see
// vite.config.ts / VITE_F2Z_PROXY. In a production build use the absolute host
// below (reached through tauri-plugin-http, which isn't subject to browser
// CORS). Development may override either with VITE_F2Z_API / VITE_F2Z_MEDIA.
const RUNTIME_ENV = (
  import.meta as unknown as { env?: Free2zRuntimeEnvironment }
).env ?? { DEV: false };
// Keep this condition directly compiler-visible. Vite replaces DEV with a
// literal, then removes the unused branch. The artifact verifier consequently
// proves which target survived in a release bundle instead of merely finding
// an unrelated production string elsewhere in the application.
const FREE2Z_ORIGINS = import.meta.env.DEV
  ? developmentFree2zOrigins(RUNTIME_ENV)
  : productionFree2zOrigins();

/** Base URL of the free2z API (no trailing slash; "" means same-origin/proxied). */
export const API_BASE = FREE2Z_ORIGINS.api;

/** Host that serves uploaded media (relative `/uploadz/...` paths hang off this). */
export const MEDIA_BASE = FREE2Z_ORIGINS.media;

/**
 * Mock mode is OFF by default — ZUULI talks to the real free2z API. Set
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

/** Dyte SDK base — used to construct join URLs for livestreams. */
export const DYTE_BASE = readEnv("VITE_DYTE_BASE", "https://app.dyte.io");

/**
 * Extra exact DNS names that may host Stripe Checkout, separated by commas.
 * `checkout.stripe.com` is always allowed. Add only a Stripe Custom Domain
 * configured for this account; schemes, paths, ports and wildcards are invalid.
 */
export const STRIPE_CHECKOUT_CUSTOM_HOSTS = readEnv(
  "VITE_STRIPE_CHECKOUT_HOSTS",
  "",
);

export const APP_NAME = "ZUULI";
export const APP_TAGLINE = "Your Z. Your keys. Your universe.";
export const COMPANY = "2Z Inc";
