import {
  type DiagnosticFrame,
  scrubIdentifier,
  scrubStack,
  scrubText,
} from "./redact";
import {
  type BreadcrumbCategory,
  type BreadcrumbCode,
  type DiagnosticKind,
  isBreadcrumbCategory,
  isBreadcrumbCode,
  isDiagnosticKind,
} from "./vocabulary";

/** A step the app took, drawn entirely from the closed vocabulary. */
export interface DiagnosticBreadcrumb {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly category: BreadcrumbCategory;
  readonly code: BreadcrumbCode;
}

/** One captured failure. Every field here has already been through redaction. */
export interface DiagnosticEvent {
  /** Epoch milliseconds. */
  readonly at: number;
  /** Which capture path produced it. */
  readonly kind: DiagnosticKind;
  /** The error's constructor name, scrubbed. */
  readonly name: string;
  /** The error's message, scrubbed. */
  readonly message: string;
  /** Stack frames reduced to function, file name, line and column. */
  readonly frames: readonly DiagnosticFrame[];
  /** What the app was doing, most recent last. */
  readonly breadcrumbs: readonly DiagnosticBreadcrumb[];
}

/**
 * The three redaction functions, as an injectable seam.
 *
 * This exists for one reason: a test that asserts a secret is absent from the
 * store proves nothing unless the same assertion would fail without redaction.
 * Passing {@link PASSTHROUGH_SCRUBBER} to {@link createDiagnosticEvent} gives a
 * test the negative control it needs. Nothing in the shipping path takes a
 * scrubber — {@link DiagnosticsStore} always uses {@link STRICT_SCRUBBER} — so
 * no caller can weaken the store by configuring it.
 */
export interface DiagnosticScrubber {
  readonly text: (value: string) => string;
  readonly identifier: (value: string) => string;
  readonly stack: (value: string) => DiagnosticFrame[];
}

/** The redaction the shipping path always uses. */
export const STRICT_SCRUBBER: DiagnosticScrubber = Object.freeze({
  text: scrubText,
  identifier: scrubIdentifier,
  stack: scrubStack,
});

/**
 * No redaction at all — the negative control, and the only thing in this
 * package that would leak. It is never reachable from a store.
 */
export const PASSTHROUGH_SCRUBBER: DiagnosticScrubber = Object.freeze({
  text: (value: string) => value,
  identifier: (value: string) => value,
  stack: (value: string) =>
    value.split("\n").map((line) => ({
      fn: line,
      source: line,
      line: 0,
      column: 0,
    })),
});

interface ErrorLike {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

function asErrorLike(value: unknown): ErrorLike | null {
  if (value instanceof Error) return value;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string") return null;
  if (typeof candidate.message !== "string") return null;
  return {
    name: candidate.name,
    message: candidate.message,
    stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
  };
}

/**
 * Describe a thrown value that is not an `Error`.
 *
 * Deliberately by type only. `String(value)` on an arbitrary object runs its
 * `toString`, and in this codebase the objects being thrown around are wallet
 * state, engine status and message envelopes — exactly the things a diagnostics
 * buffer must never serialize. A record saying "an object was thrown" is less
 * informative and is the only version that is safe by construction.
 */
function describeNonError(value: unknown): ErrorLike {
  if (typeof value === "string") {
    return { name: "String", message: value };
  }
  if (value === null) return { name: "Null", message: "" };
  if (Array.isArray(value)) return { name: "Array", message: "" };
  const kind = typeof value;
  const name = kind.charAt(0).toUpperCase() + kind.slice(1);
  return { name, message: "" };
}

/** What a caller hands {@link createDiagnosticEvent}. */
export interface DiagnosticEventInput {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly kind: DiagnosticKind;
  /** Whatever was thrown or rejected with. */
  readonly error: unknown;
  readonly breadcrumbs: readonly DiagnosticBreadcrumb[];
}

/**
 * Turn a thrown value into a record.
 *
 * Redaction happens here, at construction, so there is no moment at which an
 * unredacted `DiagnosticEvent` exists to be stored, rendered or copied by
 * mistake. Export paths are pure reads of already-redacted values.
 */
export function createDiagnosticEvent(
  input: DiagnosticEventInput,
  scrub: DiagnosticScrubber = STRICT_SCRUBBER,
): DiagnosticEvent {
  const source = asErrorLike(input.error) ?? describeNonError(input.error);
  return Object.freeze({
    at: Number.isFinite(input.at) ? Math.trunc(input.at) : 0,
    kind: isDiagnosticKind(input.kind) ? input.kind : "reported-error",
    name: scrub.identifier(source.name),
    message: scrub.text(source.message),
    frames: Object.freeze(source.stack ? scrub.stack(source.stack) : []),
    breadcrumbs: Object.freeze([...input.breadcrumbs]),
  });
}

function reviveFrame(value: unknown): DiagnosticFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.fn !== "string") return null;
  if (typeof candidate.source !== "string") return null;
  return {
    fn: scrubIdentifier(candidate.fn),
    source: scrubText(candidate.source),
    line: typeof candidate.line === "number" ? Math.trunc(candidate.line) : 0,
    column:
      typeof candidate.column === "number" ? Math.trunc(candidate.column) : 0,
  };
}

function reviveBreadcrumb(value: unknown): DiagnosticBreadcrumb | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isBreadcrumbCategory(candidate.category)) return null;
  if (!isBreadcrumbCode(candidate.code)) return null;
  return {
    at: typeof candidate.at === "number" ? Math.trunc(candidate.at) : 0,
    category: candidate.category,
    code: candidate.code,
  };
}

/**
 * Re-validate a record read back from storage.
 *
 * Persisted JSON is not the same trust level as a value this process just
 * built: the key is same-origin, but it is still writable by anything running
 * in the page, and the report renders whatever comes back. So the vocabulary is
 * re-checked and the text is scrubbed a second time on the way out. Redaction
 * is idempotent, so this costs a pass and closes the gap.
 */
export function reviveDiagnosticEvent(value: unknown): DiagnosticEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isDiagnosticKind(candidate.kind)) return null;
  const frames = Array.isArray(candidate.frames)
    ? candidate.frames.map(reviveFrame).filter((f): f is DiagnosticFrame => !!f)
    : [];
  const breadcrumbs = Array.isArray(candidate.breadcrumbs)
    ? candidate.breadcrumbs
        .map(reviveBreadcrumb)
        .filter((c): c is DiagnosticBreadcrumb => !!c)
    : [];
  return Object.freeze({
    at: typeof candidate.at === "number" ? Math.trunc(candidate.at) : 0,
    kind: candidate.kind,
    name: scrubIdentifier(
      typeof candidate.name === "string" ? candidate.name : "",
    ),
    message: scrubText(
      typeof candidate.message === "string" ? candidate.message : "",
    ),
    frames: Object.freeze(frames),
    breadcrumbs: Object.freeze(breadcrumbs),
  });
}

/** Build a breadcrumb, refusing anything outside the vocabulary. */
export function createBreadcrumb(
  at: number,
  category: BreadcrumbCategory,
  code: BreadcrumbCode,
): DiagnosticBreadcrumb | null {
  if (!isBreadcrumbCategory(category) || !isBreadcrumbCode(code)) return null;
  return Object.freeze({
    at: Number.isFinite(at) ? Math.trunc(at) : 0,
    category,
    code,
  });
}
