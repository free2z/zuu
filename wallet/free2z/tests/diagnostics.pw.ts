import { expect, test } from "@playwright/test";

test("phone navigation opens a bounded frontend report with honest native status", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/login");
  await page.getByRole("link", { name: "Diagnostics", exact: true }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/diagnostics$/);
  await expect(page.locator("[data-native-diagnostics-state]")).toContainText("intentionally unavailable");
  await page.evaluate(() => { void Promise.reject(new Error("failed https://private.invalid /Users/alice/file.txt")); });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("free2z.diagnostics.v1"))).toContain("unhandled-rejection");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const report = page.locator("[data-diagnostics-report]");
  await expect(report).toContainText("unhandled-rejection");
  await expect(report).not.toContainText("private.invalid");
  await expect(report).not.toContainText("alice");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy report", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("frontend records only");
  await page.getByRole("button", { name: "Clear frontend records" }).click();
  await expect(report).toContainText("No failures");
});

test("a real storage quota failure leaves the production crash ring usable and bounded", async ({ page }) => {
  await page.goto("/diagnostics");
  const result = await page.evaluate(async () => {
    // Vite exposes the actual production module; no alternative capture implementation.
    const { diagnostics } = await import(/* @vite-ignore */ String("/src/lib/diagnostics.ts"));
    diagnostics.clear();
    let quota = false;
    try { for (let i = 0; i < 20; i++) localStorage.setItem(`quota-${i}`, "x".repeat(1024 * 1024)); }
    catch (error) { quota = error instanceof DOMException && error.name === "QuotaExceededError"; }
    // Fill the remainder too: a failed megabyte write can still leave enough
    // space for the entire diagnostics ring. Binary search reaches real quota.
    let lower = 0;
    let upper = 1024 * 1024;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      try { localStorage.setItem("quota-tail", "x".repeat(middle)); lower = middle + 1; }
      catch { upper = middle - 1; }
    }
    let writeRefused = false;
    try { localStorage.setItem("free2z.diagnostics.v1", "probe"); }
    catch (error) { writeRefused = error instanceof DOMException && error.name === "QuotaExceededError"; }
    try {
      for (let i = 0; i < 1000; i++) diagnostics.record("reported-error", new Error("failed " + "https://private.invalid ".repeat(100)));
      const count = diagnostics.events().length;
      const persisted = localStorage.getItem("free2z.diagnostics.v1")?.length ?? 0;
      localStorage.removeItem("quota-tail");
      // Prove capture recovers persistence after the actual browser quota is freed.
      for (let i = 0; i < 20; i++) localStorage.removeItem(`quota-${i}`);
      diagnostics.record("reported-error", new Error("Recovered"));
      return { quota, writeRefused, count, persisted, recovered: localStorage.getItem("free2z.diagnostics.v1")?.length ?? 0 };
    } finally {
      localStorage.removeItem("quota-tail");
      for (let i = 0; i < 20; i++) localStorage.removeItem(`quota-${i}`);
    }
  });
  expect(result.quota).toBe(true);
  expect(result.writeRefused).toBe(true);
  expect(result.persisted).toBe(0);
  expect(result.count).toBeGreaterThan(0);
  expect(result.count).toBeLessThanOrEqual(40);
  expect(result.persisted).toBeLessThanOrEqual(48000);
  expect(result.recovered).toBeGreaterThan(0);
  expect(result.recovered).toBeLessThanOrEqual(48000);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("[data-diagnostics-report]")).toContainText("Recovered");
});
