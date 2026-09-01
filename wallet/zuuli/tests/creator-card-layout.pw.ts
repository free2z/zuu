import { expect, test } from "@playwright/test";

test("creator profile actions stay pinned to the card bottom when names wrap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/");

  const cards = page.locator('a[aria-label^="View "][aria-label$=" profile"]');
  await expect(cards).toHaveCount(6);

  const offsets = await cards.evaluateAll((items) =>
    items.map((card) => {
      const action = [...card.querySelectorAll("span")].find(
        (element) => element.textContent?.trim() === "View profile",
      );
      if (!(action instanceof HTMLElement)) {
        throw new Error("creator card is missing its View profile action");
      }
      const cardRect = card.getBoundingClientRect();
      const actionRect = action.getBoundingClientRect();
      return cardRect.bottom - actionRect.bottom;
    }),
  );

  for (const offset of offsets) {
    expect(offset).toBeGreaterThanOrEqual(15);
    expect(offset).toBeLessThanOrEqual(17);
  }
});
