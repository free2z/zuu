import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

vi.mock("@/store/session", () => ({
  useSession: () => ({
    user: {
      username: "demo-creator",
      display_name: "Demo Creator",
      image: null,
    },
    tuzis: 4210,
    logout: vi.fn(),
  }),
}));

vi.mock("@/store/wallet", () => ({
  useWallet: (selector: (state: { balance: null }) => unknown) =>
    selector({ balance: null }),
}));

describe("TopBar signed-in account chrome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps money controls while rendering unknown ZEC as an em dash", () => {
    vi.stubGlobal("window", { history: { state: { idx: 0 } } });

    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <TooltipProvider>
          <TopBar />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(markup).toContain('href="/wallet"');
    expect(markup).toContain('aria-label="Open wallet"');
    expect(markup).toContain(">—</span>");
    expect(markup).toContain(">ZEC</span>");
    expect(markup).not.toContain("0.00");
    expect(markup).toContain('href="/wallet/fund"');
    expect(markup).toContain('aria-label="Buy 2Zs. Balance 4,210 2Z"');
    expect(markup).toContain('aria-label="Account menu"');
    expect(markup).not.toContain('aria-label="Log in"');
  });
});
