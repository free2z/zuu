import {
  type DiagnosticApp,
  type EngineFamily,
  type PlatformFamily,
  isDiagnosticApp,
  isEngineFamily,
  isPlatformFamily,
} from "./vocabulary";

/**
 * What a report says about the device, and nothing more.
 *
 * A `navigator.userAgent` is a long free-text field, and the reason not to keep
 * one is not only that it fingerprints: a free-text field is somewhere a value
 * can hide. So the string is read once, mapped onto the closed families in
 * `vocabulary.ts` plus a two-part version, and then discarded. What is left
 * answers "which OS, which engine, which build" — the questions a bug report
 * actually needs — and cannot answer anything else.
 */
export interface DiagnosticsEnvironment {
  /** Which of the three surfaces produced the record. */
  readonly app: DiagnosticApp;
  /** The app's marketing version, e.g. `0.1.0`. */
  readonly version: string;
  /** The store build number, e.g. `2`. */
  readonly build: string;
  /** The OS family, or `unknown`. */
  readonly platform: PlatformFamily;
  /** `major.minor` at most, or `unknown`. */
  readonly platformVersion: string;
  /** The rendering engine family, or `unknown`. */
  readonly engine: EngineFamily;
}

const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][A-Za-z0-9.]{1,24})?$/u;
const BUILD = /^\d{1,9}$/u;

/** `unknown` is the value every field falls back to; it is never a guess. */
export const UNKNOWN = "unknown" as const;

function safeVersion(value: string): string {
  return VERSION.test(value) ? value : UNKNOWN;
}

function safeBuild(value: string): string {
  return BUILD.test(value) ? value : UNKNOWN;
}

function twoPart(major: string | undefined, minor: string | undefined): string {
  if (!major) return UNKNOWN;
  const head = Number.parseInt(major, 10);
  if (!Number.isFinite(head)) return UNKNOWN;
  const tail = minor === undefined ? undefined : Number.parseInt(minor, 10);
  return tail === undefined || !Number.isFinite(tail)
    ? String(head)
    : `${head}.${tail}`;
}

interface DeviceDescription {
  readonly platform: PlatformFamily;
  readonly platformVersion: string;
  readonly engine: EngineFamily;
}

/**
 * Map a user agent onto the closed device vocabulary.
 *
 * Order matters twice. Chromium's user agent contains `AppleWebKit`, so the
 * engine test looks for Chrome first. iPadOS reports itself as a Macintosh, and
 * we do not try to undo that — a wrong `ipados` guess is worse than an honest
 * `macos`, because a reader would trust it.
 */
export function describePlatform(userAgent: string): DeviceDescription {
  const agent = typeof userAgent === "string" ? userAgent : "";

  let platform: PlatformFamily = UNKNOWN;
  let platformVersion: string = UNKNOWN;

  const android = /Android (\d{1,3})(?:\.(\d{1,3}))?/u.exec(agent);
  const appleOs = /OS (\d{1,3})[._](\d{1,3})/u.exec(agent);
  const macOs = /Mac OS X (\d{1,3})[._](\d{1,3})/u.exec(agent);
  const windows = /Windows NT (\d{1,3})(?:\.(\d{1,3}))?/u.exec(agent);

  if (android) {
    platform = "android";
    platformVersion = twoPart(android[1], android[2]);
  } else if (/iPad/u.test(agent)) {
    platform = "ipados";
    platformVersion = twoPart(appleOs?.[1], appleOs?.[2]);
  } else if (/iPhone|iPod/u.test(agent)) {
    platform = "ios";
    platformVersion = twoPart(appleOs?.[1], appleOs?.[2]);
  } else if (/Macintosh|Mac OS X/u.test(agent)) {
    platform = "macos";
    platformVersion = twoPart(macOs?.[1], macOs?.[2]);
  } else if (windows) {
    platform = "windows";
    platformVersion = twoPart(windows[1], windows[2]);
  } else if (/Linux|X11|CrOS/u.test(agent)) {
    platform = "linux";
  }

  let engine: EngineFamily = UNKNOWN;
  if (/Chrome\/|Chromium\/|Edg\//u.test(agent)) engine = "blink";
  else if (/AppleWebKit/u.test(agent)) engine = "webkit";
  else if (/Gecko\/|Firefox\//u.test(agent)) engine = "gecko";

  return { platform, platformVersion, engine };
}

/** What an app tells the diagnostics store about itself. */
export interface EnvironmentInput {
  /** Which surface this is. Anything else is refused, not coerced. */
  readonly app: DiagnosticApp;
  /** Usually `release.json`'s `version`. */
  readonly version: string;
  /** Usually `release.json`'s `build`. */
  readonly build: string;
  /** Usually `navigator.userAgent`; only its families are kept. */
  readonly userAgent: string;
}

/**
 * Build the environment block, refusing anything that is not the shape it
 * claims. An app that passes a version string from somewhere unexpected gets
 * `unknown` rather than having that string appear in every exported report.
 */
export function createEnvironment(
  input: EnvironmentInput,
): DiagnosticsEnvironment {
  const device = describePlatform(input.userAgent);
  return Object.freeze({
    app: input.app,
    version: safeVersion(input.version),
    build: safeBuild(input.build),
    platform: device.platform,
    platformVersion: device.platformVersion,
    engine: device.engine,
  });
}

/** Re-validate an environment block read back from storage. */
export function reviveEnvironment(value: unknown): DiagnosticsEnvironment | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isDiagnosticApp(candidate.app)) return null;
  if (!isPlatformFamily(candidate.platform)) return null;
  if (!isEngineFamily(candidate.engine)) return null;
  const version =
    typeof candidate.version === "string" ? candidate.version : UNKNOWN;
  const build = typeof candidate.build === "string" ? candidate.build : UNKNOWN;
  const platformVersion =
    typeof candidate.platformVersion === "string"
      ? candidate.platformVersion
      : UNKNOWN;
  return Object.freeze({
    app: candidate.app,
    version: safeVersion(version),
    build: safeBuild(build),
    platform: candidate.platform,
    platformVersion: VERSION.test(platformVersion) ? platformVersion : UNKNOWN,
    engine: candidate.engine,
  });
}
