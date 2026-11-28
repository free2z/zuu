import { beforeEach, describe, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({ native: false, invoke: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: () => control.native }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: control.invoke }));
import { notificationCommand } from "./bridge";
beforeEach(() => { control.native = false; control.invoke.mockReset(); });
describe("notification authority bridge", () => {
  it("never requests browser permission or a token in a browser", async () => {
    expect(await notificationCommand("enable")).toEqual({ state: "unsupported", wake: false });
    expect(control.invoke).not.toHaveBeenCalled();
  });
  it("sends no account, device token, identity or caller-selected payload over IPC", async () => {
    control.native = true; control.invoke.mockResolvedValue({ state: "queued", wake: false });
    expect(await notificationCommand("test_wake")).toEqual({ state: "queued", wake: false });
    expect(control.invoke).toHaveBeenCalledWith("plugin:notify|test_wake");
  });
  it.each([{ state: "enabled", wake: true, token: "PRIVATE-CANARY" }, { state: "paid", wake: true }, { state: "enabled", wake: "true" }])("rejects authority-bearing/malformed responses", async (value) => {
    control.native = true; control.invoke.mockResolvedValue(value);
    expect(await notificationCommand("status")).toEqual({ state: "unavailable", wake: false });
  });
  it("suppresses private errors while preserving offline state", async () => {
    control.native = true; control.invoke.mockRejectedValue("PRIVATE-CANARY");
    expect(await notificationCommand("enable")).toEqual({ state: "unavailable", wake: false });
    control.invoke.mockRejectedValue("offline");
    expect(await notificationCommand("disable")).toEqual({ state: "offline", wake: false });
  });
});
