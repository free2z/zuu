import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri, useMock } from "./platform";
import { setToken } from "./api/http";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { accountBillingUrl, openAccountBilling, refreshBillingBalance } from "./account-billing";

vi.mock("./platform", () => ({ useMock: vi.fn(() => false), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./env", async (original) => ({
  ...await original<typeof import("./env")>(),
  API_BASE: "https://free2z.cash",
  ACCOUNT_ORIGIN: "https://free2z.cash",
}));

const fetchApi = vi.fn<typeof fetch>();
const assign = vi.fn();
const zecBalance = {
  accountIndex: 0, totalShielded: 100_000_000, spendable: 90_000_000,
  changePending: 10_000_000, valuePending: 0,
};
const initial = 12.345;
function response(tuzis: unknown, extra = {}) {
  return new Response(JSON.stringify({ username: "billing-fixture", tuzis, ...extra }));
}
function refresh() {
  return refreshBillingBalance(new AbortController().signal);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchApi.mockReset();
  vi.stubGlobal("window", { location: { origin: "https://free2z.cash", assign }, fetch: fetchApi });
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(useMock).mockReturnValue(false);
  setToken("billing-fixture-token");
  useSession.getState().setUser({ username: "billing-fixture", tuzis: initial });
  useWallet.setState({ balance: { ...zecBalance } });
});
afterEach(() => vi.unstubAllGlobals());

function expectUnchanged() {
  expect(useSession.getState().tuzis).toBe(initial);
  expect(useWallet.getState().balance).toEqual(zecBalance);
}

describe("account billing handoff", () => {
  it("cannot present mock data as an authoritative native funding check", async () => {
    vi.mocked(useMock).mockReturnValue(true);
    vi.mocked(isTauri).mockReturnValue(true);
    await expect(openAccountBilling()).rejects.toThrow("mock mode");
    await expect(refresh()).rejects.toThrow("mock balance");
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
    expectUnchanged();
  });
  it.each(["https://free2z.cash", "https://stage.free2z.cash/", "http://127.0.0.1:8000"])(
    "uses the same configured account realm: %s", (origin) => {
      const url = new URL(accountBillingUrl(origin));
      expect(url.origin).toBe(new URL(origin).origin);
      expect(url.pathname).toBe("/buy-2z");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    },
  );
  it.each([
    "http://free2z.cash", "javascript:alert(1)", "https://user:secret@free2z.cash",
    "https://free2z.cash/buy-2z", "https://free2z.cash?next=https://other.test",
    "https://free2z.cash#secret", "//free2z.cash",
  ])("refuses a non-origin configuration: %s", (value) => {
    expect(() => accountBillingUrl(value)).toThrow();
  });
  it("opens outside the seed-holding native WebView, with a safe retry after opener failure", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("OS refused")).mockResolvedValue(undefined);
    await expect(openAccountBilling()).rejects.toThrow("OS refused");
    expectUnchanged();
    await openAccountBilling();
    expect(vi.mocked(openUrl).mock.calls).toEqual([
      ["https://free2z.cash/buy-2z"], ["https://free2z.cash/buy-2z"],
    ]);
    expect(assign).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
    expectUnchanged();
  });
  it("navigates web to the same account page without creating a purchase or claiming credit", async () => {
    await openAccountBilling();
    expect(assign).toHaveBeenCalledExactlyOnceWith("https://free2z.cash/buy-2z");
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
    expectUnchanged();
  });
});

describe("authoritative balance, not a quote or payment acknowledgement", () => {
  it("only reads the pinned account: unconfirmed payment, then issued credit, then a replayed refresh", async () => {
    fetchApi.mockResolvedValueOnce(response("12.345", { status: "pending_confirmation", txid: "synthetic-original" }))
      .mockImplementation(async () => response("45.678"));
    await refresh();
    expectUnchanged();
    await refresh();
    await refresh();
    expect(useSession.getState().tuzis).toBe(45.678);
    expect(useSession.getState().user?.tuzis).toBe(45.678);
    expect(useWallet.getState().balance).toEqual(zecBalance);
    for (const [url, init] of fetchApi.mock.calls) {
      expect(url).toBe("https://free2z.cash/api/auth/user/");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.cache).toBe("no-store");
      expect(init?.headers).toMatchObject({ Authorization: "Token billing-fixture-token" });
    }
  });
  it("restarts from the current server balance with milli-2Z intact and no automatic resend", async () => {
    fetchApi.mockResolvedValue(response("0.001"));
    useSession.setState({ user: null, tuzis: 0, loading: true });
    await useSession.getState().bootstrap();
    expect(useSession.getState().user?.tuzis).toBe(0.001);
    expect(useSession.getState().tuzis).toBe(0.001);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(useWallet.getState().balance).toEqual(zecBalance);
  });
  it.each([undefined, null, "NaN", "-1", "1.0001", "9007199254741.000", "1e3", ""])(
    "rejects an invalid authoritative balance (%s), preserving both balances", async (wire) => {
      fetchApi.mockResolvedValue(response(wire));
      await expect(refresh()).rejects.toThrow("Account balance is unavailable");
      expectUnchanged();
    },
  );
  it("keeps the original balance through connection, expired-session and server failures; retry is a GET", async () => {
    fetchApi.mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(response("12.345"));
    for (let i = 0; i < 3; i++) {
      await expect(refresh()).rejects.toThrow();
      expectUnchanged();
    }
    await refresh();
    expectUnchanged();
  });
  it("ignores receipt or browser-success fields; an invalid balance cannot be turned into credit", async () => {
    fetchApi.mockResolvedValue(response(undefined, { credited: true, status: "credited", amount: 1000 }));
    await expect(refresh()).rejects.toThrow();
    expectUnchanged();
  });
  it("cannot overwrite a new login, including A -> B -> A", async () => {
    let finish!: (value: Response) => void;
    fetchApi.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = refresh();
    await vi.waitFor(() => expect(fetchApi).toHaveBeenCalledOnce());
    setToken("other-session");
    setToken("billing-fixture-token");
    finish(response("999.999"));
    await expect(pending).rejects.toThrow("account changed");
    expectUnchanged();
  });
  it("refuses another account's response", async () => {
    fetchApi.mockResolvedValue(response("999", { username: "other-account" }));
    await expect(refresh()).rejects.toThrow("account changed");
    expectUnchanged();
  });
  it("a timed-out read cannot apply late, even after a successful retry", async () => {
    let finish!: (value: Response) => void;
    fetchApi.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = refreshBillingBalance(controller.signal);
    await vi.waitFor(() => expect(fetchApi).toHaveBeenCalledOnce());
    controller.abort();
    fetchApi.mockResolvedValueOnce(response("13.456"));
    await refresh();
    finish(response("999.999"));
    await expect(pending).rejects.toThrow();
    expect(useSession.getState().tuzis).toBe(13.456);
    expect(useWallet.getState().balance).toEqual(zecBalance);
  });
  it("never probes an anonymous account", async () => {
    setToken(null);
    await expect(refresh()).rejects.toThrow("Log in");
    expect(fetchApi).not.toHaveBeenCalled();
    expectUnchanged();
  });
});
