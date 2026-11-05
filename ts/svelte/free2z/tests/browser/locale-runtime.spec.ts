import { expect, test, type Page } from "@playwright/test";

async function waitForHydration(page: Page) {
  await expect
    .poll(async () => {
      if (await page.getByText("Español", { exact: true }).isVisible())
        return true;
      await page.getByRole("button", { name: /^Language:/ }).click();
      return page.getByText("Español", { exact: true }).isVisible();
    })
    .toBe(true);
  await page.keyboard.press("Escape");
}

test("French server render hydrates and can switch language", async ({
  page,
  request,
}) => {
  const response = await request.get("/trending?lang=fr");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('<html lang="fr"');
  expect(html).toContain("Centre d’aide");
  await page.goto("/trending?lang=fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByText("Centre d’aide").first()).toBeVisible();
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: /Langue: Français/i }).click();
      return page.getByText("English", { exact: true }).isVisible();
    })
    .toBe(true);
  await page.getByText("English", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Help center").first()).toBeVisible();
});

test("client navigation reconciles query locale and browser history", async ({
  page,
}) => {
  await page.goto("/trending?lang=en");
  await waitForHydration(page);
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/trending?lang=fr";
    a.textContent = "Go French";
    a.id = "locale-test-link";
    (window as any).__navigationMarker = true;
    document.body.append(a);
  });
  await page.locator("#locale-test-link").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByText("Centre d’aide").first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__navigationMarker)).toBe(
    true,
  );
  await page.goBack();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Help center").first()).toBeVisible();
  await page.goForward();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("a later switch owns the locale when navigation data arrives late", async ({
  page,
}) => {
  await page.goto("/trending?lang=en");
  await waitForHydration(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/trending/__data.json*", async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/trending?lang=fr";
    a.textContent = "French link";
    document.body.append(a);
  });
  await page.getByText("French link").click({ noWaitAfter: true });
  await requested;
  const switched = await page.evaluate(async () => {
    const p = "/src/lib/i18n.ts";
    return (await import(/* @vite-ignore */ p)).setLocale("es");
  });
  expect(switched).toBe(true);
  release();
  await expect(page).toHaveURL(/lang=fr/);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect
    .poll(() => page.evaluate(() => document.cookie))
    .toContain("free2z-locale=es");
});

test("new deployment policy reconciles a disabled active locale", async ({
  page,
}) => {
  await page.goto("/trending?lang=en");
  await waitForHydration(page);
  await page.evaluate(async () => {
    const p = "/src/lib/i18n.ts";
    const i = await import(/* @vite-ignore */ p);
    const owner = i.captureLocaleNavigation();
    await i.prepareLocale("fr");
    i.hydrateLocale("fr", i.getPreparedCatalogs("fr"), ["en"], owner);
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByText("Centre d’aide").first()).toBeVisible();
});
