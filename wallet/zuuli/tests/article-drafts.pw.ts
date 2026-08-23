import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "zuuli.article-drafts.v1";

async function useSignedInSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

async function openComposer(page: Page) {
  await useSignedInSession(page);
  await page.goto("/articles/new");
  await expect(page).toHaveURL(/\/articles\/new\?draft=[a-zA-Z0-9_-]+$/);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
}

test("a pending local draft survives in-app navigation and reload", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await openComposer(page);
  const draftUrl = page.url();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  const content = page.getByLabel("Content (Markdown)");

  await title.fill("Crash-safe local draft");
  await content.fill("First paragraph");
  await expect(page.getByRole("status")).toContainText("Saved locally");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  // Leave during the debounce window. The internal-link guard flushes the
  // latest keystroke synchronously before React unmounts the composer.
  await content.fill("First paragraph\n\nLast-second sentence");
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(draftUrl);
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(title).toHaveValue("Crash-safe local draft");
  await expect(content).toHaveValue("First paragraph\n\nLast-second sentence");

  await page.reload();
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(title).toHaveValue("Crash-safe local draft");
  await expect(content).toHaveValue("First paragraph\n\nLast-second sentence");

  // Hard reload during the debounce window exercises the close/reload flush.
  await page.getByRole("textbox", { name: "Subtitle" }).fill("Saved on close");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Subtitle" })).toHaveValue(
    "Saved on close",
  );
});

test("publishing clears only that draft and leaves another account-scoped id", async ({
  page,
}) => {
  await openComposer(page);
  const firstUrl = page.url();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Keep me");
  await page.getByLabel("Content (Markdown)").fill("This draft stays local.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.getByRole("button", { name: "Start a new draft" }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Publish me");
  await page.getByLabel("Content (Markdown)").fill("This draft becomes an article.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/articles\/(?!new(?:\?|$))[^/?]+$/);
  await expect(page.getByRole("heading", { name: "Publish me" })).toBeVisible();

  const remaining = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).drafts : [];
  }, STORAGE_KEY);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].title).toBe("Keep me");

  await page.goto(firstUrl);
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
    "Keep me",
  );
});

test("discard explicitly removes the current local draft", async ({ page }) => {
  await openComposer(page);
  const draftId = new URL(page.url()).searchParams.get("draft");
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Discard me");
  await page.getByLabel("Content (Markdown)").fill("Temporary words.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard this draft" }).click();
  await expect(page).toHaveURL(/\/articles$/);

  const ids = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).drafts.map((draft: { id: string }) => draft.id) : [];
  }, STORAGE_KEY);
  expect(ids).not.toContain(draftId);
});
