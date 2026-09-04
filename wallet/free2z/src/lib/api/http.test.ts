import { afterEach, describe, expect, it } from "vitest";
import { getToken, onTokenChange, setToken } from "./http";

afterEach(() => setToken(null));

describe("process-local token transitions", () => {
  it("notifies active flows exactly when the authenticated session changes", () => {
    setToken(null);
    const observed: Array<string | null> = [];
    const stop = onTokenChange((token) => observed.push(token));

    setToken("account-a");
    setToken("account-a");
    setToken("account-b");
    setToken(null);
    stop();
    setToken("ignored-after-unsubscribe");

    expect(observed).toEqual(["account-a", "account-b", null]);
    expect(getToken()).toBe("ignored-after-unsubscribe");
  });

  it("isolates listeners so one failure cannot hide a transition", () => {
    const observed: Array<string | null> = [];
    const stopThrowing = onTokenChange(() => {
      throw new Error("stale subscriber");
    });
    const stopObserving = onTokenChange((token) => observed.push(token));

    expect(() => setToken("account-a")).not.toThrow();
    expect(observed).toEqual(["account-a"]);

    stopThrowing();
    stopObserving();
  });
});
