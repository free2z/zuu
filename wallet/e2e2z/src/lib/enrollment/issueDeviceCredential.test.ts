// `issue-device-credential`, from this app's side, judged as if the responder
// were hostile.
//
// Two halves, and the second is the one that would otherwise be written after a
// transport exists — which is to say, after it is expensive to be wrong.
//
//   1. **The shipping build fails closed.** No transport means no dispatch, no
//      device key sample, and never an `EnrollmentStatus`.
//   2. **Response handling is real.** Nothing can deliver a response today, so
//      every one below is hand-assembled from the bytes `PROTOCOL.md` §3
//      specifies, the way an attacker would have to assemble one. Correlation,
//      family, window, status, framing and the credential's own encoding each
//      get a case, and each case is a shape a responder that saw the request
//      could actually send.
//
// The response builder here is a fixture, not a second implementation: it emits
// bytes, it validates nothing, and it exists precisely so the assertions are
// against the shared decoder rather than against an encoder that agrees with it
// by construction. `wallet/zuuli/src/lib/intent-bridge.test.ts` does the same.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTENT_PROTOCOL_VERSION,
  IntentErrorCode,
  IntentFamily,
  MAX_INTENT_LIFETIME_MS,
  decodeIntentRequest,
  toHex,
} from "@free2z/wallet-shared";
import {
  CREDENTIAL_BACKDATE_MS,
  CREDENTIAL_LIFETIME_MS,
  E2E2Z_CALLER,
  ISSUE_DEVICE_CREDENTIAL_PURPOSE,
  IntentRefusedError,
  REQUEST_LIFETIME_MS,
  createDeviceCredentialClient,
  isIntentRefused,
} from "./issueDeviceCredential";
import { DeviceKeysUnavailableError } from "./deviceKeys";
import {
  IntentTransportUnavailableError,
  isIntentTransportUnavailable,
  resetIntentTransport,
  type IntentDispatchContext,
  type IntentTransport,
} from "./transport";

const NOW = 1_700_000_000_000;
const DEVICE_PK = new Uint8Array(32).fill(0x11);
const DEVICE_KEM_PK = new Uint8Array(1216).fill(0x22);
const CREDENTIAL = new Uint8Array(96).fill(0x33);

const keys = () =>
  Promise.resolve({
    devicePublicKey: DEVICE_PK,
    deviceKemPublicKey: DEVICE_KEM_PK,
  });

/** Big-endian, the only endianness the format has. */
function be(value: number, width: number): number[] {
  const out: number[] = [];
  for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) {
    out.push((value >>> shift) & 0xff);
  }
  return out;
}

/** `struct { opaque credential<0..2^24-1>; } IssueDeviceCredentialResultV1`. */
function credentialResult(credential: Uint8Array): Uint8Array {
  return Uint8Array.from([...be(credential.length, 3), ...credential]);
}

/**
 * A response envelope, assembled byte by byte with no validation whatsoever.
 *
 * Every field is overridable because every field is somewhere an attacker can
 * lie.
 */
function responseBytes(options: {
  version?: number;
  requestId: Uint8Array;
  intent?: number;
  status?: number;
  payload?: Uint8Array;
  /** Appended after the envelope, to model a padded or spliced frame. */
  trailer?: Uint8Array;
}): Uint8Array {
  const payload = options.payload ?? credentialResult(CREDENTIAL);
  const body = [
    ...options.requestId,
    ...be(options.intent ?? IntentFamily.IssueDeviceCredential, 2),
    ...be(options.status ?? 0, 2),
    ...be(payload.length, 3),
    ...payload,
  ];
  return Uint8Array.from([
    ...be(options.version ?? INTENT_PROTOCOL_VERSION, 2),
    ...be(body.length, 3),
    ...body,
    ...(options.trailer ?? []),
  ]);
}

/**
 * A stand-in for the wallet authority.
 *
 * It is `available: true`, which no shipping transport is, and it records what
 * it was handed so the *request* can be judged as well as the answer. `answer`
 * receives the request identifier the client actually generated, because a
 * responder that saw the request knows it — that is exactly the adversary
 * `PROTOCOL.md` §6 says correlation does not exclude.
 */
