/**
 * The caller half of the intent bridge, judged the way the wallet half is.
 *
 * Three groups, and the third is the one that matters:
 *
 *   1. **Nothing was relaxed.** Every creator-tip validation that existed
 *      before the amount was collected still refuses the same inputs.
 *   2. **The conversion is exact.** A ZEC string becomes an integer number of
 *      zatoshis and that integer is what the wire carries. The classic bug here
 *      is a factor of 10^8, so the assertion is on the *encoded bytes*, not on
 *      a number that a second code path produced.
 *   3. **A response is hostile until proven otherwise.** It must correlate to
 *      this request, name this family, arrive inside the window, carry status
 *      zero and hold exactly 32 bytes. Every other shape is a refusal, and a
 *      refusal never yields a txid.
 *
 * Responses are assembled here from hex by hand rather than through an encoder
 * this repository owns. That is deliberate and it is `#564`'s rule: an encoder
 * and a decoder that move together stay green through a format break, so the
 * fixture has to be bytes somebody wrote down.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IntentErrorCode,
  IntentFamily,
  MAX_INTENT_LIFETIME_MS,
  decodeIntentRequest,
  encodeExecutePaymentPayload,
  fromHex,
  toHex,
} from "@free2z/wallet-shared";
import {
  CREATOR_TIP_CALLER,
  CREATOR_TIP_EXPECTED_FEE_ZATOSHIS,
  CREATOR_TIP_LIFETIME_MS,
  clearCreatorTipIntents,
  creatorTipFailureName,
  creatorTipPurpose,
  isCreatorTipSource,
  pendingCreatorTipIntents,
  recordCreatorTipIntent,
  requestCreatorTipPayment,
  type CreatorTipIntent,
  type CreatorTipOutcome,
} from "./creator-tip";
import {
  INTENT_TRANSPORT_UNAVAILABLE,
  IntentTransportUnavailableError,
  failClosedIntentTransport,
  installedIntentTransport,
  type IntentTransport,
} from "./intent-transport";
import { MAX_TIP_ZATOSHIS, validateZec } from "../format";

const ADDRESS =
  "u1st8hhxjv6lqzlqzfxqyjfzq7x9gge4kd3fzq8jq9gqz5rq7x9gge4kd3fzq8jq9gqz5r";

const ZOOKO: CreatorTipIntent = {
  username: "zooko",
  label: "Zooko",
  recipient: ADDRESS,
};

// ── Response fixtures ───────────────────────────────────────────────────────

function u16Hex(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function u24Hex(value: number): string {
  return value.toString(16).padStart(6, "0");
}

/**
 * `IntentResponseEnvelope { uint16 version; opaque body<0..2^24-1>; }` over
 * `IntentResponseV1 { opaque request_id[32]; uint16 intent; uint16 status;
 * opaque payload<0..2^24-1>; }`, spelled out.
 */
