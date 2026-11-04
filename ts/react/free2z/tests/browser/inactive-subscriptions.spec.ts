/* eslint testing-library/prefer-screen-queries: off -- Playwright uses page locators, not Testing Library. */
import { expect, test } from "@playwright/test";

const inactiveCreator = {
  id: 101,
  username: "state-inactive",
  is_active: false,
  avatar_image: null,
  p2paddr: "",
  full_name: "",
  member_price: null,
};
const legacyCreator = {
  id: 102,
  username: "legacy-active",
  // Older responses omitted is_active and must keep their normal actions.
  avatar_image: null,
  p2paddr: "t1legacycreator",
  full_name: "Legacy Creator",
  member_price: "10",
};
const inactiveFan = {
  id: 103,
  username: "fan-inactive",
  is_active: false,
  avatar_image: null,
  p2paddr: "",
  full_name: "",
  member_price: null,
};

test("deactivated subscription stays visible and cancellable without dead creator actions", async ({
  page,
}) => {
  let cancellationRequest: string | undefined;

  await page.addInitScript(() => {
    localStorage.setItem("global", JSON.stringify({ profileTab: 2 }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 1,
          username: "billing-user",
          full_name: "Billing User",
          tuzis: "50",
          stars: [],
          star_ids: [],
          fans: [],
          avatar_image: null,
          member_price: "1",
          zpages: 0,
        }),
      });
      return;
    }

    if (pathname === "/api/tuzis/my-subscriptions") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 2,
          results: [inactiveCreator, legacyCreator].map((star) => ({
            star,
            fan: {
              id: 1,
              username: "billing-user",
              is_active: true,
              avatar_image: null,
              p2paddr: "",
            },
            max_price: 10,
            expires: new Date(Date.now() + 86_400_000).toISOString(),
          })),
        }),
      });
      return;
    }

    if (pathname === "/api/tuzis/my-subscribers") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 1,
          results: [
            {
              star: {
                id: 1,
                username: "billing-user",
                is_active: true,
                avatar_image: null,
                p2paddr: "",
              },
              fan: inactiveFan,
              max_price: 10,
              expires: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
      });
      return;
    }

    if (pathname === "/api/events/has/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "false",
      });
      return;
    }

    if (pathname === "/api/events/unread_count/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "0",
      });
      return;
    }

    if (
      request.method() === "DELETE" &&
      pathname === "/api/tuzis/subscribe/state-inactive"
    ) {
      cancellationRequest = `${request.method()} ${pathname}`;
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto("/profile");
  const inactiveRow = page.locator("li").filter({ hasText: "state-inactive" });
  await expect(inactiveRow).toBeVisible();
  await expect(page.getByText("Inactive", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/creator's account is no longer active/i)
  ).toBeVisible();
  await expect(page.locator('a[href="/state-inactive"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fund Creator" })).toHaveCount(
    0
  );
  await expect(
    page.getByRole("button", { name: "subscription actions" })
  ).toHaveCount(1);

  await inactiveRow.getByRole("button", { name: "unsubscribe" }).click();
  await expect
    .poll(() => cancellationRequest)
    .toBe("DELETE /api/tuzis/subscribe/state-inactive");

  await page.getByRole("button", { name: "subscription actions" }).click();
  await expect(
    page.getByRole("button", { name: "Fund Creator" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "unsubscribe" })).toBeVisible();
  await expect(page.locator('a[href="/legacy-active"]')).toHaveCount(2);

  await page.keyboard.press("Escape");
  await page.getByRole("tab").nth(1).click();
  const inactiveFanRow = page.locator("li").filter({ hasText: "fan-inactive" });
  await expect(inactiveFanRow).toBeVisible();
  await expect(
    inactiveFanRow.getByText("Inactive", { exact: true })
  ).toBeVisible();
  await expect(
    inactiveFanRow.getByText(/subscriber's account is no longer active/i)
  ).toBeVisible();
  await expect(page.locator('a[href="/fan-inactive"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "subscriber actions" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fund Creator" })).toHaveCount(
    0
  );
});
