import { expect, test, type Page } from "@playwright/test";
import { GUARD_WIDTHS, splitWords } from "./mobile-layout-guards";

// The owner's report against https://free2z.cash/free2z/dashboard/profile:
// the page scrolled sideways on a phone, the "2Z" number was a raw 8-decimal
// string of the wrong quantity, the stat tiles were inert, and the drafts you
// were told you had were nowhere to be found on mobile.
//
// Two distinct causes, both measured, both asserted here:
//
// 1. The stats row is a grid, grid items default to `min-width: auto`, and the
//    2Z tile's min-content width was 234px. Two columns of that needed 516px on
//    a 390px viewport.
// 2. The zpage row container is `flex flex-col items-start... sm:flex-row`.
//    `align-items: flex-start` sizes children to FIT-CONTENT on the cross
//    (horizontal) axis, so the nowrap `<h3 class="truncate">` inside it set the
//    row's width to the full title length — 479px inside a 254px parent, and
//    801px of document at a 386px viewport. `min-w-0`/`flex-1` are powerless
//    there: they govern the vertical main axis.
//
// The first attempt at this fix  missed (2) because its fixture titles
// were 21 characters long — short enough to fit whatever the container did — so
// the suite passed against a page that still overflowed by 415px in production.
// The fixture now carries realistic 60-100 character titles and an unbreakable
// single-token title.
//
// The other half of that failure was fixing overflow by ELLIPSIZING UI COPY:
// the tiles rendered "64,6…" and "2Z BALAN…". `clippedStatText` below is the
// regression guard, and it is not optional — UI copy never truncates, only
// user-authored content may wrap and clamp.
//
// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
const FIXTURE_SESSION = "profile-fixture-session";
const FIXTURE_USER = "profilefixture";
const FIXTURE_ADDRESS =
  "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j2m6c0rtyv9wq8hn3lz7kx4mv2p6gd9sr0tqy5h";
const PROFILE_URL = `/${FIXTURE_USER}/dashboard/profile`;

// The counts span the whole queryset; the lists are one 12-row page ordered
// `-created_at`. These two sessions are the cases where those disagree.
const NO_DRAFTS_SESSION = "profile-nodrafts-session";
const NO_DRAFTS_USER = "profilenodrafts";
const NO_PUBLISHED_SESSION = "profile-nopublished-session";
const NO_PUBLISHED_USER = "profilenopublished";

// Formatter-only sessions. The layout fixture above carries a
// realistic balance ("64672.234" — the owner's own, the one that rendered as
// "64,6…" in the original report). The pathological balances that pin
// `formatTuzis` live here instead, because a layout fixture holding a value no
// creator can have forces the layout assertions to be narrowed until they stop
// covering the case they exist for.
const MAX_BALANCE_SESSION = "profile-maxbalance-session";
const MAX_BALANCE_USER = "profilemaxbalance";
const ROUNDUP_SESSION = "profile-roundup-session";
const ROUNDUP_USER = "profileroundup";

