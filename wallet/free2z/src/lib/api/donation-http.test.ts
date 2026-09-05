import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { tuzi } from "./free2z";
import { request } from "./http";

const requestMock = vi.mocked(request);
const donationKey = "00000000-0000-4000-8000-000000000000";

describe("tuzi.donateIdempotent HTTP contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("uses only the explicit safe route, key header, and reviewed amount", async () => {
    requestMock.mockResolvedValue({
      balance: "900.500",
      charged: "100.000",
      replayed: false,
    });

    await expect(
      tuzi.donateIdempotent("alice/example", 100, donationKey),
    ).resolves.toEqual({ balance: 900.5, charged: 100, replayed: false });

    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledWith(
      "/api/tuzis/donate-idempotent/alice%2Fexample",
      {
        method: "POST",
        body: { amount: 100 },
        headers: { "Idempotency-Key": donationKey },
      },
    );
    expect(requestMock.mock.calls[0]?.[0]).not.toBe(
      "/api/tuzis/donate/alice/example",
    );
  });

  it("rejects a response that cannot authoritatively reconcile the charge", async () => {
    requestMock.mockResolvedValue({
      balance: "900",
      charged: "101",
      replayed: false,
    });
    await expect(
      tuzi.donateIdempotent("alice", 100, donationKey),
    ).rejects.toThrow("Donation response charge does not match");
  });

  it("does not contact the server with a malformed idempotency key", async () => {
    await expect(
      tuzi.donateIdempotent("alice", 100, "not-a-key"),
    ).rejects.toThrow("Donation idempotency key is invalid");
    expect(requestMock).not.toHaveBeenCalled();
  });
});
