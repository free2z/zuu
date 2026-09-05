import { describe, expect, it } from "vitest";
import {
  consumePaidIntent,
  discardPaidIntent,
  discardPaidIntentForAccountTransition,
  preservePaidIntent,
} from "./paid-intent";

const SEND = "/wallet/fund/send";

class MemoryStorage {
  value: string | null = null;
  getItem() {
    return this.value;
  }
  setItem(_key: string, value: string) {
    this.value = value;
  }
  removeItem() {
    this.value = null;
  }
}

describe("paid login intent", () => {
  it("round-trips a bounded draft only to its exact safe destination", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      SEND,
      { kind: "send", query: "alice", amount: 500 },
      storage,
      100,
    );
    expect(consumePaidIntent(SEND, "send", storage, 200)).toEqual({
      kind: "send",
      query: "alice",
      amount: 500,
    });
    expect(consumePaidIntent(SEND, "send", storage, 200)).toBeNull();
  });

  it("round-trips canonical numeric Send amounts while accepting the legacy string shape", () => {
    const storage = new MemoryStorage();

    preservePaidIntent(
      SEND,
      { kind: "send", query: "alice", amount: 3_000 },
      storage,
      100,
    );
    expect(consumePaidIntent(SEND, "send", storage, 200)).toEqual({
      kind: "send",
      query: "alice",
      amount: 3_000,
    });

    storage.value = JSON.stringify({
      returnTo: SEND,
      createdAt: 100,
      intent: { kind: "send", query: "alice", amount: "3,000" },
    });
    expect(consumePaidIntent(SEND, "send", storage, 200)).toEqual({
      kind: "send",
      query: "alice",
      amount: "3,000",
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])(
    "rejects an invalid canonical Send amount (%s)",
    (amount) => {
      const storage = new MemoryStorage();
      preservePaidIntent(
        SEND,
        { kind: "send", query: "alice", amount } as never,
        storage,
        100,
      );
      expect(storage.value).toBeNull();
    },
  );

  /**
   * #904 phase 4 retired `ai`, `article-tip`, `creator-tip`,
   * `creator-subscription` and `live-entry` with the routes that issued them.
   * A record written by an older build must be destroyed on read rather than
   * restored: its destination no longer exists in this app.
   */
  it.each([
    { kind: "ai", draft: "unfinished thought" },
    { kind: "article-tip", subject: "alice", amount: "250" },
    { kind: "creator-tip", subject: "alice", amount: "50" },
    { kind: "creator-subscription", subject: "alice" },
    { kind: "live-entry", subject: "alice", mode: "ppv" },
  ])("destroys a retired intent kind instead of restoring it (%o)", (intent) => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      returnTo: SEND,
      createdAt: 100,
      intent,
    });

    expect(consumePaidIntent(SEND, "send", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();
  });

  it("refuses to write a retired intent kind at all", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      SEND,
      { kind: "ai", draft: "secret" } as never,
      storage,
      100,
    );
    expect(storage.value).toBeNull();
  });

  it("destructively rejects wrong-route, expired, and malformed records", () => {
    const storage = new MemoryStorage();
    const record = JSON.stringify({
      returnTo: SEND,
      createdAt: 100,
      intent: { kind: "send", query: "alice", amount: 500 },
    });

    storage.value = record;
    expect(consumePaidIntent("/wallet/fund", "send", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();

    storage.value = record;
    expect(consumePaidIntent(SEND, "send", storage, 31 * 60 * 1000)).toBeNull();
    expect(storage.value).toBeNull();

    storage.value = "not-json";
    expect(consumePaidIntent(SEND, "send", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();
  });

  it("clears a prior draft when its replacement is unsafe or invalid", () => {
    const storage = new MemoryStorage();
    const prior = JSON.stringify({ private: "draft" });
    const intent = { kind: "send", query: "alice", amount: 500 } as const;

    storage.value = prior;
    preservePaidIntent("https://evil.test", intent, storage, 100);
    expect(storage.value).toBeNull();

    storage.value = prior;
    preservePaidIntent("/", intent, storage, 100);
    expect(storage.value).toBeNull();

    storage.value = prior;
    preservePaidIntent(
      SEND,
      { kind: "send", query: 42, amount: 500 } as never,
      storage,
      100,
    );
    expect(storage.value).toBeNull();
  });

  it("clears a private draft when its login attempt is abandoned", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      SEND,
      { kind: "send", query: "belongs to the guest", amount: 500 },
      storage,
      100,
    );

    discardPaidIntent(storage);

    expect(storage.value).toBeNull();
  });

  it("retains a first-login draft but destroys it on logout or account switch", () => {
    const storage = new MemoryStorage();
    const draft = JSON.stringify({ private: "draft" });

    storage.value = draft;
    discardPaidIntentForAccountTransition(null, "alice", storage);
    expect(storage.value).toBe(draft);

    discardPaidIntentForAccountTransition("alice", "alice", storage);
    expect(storage.value).toBe(draft);

    discardPaidIntentForAccountTransition("alice", "bob", storage);
    expect(storage.value).toBeNull();

    storage.value = draft;
    discardPaidIntentForAccountTransition("alice", null, storage);
    expect(storage.value).toBeNull();
  });

  it("preserves a paid action for a full-length backend username", () => {
    const storage = new MemoryStorage();
    const query = "a".repeat(150);
    const intent = { kind: "send", query, amount: 500 } as const;

    preservePaidIntent(SEND, intent, storage, 100);

    expect(consumePaidIntent(SEND, "send", storage, 200)).toEqual(intent);
  });

  it("counts a full-length Unicode username by code point", () => {
    const storage = new MemoryStorage();
    const query = "\u{10400}".repeat(150);
    const intent = { kind: "send", query, amount: 500 } as const;

    preservePaidIntent(SEND, intent, storage, 100);

    expect(consumePaidIntent(SEND, "send", storage, 200)).toEqual(intent);
  });

  it("rejects a username one code point over the limit", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      SEND,
      { kind: "send", query: "\u{10400}".repeat(151), amount: 500 },
      storage,
      100,
    );
    expect(storage.value).toBeNull();
  });

  it("fails closed when the record cannot be removed", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      returnTo: SEND,
      createdAt: 100,
      intent: { kind: "send", query: "secret", amount: 500 },
    });
    storage.removeItem = () => {
      throw new Error("blocked");
    };

    expect(consumePaidIntent(SEND, "send", storage, 200)).toBeNull();
    expect(storage.value).toContain("secret");
  });
});
