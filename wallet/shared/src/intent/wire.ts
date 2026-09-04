/**
 * The version-1 intent wire format, client side.
 *
 * Byte-for-byte the format `rs/crates/f2z-intent/src/wire.rs` implements and
 * `docs/intent-bridge/PROTOCOL.md` §3 specifies. The two are held together by
 * a hex constant written down in both suites rather than by either one
 * trusting the other — `#564`'s rule: an encoder and a decoder that move
 * together stay green through a format break.
 *
 * ## The version gate
 *
 * The envelope is `{ uint16 version; opaque body<0..2^24-1>; }`, and the body
 * stays opaque until the version has been checked. So a message naming a
 * version this build does not implement is **refused**, never partially
 * interpreted — `#905`'s acceptance criterion, and the reason a future
 * version can add a field without any deployed client mistaking the result for
 * a version-1 message with something odd on the end.
 *
 * ## Re-encode equality
 *
 * Every decode re-encodes the structure and byte-compares
 * ({@link decodeIntentResponse}). This is `WIRE.md` §3.3 applied to the same
 * problem it was written for: the wallet binds its confirmation to a digest
 * over the *re-encoded* request, so a message that two implementations decode
 * differently is a message whose approval means two things.
 */

import { ByteReader, ByteWriter, bytesEqual } from "./codec";
import { IntentErrorCode, IntentOutcome, outcome, refuse } from "./error";
import { encodeVisibleText, parseVisibleText } from "./text";

/** The protocol version this package implements. */
export const INTENT_PROTOCOL_VERSION = 1;

/** The intent families version 1 defines. */
export const IntentFamily = {
  /** Prove control of the wallet identity over caller-supplied bytes. */
  SignChallenge: 1,
  /** Issue a `DeviceCredential` over device public keys. */
  IssueDeviceCredential: 2,
  /** Send ZEC, after the wallet's own payment review. */
  ExecutePayment: 3,
} as const;

/** One of {@link IntentFamily}'s values. */
export type IntentFamily = (typeof IntentFamily)[keyof typeof IntentFamily];

const FAMILY_NAMES: ReadonlyMap<IntentFamily, string> = new Map([
  [IntentFamily.SignChallenge, "sign-challenge"],
  [IntentFamily.IssueDeviceCredential, "issue-device-credential"],
  [IntentFamily.ExecutePayment, "execute-payment"],
] as const);

/** The stable name of a family, for logs and telemetry-free diagnostics. */
export function intentFamilyName(family: IntentFamily): string {
  return FAMILY_NAMES.get(family) ?? `unknown-${family}`;
}

/** Resolve a wire family code, refusing anything unimplemented. */
function requireFamily(code: number): IntentFamily {
  if (!FAMILY_NAMES.has(code as IntentFamily)) {
    refuse(IntentErrorCode.UnknownIntent);
  }
  return code as IntentFamily;
}

/** The number of bytes in a request identifier. */
export const REQUEST_ID_BYTES = 32;

/** The longest challenge `sign-challenge` will carry. */
export const MAX_CHALLENGE_BYTES = 512;

/** The longest an intent may be valid for, in milliseconds. */
export const MAX_INTENT_LIFETIME_MS = 5 * 60 * 1000;

/** A version-1 request, before encoding. */
export interface IntentRequest {
  /** The family. */
  readonly intent: IntentFamily;
  /** 32 CSPRNG bytes. See {@link newRequestId}. */
  readonly requestId: Uint8Array;
  /** This app's own identifier — a package name or bundle identifier. */
  readonly caller: string;
  /** Why, in this app's words, for the wallet to render inside its own UI. */
  readonly purpose: string;
  /** Issuance, milliseconds since the Unix epoch. */
  readonly issuedAtMs: number;
  /** Expiry, milliseconds since the Unix epoch. */
  readonly expiresAtMs: number;
  /** The family request, already encoded. */
  readonly payload: Uint8Array;
}

/** A version-1 response, after decoding. */
export interface IntentResponse {
  /** Echoes the request identifier. */
  readonly requestId: Uint8Array;
  /** Echoes the family. */
  readonly intent: IntentFamily;
  /** `0` when fulfilled, else a refusal status. */
  readonly status: number;
  /** The family result, or empty on refusal. */
  readonly payload: Uint8Array;
}

