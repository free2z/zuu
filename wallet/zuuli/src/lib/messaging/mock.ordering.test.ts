// The mock owes an ordered page, and owes it without implementing the order.
//
// CLIENT-CONTRACT.md §7's 2026-08-25 correction moved display order out of the
// UI: `list_messages` returns `MessagePage.messages` already in §7's order and
// the transcript renders the sequence as given. A mock stands in for the
// **engine**, so the same obligation lands on it — and §9 rule 10 forbids it
// from meeting the obligation by sorting, because a topological pass in
// TypeScript is the second implementation ADR 0001 exists to prevent.
//
// It meets it structurally instead: the mock only ever appends causally, so its
// `Map` iteration order is already a linear extension of the DAG. These tests
// are what makes that a property rather than a comment — if someone adds a mock
// path that inserts a message before its parent, they fail here.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockMessaging, resetMockMessaging } from "./mock";
import type { Message } from "./types";

const CONVERSATION_ID = "conv-echo";
const SCENARIO_KEY = "zuuli.mock.f2zmsg-scenario";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

function useScenario(name: string | null): void {
  if (name === null) store.delete(SCENARIO_KEY);
  else store.set(SCENARIO_KEY, name);
  resetMockMessaging();
}

/**
 * §7's causal requirement, checked over a page: every parent that is present in
 * the page appears before its child. A parent that is absent imposes no
 * constraint — that is a gap, reported separately (§3.5), never inferred from
 * the order.
 */
function assertCausallyOrdered(messages: Message[]): void {
  const seen = new Set<string>();
  const present = new Set(messages.map((m) => m.msgId));
  for (const message of messages) {
    for (const parent of message.parents) {
      if (!present.has(parent)) continue;
      expect(
        seen.has(parent),
        `${message.msgId} rendered above its parent ${parent}`,
      ).toBe(true);
    }
    seen.add(message.msgId);
  }
}

beforeEach(() => useScenario(null));
afterEach(() => resetMockMessaging());

describe("the mock returns a page already in §7's order", () => {
  it("puts the seeded reply below the message it answers", async () => {
    // The zuu#733 counterexample, shipped as the default fixture: same epoch,
    // and the replier holds the LOWER leaf index. A sort by
    // `(epoch, senderLeafIndex, msgId)` alone reverses these two.
    const page = await mockMessaging.listMessages(CONVERSATION_ID, 50);
    const ids = page.messages.map((m) => m.msgId);
    expect(ids).toEqual(["aa01", "aa0b"]);

    const [parent, reply] = page.messages;
    expect(reply.parents).toEqual([parent.msgId]);
    expect(reply.epoch).toBe(parent.epoch);
    expect(reply.senderLeafIndex).toBeLessThan(parent.senderLeafIndex);
    assertCausallyOrdered(page.messages);
  });

  it("keeps the echo peer's traffic causally ordered", async () => {
    vi.useFakeTimers();
    try {
      await mockMessaging.sendMessage(CONVERSATION_ID, "hi", "ref-order");
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }

    const page = await mockMessaging.listMessages(CONVERSATION_ID, 50);
    expect(page.messages.length).toBeGreaterThan(2);
    assertCausallyOrdered(page.messages);

    // The echo reply references the message it answers, and lands after it.
    const sent = page.messages.findIndex((m) => m.msgId === "out-ref-order");
    const echoed = page.messages.findIndex((m) => m.msgId === "in-ref-order");
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(echoed).toBeGreaterThan(sent);
  });

  it("orders the unrecoverable marker with the rest of the transcript", async () => {
    // The hole is a message like any other for ordering purposes: it is never
    // rendered as nothing (§3.4) and it is never floated to an end.
    useScenario("gap-unrecoverable");
    const page = await mockMessaging.listMessages(CONVERSATION_ID, 50);
    assertCausallyOrdered(page.messages);
    expect(page.messages.map((m) => m.msgId)).toEqual([
      "aa01",
      "aa0b",
      "aa02",
    ]);
  });
});

describe("§9 rule 10 — nothing in the messaging module orders messages", () => {
  it("exports no comparator from types.ts", async () => {
    const types = await import("./types");
    expect("compareMessages" in types).toBe(false);
  });
});
