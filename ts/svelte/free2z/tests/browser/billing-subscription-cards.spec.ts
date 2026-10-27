import { expect, test, type Locator, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

// Issue: a subscription card used to render "Active · Renews Sep 3"
// directly above a red "…will not renew" notice, and for a cancelled
// subscription (max_price = 0) it did so for up to 30 days, because
// MySubscriptionsListView filters only on `expires__gt=now`.
//
// The fixture in tests/browser/mock-api.mjs serves one subscription per
// price-ceiling state, so this renders every card the classifier can produce.
// Both literals are duplicated there; keep them in sync.
const FIXTURE_SESSION = "billing-fixture-session";
const FIXTURE_CSRF = "billing-fixture-csrf";
const SHORTFALL_SESSION = "billing-shortfall-session";
const EMPTY_SESSION = "billing-empty-session";
const UNKNOWN_SESSION = "billing-unknown-session";
const FIXTURE_USER = "fixtureowner";
const BILLING_URL = `/${FIXTURE_USER}/dashboard/billing`;
// The card tab (: the page opens on Zcash).
const CARD_URL = `${BILLING_URL}?tab=stripe`;
const MOCK_API_ORIGIN = browserMockApiOrigin();

/** Cards whose ceiling makes the next renewal impossible. */
const NON_RENEWING = ["state-over", "state-unpriced", "state-cancelled"];
/** Cards that really do renew on their expiry date. */
const RENEWING = ["state-ok", "state-near", "state-at"];

async function authenticate(page: Page, session = FIXTURE_SESSION) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: session,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "csrftoken",
      value: FIXTURE_CSRF,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

function card(page: Page, username: string) {
  return page.locator("div.group", {
    has: page.locator(`a[href="/${username}"]`),
  });
}

async function horizontalSpill(locator: Locator) {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    let worst = 0;
    el.querySelectorAll("*").forEach((child) => {
      const r = child.getBoundingClientRect();
      // Hidden inputs report a 0x0 rect at the origin; they lay nothing out.
      if (r.width === 0 && r.height === 0) return;
      worst = Math.max(
        worst,
        r.right - box.right,
        box.left - r.left,
        child.scrollWidth - child.clientWidth,
      );
    });
    return worst;
  });
}

test.beforeEach(async ({ page }) => {
  await fetch(`${MOCK_API_ORIGIN}/__billing/reset`, { method: "POST" });
  await authenticate(page);
});

test("card checkout confirms the backend's exact quote before Stripe", async ({
  page,
}) => {
  await page.goto(CARD_URL);
  await page.locator("#quantity").fill("2");
  await page.getByRole("button", { name: "Review exact charge" }).click();

  const quote = page.getByTestId("authoritative-card-quote");
  await expect(quote).toBeVisible();
  await expect(quote).toContainText("$7.77");
  await expect(quote).toContainText("2 2Z");
  await expect(
    quote.getByRole("button", { name: "Continue to Stripe" }),
  ).toBeEnabled();

  await page.locator("#quantity").fill("3");
  await expect(quote).toHaveCount(0);
});

test("card checkout fails closed when the returned quote changes quantity", async ({
  page,
}) => {
  await page.goto(CARD_URL);
  await page.locator("#quantity").fill("13");
  await page.getByRole("button", { name: "Review exact charge" }).click();

  await expect(page.getByTestId("authoritative-card-quote")).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Unable to start Stripe checkout" }),
  ).toContainText("Unable to start Stripe checkout");
});

test("card checkout rejects a Stripe lookalike hostname", async ({ page }) => {
  await page.goto(CARD_URL);
  await page.locator("#quantity").fill("14");
  await page.getByRole("button", { name: "Review exact charge" }).click();

  await expect(page.getByTestId("authoritative-card-quote")).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Unable to start Stripe checkout" }),
  ).toContainText("Unable to start Stripe checkout");
});

test("updating a maximum is reactive and remains authoritative after reload", async ({
  page,
}) => {
  await page.goto(BILLING_URL);
  const target = card(page, "mutation_target");
  await expect(target).toContainText("exactly your maximum");

  await target.getByLabel("Maximum 2Z per month").fill("100");
  await target.getByRole("button", { name: "Update" }).click();

  await expect(
    page.getByText("Updated the maximum monthly amount"),
  ).toBeVisible();
  await expect(target.getByLabel("Maximum 2Z per month")).toHaveValue("100");
  await expect(target).not.toContainText("exactly your maximum");

  const requests: Array<{
    method?: string;
    path: string;
    origin: string | null;
    csrf: string | null;
  }> = await fetch(`${MOCK_API_ORIGIN}/__requests`).then((response) =>
    response.json(),
  );
  const patch = requests.find(
    (entry) =>
      entry.method === "PATCH" &&
      entry.path === "/api/tuzis/subscribe/mutation_target",
  );
  expect(patch).toMatchObject({
    origin: new URL(BILLING_URL, page.url()).origin,
    csrf: FIXTURE_CSRF,
  });

  await page.reload();
  await expect(
    card(page, "mutation_target").getByLabel("Maximum 2Z per month"),
  ).toHaveValue("100");
  await expect(card(page, "mutation_target")).not.toContainText(
    "exactly your maximum",
  );
});

