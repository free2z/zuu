import { expect, test, type Page } from "@playwright/test";
import {
  GUARD_WIDTHS,
  expectNoHorizontalScroll,
  splitWords,
} from "./mobile-layout-guards";
import { browserAppOrigin } from "./ports";

// Issue. The billing page never scrolled sideways, so the guard that
// exists for the profile dashboard would have called it fine — and on a 320px
// phone it rendered "SUBSCRI/PTIONS", "TRANSA/CTIONS", "BALANC/E" and a 2Z
// balance broken across three lines as "64,6 / 72.2 / 3".
//
// Two causes, both now removed:
//
// 1. The stat tiles kept the icon BESIDE the text at every width. At 320px the
//    tile is 144px, the icon chip and its gap take ~52px, and the label box is
//    then 92px against "SUBSCRIPTIONS" at 106px.
// 2. `[overflow-wrap:anywhere]` was applied to the value AND the label, so
//    instead of overflowing (which the existing clipping guard would have
//    caught) the copy quietly broke mid-word.
//
// The profile dashboard had already been fixed for exactly this in /
// and the two pages kept separate copies of the markup. They now share
// `$lib/components/dashboard/StatTile.svelte`, and this file guards the billing
// side of it.
//
// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
const BILLING_SESSION = "billing-fixture-session";
const BILLING_USER = "fixtureowner";
const BILLING_URL = `/${BILLING_USER}/dashboard/billing`;
//the page opens on Zcash; the card form is behind `?tab=stripe`.
// Both top-up tabs are measured, since each renders its own form.
const TOP_UP_TABS = [
  ["zcash", BILLING_URL],
  ["card", `${BILLING_URL}?tab=stripe`],
] as const;
const LAYOUT_CASES = TOP_UP_TABS.flatMap(([tab, url]) =>
  GUARD_WIDTHS.map((width) => [tab, url, width] as const),
);

async function authenticate(page: Page, session = BILLING_SESSION) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
    ]);
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  // The first dev-server page compiles the Svelte module graph. Warm it in an
  // isolated context so the first 320px layout assertion measures the page,
  // rather than spending its 30s test budget compiling and hydrating.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const appOrigin = browserAppOrigin();
  await page.goto(`${appOrigin}/`);
  await page.locator("nav kbd").waitFor();
  await context.close();
});

const STAT_IDS = [
  "billing-stat-balance",
  "billing-stat-subscriptions",
  "billing-stat-subscribers",
  "billing-stat-transactions",
] as const;

for (const [tab, url, width] of LAYOUT_CASES) {
  test(`billing (${tab} tab) lays out without clipping or word-breaking at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("billing-stats")).toBeVisible();

    await expectNoHorizontalScroll(page, `billing (${tab}) @ ${width}`);

    // Each tile fits its column...
    for (const id of STAT_IDS) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(
        box!.width,
        `${id} is wider than the viewport`,
      ).toBeLessThanOrEqual(width);
    }

    //...without clipping its own copy...
    const clipped = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-stat-text]"))
        .map((el) => ({
          text: (el.textContent || "").trim(),
          scrollWidth: el.scrollWidth,
          clientWidth: Math.ceil(el.getBoundingClientRect().width),
        }))
        .filter((m) => m.scrollWidth > m.clientWidth + 1),
    );
    expect(clipped, "no stat text may clip — UI copy never truncates").toEqual(
      [],
    );

    //...and without cutting a single word in half, which is what the page
    // actually did and what nothing above can see.
    expect(
      await splitWords(page, "[data-stat-text]"),
      "no stat word may be broken across lines",
    ).toEqual([]);

    // The guard only means anything while the tile holds the fixture balance:
    // an empty value breaks nothing at any width.
    await expect(page.getByTestId("billing-stat-balance")).toContainText(
      "64,672.23",
    );
    await expect(page.getByTestId("billing-stat-subscriptions")).toContainText(
      "Subscriptions",
    );
  });
}

test("a long username cannot run under a subscription's state badge", async ({
  page,
}) => {
  // At 320px `@mutation_target` overlapped the ACTIVE badge: the name column
  // was a flex item at its default `min-width: auto`, so it refused to shrink
  // and grew straight through its sibling. Usernames go to 150 characters.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(BILLING_URL);

  const name = page.getByRole("link", { name: "@mutation_target" }).first();
  await expect(name).toBeVisible();
  const card = page.locator("div.group").filter({ has: name }).last();
  const badge = card.locator("[data-slot=badge]").first();
  await expect(badge).toBeVisible();
  const nameBox = await name.boundingBox();
  const badgeBox = await badge.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(
    nameBox!.x + nameBox!.width,
    "the username must stop before the state badge starts",
  ).toBeLessThanOrEqual(badgeBox!.x + 1);
});

for (const [tab, url] of TOP_UP_TABS) {
  test(`the controls a thumb operates clear the 24px floor (${tab} tab)`, async ({
    page,
  }) => {
    // WCAG 2.2 SC 2.5.8 (AA). Every control inside a subscription card, measured
    // at the narrowest supported width where the cards are tightest.
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: "Update" }).first(),
    ).toBeVisible();

    const undersized = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'form button, form input[type="number"]',
        ),
      )
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: (
              el.textContent ||
              (el as HTMLInputElement).value ||
              ""
            ).trim(),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        })
        .filter((m) => m.width > 0 && (m.width < 24 || m.height < 24)),
    );
    expect(undersized, "every card control must be at least 24px").toEqual([]);
  });
}
