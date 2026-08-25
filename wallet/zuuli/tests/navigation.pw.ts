import { expect, test, type Locator, type Page } from "@playwright/test";

const WIDTHS = [320, 360] as const;
const PRIMARY_IDS = ["home", "live", "ai", "wallet", "more"] as const;
const PRIMARY_LABELS = ["Home", "Live", "AI", "Wallet", "More"] as const;
const GERMAN_PRIMARY_LABELS = ["Start", "Live", "KI", "Wallet", "Mehr"] as const;

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
  }, signedIn);
}

async function primaryNavigation(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation).toBeVisible();
  return navigation;
}

async function expectFiveItemGeometry(
  navigation: Locator,
  expectedLabels: readonly string[] = PRIMARY_LABELS,
) {
  const controls = navigation.locator("[data-navigation-id]");
  await expect(controls).toHaveCount(5);
  expect(await controls.evaluateAll((items) => items.map((item) => item.dataset.navigationId))).toEqual(
    PRIMARY_IDS,
  );

  const geometry = await navigation.evaluate((element) => {
    const navRect = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("[data-navigation-id]")];
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      controls: controls.map((control) => {
        const rect = control.getBoundingClientRect();
        const label = control.querySelector<HTMLElement>("span");
        return {
          id: control.dataset.navigationId,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          inside: rect.left >= navRect.left - 0.5 && rect.right <= navRect.right + 0.5,
          labelClientWidth: label?.clientWidth ?? 0,
          labelScrollWidth: label?.scrollWidth ?? 0,
          labelWhiteSpace: label ? getComputedStyle(label).whiteSpace : "",
        };
      }),
    };
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.controls.every(({ width, height }) => width >= 44 && height >= 44)).toBe(
    true,
  );
  expect(geometry.controls.every(({ inside }) => inside)).toBe(true);
  expect(
    geometry.controls.every(
      ({ labelClientWidth, labelScrollWidth, labelWhiteSpace }) =>
        labelScrollWidth <= labelClientWidth && labelWhiteSpace === "nowrap",
    ),
  ).toBe(true);
  for (let index = 1; index < geometry.controls.length; index += 1) {
    expect(geometry.controls[index].left).toBeGreaterThanOrEqual(
      geometry.controls[index - 1].right - 0.5,
    );
  }

  const visibleLabels = await controls.evaluateAll((items) =>
    items.map((item) => item.querySelector("span")?.textContent?.trim()),
  );
  expect(visibleLabels).toEqual(expectedLabels);
}

