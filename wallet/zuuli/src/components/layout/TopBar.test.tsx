import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import { TestI18nProvider } from "@/i18n/test-provider";
import type { SupportedLocale } from "@/i18n/locale";

function renderTopBar({
  pushed = false,
  route = pushed ? "/wallet/fund" : "/",
  locale = "en",
}: {
  pushed?: boolean;
  route?: string;
  locale?: SupportedLocale;
} = {}) {
  vi.stubGlobal("window", {
    history: { state: { idx: pushed ? 1 : 0 } },
  });

  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <TestI18nProvider locale={locale}>
        <TooltipProvider>
          <TopBar />
        </TooltipProvider>
      </TestI18nProvider>
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
    expect(markup.includes('aria-label="Go back"')).toBe(pushed);
  });

  /**
   * #904 phase 4: search moved to free2z with the route it entered. The shell
   * of the app that holds the seed hosts no query field, and the assertion is
   * written against the rendered markup rather than the import list so that
   * reintroducing the box under any name fails here.
   */
  it("hosts no search chrome anywhere in the vault shell", () => {
    for (const route of ["/wallet", "/wallet/fund", "/about"]) {
      const markup = renderTopBar({ pushed: true, route });

      expect(markup).not.toContain('role="search"');
      expect(markup).not.toContain('type="search"');
      expect(markup).not.toContain('href="/search"');
      expect(markup).not.toContain("placeholder=");
      expect(markup).toContain('aria-label="Go back"');
      expect(markup).toContain('aria-label="Log in"');
    }
  });

});
