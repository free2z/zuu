import { beforeEach, describe, expect, it, vi } from "vitest";
import { tuzi } from "./free2z";
import { request } from "./http";

vi.mock("@/lib/platform", () => ({
  useMock: () => false,
  isTauri: () => false,
}));
vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  request: vi.fn(),
}));
const pending = {
  actorId: 7,
  key: "25a31209-32ee-4eea-a7df-082bc120b151",
  quantity: 2000,
  returnMode: "web" as const,
};
const response = () => ({
  id: "cs_test_contract399",
  url: "https://checkout.stripe.com/c/pay/cs_test_contract399#opaque",
  expires_at: 2000000000,
  status_token: "signed-status-token-399",
  quote: {
    checkout_intent_id: pending.key,
    tuzis: 2000,
    amount_cents: 2200,
    currency: "usd",
    pricing_version: "card-v3",
  },
});
beforeEach(() => vi.mocked(request).mockReset());
describe("native wire contract with the public Django checkout", () => {
  it("retains retry identity, owner, quantity, charge and original Session", async () => {
    vi.mocked(request).mockResolvedValue(response());
    expect(await tuzi.buyCheckout(2000, "web", pending)).toEqual(response());
    expect(await tuzi.buyCheckout(2000, "web", pending)).toEqual(response());
    for (const call of vi.mocked(request).mock.calls) {
      expect(call[0]).toBe("/api/stripe/create-checkout-session/");
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: { "Idempotency-Key": pending.key },
        body: {
          quantity: 2000,
          currentPath: "/wallet/fund",
          returnMode: "web",
          expected_actor_id: 7,
        },
      });
    }
  });
  it("refuses a legacy URL-only response before any browser handoff", async () => {
    vi.mocked(request).mockResolvedValue({ url: response().url });
    await expect(tuzi.buyCheckout(2000, "web", pending)).rejects.toThrow();
  });
  it("does not create a checkout without a saved purchase identity", async () => {
    await expect(tuzi.buyCheckout(2000)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
