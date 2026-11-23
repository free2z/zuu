import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveStartResult } from "@/lib/api/types";

const controls = vi.hoisted(() => ({
  start: vi.fn(),
  navigate: vi.fn(),
  release: vi.fn(),
  user: { id: 41, username: "Alice" },
}));
vi.mock("@/lib/api/free2z", () => ({
  live: { start: controls.start },
  ppvPrice: (rate: string) => Number(rate) * 30 + 15,
}));
vi.mock("@/lib/api/host-seat", () => ({ releaseHostSeat: controls.release }));
vi.mock("react-router-dom", () => ({ useNavigate: () => controls.navigate }));
vi.mock("@/store/session", () => ({
  useSession: (select: any) => select({ user: controls.user }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./useMediaPreflight", () => ({
  useMediaPreflight: () => ({ status: "ready", release: vi.fn() }),
}));
vi.mock("./MediaPreflight", () => ({ MediaPreflight: () => null }));
vi.mock("@/components/ui/dialog", () =>
  Object.fromEntries(
    [
      "Dialog",
      "DialogContent",
      "DialogDescription",
      "DialogFooter",
      "DialogHeader",
      "DialogTitle",
      "DialogTrigger",
    ].map((name) => [name, ({ children }: any) => children])
  )
);
vi.mock("@/components/ui/input", async () => {
  const { useEffect } = await import("react");
  return {
    Input: ({ id, onChange }: any) => {
      useEffect(() => {
        if (id === "go-live-title")
          onChange({ target: { value: "Test stream" } });
      }, []);
      return null;
    },
  };
});
import { GoLiveDialog } from "./GoLiveDialog";
let root: Root;
let container: HTMLElement;
let restore: () => void;
let resolve: (value: LiveStartResult) => void;
const result: LiveStartResult = {
  ticket: {
    authToken: "provider",
    meetingId: "meeting",
    as: "host",
    hostSeat: { actorId: 41, username: "Alice", session: "synthetic-seat" },
  },
};
beforeEach(async () => {
  controls.start.mockReset().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  controls.navigate.mockReset();
  controls.release.mockReset();
  controls.user = { id: 41, username: "Alice" };
  const { window, document } = parseHTML(
    "<html><body><div id='root'></div></body></html>"
  );
  const globals: Record<string, unknown> = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  restore = () =>
    saved.forEach(([name, descriptor]) =>
      descriptor
        ? Object.defineProperty(globalThis, name, descriptor)
        : delete (globalThis as any)[name]
    );
  container = document.getElementById("root") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(<GoLiveDialog />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  restore();
});
async function start() {
  const button = [...container.querySelectorAll("button")].find(
    (el) => el.textContent === "Confirm and start"
  )!;
  expect(button.disabled).toBe(false);
  await act(async () =>
    button.dispatchEvent(new window.Event("click", { bubbles: true }))
  );
  expect(controls.start).toHaveBeenCalledWith("broadcast", undefined);
}
it("hands the exact returned seat to Room and leaves ownership there after dialog unmount", async () => {
  await start();
  await act(async () => resolve(result));
  expect(controls.navigate).toHaveBeenCalledWith(
    "/live/Alice",
    expect.objectContaining({
      state: {
        justStarted: expect.objectContaining({ ticket: result.ticket }),
      },
    })
  );
  await act(async () => root.unmount());
  expect(controls.release).not.toHaveBeenCalled();
});
it.each(["unmount", "actor"])(
  "late provisioning after %s releases its exact seat without navigation",
  async (reason) => {
    await start();
    if (reason === "unmount") await act(async () => root.unmount());
    else {
      controls.user = { id: 42, username: "Bob" };
      await act(async () => root.render(<GoLiveDialog />));
    }
    await act(async () => resolve(result));
    expect(controls.navigate).not.toHaveBeenCalled();
    expect(controls.release).toHaveBeenCalledWith(result.ticket.hostSeat);
  }
);
