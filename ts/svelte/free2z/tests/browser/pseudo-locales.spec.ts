import { expect, test } from "@playwright/test";

const enabled = process.env.FREE2Z_PSEUDO_TEST === "1";
test.skip(!enabled, "requires the explicit pseudo-locale test build");
for (const [tag, direction] of [
  ["en-XA", "ltr"],
  ["en-XB", "ltr"],
  ["ar-XB", "rtl"],
] as const) {
  for (const width of [390, 1280]) {
    test(`${tag} shell, sign-in and authenticated editor at ${width}px`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const response = await request.get(`/?lang=${tag}`);
      expect(response.ok()).toBeTruthy();
      const html = await response.text();
      expect(html).toContain(`<html lang="${tag}" dir="${direction}">`);
      await page.goto(`/?lang=${tag}`);
      await expect(page.locator("html")).toHaveAttribute("lang", tag);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBe(true);
      await expect(page.locator("body")).toContainText(
        tag === "en-XA" ? "[" : tag === "en-XB" ? "ë" : "⟦",
      );
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const path = "/src/lib/i18n.ts";
            const i18n = await import(/* @vite-ignore */ path);
            const displayPath = "/src/lib/intl-display.js";
            const display = await import(/* @vite-ignore */ displayPath);
            return [
              i18n.getCurrentLocale(),
              i18n.formatLocalizedNumber(1234.5),
              display.formatDisplayNumber(1234.5, i18n.getCurrentLocale()),
            ];
          }),
        )
        .toEqual([
          tag,
          new Intl.NumberFormat("en").format(1234.5),
          new Intl.NumberFormat("en").format(1234.5),
        ]);
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toBeVisible();
      await page.goto(`/login?lang=${tag}`);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await expect(page.locator("input").first()).toBeVisible();
      await page.context().addCookies([
        {
          name: "sessionid",
          value: "billing-fixture-session",
          domain: "127.0.0.1",
          path: "/",
        },
        { name: "free2z-locale", value: tag, domain: "127.0.0.1", path: "/" },
      ]);
      for (const path of [
        "/fixtureowner/dashboard/billing",
        "/fixtureowner/dashboard/settings",
        "/edit",
      ]) {
        const navigation = await page.goto(path);
        expect(navigation?.ok()).toBeTruthy();
        await expect(page.locator("html")).toHaveAttribute("dir", direction);
        if (path.endsWith("/settings"))
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        else
          await expect(
            page.getByTestId(
              path === "/edit" ? "editor-insert-trigger" : "billing-stats",
            ),
          ).toBeVisible();
        await expect(page.locator("body")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          )
          .toBe(true);
      }
    });
  }
}

test("RTL switch updates document direction and content language remains independent", async ({
  page,
}) => {
  await page.goto("/?lang=en");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const path = "/src/lib/i18n.ts";
        const i18n = await import(/* @vite-ignore */ path);
        return i18n.getCurrentLocale();
      }),
    )
    .toBe("en");
  for (const [tag, direction] of [
    ["en-XA", "ltr"],
    ["en-XB", "ltr"],
    ["ar-XB", "rtl"],
  ]) {
    await page.evaluate(async (next) => {
      const path = "/src/lib/i18n.ts";
      const i18n = await import(/* @vite-ignore */ path);
      await i18n.setLocale(next);
    }, tag);
    await expect(page.locator("html")).toHaveAttribute("lang", tag);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
  }
  await page.evaluate(async () => {
    const path = "/src/lib/i18n.ts";
    const i18n = await import(/* @vite-ignore */ path);
    i18n.setDocumentContentLanguage("en");
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("direction and overflow assertions reject deliberate defects", async ({
  page,
}) => {
  await page.goto("/?lang=ar-XB");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("dir", "rtl");
  const main = page.locator("main").first();
  await expect(main).toBeVisible();
  const fitsViewport = (width: number, viewport: number) =>
    width <= viewport + 1;
  expect(
    fitsViewport(
      await main.evaluate((node) => node.getBoundingClientRect().width),
      await page.evaluate(() => innerWidth),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.removeAttribute("dir");
    const probe = document.createElement("div");
    probe.id = "pseudo-overflow-negative-control";
    probe.style.width = `${innerWidth + 200}px`;
    document.body.append(probe);
  });
  await expect(root).not.toHaveAttribute("dir", "rtl");
  const probeWidth = await page
    .locator("#pseudo-overflow-negative-control")
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(fitsViewport(probeWidth, await page.evaluate(() => innerWidth))).toBe(
    false,
  );
  await page.evaluate(() => {
    document.querySelector("#pseudo-overflow-negative-control")?.remove();
    document.documentElement.dir = "rtl";
  });
  await expect(root).toHaveAttribute("dir", "rtl");
});

test("RTL sign-in controls expose names, keyboard focus and pointer states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login?lang=ar-XB");
  const buttons = page.locator("button:visible:enabled");
  expect(await buttons.count()).toBeGreaterThan(0);
  const button = buttons.first();
  await expect(button).toHaveCSS("cursor", "pointer");
  const name = await button.evaluate(
    (element) =>
      element.getAttribute("aria-label") ||
      element.textContent?.trim() ||
      element.getAttribute("title") ||
      "",
  );
  expect(name.trim()).not.toBe("");
  expect(
    await button.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  const disabled = page.locator("button:visible:disabled");
  for (let i = 0; i < (await disabled.count()); i++)
    await expect(disabled.nth(i)).not.toHaveCSS("cursor", "pointer");
});
