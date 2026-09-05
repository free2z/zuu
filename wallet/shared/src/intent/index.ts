/**
 * The cross-app intent bridge, client side — `docs/intent-bridge/PROTOCOL.md`.
 *
 * One implementation, consumed by every app that is not the wallet. It sits
 * inside `@free2z/wallet-shared` rather than beside it because
 * `wallet/zuuli/scripts/project-boundary.mjs` pins that package's exports to
 * exactly `{".": "./src/index.ts"}`, and a *second* shared package would be a
 * second place for a second copy of this to appear — which is the thing #905
 * asks the boundary scanner to forbid.
 *
 * The wallet side is `rs/crates/f2z-intent`. This half never grants authority;
 * it builds requests, remembers them, and refuses answers to questions it did
 * not ask.
 */

export {
  IntentErrorCode,
  IntentRefusal,
  intentErrorFromStatus,
  intentErrorName,
} from "./error";
export type { IntentOutcome } from "./error";
export { bytesEqual, fromHex, toHex } from "./codec";
export {
  MAX_TEXT_BYTES,
  escapeLayoutControls,
  isForbiddenCodePoint,
  parseVisibleText,
} from "./text";
export {
  INTENT_PROTOCOL_VERSION,
  IntentFamily,
  MAX_CHALLENGE_BYTES,
  MAX_INTENT_LIFETIME_MS,
  REQUEST_ID_BYTES,
  TXID_BYTES,
  decodeExecutePaymentResult,
  decodeIntentRequest,
  decodeIntentResponse,
  decodeIssueDeviceCredentialResult,
  encodeExecutePaymentPayload,
  encodeIntentRequest,
  encodeIssueDeviceCredentialPayload,
  encodeSignChallengePayload,
  intentFamilyName,
  newRequestId,
} from "./wire";
export type { IntentRequest, IntentResponse } from "./wire";
export {
  MAX_PENDING_INTENTS,
  createIntentSession,
} from "./session";
export type { AcceptedIntentResponse, IntentSession } from "./session";
