import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCreditedCardPurchase,
  parseCardPurchase,
  pendingCardPurchase,
} from "./card-purchase";

const quote = () => ({
  id: "cs_test_exact399",
  url: "https://checkout.stripe.com/c/pay/cs_test_exact399",
  expires_at: 2000000000,
  status_token: "signed-status-token-399",
  quote: {
    checkout_intent_id: "85ac5ed2-2bce-4c30-9eb9-bae78ce21fd1",
    tuzis: 2000,
    amount_cents: 2200,
    currency: "usd",
    pricing_version: "card-v3",
  },
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
describe("exact server card order", () => {
  it("keeps charged cents and exact quantity without inverse arithmetic", () => {
    expect(parseCardPurchase(quote(), 2000).quote).toEqual(quote().quote);
    const small = quote();
    small.quote.tuzis = 1;
    small.quote.amount_cents = 51;
    expect(parseCardPurchase(small, 1).quote.tuzis).toBe(1);
  });
  it.each(["id", "url", "expires_at", "status_token", "quote"])(
    "rejects missing %s",
    (key) => {
      const p = quote();
      delete (p as unknown as Record<string, unknown>)[key];
      expect(() => parseCardPurchase(p, 2000)).toThrow();
    },
  );
  it.each([
    ["tuzis", 1999],
    ["tuzis", 1.5],
    ["amount_cents", 0],
    ["amount_cents", true],
    ["amount_cents", Number.MAX_SAFE_INTEGER + 1],
    ["currency", "eur"],
    ["pricing_version", ""],
    ["checkout_intent_id", "forged"],
  ])("rejects invalid quote %s=%s", (key, value) => {
    const p = quote();
    (p.quote as Record<string, unknown>)[key as string] = value;
    expect(() => parseCardPurchase(p, 2000)).toThrow();
  });
  it("rejects an untrusted external checkout", () => {
    expect(() =>
      parseCardPurchase({ ...quote(), url: "https://evil.example/pay" }, 2000),
    ).toThrow();
  });
});

describe("original purchase retry identity", () => {
  it("survives restart, repeat activation and changed selection without replacing the original", () => {
    const first = pendingCardPurchase(1, 2000, "web");
    expect(pendingCardPurchase(1, 1, "zuuli_mobile")).toEqual(first);
    expect(JSON.parse(localStorage.getItem("zuuli.card-purchase.1")!)).toEqual(
      first,
    );
    expect(pendingCardPurchase(2, 2000, "web").key).not.toBe(first.key);
  });
  it("only clears the matching original after an authoritative receipt", () => {
    const first = pendingCardPurchase(1, 2000, "web");
    clearCreditedCardPurchase({ ...first, key: crypto.randomUUID() });
    expect(pendingCardPurchase(1, 1, "web")).toEqual(first);
    clearCreditedCardPurchase(first);
    expect(pendingCardPurchase(1, 1, "web").key).not.toBe(first.key);
  });
  it("fails closed on corrupt stored identity instead of charging with a fresh key", () => {
    localStorage.setItem(
      "zuuli.card-purchase.1",
      JSON.stringify({ actorId: 2 }),
    );
    expect(() => pendingCardPurchase(1, 2000, "web")).toThrow();
    expect(localStorage.getItem("zuuli.card-purchase.1")).toBe(
      JSON.stringify({ actorId: 2 }),
    );
  });
});