//Django usernames may contain `-`, `.`, `@` and `+`. The billing
// actions refused anything outside `[a-zA-Z0-9_]`, so Update (and Unsubscribe,
// covered by the inactive-creator spec below) failed for `state-ok` with
// "Invalid subscription username." before any request reached the API.
test("Update submits for a creator whose username contains a hyphen", async ({
  page,
}) => {
  await page.goto(BILLING_URL);
  const target = card(page, "state-ok");
  await target.getByLabel("Maximum 2Z per month").fill("20");
  await target.getByRole("button", { name: "Update" }).click();

  await expect(
    page.getByText("Updated the maximum monthly amount"),
  ).toBeVisible();
  await expect(page.getByText("Invalid subscription username.")).toHaveCount(0);
  const requests: Array<{ method?: string; path: string }> = await fetch(
    `${MOCK_API_ORIGIN}/__requests`,
  ).then((response) => response.json());
  expect(
    requests.some(
      (entry) =>
        entry.method === "PATCH" &&
        entry.path === "/api/tuzis/subscribe/state-ok",
    ),
  ).toBe(true);
});

//a deactivated counterparty stays listed (its row carries the only
// unsubscribe control) but the API redacts it to a username. Before this, the
// card looked like a live creator with blank fields: a profile link that 404s
// and an Update form whose PATCH the backend refuses for an inactive creator.
function inactiveCard(page: Page, username: string) {
  return page.locator("div.group").filter({ hasText: `@${username}` });
}

test("a deactivated creator's card names the state and offers only Unsubscribe", async ({
  page,
}) => {
  await page.goto(BILLING_URL);
  const target = inactiveCard(page, "state-inactive");
  await expect(target).toHaveCount(1);
  await expect(target).toContainText("no longer active");
  await expect(target).toContainText("Inactive");

  // No dead link, no ceiling controls, no price that is not a price.
  await expect(page.locator('a[href="/state-inactive"]')).toHaveCount(0);
  await expect(target.getByRole("button", { name: "Update" })).toHaveCount(0);
  await expect(target.getByLabel("Maximum 2Z per month")).toHaveCount(0);
  await expect(target).not.toContainText("Creator's price now");
  await expect(target).not.toContainText("no chargeable price");
  await expect(target).not.toContainText(/renews/i);

  // The one control that must keep working.
  const unsubscribe = target.getByRole("button", { name: "Unsubscribe" });
  await expect(unsubscribe).toBeEnabled();
  await unsubscribe.click();
  await expect(
    page.getByText("The subscription to @state-inactive will not renew."),
  ).toBeVisible();
  const requests: Array<{ method?: string; path: string }> = await fetch(
    `${MOCK_API_ORIGIN}/__requests`,
  ).then((response) => response.json());
  expect(
    requests.some(
      (entry) =>
        entry.method === "DELETE" &&
        entry.path === "/api/tuzis/subscribe/state-inactive",
    ),
  ).toBe(true);

  // Live creators are untouched: still linked, still updatable.
  await expect(card(page, "state-ok")).toBeVisible();
  await expect(
    card(page, "state-ok").getByRole("button", { name: "Update" }),
  ).toBeVisible();
});

test("a deactivated subscriber's card says the account is gone, not a blank card", async ({
  page,
}) => {
  await page.goto(`${BILLING_URL}?section=subscribers`);
  await page.getByRole("tab", { name: "Subscribers" }).click();
  await expect(card(page, "fan-renewing")).toBeVisible();

  const fan = inactiveCard(page, "fan_inactive");
  await expect(fan).toHaveCount(1);
  await expect(fan).toContainText("no longer active");
  await expect(fan).toContainText("Inactive");
  await expect(fan).toContainText(/Maximum monthly\s+100 2Z/);
  await expect(page.locator('a[href="/fan_inactive"]')).toHaveCount(0);
  // An inactive fan's spend is frozen, so no renewal claim.
  await expect(fan).not.toContainText("Renews");
});

test("the aggregate banner names the window it actually measured", async ({
  page,
}) => {
  await page.goto(BILLING_URL);

  // Not "covers your renewals" — the query only proves one billing cycle, and
  // the copy may never claim more than the arithmetic supports.
  await expect(
    page.getByText(
      "At today's prices, your balance covers the renewals scheduled in the " +
        "next 29 days (64 2Z).",
      { exact: true },
    ),
  ).toBeVisible();

  // The fixture deliberately includes over-ceiling and unpriced rows, which
  // the aggregate omits. Without this line the green banner would read as
  // "all your subscriptions are safe" directly above cards saying otherwise.
  await expect(
    page.getByText("Subscriptions shown as not renewing are not counted here."),
  ).toBeVisible();
});

