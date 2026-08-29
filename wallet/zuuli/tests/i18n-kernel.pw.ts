import { expect, test } from "@playwright/test";

test("a failed locale chunk renders the dependency-free recovery frame", async ({
  page,
}) => {
  let documentRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === "document" && url.pathname === "/") {
      documentRequests += 1;
    }
  });
  await page.route(/\/src\/i18n\/locales\/en\.json(?:\?.*)?$/, (route) =>
    route.abort(),
  );

  await page.goto("/");

  const fallback = page.getByRole("alert");
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole("heading")).toHaveText(
    "Something went wrong",
  );
  await expect(fallback).toContainText(
    "ZUULI hit an unexpected error. Reloading usually fixes it.",
  );
  await expect(fallback.getByRole("button", { name: "Reload" })).toBeVisible();
  expect(
    await page.locator("#root").evaluate((root) => root.innerHTML.length),
  ).toBeGreaterThan(0);

  await fallback.getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => documentRequests).toBe(2);
  await expect(page.getByRole("alert")).toBeVisible();
});

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
  await expect(
    page.getByRole("button", { name: /langue|language/i }),
  ).toHaveCount(0);
  await context.close();
});
