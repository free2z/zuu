// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "@free2z/wallet-shared";
import {
  appLinkIntentTransport,
  deliverInbound,
  inboundAnswer,
  installAppLinkIntentTransport,
  IntentDispatchBusyError,
  IntentResponseTimeoutError,
  resetAppLinkTransportForTests,
} from "./appLinkTransport";
import { intentTransport, resetIntentTransport } from "./transport";

const invoke = vi.fn<(command: string, args: unknown) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));

const ANSWER = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const REQUEST_ID = "07".repeat(32);

function reply(responseHex: string, requestId: string): string {
  return `https://free2z.com/bridge/e2e2z/#res=${responseHex}&rid=${requestId}`;
}

function context(overrides: Partial<{ requestId: string; expiresAtMs: number }> = {}) {
  return {
    family: "issue-device-credential",
    requestId: REQUEST_ID,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  resetAppLinkTransportForTests();
  vi.useRealTimers();
});

describe("the App Link transport", () => {
  it("dispatches the request to the authority's link, in the fragment", async () => {
    const request = new Uint8Array([0x01, 0x02, 0x03]);
    const answered = appLinkIntentTransport.dispatch(request, context());

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("e2e2z_dispatch_intent", {
      args: { request: "010203" },
    });

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(answered).resolves.toEqual(ANSWER);
  });

  it("resolves with the response bytes verbatim, without reading them", async () => {
    // Not a well-formed envelope. The transport must still hand it on: judging
    // it is `IntentSession.accept`'s job, and a transport that rejected what it
    // thought was malformed would be a second implementation of that guard.
    const nonsense = new Uint8Array([0x00, 0xff, 0x00]);
    const answered = appLinkIntentTransport.dispatch(new Uint8Array([1]), context());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    deliverInbound(reply(toHex(nonsense), REQUEST_ID));
    await expect(answered).resolves.toEqual(nonsense);
  });

  it("refuses a second dispatch while one is outstanding", async () => {
    const first = appLinkIntentTransport.dispatch(new Uint8Array([1]), context());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    await expect(
      appLinkIntentTransport.dispatch(new Uint8Array([2]), context()),
    ).rejects.toBeInstanceOf(IntentDispatchBusyError);

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(first).resolves.toEqual(ANSWER);
  });

  it("ignores an answer to a request it is not waiting for", async () => {
    const answered = appLinkIntentTransport.dispatch(new Uint8Array([1]), context());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    let settled = false;
    void answered.then(() => {
      settled = true;
    });

    // A late answer to an abandoned attempt must not resolve this one.
    deliverInbound(reply(toHex(ANSWER), "11".repeat(32)));
    // A macrotask, so every microtask a wrongful resolution would queue has
    // run. A `Promise.race` against an already-resolved promise wins even
    // when this dispatch did resolve, and so proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await expect(answered).resolves.toEqual(ANSWER);
  });

  it("times out on the request's own deadline", async () => {
    vi.useFakeTimers();
    const answered = appLinkIntentTransport.dispatch(
      new Uint8Array([1]),
      context({ expiresAtMs: Date.now() + 1_000 }),
    );
    const assertion = expect(answered).rejects.toBeInstanceOf(
      IntentResponseTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("rejects when the platform refuses to open the link", async () => {
    invoke.mockRejectedValueOnce(new Error("no handler for this link"));
    await expect(
      appLinkIntentTransport.dispatch(new Uint8Array([1]), context()),
    ).rejects.toThrow("no handler for this link");
  });

  it("reports itself available on both halves", () => {
    // `available` is what the enrollment client checks before it samples a
    // device key set. A transport that delivered but could not authenticate
    // its answer would have to report `false`.
    expect(appLinkIntentTransport.available).toBe(true);
    expect(appLinkIntentTransport.id).toBe("app-link");
  });
});

describe("installation", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    resetIntentTransport();
  });

  it("leaves a browser on the fail-closed default", () => {
    // A browser cannot hand a link to a native app, so nothing would ever
    // deliver the answer. Reporting `available` there would make the
    // enrollment client sample a device key set for a request with nowhere to
    // go — #926 checks `available` before sampling for that exact reason.
    installAppLinkIntentTransport();
    expect(intentTransport().id).toBe("unavailable");
    expect(intentTransport().available).toBe(false);
  });

  it("installs the App Link transport in a native runtime", () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
      {};
    installAppLinkIntentTransport();
    expect(intentTransport().id).toBe("app-link");
    expect(intentTransport().available).toBe(true);
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
      `cash.free2z.e2e2z://bridge/return#res=dead&rid=${REQUEST_ID}`,
      `http://free2z.com/bridge/e2e2z/#res=dead&rid=${REQUEST_ID}`,
      // The association is domain-bound; a lookalike owns none of ours.
      `https://free2z.cash/bridge/e2e2z/#res=dead&rid=${REQUEST_ID}`,
      `https://evil.example/bridge/e2e2z/#res=dead&rid=${REQUEST_ID}`,
      // The authority's own prefix is not this app's.
      `https://free2z.com/bridge/zuuli/#res=dead&rid=${REQUEST_ID}`,
      // §4.1: a response payload must never travel in the query component.
      `https://free2z.com/bridge/e2e2z/?res=dead&rid=${REQUEST_ID}`,
      // Present but unusable.
      `https://free2z.com/bridge/e2e2z/#res=dead`,
      `https://free2z.com/bridge/e2e2z/#rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/e2e2z/#res=nothex&rid=${REQUEST_ID}`,
      // A key that merely starts with `res` is not `res`.
      `https://free2z.com/bridge/e2e2z/#resx=dead&rid=${REQUEST_ID}`,
      "https://free2z.com/bridge/e2e2z/",
      "not a url",
    ]) {
      expect(inboundAnswer(refused), refused).toBeNull();
    }
  });
});
