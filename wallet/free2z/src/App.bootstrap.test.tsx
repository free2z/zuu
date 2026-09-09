// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-router-dom", async (original) => ({
  ...await original<typeof import("react-router-dom")>(),
  createBrowserRouter: vi.fn(() => ({})),
  RouterProvider: () => <p>Session loading</p>,
}));
vi.mock("@/features/auth", () => ({ default: () => null }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/lib/auth/paid-intent", () => ({
  discardPaidIntent: vi.fn(() => { throw new Error("local storage unavailable"); }),
  discardPaidIntentForAccountTransition: vi.fn(),
}));
vi.mock("@/lib/api/http", async (original) => ({
  ...await original<typeof import("@/lib/api/http")>(),
  isAuthed: () => false,
}));
import App from "./App";
import { useSession } from "@/store/session";
import { discardPaidIntent } from "@/lib/auth/paid-intent";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("shows a terminal fallback when session cleanup rejects before auth validation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSession.setState({ loading: true, user: null, tuzis: 0 });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<App />); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t restore your session");
    expect(container.textContent).not.toContain("Session loading");
    expect(container.textContent).toContain("Reload the app");
    expect(useSession.getState().loading).toBe(true);
    expect(discardPaidIntent).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
