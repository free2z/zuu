/* eslint testing-library/prefer-screen-queries: off -- Playwright uses page locators. */
import { expect, test } from "@playwright/test";

test("creator carousel keeps interactive navigation after the Swiper update", async ({ page }) => {
  const creators = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    username: `carousel-${index}`,
    full_name: `Carousel Creator ${index}`,
    avatar_image: null,
    banner_image: null,
    member_price: null,
    is_active: true,
  }));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: path === "/api/auth/user/" ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify(path === "/api/creator/"
        ? { count: creators.length, results: creators }
        : { count: 0, results: [], detail: "Not authenticated" }),
    });
  });
  await page.goto("/");
  const carousel = page.locator(".swiper").filter({ has: page.locator('a[href="carousel-0"]') });
  const first = carousel.locator(".swiper-slide").first();
  await expect(first).toHaveClass(/swiper-slide-active/);
  await carousel.locator(".swiper-button-next").click();
  await expect(first).not.toHaveClass(/swiper-slide-active/);
  await carousel.locator(".swiper-button-prev").click();
  await expect(first).toHaveClass(/swiper-slide-active/);
});
