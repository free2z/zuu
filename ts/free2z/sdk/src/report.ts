import { SdkError } from "./error.js";
import { identifier } from "./http.js";
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
 * `detail` of 1–200 code points with no control characters (one line).
 */
export function reportBody(
  callId: string,
  reason: ReportReason,
  detail?: string,
): { reason: ReportReason; detail?: string } {
  try {
    identifier(callId);
  } catch {
    invalid("call_id");
  }
  if (typeof reason !== "string" || !REASONS.includes(reason))
    invalid("reason");
  if (detail === undefined) return { reason };
  if (
    typeof detail !== "string" ||
    detail.length === 0 ||
    [...detail].length > REPORT_DETAIL_MAX_CHARS ||
    // C0, DEL and C1: the server's "one line, no control characters".
    /[\u0000-\u001f\u007f-\u009f]/.test(detail)
  )
    invalid("detail");
  return { reason, detail };
}
