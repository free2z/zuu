// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { IntentErrorCode } from "@free2z/wallet-shared";
import type { CreatorTipOutcome } from "@/lib/bridge/creator-tip";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/bridge/creator-tip", async (original) => ({
  ...(await original<typeof import("@/lib/bridge/creator-tip")>()),
  requestCreatorTipPayment: mocks.request,
}));
const source = { username: "alice", label: "Alice", recipient: "u1alice" };
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  mocks.request.mockReset();
});

it("locks synchronously across rapid taps, mutated source/amount, and navigation", async () => {
  let finish!: (value: CreatorTipOutcome) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { startZecTip, acknowledgeZecTip } = await import("./zec-tip-session");
  const mutable = { ...source };
  const first = startZecTip(mutable, 100_000);
  mutable.username = "mallory";
  mutable.recipient = "u1mallory";
  await startZecTip(mutable, 900_000);
  acknowledgeZecTip();
  await startZecTip(source, 900_000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith(source, 100_000);
  expect(Object.isFrozen(mocks.request.mock.calls[0][0])).toBe(true);
  expect(localStorage.getItem("free2z.zec-tip-needs-wallet-check")).toBe("1");
  finish({ kind: "sent", txid: "ab".repeat(32) });
  await first;
  await startZecTip(source, 900_000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  acknowledgeZecTip();
  mocks.request.mockResolvedValue({ kind: "no-transport", reason: "browser" });
  await startZecTip(source, 900_000);
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it.each<CreatorTipOutcome>([
  { kind: "transport-failed", detail: "timeout" },
  { kind: "unknown-status", status: 4242 },
  { kind: "refused", error: IntentErrorCode.Unavailable },
  { kind: "refused", error: IntentErrorCode.Unsolicited },
  { kind: "refused", error: IntentErrorCode.Malformed },
])(
  "retains an anonymous recovery latch across restart for %j",
  async (outcome) => {
    mocks.request.mockResolvedValue(outcome);
    const { startZecTip } = await import("./zec-tip-session");
    await startZecTip(source, 100_000);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("free2z.zec-tip-needs-wallet-check")).toBe("1");
    vi.resetModules();
    const restarted = await import("./zec-tip-session");
    await restarted.startZecTip({ ...source, username: "bob" }, 900_000);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    restarted.acknowledgeZecTip();
    await restarted.startZecTip(source, 100_000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  },
);

it.each<CreatorTipOutcome>([
  { kind: "no-transport", reason: "browser" },
  { kind: "unsendable", error: IntentErrorCode.InvalidValue },
  { kind: "refused", error: IntentErrorCode.NotConfirmed },
])("clears crash recovery only for a certain outcome %j", async (outcome) => {
  mocks.request.mockResolvedValue(outcome);
  const { startZecTip } = await import("./zec-tip-session");
  await startZecTip(source, 100_000);
  expect(localStorage.length).toBe(0);
  await startZecTip(source, 100_000);
  expect(mocks.request).toHaveBeenCalledTimes(1); // receipt must be acknowledged
});

it("retains crash protection after an accepted response until the receipt is acknowledged", async () => {
  mocks.request.mockResolvedValue({ kind: "sent", txid: "ab".repeat(32) });
  const { startZecTip } = await import("./zec-tip-session");
  await startZecTip(source, 100_000);
  expect(localStorage.getItem("free2z.zec-tip-needs-wallet-check")).toBe("1");
  vi.resetModules();
  const restarted = await import("./zec-tip-session");
  await restarted.startZecTip(source, 100_000);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  restarted.acknowledgeZecTip();
  expect(localStorage.length).toBe(0);
});

it("preserves uncertainty for an unexpected rejection", async () => {
  mocks.request.mockRejectedValue(new Error("bad response"));
  const { startZecTip } = await import("./zec-tip-session");
  await expect(startZecTip(source, 100_000)).resolves.toBeUndefined();
  expect(localStorage.length).toBe(1);
});

it("refuses dispatch if crash protection cannot be persisted", async () => {
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  try {
    const { startZecTip } = await import("./zec-tip-session");
    await startZecTip(source, 100_000);
    expect(mocks.request).not.toHaveBeenCalled();
  } finally {
    set.mockRestore();
  }
});
