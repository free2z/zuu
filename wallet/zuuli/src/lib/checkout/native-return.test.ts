import { beforeEach, describe, expect, it, vi } from "vitest";

const deepLink = vi.hoisted(() => ({
  current: null as string[] | null,
  callback: null as ((urls: string[]) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("@/lib/oauth/transport", () => ({
  isMobileTauri: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(async () => deepLink.current),
  onOpenUrl: vi.fn(async (callback: (urls: string[]) => void) => {
    deepLink.callback = callback;
    return deepLink.unlisten;
  }),
}));

import {
  CHECKOUT_RETURN_URI,
  listenForCheckoutReturns,
  parseCheckoutPaymentStatus,
  parseCheckoutReturnClaim,
  parseCheckoutReturnUrl,
  recoverCheckoutReturn,
} from "./native-return";

const CODE = ".eJyrVkrLz1eyUkpKLFKqBQA6WQZK:1rabcD:Abc_def-1234567890";

beforeEach(() => {
  deepLink.current = null;
  deepLink.callback = null;
  deepLink.unlisten.mockReset();
});

describe("native Checkout deep-link parser", () => {
  it("accepts only the exact registered route with one opaque code", () => {
    expect(parseCheckoutReturnUrl(`${CHECKOUT_RETURN_URI}?code=${CODE}`)).toBe(
      CODE,
    );
  });

  it.each([
    `https://free2z.cash/checkout/return?code=${CODE}`,
    `cash.free2z.zuuli://oauth/callback?code=${CODE}`,
    `cash.free2z.zuuli://checkout/other?code=${CODE}`,
    `cash.free2z.zuuli://checkout/return%2F?code=${CODE}`,
    `cash.free2z.zuuli://user@checkout/return?code=${CODE}`,
    `cash.free2z.zuuli://checkout/return?code=${CODE}#fragment`,
    `cash.free2z.zuuli://checkout/return?code=${CODE}&next=https://evil.example`,
    `cash.free2z.zuuli://checkout/return?code=${CODE}&code=${CODE}`,
    `cash.free2z.zuuli://checkout/return?code=short`,
    `cash.free2z.zuuli://checkout/return?code=${"a".repeat(2049)}`,
    `cash.free2z.zuuli://checkout/return?code=signed%2Fclaim%3Ainvalid`,
    `cash.free2z.zuuli://checkout/return?code=signed%20claim%3Ainvalid`,
  ])("rejects a near-miss callback: %s", (value) => {
    expect(parseCheckoutReturnUrl(value)).toBeNull();
  });
});

describe("native Checkout response contracts", () => {
  it("strictly parses cancel and success claims", () => {
    expect(
      parseCheckoutReturnClaim({ outcome: "cancel", status: "cancelled" }),
    ).toEqual({
      outcome: "cancel",
      status: "cancelled",
    });
    expect(
      parseCheckoutReturnClaim({
        outcome: "success",
        status: "processing",
        status_token: "s".repeat(20),
      }),
    ).toEqual({
      outcome: "success",
      status: "processing",
      statusToken: "s".repeat(20),
    });
  });

  it.each([
    null,
    { outcome: "success", status: "credited", status_token: "x".repeat(20) },
    { outcome: "success", status: "processing" },
    { outcome: "cancel", status: "cancelled", status_token: "extra" },
    { outcome: "unknown", status: "cancelled" },
  ])("fails closed for malformed claims: %j", (value) => {
    expect(() => parseCheckoutReturnClaim(value)).toThrow(
      "malformed checkout claim",
    );
  });

  it("accepts only processing or a positive authoritative credit", () => {
    expect(parseCheckoutPaymentStatus({ status: "processing" })).toEqual({
      status: "processing",
    });
    expect(
      parseCheckoutPaymentStatus({ status: "credited", tuzis_credited: 100 }),
    ).toEqual({ status: "credited", tuzisCredited: 100 });
    expect(() =>
      parseCheckoutPaymentStatus({ status: "credited", tuzis_credited: 0 }),
    ).toThrow("malformed checkout status");
    expect(() =>
      parseCheckoutPaymentStatus({ status: "processing", redirect: "evil" }),
    ).toThrow("malformed checkout status");
  });
});

describe("native Checkout recovery", () => {
  it("reports cancellation without querying payment status", async () => {
    const dependencies = {
      claim: vi
        .fn()
        .mockResolvedValue({ outcome: "cancel", status: "cancelled" }),
      status: vi.fn(),
      refreshSession: vi.fn().mockResolvedValue(undefined),
      navigateToBuy: vi.fn(),
      wait: vi.fn(),
    };
    await expect(recoverCheckoutReturn(CODE, dependencies)).resolves.toEqual({
      status: "cancelled",
    });
    expect(dependencies.navigateToBuy).toHaveBeenCalledOnce();
    expect(dependencies.refreshSession).toHaveBeenCalledOnce();
    expect(dependencies.status).not.toHaveBeenCalled();
  });

  it("waits for webhook-authoritative credit and refreshes the final balance", async () => {
    const dependencies = {
      claim: vi.fn().mockResolvedValue({
        outcome: "success",
        status: "processing",
        statusToken: "status-token",
      }),
      status: vi
        .fn()
        .mockResolvedValueOnce({ status: "processing" })
        .mockResolvedValueOnce({ status: "credited", tuzisCredited: 250 }),
      refreshSession: vi.fn().mockResolvedValue(undefined),
      navigateToBuy: vi.fn(),
      wait: vi.fn().mockResolvedValue(undefined),
    };
    await expect(recoverCheckoutReturn(CODE, dependencies)).resolves.toEqual({
      status: "credited",
      tuzisCredited: 250,
    });
    expect(dependencies.status).toHaveBeenCalledTimes(2);
    expect(dependencies.refreshSession).toHaveBeenCalledTimes(2);
    expect(dependencies.wait).toHaveBeenCalledWith(750);
  });

  it("stays processing when the verified webhook has not landed", async () => {
    const dependencies = {
      claim: vi.fn().mockResolvedValue({
        outcome: "success",
        status: "processing",
        statusToken: "status-token",
      }),
      status: vi.fn().mockResolvedValue({ status: "processing" }),
      refreshSession: vi.fn().mockResolvedValue(undefined),
      navigateToBuy: vi.fn(),
      wait: vi.fn().mockResolvedValue(undefined),
    };
    await expect(recoverCheckoutReturn(CODE, dependencies)).resolves.toEqual({
      status: "processing",
    });
    expect(dependencies.status).toHaveBeenCalledTimes(4);
    expect(dependencies.refreshSession).toHaveBeenCalledOnce();
  });
});

describe("cold and warm native delivery", () => {
  it("delivers getCurrent and onOpenUrl once per claim code", async () => {
    deepLink.current = [`${CHECKOUT_RETURN_URI}?code=${CODE}`];
    const deliver = vi.fn().mockResolvedValue(undefined);
    const stop = await listenForCheckoutReturns(deliver);
    expect(deliver).toHaveBeenCalledWith(CODE);

    deepLink.callback?.([`${CHECKOUT_RETURN_URI}?code=${CODE}`]);
    deepLink.callback?.([
      `${CHECKOUT_RETURN_URI}?code=${"b".repeat(32)}:stamp:signature`,
      `cash.free2z.zuuli://oauth/callback?code=${"c".repeat(43)}`,
    ]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith(
      `${"b".repeat(32)}:stamp:signature`,
    );
    stop();
    expect(deepLink.unlisten).toHaveBeenCalledOnce();
  });
});
