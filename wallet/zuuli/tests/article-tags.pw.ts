import { expect, test, type Page } from "@playwright/test";

async function useSignedInSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

test("authored tags autocomplete and round-trip into reader filter links", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await useSignedInSession(page);
  await page.goto("/articles/new");

  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Open vocabulary tag round-trip");
  await page
    .getByLabel("Content (Markdown)")
    .fill("# Tagged end to end\n\nA deterministic mock publication.");

  const tagInput = page.getByRole("combobox", { name: "Tags" });
  await tagInput.focus();
  await expect(page.getByRole("option", { name: /#privacy/ })).toBeVisible();
  await page.getByRole("option", { name: /#privacy/ }).click();
  await expect(
    page.getByRole("button", { name: "Remove tag privacy" }),
  ).toBeVisible();

  await tagInput.fill("C++");
  await tagInput.press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove tag c++" }),
  ).toBeVisible();

  await tagInput.fill("PRIVACY");
  await tagInput.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "That tag is already added.",
  );
  await tagInput.fill("");

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByRole("heading", { name: "Open vocabulary tag round-trip" }),
  ).toBeVisible();

  const privacy = page.getByRole("link", { name: "#privacy" });
  const cpp = page.getByRole("link", { name: "#c++" });
  await expect(privacy).toBeVisible();
  await expect(cpp).toBeVisible();

  await cpp.click();
  await expect(page).toHaveURL(/\/articles\?tags=c%2B%2B$/);
  await expect(
    page.getByRole("heading", { name: "Open vocabulary tag round-trip" }),
  ).toBeVisible();
  await expect(
    page.getByText("1 article tagged c++", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "privacy" }).click();
  expect(new URL(page.url()).searchParams.get("tags")).toBe("c++,privacy");
  await expect(
    page.getByText("1 article tagged c++ + privacy", { exact: true }),
  ).toBeVisible();
});

test("a direct multi-tag Articles URL remains filtered across reload", async ({
  page,
}) => {
  await page.goto("/articles?tags=Privacy,zcash");

  const resultCount = page.locator("p.tabular-nums").filter({
    hasText: "tagged privacy + zcash",
  });
  await expect(resultCount).toBeVisible();
  const expected = await resultCount.textContent();
  await expect(page.locator("[data-article-card]").first()).toBeVisible();

  await page.reload();
  await expect(resultCount).toHaveText(expected ?? "");
  expect(new URL(page.url()).searchParams.get("tags")).toBe("Privacy,zcash");

  await page.getByRole("button", { name: "Clear tags" }).click();
  expect(new URL(page.url()).searchParams.has("tags")).toBe(false);
});
