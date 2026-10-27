import { expect, test, type Page } from "@playwright/test";
import { GUARD_WIDTHS, expectNoHorizontalScroll } from "./mobile-layout-guards";

// Issue. Three defects on this page, none of which the document-width
// guards could see:
//
// 1. `saveError` and `saveSuccess` were rendered only inside a
//    `hidden lg:flex` container. Below 1024px — every phone — a failed save
//    produced NO message at all: the spinner stopped and nothing had been
//    written.
// 2. "Save Changes" lived in the page header, ~200px into a form that is
//    2,200px tall on a phone, so saving meant scrolling back to the top.
// 3. The avatar and banner uploaders were `opacity-0 hover:opacity-100`
//    overlays. Touch produces no hover, so on a phone the only way to find
//    them was to tap an unmarked rectangle.
//
// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
const SESSION = "billing-fixture-session";
const USER = "fixtureowner";
const SETTINGS_URL = `/${USER}/dashboard/settings`;

async function authenticate(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

for (const width of GUARD_WIDTHS) {
  test(`settings lays out without horizontal scroll at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(SETTINGS_URL);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page, `settings @ ${width}`);
  });
}

test("the save action stays reachable at the bottom of the form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);

  const dock = page.getByTestId("settings-mobile-actions");
  await expect(dock).toBeVisible();
  await expect(dock).toBeInViewport();

  // Everywhere inside the form. The header's copy of the button leaves the
  // viewport within ~250px; the dock must not.
  const formBottom = await page.evaluate(() => {
    // The dock's own rect is useless here — it is `sticky`, so while it is
    // stuck its rect reports the viewport bottom no matter where you are in
    // the document. Measure the container it sticks inside.
    const el = document.querySelector<HTMLElement>(
      '[data-testid="settings-mobile-actions"]',
    );
    const container = el?.parentElement;
    return container
      ? container.getBoundingClientRect().bottom + window.scrollY
      : 0;
  });
  expect(formBottom, "the form must be taller than one screen").toBeGreaterThan(
    900,
  );

  for (const fraction of [0.25, 0.5, 0.9]) {
    await page.evaluate((y) => window.scrollTo(0, y), formBottom * fraction);
    await page.waitForTimeout(150);
    await expect(
      page.getByTestId("settings-save-mobile"),
      `the save button must be on screen ${fraction * 100}% down the form`,
    ).toBeInViewport();
  }

  // `sticky`, not `fixed`: it rides the viewport bottom through the form and
  // then lands in flow above the footer, rather than covering it forever.
  const position = await dock.evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("sticky");
});

test("the save dock rides above whatever else is docked at the bottom", async ({
  page,
}) => {
  // `ClassicUiBanner` is `fixed` at the bottom at z-40 for eight seconds on
  // the production hosts and publishes its height as
  // `--f2z-bottom-dock-height`; `PageActions` already lifts by it. It is never
  // shown on 127.0.0.1 — `classicUiAvailable()` is host-gated — so no test can
  // instantiate it and the variable has to be driven directly. Without this the
  // banner covers the only mobile Save/Discard controls on the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);

  const dock = page.getByTestId("settings-mobile-actions");
  await expect(dock).toBeVisible();
  // The tab panel below the dock is filled in on hydration; measuring before
  // that lands compares two different layouts.
  await page.waitForLoadState("networkidle");
  const restingBottom = await dock.evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );

  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--f2z-bottom-dock-height",
      "96px",
    ),
  );
  await page.waitForTimeout(150);
  const liftedBottom = await dock.evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );

  expect(
    restingBottom - liftedBottom,
    "the dock must lift by the published dock height",
  ).toBeCloseTo(96, 0);
});

test("the desktop header keeps its own actions and the dock is hidden", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SETTINGS_URL);

  await expect(page.getByTestId("settings-mobile-actions")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Save Changes" }),
  ).toBeVisible();
});

test("a failed save reports itself on a phone", async ({ page }) => {
  // The regression this guards is silence: the page used to swallow the error
  // entirely below `lg`, which is worse than a bad message.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);
  // The button is server-rendered before its handler exists; clicking a
  // pre-hydration button is a no-op and the failure looks exactly like the bug.
  await page.waitForLoadState("networkidle");

  await page.route(
    (url) => url.pathname === "/api/auth/user/",
    (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: "{}",
          })
        : route.continue(),
  );

  await page.getByTestId("settings-save-mobile").click();
  const error = page.getByTestId("settings-save-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toBeInViewport();
});

test("the image uploaders are visible and tappable without hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);

  for (const name of ["Upload avatar", "Upload banner image"]) {
    // `getByLabel` resolves the file input; the visible control is its label.
    const input = page.getByLabel(name);
    await expect(input).toHaveCount(1);
    const control = page.locator("label", { has: input });
    await expect(
      control,
      `${name} must be visible without hover`,
    ).toBeVisible();
    const box = await control.boundingBox();
    expect(box, name).not.toBeNull();
    // WCAG 2.2 SC 2.5.8 is 24px; these are deliberately 44.
    expect(box!.width, `${name} tap target`).toBeGreaterThanOrEqual(24);
    expect(box!.height, `${name} tap target`).toBeGreaterThanOrEqual(24);
    // And they must be visible in their resting state, not only on hover.
    const opacity = await control.evaluate(
      (el) => getComputedStyle(el).opacity,
    );
    expect(Number(opacity), `${name} must not be transparent`).toBeGreaterThan(
      0.5,
    );
  }
});

test("the direct-support address caution is readable without hovering anything", async ({
  page,
}) => {
  // It used to live in a tooltip hung off a 12px icon: half the 24px target
  // floor, and tooltip content opens on hover, which touch never produces. The
  // warning is that saving rewrites the direct-support address on EVERY existing
  // article — not something to hide behind an interaction.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);

  await expect(
    page.getByText(
      "This updates the direct support address on all existing articles. Confirm it is the intended wallet.",
      { exact: false },
    ),
  ).toBeVisible();
});
