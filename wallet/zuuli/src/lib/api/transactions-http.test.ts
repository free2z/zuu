import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});
vi.mock("../platform", () => ({ useMock: () => false }));

import { tuzi } from "./free2z";
import { request } from "./http";
const requestMock = vi.mocked(request);

describe("tuzi.transactions purchase contract", () => {
  beforeEach(() => requestMock.mockReset());
  it("preserves known non-buy and unknown payload kinds and defaults missing kind to buy", async () => {
    requestMock.mockResolvedValue({
      count: 4,
      next: null,
      previous: null,
      results: [
        {
          id: 1,
          amount: 200,
          tuzis_credited: 200,
          timestamp: "2026-01-01",
          kind: "buy",
        },
        {
          id: 2,
          amount: 100,
          tuzis_credited: 100,
          timestamp: "2026-01-02",
          kind: "donate",
        },
        {
          id: 3,
          amount: 75,
          tuzis_credited: 75,
          timestamp: "2026-01-03",
          kind: "future-kind",
        },
        { id: 4, amount: 50, tuzis_credited: 50, timestamp: "2026-01-04" },
      ],
    });
    const transactions = await tuzi.transactions();
    expect(requestMock).toHaveBeenCalledWith("/api/stripe/transactions/");
    expect(transactions.map((transaction) => transaction.kind)).toEqual([
      "buy",
      "donate",
      "future-kind",
      "buy",
    ]);
  });
});
