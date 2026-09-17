import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequestResult } from "@/lib/api/chat-request";
import {
  forgetChatRequests,
  rememberChatRequest,
  startedChatRequest,
} from "./chat-request-session";

const result: ChatRequestResult = {
  balance: 1,
  charged: 1,
  replayed: false,
  requestId: "r",
  recipient: { username: "Alice", handle: "alice", handleStatus: "bound" },
};

describe("chat requests remembered for this session", () => {
  afterEach(forgetChatRequests);

  it("remembers a success per viewer and creator, case-insensitively", () => {
    rememberChatRequest("Bob", "Alice", result);
    expect(startedChatRequest("bob", "alice")).toBe(result);
    expect(startedChatRequest("BOB", "ALICE")).toBe(result);
  });

  it("never hands one account's request to another, or to a guest", () => {
    rememberChatRequest("bob", "alice", result);
    expect(startedChatRequest("carol", "alice")).toBeNull();
    expect(startedChatRequest(null, "alice")).toBeNull();
    expect(startedChatRequest("bob", "dave")).toBeNull();
  });
});
