import { expect, test } from "@playwright/test";

test("disabled locale cannot negotiate or appear in the selector", async ({
  page,
  context,
  request,
}) => {
  test.skip(
    process.env.PRIVATE_DISABLED_UI_LOCALES !== "fr",
    "requires French disabled",
  );
  await context.addCookies([
    {
      name: "free2z-locale",
      value: "fr",
      url: new URL("/", test.info().project.use.baseURL).href,
    },
    {
      name: "free2z-locale-retry",
      value: "fr",
      url: new URL("/", test.info().project.use.baseURL).href,
    },
  ]);
  const response = await request.get("/trending?lang=fr", {
    headers: { "accept-language": "fr,es;q=0.9" },
  });
  expect(await response.text()).toContain('<html lang="es"');
  await page.goto("/trending?lang=fr");
  await expect(page.locator("html")).not.toHaveAttribute("lang", "fr");
  const button = page.getByRole("button", {
    name: /^(Language|Idioma|Langue):/,
  });
  await button.click();
  await expect(page.getByText("Français", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Español", { exact: true })).toBeVisible();
});

test("English can be disabled as a selectable UI locale", async ({ page }) => {
  test.skip(
    process.env.PRIVATE_DISABLED_UI_LOCALES !== "en",
    "requires English disabled",
  );
  await page.goto("/trending?lang=en");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByRole("button", { name: /^Idioma:/ }).click();
  await expect(page.getByText("English", { exact: true })).toHaveCount(0);
});