/** 32 CSPRNG bytes from the platform generator. */
export function newRequestId(): Uint8Array {
  const bytes = new Uint8Array(REQUEST_ID_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodeRequestBody(request: IntentRequest): Uint8Array {
  if (request.requestId.length !== REQUEST_ID_BYTES) {
    refuse(IntentErrorCode.InvalidValue);
  }
  if (
    !Number.isSafeInteger(request.issuedAtMs) ||
    !Number.isSafeInteger(request.expiresAtMs) ||
    request.issuedAtMs < 0 ||
    request.expiresAtMs <= request.issuedAtMs ||
    request.expiresAtMs - request.issuedAtMs > MAX_INTENT_LIFETIME_MS
  ) {
    refuse(IntentErrorCode.InvalidValue);
  }
  requireFamily(request.intent);
  const writer = new ByteWriter();
  writer.u16(request.intent);
  writer.bytes(request.requestId);
  writer.opaque8(encodeVisibleText(request.caller));
  writer.opaque8(encodeVisibleText(request.purpose));
  writer.u64(BigInt(request.issuedAtMs));
  writer.u64(BigInt(request.expiresAtMs));
  writer.opaque24(request.payload);
  return writer.finish();
}

function encodeEnvelope(body: Uint8Array): Uint8Array {
  const writer = new ByteWriter();
  writer.u16(INTENT_PROTOCOL_VERSION);
  writer.opaque24(body);
  return writer.finish();
}

/**
 * Encode a request.
 *
 * Every bound the wallet enforces is enforced here too, so a client learns it
 * built something unsendable at the point it built it rather than after a
 * round trip.
 */
export function encodeIntentRequest(
  request: IntentRequest,
): IntentOutcome<Uint8Array> {
  return outcome(() => encodeEnvelope(encodeRequestBody(request)));
}

/** Decode the opaque body of a response envelope, once the version is known. */
function decodeResponseBody(body: Uint8Array): IntentResponse {
  const reader = new ByteReader(body);
  const requestId = reader.fixed(REQUEST_ID_BYTES);
  const intent = requireFamily(reader.u16());
  const status = reader.u16();
  const payload = reader.opaque24();
  reader.finish();
  // A refusal carries a status and nothing else. A payload attached to one is
  // a channel with no defined meaning, so it is refused rather than ignored.
  if (status !== 0 && payload.length !== 0) refuse(IntentErrorCode.Malformed);
  return { requestId, intent, status, payload };
}

function encodeResponseBody(response: IntentResponse): Uint8Array {
  const writer = new ByteWriter();
  writer.bytes(response.requestId);
  writer.u16(response.intent);
  writer.u16(response.status);
  writer.opaque24(response.payload);
  return writer.finish();
}

/**
 * Decode a response: version gate first, then the body, then re-encode
 * equality over the whole envelope.
 */
export function decodeIntentResponse(
  bytes: Uint8Array,
): IntentOutcome<IntentResponse> {
  return outcome(() => {
    const reader = new ByteReader(bytes);
    const version = reader.u16();
    const body = reader.opaque24();
    reader.finish();
    // THE version gate, before the body is interpreted.
    if (version !== INTENT_PROTOCOL_VERSION) {
      refuse(IntentErrorCode.UnsupportedVersion);
    }
    const response = decodeResponseBody(body);
    // Re-encode equality (`WIRE.md` §3.3). Cheap here and it closes the gap
    // between "these bytes decoded" and "these are the only bytes that decode
    // to this".
    if (!bytesEqual(encodeEnvelope(encodeResponseBody(response)), bytes)) {
      refuse(IntentErrorCode.Malformed);
    }
    return response;
  });
}

/**
 * Decode a *request*, for tests and for a wallet-side surface written in
 * TypeScript.
 *
 * The authoritative request decoder is the Rust one — it is the side that
 * grants authority. This exists so the client's conformance suite can prove
 * the two agree about the same bytes.
 */
export function decodeIntentRequest(
  bytes: Uint8Array,
): IntentOutcome<IntentRequest> {
  return outcome(() => {
    const reader = new ByteReader(bytes);
    const version = reader.u16();
    const body = reader.opaque24();
    reader.finish();
    if (version !== INTENT_PROTOCOL_VERSION) {
      refuse(IntentErrorCode.UnsupportedVersion);
    }
    const inner = new ByteReader(body);
    const intent = requireFamily(inner.u16());
    const requestId = inner.fixed(REQUEST_ID_BYTES);
    const caller = parseVisibleText(inner.opaque8());
    const purpose = parseVisibleText(inner.opaque8());
    const issuedAt = inner.u64();
    const expiresAt = inner.u64();
    const payload = inner.opaque24();
    inner.finish();
    if (
      issuedAt > BigInt(Number.MAX_SAFE_INTEGER) ||
      expiresAt > BigInt(Number.MAX_SAFE_INTEGER) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > BigInt(MAX_INTENT_LIFETIME_MS)
    ) {
      refuse(IntentErrorCode.InvalidValue);
    }
    const request: IntentRequest = {
      intent,
      requestId,
      caller,
      purpose,
      issuedAtMs: Number(issuedAt),
      expiresAtMs: Number(expiresAt),
      payload,
    };
    if (!bytesEqual(encodeEnvelope(encodeRequestBody(request)), bytes)) {
      refuse(IntentErrorCode.Malformed);
    }
    return request;
  });
}

/** Encode a `sign-challenge` family payload. */
export function encodeSignChallengePayload(
  challenge: Uint8Array,
): IntentOutcome<Uint8Array> {
  return outcome(() => {
    if (challenge.length === 0 || challenge.length > MAX_CHALLENGE_BYTES) {
      refuse(IntentErrorCode.InvalidValue);
    }
    const writer = new ByteWriter();
    writer.opaque24(challenge);
    return writer.finish();
  });
}

/** Encode an `execute-payment` family payload. */
export function encodeExecutePaymentPayload(payment: {
  readonly recipient: string;
  readonly amountZatoshis: bigint;
  readonly memo: string;
  readonly feeZatoshis: bigint;
}): IntentOutcome<Uint8Array> {
  return outcome(() => {
    if (payment.amountZatoshis <= 0n) refuse(IntentErrorCode.InvalidValue);
    const writer = new ByteWriter();
    writer.opaque8(encodeVisibleText(payment.recipient));
    writer.u64(payment.amountZatoshis);
    writer.opaque8(
      payment.memo.length === 0
        ? new Uint8Array(0)
        : encodeVisibleText(payment.memo),
    );
    writer.u64(payment.feeZatoshis);
    return writer.finish();
  });
}

/**
 * Decode an `issue-device-credential` family **result**.
 *
 * `struct { opaque credential<0..2^24-1>; } IssueDeviceCredentialResultV1`
 * (§3.3). The credential stays opaque: it is a
 * `f2z_kt_core::DeviceCredential`, defined once in that crate, and a second
 * definition on this side would be a second chance to disagree about the bytes
 * the whole key-transparency directory is built on. What this function
 * guarantees is only that the *framing* is exactly one well-formed structure —
 * the caller must still hand the bytes to the layer that validates them.
 *
 * Three refusals, and each is a shape a hostile responder can send:
 *
 * - a **truncated** payload, caught by the reader's before-the-read bounds
 *   check rather than becoming a short array of plausible zeroes;
 * - **trailing bytes** after the credential, caught by `finish()` and again by
 *   re-encode equality, because a payload that decodes two ways is a payload
 *   whose meaning depends on who is reading;
 * - an **empty** credential, which frames perfectly and is not a credential.
 *   `KT.md` §4.1 gives no valid zero-length encoding, so accepting it would
 *   mean returning `ok` for nothing at all.
 */
export function decodeIssueDeviceCredentialResult(
  payload: Uint8Array,
): IntentOutcome<Uint8Array> {
  return outcome(() => {
    const reader = new ByteReader(payload);
    const credential = reader.opaque24();
    reader.finish();
    if (credential.length === 0) refuse(IntentErrorCode.InvalidValue);
    const writer = new ByteWriter();
    writer.opaque24(credential);
    if (!bytesEqual(writer.finish(), payload)) {
      refuse(IntentErrorCode.Malformed);
    }
    return credential;
  });
}

/** Encode an `issue-device-credential` family payload. Public keys only. */
export function encodeIssueDeviceCredentialPayload(device: {
  readonly handle: string;
  readonly devicePublicKey: Uint8Array;
  readonly deviceKemPublicKey: Uint8Array;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}): IntentOutcome<Uint8Array> {
  return outcome(() => {
    if (
      device.devicePublicKey.length !== 32 ||
      device.deviceKemPublicKey.length === 0 ||
      !Number.isSafeInteger(device.notBeforeMs) ||
      !Number.isSafeInteger(device.notAfterMs) ||
      device.notAfterMs <= device.notBeforeMs
    ) {
      refuse(IntentErrorCode.InvalidValue);
    }
    const writer = new ByteWriter();
    writer.opaque8(encodeVisibleText(device.handle));
    writer.bytes(device.devicePublicKey);
    writer.opaque24(device.deviceKemPublicKey);
    writer.u64(BigInt(device.notBeforeMs));
    writer.u64(BigInt(device.notAfterMs));
    return writer.finish();
  });
}
