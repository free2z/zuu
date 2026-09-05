/**
 * The caller side of `issue-device-credential` — #905, #904, blocked on #461.
 *
 * ZUULI holds the Zcash seed and is therefore the wallet authority. e2e2z holds
 * device keys and a `DeviceCredential` and never anything seed-derived
 * (`docs/e2ee/ARCHITECTURE.md` §4.2). The one operation that crosses that line
 * is enrollment: claiming a handle means signing with the seed-derived
 * `IdentitySigningKey`, and the signature that binds *this* device to *that*
 * account is a `DeviceCredential`. So this app asks for one, and asks in the
 * one format both halves already implement.
 *
 * ## Everything here is built through the single implementation
 *
 * `@free2z/wallet-shared` is the only intent-bridge implementation in the
 * repository and `wallet/zuuli/scripts/project-boundary.mjs` enforces that
 * mechanically: the version gate, the request encoder, the response decoder,
 * the outstanding-question map and the text validator may only be *declared*
 * under `wallet/shared/src/intent`. This module declares none of them. It
 * supplies policy — who is calling, what for, how long the request lives — and
 * hands every byte decision to the shared code.
 *
 * That is not tidiness. The wallet binds the user's approval to a digest over
 * the re-encoded request (`PROTOCOL.md` §5), so a client that encoded a request
 * even slightly differently would be asking the user to approve a structure
 * that means one thing here and another there.
 *
 * ## It fails closed, and the closure is one line deep
 *
 * There is no transport (`./transport.ts`), so in the shipping build this
 * function throws before it samples a key. It **never** returns a fabricated
 * credential and it **never** synthesizes an `EnrollmentStatus`: every field of
 * one is a claim about the key-transparency directory, and a fabricated
 * `enrolled: true` would make this app render a handle nobody published.
 *
 * ## What the response validation can and cannot prove
 *
 * `CALLER-AUTHENTICATION.md` §5 is explicit: **there is no signature over
 * responses.** So the checks below prove exactly one thing — that whoever
 * answered had seen this request, because `request_id` is 32 CSPRNG bytes that
 * appeared in exactly one outbound message. They do **not** prove the responder
 * was ZUULI. An app that *received* the request holds the identifier and can
 * answer. Only a transport that authenticates the response destination closes
 * that, which is #461, which is why nothing dispatches yet.
 */

import {
  IntentErrorCode,
  IntentFamily,
  createIntentSession,
  decodeIssueDeviceCredentialResult,
  encodeIssueDeviceCredentialPayload,
  intentErrorName,
  intentFamilyName,
  newRequestId,
  toHex,
  type IntentOutcome,
  type IntentSession,
} from "@free2z/wallet-shared";
import {
  readDeviceCredentialKeys,
  type DeviceCredentialKeys,
} from "./deviceKeys";
import {
  intentTransport,
  IntentTransportUnavailableError,
  type IntentTransport,
} from "./transport";

/**
 * This app's own identifier — the bundle identifier `tauri.conf.json` declares.
 *
 * It is a **claim**, and the protocol says so. ZUULI renders the caller's
 * display name from its own registry and never from this string
 * (`CALLER-AUTHENTICATION.md` §2), and on iOS there is no attestation that
 * could make it more than a claim. It is here so the wallet can look the caller
 * up, not so the wallet can believe it.
 */
export const E2E2Z_CALLER = "cash.free2z.e2e2z";

/**
 * What the wallet renders inside its own confirmation.
 *
 * Bridge text (`PROTOCOL.md` §3.5): UTF-8, non-empty, trimmed, at most 255
 * bytes, and no bidirectional or invisible-formatting control. A constant
 * rather than something composed at the call site, because a `purpose` is
 * authored by *this* app specifically to appear inside *ZUULI's* confirmation,
 * and a string with a runtime-interpolated tail is a string an attacker who
 * reaches the interpolation gets to write.
 */
export const ISSUE_DEVICE_CREDENTIAL_PURPOSE =
  "Issue this device a messaging credential";

/**
 * How long the *request* stays answerable, in milliseconds.
 *
 * Two minutes, against §3.4's five-minute ceiling. The user has to read a
 * confirmation in another app, so seconds are too few; the ceiling exists
 * because "nothing here is a continuous grant" (#904), so the whole window
 * should be no longer than the task needs.
 */
export const REQUEST_LIFETIME_MS = 120_000;

/**
 * How long the *credential* is requested for.
 *
 * The same window `wallet/zuuli/src-tauri/src/messaging.rs` already uses when
 * it issues one in process — an hour of backdating for clock skew, then a year
 * — so the bridged path and the in-process path ask for the identical thing.
 * `KT.md` §4.1 leaves the window to the issuer, and ZUULI is the issuer: these
 * are a **request**, and it may narrow them.
 */
export const CREDENTIAL_BACKDATE_MS = 3_600_000;
/** See {@link CREDENTIAL_BACKDATE_MS}. */
export const CREDENTIAL_LIFETIME_MS = 31_536_000_000;

/**
 * A refusal that came from the protocol rather than from the transport.
 *
 * `stage` says which side was wrong, and it matters: `request` means this app
 * built something unsendable and is a bug here, while `response` means the
 * answer failed a check and is either a broken responder or a hostile one.
 */
export class IntentRefusedError extends Error {
  readonly reason = "intent-refused" as const;
  readonly code: IntentErrorCode;
  readonly stage: "request" | "response";

  constructor(stage: "request" | "response", code: IntentErrorCode) {
    super(
      `the issue-device-credential ${stage} was refused: ${intentErrorName(code)}`,
    );
    this.name = "IntentRefusedError";
    this.stage = stage;
    this.code = code;
  }
}

