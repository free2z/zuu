// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api/free2z", () => ({ live: { status: vi.fn() } }));
import { live } from "@/lib/api/free2z";
import { useLiveGate } from "./useLiveGate";
function ProfileStatus() {
  const isLive = useLiveGate("alice", undefined);
  return <p>{isLive ? "Watch live" : "Creator profile"}</p>;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("preserves usable profile and last live status across failed initial and periodic probes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(live.status)
    .mockRejectedValueOnce(new Error("invalid response"))
    .mockResolvedValueOnce({ live: true } as Awaited<ReturnType<typeof live.status>>)
    .mockRejectedValueOnce(new Error("connection closed"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProfileStatus />));
    expect(container.textContent).toBe("Creator profile");
    expect(live.status).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toBe("Watch live");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toBe("Watch live");
    expect(live.status).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
  }
  expect(vi.getTimerCount()).toBe(0);
});
