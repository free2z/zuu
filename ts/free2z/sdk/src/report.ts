import { SdkError } from "./error.js";
import type { ReportReason } from "./types.js";

/** The most a report's `detail` may hold, in Unicode code points. */
export const REPORT_DETAIL_MAX_CHARS = 200;
const REASONS: readonly string[] = [
  "incorrect",
  "inappropriate",
  "unsafe",
  "other",
];
function invalid(field: string): never {
  throw new SdkError("invalid_request", { details: { field } });
}
/**
 * `POST /api/sdk/v1/calls/{id}/report`'s body, checked as the server checks
 * it so a refused value never leaves the device: a known reason, and a
 * `detail` of 1–200 code points on one line: no C0/C1 controls, no U+2028 /
 * U+2029 separators, no bidi controls (U+202A–202E, U+2066–2069). ZWJ and
 * ZWNJ are allowed.
 */
export function reportBody(
  callId: string,
  reason: ReportReason,
  detail?: string,
  childDirected = false,
): { reason: ReportReason; detail?: string } {
  // The gateway's call_id is a UUID; anything else never reaches a URL.
  if (
    typeof callId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      callId,
    )
  )
    invalid("call_id");
  if (typeof reason !== "string" || !REASONS.includes(reason))
    invalid("reason");
  if (detail === undefined) return { reason };
  // A child-directed app sends no detail at all.
  if (childDirected) invalid("detail");
  if (
    typeof detail !== "string" ||
    detail.length === 0 ||
    [...detail].length > REPORT_DETAIL_MAX_CHARS ||
    // The server's rule: C0, DEL and C1; line/paragraph separators; bidi.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(
      detail,
    )
  )
    invalid("detail");
  return { reason, detail };
}
