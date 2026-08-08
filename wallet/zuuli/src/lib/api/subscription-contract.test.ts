import { describe, expect, it, vi } from "vitest";
import {
  collectSubscriptionPages,
  parseSubscribeResult,
  parseSubscriptionPage,
  parseSubscriptionStatus,
} from "./free2z";

function rawSubscription(username: string) {
  return {
    fan: { username: "viewer" },
    star: { username },
    expires: "2099-01-01T00:00:00Z",
    max_price: "10",
  };
}

function page(
  count: number,
  results: unknown[],
  next: string | null = null,
) {
  return { count, next, previous: null, results };
}

describe("membership pagination contract", () => {
  it("rejects missing or non-array results instead of failing open", () => {
    expect(() =>
      parseSubscriptionPage({ count: 1, next: null, previous: null }),
    ).toThrow("Malformed membership pagination response");
    expect(() =>
      parseSubscriptionPage({
        count: 1,
        next: null,
        previous: null,
        results: {},
      }),
    ).toThrow("Malformed membership pagination response");
  });

  it("collects a complete validated multi-page snapshot", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(
        page(2, [rawSubscription("one")], "/api/tuzis/my-subscriptions?page=2"),
      )
      .mockResolvedValueOnce(page(2, [rawSubscription("two")]));

    await expect(collectSubscriptionPages(load)).resolves.toHaveLength(2);
    expect(load).toHaveBeenNthCalledWith(1, 1, 48);
    expect(load).toHaveBeenNthCalledWith(2, 2, 48);
  });

  it("rejects count drift and duplicates caused by a mutable offset list", async () => {
    const drift = vi
      .fn()
      .mockResolvedValueOnce(
        page(2, [rawSubscription("one")], "/api/tuzis/my-subscriptions?page=2"),
      )
      .mockResolvedValueOnce(page(3, [rawSubscription("two")]));
    await expect(collectSubscriptionPages(drift)).rejects.toThrow(
      "changed during the read",
    );

    const duplicate = vi
      .fn()
      .mockResolvedValueOnce(
        page(2, [rawSubscription("one")], "/api/tuzis/my-subscriptions?page=2"),
      )
      .mockResolvedValueOnce(page(2, [rawSubscription("one")]));
    await expect(collectSubscriptionPages(duplicate)).rejects.toThrow(
      "duplicate row",
    );
  });

  it("rejects incomplete and off-endpoint pagination", async () => {
    await expect(
      collectSubscriptionPages(
        vi.fn().mockResolvedValue(page(2, [rawSubscription("one")])),
      ),
    ).rejects.toThrow("incomplete snapshot");

    await expect(
      collectSubscriptionPages(
        vi
          .fn()
          .mockResolvedValue(
            page(2, [rawSubscription("one")], "/api/other?page=2"),
          ),
      ),
    ).rejects.toThrow("left its endpoint");
  });
});

describe("target membership money contract", () => {
  it("rejects malformed status rather than treating it as nonmember", () => {
    expect(() => parseSubscriptionStatus({ active: false })).toThrow(
      "Malformed membership status response",
    );
    expect(() =>
      parseSubscriptionStatus({
        username: "creator",
        active: false,
        expires: null,
        max_price: null,
      }),
    ).toThrow("current_price");
  });

  it("requires the authoritative balance and full subscription result", () => {
    expect(() =>
      parseSubscribeResult({
        charged: true,
        replayed: false,
        expires: "2099-01-01T00:00:00Z",
        subscription: rawSubscription("creator"),
      }),
    ).toThrow("balance");
  });
});
