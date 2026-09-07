/**
 * Private, local-first error capture for the three surfaces.
 *
 * ## The shape of it
 *
 * ```
 *  window "error"  ─┐
 *  "unhandledrejection" ─┤
 *  ErrorBoundary onError ─┼─► redact.ts ─► DiagnosticsStore ─► diagnostics screen
 *  mountApplication      ─┤    (allow-list)   (bounded ring,      (read / copy /
 *  reportError           ─┘                    localStorage)       share by hand)
 * ```
 *
 * ## What it deliberately is not
 *
 * There is no upload, no endpoint, no queue, no retry, no SDK and no sampling.
 * Not because a content-security policy would block one — it would, and that is
 * a symptom rather than the reason — but because a wallet and an end-to-end
 * encrypted messenger cannot ship a process that sends anything about a user's
 * session anywhere without the user doing it. The buffer is local; the user
 * reads it and decides.
 *
 * ## Where the privacy guarantee actually lives
 *
 * Not in a filter over the export. In two structural places:
 *
 * - `vocabulary.ts` closes every field a caller controls. A breadcrumb takes no
 *   string argument at all, so no call site can attach a handle, an address, an
 *   amount or a message body to one.
 * - `redact.ts` runs at `record()` time on the only three strings that are left
 *   — an error's name, message and stack — and keeps a token only if it matches
 *   a shape known to be safe. The buffer therefore never holds an unredacted
 *   value, so no export path can leak one by forgetting to filter.
 *
 * `record.ts` exports `PASSTHROUGH_SCRUBBER` so a test can prove that the
 * assertion "the secret is absent" would fail without redaction. A redaction
 * test that passes against an unredacted implementation is decoration.
 */

export {
  BREADCRUMB_CATEGORIES,
  BREADCRUMB_CODES,
  DIAGNOSTIC_APPS,
  DIAGNOSTIC_KINDS,
  ENGINE_FAMILIES,
  PLATFORM_FAMILIES,
  isBreadcrumbCategory,
  isBreadcrumbCode,
  isDiagnosticApp,
  isDiagnosticKind,
  isEngineFamily,
  isPlatformFamily,
} from "./vocabulary";
export type {
  BreadcrumbCategory,
  BreadcrumbCode,
  DiagnosticApp,
  DiagnosticKind,
  EngineFamily,
  PlatformFamily,
} from "./vocabulary";

export {
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGE_TOKENS,
  MAX_STACK_FRAMES,
  REDACTION_CLASSES,
  TRUNCATION_MARK,
  WORD_RUN_LIMIT,
  redactionMark,
  scrubIdentifier,
  scrubSource,
  scrubStack,
  scrubText,
} from "./redact";
export type { DiagnosticFrame, RedactionClass } from "./redact";

export {
  UNKNOWN,
  createEnvironment,
  describePlatform,
  reviveEnvironment,
} from "./environment";
export type {
  DiagnosticsEnvironment,
  EnvironmentInput,
} from "./environment";

export {
  PASSTHROUGH_SCRUBBER,
  STRICT_SCRUBBER,
  createBreadcrumb,
  createDiagnosticEvent,
  reviveDiagnosticEvent,
} from "./record";
export type {
  DiagnosticBreadcrumb,
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticScrubber,
} from "./record";

export {
  BREADCRUMBS_PER_EVENT,
  DEFAULT_BREADCRUMB_CAPACITY,
  DEFAULT_EVENT_CAPACITY,
  DIAGNOSTICS_SCHEMA_VERSION,
  DIAGNOSTICS_STORAGE_KEY,
  DiagnosticsStore,
  MAX_PERSISTED_CHARACTERS,
  localStoragePersistence,
} from "./store";
export type {
  DiagnosticsPersistence,
  DiagnosticsStoreOptions,
} from "./store";

export {
  bootstrapReporter,
  boundaryReporter,
  installGlobalDiagnostics,
} from "./capture";
export type { DiagnosticsGlobalTarget } from "./capture";

export { REPORT_TITLE, renderDiagnosticsReport } from "./report";
export type { ReportOptions } from "./report";
