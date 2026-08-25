import { expect, test } from "@playwright/test";

test("preserved wallet preview requires a click and renders only redacted inventory", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.mock.wallet-scenario", "legacy-import");
  });
  await page.goto("/");

  const notice = page.getByRole("status", { name: "Preserved legacy wallet" });
  await expect(notice).toContainText("Earlier wallet preserved");
  await expect(notice).not.toContainText("preserved wallets inspected");

  await notice.getByRole("button", { name: "Inspect preserved wallet" }).click();

  await expect(notice).toContainText("2 preserved wallets inspected");
  await expect(notice).toContainText("Multi-wallet layout");
  await expect(notice).toContainText("3 accounts");
  await expect(notice).toContainText("encrypted custody present for 1");
  await expect(notice).toContainText("SQLite sidecars present for 1");
  await expect(notice).toContainText("Browser fixture preview is read-only.");
  await expect(notice).not.toContainText("browser-fixture-secret-wallet");
  await expect(notice).not.toContainText("browser-fixture-secret-name");
  await expect(notice).not.toContainText("browser-fixture-secret-a.sqlite");
  await expect(notice).not.toContainText("browser-fixture-secret-fingerprint");
});
