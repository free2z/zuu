import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { e2ee } from "./free2z";
import { ApiError, request } from "./http";
import { classifyChatRequestFailure } from "./chat-request";

const requestMock = vi.mocked(request);
const key = "00000000-0000-4000-8000-000000000000";

// The real backend's shapes: decimal strings for money.
const success = {
  balance: "9.000",
  charged: "1.000",
  replayed: false,
  request_id: "r1",
  recipient: { username: "alice", handle: "alice", handle_status: "bound" },
};

describe("e2ee chat request HTTP contract (Contract A)", () => {
  // Braces matter: `mockReset()` returns the mock, and a function returned from
  // `beforeEach` is run as teardown — which would call a rejecting mock.
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("reads the server-set price from the price route", async () => {
    requestMock.mockResolvedValue({ cost: 1 });
    await expect(e2ee.chatRequestPrice()).resolves.toBe(1);
    expect(requestMock).toHaveBeenCalledWith("/api/e2ee/chat-requests/price/", {
      signal: undefined,
    });
  });

  it("posts only the shown cost as expected_cost, with the key header", async () => {
    requestMock.mockResolvedValue(success);
    await expect(e2ee.startChatRequest("alice", 1, key)).resolves.toMatchObject({
      balance: 9,
      charged: 1,
      recipient: { handle: "alice", handleStatus: "bound" },
    });
    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledWith("/api/e2ee/chat-requests/alice/", {
      method: "POST",
      body: { expected_cost: 1 },
      headers: { "Idempotency-Key": key },
    });
  });

  it("refuses a charge that differs from the cost it showed", async () => {
    requestMock.mockResolvedValue({ ...success, charged: "5.000" });
    const failure = await e2ee
      .startChatRequest("alice", 1, key)
      .catch((error: unknown) => error);
    expect(classifyChatRequestFailure(failure)).toEqual({ kind: "mismatch" });
  });

  it("does not contact the server with a malformed idempotency key", async () => {
    await expect(e2ee.startChatRequest("alice", 1, "nope")).rejects.toThrow(
      "Chat request idempotency key is invalid",
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("carries the authoritative balance out of a 402", async () => {
    const refusal = new ApiError(402, "Not enough 2Zs.", { balance: "0.000" });
    requestMock.mockRejectedValue(refusal);
    await expect(e2ee.startChatRequest("alice", 1, key)).rejects.toBe(refusal);
    expect(classifyChatRequestFailure(refusal)).toEqual({
      kind: "insufficient",
      balance: 0,
    });
  });

  it("reads a price_changed 409 as a refusal to re-confirm", async () => {
    const refusal = new ApiError(409, "The price changed.", {
      code: "price_changed",
    });
    requestMock.mockRejectedValue(refusal);
    await expect(e2ee.startChatRequest("alice", 1, key)).rejects.toBe(refusal);
    expect(classifyChatRequestFailure(refusal)).toEqual({
      kind: "price-changed",
    });
  });

  it("reads a sender_handle_unavailable 422 as its own outcome", async () => {
    const refusal = new ApiError(422, "Claim a handle.", {
      code: "sender_handle_unavailable",
    });
    requestMock.mockRejectedValue(refusal);
    await expect(e2ee.startChatRequest("alice", 1, key)).rejects.toBe(refusal);
    expect(classifyChatRequestFailure(refusal)).toEqual({
      kind: "sender-handle-unavailable",
    });
  });
});