test("the shortfall rounds UP to a whole credit and sets no deadline", async ({
  page,
}) => {
  await authenticate(page, SHORTFALL_SESSION);
  await page.goto(BILLING_URL);

  const banner = page
    .getByRole("alert")
    .filter({ hasText: "Upcoming renewals" });
  await expect(banner).toContainText(
    "At today's prices, renewals scheduled in the next 29 days total 64 2Z.",
  );
  // The fixture deficit is 43.500. Truncating it to "43" — or to "43.5", which
  // no checkout sells — understates what has to be added for the charge to go
  // through at all.
  await expect(banner).toContainText("Your balance is short by 44 2Z.");
  // `next_renewal` is not a funding deadline: attempts start 24h early and
  // retry hourly, so no "before <date>" may appear here.
  await expect(banner).not.toContainText("before");
  // The shortfall banner carries the same exclusion note as the green one.
  await expect(banner).toContainText(
    "Subscriptions shown as not renewing are not counted here.",
  );
});

test("no chargeable renewals leave the aggregate banner quiet", async ({
  page,
}) => {
  await authenticate(page, EMPTY_SESSION);
  await page.goto(BILLING_URL);

  await expect(
    page.getByText("Upcoming renewals", { exact: true }),
  ).toHaveCount(0);
});

