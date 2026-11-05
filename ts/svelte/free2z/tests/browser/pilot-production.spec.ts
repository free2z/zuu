import { expect, test } from "@playwright/test";
test.skip(
  process.env.PLAYWRIGHT_PRODUCTION !== "1",
  "requires production build",
);
test("unreviewed pilot cannot be selected in production", async ({
  page,
  request,
}) => {
  const response = await request.get("/trending?lang=ar", {
    headers: { "accept-language": "en" },
  });
  expect(await response.text()).toContain('<html lang="en"');
  await page.goto("/trending?lang=ar");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: /^Language:/ }).click();
  await expect(page.getByText("العربية (draft)", { exact: true })).toHaveCount(
    0,
  );
});
