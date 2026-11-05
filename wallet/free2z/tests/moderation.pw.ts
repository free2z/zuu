import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
}

async function report(
  page: import("@playwright/test").Page,
  button: import("@playwright/test").Locator,
) {
  await expect(button).toHaveCSS("cursor", "pointer");
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Report" })).toBeVisible();
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report sent.")).toBeVisible();
}

test("article card, reader, comment and creator expose report and block", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/articles");
  const card = page.locator("[data-article-card]").first();
  await expect(card).toBeVisible();
  await report(page, card.getByRole("button", { name: "Report" }));
  await page.goto("/articles/why-shielded-by-default");
  await expect(
    page.getByRole("heading", { name: /shielded/i }).first(),
  ).toBeVisible();
  await report(page, page.getByRole("button", { name: "Report" }).first());
  const comments = page.locator("section[aria-labelledby='comments-heading']");
  await expect(
    comments.getByRole("button", { name: "Report" }).first(),
  ).toBeVisible();
  await report(page, comments.getByRole("button", { name: "Report" }).first());
  await page.goto("/creator/zooko");
  await report(page, page.getByRole("button", { name: "Report" }).first());
  const block = page
    .getByRole("button", { name: "Block", exact: true })
    .first();
  await expect(block).toBeEnabled();
  await block.click();
  await expect(
    page.getByText("Content hidden from a blocked account."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Blocked accounts" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("@zooko")).toBeVisible();
  await dialog.getByRole("button", { name: "Unblock" }).click();
  await expect(dialog.getByText("No blocked accounts.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-creator-profile]")).toBeVisible();
});
