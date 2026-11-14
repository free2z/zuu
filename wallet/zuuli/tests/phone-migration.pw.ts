import { expect, test } from "@playwright/test";

const locales = [
  { locale: "en", title: "Move to a new phone", inventory: "Read this wallet’s metadata", verify: "Authenticate and check native wallet", incomplete: "Recovery is not verified.", error: "Recovery could not be verified.", recover: "Open native recovery" },
  { locale: "es", title: "Cambiar de teléfono", inventory: "Leer metadatos de esta cartera", verify: "Autenticar y comprobar cartera nativa", incomplete: "Recuperación no verificada.", error: "No se pudo verificar la recuperación.", recover: "Abrir recuperación nativa" },
  { locale: "fr", title: "Changer de téléphone", inventory: "Lire les métadonnées du portefeuille", verify: "S’authentifier et vérifier le portefeuille natif", incomplete: "Récupération non vérifiée.", error: "Impossible de vérifier la récupération.", recover: "Ouvrir la récupération native" },
];
for (const copy of locales) {
  test(`${copy.locale}: native phone recovery fails closed in a browser and never records success`, async ({ page }) => {
    await page.addInitScript((locale) => localStorage.setItem("free2z-locale", locale), copy.locale);
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto("/wallet/move");
    await expect(page.getByRole("heading", { name: copy.title, exact: true })).toBeVisible();
    const recover = page.getByRole("button", { name: copy.recover, exact: true });
    await expect(recover).toBeDisabled();
    await expect(recover).toHaveCSS("cursor", "default");
    const inventory = page.getByRole("button", { name: copy.inventory, exact: true });
    await expect(inventory).toHaveCSS("cursor", "pointer");
    for (const button of await page.locator("section button").all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await page.getByRole("button", { name: copy.inventory, exact: true }).click();
    // Reading the destination must not replace the expected source inventory.
    await expect(page.locator("#phone-metadata")).toHaveValue("");
    const source = await page.locator("textarea[readonly]").inputValue();
    await page.locator("#phone-metadata").fill(source);
    await expect(page.getByText(copy.incomplete, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: copy.verify, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(copy.error);
    await expect(page.getByText(copy.incomplete, { exact: false })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(2);
    await page.reload();
    await expect(recover).toBeDisabled();
    await expect(page.locator("#phone-metadata")).toHaveValue("");
  });
}

test("restored data without its device key reaches recovery on startup", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zuuli.mock.custody-state", "missingKey"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/wallet\/move$/);
  await expect(page.getByRole("heading", { name: "Move to a new phone", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create wallet", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("without usable device custody");
});


test("each seed identity can be selected without retaining another wallet's verification", async ({ page }) => {
  await page.goto("/wallet/move");
  const identities = page.getByLabel("Wallet identity", { exact: true });
  await expect(identities.locator("option")).toHaveCount(2);
  await identities.selectOption("mock-wallet-1");
  await expect(identities).toHaveValue("mock-wallet-1");
  await page.getByRole("button", { name: "Read this wallet’s metadata", exact: true }).click();
  await expect(page.locator("textarea[readonly]")).toHaveCount(1);
  await identities.selectOption("mock-wallet-0");
  await expect(identities).toHaveValue("mock-wallet-0");
  await expect(page.locator("textarea[readonly]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authenticate and check native wallet", exact: true })).toBeDisabled();
});
