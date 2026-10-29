/**
 * The App Link transport, and the whole creator tip carried over it.
 *
 * `openUrl` and `onOpenUrl` cannot be provoked from a unit test, so the link
 * this app would open is captured from the `openUrl` mock and ZUULI's answer is
 * handed to `deliverInbound`, the function `onOpenUrl`'s callback calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntentFamily,
  decodeIntentRequest,
  fromHex,
  toHex,
} from "@free2z/wallet-shared";

const mocks = vi.hoisted(() => ({
  isTauri: false,
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  onOpenUrl: vi.fn<(handler: (urls: string[]) => void) => Promise<void>>(),
}));

vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/platform")>()),
  isTauri: () => mocks.isTauri,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: mocks.onOpenUrl,
}));

import {
  AUTHORITY_BRIDGE_URL,
  AuthorityLinkError,
  IntentExchangeBusyError,
  IntentResponseTimeoutError,
  appLinkIntentTransport,
  authorityLink,
  deliverInbound,
  inboundAnswer,
  listenForAuthorityAnswers,
  resetAppLinkTransportForTests,
} from "./appLinkTransport";
import {
  IntentTransportUnavailableError,
  failClosedIntentTransport,
  installedIntentTransport,
} from "./intent-transport";
import {
  clearCreatorTipIntents,
  requestCreatorTipPayment,
  type CreatorTipIntent,
} from "./creator-tip";

const IPHONE = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
  maxTouchPoints: 5,
};
const ANDROID = {
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36",
  maxTouchPoints: 5,
};
const MAC = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
  maxTouchPoints: 0,
};

const REQUEST_ID = "07".repeat(32);
const ANSWER = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

function reply(responseHex: string, requestId: string): string {
  return `https://free2z.com/bridge/free2z/#res=${responseHex}&rid=${requestId}`;
}

function context(overrides: Partial<{ requestId: string; expiresAtMs: number }> = {}) {
  return {
    family: "execute-payment",
    requestId: REQUEST_ID,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

/** Wait a macrotask, so every microtask a wrongful settlement would queue has run. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mocks.isTauri = false;
  mocks.openUrl.mockReset();
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.onOpenUrl.mockReset();
  mocks.onOpenUrl.mockResolvedValue(undefined);
  clearCreatorTipIntents();
});

afterEach(() => {
  resetAppLinkTransportForTests();
  vi.useRealTimers();
});

describe("the outbound link", () => {
  it("goes to ZUULI's bridge, with the request in the fragment only", () => {
    const link = new URL(authorityLink(new Uint8Array([0x01, 0x02, 0xab])));
    expect(`${link.origin}${link.pathname}`).toBe(AUTHORITY_BRIDGE_URL);
    expect(link.search).toBe("");
    expect(link.hash).toBe("#req=0102ab");
  });

  it("is what an exchange hands to the operating system", async () => {
    const answered = appLinkIntentTransport.exchange(
      new Uint8Array([0x01, 0x02, 0x03]),
      context(),
    );
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledTimes(1));
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://free2z.com/bridge/zuuli/#req=010203",
    );

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(answered).resolves.toEqual(ANSWER);
  });
});

describe("an exchange", () => {
  it("resolves with the response bytes verbatim, without reading them", async () => {
    // Not a well-formed envelope. Judging it is `IntentSession.accept`'s job,
    // and a transport that refused what it thought was malformed would be a
    // second implementation of that guard.
    const nonsense = new Uint8Array([0x00, 0xff, 0x00]);
    const answered = appLinkIntentTransport.exchange(new Uint8Array([1]), context());
    deliverInbound(reply(toHex(nonsense), REQUEST_ID));
    await expect(answered).resolves.toEqual(nonsense);
  });

  it("ignores an answer to a request it is not waiting for", async () => {
    const answered = appLinkIntentTransport.exchange(new Uint8Array([1]), context());
    let settled = false;
    void answered.then(
      () => (settled = true),
      () => (settled = true),
    );

    // A late answer to an abandoned exchange must not resolve this one.
    deliverInbound(reply(toHex(ANSWER), "11".repeat(32)));
    await macrotask();
    expect(settled).toBe(false);

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(answered).resolves.toEqual(ANSWER);
  });

  it("ignores an answer when nothing is waiting", async () => {
    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    // A later exchange with the same identifier is not pre-answered by it.
    const answered = appLinkIntentTransport.exchange(new Uint8Array([1]), context());
    let settled = false;
    void answered.then(
      () => (settled = true),
      () => (settled = true),
    );
    await macrotask();
    expect(settled).toBe(false);
  });

  it("refuses a second exchange while one is outstanding", async () => {
    const first = appLinkIntentTransport.exchange(new Uint8Array([1]), context());
    await expect(
      appLinkIntentTransport.exchange(new Uint8Array([2]), context()),
    ).rejects.toBeInstanceOf(IntentExchangeBusyError);
    // Only the first request left the process.
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(first).resolves.toEqual(ANSWER);
  });

  it("times out on the request's own deadline, and says so as 'unknown'", async () => {
    vi.useFakeTimers();
    const answered = appLinkIntentTransport.exchange(
      new Uint8Array([1]),
      context({ expiresAtMs: Date.now() + 1_000 }),
    );
    const assertion = expect(answered).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IntentResponseTimeoutError &&
        // "No channel" would be rendered as "nothing was sent". After the link
        // opened, that may be false: ZUULI may have paid.
        !(error instanceof IntentTransportUnavailableError),
    );
    await vi.advanceTimersByTimeAsync(999);
    deliverInbound(reply(toHex(ANSWER), "11".repeat(32)));
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it("rejects, as a broken channel, when the platform will not open the link", async () => {
    mocks.openUrl.mockRejectedValueOnce(new Error("no handler for this link"));
    const error = await appLinkIntentTransport
      .exchange(new Uint8Array([1]), context())
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );
    expect(error).toBeInstanceOf(AuthorityLinkError);
    expect(error).not.toBeInstanceOf(IntentTransportUnavailableError);
    expect((error as Error).message).toContain("no handler for this link");
  });
});

describe("an inbound link", () => {
  it("is read only from a verified reply to this app", () => {
    expect(inboundAnswer(reply("dead", REQUEST_ID))).toEqual({
      response: new Uint8Array([0xde, 0xad]),
      requestId: REQUEST_ID,
    });
  });

  it("is refused on every condition the association rests on", () => {
    for (const refused of [
      // A custom scheme authenticates nobody: any app can register one.
      `cash.free2z.free2z://bridge/return#res=dead&rid=${REQUEST_ID}`,
      `http://free2z.com/bridge/free2z/#res=dead&rid=${REQUEST_ID}`,
      // The association is bound to one host; a lookalike owns none of it.
      `https://free2z.cash/bridge/free2z/#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com.evil.example/bridge/free2z/#res=dead&rid=${REQUEST_ID}`,
      // Other apps' prefixes, and routes that merely start with this one.
      `https://free2z.com/bridge/zuuli/#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/e2e2z/#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/free2z/other/#res=dead&rid=${REQUEST_ID}`,
      // Resolved before it is matched: these name ZUULI's path, not ours.
      `https://free2z.com/bridge/free2z/../zuuli/#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/free2z/%2e%2e/zuuli/#res=dead&rid=${REQUEST_ID}`,
      // §4.1: a response must never travel in the query, even beside a
      // well-formed fragment.
      `https://free2z.com/bridge/free2z/?res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/free2z/?x=1#res=dead&rid=${REQUEST_ID}`,
      // Present but unusable.
      "https://free2z.com/bridge/free2z/#res=dead",
      `https://free2z.com/bridge/free2z/#rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/free2z/#res=nothex&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/free2z/#res=DEAD&rid=${REQUEST_ID}`,
      // A key that merely starts with `res` is not `res`.
      `https://free2z.com/bridge/free2z/#resx=dead&rid=${REQUEST_ID}`,
      "https://free2z.com/bridge/free2z/",
      "not a url",
    ]) {
      expect(inboundAnswer(refused), refused).toBeNull();
    }
  });
});

describe("the transport this runtime gets", () => {
  it("is the refusal in a browser", () => {
    mocks.isTauri = false;
    expect(installedIntentTransport(IPHONE)).toBe(failClosedIntentTransport);
  });

  it("is the refusal in a desktop build, which has no App Link association", () => {
    mocks.isTauri = true;
    expect(installedIntentTransport(MAC)).toBe(failClosedIntentTransport);
  });

  it("is the App Link on iOS and Android", () => {
    mocks.isTauri = true;
    expect(installedIntentTransport(IPHONE)).toBe(appLinkIntentTransport);
    expect(installedIntentTransport(ANDROID)).toBe(appLinkIntentTransport);
  });

  it("listens for answers only where it can send", async () => {
    mocks.isTauri = false;
    listenForAuthorityAnswers(IPHONE);
    mocks.isTauri = true;
    listenForAuthorityAnswers(MAC);
    await macrotask();
    expect(mocks.onOpenUrl).not.toHaveBeenCalled();

    listenForAuthorityAnswers(ANDROID);
    await vi.waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalledTimes(1));

    // The registered handler is the one that settles an exchange.
    const handler = mocks.onOpenUrl.mock.calls[0]?.[0];
    const answered = appLinkIntentTransport.exchange(new Uint8Array([1]), context());
    handler?.([reply(toHex(ANSWER), REQUEST_ID)]);
    await expect(answered).resolves.toEqual(ANSWER);
  });
});

// ── The whole tip, over this transport ─────────────────────────────────────

const ZOOKO: CreatorTipIntent = {
  username: "zooko",
  label: "Zooko",
  recipient:
    "u1st8hhxjv6lqzlqzfxqyjfzq7x9gge4kd3fzq8jq9gqz5rq7x9gge4kd3fzq8jq9gqz5r",
};

/**
 * ZUULI's answer, written out by hand rather than through an encoder this
 * repository owns (#564): `IntentResponseEnvelope { uint16 version; opaque
 * body<0..2^24-1>; }` over `IntentResponseV1 { opaque request_id[32]; uint16
 * intent; uint16 status; opaque payload<0..2^24-1>; }`, carrying a 32-byte txid.
 */
