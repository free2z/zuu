import { describe, expect, it } from "vitest";
import {
  ChatRequestContractError,
  canReceiveChatRequest,
  chatRequestErrorCode,
  chatRequestRoute,
  classifyChatRequestFailure,
  isMessagingHandle,
  normalizeChatRequestPrice,
  normalizeChatRequestResult,
} from "./chat-request";
import { ApiError } from "./http";

function response(overrides: Record<string, unknown> = {}) {
  return {
    balance: "41.500",
    charged: 1,
    replayed: false,
    request_id: "req_123",
    recipient: { username: "Alice", handle: "alice", handle_status: "bound" },
    ...overrides,
  };
}

describe("messaging handles (Contract B pattern)", () => {
  it.each(["a", "alice", "alice_42", "a".repeat(30), "0"])("accepts %s", (h) => {
    expect(isMessagingHandle(h)).toBe(true);
  });

  it.each([
    "",
    "Alice",
    "a".repeat(31),
    "al-ice",
    "al.ice",
    "alice&x=1",
    "alice#x",
    "alice\n",
    " alice",
    "ａlice",
    null,
    42,
  ])("refuses %j", (h) => {
    expect(isMessagingHandle(h)).toBe(false);
  });
});

describe("normalizeChatRequestPrice", () => {
  it("reads a positive whole price, as a number or a whole decimal string", () => {
    expect(normalizeChatRequestPrice({ cost: 1 })).toBe(1);
    expect(normalizeChatRequestPrice({ cost: "3.000" })).toBe(3);
  });

  it.each([{ cost: 0 }, { cost: -1 }, { cost: 1.5 }, { cost: "1.5" }, {}, null, [1]])(
    "refuses %j",
    (value) => {
      expect(() => normalizeChatRequestPrice(value)).toThrow(
        ChatRequestContractError,
      );
    },
  );
});

describe("normalizeChatRequestResult", () => {
  it("accepts the Contract A success shape", () => {
    expect(normalizeChatRequestResult(response(), 1, "alice")).toEqual({
      balance: 41.5,
      charged: 1,
      replayed: false,
      requestId: "req_123",
      recipient: { username: "Alice", handle: "alice", handleStatus: "bound" },
    });
  });

  it("accepts the real backend's decimal-string balance and charge", () => {
    expect(
      normalizeChatRequestResult(
        response({ balance: "9.000", charged: "1.000" }),
        1,
        "alice",
      ),
    ).toMatchObject({ balance: 9, charged: 1 });
    expect(
      normalizeChatRequestResult(
        response({ balance: "0.250", charged: "3.000" }),
        3,
        "alice",
      ),
    ).toMatchObject({ balance: 0.25, charged: 3 });
  });

  it.each(["1.500", "1.001", "2.000", "0.000", "1e0", " 1.000", "1,000", ""])(
    "refuses the decimal-string charge %j for a 1 2Z request",
    (charged) => {
      expect(() =>
        normalizeChatRequestResult(response({ charged }), 1, "alice"),
      ).toThrow(ChatRequestContractError);
    },
  );

  it("refuses a charge different from the cost the payer was shown", () => {
    expect(() =>
      normalizeChatRequestResult(response({ charged: 2 }), 1, "alice"),
    ).toThrow("Chat request charge does not match");
    expect(() =>
      normalizeChatRequestResult(response({ charged: 0 }), 1, "alice"),
    ).toThrow("Chat request charge does not match");
  });

  it("refuses a charge recorded against somebody else", () => {
    expect(() => normalizeChatRequestResult(response(), 1, "bob")).toThrow(
      "Chat request recipient does not match",
    );
  });

  it.each([
    ["balance", { balance: "-1" }],
    ["balance precision", { balance: "1.0001" }],
    ["replayed", { replayed: "false" }],
    ["request id", { request_id: "" }],
    ["long request id", { request_id: "x".repeat(129) }],
    ["recipient", { recipient: null }],
    [
      "handle status",
      { recipient: { username: "alice", handle: "alice", handle_status: "ok" } },
    ],
  ])("refuses an invalid %s", (_label, overrides) => {
    expect(() =>
      normalizeChatRequestResult(response(overrides), 1, "alice"),
    ).toThrow(ChatRequestContractError);
  });

  it("reads unclaimed recipients as having no handle, whatever was sent", () => {
    expect(
      normalizeChatRequestResult(
        response({
          recipient: { username: "alice", handle: "alice", handle_status: "unclaimed" },
        }),
        1,
        "alice",
      ).recipient,
    ).toEqual({ username: "alice", handle: null, handleStatus: "unclaimed" });
  });

  it("never lets a malformed handle become a link, even when marked bound", () => {
    for (const handle of [null, "Alice", "a/b", "x".repeat(31), "a#b"]) {
      expect(
        normalizeChatRequestResult(
          response({
            recipient: { username: "alice", handle, handle_status: "bound" },
          }),
          1,
          "alice",
        ).recipient,
      ).toEqual({ username: "alice", handle: null, handleStatus: "unclaimed" });
    }
  });

  it("keeps a replay flag so a retry is visibly the same request", () => {
    expect(
      normalizeChatRequestResult(response({ replayed: true }), 1, "alice")
        .replayed,
    ).toBe(true);
  });
});

