import { expect, test, type Page } from "@playwright/test";
import { browserAppOrigin, browserMockApiOrigin } from "./ports";

//  apps don't sell 2Z: every "get 2Z" link lands on the billing page,
// where Zcash is offered first (and by default) and card second.
//
// Negative controls (each run on a tree that still builds): restore the old
// tab order and the first test fails on the tab order; restore the
// `"stripe"` default and it fails on the selected tab and the missing QR;
// drop the Card fallback and "an unavailable Zcash opens Card" fails; drop the
// `{#if returningApp}` line and the app test fails.

const BILLING = "/fixtureowner/dashboard/billing";

const capabilities = {
  policy_version: 1,
  active: true,
  creator_compensation_available: true,
  zec_funding_method: {
    version: "zec-funding-v3",
    digest: "synthetic-v3-digest",
    text: "Credits use actual received ZEC after three confirmations at the current processing price, with no settlement spread. Estimates do not reserve a rate or impose a payment deadline.",
  },
};

async function zcashAvailable(page: Page) {
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "200000000",
          remaining_sale_nusd: "10000000000000",
        },
      },
    }),
  );
  await page.route("**/api/economy/capabilities/", (route) =>
    route.fulfill({ json: capabilities }),
  );
}

async function zcashUnavailable(page: Page) {
  await page.route("**/api/economy/capabilities/", (route) =>
    route.fulfill({ status: 503, json: { detail: "unavailable" } }),
  );
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  // The first dev-server page compiles the Svelte module graph (and may
  // reload once for a dependency optimisation). Warm it in an isolated
  // context so the first assertion measures the page, not the compiler.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Explicit: Playwright applies `test.use` options to this context too,
    // and the no-JS group below would otherwise never see the nav render.
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  await page.goto(`${browserAppOrigin()}/`);
  await page.locator("nav kbd").waitFor();
  await context.close();
});

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-11T18:55:01Z") });
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: {
        zec_usd: "100.00",
        spread: "0.00",
        tuzis_per_zec: "10000.0000",
        estimate_buffer: "0.10",
        estimated_tuzis_per_zec: "9000.0000",
        tuzi_per_usd: 100,
        usd_per_tuzi: "0.01",
        num_sources: 2,
        sources: { synthetic: "100.00" },
        updated_at: "2026-10-11T18:55:00Z",
        stale: false,
        card: { percent_fee: "0.10", min_fee_cents: 50 },
      },
    }),
  );
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
});

const topUpTabs = (page: Page) =>
  page
    .getByRole("tablist")
    .filter({ has: page.getByRole("tab", { name: "Card", exact: true }) });

test("Zcash is the first tab and its QR shows by default", async ({ page }) => {
  await zcashAvailable(page);
  await page.goto(BILLING);
  const tabs = topUpTabs(page).getByRole("tab");
  await expect(tabs).toHaveText(["Zcash", "Card"]);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: "Stripe", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect(page.locator("#quantity")).toBeHidden();
});

for (const tab of ["stripe", "card"]) {
  test(`?tab=${tab} still opens the card tab`, async ({ page }) => {
    await zcashAvailable(page);
    await page.goto(`${BILLING}?tab=${tab}`);
    await expect(
      page.getByRole("tab", { name: "Card", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#quantity")).toBeVisible();
  });
}

test("an unavailable Zcash opens Card when no tab was asked for", async ({
  page,
}) => {
  await zcashUnavailable(page);
  await page.goto(BILLING);
  await expect(
    page.getByRole("tab", { name: "Card", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#quantity")).toBeVisible();
  // Zcash is still offered first, one click away, with its own state.
  await page.getByRole("tab", { name: "Zcash", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry payment instructions" }),
  ).toBeVisible();
});

test("an app's deep link falls back to Card too when Zcash is unavailable", async ({
  page,
}) => {
  // /buy-2z with no method writes no tab, so the page is undecided and may
  // fall back; `tab=zcash` there would pin the visitor to the Retry state.
  await zcashUnavailable(page);
  await page.goto("/buy-2z?client_id=aha-ios");
  await expect(page).toHaveURL(`${BILLING}?app=aha-ios`);
  await expect(
    page.getByRole("tab", { name: "Card", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("return-to-app")).toBeVisible();
  // The card checkout carries the app back from Stripe (its return path).
  await expect(page.locator('form input[name="app"]')).toHaveValue("aha-ios");
});

test("an explicit ?tab=zcash keeps Zcash even when it is unavailable", async ({
  page,
}) => {
  await zcashUnavailable(page);
  const refused = page.waitForResponse("**/api/economy/capabilities/");
  await page.goto(`${BILLING}?tab=zcash`);
  await refused;
  // "Never switches" needs a window: the Retry state renders before the
  // first check even answers, so asserting at once would pass whether or not
  // the fallback later fires. Without the URL choice, the switch lands within
  // milliseconds of this response (the test above); give it a full second.
  await page.waitForTimeout(1000);
  await expect(
    page.getByRole("tab", { name: "Zcash", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Retry payment instructions" }),
  ).toBeVisible();
});

test("an app's visitor sees one neutral line, with no link and no app name", async ({
  page,
}) => {
  await zcashAvailable(page);
  await page.goto(
    "/buy-2z?client_id=evil-app-name&return=https%3A%2F%2Fevil.example",
  );
  await expect(page).toHaveURL(`${BILLING}?app=evil-app-name`);
  const line = page.getByTestId("return-to-app");
  await expect(line).toHaveText(
    "When you're done, go back to your app. It will pick up your new balance once your payment is credited.",
  );
  await expect(line.locator("a")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("evil-app-name");
  // The id rides along in same-page links (pagination) so the line
  // survives them; nothing on the page leads off-site to the caller's URL.
  await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
});

test("no app, or an unusable one, shows no line", async ({ page }) => {
  await zcashAvailable(page);
  await page.goto(BILLING);
  await expect(
    page.getByRole("tab", { name: "Zcash", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("return-to-app")).toHaveCount(0);
  await page.goto(`${BILLING}?app=${"x".repeat(256)}`);
  await expect(
    page.getByRole("tab", { name: "Zcash", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("return-to-app")).toHaveCount(0);
});

test.describe("before hydration", () => {
  test.use({ javaScriptEnabled: false });

  test("a card checkout posted without JS comes back on the Card tab", async ({
    page,
  }) => {
    await fetch(`${browserMockApiOrigin()}/__billing/reset`, {
      method: "POST",
    });
    await page.goto(`${BILLING}?tab=stripe&app=aha-ios`);
    await page.locator("#quantity").fill("2");
    await page.getByRole("button", { name: "Review exact charge" }).click();
    await expect(page).toHaveURL(/[?&]tab=stripe(&|$)/);
    await expect(page).toHaveURL(/[?&]app=aha-ios(&|$)/);
    // The response page opens on the Card tab (the quote itself needs JS);
    // a bare `?/checkout` action would reopen on Zcash and hide the form.
    await expect(
      page.getByRole("tab", { name: "Card", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#quantity")).toBeVisible();
  });
});
