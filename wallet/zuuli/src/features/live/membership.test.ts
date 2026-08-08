import { describe, expect, it, vi } from "vitest";
import type {
  DyteJoinTicket,
  Subscription,
} from "@/lib/api/types";
import {
  activeMembershipFor,
  enterSubscriberStream,
  MembershipReconciliationError,
  runSingleFlight,
} from "./membership";

const ticket: DyteJoinTicket = {
  authToken: "ticket",
  meetingId: "meeting",
  as: "participant",
};

function membership(
  expires: string,
  maxPrice = "500",
): Subscription {
  return {
    fan: { username: "viewer", free2zaddr: "viewer" },
    star: { username: "Creator", free2zaddr: "creator" },
    expires,
    max_price: maxPrice,
  };
}

describe("activeMembershipFor", () => {
  it("matches the server-filtered active list case-insensitively", () => {
    const active = membership("2026-08-08T12:00:01Z");

    expect(activeMembershipFor([active], "creator")).toBe(active);
    expect(activeMembershipFor([active], "someone-else")).toBeNull();
  });

  it("treats an active cancelled membership as entitled", () => {
    const cancelled = membership("2026-09-01T00:00:00Z", "0");
    expect(activeMembershipFor([cancelled], "creator")).toBe(cancelled);
  });
});

describe("enterSubscriberStream", () => {
  function deps(loadMemberships: () => Promise<Subscription[]>) {
    return {
      username: "creator",
      idempotencyKey: "stable-attempt-key",
      confirmedPrice: 500,
      loadMemberships,
      loadCurrentPrice: vi.fn().mockResolvedValue(500),
      subscribe: vi.fn().mockResolvedValue({
        charged: true,
        expires: "2026-09-07T12:00:00Z",
      }),
      reconcileBalance: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(ticket),
    };
  }

  it("joins an active member directly without purchasing or refreshing balance", async () => {
    const active = membership("2099-01-01T00:00:00Z", "0");
    const runtime = deps(vi.fn().mockResolvedValue([active]));

    const result = await enterSubscriberStream(runtime);

    expect(result.purchase).toBeNull();
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(runtime.reconcileBalance).not.toHaveBeenCalled();
    expect(runtime.join).toHaveBeenCalledOnce();
  });

  it("purchases after an expired membership drops from the active endpoint and joins only after reconciliation", async () => {
    const active = membership("2099-01-01T00:00:00Z");
    const events: string[] = [];
    const load = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("preflight");
        return [];
      })
      .mockImplementationOnce(async () => {
        events.push("membership reconciled");
        return [active];
      });
    const runtime = deps(load);
    runtime.subscribe.mockImplementation(async (_username, key) => {
      events.push(`subscribe:${key}`);
      return { charged: true, expires: active.expires! };
    });
    runtime.reconcileBalance.mockImplementation(async () => {
      events.push("balance reconciled");
    });
    runtime.join.mockImplementation(async () => {
      events.push("join");
      return ticket;
    });

    await enterSubscriberStream(runtime);

    expect(runtime.subscribe).toHaveBeenCalledWith(
      "creator",
      "stable-attempt-key",
    );
    expect(events.indexOf("join")).toBeGreaterThan(
      events.indexOf("membership reconciled"),
    );
    expect(events.indexOf("join")).toBeGreaterThan(
      events.indexOf("balance reconciled"),
    );
  });

  it("does not join or invent local state after insufficient funds", async () => {
    const runtime = deps(vi.fn().mockResolvedValue([]));
    runtime.subscribe.mockRejectedValue(new Error("Insufficient funds"));

    await expect(enterSubscriberStream(runtime)).rejects.toThrow(
      "Insufficient funds",
    );
    expect(runtime.reconcileBalance).toHaveBeenCalledOnce();
    expect(runtime.join).not.toHaveBeenCalled();
  });

  it("requires a new confirmation when the authoritative price changed", async () => {
    const runtime = deps(vi.fn().mockResolvedValue([]));
    runtime.loadCurrentPrice.mockResolvedValue(750);

    await expect(enterSubscriberStream(runtime)).rejects.toThrow(
      "price changed from 500 2Z to 750 2Z",
    );
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(runtime.reconcileBalance).not.toHaveBeenCalled();
    expect(runtime.join).not.toHaveBeenCalled();
  });

  it("fails closed when a successful POST cannot be confirmed", async () => {
    const runtime = deps(vi.fn().mockResolvedValue([]));

    await expect(enterSubscriberStream(runtime)).rejects.toBeInstanceOf(
      MembershipReconciliationError,
    );
    expect(runtime.join).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous response when authoritative reads prove the purchase", async () => {
    const active = membership("2099-01-01T00:00:00Z");
    const runtime = deps(
      vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([active]),
    );
    runtime.subscribe.mockRejectedValue(new Error("response lost"));

    const result = await enterSubscriberStream(runtime);

    expect(result.recoveredAmbiguousPurchase).toBe(true);
    expect(runtime.join).toHaveBeenCalledOnce();
  });

  it("a retry after reconciliation failure sees membership and never POSTs twice", async () => {
    const active = membership("2099-01-01T00:00:00Z");
    const load = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce([active]);
    const runtime = deps(load);

    await expect(enterSubscriberStream(runtime)).rejects.toBeInstanceOf(
      MembershipReconciliationError,
    );
    await expect(enterSubscriberStream(runtime)).resolves.toMatchObject({
      purchase: null,
    });

    expect(runtime.subscribe).toHaveBeenCalledOnce();
    expect(runtime.join).toHaveBeenCalledOnce();
  });
});

describe("runSingleFlight", () => {
  it("drops a double-click while the first operation is pending, then unlocks", async () => {
    const lock = { current: false };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn().mockImplementation(() => pending);

    const first = runSingleFlight(lock, operation);
    const second = runSingleFlight(lock, operation);

    await expect(second).resolves.toBeNull();
    expect(operation).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBeUndefined();

    await runSingleFlight(lock, operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