describe("classifyChatRequestFailure", () => {
  it("maps each Contract A status", () => {
    expect(
      classifyChatRequestFailure(new ApiError(402, "x", { balance: "0.250" })),
    ).toEqual({ kind: "insufficient", balance: 0.25 });
    expect(classifyChatRequestFailure(new ApiError(402, "x"))).toEqual({
      kind: "insufficient",
      balance: null,
    });
    expect(classifyChatRequestFailure(new ApiError(404, "x"))).toEqual({
      kind: "not-found",
    });
    expect(classifyChatRequestFailure(new ApiError(409, "x"))).toEqual({
      kind: "self",
    });
    expect(
      classifyChatRequestFailure(
        new ApiError(409, "x", { code: "price_changed", cost: "2.000" }),
      ),
    ).toEqual({ kind: "price-changed" });
    expect(
      classifyChatRequestFailure(
        new ApiError(409, "x", { code: "cannot_message_self" }),
      ),
    ).toEqual({ kind: "self" });
    expect(
      classifyChatRequestFailure(
        new ApiError(422, "x", {
          code: "sender_handle_unavailable",
          detail: "Claim a messaging handle first.",
        }),
      ),
    ).toEqual({ kind: "sender-handle-unavailable" });
    expect(
      classifyChatRequestFailure(new ApiError(422, "x", { code: "other" })),
    ).toEqual({ kind: "refused", status: 422 });
    expect(classifyChatRequestFailure(new ApiError(405, "x"))).toEqual({
      kind: "refused",
      status: 405,
    });
    expect(classifyChatRequestFailure(new ApiError(429, "x"))).toEqual({
      kind: "rate-limited",
    });
    expect(classifyChatRequestFailure(new ApiError(401, "x"))).toEqual({
      kind: "signed-out",
    });
    expect(classifyChatRequestFailure(new ApiError(403, "x"))).toEqual({
      kind: "signed-out",
    });
    expect(classifyChatRequestFailure(new ApiError(400, "x"))).toEqual({
      kind: "refused",
      status: 400,
    });
  });

  it("treats every answer it cannot trust as uncertain, never as a refusal", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      new DOMException("timed out", "TimeoutError"),
      new ApiError(500, "x"),
      new ApiError(502, "x"),
      new ApiError(504, "x"),
      "string",
      undefined,
    ]) {
      expect(classifyChatRequestFailure(error)).toEqual({ kind: "uncertain" });
    }
  });

  it("treats a response that does not match the request as a mismatch", () => {
    expect(
      classifyChatRequestFailure(new ChatRequestContractError("x")),
    ).toEqual({ kind: "mismatch" });
  });
});

describe("chatRequestErrorCode", () => {
  it("reads a top-level or DRF-nested code string", () => {
    expect(chatRequestErrorCode({ code: "price_changed" })).toBe("price_changed");
    expect(
      chatRequestErrorCode({ detail: { code: "sender_handle_unavailable" } }),
    ).toBe("sender_handle_unavailable");
  });

  it.each([
    null,
    undefined,
    "price_changed",
    ["price_changed"],
    { code: 409 },
    { code: ["price_changed"] },
    { detail: "price_changed" },
    { detail: ["price_changed"] },
    { error: { code: "price_changed" } },
  ])("finds no code in %j", (body) => {
    expect(chatRequestErrorCode(body)).toBeNull();
  });

  it("does not mistake a malformed 409 or 422 for a certain refusal", () => {
    expect(
      classifyChatRequestFailure(new ApiError(409, "x", "price_changed")),
    ).toEqual({ kind: "self" });
    expect(
      classifyChatRequestFailure(
        new ApiError(422, "x", ["sender_handle_unavailable"]),
      ),
    ).toEqual({ kind: "refused", status: 422 });
  });
});

describe("canReceiveChatRequest", () => {
  it("excludes only the username that collides with the price route", () => {
    expect(canReceiveChatRequest("price")).toBe(false);
    expect(canReceiveChatRequest("Price")).toBe(false);
    expect(canReceiveChatRequest("prices")).toBe(true);
    expect(canReceiveChatRequest("alice")).toBe(true);
  });
});

describe("chatRequestRoute", () => {
  it("encodes the username as one path segment", () => {
    expect(chatRequestRoute("alice/../x")).toBe(
      "/api/e2ee/chat-requests/alice%2F..%2Fx/",
    );
  });
});
