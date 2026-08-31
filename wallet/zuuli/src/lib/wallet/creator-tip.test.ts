import { describe, expect, it } from "vitest";
import {
  createCreatorTipRouteState,
  readCreatorTipRouteState,
  retireCreatorTipIntent,
} from "./creator-tip";

const SOURCE = {
  username: "ZcashCreator",
  label: "Zcash Creator",
  recipient: "u1exactloadedcreatoraddress",
};

describe("creator ZEC tip route state", () => {
  it("returns an immutable snapshot of the exact issued creator destination", () => {
    const routeState = createCreatorTipRouteState(SOURCE);
    const intent = readCreatorTipRouteState(routeState);

    expect(intent).toEqual(SOURCE);
    expect(Object.isFrozen(routeState)).toBe(true);
    expect(Object.isFrozen(routeState.creatorTip)).toBe(true);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["wrong version", { creatorTip: { version: 2 } }],
    ["unexpected field", { creatorTip: {}, extra: true }],
  ])("rejects %s state", (_name, state) => {
    expect(readCreatorTipRouteState(state)).toBeNull();
  });

  it.each(["username", "label", "recipient"] as const)(
    "detects an altered %s",
    (field) => {
      const issued = createCreatorTipRouteState(SOURCE);
      const altered = {
        creatorTip: {
          ...issued.creatorTip,
          [field]: `${issued.creatorTip[field]}-altered`,
        },
      };

      expect(readCreatorTipRouteState(altered)).toBeNull();
      expect(readCreatorTipRouteState(issued)).toEqual(SOURCE);
    },
  );

  it("rejects a structurally valid state that was never issued in memory", () => {
    expect(
      readCreatorTipRouteState({
        creatorTip: {
          version: 1,
          nonce: crypto.randomUUID(),
          ...SOURCE,
        },
      }),
    ).toBeNull();
  });

  it("retires an accepted intent so its history state cannot be reused", () => {
    const routeState = createCreatorTipRouteState(SOURCE);
    const intent = readCreatorTipRouteState(routeState);
    expect(intent).not.toBeNull();

    retireCreatorTipIntent(intent!);

    expect(readCreatorTipRouteState(routeState)).toBeNull();
  });

  it.each([
    { ...SOURCE, username: " creator" },
    { ...SOURCE, label: "" },
    { ...SOURCE, recipient: "u1address with whitespace" },
    { ...SOURCE, recipient: "u1address\n" },
  ])("refuses malformed source data before navigation", (source) => {
    expect(() => createCreatorTipRouteState(source)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
  });
});