function walletStandIn(
  answer: (requestId: Uint8Array, request: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): IntentTransport & { readonly sent: Uint8Array[]; readonly contexts: IntentDispatchContext[] } {
  const sent: Uint8Array[] = [];
  const contexts: IntentDispatchContext[] = [];
  return {
    id: "wallet-stand-in",
    available: true,
    sent,
    contexts,
    async dispatch(request, context) {
      sent.push(request);
      contexts.push(context);
      const decoded = decodeIntentRequest(request);
      if (!decoded.ok) throw new Error("the stand-in was handed an undecodable request");
      return answer(decoded.value.requestId, request);
    },
  };
}

function clientWith(transport: IntentTransport, now: () => number = () => NOW) {
  return createDeviceCredentialClient({
    transport: () => transport,
    readKeys: keys,
    now,
  });
}

/** The refusal code, or a failure that says what happened instead. */
async function refusalCode(promise: Promise<unknown>): Promise<IntentErrorCode> {
  const caught = await promise.then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  if (caught.resolved) {
    throw new Error(`expected a refusal, resolved with ${String(caught.value)}`);
  }
  if (!isIntentRefused(caught.error)) {
    throw new Error(`expected an IntentRefusedError, got ${String(caught.error)}`);
  }
  return (caught.error as IntentRefusedError).code;
}

afterEach(() => {
  resetIntentTransport();
  vi.restoreAllMocks();
});

describe("the shipping build fails closed", () => {
  it("refuses before it samples a device key set", async () => {
    const readKeys = vi.fn(keys);
    // No `transport` override: this is the module registry, in the state every
    // packaged build ships it in.
    const client = createDeviceCredentialClient({ readKeys, now: () => NOW });

    await expect(client.requestDeviceCredential("alice")).rejects.toBeInstanceOf(
      IntentTransportUnavailableError,
    );
    // `prepare_device` replaces this device's pending key set and discards the
    // previous secrets. Sampling one for a request that cannot leave the
    // process would throw key material away for nothing.
    expect(readKeys).not.toHaveBeenCalled();
    expect(client.pending).toBe(0);
  });

  it("never resolves, however the call is shaped", async () => {
    const client = createDeviceCredentialClient({ readKeys: keys, now: () => NOW });
    for (const handle of ["alice", "bob", "a".repeat(30)]) {
      const settled = await client.requestDeviceCredential(handle).then(
        (value) => ({ resolved: true as const, value }),
        () => ({ resolved: false as const }),
      );
      expect(settled.resolved).toBe(false);
    }
  });

  it("names the transport gap rather than blaming the wallet", async () => {
    const client = createDeviceCredentialClient({ readKeys: keys, now: () => NOW });
    const refusal = await client
      .requestDeviceCredential("alice")
      .catch((cause: unknown) => cause);
    expect(isIntentTransportUnavailable(refusal)).toBe(true);
    expect((refusal as IntentTransportUnavailableError).blockedOn).toBe(461);
  });
});

describe("the request this app builds", () => {
  it("is the structure the wallet parses, with the fields #905 specifies", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    await clientWith(transport).requestDeviceCredential("alice");

    expect(transport.sent).toHaveLength(1);
    const decoded = decodeIntentRequest(transport.sent[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const request = decoded.value;

    expect(request.intent).toBe(IntentFamily.IssueDeviceCredential);
    expect(request.caller).toBe(E2E2Z_CALLER);
    expect(request.purpose).toBe(ISSUE_DEVICE_CREDENTIAL_PURPOSE);
    expect(request.issuedAtMs).toBe(NOW);
    expect(request.expiresAtMs).toBe(NOW + REQUEST_LIFETIME_MS);
    expect(request.requestId).toHaveLength(32);

    // §3.3's payload: handle, device_pk[32], device_kem_pk<0..2^24-1>,
    // not_before_ms, not_after_ms. Asserted as bytes, because the point of the
    // shared encoder is that these are the bytes the wallet's digest covers.
    const notBefore = NOW - CREDENTIAL_BACKDATE_MS;
    const notAfter = NOW + CREDENTIAL_LIFETIME_MS;
    expect(toHex(request.payload)).toBe(
      "05" +
        toHex(new TextEncoder().encode("alice")) +
        toHex(DEVICE_PK) +
        "0004c0" +
        toHex(DEVICE_KEM_PK) +
        BigInt(notBefore).toString(16).padStart(16, "0") +
        BigInt(notAfter).toString(16).padStart(16, "0"),
    );
  });

  it("declares a window inside the protocol's ceiling", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    await clientWith(transport).requestDeviceCredential("alice");
    const decoded = decodeIntentRequest(transport.sent[0] as Uint8Array);
    if (!decoded.ok) throw new Error("the request must decode");
    const lifetime = decoded.value.expiresAtMs - decoded.value.issuedAtMs;
    expect(lifetime).toBeGreaterThan(0);
    // "Nothing here is a continuous grant" (#904), enforced on the *declared*
    // window so it binds even when the verifying clock is wrong.
    expect(lifetime).toBeLessThanOrEqual(MAX_INTENT_LIFETIME_MS);
  });

  it("carries a fresh identifier every time", async () => {
    const seen = new Set<string>();
    const transport = walletStandIn((requestId) => {
      seen.add(toHex(requestId));
      return responseBytes({ requestId });
    });
    const client = clientWith(transport);
    for (let index = 0; index < 8; index += 1) {
      await client.requestDeviceCredential("alice");
    }
    expect(seen.size).toBe(8);
  });

  it("refuses a handle carrying a bidirectional override, before dispatch", async () => {
    // `PROTOCOL.md` §3.5: bridge text is refused outright rather than escaped,
    // because it is written by this app to appear inside ZUULI's confirmation.
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("ali‮ce"))).toBe(
      IntentErrorCode.InvalidValue,
    );
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses an empty handle, before dispatch", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    expect(await refusalCode(clientWith(transport).requestDeviceCredential(""))).toBe(
      IntentErrorCode.InvalidValue,
    );
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses unusable device keys without asking the wallet anything", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    const client = createDeviceCredentialClient({
      transport: () => transport,
      now: () => NOW,
      readKeys: async () => ({
        devicePublicKey: new Uint8Array(31).fill(0x11),
        deviceKemPublicKey: DEVICE_KEM_PK,
      }),
    });
    // Not a protocol refusal: the wrong side was wrong, and saying
    // INTENT_INVALID_VALUE would point a reader at the wallet.
    await expect(client.requestDeviceCredential("alice")).rejects.toBeInstanceOf(Error);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("a response is judged as if the responder were hostile", () => {
  it("accepts the one well-formed answer to the question it asked", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId }));
    const credential = await clientWith(transport).requestDeviceCredential("alice");
    expect(toHex(credential)).toBe(toHex(CREDENTIAL));
    // What this proves: the responder saw the request. What it does not prove:
    // that the responder was ZUULI. CALLER-AUTHENTICATION.md §5 — there is no
    // signature over responses, and correlation is not authentication.
  });

  it("refuses an answer to a different request", async () => {
    const transport = walletStandIn(() =>
      responseBytes({ requestId: new Uint8Array(32).fill(0xaa) }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("refuses an answer whose identifier differs in one byte", async () => {
    const transport = walletStandIn((requestId) => {
      const near = Uint8Array.from(requestId);
      near[31] = ((near[31] as number) ^ 0x01) & 0xff;
      return responseBytes({ requestId: near });
    });
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("refuses a correlated answer that echoes a different family", async () => {
    // The dangerous shape: right identifier, wrong family. Accepting it would
    // route a `sign-challenge` result into a credential.
    const transport = walletStandIn((requestId) =>
      responseBytes({
        requestId,
        intent: IntentFamily.SignChallenge,
        payload: credentialResult(CREDENTIAL),
      }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("refuses a version it does not implement, before reading the body", async () => {
    const transport = walletStandIn((requestId) => responseBytes({ requestId, version: 2 }));
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.UnsupportedVersion,
    );
  });

  it("refuses a truncated envelope rather than reading plausible zeroes", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId }).subarray(0, 20),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses trailing bytes after a complete envelope", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId, trailer: Uint8Array.from([0x00]) }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses an empty response", async () => {
    const transport = walletStandIn(() => new Uint8Array(0));
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses a family payload with a truncated credential length", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId, payload: Uint8Array.from([0x00, 0x00, 0x40, 0x33]) }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses a family payload with bytes after the credential", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({
        requestId,
        payload: Uint8Array.from([...credentialResult(CREDENTIAL), 0x00]),
      }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses a zero-length credential, which frames perfectly and is not one", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId, payload: credentialResult(new Uint8Array(0)) }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.InvalidValue,
    );
  });

  it("never mistakes a refusal for a success", async () => {
    for (const status of [
      IntentErrorCode.CallerNotAuthorized,
      IntentErrorCode.NotConfirmed,
      IntentErrorCode.Expired,
      IntentErrorCode.Replay,
    ]) {
      const transport = walletStandIn((requestId) =>
        // §3.4: a refusal carries an empty payload.
        responseBytes({ requestId, status, payload: new Uint8Array(0) }),
      );
      expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
        status,
      );
    }
  });

  it("refuses a refusal that also carries a payload", async () => {
    // A payload beside a non-zero status is a channel with no defined meaning —
    // and the concrete hazard is a client that reads the payload anyway and
    // installs a credential the wallet said it was refusing.
    const transport = walletStandIn((requestId) =>
      responseBytes({
        requestId,
        status: IntentErrorCode.NotConfirmed,
        payload: credentialResult(CREDENTIAL),
      }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses an unknown refusal status rather than guessing", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId, status: 4242, payload: new Uint8Array(0) }),
    );
    expect(await refusalCode(clientWith(transport).requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Malformed,
    );
  });

  it("refuses a replay of an answer it already accepted", async () => {
    let first: Uint8Array | null = null;
    const transport = walletStandIn((requestId) => {
      // The second call replays the FIRST response verbatim — the shape a
      // recorded deep link has.
      if (first === null) first = responseBytes({ requestId });
      return first;
    });
    const client = clientWith(transport);
    await expect(client.requestDeviceCredential("alice")).resolves.toBeInstanceOf(Uint8Array);
    expect(await refusalCode(client.requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Unsolicited,
    );
  });

  it("refuses an answer that arrives after the window closed", async () => {
    let clock = NOW;
    const transport = walletStandIn((requestId) => {
      clock = NOW + REQUEST_LIFETIME_MS + 1;
      return responseBytes({ requestId });
    });
    const client = clientWith(transport, () => clock);
    expect(await refusalCode(client.requestDeviceCredential("alice"))).toBe(
      IntentErrorCode.Expired,
    );
  });

  it("consumes the outstanding question whether the answer is accepted or refused", async () => {
    const transport = walletStandIn((requestId) =>
      responseBytes({ requestId, intent: IntentFamily.ExecutePayment }),
    );
    const client = clientWith(transport);
    await client.requestDeviceCredential("alice").catch(() => undefined);
    // Nothing outstanding: a second delivery of the same bytes finds no
    // question, which is what makes a recorded response worthless.
    expect(client.pending).toBe(0);
  });

  it("does not launder a transport that resolves with a non-response", async () => {
    const transport: IntentTransport = {
      id: "broken",
      available: true,
      dispatch: async () => "definitely bytes" as unknown as Uint8Array,
    };
    await expect(
      clientWith(transport).requestDeviceCredential("alice"),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("propagates a transport rejection unchanged", async () => {
    const failure = new Error("the link was never opened");
    const transport: IntentTransport = {
      id: "failing",
      available: true,
      dispatch: () => Promise.reject(failure),
    };
    await expect(clientWith(transport).requestDeviceCredential("alice")).rejects.toBe(
      failure,
    );
  });
});

describe("the refusal type", () => {
  it("says which side was wrong", () => {
    expect(new IntentRefusedError("request", IntentErrorCode.InvalidValue).stage).toBe(
      "request",
    );
    expect(String(new IntentRefusedError("response", IntentErrorCode.Unsolicited))).toContain(
      "INTENT_UNSOLICITED",
    );
  });

  it("is recognizable after losing its prototype", () => {
    expect(isIntentRefused({ reason: "intent-refused" })).toBe(true);
    expect(isIntentRefused(new DeviceKeysUnavailableError("nope"))).toBe(false);
  });
});
