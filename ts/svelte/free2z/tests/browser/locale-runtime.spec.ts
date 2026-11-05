import { expect, test } from "@playwright/test";

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
