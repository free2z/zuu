import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./platform", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
import { nativeApiFetch, openNetworkUrl } from "./network";
afterEach(() => vi.resetAllMocks());
describe("native policy dispatch", () => {
  it("routes API requests through the sole native policy command and preserves failures", async () => {
    mocks.invoke.mockResolvedValue({status: 403, body: '{"error":"refused"}'});
    const response = await nativeApiFetch("https://free2z.cash/api/auth/user/", { method:"POST", headers:{Authorization:"Token fixture"}, body:"{}" });
    expect(response.status).toBe(403);
    expect(mocks.invoke).toHaveBeenCalledWith("api_request", {url:"https://free2z.cash/api/auth/user/",method:"POST",headers:{authorization:"Token fixture", "content-type":"text/plain;charset=UTF-8"},body:[123,125]});
    mocks.invoke.mockRejectedValue(new Error("Free2Z API unavailable in Tor mode"));
    await expect(nativeApiFetch("https://free2z.cash/api/", {})).rejects.toThrow("unavailable in Tor mode");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
  it("does not let the plugin opener bypass a native policy refusal", async () => {
    mocks.invoke.mockRejectedValue(new Error("External links unavailable in Tor mode"));
    await expect(openNetworkUrl("https://example.invalid/")).rejects.toThrow("unavailable in Tor mode");
    expect(mocks.invoke).toHaveBeenCalledWith("network_open", {url:"https://example.invalid/"});
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
  it("refuses an already cancelled operation before invoking native I/O", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(nativeApiFetch("https://free2z.cash/api/", {signal:controller.signal})).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
