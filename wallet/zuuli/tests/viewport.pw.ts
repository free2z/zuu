import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [320, 360, 390, 414] as const;
const ROUTES = [
  "/",
  "/search",
  "/search?q=zcash",
  "/creator/skyl",
  "/profile",
  "/kyc",
  "/wallet",
  "/wallet/send",
  "/wallet/receive",
  "/wallet/history",
  "/ai",
  "/live",
  "/live/nine",
  "/articles",
  "/articles/new",
  "/articles/why-shielded-by-default",
  "/buy",
  "/does-not-exist",
  "/login",
] as const;

type HorizontalAudit = {
  boundary: { clientWidth: number; scrollWidth: number };
  content: { clientWidth: number; scrollWidth: number };
  failures: string[];
};

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
  }, signedIn);
}

async function auditHorizontalLayout(page: Page): Promise<HorizontalAudit> {
  return page.evaluate(() => {
    const genericContent = document.querySelector<HTMLElement>(
      "main.app-scroll-content",
    );
    const routeFrame = document.querySelector<HTMLElement>(
      "main[data-route-frame]",
    );
    const content = genericContent ?? routeFrame;
    if (!content) throw new Error("Route content frame is missing");

    const boundary = genericContent
      ? genericContent.closest<HTMLElement>("[data-scroll-area-viewport]")
      : routeFrame;
    if (!boundary) throw new Error("Route viewport boundary is missing");

    const boundaryRect = boundary.getBoundingClientRect();
    const tolerance = 1;
    const failures: string[] = [];

    function label(element: Element): string {
      const html = element as HTMLElement;
      const text = (
        element.getAttribute("aria-label") ??
        html.innerText ??
        element.textContent ??
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);
      const id = element.id ? `#${element.id}` : "";
      return `${element.tagName.toLowerCase()}${id}${text ? ` “${text}”` : ""}`;
    }

    function isLocallyScrollable(element: Element): boolean {
      for (
        let current = element.parentElement;
        current && current !== content.parentElement;
        current = current.parentElement
      ) {
        const style = getComputedStyle(current);
        if (
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          current.scrollWidth > current.clientWidth + tolerance
        ) {
          const rect = current.getBoundingClientRect();
          return (
            rect.left >= boundaryRect.left - tolerance &&
            rect.right <= boundaryRect.right + tolerance
          );
        }
        if (current === content) break;
      }
      return false;
    }

    for (const element of [content, ...content.querySelectorAll<HTMLElement>("*")]) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        element.classList.contains("sr-only")
      ) {
        continue;
      }
      if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") {
        continue;
      }
      if (
        element.getAttribute("aria-hidden") === "true" ||
        (style.pointerEvents === "none" && !element.textContent?.trim())
      ) {
        continue;
      }

      const outside =
        rect.left < boundaryRect.left - tolerance ||
        rect.right > boundaryRect.right + tolerance;
      if (outside && !isLocallyScrollable(element)) {
        failures.push(
          `${label(element)} bounds ${rect.left.toFixed(1)}..${rect.right.toFixed(1)} outside ${boundaryRect.left.toFixed(1)}..${boundaryRect.right.toFixed(1)}`,
        );
      }

      const scrollsHorizontally =
        element.clientWidth > 0 &&
        element.scrollWidth > element.clientWidth + tolerance;
      const isLocalOwner =
        style.overflowX === "auto" || style.overflowX === "scroll";
      const deliberatelyEllipsized =
        style.textOverflow === "ellipsis" ||
        element.classList.contains("truncate") ||
        Number.parseInt(style.webkitLineClamp, 10) > 0;
      const formControl = element.matches("input, textarea, select");
      if (
        scrollsHorizontally &&
        !isLocalOwner &&
        !isLocallyScrollable(element) &&
        !deliberatelyEllipsized &&
        !formControl
      ) {
        failures.push(
          `${label(element)} scrollWidth ${element.scrollWidth} exceeds clientWidth ${element.clientWidth}`,
        );
      }
    }

    return {
      boundary: {
        clientWidth: boundary.clientWidth,
        scrollWidth: boundary.scrollWidth,
      },
      content: {
        clientWidth: content.clientWidth,
        scrollWidth: content.scrollWidth,
      },
      failures: [...new Set(failures)].slice(0, 30),
    };
  });
}

for (const signedIn of [false, true]) {
  for (const width of WIDTHS) {
    test(`${signedIn ? "signed in" : "signed out"} routes fit at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 760 });
      await setSession(page, signedIn);

      for (const route of ROUTES) {
        await page.goto(route);
        await page.locator("[data-app-frame]").waitFor();
        await page.waitForTimeout(500);

        const audit = await auditHorizontalLayout(page);
        expect(
          audit.boundary.scrollWidth,
          `${route} route viewport must not acquire horizontal overflow`,
        ).toBeLessThanOrEqual(audit.boundary.clientWidth + 1);
        expect(
          audit.content.scrollWidth,
          `${route} route content must not acquire horizontal overflow`,
        ).toBeLessThanOrEqual(audit.content.clientWidth + 1);
        expect(audit.failures, `${route} has clipped descendants`).toEqual([]);

        if (route === "/live" && width === 320) {
          const filterTabs = await page.getByRole("tab").evaluateAll((tabs) =>
            tabs.map((tab) => {
              const rect = tab.getBoundingClientRect();
              return { height: rect.height, top: rect.top };
            }),
          );
          expect(filterTabs, "live filters must retain four touch targets").toHaveLength(4);
          expect(
            filterTabs.every(({ height }) => height >= 44),
            "live filter targets must remain at least 44px high",
          ).toBe(true);
          expect(
            new Set(filterTabs.map(({ top }) => Math.round(top))).size,
            "live filters must reflow into two rows at 320px",
          ).toBe(2);
        }
      }
    });
  }
}
