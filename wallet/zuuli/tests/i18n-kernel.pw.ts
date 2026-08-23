import { expect, test } from "@playwright/test";

test("browser locale loads only the normalized Spanish shell catalog", async ({
  browser,
}) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "es-MX",
    viewport: { width: 320, height: 568 },
  });
  const page = await context.newPage();
  const catalogRequests: string[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(
      /\/src\/i18n\/locales\/(en|es|fr)\.json$/,
    );
    if (match) catalogRequests.push(match[1]);
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  const navigation = page.getByRole("navigation", {
    name: "Navegación principal",
  });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Más navegación" }).click();
  await expect(page.getByRole("dialog")).toContainText("Más");
  await expect(page.getByText("2 destinos adicionales")).toBeAttached();
  expect(catalogRequests).toEqual(["es"]);
  await context.close();
});
test("saved French locale overrides the browser without exposing a control", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "es-ES" });
  await context.addInitScript(() => {
    window.localStorage.setItem("free2z-locale", "fr-CA");
  });
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(
    page.getByRole("navigation", { name: "Navigation de l'application" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Accueil" })).toBeVisible();
  await expect(page.getByRole("button", { name: /langue|language/i })).toHaveCount(
    0,
  );
  await context.close();
});