for (const signedIn of [false, true]) {
  for (const width of WIDTHS) {
    test(`${signedIn ? "signed in" : "signed out"} five-item navigation works at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 760 });
      await setSession(page, signedIn);
      await page.goto("/");
      await page.locator("[data-app-frame]").waitFor();

      const navigation = await primaryNavigation(page);
      await expectFiveItemGeometry(navigation);
      await expect(navigation.getByLabel("Search", { exact: true })).toHaveCount(0);
      await expect(navigation.getByText("Buy", { exact: true })).toHaveCount(0);
      await expect(page.locator("[data-app-top-bar]").getByLabel("Search", { exact: true })).toBeVisible();

      await page.goto("/wallet/fund");
      await expect(
        navigation.locator('[data-navigation-id="wallet"]'),
      ).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "Wallet funding" })).toBeVisible();

      await page.goto("/buy?offer=standard#checkout");
      await expect(page).toHaveURL(/\/wallet\/fund\?offer=standard#checkout$/);
      await expect(
        navigation.locator('[data-navigation-id="wallet"]'),
      ).toHaveAttribute("aria-current", "page");

      await page.goto("/articles");
      const more = navigation.locator('[data-navigation-id="more"]');
      await expect(more).toHaveAttribute("aria-current", "page");
      await more.click();

      const dialog = page.getByRole("dialog", { name: "More" });
      await expect(dialog).toBeVisible();
      const dialogGeometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        };
      });
      expect(dialogGeometry.left).toBeGreaterThanOrEqual(0);
      expect(dialogGeometry.right).toBeLessThanOrEqual(
        dialogGeometry.viewportWidth,
      );
      expect(dialogGeometry.scrollWidth).toBeLessThanOrEqual(
        dialogGeometry.clientWidth,
      );
      const moreNavigation = dialog.getByRole("navigation", { name: "More navigation" });
      const rows = moreNavigation.getByRole("link");
      // Messaging is signed-in only, and CLIENT-CONTRACT.md §2.4 places it at
      // `{ area: "more", order: 0 }`. Articles already holds that order, so the
      // two tie and declaration order puts Messages second.
      const expectedNames = signedIn
        ? ["Articles", "Messages", "Edit profile", "Revenue share"]
        : ["Articles", "Log in"];
      await expect(rows).toHaveCount(expectedNames.length);
      for (const name of expectedNames) {
        await expect(moreNavigation.getByRole("link", { name })).toBeVisible();
      }
      await expect(
        moreNavigation.getByRole("link", { name: "Articles" }),
      ).toHaveAttribute("aria-current", "page");

      const rowSizes = await rows.evaluateAll((items) =>
        items.map((item) => {
          const rect = item.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      expect(rowSizes.every(({ width: rowWidth, height }) => rowWidth >= 44 && height >= 44)).toBe(
        true,
      );

      // Radix Dialog owns the focus trap. Exercise both ends of the loop,
      // Escape dismissal, and trigger focus restoration in the real browser.
      for (let index = 0; index < expectedNames.length + 3; index += 1) {
        await page.keyboard.press(index === 0 ? "Shift+Tab" : "Tab");
        expect(
          await dialog.evaluate((element) => element.contains(document.activeElement)),
          "focus must remain inside More",
        ).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(more).toBeFocused();
    });
  }
}

test("long localized accessible names do not change the 320px bar", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await setSession(page, false);
  await page.goto("/");
  const navigation = await primaryNavigation(page);
  await expectFiveItemGeometry(navigation);

  const names = await navigation.locator("[data-navigation-id]").evaluateAll((items) =>
    items.map((item, index) => {
      const name = `${index} — Zu diesem ausführlich lokalisierten Navigationsziel wechseln`;
      item.setAttribute("aria-label", name);
      return name;
    }),
  );
  for (const name of names) {
    await expect(navigation.getByLabel(name, { exact: true })).toBeVisible();
  }
  await expectFiveItemGeometry(navigation);
});

test("German proxy copy fits the signed-in chrome and Revenue share destination at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await setSession(page, true);
  await page.goto("/kyc");

  const navigation = await primaryNavigation(page);
  await navigation.locator("[data-navigation-id]").evaluateAll((items, labels) => {
    items.forEach((item, index) => {
      const label = item.querySelector<HTMLElement>("span");
      if (label) label.textContent = labels[index];
    });
  }, GERMAN_PRIMARY_LABELS);
  await expectFiveItemGeometry(navigation, GERMAN_PRIMARY_LABELS);

  const heading = page.getByRole("heading", { name: "Revenue share" });
  await expect(heading).toBeVisible();
  const headingGeometry = await heading.evaluate((element) => {
    element.textContent = "Umsatzbeteiligung für Kreative";
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(headingGeometry.left).toBeGreaterThanOrEqual(0);
  expect(headingGeometry.right).toBeLessThanOrEqual(headingGeometry.viewportWidth);
  expect(headingGeometry.scrollWidth).toBeLessThanOrEqual(headingGeometry.clientWidth);

  await navigation.locator('[data-navigation-id="more"]').click();
  const dialog = page.getByRole("dialog", { name: "More" });
  const rows = dialog.getByRole("navigation", { name: "More navigation" }).getByRole("link");
  await rows.evaluateAll((items, labels) => {
    items.forEach((item, index) => {
      const label = item.querySelector<HTMLElement>("span");
      if (label) label.textContent = labels[index];
    });
  }, ["Artikel", "Profil bearbeiten", "Umsatzbeteiligung"]);
  const germanGeometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("nav a")];
    return {
      left: rect.left,
      right: rect.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      rows: rows.map((row) => {
        const rowRect = row.getBoundingClientRect();
        return { left: rowRect.left, right: rowRect.right };
      }),
    };
  });
  expect(germanGeometry.left).toBeGreaterThanOrEqual(0);
  expect(germanGeometry.right).toBeLessThanOrEqual(germanGeometry.viewportWidth);
  expect(germanGeometry.scrollWidth).toBeLessThanOrEqual(germanGeometry.clientWidth);
  expect(
    germanGeometry.rows.every(
      ({ left, right }) => left >= germanGeometry.left && right <= germanGeometry.right,
    ),
  ).toBe(true);
});

test("conventional icon-only TopBar controls expose pointer tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await setSession(page, false);
  await page.goto("/");

  const topBar = page.locator("[data-app-top-bar]");
  for (const name of ["Search", "Log in"]) {
    await topBar
      .getByRole(name === "Search" ? "link" : "button", {
        name,
        exact: true,
      })
      .hover();
    await expect(page.getByRole("tooltip", { name })).toBeVisible();
    await expect(topBar.getByLabel(name, { exact: true })).toHaveAccessibleName(name);
    await expect(topBar.getByLabel(name, { exact: true })).not.toHaveAttribute(
      "aria-describedby",
    );
    await page.reload();
  }

  const navigation = await primaryNavigation(page);
  await navigation.locator('[data-navigation-id="more"]').click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Articles" }).click();
  const back = topBar.getByRole("button", { name: "Go back" });
  await back.hover();
  await expect(page.getByRole("tooltip", { name: "Go back" })).toBeVisible();
  await expect(back).toHaveAccessibleName("Go back");
  await expect(back).not.toHaveAttribute("aria-describedby");

  await setSession(page, true);
  await page.reload();
  const account = topBar.getByRole("button", { name: "Account menu" });
  await account.hover();
  await expect(page.getByRole("tooltip", { name: "Account menu" })).toBeVisible();
  await expect(account).toHaveAccessibleName("Account menu");
  await expect(account).not.toHaveAttribute("aria-describedby");
  await account.click();
  await expect(page.getByRole("menuitem", { name: "Revenue share" })).toBeVisible();
  await expect(page.getByRole("tooltip", { name: "Account menu" })).toBeHidden();

  await page.keyboard.press("Escape");
  await page.reload();
  for (let index = 0; index < 6 && !(await account.evaluate((element) => element === document.activeElement)); index += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(account).toBeFocused();
  expect(await account.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(
    await account.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.boxShadow !== "none" || style.outlineStyle !== "none";
    }),
  ).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Revenue share" })).toBeVisible();
  await expect(page.getByRole("tooltip", { name: "Account menu" })).toBeHidden();
});

test.describe("touch icon controls", () => {
  test.use({ hasTouch: true });

  test("search, back, and account menu act on the first touch", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await setSession(page, true);
    await page.goto("/");

    const topBar = page.locator("[data-app-top-bar]");
    await topBar.getByRole("button", { name: "Account menu" }).tap();
    await expect(page.getByRole("menuitem", { name: "Revenue share" })).toBeVisible();
    await page.keyboard.press("Escape");

    await topBar.getByRole("link", { name: "Search", exact: true }).tap();
    await expect(page).toHaveURL(/\/search$/);
    await topBar.getByRole("button", { name: "Go back" }).tap();
    await expect(page).toHaveURL(/\/$/);
  });
});

test("More sheet keeps controls inside native horizontal safe areas", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setSession(page, false);
  await page.goto("/");
  await page.addStyleTag({
    content: `:root {
      --safe-area-left: 17px !important;
      --safe-area-right: 19px !important;
      --safe-area-bottom: 11px !important;
    }`,
  });

  const navigation = await primaryNavigation(page);
  await navigation.locator('[data-navigation-id="more"]').click();
  const dialog = page.getByRole("dialog", { name: "More" });
  const close = dialog.getByRole("button", { name: "Close" });
  await expect
    .poll(() => dialog.evaluate((element) => element.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual(568);
  const geometry = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const closeButton = element.querySelector<HTMLElement>(
      '[aria-label="Close"], button:has(.sr-only)',
    );
    const closeRect = closeButton?.getBoundingClientRect();
    return {
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      closeRight: closeRect?.right ?? Number.POSITIVE_INFINITY,
      viewportWidth: document.documentElement.clientWidth,
      visualViewportHeight:
        window.visualViewport?.height ?? document.documentElement.clientHeight,
    };
  });

  await expect(close).toBeVisible();
  expect(geometry.paddingLeft).toBeGreaterThanOrEqual(33);
  expect(geometry.paddingRight).toBeGreaterThanOrEqual(35);
  expect(geometry.paddingBottom).toBeGreaterThanOrEqual(27);
  expect(geometry.closeRight).toBeLessThanOrEqual(geometry.viewportWidth - 19);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualViewportHeight);
});

test("grouped desktop navigation stays reachable in a short landscape viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 568 });
  await setSession(page, true);
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "App navigation" });
  const revenueShare = navigation.getByRole("link", {
    name: "Revenue share",
  });
  const metrics = await navigation.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));

  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThanOrEqual(metrics.clientHeight);
  await revenueShare.scrollIntoViewIfNeeded();
  await expect(revenueShare).toBeVisible();
  await expect(page.locator("[data-sidebar-footer]")).toHaveCount(0);
});