function responseBytes({
  version = 1,
  requestId,
  intent = IntentFamily.ExecutePayment,
  status = 0,
  payload = new Uint8Array(32),
}: {
  version?: number;
  requestId: Uint8Array;
  intent?: number;
  status?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const body =
    toHex(requestId) +
    u16Hex(intent) +
    u16Hex(status) +
    u24Hex(payload.length) +
    toHex(payload);
  return fromHex(u16Hex(version) + u24Hex(body.length / 2) + body);
}

function txid(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** The identifier this app minted for the request it just handed over. */
function requestIdOf(request: Uint8Array): Uint8Array {
  const decoded = decodeIntentRequest(request);
  if (!decoded.ok) throw new Error(`unencodable request: ${decoded.error}`);
  return decoded.value.requestId;
}

/**
 * `ExecutePaymentRequestV1 { opaque recipient<0..255>; uint64 amount_zatoshis;
 * opaque memo<0..255>; uint64 fee_zatoshis; }`, read back by hand.
 */
function paymentPayload(request: Uint8Array): {
  recipient: string;
  amountZatoshis: bigint;
  memo: string;
  feeZatoshis: bigint;
} {
  const decoded = decodeIntentRequest(request);
  if (!decoded.ok) throw new Error(`unencodable request: ${decoded.error}`);
  const bytes = decoded.value.payload;
  const text = new TextDecoder("utf-8", { fatal: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const recipientLength = bytes[at++] as number;
  const recipient = text.decode(bytes.subarray(at, at + recipientLength));
  at += recipientLength;
  const amountZatoshis = view.getBigUint64(at);
  at += 8;
  const memoLength = bytes[at++] as number;
  const memo = text.decode(bytes.subarray(at, at + memoLength));
  at += memoLength;
  const feeZatoshis = view.getBigUint64(at);
  at += 8;
  expect(at).toBe(bytes.length);
  return { recipient, amountZatoshis, memo, feeZatoshis };
}

/** A transport that records what it was handed and answers with `answer`. */
function replyingTransport(
  answer: (request: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): IntentTransport & { readonly sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    id: "test",
    sent,
    async exchange(request: Uint8Array): Promise<Uint8Array> {
      sent.push(request);
      return answer(request);
    },
  };
}

/** The happy path: an answer correlated to whatever it was just asked. */
function fulfilling(bytes: Uint8Array = txid(0xab)) {
  return replyingTransport((request) =>
    responseBytes({ requestId: requestIdOf(request), payload: bytes }),
  );
}

async function tip(
  amountZatoshis: number,
  transport: IntentTransport,
  now?: number,
): Promise<CreatorTipOutcome> {
  return requestCreatorTipPayment(ZOOKO, amountZatoshis, { transport, now });
}

beforeEach(() => {
  clearCreatorTipIntents();
});

// ── 1. Nothing was relaxed ──────────────────────────────────────────────────

describe("the creator-tip destination validation is unchanged", () => {
  it("accepts a well-formed source", () => {
    expect(isCreatorTipSource(ZOOKO)).toBe(true);
  });

  it.each<[string, CreatorTipIntent]>([
    ["no address at all", { ...ZOOKO, recipient: "" }],
    ["an address with whitespace", { ...ZOOKO, recipient: `${ADDRESS} ` }],
    ["an address split by a space", { ...ZOOKO, recipient: "u1st8 hhxjv" }],
    ["an untrimmed username", { ...ZOOKO, username: " zooko" }],
    ["an untrimmed label", { ...ZOOKO, label: "Zooko " }],
    ["a control character in the label", { ...ZOOKO, label: "Zoo\u0007ko" }],
    ["a DEL in the username", { ...ZOOKO, username: "zoo\u007fko" }],
    ["an empty label", { ...ZOOKO, label: "" }],
    ["an over-long username", { ...ZOOKO, username: "z".repeat(151) }],
    ["an over-long label", { ...ZOOKO, label: "z".repeat(129) }],
    ["an over-long recipient", { ...ZOOKO, recipient: "u".repeat(256) }],
  ])("refuses %s", (_why, source) => {
    expect(isCreatorTipSource(source)).toBe(false);
    expect(() => recordCreatorTipIntent(source)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
    expect(pendingCreatorTipIntents()).toEqual([]);
  });

  it("freezes the snapshot it retains", () => {
    const intent = recordCreatorTipIntent(ZOOKO);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() => {
      (intent as { recipient: string }).recipient = "attacker";
    }).toThrow();
    expect(pendingCreatorTipIntents()[0]?.recipient).toBe(ADDRESS);
  });

  it("keeps at most 32 recorded intents, oldest dropped first", () => {
    for (let index = 0; index < 40; index += 1) {
      recordCreatorTipIntent({ ...ZOOKO, username: `creator${index}` });
    }
    const recorded = pendingCreatorTipIntents();
    expect(recorded).toHaveLength(32);
    expect(recorded[0]?.username).toBe("creator8");
    expect(recorded[31]?.username).toBe("creator39");
  });

  it("still refuses a malformed source when an amount is supplied", async () => {
    await expect(
      requestCreatorTipPayment({ ...ZOOKO, recipient: "" }, 100_000, {
        transport: fulfilling(),
      }),
    ).rejects.toThrow("Creator ZEC tip details are missing or malformed");
  });

  it("never records an intent that failed validation", async () => {
    await expect(
      requestCreatorTipPayment({ ...ZOOKO, label: "" }, 100_000, {
        transport: fulfilling(),
      }),
    ).rejects.toThrow();
    expect(pendingCreatorTipIntents()).toEqual([]);
  });
});

// ── 2. The conversion is exact ──────────────────────────────────────────────

describe("ZEC input becomes an exact number of zatoshis", () => {
  it.each<[string, number]>([
    ["0.00000001", 1],
    ["0.001", 100_000],
    ["0.01", 1_000_000],
    ["0.1", 10_000_000],
    ["1", 100_000_000],
    ["1.5", 150_000_000],
    ["12.34567891", 1_234_567_891],
    ["1000", MAX_TIP_ZATOSHIS],
  ])("converts %s ZEC", (raw, zatoshis) => {
    expect(validateZec(raw)).toEqual({ zatoshis, error: null });
  });

  it.each(["", "0", "0.0", "-1", "abc", "1e3", "1,000", " 1", "1.000000001"])(
    "refuses %s outright rather than rounding it",
    (raw) => {
      expect(validateZec(raw)).toEqual({ zatoshis: null, error: "invalid" });
    },
  );

  it("bounds a tip at 1,000 ZEC", () => {
    expect(validateZec("1000.00000001").error).toBe("tooLarge");
  });

  it("puts that exact integer, and nothing rescaled, on the wire", async () => {
    const transport = fulfilling();
    // Driven from the string a payer would type, so the whole path from the
    // input box to the encoded `uint64` is one assertion.
    const parsed = validateZec("0.5");
    expect(parsed.zatoshis).toBe(50_000_000);
    await tip(parsed.zatoshis as number, transport);

    const payload = paymentPayload(transport.sent[0] as Uint8Array);
    // 0.5 ZEC. A factor-of-ten error anywhere between the input and the wire
    // shows up here as 5_000_000 or 500_000_000.
    expect(payload.amountZatoshis).toBe(50_000_000n);
    expect(payload.recipient).toBe(ADDRESS);
    expect(payload.memo).toBe("");
    expect(payload.feeZatoshis).toBe(CREATOR_TIP_EXPECTED_FEE_ZATOSHIS);
  });

  // ── The positivity rule, pinned where it actually lives ──────────────────
  //
  // `PROTOCOL.md` §3.4 puts "a zero-value payment is not a payment" in the
  // encoder, and `creator-tip.ts` deliberately does not repeat it. These two
  // tests are the reason that is safe: the first drives the encoder guard
  // directly, the second drives the same guard through the caller. Removing
  // `encodeExecutePaymentPayload`'s `amountZatoshis <= 0n` turns BOTH red.

  it.each([0n, -1n, -100_000_000n])(
    "the encoder itself refuses %s zatoshis",
    (amountZatoshis) => {
      const encoded = encodeExecutePaymentPayload({
        recipient: ADDRESS,
        amountZatoshis,
        memo: "",
        feeZatoshis: CREATOR_TIP_EXPECTED_FEE_ZATOSHIS,
      });

      expect(encoded).toEqual({
        ok: false,
        error: IntentErrorCode.InvalidValue,
      });
    },
  );

  it.each([0, -1, -100_000_000])(
    "refuses to build a request for %s zatoshis",
    async (amount) => {
      const transport = fulfilling();
      const outcome = await tip(amount, transport);

      expect(outcome).toEqual({
        kind: "unsendable",
        error: IntentErrorCode.InvalidValue,
      });
      // Refused before the question was ever asked.
      expect(transport.sent).toEqual([]);
    },
  );

  // ── Representability, which is the caller's own rule ─────────────────────
  //
  // `Number.isSafeInteger` is enforced nowhere else. Without it `BigInt(0.5)`
  // throws a `RangeError`, which is not an `IntentRefusal`, so `outcome()`
  // rethrows and the caller gets a rejected promise rather than a refusal it
  // can render. `resolves` is the whole point of the assertion.

  it.each([0.5, -0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, Infinity])(
    "refuses %s zatoshis as a refusal, never as a thrown RangeError",
    async (amount) => {
      const transport = fulfilling();

      await expect(tip(amount, transport)).resolves.toEqual({
        kind: "unsendable",
        error: IntentErrorCode.InvalidValue,
      });
      expect(transport.sent).toEqual([]);
    },
  );
});

describe("the request is the one ZUULI's authority validates", () => {
  it("names this app, this family and a bounded window", async () => {
    const transport = fulfilling();
    const now = 1_700_000_000_000;
    await tip(100_000, transport, now);

    const decoded = decodeIntentRequest(transport.sent[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.intent).toBe(IntentFamily.ExecutePayment);
    expect(decoded.value.caller).toBe(CREATOR_TIP_CALLER);
    expect(decoded.value.caller).toBe("cash.free2z.free2z");
    expect(decoded.value.purpose).toBe(creatorTipPurpose("zooko"));
    expect(decoded.value.issuedAtMs).toBe(now);
    expect(decoded.value.expiresAtMs).toBe(now + CREATOR_TIP_LIFETIME_MS);
    expect(decoded.value.expiresAtMs - decoded.value.issuedAtMs).toBeLessThan(
      MAX_INTENT_LIFETIME_MS,
    );
    expect(decoded.value.requestId).toHaveLength(32);
  });

  it("mints a fresh identifier for every request", async () => {
    const transport = fulfilling();
    await tip(100_000, transport);
    await tip(100_000, transport);

    const first = toHex(requestIdOf(transport.sent[0] as Uint8Array));
    const second = toHex(requestIdOf(transport.sent[1] as Uint8Array));
    expect(first).not.toBe(second);
  });

  it("refuses a purpose that could not survive the bridge's text rule", async () => {
    const transport = fulfilling();
    const outcome = await requestCreatorTipPayment(
      // Accepted by the creator-tip rule (no C0/DEL) and refused by bridge
      // text, which bans the bidirectional overrides outright.
      { ...ZOOKO, username: "zoo\u202eko" },
      100_000,
      { transport },
    );

    expect(outcome).toEqual({
      kind: "unsendable",
      error: IntentErrorCode.InvalidValue,
    });
    expect(transport.sent).toEqual([]);
  });
});

// ── 3. The transport fails closed ───────────────────────────────────────────

describe("the transport seam fails closed", () => {
  it("ships the fail-closed implementation", () => {
    expect(installedIntentTransport).toBe(failClosedIntentTransport);
  });

  it("rejects with a typed error naming the blocking prerequisite", async () => {
    const rejection = failClosedIntentTransport
      .exchange(new Uint8Array([1, 2, 3]))
      .then(
        () => null,
        (error: unknown) => error,
      );
    const error = await rejection;

    expect(error).toBeInstanceOf(IntentTransportUnavailableError);
    expect((error as IntentTransportUnavailableError).code).toBe(
      INTENT_TRANSPORT_UNAVAILABLE,
    );
    expect((error as IntentTransportUnavailableError).reason).toContain("#461");
  });

  it("reports no-transport, and never a txid, by default", async () => {
    const outcome = await requestCreatorTipPayment(ZOOKO, 100_000);

    expect(outcome.kind).toBe("no-transport");
    expect(outcome).not.toHaveProperty("txid");
    if (outcome.kind === "no-transport") {
      expect(creatorTipFailureName(outcome)).toBe(INTENT_TRANSPORT_UNAVAILABLE);
    }
  });

  it("separates a broken channel from an absent one", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport(() => {
        throw new TypeError("network is unreachable");
      }),
    );

    expect(outcome).toEqual({ kind: "transport-failed", detail: "TypeError" });
  });

  it("refuses a transport that answers with something that is not bytes", async () => {
    const outcome = await tip(100_000, {
      id: "liar",
      exchange: async () => "sent!" as unknown as Uint8Array,
    });

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Malformed,
    });
  });
});

// ── 4. A response is hostile until proven otherwise ─────────────────────────

describe("a response is accepted only when it answers this exact request", () => {
  it("returns the txid of a correlated, well-formed fulfilment", async () => {
    const outcome = await tip(100_000, fulfilling(txid(0xab)));

    expect(outcome).toEqual({ kind: "sent", txid: "ab".repeat(32) });
  });

  it("rejects a response addressed to a different request", async () => {
    // A real answer, correlated to a *different* question this app asked.
    const first = fulfilling();
    await tip(100_000, first);
    const foreign = responseBytes({
      requestId: requestIdOf(first.sent[0] as Uint8Array),
      payload: txid(0xcd),
    });

    const outcome = await tip(
      100_000,
      replyingTransport(() => foreign),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Unsolicited,
    });
  });

  it("rejects an identifier that is merely close", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) => {
        const id = requestIdOf(request);
        id[31] = (id[31] as number) ^ 0x01;
        return responseBytes({ requestId: id, payload: txid(0x11) });
      }),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Unsolicited,
    });
  });

  it("rejects an answer naming a different family", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          requestId: requestIdOf(request),
          intent: IntentFamily.SignChallenge,
          payload: txid(0x22),
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Unsolicited,
    });
  });

  it("rejects a protocol version this build does not implement", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          version: 2,
          requestId: requestIdOf(request),
          payload: txid(0x33),
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.UnsupportedVersion,
    });
  });

  it.each([
    ["truncated mid-body", (bytes: Uint8Array) => bytes.subarray(0, 12)],
    ["truncated to nothing", () => new Uint8Array(0)],
    [
      "carrying a trailing byte",
      (bytes: Uint8Array) => Uint8Array.from([...bytes, 0x00]),
    ],
  ])("rejects a payload %s", async (_why, mangle) => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        mangle(
          responseBytes({
            requestId: requestIdOf(request),
            payload: txid(0x44),
          }),
        ),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Malformed,
    });
  });

  it.each([1, 16, 31, 33, 64])(
    "rejects a fulfilment carrying %s txid bytes",
    async (length) => {
      const outcome = await tip(
        100_000,
        replyingTransport((request) =>
          responseBytes({
            requestId: requestIdOf(request),
            payload: new Uint8Array(length).fill(0x55),
          }),
        ),
      );

      expect(outcome).toEqual({
        kind: "refused",
        error: IntentErrorCode.Malformed,
      });
      expect(outcome).not.toHaveProperty("txid");
    },
  );

  /**
   * The single worst outcome this module can produce, so it gets its own test
   * rather than a row in the table above.
   *
   * Relaxing `decodeExecutePaymentResult`'s fixed 32-byte read to a short read
   * turns an empty payload into `{ kind: "sent", txid: "" }`. That is a
   * *correlated* fulfilment carrying no transaction — the UI renders "ZUULI
   * sent your ZEC tip", and a payer has no way to tell it did not happen. An
   * app that has shown "sent" cannot unshow it.
   */
  it("never reports an empty payload as a payment", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          requestId: requestIdOf(request),
          status: 0,
          payload: new Uint8Array(0),
        }),
      ),
    );

    expect(outcome.kind).not.toBe("sent");
    expect(outcome).not.toHaveProperty("txid");
    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Malformed,
    });
  });

  it("never reads a refusal as a success", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          requestId: requestIdOf(request),
          status: IntentErrorCode.NotConfirmed,
          payload: new Uint8Array(0),
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.NotConfirmed,
    });
    expect(outcome).not.toHaveProperty("txid");
    if (outcome.kind === "refused") {
      expect(creatorTipFailureName(outcome)).toBe("INTENT_NOT_CONFIRMED");
    }
  });

  /**
   * `INTENT_UNAVAILABLE` is status 12, defined in both halves by `#914`.
   *
   * `IntentSession.accept` maps an unrecognised status through
   * `intentErrorFromStatus(...) ?? Malformed`, so a client that did not know
   * this status would report the refusal as `INTENT_MALFORMED` — "the wallet's
   * answer was garbage" — when what ZUULI actually said was "I could not
   * complete this, and a transaction may exist locally". Those two are the
   * difference between reassuring a payer and sending them to look at their
   * wallet, so the status is pinned here rather than assumed.
   */
  it("carries INTENT_UNAVAILABLE through as itself, not as a decode failure", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          requestId: requestIdOf(request),
          status: IntentErrorCode.Unavailable,
          payload: new Uint8Array(0),
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Unavailable,
    });
    expect(outcome).not.toHaveProperty("txid");
    if (outcome.kind === "refused") {
      expect(creatorTipFailureName(outcome)).toBe("INTENT_UNAVAILABLE");
    }
  });

  it("rejects a refusal that also carries a payload", async () => {
    const outcome = await tip(
      100_000,
      replyingTransport((request) =>
        responseBytes({
          requestId: requestIdOf(request),
          status: IntentErrorCode.CallerNotAuthorized,
          payload: txid(0x66),
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Malformed,
    });
  });

  it("rejects an answer that arrives after the window closed", async () => {
    const outcome = await tip(
      100_000,
      fulfilling(txid(0x77)),
      Date.now() - CREATOR_TIP_LIFETIME_MS - 1_000,
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Expired,
    });
  });

  it("answers one question once: a replayed response finds nothing pending", async () => {
    const first = fulfilling(txid(0x88));
    const sent = await tip(100_000, first);
    expect(sent.kind).toBe("sent");

    const replayed = responseBytes({
      requestId: requestIdOf(first.sent[0] as Uint8Array),
      payload: txid(0x88),
    });
    const outcome = await tip(
      100_000,
      replyingTransport(() => replayed),
    );

    expect(outcome).toEqual({
      kind: "refused",
      error: IntentErrorCode.Unsolicited,
    });
  });
});

