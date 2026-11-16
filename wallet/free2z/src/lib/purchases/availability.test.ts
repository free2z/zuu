import { recoverCheckoutReturn, parseCheckoutReturnUrl } from "../checkout/native-return";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ai, comments, e2ee, live, pricing, tuzi } from "../api/free2z";
import { request } from "../api/http";
import { validateStripeCheckoutUrl } from "../api/checkout";
import { consumePaidIntent, preservePaidIntent } from "../auth/paid-intent";
import { runPaidAction } from "../auth/paid-action";
import { mockModels } from "../api/mock-data";
import { digitalPurchasesUnavailable, DigitalPurchaseUnavailableError, isDigitalPurchaseRequest } from "./availability";

const mode = vi.hoisted(() => ({ mock: false }));
vi.mock("../platform", () => ({ isTauri: () => false, useMock: () => mode.mock }));
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("TAURI_ENV_PLATFORM", "android");
  window.fetch = fetcher;
  fetcher.mockReset().mockResolvedValue(new Response('{}'));
  sessionStorage.clear();
  mode.mock = false;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Android production purchase seams", () => {
  const key = "12345678-1234-4234-8234-123456789012";
  it.each([false, true])("refuses every exported purchase API before transport, mock=%s", async (mock) => {
    mode.mock = mock;
    const calls = [
      () => tuzi.buyCheckout(100), () => pricing.quote(100),
      () => tuzi.donate("alice", 1), () => tuzi.donateIdempotent("alice", 1, key),
      () => tuzi.subscribe("alice"), () => tuzi.subscribeConfirmed("alice", key, 1),
      () => ai.prompt({ model: mockModels[0], prompt: "x" }),
      () => ai.conversations.create({ displayName: "x", model: mockModels[0] }),
      () => ai.conversations.sendMessage({ conversationId: "x", userInput: "x", model: mockModels[0] }),
      () => comments.create("zpage", "x", { headline: "x", content: "x", tuzis: 1 }),
      () => comments.createReply("x", { headline: "x", content: "x", tuzis: 1 }),
      () => comments.vote("x", "up"), () => e2ee.chatRequestPrice(),
      () => e2ee.startChatRequest("alice", 1, key),
      () => live.join("alice", "ppv"), () => live.start("ppv"),
      // A stale ticket does not authorize another potentially charging join.
      () => live.refreshParticipant("alice", "ppv", { authToken: "old", meetingId: "x", roomName: "x", as: "participant" }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(DigitalPurchaseUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => validateStripeCheckoutUrl("https://checkout.stripe.com/c/pay")).toThrow(DigitalPurchaseUnavailableError);
  });

  it("also refuses direct requests, absolute URLs, encodings and query bypasses", async () => {
    for (const path of ["/api/tuzis/subscribe/alice?x=1", "https://free2z.cash/api/%74uzis/subscribe/alice", "/api/comments/x/vote/", "/api/ai/conversations/x/promptresponses/", "/api/dyte/alice/ppv/"]) {
      await expect(request(path, { method: "POST" })).rejects.toBeInstanceOf(DigitalPurchaseUnavailableError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves receipt, claim, ledger status, entitlement and cancellation requests", async () => {
    for (const [path, method] of [
      ["/api/stripe/transactions/", "GET"],
      ["/api/stripe/native-return/claim/", "POST"],
      ["/api/stripe/native-return/status/", "POST"],
      ["/api/tuzis/subscription-status/alice", "GET"],
      ["/api/tuzis/my-subscriptions", "GET"],
      ["/api/tuzis/subscribe/alice", "DELETE"],
      ["/api/dyte/alice/subscribers-only", "POST"],
      ["/api/dyte/alice/broadcast", "POST"],
    ] as const) {
      fetcher.mockResolvedValueOnce(new Response('{}'));
      await request(path, { method });
    }
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it.each(["cancel", "processing", "success"] as const)("retains authenticated %s recovery without initiating checkout", async (outcome) => {
    const code = "safe-return-code-123456";
    const token = "safe-status-token-123456";
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(outcome === "cancel"
      ? { outcome, status: "cancelled" }
      : outcome === "processing" ? { outcome, status: "processing" }
      : { outcome, status: "processing", status_token: token })));
    if (outcome === "success") fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: "credited", tuzis_credited: 100 })));
    const result = await recoverCheckoutReturn(code, {
      claim: tuzi.claimCheckoutReturn, status: tuzi.checkoutReturnStatus,
      refreshSession: vi.fn().mockResolvedValue(undefined), navigateToBuy: vi.fn(), wait: vi.fn(),
    });
    expect(result.status).toBe(outcome === "cancel" ? "cancelled" : outcome === "success" ? "credited" : "processing");
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("/api/stripe/native-return/"))).toBe(true);
  });

  it("refuses expired or replay-refused claims without creating a new purchase", async () => {
    fetcher.mockResolvedValueOnce(new Response('{"detail":"Expired claim"}', { status: 403 }));
    await expect(recoverCheckoutReturn("expired-return-code-123456", {
      claim: tuzi.claimCheckoutReturn, status: tuzi.checkoutReturnStatus,
      refreshSession: vi.fn(), navigateToBuy: vi.fn(), wait: vi.fn(),
    })).rejects.toThrow("Expired claim");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(parseCheckoutReturnUrl("cash.free2z.zuuli://checkout/return?code=safe-return-code-123456")).toBeNull();
    expect(parseCheckoutReturnUrl("cash.free2z.free2z://checkout/return?code=safe-return-code-123456&purchase=1")).toBeNull();
  });

  it("destroys stale login intents and never runs a paid action after recovery", async () => {
    sessionStorage.setItem("zuuli.auth.pending-paid-intent", JSON.stringify({ returnTo: "/ai", createdAt: Date.now(), intent: { kind: "ai", draft: "private" } }));
    expect(consumePaidIntent("/ai", "ai")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    preservePaidIntent("/ai", { kind: "ai", draft: "private" });
    expect(sessionStorage.length).toBe(0);
    const action = vi.fn();
    expect(await runPaidAction({ sessionLoading: false, user: null, cost: 1, balance: 100 }, action)).toEqual({ gate: "unavailable" });
    expect(action).not.toHaveBeenCalled();
  });

  it("does not use browser UA, region, balance or login as policy authority", () => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "");
    expect(digitalPurchasesUnavailable()).toBe(false);
    Object.defineProperty(window, "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__", { configurable: true, value: true });
    expect(digitalPurchasesUnavailable()).toBe(true);
    Reflect.deleteProperty(window, "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__");
  });

  it("retains public web and other platform checkout behavior", () => {
    for (const target of ["", "ios", "linux", "windows", "macos"]) {
      vi.stubEnv("TAURI_ENV_PLATFORM", target);
      expect(digitalPurchasesUnavailable()).toBe(false);
      expect(validateStripeCheckoutUrl("https://checkout.stripe.com/c/pay")).toContain("checkout.stripe.com");
    }
  });

  it("has an independent inventory of writes and safe operations", () => {
    expect(isDigitalPurchaseRequest("/api/tuzis/subscribe-confirmed/alice", "POST")).toBe(true);
    expect(isDigitalPurchaseRequest("/api/stripe/native-return/status/", "POST")).toBe(false);
    expect(isDigitalPurchaseRequest("/api/tuzis/subscribe/alice", "DELETE")).toBe(false);
    expect(isDigitalPurchaseRequest("/api/tuzis/subscription-status/%C3%A9lodie", "GET")).toBe(false);
    expect(isDigitalPurchaseRequest("/api/tuzis/subscribe-recovery/1", "POST")).toBe(false);
    expect(isDigitalPurchaseRequest("/api/sdk/v1/purchases/receipt-id", "GET")).toBe(false);
    expect(isDigitalPurchaseRequest("/api/zpage/", "POST")).toBe(false);
    expect(isDigitalPurchaseRequest("/v1/calls/receipt-id", "GET")).toBe(false);
    for (const [path, method] of [
      ["/api/ai/prompt/", "POST"], ["/api/openai/image", "POST"],
      ["/api/zpage/fund/", "POST"], ["/api/zpage/x/vote/", "POST"],
      ["/api/zpage/x/variants/fr/translate/quote/", "GET"],
      ["/api/zpage/x/translations/", "POST"], ["/api/ai/creator-options/", "GET"],
      ["/api/storytime/x/image", "POST"], ["/api/sdk/v1/purchases", "POST"],
      ["/api/sdk/v1/grant", "POST"], ["/api/mcp", "POST"],
      ["https://ai.free2z.cash/v1/chat", "POST"], ["/v1/chat/estimate", "POST"],
      ["/api/economy/usage-purchase-quote/", "GET"], ["/api/economy/usage-purchases/", "POST"],
    ]) expect(isDigitalPurchaseRequest(path, method), path).toBe(true);
  });
});
