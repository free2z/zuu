import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * In-app report and block: the controls Play's UGC policy and Child
 * Safety Standards require, driven the way a reader uses them.
 */

// Same budget zpage-support-zcash.spec.ts uses: the first navigation after a
// cold dev server can spend most of the default 30s compiling.
test.setTimeout(90_000);

const ZPAGE_URL = "/boost-author/boost-a";
const ZPAGE_ADDR = "00000000-0000-4000-8000-000000000861";
const PROFILE_USER = "tagfilterfixture";

type Recorded = { method: string; path: string; body: unknown };

async function installApi(page: Page, initiallyBlocked = false) {
  const writes: Recorded[] = [];
  let blocked = initiallyBlocked;

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (pathname === "/api/auth/user/") {
      return fulfill(200, {
        id: 1749,
        username: "report-reader",
        full_name: "Report Reader",
        tuzis: "10",
      });
    }
    if (pathname === "/api/reports/" && request.method() === "POST") {
      writes.push({
        method: "POST",
        path: pathname,
        body: request.postDataJSON(),
      });
      return fulfill(201, {
        id: "11111111-1111-4111-8111-111111111111",
        created_at: "2026-10-04T00:00:00Z",
      });
    }
    if (pathname === `/api/creator/${PROFILE_USER}/block/`) {
      if (request.method() !== "GET") {
        writes.push({ method: request.method(), path: pathname, body: null });
        blocked = request.method() === "PUT";
      }
      return fulfill(200, { username: PROFILE_USER, active: blocked });
    }
    if (pathname === "/api/g12f/blocks/mine/") {
      return fulfill(200, {
        count: blocked ? 1 : 0,
        next: null,
        previous: null,
        results: blocked
          ? [{ username: PROFILE_USER, created_at: "2026-10-04T00:00:00Z" }]
          : [],
      });
    }
    return route.continue();
  });

  return writes;
}

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "report-block-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
});

test("a reader reports a zPage for child safety from the page action rail", async ({
  page,
}) => {
  const writes = await installApi(page);
  // Cold-start retry: the first navigation after the dev server boots can be
  // aborted by Vite's dependency re-optimisation reload (net::ERR_ABORTED),
  // the same artifact zpage-support-zcash.spec.ts handles this way.
  const trigger = page.locator(".page-action-trigger");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(ZPAGE_URL, { timeout: 25_000 });
      await trigger.waitFor({ timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  await page.mouse.move(0, 0);

  // The SSR trigger exists before hydration attaches its handler; retry the
  // keyboard activation until the rail actually opens rather than waiting on
  // network idle, which a cold dev server can hold open past the timeout.
  await expect
    .poll(
      async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.focus();
          await page.keyboard.press("Enter");
        }
        return trigger.getAttribute("aria-expanded");
      },
      { timeout: 20_000 },
    )
    .toBe("true");

  await page.getByTestId("page-action-report").click();
  const dialog = page.getByTestId("report-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("report-submit")).toBeDisabled();

  await page.getByTestId("report-reason-csae").check();
  await expect(page.getByTestId("report-csae-notice")).toBeVisible();
  await dialog.locator("#report-details").fill("Found in the comments.");
  await page.getByTestId("report-submit").click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Your report was sent to the Free2Z team"),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/reports/",
      body: {
        target_kind: "zpage",
        target_id: ZPAGE_ADDR,
        reason: "csae",
        details: "Found in the comments.",
      },
    },
  ]);
});

test("a reader blocks and unblocks an account from its profile", async ({
  page,
}) => {
  const writes = await installApi(page);
  await page.goto(`/${PROFILE_USER}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("profile-blocked-banner")).toHaveCount(0);

  const menu = page.getByTestId("profile-moderation-menu");
  await menu.click();
  await page.getByTestId("profile-block-toggle").click();
  await expect(page.getByTestId("block-confirm")).toBeVisible();
  await page.getByTestId("block-confirm-submit").click();

  await expect(page.getByTestId("profile-blocked-banner")).toBeVisible();
  // The profile list came from an SSR fetch without the reader's session,
  // so the client hides the cards itself.
  await expect(page.getByTestId("zpage-card-blocked").first()).toBeVisible();
  expect(writes).toEqual([
    { method: "PUT", path: `/api/creator/${PROFILE_USER}/block/`, body: null },
  ]);

  await menu.click();
  await expect(page.getByTestId("profile-block-toggle")).toContainText(
    `Unblock @${PROFILE_USER}`,
  );
  await page.getByTestId("profile-block-toggle").click();
  await expect(page.getByTestId("profile-blocked-banner")).toHaveCount(0);
  await expect(page.getByTestId("zpage-card-blocked")).toHaveCount(0);
  expect(writes.at(-1)).toEqual({
    method: "DELETE",
    path: `/api/creator/${PROFILE_USER}/block/`,
    body: null,
  });
});

test("an account blocked earlier is hidden on first load and its profile can be reported", async ({
  page,
}) => {
  const writes = await installApi(page, true);
  await page.goto(`/${PROFILE_USER}`);
  await expect(page.getByTestId("profile-blocked-banner")).toBeVisible();

  await page.getByTestId("profile-moderation-menu").click();
  await page.getByTestId("profile-report").click();
  await page.getByTestId("report-reason-harassment").check();
  await expect(page.getByTestId("report-csae-notice")).toHaveCount(0);
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-dialog")).toBeHidden();
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/reports/",
      body: {
        target_kind: "creator",
        target_id: PROFILE_USER,
        reason: "harassment",
      },
    },
  ]);
});
