import { describe, expect, it } from "vitest";
import {
  browserHistoryEntryKey,
  normalizedInitialHistoryState,
  ScrollPositionStore,
} from "./route-scroll";

describe("ScrollPositionStore", () => {
  it("keeps distinct history-entry offsets and refreshes restored entries", () => {
    const positions = new ScrollPositionStore(3);
    positions.remember("a", 120);
    positions.remember("b", 340);
    positions.remember("c", 560);

    expect(positions.recall("a")).toBe(120);
    positions.remember("d", 780);

    expect(positions.recall("b")).toBeUndefined();
    expect(positions.recall("c")).toBe(560);
    expect(positions.recall("d")).toBe(780);
    expect(positions.size).toBe(3);
    expect(positions.has("a")).toBe(true);
    expect(positions.has("b")).toBe(false);
  });

  it("bounds hostile offsets and never grows past its limit", () => {
    const positions = new ScrollPositionStore(2);
    positions.remember("negative", -20);
    positions.remember("infinite", Number.POSITIVE_INFINITY);
    positions.remember("huge", Number.MAX_VALUE);

    expect(positions.recall("negative")).toBeUndefined();
    expect(positions.recall("infinite")).toBe(0);
    expect(positions.recall("huge")).toBe(Number.MAX_SAFE_INTEGER);
    expect(positions.size).toBe(2);
  });
});

describe("browserHistoryEntryKey", () => {
  it("accepts the exact non-empty React Router history key", () => {
    expect(browserHistoryEntryKey({ usr: null, key: "entry-2", idx: 2 })).toBe(
      "entry-2",
    );
  });

  it.each([null, undefined, [], {}, { key: "" }, { key: 2 }])(
    "fails closed for malformed history state %#",
    (state) => {
      expect(browserHistoryEntryKey(state)).toBeNull();
    },
  );
});

describe("normalizedInitialHistoryState", () => {
  it("adds BrowserRouter's default key only to its exact initial state", () => {
    expect(normalizedInitialHistoryState({ idx: 0 }, "default")).toEqual({
      idx: 0,
      key: "default",
    });
  });

  it.each([
    [{ idx: 0 }, "unexpected"],
    [{ idx: 1 }, "default"],
    [{ idx: 0, usr: null }, "default"],
    [{ idx: 0, hostile: true }, "default"],
    [null, "default"],
  ])("rejects malformed or non-initial state %#", (state, locationKey) => {
    expect(normalizedInitialHistoryState(state, locationKey)).toBeNull();
  });
});
