import { expect, test } from "@playwright/test";

test("creator moderation can be used by keyboard and managed from the account menu", async ({
  page,
}) => {
  let blocked = false;
  let reports = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown = { count: 0, next: null, results: [] };
    let status = 200;
    if (path === "/api/events/has/") data = false;
    else if (path === "/api/events/unread_count/") data = 0;
    else if (path === "/api/dyte/alice/live-status") data = {};
    else if (path === "/api/auth/user/")
      data = {
        id: 1,
        username: "reader",
        full_name: "Reader",
        tuzis: "10",
        stars: [],
        star_ids: [],
        fans: [],
        avatar_image: null,
        member_price: "1",
        zpages: 0,
      };
    else if (path === "/api/creator/alice/")
      data = {
        id: 2,
        username: "alice",
        full_name: "Alice",
        description: "Alice profile",
        is_verified: false,
        total: 0,
        p2paddr: "",
        zpages: 0,
        member_price: "1",
        can_stream: false,
        avatar_image: null,
        banner_image: null,
      };
    else if (path === "/api/g12f/blocks/mine/")
      data = {
        count: blocked ? 1 : 0,
        next: null,
        results: blocked ? [{ username: "alice" }] : [],
      };
    else if (path === "/api/creator/alice/block/") {
      blocked = request.method() === "PUT";
      data = { username: "alice", active: blocked };
    } else if (path === "/api/reports/") {
      reports++;
      data = {};
      status = 201;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/alice");
  const report = page.getByRole("button", { name: "Report", exact: true });
  await expect(report).toBeVisible();
  await expect(report).toHaveCSS("cursor", "pointer");
  await report.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(
    page.getByRole("status").getByText("Report sent.")
  ).toBeVisible();
  expect(reports).toBe(1);
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(
    page.getByText("Content hidden from a blocked account.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Logged in as reader" }).click();
  await page.getByRole("button", { name: "Blocked accounts" }).click();
  await page
    .getByRole("button", { name: "Unblock", exact: true })
    .last()
    .click();
  await expect(page.getByText("Alice profile")).toBeVisible();
});
