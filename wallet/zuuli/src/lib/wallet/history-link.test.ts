import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  native: true,
  current: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.native }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: mocks.current,
  onOpenUrl: mocks.listen,
}));
import {
  parseWalletHistoryLink,
  listenForWalletHistoryLinks,
} from "./history-link";
const id = "ab".repeat(32);
const link = `https://free2z.com/bridge/zuuli/#history=${id}`;
afterEach(() => {
  vi.resetAllMocks();
  mocks.native = true;
});
it("maps an exact local txid and all-history to read-only routes", () => {
  expect(parseWalletHistoryLink(link)).toBe(`/wallet/history?txid=${id}`);
  expect(
    parseWalletHistoryLink("https://free2z.com/bridge/zuuli/#history=all"),
  ).toBe("/wallet/history");
});
it.each([
  link.replace("https:", "zuuli:"),
  link.replace("free2z.com", "evil.example"),
  link.replace("free2z.com", "free2z.com:8443"),
  link.replace("free2z.com", "user@free2z.com"),
  link.replace("/zuuli/", "/free2z/"),
  link.replace("/#", "/?secret=1#"),
  link + "&req=00",
  link + "&creator=mallory",
  link.replace(id, "zz".repeat(32)),
  link.replace(id, "ab"),
  link.replace(id, "../send"),
])(
  "refuses another origin, authority payload, attribution or invalid id: %s",
  (raw) => {
    expect(parseWalletHistoryLink(raw)).toBeNull();
  },
);
it("delivers both cold and warm links and cleans up failed startup", async () => {
  const stop = vi.fn();
  let receive!: (urls: string[]) => void;
  mocks.listen.mockImplementation(async (callback) => {
    receive = callback;
    return stop;
  });
  mocks.current.mockResolvedValue([link]);
  const navigate = vi.fn();
  const unlisten = await listenForWalletHistoryLinks(navigate);
  expect(navigate).toHaveBeenCalledWith(`/wallet/history?txid=${id}`);
  receive([link.replace(id, "cd".repeat(32))]);
  expect(navigate).toHaveBeenLastCalledWith(
    `/wallet/history?txid=${"cd".repeat(32)}`,
  );
  unlisten();
  expect(stop).toHaveBeenCalledTimes(1);
  mocks.current.mockRejectedValue(new Error("ipc failed"));
  await expect(listenForWalletHistoryLinks(navigate)).rejects.toThrow(
    "ipc failed",
  );
  expect(stop).toHaveBeenCalledTimes(2);
});
it("never installs in an ordinary browser", async () => {
  mocks.native = false;
  await listenForWalletHistoryLinks(vi.fn());
  expect(mocks.listen).not.toHaveBeenCalled();
});
