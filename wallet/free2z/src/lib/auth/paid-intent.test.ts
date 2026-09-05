import { describe, expect, it } from "vitest";
import {
  consumePaidIntent,
  discardPaidIntent,
  discardPaidIntentForAccountTransition,
  preservePaidIntent,
} from "./paid-intent";

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
      "/ai",
      { kind: "ai", draft: "unfinished thought" },
      storage,
      100,
    );
    expect(consumePaidIntent("/ai", "ai", storage, 200)).toEqual({
      kind: "ai",
      draft: "unfinished thought",
    });
    expect(consumePaidIntent("/ai", "ai", storage, 200)).toBeNull();
  });

  it("round-trips canonical numeric Send amounts while accepting the legacy string shape", () => {
    const storage = new MemoryStorage();

    preservePaidIntent(
      "/fund",
      { kind: "send", query: "alice", amount: 3_000 },
      storage,
      100,
    );
    expect(consumePaidIntent("/fund", "send", storage, 200)).toEqual({
      kind: "send",
      query: "alice",
      amount: 3_000,
    });

    storage.value = JSON.stringify({
      returnTo: "/fund",
      createdAt: 100,
      intent: { kind: "send", query: "alice", amount: "3,000" },
    });
    expect(consumePaidIntent("/fund", "send", storage, 200)).toEqual({
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
        "/fund",
        { kind: "send", query: "alice", amount } as never,
        storage,
        100,
      );
      expect(storage.value).toBeNull();
    },
  );

  it.each([
    ["/ai", { kind: "ai", draft: "draft" }],
    [
      "/articles/post",
      { kind: "article-tip", subject: "alice", amount: "250" },
    ],
    ["/creator/alice", { kind: "creator-tip", subject: "alice", amount: "50" }],
    ["/creator/alice", { kind: "creator-subscription", subject: "alice" }],
    ["/fund", { kind: "send", query: "alice", amount: "500" }],
    ["/live/alice", { kind: "live-entry", subject: "alice", mode: "ppv" }],
  ] as const)("preserves the %s paid intent across login", (path, intent) => {
    const storage = new MemoryStorage();
    preservePaidIntent(path, intent, storage, 100);
    expect(consumePaidIntent(path, intent.kind, storage, 200)).toEqual(intent);
  });

  it("destructively rejects wrong-route, wrong-kind, expired, and malformed records", () => {
    const storage = new MemoryStorage();
    const record = JSON.stringify({
      returnTo: "/ai",
      createdAt: 100,
      intent: { kind: "ai", draft: "secret" },
    });

    storage.value = record;
    expect(consumePaidIntent("/fund", "ai", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();

    storage.value = record;
    expect(consumePaidIntent("/ai", "creator-tip", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();

    storage.value = record;
    expect(consumePaidIntent("/ai", "ai", storage, 31 * 60 * 1000)).toBeNull();
    expect(storage.value).toBeNull();

    storage.value = "not-json";
    expect(consumePaidIntent("/ai", "ai", storage, 200)).toBeNull();
    expect(storage.value).toBeNull();
  });

  it("clears a prior draft when its replacement is unsafe or invalid", () => {
    const storage = new MemoryStorage();
    const prior = JSON.stringify({ private: "draft" });

    storage.value = prior;
    preservePaidIntent(
      "https://evil.test",
      { kind: "ai", draft: "secret" },
      storage,
      100,
    );
    expect(storage.value).toBeNull();

    storage.value = prior;
    preservePaidIntent("/", { kind: "ai", draft: "secret" }, storage, 100);
    expect(storage.value).toBeNull();

    storage.value = prior;
    preservePaidIntent("/ai", { kind: "ai", draft: 42 } as never, storage, 100);
    expect(storage.value).toBeNull();
  });

  it("clears a private draft when its login attempt is abandoned", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      "/ai",
      { kind: "ai", draft: "belongs to the guest" },
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

  it("preserves paid actions for a full-length backend username", () => {
    const storage = new MemoryStorage();
    const username = "a".repeat(150);
    const intent = {
      kind: "creator-tip",
      subject: username,
      amount: "50",
    } as const;

    preservePaidIntent(`/creator/${username}`, intent, storage, 100);

    expect(
      consumePaidIntent(`/creator/${username}`, "creator-tip", storage, 200),
    ).toEqual(intent);
  });

  it("counts a full-length Unicode username by code point", () => {
    const storage = new MemoryStorage();
    const username = "\u{10400}".repeat(150);
    const returnTo = `/creator/${encodeURIComponent(username)}`;
    const intent = {
      kind: "creator-tip",
      subject: username,
      amount: "50",
    } as const;

    preservePaidIntent(returnTo, intent, storage, 100);

    expect(consumePaidIntent(returnTo, "creator-tip", storage, 200)).toEqual(
      intent,
    );
  });

  it("lets the creator page consume either of its owned intent kinds once", () => {
    const storage = new MemoryStorage();
    preservePaidIntent(
      "/creator/alice",
      { kind: "creator-tip", subject: "alice", amount: "50" },
      storage,
      100,
    );
    expect(
      consumePaidIntent(
        "/creator/alice",
        ["creator-subscription", "creator-tip"],
        storage,
        200,
      ),
    ).toEqual({ kind: "creator-tip", subject: "alice", amount: "50" });
    expect(storage.value).toBeNull();
  });

  it("fails closed when the record cannot be removed", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      returnTo: "/ai",
      createdAt: 100,
      intent: { kind: "ai", draft: "secret" },
    });
    storage.removeItem = () => {
      throw new Error("blocked");
    };

    expect(consumePaidIntent("/ai", "ai", storage, 200)).toBeNull();
    expect(storage.value).toContain("secret");
  });
});