async function authenticate(page: Page, session = FIXTURE_SESSION) {
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

/**
 * Stat-tile text measured against its own box. `scrollWidth` past the rounded-up
 * client width means the element is clipping its own text — which is exactly
 * what `truncate` does, and exactly what produced "64,6…" and "2Z BALAN…" on the
 * owner's phone.
 *
 * `kind` is `"value" | "label"`, or omitted for both.
 */
async function clippedStatText(page: Page, kind?: "value" | "label") {
  return page.evaluate((only) => {
    const selector = only ? `[data-stat-text="${only}"]` : "[data-stat-text]";
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((el) => ({
        kind: el.dataset.statText,
        text: (el.textContent || "").trim(),
        scrollWidth: el.scrollWidth,
        clientWidth: Math.ceil(el.getBoundingClientRect().width),
      }))
      .filter((m) => m.scrollWidth > m.clientWidth + 1);
  }, kind);
}

for (const width of GUARD_WIDTHS) {
  test(`the profile dashboard never scrolls horizontally at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(PROFILE_URL);
    // Deliberately NOT gated on a test id this change introduces: the width
    // assertion below has to be what fails against the unfixed page, not a
    // missing selector.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The rows the fixture titles live in must actually be on the page, or the
    // measurement below is taken against an empty list and proves nothing.
    await expect(
      page.getByRole("heading", { level: 3 }).first(),
      "the zpage rows carrying the long fixture titles must be rendered",
    ).toBeVisible();

    const measured = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      bodyContent: document.body.scrollWidth,
    }));
    expect(
      measured.content,
      "the document must not scroll horizontally",
    ).toBeLessThanOrEqual(measured.viewport);
    expect(measured.bodyContent).toBeLessThanOrEqual(measured.viewport);

    // Every stat tile has to fit its column too — a tile that overflows its
    // own card only stops scrolling the page if something else clips it.
    await expect(page.getByTestId("stat-balance")).toBeVisible();
    for (const id of [
      "stat-published",
      "stat-drafts",
      "stat-balance",
      "stat-fans",
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(
        box!.width,
        `${id} is wider than the viewport`,
      ).toBeLessThanOrEqual(width);
    }

    //...and it must fit WITHOUT hiding any of the copy. Fixing overflow by
    // ellipsizing the label is not fixing overflow.
    //
    // Labels AND values, at every width. This used to skip the value check
    // above 390px, because the fixture balance was "99,999,999,999,999.999" —
    // the widest the `max_digits=17, decimal_places=3` column can physically
    // hold. Twenty-one glyphs do not fit a 268px 4-up desktop tile at any sane
    // type size, so an unconditional assertion would have failed on the
    // FIXTURE rather than on a defect, and the exemption left a genuinely
    // too-wide desktop value uncaught. The fix was the fixture, not
    // the assertion: the pathological balances moved to their own sessions,
    // this one carries a realistic "64,672.23", and both checks now run at all
    // four widths.
    expect(
      await clippedStatText(page, "label"),
      "no stat label may clip its own text — UI copy never truncates",
    ).toEqual([]);
    expect(
      await clippedStatText(page, "value"),
      "no stat value may clip its own text",
    ).toEqual([]);

    // Clipping is only half of it. The billing page reached the same place
    // from the other direction — `overflow-wrap: anywhere` meant nothing
    // clipped and nothing overflowed, the copy just broke mid-word
    // ("SUBSCRI/PTIONS", a balance as "64,6 / 72.2 / 3"). The two pages share
    // `StatTile` now, so this side asserts it too.
    expect(
      await splitWords(page, "[data-stat-text]"),
      "no stat word may be broken across lines",
    ).toEqual([]);

    // The guard above only means something if the tile is actually rendering
    // the fixture balance: an empty or "—" value clips nothing at any width.
    await expect(page.getByTestId("stat-balance")).toContainText("64,672.23");
  });
}

test("the 2Z stat shows the formatted credit balance, never a raw decimal", async ({
  page,
}) => {
  await page.goto(PROFILE_URL);
  const balance = page.getByTestId("stat-balance");

  await expect(balance).toContainText("2Z Balance");
  await expect(balance).not.toContainText("Earned");
  // The fixture balance is "64672.234": grouped, and TRUNCATED to 2 decimals
  // rather than rounded.
  await expect(balance).toContainText("64,672.23");
  // The old bug printed `creator.total` — a different quantity — verbatim,
  // because String.prototype.toLocaleString is a no-op.
  await expect(balance).not.toContainText("3.45372709");
  await expect(balance).not.toContainText("64672.234");
});

test("the widest balance the column can hold is truncated, not rounded", async ({
  page,
}) => {
  // "99999999999999.999" — `max_digits=17, decimal_places=3`. Rounding here
  // prints "100,000,000,000,000": overstating the balance by the largest
  // margin available, at exactly the point where precision matters most.
  await authenticate(page, MAX_BALANCE_SESSION);
  await page.goto(`/${MAX_BALANCE_USER}/dashboard/profile`);

  const balance = page.getByTestId("stat-balance");
  await expect(balance).toContainText("99,999,999,999,999.99");
  await expect(balance).not.toContainText("100,000,000,000,000");
  await expect(balance).not.toContainText(".999");
});

test("a balance is never inflated by a float round-trip", async ({ page }) => {
  //. The fixture is "99999999999999.010". Truncating the TEXT gives
  // "99999999999999.01" — correct — but handing that to `Number()` yields
  // 99999999999999.02, because a value near 1e14 with two decimals needs ~16
  // significant digits and a double carries ~15.95. Both previous fixture
  // values happened to round DOWN, so the old formatter passed every
  // assertion while overstating by a cent at the top of the column's range.
  await authenticate(page, ROUNDUP_SESSION);
  await page.goto(`/${ROUNDUP_USER}/dashboard/profile`);

  const balance = page.getByTestId("stat-balance");
  await expect(balance).toContainText("99,999,999,999,999.01");
  await expect(balance).not.toContainText("99,999,999,999,999.02");
});

test("stat counts come from the API totals, not the 12-row page", async ({
  page,
}) => {
  await page.goto(PROFILE_URL);
  // The fixture serves 12 results but 4321 published / 1234 drafts.
  await expect(page.getByTestId("stat-published")).toContainText("4,321");
  await expect(page.getByTestId("stat-drafts")).toContainText("1,234");
  await expect(page.getByTestId("stat-fans")).toContainText("2,468");
});

test("every stat tile is a link, and Drafts answers 'where are my drafts?'", async ({
  page,
}) => {
  await page.goto(PROFILE_URL);

  await expect(page.getByTestId("stat-published")).toHaveAttribute(
    "href",
    `/${FIXTURE_USER}/dashboard/pages`,
  );
  await expect(page.getByTestId("stat-balance")).toHaveAttribute(
    "href",
    `/${FIXTURE_USER}/dashboard/billing`,
  );
  await expect(page.getByTestId("stat-fans")).toHaveAttribute(
    "href",
    `/${FIXTURE_USER}/dashboard/billing?section=subscribers`,
  );
  await expect(page.getByTestId("stat-drafts")).toHaveAttribute(
    "href",
    "#drafts",
  );

  await page.getByTestId("stat-drafts").click();
  await expect(page).toHaveURL(/#drafts$/);
  await expect(page.locator("#drafts")).toBeInViewport();
});

const content = (page: Page) => page.getByTestId("dashboard-content");
const sidebar = (page: Page) => page.getByTestId("dashboard-sidebar");

test("drafts come before the upload tools on mobile — in the DOM, not just visually", async ({
  page,
}) => {
  // Source order put Quick Actions, a full-size dropzone and the bio ahead of
  // the drafts list, so on one column you scrolled past all of it first.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PROFILE_URL);

  const contentBox = await content(page).boundingBox();
  const sidebarBox = await sidebar(page).boundingBox();
  expect(contentBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(
    contentBox!.y,
    "drafts must render above Quick Actions on mobile",
  ).toBeLessThan(sidebarBox!.y);

  // The half a CSS-only `order-*` swap cannot deliver: `order` moves paint
  // position but not focus order or reading order, so a keyboard user would
  // still tab into Quick Actions first and see focus land BELOW the drafts it
  // visually precedes (WCAG 2.4.3), and a screen reader would still announce
  // Quick Actions first. Only a real DOM reorder fixes that.
  const contentPrecedesInDom = await page.evaluate(() => {
    const contentEl = document.querySelector(
      '[data-testid="dashboard-content"]',
    );
    const sidebarEl = document.querySelector(
      '[data-testid="dashboard-sidebar"]',
    );
    if (!contentEl || !sidebarEl) return null;
    // DOCUMENT_POSITION_FOLLOWING === 4: sidebarEl comes after contentEl.
    return Boolean(contentEl.compareDocumentPosition(sidebarEl) & 4);
  });
  expect(
    contentPrecedesInDom,
    "drafts must precede Quick Actions in the DOM, not merely in paint order",
  ).toBe(true);

  // And the tab order follows the DOM, which is the whole point.
  const firstFocusedAfterStats = await page.evaluate(() => {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    ).filter((el) => el.offsetParent !== null);
    const stat = document.querySelector('[data-testid="stat-fans"]');
    const after = focusable.filter(
      (el) => stat && stat.compareDocumentPosition(el) & 4,
    );
    const contentEl = document.querySelector(
      '[data-testid="dashboard-content"]',
    );
    return contentEl?.contains(after[0]) ?? null;
  });
  expect(
    firstFocusedAfterStats,
    "the first control after the stats must be inside the content column",
  ).toBe(true);
});

test("the desktop two-column layout is unchanged by the reorder", async ({
  page,
}) => {
  // The DOM reorder is undone at `lg:` with `lg:order-*`. The sidebar must be
  // back on the LEFT and the content column on the right, sharing one row.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PROFILE_URL);

  const contentBox = await content(page).boundingBox();
  const sidebarBox = await sidebar(page).boundingBox();
  expect(contentBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();

  expect(
    sidebarBox!.x,
    "the sidebar sits left of the content column on desktop",
  ).toBeLessThan(contentBox!.x);
  // Same row, not stacked.
  expect(Math.abs(sidebarBox!.y - contentBox!.y)).toBeLessThan(2);
  // The content column is the wider one (lg:col-span-2 of 3).
  expect(contentBox!.width).toBeGreaterThan(sidebarBox!.width * 1.5);
});

test("a count the list cannot show always offers a way to see the rest", async ({
  page,
}) => {
  // 4,321 published / 1,234 drafts, but only 12 rows on this page.
  await page.goto(PROFILE_URL);
  await expect(page.getByTestId("drafts-view-all")).toHaveAttribute(
    "href",
    `/${FIXTURE_USER}/dashboard/pages`,
  );
  await expect(page.getByTestId("published-view-all")).toHaveAttribute(
    "href",
    `/${FIXTURE_USER}/dashboard/pages`,
  );
});

test("a drafts card that cannot show its drafts says so instead of 'none'", async ({
  page,
}) => {
  // The regression this guards is strictly worse than the original bug: the
  // tile says "1,234 Drafts", you click it expecting an answer to "where are
  // my drafts?", and the card underneath tells you there are none.
  await authenticate(page, NO_DRAFTS_SESSION);
  await page.goto(`/${NO_DRAFTS_USER}/dashboard/profile`);

  await expect(page.getByTestId("stat-drafts")).toContainText("1,234");
  const draftsCard = page.locator("#drafts");
  await expect(draftsCard).toContainText("1,234 works in progress");
  await expect(
    draftsCard,
    "must not claim there are no drafts while advertising 1,234",
  ).not.toContainText("No active drafts");
  await expect(page.getByTestId("drafts-elsewhere")).toBeVisible();
  await expect(
    draftsCard.getByRole("link", { name: "View all your drafts" }),
  ).toHaveAttribute("href", `/${NO_DRAFTS_USER}/dashboard/pages`);
});

test("the published card has the same honesty", async ({ page }) => {
  await authenticate(page, NO_PUBLISHED_SESSION);
  await page.goto(`/${NO_PUBLISHED_USER}/dashboard/profile`);

  await expect(page.getByTestId("published-elsewhere")).toBeVisible();
  await expect(page.getByText("Nothing published yet.")).toHaveCount(0);
});

test("a balance is never rounded up", async ({ page }) => {
  // `tuzis` is decimal_places=3. Rounding 4.996 to "5" advertises money the
  // creator does not have, next to actions priced at 5 that will then fail.
  await authenticate(page, NO_DRAFTS_SESSION);
  await page.goto(`/${NO_DRAFTS_USER}/dashboard/profile`);

  const balance = page.getByTestId("stat-balance");
  await expect(balance).toContainText("4.99");
  await expect(balance).not.toContainText("5");
});

test("the wallet chip truncates the middle and keeps the tail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PROFILE_URL);

  const chip = page.getByRole("button", { name: "Copy Zcash address" });
  await expect(chip).toBeVisible();
  const shown = (await chip.innerText()).trim();

  expect(shown, "must be truncated at all").not.toEqual(FIXTURE_ADDRESS);
  expect(shown, "an ellipsis marks the elision").toContain("…");
  const [head, tail] = shown.split("…");
  // The tail is the checksum-bearing part; a head-only truncation is grindable
  // and therefore worthless for verification.
  expect(tail.length).toBeGreaterThanOrEqual(head.length);
  expect(FIXTURE_ADDRESS.endsWith(tail)).toBe(true);
  expect(FIXTURE_ADDRESS.startsWith(head)).toBe(true);
  // The full value stays reachable — `title` alone is unreachable on touch.
  await expect(chip).toHaveAttribute("title", FIXTURE_ADDRESS);
});

test("a 128-character unbroken display name cannot burst the header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PROFILE_URL);

  const heading = page.getByRole("heading", { level: 1 });
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(390);
});
