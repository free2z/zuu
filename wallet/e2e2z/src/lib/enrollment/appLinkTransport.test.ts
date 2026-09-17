// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "@free2z/wallet-shared";
import {
  appLinkIntentTransport,
  AuthorityLinkError,
  deliverInbound,
  inboundAnswer,
  installAppLinkIntentTransport,
  IntentDispatchBusyError,
  IntentDispatchCancelledError,
  IntentResponseTimeoutError,
  REPLY_PATH,
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
    const refusal = appLinkIntentTransport.dispatch(new Uint8Array([1]), context());
    await expect(refusal).rejects.toThrow("no handler for this link");
    // Typed, so the screen can say "ZUULI didn't open" rather than "something
    // broke" — and a bare §8 code string is carried, not flattened.
    await expect(refusal).rejects.toBeInstanceOf(AuthorityLinkError);
  });

  it("stops waiting when cancelled, and ignores the answer that follows", async () => {
    const answered = appLinkIntentTransport.dispatch(new Uint8Array([1]), context());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    appLinkIntentTransport.cancel?.();
    await expect(answered).rejects.toBeInstanceOf(IntentDispatchCancelledError);

    // The answer to the cancelled request arrives after all. Nothing is waiting
    // for it, so it resolves nothing — including a later dispatch.
    const next = appLinkIntentTransport.dispatch(
      new Uint8Array([2]),
      context({ requestId: "22".repeat(32) }),
    );
    let settled = false;
    void next.then(
      () => (settled = true),
      () => (settled = true),
    );
    deliverInbound(reply(toHex(ANSWER), REQUEST_ID));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    deliverInbound(reply(toHex(ANSWER), "22".repeat(32)));
    await expect(next).resolves.toEqual(ANSWER);
  });

  it("treats cancel with nothing outstanding as a no-op", () => {
    expect(() => appLinkIntentTransport.cancel?.()).not.toThrow();
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
    // A phone's browser is still a browser.
    installAppLinkIntentTransport(IPHONE);
    expect(intentTransport().id).toBe("unavailable");
    expect(intentTransport().available).toBe(false);
  });

  const IPHONE = {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    maxTouchPoints: 5,
  };
  const ANDROID = {
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
  };
  const IPADOS = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    maxTouchPoints: 5,
  };
  const MAC = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    maxTouchPoints: 0,
  };
  const LINUX = {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
  };

  function nativeRuntime(): void {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
      {};
  }

  it.each([
    ["iPhone", IPHONE],
    ["Android", ANDROID],
    ["iPadOS, which reports a desktop user agent", IPADOS],
  ])("installs the App Link transport on %s", (_name, runtime) => {
    nativeRuntime();
    installAppLinkIntentTransport(runtime);
    expect(intentTransport().id).toBe("app-link");
    expect(intentTransport().available).toBe(true);
  });

  // #1019 review: `tauri.conf.json` declares the association under
  // `plugins.deep-link.mobile` only. On a desktop the authority's link opens a
  // browser and the answer has no way back, so the transport must not claim
  // to be available there — the screen would otherwise start a two-minute
  // wait that can only end in "expired".
  it.each([
    ["macOS", MAC],
    ["Linux", LINUX],
  ])("leaves a %s desktop build on the fail-closed default", (_name, runtime) => {
    nativeRuntime();
    installAppLinkIntentTransport(runtime);
    expect(intentTransport().id).toBe("unavailable");
    expect(intentTransport().available).toBe(false);
  });
});

describe("an inbound link", () => {
  it("is answered on exactly the path ZUULI's registry names", () => {
    // `wallet/zuuli/src-tauri/src/bridge.rs`: reply_to for cash.free2z.e2e2z.
    expect(REPLY_PATH).toBe("/bridge/e2e2z/");
  });

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
      // Other routes under this app's prefix are not replies (#1022): the chat
      // link lives at /bridge/e2e2z/chat/, and a reply shaped like one must
      // not be read as one, nor the other way round.
      `https://free2z.com/bridge/e2e2z/chat/#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/e2e2z/anything#res=dead&rid=${REQUEST_ID}`,
      `https://free2z.com/bridge/e2e2z#res=dead&rid=${REQUEST_ID}`,
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
