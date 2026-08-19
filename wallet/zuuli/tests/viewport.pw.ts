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

async function assertMobileHeader(page: Page, signedIn: boolean) {
  const header = page.locator("[data-app-top-bar]");
  await expect(header).toBeVisible();

  if (signedIn) {
    await expect(
      header.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    await expect(
      header.getByRole("link", { name: /Buy 2Zs\. Balance/ }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Log in", exact: true }),
    ).toHaveCount(0);
  } else {
    const login = header.getByRole("button", { name: "Log in", exact: true });
    await expect(login).toBeVisible();
    await expect(login).toHaveText("");
    await expect(header.getByRole("link", { name: /Buy 2Zs/ })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "Open wallet" })).toHaveCount(0);
    await expect(header).not.toContainText("2Z");
    await expect(header).not.toContainText("ZEC");

    const loginBox = await login.boundingBox();
    expect(loginBox, "anonymous Log in target must have a layout box").not.toBeNull();
    expect(
      loginBox!.width,
      "anonymous Log in target must be at least 44px wide",
    ).toBeGreaterThanOrEqual(44);
    expect(
      loginBox!.height,
      "anonymous Log in target must be at least 44px high",
    ).toBeGreaterThanOrEqual(44);
  }

  const metrics = await header.evaluate((element) => {
    const headerRect = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("a, button")]
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          height: rect.height,
          label:
            (control.getAttribute("aria-label") ?? control.innerText.trim()) ||
            control.tagName.toLowerCase(),
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
        };
      })
      .filter(({ height }) => height > 0);
    return {
      clientWidth: element.clientWidth,
      height: headerRect.height,
      scrollWidth: element.scrollWidth,
      controlCenters: controls.map(({ top, bottom }) => (top + bottom) / 2),
      undersizedControls: controls
        .filter(({ height, width }) => height < 44 || width < 44)
        .map(({ height, label, width }) => `${label}: ${width}x${height}`),
      controlsInside: controls.every(
        ({ top, bottom }) =>
          top >= headerRect.top - 1 && bottom <= headerRect.bottom + 1,
      ),
    };
  });

  expect(
    metrics.scrollWidth,
    "mobile header must not scroll horizontally",
  ).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.height, "mobile header must retain its 56px chrome row").toBe(
    56,
  );
  expect(
    metrics.controlsInside,
    "mobile header controls must stay inside the chrome row",
  ).toBe(true);
  expect(
    metrics.undersizedControls,
    "mobile header controls must retain 44px touch targets",
  ).toEqual([]);
  expect(
    Math.max(...metrics.controlCenters) - Math.min(...metrics.controlCenters),
    "mobile header controls must remain on one row",
  ).toBeLessThanOrEqual(1);
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

      if (width === 320) {
        await page.goto("/");
        await page.locator("[data-app-frame]").waitFor();
        await assertMobileHeader(page, signedIn);

        await page
          .locator("[data-app-top-bar]")
          .getByRole("link", { name: "Search", exact: true })
          .click();
        await expect(page).toHaveURL(/\/search$/);
        await assertMobileHeader(page, signedIn);

        if (signedIn) {
          await page.setViewportSize({ width: 640, height: 760 });
          const wallet = page.getByRole("link", { name: "Open wallet" });
          await expect(wallet).toBeVisible();
          await expect(wallet).toContainText("ZEC");
          await expect(wallet).not.toContainText("0.00");
          await page.setViewportSize({ width, height: 760 });
        }
      }

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

test("signed-out card checkout returns to Buy after login at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setSession(page, false);
  await page.goto("/buy");
  await page.locator("[data-app-frame]").waitFor();

  await page.getByRole("button", { name: "Sign in to buy" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Sign in to ZUULI", { exact: true })).toBeVisible();
  expect((await auditHorizontalLayout(page)).failures).toEqual([]);

  await page.getByLabel("Email or username").fill("checkout-return");
  await page.getByLabel("Password").fill("mock-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/buy$/);
  await expect(page.getByRole("button", { name: "Pay with card" })).toBeVisible();
  expect((await auditHorizontalLayout(page)).failures).toEqual([]);
});
