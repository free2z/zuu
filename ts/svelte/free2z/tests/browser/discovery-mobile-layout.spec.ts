import { expect, test, type Page } from "@playwright/test";
import {
  GUARD_WIDTHS,
  expectNoHorizontalScroll,
  splitWords,
} from "./mobile-layout-guards";

// Issue  — /trending and /creators, the two discovery surfaces. Neither
// had any layout guard at all before this file.
//
// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
// The titles there are deliberately long (one 78-char sentence, one 66-char
// unbreakable token) because a fixture of short titles cannot fail a wrapping
// assertion — the same hole  found in the profile fixture.
const TRENDING_SESSION = "trending-mobile-session";
const TRENDING_URL = "/trending";
const CREATORS_URL = "/creators";
const UNBREAKABLE_TITLE =
  "Supercalifragilisticexpialidociousunbreakabletitletokenwithnospaces";

async function useTrendingFixture(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: TRENDING_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

// /creators is a client-side infinite query, so it is mocked in the browser
// rather than through the SSR fixture server. Long display names, long
// handles, a 120,345 post count and a non-Latin name — the values that make a
// 320px card fail.
const CREATOR_FIXTURES = [
  {
    username: "averyverylongsinglewordcreatorhandle",
    display_name: "Antidisestablishmentarianism Quarterly",
    zpages: 120345,
  },
  { username: "kev", display_name: "Kev", zpages: 1 },
  {
    username: "zcash_maximalist_2026",
    display_name:
      "The Zcash Maximalist — Notes on Shielded Money, Privacy, and Policy",
    zpages: 3456,
  },
  { username: "nara", display_name: "ナラティブ・アーカイブ", zpages: 0 },
].map((c, index) => ({
  ...c,
  full_name: c.display_name,
  is_verified: index % 2 === 0,
  member_price: index % 2 ? "50" : "0",
  p2paddr: index % 2 ? "u1abc" : "",
  avatar_image: null,
  banner_image: null,
  last_post_at: "2026-08-11T10:00:00Z",
  date_joined: "2024-01-02T10:00:00Z",
}));

async function mockCreators(page: Page) {
  // Path equality, not a glob: `**/api/creator/**` also matches the Vite dev
  // server's own module URL for `/src/lib/api/creator/creator.ts`, and
  // answering that with JSON takes the whole app down with a MIME-type error.
  await page.route(
    (url) => url.pathname === "/api/creator/",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: CREATOR_FIXTURES.length,
          next: null,
          previous: null,
          results: CREATOR_FIXTURES,
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/zpage/",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 0,
          next: null,
          previous: null,
          results: [],
        }),
      }),
  );
}

for (const width of GUARD_WIDTHS) {
  test(`trending lays out cleanly at ${width}px`, async ({ page }) => {
    await useTrendingFixture(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(TRENDING_URL);

    // Fail on the measurement, not on a missing selector: the fixture stories
    // have to actually be on the page.
    await expect(page.getByText(UNBREAKABLE_TITLE)).toBeVisible();
    await expectNoHorizontalScroll(page, `trending @ ${width}`);
  });
}

test("trending renders the compact row on a phone and the full card on desktop", async ({
  page,
}) => {
  // /trending was the last list still rendering the full magazine card at
  // phone width: a 176px cover plus a reserved title box and a reserved blurb
  // box per story. /search, the public profile and the pages dashboard all
  // already pass `compactOnMobile`.
  await useTrendingFixture(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(TRENDING_URL);
  const compactHeight = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="zpage-card"]')
        ?.getBoundingClientRect().height ?? 0,
  );
  expect(
    compactHeight,
    "a compact row is far shorter than the magazine card it replaced",
  ).toBeLessThan(200);

  // The byline comes with it. `compactOnMobile` hides the card FOOTER below
  // `sm`, and the footer is where the creator's name lives, so without a
  // stand-in every card on a phone was anonymous.
  await expect(
    page
      .getByRole("link", {
        name: "A Creator Whose Display Name Runs Well Past The Column",
      })
      .first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(TRENDING_URL);
  const fullHeight = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="zpage-card"]')
        ?.getBoundingClientRect().height ?? 0,
  );
  expect(fullHeight, "the desktop grid keeps the full card").toBeGreaterThan(
    compactHeight,
  );
});

for (const width of GUARD_WIDTHS) {
  test(`the creators directory lays out cleanly at ${width}px`, async ({
    page,
  }) => {
    await page.context().clearCookies();
    await mockCreators(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(CREATORS_URL);

    await expect(page.getByText("@ZCASH_MAXIMALIST_2026")).toBeVisible();
    await expectNoHorizontalScroll(page, `creators @ ${width}`);
  });
}

test("a creator card never breaks a word or a number in half", async ({
  page,
}) => {
  // "120,345 posts · Aug 11, 2026" used to wrap as "120,345 / POSTS" with the
  // separator dot orphaned, and the card grew past its own `h-28`.
  await page.context().clearCookies();
  await mockCreators(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(CREATORS_URL);
  await expect(page.getByText("@ZCASH_MAXIMALIST_2026")).toBeVisible();

  expect(
    await splitWords(
      page,
      '[data-testid="creator-card"] span, [data-testid="creator-card"] h3',
    ),
    "no word of a creator card's metadata may be split across lines",
  ).toEqual([]);
});

test("a creator card carries exactly one hover cue", async ({ page }) => {
  // House rule: hover cues only on genuinely clickable elements, ONE cue per
  // element — never a shadow and a ring and a colour at once. This card used to
  // stack eight: border, a 2rem lift, an avatar glow, an avatar scale, a
  // gradient shift, a scanline fade, a title colour change and a bottom rule.
  // None of them exist on touch, and none said anything the border did not.
  await page.context().clearCookies();
  await mockCreators(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(CREATORS_URL);
  await expect(page.getByText("@ZCASH_MAXIMALIST_2026")).toBeVisible();

  const cues = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(
      '[data-testid="creator-card"]',
    );
    if (!card) return null;
    const classes = [card, ...Array.from(card.querySelectorAll("*"))]
      .flatMap((el) =>
        Array.from((el as HTMLElement).classList).filter((c) =>
          /(^|:)(group-)?hover:/.test(c),
        ),
      )
      // `sm:hover:` and friends are the same cue at another breakpoint.
      .map((c) => c.replace(/^[a-z]+:(?=(group-)?hover:)/, ""));
    return Array.from(new Set(classes));
  });
  expect(cues, "the card must render").not.toBeNull();
  expect(
    cues,
    `one hover cue only, found: ${JSON.stringify(cues)}`,
  ).toHaveLength(1);
});
