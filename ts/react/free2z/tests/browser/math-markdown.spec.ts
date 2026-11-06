import { expect, test } from "@playwright/test";

test("creator Markdown renders an equation in the production browser bundle", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const creator = {
      id: 2,
      username: "equations",
      full_name: "Equations",
      description: "A right triangle satisfies $x^2 + y^2 = z^2$.",
      is_verified: false,
      total: 0,
      p2paddr: "",
      zpages: 0,
      member_price: "1",
      can_stream: false,
      avatar_image: null,
      banner_image: null,
    };
    await route.fulfill({
      status: path === "/api/auth/user/" ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        path === "/api/creator/equations/"
          ? creator
          : { count: 0, next: null, results: [] }
      ),
    });
  });
  await page.goto("/equations");
  const equation = page.locator("mjx-container svg");
  await expect(equation).toBeVisible();
  await expect(equation.locator('[data-mml-node="msup"]')).toHaveCount(3);
  expect(errors).toEqual([]);
});
