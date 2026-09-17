/**
 * Why an "Enroll with ZUULI" attempt did not finish, as something a screen can
 * say.
 *
 * `bridge.enroll` wraps every failure in `EnrollmentUnavailableError` and keeps
 * the real one as `cause`. This module reads that cause, and only its
 * machine-readable parts — a `reason`, an intent status, a bare §8 code — so
 * no branch here depends on an error's prose.
 *
 * Each kind is a different next step for the person holding the phone, which
 * is the only reason two kinds are separate:
 *
 * | kind               | what happened                                          |
 * | ------------------ | ------------------------------------------------------ |
 * | `unavailable`      | this build has no App Link transport (desktop, web)    |
 * | `busy`             | a request is already waiting for ZUULI                 |
 * | `cancelled`        | the user stopped waiting                               |
 * | `expired`          | no answer inside the request's lifetime                |
 * | `declined`         | the user said no in ZUULI                              |
 * | `wallet-not-ready` | ZUULI could not act (no wallet, or wallet locked)      |
 * | `not-registered`   | ZUULI does not recognise this app as a caller          |
 * | `link-failed`      | the platform would not open ZUULI's link               |
 * | `handle-mismatch`  | the credential names another handle (ADR 0016 §4)      |
 * | `durability`       | this device cannot keep a wrap key                     |
 * | `unknown-outcome`  | ZUULI answered a status this build cannot read         |
 * | `defect`           | anything else, with the detail kept for a bug report   |
 */

import { IntentErrorCode, intentErrorName } from "@free2z/wallet-shared";

export type EnrollmentFailureKind =
  | "unavailable"
  | "busy"
  | "cancelled"
  | "expired"
  | "declined"
  | "wallet-not-ready"
  | "not-registered"
  | "link-failed"
  | "handle-mismatch"
  | "durability"
  | "unknown-outcome"
  | "defect";

export interface EnrollmentFailure {
  readonly kind: EnrollmentFailureKind;
  /** Evidence for a bug report: a code or a message. Never shown as a title. */
  readonly detail: string;
}

type Tagged = { reason?: unknown; cause?: unknown; code?: unknown; stage?: unknown; message?: unknown };

function tagged(value: unknown): Tagged | null {
  return typeof value === "object" && value !== null ? (value as Tagged) : null;
}

/** The innermost cause, following `cause` through the bridge's wrapper. */
function innermost(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = tagged(current);
    if (
      record?.reason === "enrollment-requires-wallet-app" ||
      record?.reason === "device-credential-install-failed"
    ) {
      if (record.cause === undefined) return current;
      current = record.cause;
      continue;
    }
    return current;
  }
  return current;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = tagged(value);
  if (record && typeof record.message === "string") return record.message;
  return String(value);
}

/** A bare §8 code, as `tauri-plugin-f2zmsg` serializes every refusal. */
function engineCode(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : null;
  return candidate !== null && /^[a-z]+(-[a-z]+)*$/.test(candidate)
    ? candidate
    : null;
}

/**
 * Classify a failed enrollment.
 *
 * `installFailed` is whether the failure came from the install step, which is
 * the only place a `handle-ineligible` code means "ZUULI signed a different
 * handle" rather than "the handle was never valid".
 */
export function classifyEnrollmentFailure(error: unknown): EnrollmentFailure {
  const outer = tagged(error);
  // Whether the install step refused. The wrapper is kept by the bridge, so
  // this is read before unwrapping.
  let installFailed = false;
  for (
    let current: unknown = error, depth = 0;
    depth < 4 && tagged(current);
    depth += 1
  ) {
    const record = tagged(current);
    if (record?.reason === "device-credential-install-failed") {
      installFailed = true;
      break;
    }
    current = record?.cause;
  }

  const cause = innermost(error);
  const record = tagged(cause);
  const detail = text(cause);

  switch (record?.reason) {
    case "intent-transport-not-built":
      return { kind: "unavailable", detail };
    case "intent-dispatch-in-flight":
      return { kind: "busy", detail };
    case "intent-dispatch-cancelled":
      return { kind: "cancelled", detail };
    case "intent-response-timeout":
      return { kind: "expired", detail };
    case "authority-link-failed":
      return { kind: "link-failed", detail };
    case "intent-status-unknown":
      return { kind: "unknown-outcome", detail };
    case "device-keys-unavailable":
      return { kind: "defect", detail };
    case "intent-refused": {
      const code = record.code as IntentErrorCode;
      const name = intentErrorName(code);
      if (record.stage === "response") {
        if (code === IntentErrorCode.NotConfirmed) {
          return { kind: "declined", detail: name };
        }
        if (code === IntentErrorCode.Expired) {
          return { kind: "expired", detail: name };
        }
        if (code === IntentErrorCode.Unavailable) {
          return { kind: "wallet-not-ready", detail: name };
        }
        if (code === IntentErrorCode.CallerNotAuthorized) {
          return { kind: "not-registered", detail: name };
        }
      }
      return { kind: "defect", detail: name };
    }
    default:
      break;
  }

  const code = engineCode(cause);
  if (code === "durability-unavailable") {
    return { kind: "durability", detail: code };
  }
  if (code === "handle-ineligible" && installFailed) {
    return { kind: "handle-mismatch", detail: code };
  }
  // The wrapper itself with nothing inside: a refusal with no recorded cause.
  if (cause === error && outer?.reason === "enrollment-requires-wallet-app") {
    return { kind: "unavailable", detail };
  }
  return { kind: "defect", detail: code ?? detail };
}
