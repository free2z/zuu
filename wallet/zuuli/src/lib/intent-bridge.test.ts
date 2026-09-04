/**
 * The client half of `#905`'s conformance suite.
 *
 * It lives in ZUULI rather than in `wallet/shared` because
 * `@free2z/wallet-shared` has no test runner of its own and adding one would
 * mean a second dependency graph for a package whose whole value is being the
 * single copy. Shared code is tested through a consumer here, which is the
 * pattern `src/lib/wallet/sensitive-entry.test.ts` already follows.
 *
 * Every case was mutation-verified the same way the Rust suite was: the guard
 * was broken in `wallet/shared/src/intent/`, this file was watched to fail,
 * and the guard was restored. `docs/intent-bridge/CONFORMANCE.md` records the
 * mutations — **including the two that leave this file green**, because
 * version 1 has exactly one encoding per value and so `finish()` and
 * re-encode equality each catch a trailing byte on their own. Removing both
 * together is what a trailing byte survives, and that mutation does fail here.
 * Reporting those two as independently proven would have been the
 * overstatement the whole exercise exists to avoid.
 */

import { describe, expect, it } from "vitest";
import {
  INTENT_PROTOCOL_VERSION,
  IntentErrorCode,
  IntentFamily,
  MAX_CHALLENGE_BYTES,
  MAX_INTENT_LIFETIME_MS,
  createIntentSession,
  decodeIntentRequest,
  decodeIntentResponse,
  encodeExecutePaymentPayload,
  encodeIntentRequest,
  encodeIssueDeviceCredentialPayload,
  encodeSignChallengePayload,
  escapeLayoutControls,
  fromHex,
  isForbiddenCodePoint,
  newRequestId,
  parseVisibleText,
  toHex,
} from "@free2z/wallet-shared";
import type { IntentOutcome, IntentRequest } from "@free2z/wallet-shared";

/**
 * The canonical fixture, byte for byte.
 *
 * **This constant is the contract.** `rs/crates/f2z-intent/tests/wire_vectors.rs`
 * pins the identical string, derived by hand from
 * `docs/intent-bridge/PROTOCOL.md` §3 rather than printed from either encoder.
 * Two implementations agreeing with themselves proves nothing; two
 * implementations agreeing with one written-down constant is what makes "one
 * wire format" a fact.
 *
 * ```text
 * 0001                      version = 1
 * 00007d                    body length = 125
 *   0001                    intent = 1 (sign-challenge)
 *   77 x32                  request_id
 *   12 "cash.free2z.free2z" caller
 *   11 "Sign in to free2z"  purpose
 *   0000018bcfe56800        issued_at_ms  = 1_700_000_000_000
 *   0000018bcfe65260        expires_at_ms = 1_700_000_060_000
 *   000023                  payload length = 35
 *     000020                challenge length = 32
 *     5a x32
 * ```
 */
const CANONICAL_REQUEST_HEX =
  "0001" +
  "00007d" +
  "0001" +
  "7777777777777777777777777777777777777777777777777777777777777777" +
  "12" +
  "636173682e66726565327a2e66726565327a" +
  "11" +
  "5369676e20696e20746f2066726565327a" +
  "0000018bcfe56800" +
  "0000018bcfe65260" +
  "000023" +
  "000020" +
  "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

const ISSUED_AT_MS = 1_700_000_000_000;
const EXPIRES_AT_MS = ISSUED_AT_MS + 60_000;
const REQUEST_ID = new Uint8Array(32).fill(0x77);

function unwrap<T>(outcome: IntentOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`expected success, got status ${outcome.error}`);
  }
  return outcome.value;
}

function refusal<T>(outcome: IntentOutcome<T>): IntentErrorCode {
  if (outcome.ok) throw new Error("expected a refusal, got success");
  return outcome.error;
}

function canonicalRequest(): IntentRequest {
  return {
    intent: IntentFamily.SignChallenge,
    requestId: REQUEST_ID,
    caller: "cash.free2z.free2z",
    purpose: "Sign in to free2z",
    issuedAtMs: ISSUED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    payload: unwrap(encodeSignChallengePayload(new Uint8Array(32).fill(0x5a))),
  };
}

