import { describe, expect, it, vi } from "vitest";
import {
  canRunZecTopUpDemo,
  settleZecTopUpDemo,
  type ZecTopUpDemoRuntime,
} from "./zec-top-up-demo";

const MOCK_BROWSER_DEV: ZecTopUpDemoRuntime = {
  explicitMock: true,
  development: true,
  tauri: false,
};

describe("ZEC top-up demo boundary", () => {
  it.each([
    ["real browser development", { ...MOCK_BROWSER_DEV, explicitMock: false }],
    ["production browser", { ...MOCK_BROWSER_DEV, development: false }],
    ["Tauri development", { ...MOCK_BROWSER_DEV, tauri: true }],
    [
      "production Tauri",
      { ...MOCK_BROWSER_DEV, development: false, tauri: true },
    ],
  ])("cannot fabricate settlement in %s", async (_name, runtime) => {
    const adjustTuzis = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    expect(canRunZecTopUpDemo(runtime)).toBe(false);
    await expect(
      settleZecTopUpDemo(runtime, 1_000, adjustTuzis, wait),
    ).rejects.toThrow(/unavailable/);
    expect(wait).not.toHaveBeenCalled();
    expect(adjustTuzis).not.toHaveBeenCalled();
  });

  it("allows an explicitly mocked browser development demo", async () => {
    const adjustTuzis = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    expect(canRunZecTopUpDemo(MOCK_BROWSER_DEV)).toBe(true);
    await settleZecTopUpDemo(MOCK_BROWSER_DEV, 1_000, adjustTuzis, wait);

    expect(wait).toHaveBeenCalledOnce();
    expect(adjustTuzis).toHaveBeenCalledOnce();
    expect(adjustTuzis).toHaveBeenCalledWith(1_000);
  });
});
