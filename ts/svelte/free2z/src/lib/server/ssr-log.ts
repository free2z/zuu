import { isHttpError, isRedirect } from "@sveltejs/kit";

/**
 * SSR logging that keeps ERROR for errors.
 *
 * How Cloud Logging grades this container (verified with `gcloud logging
 * read` on the prod `sveltekit` pods, 2026-09-26): a PLAIN-TEXT line on
 * stderr is `severity: ERROR`, a plain-text line on stdout is `INFO`, and a
 * line that is one JSON object is parsed into `jsonPayload` on either stream
 * with its `severity` key promoted. So `console.warn` is ERROR too (Node
 * writes it to stderr), and a multi-line `console.error(label, obj)` becomes
 * one ERROR entry PER LINE — `status: 404`, `}`, `null`, each its own error.
 *
 * Before this, ~99.5% of the container's ERROR entries were scanner 404s
 * (`/wp-admin`, `/.env`, `/api/zpage/.env/`) and they were Error Reporting's
 * top group at ~1,200/day, so a real SSR regression landed underneath them.
 *
 * The rules:
 * - An outcome that is the visitor's problem — a redirect, a SvelteKit
 *   `error()` below 500, an API 4xx that becomes one — logs NOTHING here.
 *   The request log (nginx sidecar, the load balancer) already records the
 *   status; an ERROR entry adds nothing but noise.
 * - Everything else is ONE line of JSON at `severity: "ERROR"`, whose
 *   `message` is the stack when there is one. Error Reporting detects a
 *   stack trace in `jsonPayload.message`, so real failures still group —
 *   and now as a single entry instead of a dozen.
 */

type Field = string | number | boolean | null | undefined;
export type LogFields = Record<string, Field>;

// Scanner paths are attacker-chosen and can be long. JSON.stringify escapes
// them; this only bounds the size of the line.
const MAX_FIELD_LENGTH = 300;

function bounded(value: Field): Field {
  return typeof value === "string" && value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}…`
    : value;
}

/**
 * The HTTP status an error carries, if any: a SvelteKit `HttpError`, the
 * generated client's `ApiError`, a route's own `ApiFetchError`.
 */
export function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
}

/**
 * True for control flow a loader rethrows as-is and must not log: a
 * `redirect()`, or a SvelteKit `error()` whose status is below 500.
 */
export function isExpectedOutcome(err: unknown): boolean {
  if (isRedirect(err)) return true;
  return isHttpError(err) && err.status < 500;
}

function describe(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      // `stack` begins with `${name}: ${message}`, so it is the whole story.
      message: err.stack || `${err.name}: ${err.message}`,
    };
  }
  if (isHttpError(err)) {
    return {
      name: "HttpError",
      message: `HttpError ${err.status}: ${err.body?.message ?? ""}`,
    };
  }
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

function emit(severity: "ERROR" | "WARNING", line: Record<string, unknown>) {
  const text = JSON.stringify({ severity, ...line });
  // stderr for ERROR, so even an agent that failed to parse the JSON would
  // still grade it ERROR; stdout for anything milder (the og_* convention).
  if (severity === "ERROR") console.error(text);
  else console.log(text);
}

/**
 * One ERROR line for a genuine SSR failure. `event` is a stable,
 * low-cardinality name (`article_load_failed`) to filter on.
 */
export function logSsrError(
  event: string,
  err: unknown,
  fields: LogFields = {},
): void {
  const { name, message } = describe(err);
  const extra: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    extra[key] = bounded(value);
  }
  emit("ERROR", {
    message,
    event,
    ...(name ? { error_name: name } : {}),
    status: errorStatus(err),
    // `ApiFetchError("Request failed for …", { cause })` hides the real
    // reason (a TimeoutError, a refused socket) in `cause`, which `stack`
    // does not print.
    ...(err instanceof Error && err.cause !== undefined
      ? { cause: bounded(describe(err.cause).message.split("\n")[0]) }
      : {}),
    ...extra,
  });
}

/** One WARNING line for something worth seeing that is not an error. */
export function logSsrWarning(
  event: string,
  message: string,
  fields: LogFields = {},
): void {
  const extra: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    extra[key] = bounded(value);
  }
  emit("WARNING", { message, event, ...extra });
}