// ─── Ported from #912, preserved verbatim ────────────────────────────────────
//
// `#912` added this suite to `main` after `#920` branched from it, so it never
// existed in this branch's base and arrived as an add/add conflict at rebase.
// It is kept whole rather than merged away: it asserts two properties the
// intent suite above does not — that only the three reviewed fields survive a
// snapshot, and that the length bound is measured in code points rather than
// UTF-16 units.
//
// Its original header: ported from wallet/zuuli/src/lib/wallet/creator-tip.test.ts,
// covering the acceptance bound (150/128/255 code points, trim-equality, no
// control characters, no whitespace in a recipient), the frozen snapshot, and
// the 32-entry cap on the in-memory record.

const SOURCE = {
  username: "ZcashCreator",
  label: "Zcash Creator",
  recipient: "u1exactloadedcreatoraddress",
};

// The module keeps its record in module memory, so every test starts from a
// known-empty one rather than inheriting the previous test's pushes.
afterEach(() => {
  clearCreatorTipIntents();
});

describe("creator ZEC tip intent", () => {
  it("returns an immutable snapshot of the exact creator destination", () => {
    const intent = recordCreatorTipIntent(SOURCE);

    expect(intent).toEqual(SOURCE);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it("carries only the three reviewed fields, dropping anything else", () => {
    const intent = recordCreatorTipIntent({
      ...SOURCE,
      // A caller handing over a whole creator object must not smuggle extra
      // keys into the snapshot that eventually crosses the bridge.
      amountZatoshis: 1,
      memo: "attacker controlled",
    } as unknown as typeof SOURCE);

    expect(Object.keys(intent).sort()).toEqual([
      "label",
      "recipient",
      "username",
    ]);
  });

  it("records each accepted intent, oldest first, and hands back a frozen copy", () => {
    const first = recordCreatorTipIntent(SOURCE);
    const second = recordCreatorTipIntent({ ...SOURCE, username: "Another" });

    const pending = pendingCreatorTipIntents();
    expect(pending).toEqual([first, second]);
    expect(Object.isFrozen(pending)).toBe(true);
  });

  it("never lets the in-memory record grow past 32 entries", () => {
    for (let index = 0; index < 40; index += 1) {
      recordCreatorTipIntent({ ...SOURCE, username: `creator${index}` });
    }

    const pending = pendingCreatorTipIntents();
    expect(pending).toHaveLength(32);
    // The cap drops the oldest, so what survives is the last 32 pushes.
    expect(pending[0].username).toBe("creator8");
    expect(pending[31].username).toBe("creator39");
  });

  it("drops every recorded intent on clear", () => {
    recordCreatorTipIntent(SOURCE);
    clearCreatorTipIntents();

    expect(pendingCreatorTipIntents()).toEqual([]);
  });

  it.each([
    ["a leading space in username", { ...SOURCE, username: " creator" }],
    ["a trailing space in username", { ...SOURCE, username: "creator " }],
    ["an empty label", { ...SOURCE, label: "" }],
    ["an empty username", { ...SOURCE, username: "" }],
    ["an empty recipient", { ...SOURCE, recipient: "" }],
    [
      "a recipient containing whitespace",
      { ...SOURCE, recipient: "u1address with whitespace" },
    ],
    ["a recipient ending in a newline", { ...SOURCE, recipient: "u1address\n" }],
    [
      "a recipient containing a tab",
      { ...SOURCE, recipient: "u1address\taddress" },
    ],
    ["a control character in label", { ...SOURCE, label: "Zcash\u0007Creator" }],
    ["a DEL character in username", { ...SOURCE, username: "creator\u007f" }],
    [
      "a non-string username",
      { ...SOURCE, username: 1 as unknown as string },
    ],
    ["a null recipient", { ...SOURCE, recipient: null as unknown as string }],
    [
      "an undefined label",
      { ...SOURCE, label: undefined as unknown as string },
    ],
  ])("refuses %s before anything is recorded", (_name, source) => {
    expect(isCreatorTipSource(source)).toBe(false);
    expect(() => recordCreatorTipIntent(source)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
    expect(pendingCreatorTipIntents()).toEqual([]);
  });

  // The bounds are the reason this validation exists on a surface that cannot
  // spend: an over-long field is refused in the renderer rather than reaching a
  // signer. Each is asserted at the boundary and one code point past it.
  it.each([
    ["username", 150],
    ["label", 128],
    ["recipient", 255],
  ] as const)("accepts %s at %i code points and refuses one more", (
    field,
    maximum,
  ) => {
    const atBound = { ...SOURCE, [field]: "a".repeat(maximum) };
    const overBound = { ...SOURCE, [field]: "a".repeat(maximum + 1) };

    expect(isCreatorTipSource(atBound)).toBe(true);
    expect(recordCreatorTipIntent(atBound)[field]).toHaveLength(maximum);

    expect(isCreatorTipSource(overBound)).toBe(false);
    expect(() => recordCreatorTipIntent(overBound)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
  });

  // The bound counts code points, not UTF-16 units, so an astral-plane
  // character must not consume two of a creator's 150. `String.length` would
  // report 300 here and reject a name that is 150 characters long.
  it("measures the bound in code points rather than UTF-16 units", () => {
    const astralUsername = "\u{1F600}".repeat(150);
    expect(astralUsername.length).toBe(300);

    expect(isCreatorTipSource({ ...SOURCE, username: astralUsername })).toBe(
      true,
    );
    expect(
      isCreatorTipSource({
        ...SOURCE,
        username: "\u{1F600}".repeat(151),
      }),
    ).toBe(false);
  });
});
