/**
 * The closed vocabularies a diagnostic record is built from.
 *
 * ## Why a vocabulary and not strings
 *
 * A wallet and an end-to-end encrypted messenger cannot ship a buffer that
 * accepts arbitrary caller text. `breadcrumb("opened chat with " + handle)` is
 * one autocomplete away at every call site, and no reviewer catches it twice.
 * So the capture API takes no free-form string at all: a breadcrumb is a
 * `(category, code)` pair drawn from the frozen sets below, and the only way to
 * add one is to edit this file — which is a reviewed change in the shared
 * package rather than a line in a feature.
 *
 * That is the load-bearing half of the privacy design. Everything the store
 * holds is drawn from here except an `Error`'s own `name`, `message` and
 * `stack`, and those three are the only text `redact.ts` has to reason about.
 */

/** The application a record came from. */
export const DIAGNOSTIC_APPS = ["zuuli", "free2z", "e2e2z"] as const;

/** One of {@link DIAGNOSTIC_APPS}. */
export type DiagnosticApp = (typeof DIAGNOSTIC_APPS)[number];

/**
 * How a failure reached the store.
 *
 * These are capture paths, not error classifications: a caller does not get to
 * invent a kind, so the diagnostics screen can group by kind without ever
 * rendering an attacker- or user-supplied label.
 */
export const DIAGNOSTIC_KINDS = [
  /** `window.onerror` — a throw that escaped to the event loop. */
  "uncaught-error",
  /** `unhandledrejection` — the class of failure that caused #973. */
  "unhandled-rejection",
  /** A React render/lifecycle throw caught by a root `ErrorBoundary`. */
  "render-error",
  /** Locale or mount bootstrap failed before the app was on screen. */
  "bootstrap-error",
  /** A failure a feature reported deliberately through `captureError`. */
  "reported-error",
] as const;

/** One of {@link DIAGNOSTIC_KINDS}. */
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/** The coarse area of the app a breadcrumb belongs to. */
export const BREADCRUMB_CATEGORIES = [
  "lifecycle",
  "navigation",
  "bridge",
  "messaging",
  "enrollment",
  "wallet",
] as const;

/** One of {@link BREADCRUMB_CATEGORIES}. */
export type BreadcrumbCategory = (typeof BREADCRUMB_CATEGORIES)[number];

/**
 * Every breadcrumb this codebase may leave.
 *
 * Deliberately coarse. A breadcrumb answers "what was the app doing", never
 * "what was the app doing it to" — there is no code here that could be
 * parameterised by a handle, an address, an amount or a message body, because
 * there is no parameter at all.
 */
export const BREADCRUMB_CODES = [
  // lifecycle
  "app-start",
  "locale-ready",
  "app-mounted",
  "app-visible",
  "app-hidden",
  // navigation
  "route-enter",
  "route-leave",
  // bridge — the cross-surface intent bridge (docs/intent-bridge/PROTOCOL.md)
  "bridge-request-encoded",
  "bridge-response-decoded",
  "bridge-refused",
  // messaging
  "engine-status-requested",
  "engine-status-ready",
  "engine-status-failed",
  "device-info-requested",
  "device-info-ready",
  "device-info-failed",
  "transcript-rendered",
  // enrollment
  "enrollment-status-requested",
  "enrollment-status-ready",
  "enrollment-unavailable",
  "enrollment-started",
  "enrollment-refused",
  // wallet
  "wallet-locked",
  "wallet-unlocked",
  "sync-started",
  "sync-failed",
] as const;

/** One of {@link BREADCRUMB_CODES}. */
export type BreadcrumbCode = (typeof BREADCRUMB_CODES)[number];

/**
 * The device families we distinguish.
 *
 * A `navigator.userAgent` is free text, and a long enough free-text field is a
 * place a secret can hide. So the store never keeps one: `describePlatform`
 * maps it onto this set plus a two-part version number, and anything it cannot
 * place becomes `unknown`.
 */
export const PLATFORM_FAMILIES = [
  "ios",
  "ipados",
  "android",
  "macos",
  "windows",
  "linux",
  "unknown",
] as const;

/** One of {@link PLATFORM_FAMILIES}. */
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];

/** The rendering engine families we distinguish. */
export const ENGINE_FAMILIES = ["webkit", "blink", "gecko", "unknown"] as const;

/** One of {@link ENGINE_FAMILIES}. */
export type EngineFamily = (typeof ENGINE_FAMILIES)[number];

const APP_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_APPS);
const KIND_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_KINDS);
const CATEGORY_SET: ReadonlySet<string> = new Set(BREADCRUMB_CATEGORIES);
const CODE_SET: ReadonlySet<string> = new Set(BREADCRUMB_CODES);
const PLATFORM_SET: ReadonlySet<string> = new Set(PLATFORM_FAMILIES);
const ENGINE_SET: ReadonlySet<string> = new Set(ENGINE_FAMILIES);

/**
 * Membership tests.
 *
 * The types above stop TypeScript callers; these stop everyone else. Records
 * are re-read from persisted JSON on the next launch, and a JS caller can hand
 * a plain string to any of these APIs, so the vocabulary is checked at runtime
 * on the way in and on the way back out of storage rather than trusted.
 */
export function isDiagnosticApp(value: unknown): value is DiagnosticApp {
  return typeof value === "string" && APP_SET.has(value);
}

/** Whether `value` is one of {@link DIAGNOSTIC_KINDS}. */
export function isDiagnosticKind(value: unknown): value is DiagnosticKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Whether `value` is one of {@link BREADCRUMB_CATEGORIES}. */
export function isBreadcrumbCategory(
  value: unknown,
): value is BreadcrumbCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

/** Whether `value` is one of {@link BREADCRUMB_CODES}. */
export function isBreadcrumbCode(value: unknown): value is BreadcrumbCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/** Whether `value` is one of {@link PLATFORM_FAMILIES}. */
export function isPlatformFamily(value: unknown): value is PlatformFamily {
  return typeof value === "string" && PLATFORM_SET.has(value);
}

/** Whether `value` is one of {@link ENGINE_FAMILIES}. */
export function isEngineFamily(value: unknown): value is EngineFamily {
  return typeof value === "string" && ENGINE_SET.has(value);
}
