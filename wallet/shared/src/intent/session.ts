/**
 * The client's outstanding-question map — `creator-tip.ts`, generalised.
 *
 * `wallet/zuuli/src/lib/wallet/creator-tip.ts` says it best, about a route
 * state rather than a deep link:
 *
 * > A route state is renderer-controlled and therefore cannot authenticate
 * > itself. Keep the source snapshot in module memory and use the route nonce
 * > only as a lookup capability. Reloads and fresh deep links intentionally
 * > lose this map and fail closed.
 *
 * Every clause survives the substitution. A response arrives as bytes over a
 * channel that does not name its sender; the only thing that makes it an
 * *answer* is that this client is holding a matching outstanding question,
 * keyed by 32 CSPRNG bytes it generated and put in exactly one outbound link.
 *
 * ## What this proves, and what it does not
 *
 * It proves the responder saw the request. A bystander cannot guess a request
 * identifier, so a bystander cannot forge a response.
 *
 * **It does not prove the responder is ZUULI.** An app that *received* the
 * request — because it registered the same link and the operating system
 * routed there — holds the identifier and can answer. That is exactly why
 * [#461](https://github.com/free2z/zuu/issues/461), verified App Links and
 * Universal Links, is a hard prerequisite before any intent carrying authority
 * ships. `docs/intent-bridge/CALLER-AUTHENTICATION.md` §4 states the residual
 * risk if that assumption fails.
 *
 * ## Deliberately not persisted
 *
 * The map lives in memory. A reload loses it and every outstanding question
 * fails closed, which is `creator-tip.ts`'s behaviour and is correct: a
 * response that outlives the page that asked for it is a response nobody is
 * waiting for.
 */

import { bytesEqual } from "./codec";
import {
  IntentErrorCode,
  IntentOutcome,
  intentErrorFromStatus,
} from "./error";
import {
  IntentFamily,
  IntentRequest,
  decodeIntentResponse,
  encodeIntentRequest,
} from "./wire";

/** How many questions one client keeps outstanding. */
export const MAX_PENDING_INTENTS = 32;

/** A fulfilled response, family-tagged from the *pending* record. */
export interface AcceptedIntentResponse {
  /** The family, taken from what this client asked rather than from the reply. */
  readonly intent: IntentFamily;
  /** The family result, still opaque. */
  readonly payload: Uint8Array;
}

interface Pending {
  readonly requestId: Uint8Array;
  readonly intent: IntentFamily;
  readonly expiresAtMs: number;
}

/** The client half of the bridge. */
export interface IntentSession {
  /** Encode a request and record it as outstanding. */
  issue(request: IntentRequest, nowMs: number): IntentOutcome<Uint8Array>;
  /** Judge a response against the outstanding questions. */
  accept(
    bytes: Uint8Array,
    nowMs: number,
  ): IntentOutcome<AcceptedIntentResponse>;
  /** How many questions are outstanding. */
  readonly size: number;
}

/**
 * A fresh session.
 *
 * A factory rather than a module-level singleton: a singleton would be shared
 * between an app and its tests, and — more to the point — between two
 * independent surfaces in one process, so one surface's response could be
 * matched against another's question.
 */
export function createIntentSession(
  capacity: number = MAX_PENDING_INTENTS,
): IntentSession {
  const pending: Pending[] = [];

  const prune = (nowMs: number): void => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (entry !== undefined && entry.expiresAtMs <= nowMs) {
        pending.splice(index, 1);
      }
    }
  };

  return {
    get size(): number {
      return pending.length;
    },

    issue(request: IntentRequest, nowMs: number): IntentOutcome<Uint8Array> {
      const encoded = encodeIntentRequest(request);
      if (!encoded.ok) return encoded;
      prune(nowMs);
      if (
        pending.some((entry) => bytesEqual(entry.requestId, request.requestId))
      ) {
        return { ok: false, error: IntentErrorCode.InvalidValue };
      }
      // Fail closed rather than evicting: dropping the oldest outstanding
      // question is precisely how an attacker makes room for a forged answer.
      if (pending.length >= capacity) {
        return { ok: false, error: IntentErrorCode.LedgerFull };
      }
      pending.push({
        requestId: Uint8Array.from(request.requestId),
        intent: request.intent,
        expiresAtMs: request.expiresAtMs,
      });
      return encoded;
    },

    accept(
      bytes: Uint8Array,
      nowMs: number,
    ): IntentOutcome<AcceptedIntentResponse> {
      const decoded = decodeIntentResponse(bytes);
      if (!decoded.ok) return decoded;
      const response = decoded.value;
      const index = pending.findIndex((entry) =>
        bytesEqual(entry.requestId, response.requestId),
      );
      if (index < 0) return { ok: false, error: IntentErrorCode.Unsolicited };
      const entry = pending[index];
      if (entry === undefined) {
        return { ok: false, error: IntentErrorCode.Unsolicited };
      }
      // One use. The question is answered — or spoiled — either way, so a
      // replayed response link finds nothing outstanding the second time.
      pending.splice(index, 1);
      if (entry.intent !== response.intent) {
        return { ok: false, error: IntentErrorCode.Unsolicited };
      }
      if (nowMs >= entry.expiresAtMs) {
        return { ok: false, error: IntentErrorCode.Expired };
      }
      if (response.status !== 0) {
        return {
          ok: false,
          error:
            intentErrorFromStatus(response.status) ?? IntentErrorCode.Malformed,
        };
      }
      return {
        ok: true,
        value: { intent: entry.intent, payload: response.payload },
      };
    },
  };
}