/** Whether a caught value is an {@link IntentRefusedError}, prototype or not. */
export function isIntentRefused(error: unknown): error is IntentRefusedError {
  return (
    error instanceof IntentRefusedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { reason?: unknown }).reason === "intent-refused")
  );
}

/** Unwrap an outcome, or throw the refusal it carries. */
function orRefuse<T>(
  outcome: IntentOutcome<T>,
  stage: "request" | "response",
): T {
  if (!outcome.ok) throw new IntentRefusedError(stage, outcome.error);
  return outcome.value;
}

/** The seams a test replaces. Production passes none of them. */
export interface DeviceCredentialClientOptions {
  /** The outstanding-question map. One per client, never module-global. */
  readonly session?: IntentSession;
  /** Where the bytes go. Defaults to the registry in `./transport.ts`. */
  readonly transport?: () => IntentTransport;
  /** How device public keys are read. Defaults to the app-crate command. */
  readonly readKeys?: () => Promise<DeviceCredentialKeys>;
  /** The wall clock. */
  readonly now?: () => number;
}

/** The client half of `issue-device-credential`. */
export interface DeviceCredentialClient {
  /**
   * Ask the wallet authority to issue this device a credential for `handle`.
   *
   * Resolves with the credential's canonical bytes — opaque here on purpose:
   * it is a `f2z_kt_core::DeviceCredential`, defined once in that crate, and
   * the layer that installs it is the one that validates it.
   *
   * @throws {@link IntentTransportUnavailableError} in every shipping build.
   * @throws {@link IntentRefusedError} when the protocol refuses either half.
   * @throws `DeviceKeysUnavailableError` when this device's keys are unusable.
   */
  requestDeviceCredential(handle: string): Promise<Uint8Array>;
  /** How many questions are outstanding, for tests and diagnostics. */
  readonly pending: number;
}

/**
 * A client.
 *
 * A factory and not a singleton, for `createIntentSession`'s reason: a module
 * global would be shared between two independent surfaces in one process, so
 * one surface's response could be matched against another's question.
 */
export function createDeviceCredentialClient(
  options: DeviceCredentialClientOptions = {},
): DeviceCredentialClient {
  const session = options.session ?? createIntentSession();
  const transportOf = options.transport ?? intentTransport;
  const readKeys = options.readKeys ?? readDeviceCredentialKeys;
  const now = options.now ?? (() => Date.now());
  const family = intentFamilyName(IntentFamily.IssueDeviceCredential);

  return {
    get pending(): number {
      return session.size;
    },

    async requestDeviceCredential(handle: string): Promise<Uint8Array> {
      const transport = transportOf();
      // Before anything is sampled. `prepare_device` replaces this device's
      // pending key set and discards the previous secrets, so preparing a
      // device for a request that cannot leave the process throws key material
      // away for nothing. The transport refuses again inside `dispatch`, and
      // that second refusal does not read this flag — see `./transport.ts`.
      if (!transport.available) {
        throw new IntentTransportUnavailableError(family);
      }

      const keys = await readKeys();
      const issuedAtMs = now();
      const payload = orRefuse(
        encodeIssueDeviceCredentialPayload({
          handle,
          devicePublicKey: keys.devicePublicKey,
          deviceKemPublicKey: keys.deviceKemPublicKey,
          notBeforeMs: Math.max(0, issuedAtMs - CREDENTIAL_BACKDATE_MS),
          notAfterMs: issuedAtMs + CREDENTIAL_LIFETIME_MS,
        }),
        "request",
      );

      const requestId = newRequestId();
      const expiresAtMs = issuedAtMs + REQUEST_LIFETIME_MS;
      // `issue` encodes and records in one step, so there is no window in which
      // a request exists on the wire without an outstanding question behind it.
      const encoded = orRefuse(
        session.issue(
          {
            intent: IntentFamily.IssueDeviceCredential,
            requestId,
            caller: E2E2Z_CALLER,
            purpose: ISSUE_DEVICE_CREDENTIAL_PURPOSE,
            issuedAtMs,
            expiresAtMs,
            payload,
          },
          issuedAtMs,
        ),
        "request",
      );

      // The record stays outstanding if this rejects. It is keyed by 32 CSPRNG
      // bytes and expires on its own; removing it here would mean a response
      // that crossed a slow dispatch's rejection could never be judged.
      const answer = await transport.dispatch(encoded, {
        family,
        requestId: toHex(requestId),
        expiresAtMs,
      });

      // A transport is not trusted to have returned bytes at all. Anything else
      // is a programming error in the transport, not a message, so it is not
      // laundered into a protocol refusal.
      if (!(answer instanceof Uint8Array)) {
        throw new TypeError(
          `the ${transport.id} transport resolved with something that is not a response`,
        );
      }

      // Every hostile shape is judged here: an unsolicited identifier, a
      // different family, an expired window, a refusal status, a malformed or
      // truncated envelope, trailing bytes. All of it is the shared session's
      // and the shared decoder's, re-checked against the frozen record.
      const accepted = orRefuse(session.accept(answer, now()), "response");

      // Defence in depth. `accept` already tags the result from the *pending*
      // record rather than from the reply, and refuses a family mismatch; this
      // costs nothing and means a future change to that tagging cannot quietly
      // route another family's payload into a credential.
      if (accepted.intent !== IntentFamily.IssueDeviceCredential) {
        throw new IntentRefusedError("response", IntentErrorCode.Unsolicited);
      }

      return orRefuse(
        decodeIssueDeviceCredentialResult(accepted.payload),
        "response",
      );
    },
  };
}
