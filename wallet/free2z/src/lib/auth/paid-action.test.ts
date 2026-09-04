import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/api/types";
import { paidActionGate, runPaidAction } from "./paid-action";

const user = { username: "alice", tuzis: 5 } as AuthUser;

describe("paidActionGate", () => {
  it("resolves session and authentication before diagnosing balance", () => {
    expect(
      paidActionGate({
        sessionLoading: true,
        user: null,
        balance: 0,
        cost: 10,
      }),
    ).toBe("loading");
    expect(
      paidActionGate({
        sessionLoading: false,
        user: null,
        balance: 0,
        cost: 10,
      }),
    ).toBe("sign-in");
    expect(
      paidActionGate({ sessionLoading: false, user, balance: 5, cost: 10 }),
    ).toBe("low-balance");
    expect(
      paidActionGate({ sessionLoading: false, user, balance: 10, cost: 10 }),
    ).toBe("ready");
  });

  it("never invokes a protected action for loading, signed-out, or low-balance state", async () => {
    const action = vi.fn().mockResolvedValue("called");
    for (const state of [
      { sessionLoading: true, user: null, balance: 0, cost: 1 },
      { sessionLoading: false, user: null, balance: 1_000, cost: 1 },
      { sessionLoading: false, user, balance: 0, cost: 1 },
    ]) {
      await runPaidAction(state, action);
    }
    expect(action).not.toHaveBeenCalled();
    await expect(
      runPaidAction(
        { sessionLoading: false, user, balance: 5, cost: 1 },
        action,
      ),
    ).resolves.toEqual({ gate: "ready", result: "called" });
    expect(action).toHaveBeenCalledOnce();
  });

  it.each([
    "AI conversation",
    "article tip",
    "creator tip",
    "creator subscription",
    "2Z send",
    "card checkout",
    "paid livestream entry",
  ])("keeps the %s API boundary closed for a guest", async () => {
    const protectedApi = vi.fn().mockResolvedValue(undefined);
    const outcome = await runPaidAction(
      { sessionLoading: false, user: null, balance: 0, cost: 100 },
      protectedApi,
    );
    expect(outcome.gate).toBe("sign-in");
    expect(protectedApi).not.toHaveBeenCalled();
  });
});
