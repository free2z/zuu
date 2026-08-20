import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

function renderTopBar({
  pushed = false,
  route = pushed ? "/wallet/fund" : "/",
}: {
  pushed?: boolean;
  route?: string;
} = {}) {
  vi.stubGlobal("window", {
    history: { state: { idx: pushed ? 1 : 0 } },
  });

  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <TooltipProvider>
        <TopBar />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("TopBar account chrome", () => {
  beforeEach(() => {
    useSession.setState({ user: null, tuzis: 0, loading: false });
    useWallet.setState({ balance: null, loading: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["root", false],
    ["pushed route", true],
  ])("shows no invented anonymous money state on the %s", (_name, pushed) => {
    const markup = renderTopBar({ pushed });

    expect(markup).toContain('aria-label="Log in"');
    expect(markup).not.toContain("Login with Zcash");
    expect(markup).not.toContain("0 2Z");
    expect(markup).not.toContain("0.00");
    expect(markup).not.toContain('href="/wallet/fund"');
    expect(markup).not.toContain('href="/wallet"');
    expect(markup).toContain('aria-label="Search"');
    expect(markup.includes('aria-label="Go back"')).toBe(pushed);
  });

  it("yields all search chrome to the route while /search is active", () => {
    const markup = renderTopBar({ pushed: true, route: "/search?q=zcash" });

    expect(markup).not.toContain('role="search"');
    expect(markup).not.toContain('aria-label="Search"');
    expect(markup).toContain('aria-label="Go back"');
    expect(markup).toContain('aria-label="Log in"');
  });
});