function response(options: {
  requestId?: Uint8Array;
  intent?: number;
  status?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const body: number[] = [];
  const requestId = options.requestId ?? REQUEST_ID;
  body.push(...requestId);
  const intent = options.intent ?? IntentFamily.SignChallenge;
  body.push((intent >>> 8) & 0xff, intent & 0xff);
  const status = options.status ?? 0;
  body.push((status >>> 8) & 0xff, status & 0xff);
  const payload = options.payload ?? new Uint8Array(96).fill(0x01);
  body.push(
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  );
  const envelope: number[] = [];
  envelope.push(
    (INTENT_PROTOCOL_VERSION >>> 8) & 0xff,
    INTENT_PROTOCOL_VERSION & 0xff,
  );
  envelope.push(
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    ...body,
  );
  return Uint8Array.from(envelope);
}

describe("the wire format is the one the Rust wallet implements", () => {
  it("encodes the canonical request to the specified bytes", () => {
    expect(toHex(unwrap(encodeIntentRequest(canonicalRequest())))).toBe(
      CANONICAL_REQUEST_HEX,
    );
  });

  it("decodes the hand-written vector back to the same fields", () => {
    const decoded = unwrap(decodeIntentRequest(fromHex(CANONICAL_REQUEST_HEX)));
    expect(decoded.intent).toBe(IntentFamily.SignChallenge);
    expect(decoded.caller).toBe("cash.free2z.free2z");
    expect(decoded.purpose).toBe("Sign in to free2z");
    expect(decoded.issuedAtMs).toBe(ISSUED_AT_MS);
    expect(decoded.expiresAtMs).toBe(EXPIRES_AT_MS);
    expect(toHex(decoded.payload)).toBe(
      "000020" + "5a".repeat(32),
    );
  });

  it("round-trips every family", () => {
    const payloads = [
      unwrap(encodeSignChallengePayload(new Uint8Array(16).fill(1))),
      unwrap(
        encodeIssueDeviceCredentialPayload({
          handle: "skylar",
          devicePublicKey: new Uint8Array(32).fill(0x11),
          deviceKemPublicKey: new Uint8Array(64).fill(0x22),
          notBeforeMs: ISSUED_AT_MS,
          notAfterMs: ISSUED_AT_MS + 86_400_000,
        }),
      ),
      unwrap(
        encodeExecutePaymentPayload({
          recipient: "u1exampleexampleexample",
          amountZatoshis: 100_000n,
          memo: "thanks for the article",
          feeZatoshis: 10_000n,
        }),
      ),
    ];
    const families = [
      IntentFamily.SignChallenge,
      IntentFamily.IssueDeviceCredential,
      IntentFamily.ExecutePayment,
    ];
    families.forEach((intent, index) => {
      const request: IntentRequest = {
        ...canonicalRequest(),
        intent,
        payload: payloads[index] as Uint8Array,
      };
      const bytes = unwrap(encodeIntentRequest(request));
      expect(unwrap(decodeIntentRequest(bytes)).intent).toBe(intent);
    });
  });
});

describe("an unknown version is refused rather than best-guessed", () => {
  it("refuses every version but the implemented one, on both directions", () => {
    const canonical = fromHex(CANONICAL_REQUEST_HEX);
    for (const version of [0, 2, 7, 0xffff]) {
      const mutated = Uint8Array.from(canonical);
      mutated[0] = (version >>> 8) & 0xff;
      mutated[1] = version & 0xff;
      expect(refusal(decodeIntentRequest(mutated))).toBe(
        IntentErrorCode.UnsupportedVersion,
      );
    }
    const reply = response({});
    reply[1] = INTENT_PROTOCOL_VERSION + 1;
    expect(refusal(decodeIntentResponse(reply))).toBe(
      IntentErrorCode.UnsupportedVersion,
    );
  });

  it("never parses a future version's body as version one", () => {
    // A version-2 request that appended a field. Under a flat structure this
    // would decode as version 1 plus trailing bytes.
    const canonical = fromHex(CANONICAL_REQUEST_HEX);
    const body = canonical.subarray(5);
    const extended = Uint8Array.from([...body, 0xde, 0xad, 0xbe, 0xef]);
    const envelope = Uint8Array.from([
      0x00,
      0x02,
      (extended.length >>> 16) & 0xff,
      (extended.length >>> 8) & 0xff,
      extended.length & 0xff,
      ...extended,
    ]);
    expect(refusal(decodeIntentRequest(envelope))).toBe(
      IntentErrorCode.UnsupportedVersion,
    );
  });

  it("refuses an unimplemented intent family", () => {
    const canonical = fromHex(CANONICAL_REQUEST_HEX);
    for (const family of [0, 4, 0xffff]) {
      const mutated = Uint8Array.from(canonical);
      mutated[5] = (family >>> 8) & 0xff;
      mutated[6] = family & 0xff;
      expect(refusal(decodeIntentRequest(mutated))).toBe(
        IntentErrorCode.UnknownIntent,
      );
    }
  });
});

describe("malformed input is refused at every shape", () => {
  it("refuses every truncation, trailing data and over-long prefix", () => {
    const canonical = fromHex(CANONICAL_REQUEST_HEX);
    expect(refusal(decodeIntentRequest(new Uint8Array(0)))).toBe(
      IntentErrorCode.Malformed,
    );
    for (let cut = 0; cut < canonical.length; cut += 1) {
      expect(refusal(decodeIntentRequest(canonical.subarray(0, cut)))).toBe(
        IntentErrorCode.Malformed,
      );
    }
    expect(
      refusal(decodeIntentRequest(Uint8Array.from([...canonical, 0]))),
    ).toBe(IntentErrorCode.Malformed);
    const overlong = Uint8Array.from(canonical);
    overlong[2] = 0xff;
    expect(refusal(decodeIntentRequest(overlong))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("never throws on a single-byte corruption anywhere", () => {
    const canonical = fromHex(CANONICAL_REQUEST_HEX);
    for (let index = 0; index < canonical.length; index += 1) {
      const corrupted = Uint8Array.from(canonical);
      corrupted[index] = (corrupted[index] as number) ^ 0xff;
      expect(() => decodeIntentRequest(corrupted)).not.toThrow();
    }
  });

  it("refuses a refusal that carries a payload", () => {
    expect(
      refusal(
        decodeIntentResponse(
          response({ status: IntentErrorCode.Expired, payload: new Uint8Array(4) }),
        ),
      ),
    ).toBe(IntentErrorCode.Malformed);
  });
});

describe("field validation fails closed", () => {
  it("refuses a layout control anywhere in rendered text", () => {
    for (const point of [
      " ",
      "\n",
      "",
      "­",
      "؜",
      "​",
      "‏",
      "‮",
      "⁩",
      "﻿",
      "\u{e0041}",
    ]) {
      expect(
        refusal(
          encodeIntentRequest({
            ...canonicalRequest(),
            purpose: `Sign${point} in`,
          }),
        ),
      ).toBe(IntentErrorCode.InvalidValue);
      expect(isForbiddenCodePoint(point.codePointAt(0) as number)).toBe(true);
    }
  });

  it("refuses untrimmed, empty and oversize text", () => {
    for (const purpose of [" a", "a ", "", "a".repeat(256)]) {
      expect(
        refusal(encodeIntentRequest({ ...canonicalRequest(), purpose })),
      ).toBe(IntentErrorCode.InvalidValue);
    }
  });

  it("refuses invalid UTF-8 rather than replacing it", () => {
    // U+FFFD substitution is the failure this guards: an unparseable field
    // must not become a renderable one.
    expect(() => parseVisibleText(Uint8Array.from([0xc3, 0x28]))).toThrow();
  });

  it("refuses a challenge large enough to be a signing oracle", () => {
    expect(
      refusal(
        encodeSignChallengePayload(new Uint8Array(MAX_CHALLENGE_BYTES + 1)),
      ),
    ).toBe(IntentErrorCode.InvalidValue);
    expect(refusal(encodeSignChallengePayload(new Uint8Array(0)))).toBe(
      IntentErrorCode.InvalidValue,
    );
  });

  it("refuses a window longer than the ceiling", () => {
    expect(
      refusal(
        encodeIntentRequest({
          ...canonicalRequest(),
          expiresAtMs: ISSUED_AT_MS + MAX_INTENT_LIFETIME_MS + 1,
        }),
      ),
    ).toBe(IntentErrorCode.InvalidValue);
  });

  it("refuses an inverted window", () => {
    expect(
      refusal(
        encodeIntentRequest({
          ...canonicalRequest(),
          expiresAtMs: ISSUED_AT_MS,
        }),
      ),
    ).toBe(IntentErrorCode.InvalidValue);
  });

  it("escapes rather than emits a layout control when rendering", () => {
    expect(escapeLayoutControls("a‮b")).toBe("a<U+202E>b");
  });
});

describe("the session refuses answers to questions it did not ask", () => {
  it("refuses an unknown identifier", () => {
    const session = createIntentSession();
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    expect(
      refusal(
        session.accept(
          response({ requestId: new Uint8Array(32).fill(0xaa) }),
          ISSUED_AT_MS,
        ),
      ),
    ).toBe(IntentErrorCode.Unsolicited);
  });

  it("refuses the right identifier with the wrong family", () => {
    const session = createIntentSession();
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    expect(
      refusal(
        session.accept(
          response({ intent: IntentFamily.ExecutePayment }),
          ISSUED_AT_MS,
        ),
      ),
    ).toBe(IntentErrorCode.Unsolicited);
  });

  it("accepts a response exactly once", () => {
    const session = createIntentSession();
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    const reply = response({});
    expect(unwrap(session.accept(reply, ISSUED_AT_MS)).intent).toBe(
      IntentFamily.SignChallenge,
    );
    expect(refusal(session.accept(reply, ISSUED_AT_MS))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("refuses a response that arrives after the question expired", () => {
    const session = createIntentSession();
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    expect(refusal(session.accept(response({}), EXPIRES_AT_MS))).toBe(
      IntentErrorCode.Expired,
    );
  });

  it("reports the wallet's refusal as that refusal, and an unknown one as malformed", () => {
    const session = createIntentSession();
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    expect(
      refusal(
        session.accept(
          response({
            status: IntentErrorCode.CallerNotAuthorized,
            payload: new Uint8Array(0),
          }),
          ISSUED_AT_MS,
        ),
      ),
    ).toBe(IntentErrorCode.CallerNotAuthorized);

    const second = createIntentSession();
    unwrap(second.issue(canonicalRequest(), ISSUED_AT_MS));
    expect(
      refusal(
        second.accept(
          response({ status: 60_000, payload: new Uint8Array(0) }),
          ISSUED_AT_MS,
        ),
      ),
    ).toBe(IntentErrorCode.Malformed);
  });

  it("fails closed when full instead of evicting the record it needs", () => {
    const session = createIntentSession(2);
    unwrap(session.issue(canonicalRequest(), ISSUED_AT_MS));
    unwrap(
      session.issue(
        { ...canonicalRequest(), requestId: new Uint8Array(32).fill(0x02) },
        ISSUED_AT_MS,
      ),
    );
    expect(
      refusal(
        session.issue(
          { ...canonicalRequest(), requestId: new Uint8Array(32).fill(0x03) },
          ISSUED_AT_MS,
        ),
      ),
    ).toBe(IntentErrorCode.LedgerFull);
    // The record an attacker wanted pushed out is still there.
    expect(unwrap(session.accept(response({}), ISSUED_AT_MS)).intent).toBe(
      IntentFamily.SignChallenge,
    );
  });

  it("loses every outstanding question when the session is replaced", () => {
    // The `creator-tip.ts` reload property: a fresh session has no memory, so
    // a response that outlives the page that asked for it is unsolicited.
    const first = createIntentSession();
    unwrap(first.issue(canonicalRequest(), ISSUED_AT_MS));
    const reloaded = createIntentSession();
    expect(refusal(reloaded.accept(response({}), ISSUED_AT_MS))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("mints unguessable identifiers", () => {
    const first = toHex(newRequestId());
    const second = toHex(newRequestId());
    expect(first).toHaveLength(64);
    expect(first).not.toBe(second);
  });
});
