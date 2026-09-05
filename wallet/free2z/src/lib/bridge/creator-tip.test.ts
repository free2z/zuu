// Ported from wallet/zuuli/src/lib/wallet/creator-tip.test.ts.
//
// The validation in `./creator-tip.ts` is described as "byte-for-byte
// equivalent to ZUULI's", and a creator without a usable address is supposed to
// fail here, in the renderer, rather than at a signer. That claim is only worth
// anything if it is asserted, so this is ZUULI's suite adapted to this surface's
// API: there is no route state, no nonce and no alteration-detection here,
// because there is no `/wallet/send` route to hand anything to. What remains —
// and what this file covers — is the acceptance bound (150/128/255 code points,
// trim-equality, no control characters, no whitespace in a recipient), the
// frozen snapshot, and the 32-entry cap on the in-memory record.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCreatorTipIntents,
  isCreatorTipSource,
  pendingCreatorTipIntents,
  recordCreatorTipIntent,
} from "./creator-tip";

const SOURCE = {
  username: "ZcashCreator",
  label: "Zcash Creator",
  recipient: "u1exactloadedcreatoraddress",
};

// The module keeps its record in module memory, so every test starts from a
// known-empty one rather than inheriting the previous test's pushes.
afterEach(() => {
  clearCreatorTipIntents();
});

describe("creator ZEC tip intent", () => {
  it("returns an immutable snapshot of the exact creator destination", () => {
    const intent = recordCreatorTipIntent(SOURCE);

    expect(intent).toEqual(SOURCE);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it("carries only the three reviewed fields, dropping anything else", () => {
    const intent = recordCreatorTipIntent({
      ...SOURCE,
      // A caller handing over a whole creator object must not smuggle extra
      // keys into the snapshot that eventually crosses the bridge.
      amountZatoshis: 1,
      memo: "attacker controlled",
    } as unknown as typeof SOURCE);

    expect(Object.keys(intent).sort()).toEqual([
      "label",
      "recipient",
      "username",
    ]);
  });

  it("records each accepted intent, oldest first, and hands back a frozen copy", () => {
    const first = recordCreatorTipIntent(SOURCE);
    const second = recordCreatorTipIntent({ ...SOURCE, username: "Another" });

    const pending = pendingCreatorTipIntents();
    expect(pending).toEqual([first, second]);
    expect(Object.isFrozen(pending)).toBe(true);
  });

  it("never lets the in-memory record grow past 32 entries", () => {
    for (let index = 0; index < 40; index += 1) {
      recordCreatorTipIntent({ ...SOURCE, username: `creator${index}` });
    }

    const pending = pendingCreatorTipIntents();
    expect(pending).toHaveLength(32);
    // The cap drops the oldest, so what survives is the last 32 pushes.
    expect(pending[0].username).toBe("creator8");
    expect(pending[31].username).toBe("creator39");
  });

  it("drops every recorded intent on clear", () => {
    recordCreatorTipIntent(SOURCE);
    clearCreatorTipIntents();

    expect(pendingCreatorTipIntents()).toEqual([]);
  });

  it.each([
    ["a leading space in username", { ...SOURCE, username: " creator" }],
    ["a trailing space in username", { ...SOURCE, username: "creator " }],
    ["an empty label", { ...SOURCE, label: "" }],
    ["an empty username", { ...SOURCE, username: "" }],
    ["an empty recipient", { ...SOURCE, recipient: "" }],
    [
      "a recipient containing whitespace",
      { ...SOURCE, recipient: "u1address with whitespace" },
    ],
    ["a recipient ending in a newline", { ...SOURCE, recipient: "u1address\n" }],
    [
      "a recipient containing a tab",
      { ...SOURCE, recipient: "u1address\taddress" },
    ],
    ["a control character in label", { ...SOURCE, label: "Zcash\u0007Creator" }],
    ["a DEL character in username", { ...SOURCE, username: "creator\u007f" }],
    [
      "a non-string username",
      { ...SOURCE, username: 1 as unknown as string },
    ],
    ["a null recipient", { ...SOURCE, recipient: null as unknown as string }],
    [
      "an undefined label",
      { ...SOURCE, label: undefined as unknown as string },
    ],
  ])("refuses %s before anything is recorded", (_name, source) => {
    expect(isCreatorTipSource(source)).toBe(false);
    expect(() => recordCreatorTipIntent(source)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
    expect(pendingCreatorTipIntents()).toEqual([]);
  });

  // The bounds are the reason this validation exists on a surface that cannot
  // spend: an over-long field is refused in the renderer rather than reaching a
  // signer. Each is asserted at the boundary and one code point past it.
  it.each([
    ["username", 150],
    ["label", 128],
    ["recipient", 255],
  ] as const)("accepts %s at %i code points and refuses one more", (
    field,
    maximum,
  ) => {
    const atBound = { ...SOURCE, [field]: "a".repeat(maximum) };
    const overBound = { ...SOURCE, [field]: "a".repeat(maximum + 1) };

    expect(isCreatorTipSource(atBound)).toBe(true);
    expect(recordCreatorTipIntent(atBound)[field]).toHaveLength(maximum);

    expect(isCreatorTipSource(overBound)).toBe(false);
    expect(() => recordCreatorTipIntent(overBound)).toThrow(
      "Creator ZEC tip details are missing or malformed",
    );
  });

  // The bound counts code points, not UTF-16 units, so an astral-plane
  // character must not consume two of a creator's 150. `String.length` would
  // report 300 here and reject a name that is 150 characters long.
  it("measures the bound in code points rather than UTF-16 units", () => {
    const astralUsername = "\u{1F600}".repeat(150);
    expect(astralUsername.length).toBe(300);

    expect(isCreatorTipSource({ ...SOURCE, username: astralUsername })).toBe(
      true,
    );
    expect(
      isCreatorTipSource({
        ...SOURCE,
        username: "\u{1F600}".repeat(151),
      }),
    ).toBe(false);
  });
});
