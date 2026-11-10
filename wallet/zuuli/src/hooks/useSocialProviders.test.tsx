import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ useMock: () => false }));
vi.mock("@/lib/oauth/transport", async (original) => ({
  ...await original<typeof import("@/lib/oauth/transport")>(),
  oauthCallbackTransport: vi.fn().mockResolvedValue("web"),
}));
vi.mock("@/lib/api/http", async (original) => ({
  ...await original<typeof import("@/lib/api/http")>(),
  request: vi.fn(),
}));

import { auth } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import { getTokenSnapshot, request, setToken } from "@/lib/api/http";
import { useSocialProviders, type SocialProvidersResult } from "./useSocialProviders";
import { SocialButtons } from "@/components/common/SocialButtons";

const wire = (configured = true) => ({ providers: [
  { provider: "github", configured: false, web_reauthentication: true },
  { provider: "x", configured, web_reauthentication: false },
  { provider: "google", configured: false, web_reauthentication: false },
] });

let root: Root;
let host: HTMLDivElement;
let latest: SocialProvidersResult;
function Probe() {
  latest = useSocialProviders();
  return null;
}
async function mount(associate: boolean) {
  await act(async () => root.render(<MemoryRouter>
    <Probe /><SocialButtons associate={associate} />
  </MemoryRouter>));
}

beforeEach(async () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  Object.defineProperty(window, "location", { configurable: true, value: { protocol: "http:" } });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  vi.mocked(request).mockReset();
  setToken(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const associate of [false, true]) {
  describe(associate ? "association discovery" : "login discovery", () => {
    it("carries the current backend contract through API, hook and buttons", async () => {
      vi.mocked(request).mockResolvedValue(wire());
      await mount(associate);
      expect(latest.providers).toEqual(["x"]);
      expect(host.textContent).toContain(associate ? "Link X" : "Continue with X");
      expect(host.textContent).not.toMatch(/GitHub|Google|Retry/);
    });

    it("keeps all-disabled distinct from contract and transport failures and retries", async () => {
      vi.mocked(request).mockResolvedValue(wire(false));
      await mount(associate);
      expect(latest.error).toBeNull();
      expect(latest.providers).toEqual([]);
      expect(host.querySelector('[role="alert"]')).toBeNull();

      vi.mocked(request).mockResolvedValue({ x: true });
      await act(async () => setToken("refresh-contract"));
      expect(latest.error).toBeInstanceOf(Error);
      expect(latest.providers).toEqual([]);
      expect(host.textContent).not.toContain("coming soon");
      expect(host.textContent).toContain(associate ? "account-link options" : "sign-in options");

      vi.mocked(request).mockRejectedValue(new Error("offline"));
      await act(async () => host.querySelector('button')!.click());
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      vi.mocked(request).mockResolvedValue(wire());
      await act(async () => host.querySelector('button')!.click());
      expect(host.textContent).toContain(associate ? "Link X" : "Continue with X");
    });

    it("does not publish an OAuth result into a switched account", async () => {
      vi.mocked(request).mockResolvedValue(wire());
      setToken("initiating-account");
      const generation = getTokenSnapshot().generation;
      let resolve!: (value: never) => void;
      vi.spyOn(auth, "socialLogin").mockImplementation(() => new Promise((yes) => { resolve = yes; }));
      const publish = vi.fn();
      const previous = useSession.getState().setUser;
      useSession.setState({ setUser: publish });
      try {
        await mount(associate);
        await act(async () => host.querySelector('button')!.click());
        expect(auth.socialLogin).toHaveBeenCalledWith("x", { associate });
        await act(async () => {
          setToken("replacement-account");
          resolve({
            status: associate ? "associated" : "authenticated",
            sessionGeneration: generation,
            user: { username: "old-account" },
            session: { token: "old-result-token", user: { username: "old-account" } },
          } as never);
        });
        expect(publish).not.toHaveBeenCalled();
        expect(getTokenSnapshot().token).toBe("replacement-account");
      } finally {
        useSession.setState({ setUser: previous });
      }
    });

    it.each(["success", "failure"])("ignores late %s after A -> B -> A and hides retained readiness", async (outcome) => {
      setToken("account-a");
      vi.mocked(request).mockResolvedValue(wire());
      await mount(associate);
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const old = new Promise((yes, no) => { resolve = yes; reject = no; });
      vi.mocked(request).mockReturnValue(old);
      await act(async () => latest.reload());
      expect(latest.providers).toEqual([]);
      // Probe reloaded independently; the session transition below rechecks both.

      vi.mocked(request).mockResolvedValue(wire(false));
      await act(async () => { setToken("account-b"); setToken("account-a"); });
      await act(async () => {
        if (outcome === "success") resolve(wire());
        else reject(new Error("old session failed"));
      });
      expect(latest.providers).toEqual([]);
      expect(latest.error).toBeNull();
      expect(latest.loading).toBe(false);
      expect(host.querySelector('button')).toBeNull();
    });
  });
}
