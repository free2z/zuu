import { expect, test } from '@playwright/test';

// Text can overlap a neighboring grid cell without widening the document.
// Measure the painted text range, not the constrained span's own box.
test('phone navigation labels stay inside their own destinations', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/articles');
  const navigation = page.locator('[data-app-bottom-nav]');
  await expect(navigation).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const labels = await navigation.locator('a').evaluateAll((links) => links.map((link) => {
    const span = link.querySelector('span[aria-hidden]')!;
    const range = document.createRange();
    range.selectNodeContents(span);
    const text = range.getBoundingClientRect();
    const cell = link.getBoundingClientRect();
    return { label: span.textContent, left: text.left, right: text.right, cellLeft: cell.left, cellRight: cell.right };
  }));
  expect(labels.length).toBeGreaterThan(1);
  for (const [index, label] of labels.entries()) {
    expect(label.left, `${label.label} spills left of its destination`).toBeGreaterThanOrEqual(label.cellLeft);
    expect(label.right, `${label.label} spills right of its destination`).toBeLessThanOrEqual(label.cellRight);
    if (index > 0) expect(labels[index - 1].right, `adjacent labels overlap: ${labels[index - 1].label} / ${label.label}`).toBeLessThanOrEqual(label.left);
  }
});