function fulfilment(requestIdHex: string, txidByte: number): string {
  const payload = txidByte.toString(16).padStart(2, "0").repeat(32);
  const body =
    requestIdHex +
    IntentFamily.ExecutePayment.toString(16).padStart(4, "0") +
    "0000" +
    (32).toString(16).padStart(6, "0") +
    payload;
  return "0001" + (body.length / 2).toString(16).padStart(6, "0") + body;
}

/** The identifier inside the request this app opened ZUULI with. */
function openedRequestId(): string {
  const calls = mocks.openUrl.mock.calls;
  const opened = calls[calls.length - 1]?.[0];
  if (!opened) throw new Error("no link was opened");
  const requestHex = new URL(opened).hash.slice("#req=".length);
  const decoded = decodeIntentRequest(fromHex(requestHex));
  if (!decoded.ok) throw new Error(`the opened request does not decode: ${decoded.error}`);
  return toHex(decoded.value.requestId);
}

describe("a creator tip over the App Link", () => {
  it("is sent when ZUULI answers the request it was given", async () => {
    const outcome = requestCreatorTipPayment(ZOOKO, 100_000, {
      transport: appLinkIntentTransport,
    });
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledTimes(1));
    const requestId = openedRequestId();

    deliverInbound(reply(fulfilment(requestId, 0xab), requestId));

    await expect(outcome).resolves.toEqual({ kind: "sent", txid: "ab".repeat(32) });
  });

  it("hands the transport the request's own identifier and deadline", async () => {
    const exchange = vi.spyOn(appLinkIntentTransport, "exchange");
    const now = Date.now();
    const outcome = requestCreatorTipPayment(ZOOKO, 100_000, {
      transport: appLinkIntentTransport,
      now,
    });
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledTimes(1));
    const requestId = openedRequestId();

    expect(exchange).toHaveBeenCalledWith(expect.any(Uint8Array), {
      family: "execute-payment",
      requestId,
      expiresAtMs: now + 120_000,
    });

    deliverInbound(reply(fulfilment(requestId, 0x01), requestId));
    await outcome;
    exchange.mockRestore();
  });

  it("is 'unknown', never 'not sent', when ZUULI does not answer in time", async () => {
    vi.useFakeTimers();
    const outcome = requestCreatorTipPayment(ZOOKO, 100_000, {
      transport: appLinkIntentTransport,
    });
    await vi.advanceTimersByTimeAsync(120_001);

    await expect(outcome).resolves.toEqual({
      kind: "transport-failed",
      detail: "IntentResponseTimeoutError",
    });
  });

  it("is refused when the answer names a different request", async () => {
    const outcome = requestCreatorTipPayment(ZOOKO, 100_000, {
      transport: appLinkIntentTransport,
    });
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledTimes(1));
    const requestId = openedRequestId();

    // Correlated at the transport, but the envelope inside answers another
    // question: `IntentSession.accept` is still the judge of the bytes.
    deliverInbound(reply(fulfilment("22".repeat(32), 0xab), requestId));

    const result = await outcome;
    expect(result.kind).toBe("refused");
    expect(result).not.toHaveProperty("txid");
  });
});
