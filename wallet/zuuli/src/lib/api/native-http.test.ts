import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn());
vi.mock("../platform", () => ({ isTauri: () => true }));
vi.mock("../env", () => ({ API_BASE: "", MEDIA_BASE: "" }));
vi.mock("../network", () => ({ nativeApiFetch: native }));
import { request } from "./http";
afterEach(() => vi.clearAllMocks());
describe("native development follows the production policy seam", () => {
  it("uses the reviewed staging origin instead of the browser/Vite proxy", async () => {
    native.mockResolvedValue(new Response('{"ok":true}'));
    await expect(request("/api/auth/user/",{anonymous:true})).resolves.toEqual({ok:true});
    expect(native).toHaveBeenCalledWith("https://stage.free2z.cash/api/auth/user/",expect.objectContaining({method:"GET"}));
  });
  it("does not recover a native policy refusal through browser fetch", async () => {
    native.mockRejectedValue(new Error("Free2Z API unavailable in Tor mode"));
    await expect(request("/api/auth/user/")).rejects.toThrow("unavailable in Tor mode");
    expect(native).toHaveBeenCalledTimes(1);
  });
});
