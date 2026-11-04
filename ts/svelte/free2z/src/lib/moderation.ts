/**
 * In-app report and block: the Play UGC / Child Safety Standards
 * controls.
 *
 * The API is `POST /api/reports/` (private staff intake; CSAE pages staff) and
 * `PUT|DELETE /api/creator/{username}/block/`. This module turns their
 * answers into a small result union so every entry point -- comment card,
 * zPage action rail, profile menu -- says the same thing for the same
 * outcome, and so the mapping is testable without a browser.
 */
import { ApiError } from "$lib/api/mutator";
import { reportsCreate } from "$lib/api/reports/reports";
import {
  creatorBlockDestroy,
  creatorBlockRetrieve,
  creatorBlockUpdate,
} from "$lib/api/creator/creator";
import type {
  ContentReportReasonEnum,
  TargetKindEnum,
} from "$lib/api/f2z.schemas";

export type ReportTargetKind = TargetKindEnum;
export type ReportReason = ContentReportReasonEnum;

/** Server limit on `details` (ContentReport.details max_length). */
export const REPORT_DETAILS_MAX = 2000;

/**
 * Display order. CSAE first: it is the one Play's Child Safety Standards
 * require to be findable, and staff triage it first.
 */
export const REPORT_REASONS: readonly ReportReason[] = [
  "csae",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "spam",
  "other",
];

export type ReportOutcome =
  /** Accepted (or a duplicate of one this account already filed). */
  | { ok: true }
  | {
      ok: false;
      /**
       * `auth`: not signed in. `rate`: the per-account limit. `gone`: the
       * target is no longer visible to this account. `invalid`: the server
       * refused a field. `failed`: anything else (network, 5xx).
       */
      reason: "auth" | "rate" | "gone" | "invalid" | "failed";
      message?: string;
    };

function classify(error: unknown): Exclude<ReportOutcome, { ok: true }> {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, reason: "auth" };
    }
    if (error.status === 429) {
      return { ok: false, reason: "rate", message: error.serverMessage };
    }
    if (error.status === 404) return { ok: false, reason: "gone" };
    if (error.status === 400) {
      const first = Object.values(error.fieldErrors ?? {})[0];
      return {
        ok: false,
        reason: "invalid",
        message: first || error.serverMessage,
      };
    }
  }
  return { ok: false, reason: "failed" };
}

export async function submitReport(input: {
  kind: ReportTargetKind;
  /** comment UUID, zPage free2zaddr, or creator username. */
  targetId: string;
  reason: ReportReason;
  details?: string;
}): Promise<ReportOutcome> {
  const details = (input.details ?? "").trim().slice(0, REPORT_DETAILS_MAX);
  try {
    await reportsCreate({
      target_kind: input.kind,
      target_id: input.targetId,
      reason: input.reason,
      ...(details ? { details } : {}),
    });
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

export type BlockOutcome =
  | { ok: true; blocked: boolean }
  | { ok: false; reason: "auth" | "gone" | "invalid" | "failed" };

function blockFailure(error: unknown): Exclude<BlockOutcome, { ok: true }> {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, reason: "auth" };
    }
    if (error.status === 404) return { ok: false, reason: "gone" };
    if (error.status === 400) return { ok: false, reason: "invalid" };
  }
  return { ok: false, reason: "failed" };
}

/** Block (`true`) or unblock (`false`) `username`; both are idempotent. */
export async function setBlocked(
  username: string,
  blocked: boolean,
): Promise<BlockOutcome> {
  try {
    const state = blocked
      ? await creatorBlockUpdate(username)
      : await creatorBlockDestroy(username);
    return { ok: true, blocked: Boolean(state?.active) };
  } catch (error) {
    return blockFailure(error);
  }
}

/** Whether the signed-in account has blocked `username`; `null` = unknown. */
export async function readBlocked(username: string): Promise<boolean | null> {
  try {
    const state = await creatorBlockRetrieve(username, { timeoutMs: 15_000 });
    return Boolean(state?.active);
  } catch {
    return null;
  }
}
