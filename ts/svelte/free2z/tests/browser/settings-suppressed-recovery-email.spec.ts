import { expect, test } from "@playwright/test";

const USER = "fixtureowner";
const SETTINGS = `/${USER}/dashboard/settings`;
test.setTimeout(60_000);

test("an unmailed recovery address can be resent from settings", async ({
  page,
}) => {
  const resent: string[] = [];
  const added: string[] = [];
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: "retry@example.com",
        confirmed: false,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 8106, username: USER, full_name: "Fixture Owner" },
    }),
  );
  await page.route("**/api/emails/resend", (route) => {
    resent.push(route.request().postDataJSON().email);
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/emails/add", (route) => {
    added.push(route.request().postDataJSON().email);
    return route.fulfill({ status: 201, json: {} });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const accountTab = page.getByRole("tab", { name: "Account", exact: true });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("data-state", "active");

  await page.getByRole("button", { name: "Resend Confirmation" }).click();
  await expect.poll(() => resent.length).toBe(1);
  expect(resent).toEqual(["retry@example.com"]);

  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => resent.length).toBe(2);
  expect(added).toEqual([]);
});