test("an unavailable aggregate summary fails closed", async ({ page }) => {
  await authenticate(page, UNKNOWN_SESSION);
  await page.goto(BILLING_URL);

  await expect(
    page.getByText("We couldn't calculate your upcoming renewal total.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("no subscription card claims a renewal it cannot make", async ({
  page,
}) => {
  await page.goto(BILLING_URL);
  await expect(card(page, "state-ok")).toBeVisible();

  for (const username of NON_RENEWING) {
    const text = (await card(page, username).innerText()).toLowerCase();
    // The whole point of: never both at once.
    expect(text, `${username} must not claim a renewal date`).not.toContain(
      "renews",
    );
    expect(text, `${username} must not read as Active`).not.toContain("active");
    expect(text, `${username} must say when access ends`).toContain(
      "access ends",
    );
    expect(text, `${username} keeps its ceiling notice`).toMatch(
      /will not renew|cannot renew/,
    );
  }

  for (const username of RENEWING) {
    const text = (await card(page, username).innerText()).toLowerCase();
    expect(text, `${username} still renews`).toContain("renews");
    expect(text, `${username} is active`).toContain("active");
    expect(text, `${username} must not claim an end date`).not.toContain(
      "access ends",
    );
  }
});

test("an unreadable ceiling claims nothing at all", async ({ page }) => {
  // max_price is `default=0, null=False`; an unparseable one means the payload
  // is not what we think it is, so the card must not print a renewal date off
  // a premise it could not verify.
  await page.goto(BILLING_URL);
  const text = (await card(page, "state-unknown").innerText()).toLowerCase();
  expect(text).toContain("unknown");
  expect(text).not.toContain("renews");
  expect(text).not.toContain("access ends");
});

test("an already-lapsed card says access ended, not renews", async ({
  page,
}) => {
  await page.goto(BILLING_URL);
  const text = (await card(page, "state-expired").innerText()).toLowerCase();
  expect(text).toContain("access ended");
  expect(text).toContain("expired");
  expect(text).not.toContain("renews");
});

test("the small-numbers near warning fires at max=5 price=4", async ({
  page,
}) => {
  // A pure 10% headroom rule called this "ok" while it was one 2Z rise from
  // not renewing (member_price is decimal_places=0).
  await page.goto(BILLING_URL);
  await expect(card(page, "state-near")).toContainText("below your maximum");
  await expect(card(page, "state-ok")).not.toContainText("below your maximum");
});

test("subscriber cards do not promise renewals their ceiling blocks", async ({
  page,
}) => {
  await page.goto(`${BILLING_URL}?section=subscribers`);
  await page.getByRole("tab", { name: "Subscribers" }).click();
  await expect(card(page, "fan-renewing")).toBeVisible();

  await expect(card(page, "fan-renewing")).toContainText("Renews");
  for (const username of ["fan-over", "fan-cancelled"]) {
    const text = await card(page, username).innerText();
    expect(text, `${username} must not say Renews`).not.toContain("Renews");
    expect(text, `${username} is ending`).toContain("Ends");
  }

  // Fails closed like the fan card: no date claim at all under an "Unknown"
  // badge. Verified against the unguarded markup, which renders exactly
  // "UNKNOWN | Maximum monthly | 0 2Z | Ends | Sep 3, 2026" for this row —
  // a definite date under a badge saying the data could not be read.
  const unknown = (await card(page, "fan-unknown").innerText()).toLowerCase();
  const date = (await card(page, "fan-renewing").innerText())
    .split(/renews/i)[1]
    ?.trim();
  expect(date, "fixture must produce a real date to look for").toMatch(/\d{4}/);
  expect(unknown, "badge says the data is unreadable").toContain("unknown");
  expect(unknown, "no renews/ends label").not.toMatch(/renews|ends|ended/);
  expect(unknown, "no date claim").not.toContain(date!.toLowerCase());
});

test("subscriber cards distinguish unreadable ceilings from cancellation", async ({
  page,
}) => {
  await page.goto(`${BILLING_URL}?section=subscribers`);
  await page.getByRole("tab", { name: "Subscribers" }).click();

  for (const username of [
    "fan-unknown",
    "fan-nonnumeric",
    "fan-whitespace",
    "fan-boolean",
  ]) {
    const text = await card(page, username).innerText();
    expect(text, `${username} renders an unknown amount`).toMatch(
      /Maximum monthly\s+—/,
    );
    expect(text, `${username} must not invent a numeric amount`).not.toMatch(
      /Maximum monthly\s+(?:0|NaN) 2Z/,
    );
  }

  expect(
    await card(page, "fan-cancelled").innerText(),
    "a real zero still identifies cancellation",
  ).toMatch(/Maximum monthly\s+0 2Z/);
});

for (const width of [320, 1280]) {
  test(`billing page and subscription cards fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(BILLING_URL);
    await expect(card(page, "state-cancelled")).toBeVisible();

    const statCards = page.getByTestId("billing-stats").locator(":scope > div");
    // Asymmetric on purpose: adding a fifth stat is a product decision and
    // must not fail here, but losing any of the four is a regression on a
    // money-adjacent dashboard. This also keeps the spill loop below from
    // passing vacuously over an empty list.
    await expect(statCards.first()).toBeVisible();
    expect(await statCards.count()).toBeGreaterThanOrEqual(4);
    for (const statCard of await statCards.all()) {
      expect(
        await horizontalSpill(statCard),
        "stat content spills out of its card",
      ).toBeLessThan(1);
    }

    const pageWidth = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(
      pageWidth.content,
      "page must not scroll horizontally",
    ).toBeLessThanOrEqual(pageWidth.viewport);

    for (const username of [...NON_RENEWING, ...RENEWING]) {
      const box = await card(page, username).boundingBox();
      expect(box, username).not.toBeNull();
      expect(box!.width, `${username} card width`).toBeLessThanOrEqual(width);

      // The badge and the renews/ends line share one row; the longest
      // localized badge must not push either out of the card.
      const spill = await horizontalSpill(card(page, username));
      expect(spill, `${username} content spills out of its card`).toBeLessThan(
        1,
      );
    }
  });
}

test("the billing 2Z balance is formatted, and never rounded up", async ({
  page,
}) => {
  //this tile read `(creator?.tuzis || 0).toLocaleString($locale)`.
  // `creator.tuzis` is a DRF decimal STRING and
  // `String.prototype.toLocaleString` ignores its arguments and returns the
  // string unchanged, so the locale argument did nothing and the raw payload
  // rendered. TypeScript could not see it: the loader's `creator` is `any`.
  //
  // The fixture is "64672.234" — a string, with the third decimal `tuzis`
  // always carries. The third decimal must be TRUNCATED away: a balance that
  // rounds up advertises credits the creator cannot spend.
  await page.goto(BILLING_URL);
  const balance = page.getByTestId("billing-balance-value");

  await expect(balance).toHaveText("64,672.23");
  await expect(balance).not.toHaveText("64672.234");
  await expect(balance).not.toHaveText("64,672.24");
});

test("card handoff refuses a different authenticated actor after quote review", async ({
  page,
}) => {
  await page.goto(CARD_URL);
  await page.locator("#quantity").fill("2");
  await page.getByRole("button", { name: "Review exact charge" }).click();
  const quote = page.getByTestId("authoritative-card-quote");
  await expect(quote).toBeVisible();
  await expect(
    quote.getByRole("button", { name: "Continue to Stripe" }),
  ).toBeEnabled();
  let stripeRequests = 0;
  await page.route("https://checkout.stripe.com/**", (route) => {
    stripeRequests++;
    return route.abort();
  });
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: 999, username: "otherowner", tuzis: 0 }),
    }),
  );
  await quote.getByRole("button", { name: "Continue to Stripe" }).click();
  await expect(
    page.getByText("Sign in again before continuing.", { exact: true }),
  ).toBeVisible();
  expect(stripeRequests).toBe(0);
  expect(new URL(page.url()).pathname).toBe(BILLING_URL);
});
