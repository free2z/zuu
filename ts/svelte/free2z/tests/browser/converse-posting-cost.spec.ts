import { expect, test, type Page } from "@playwright/test";

//  posting costs a penny by design, and a new account starts at 0.
//
// The verification bar from the issue: a creator holding 0 2Z attempts a post,
// and the UI shows the cost, the balance and BOTH ways in (be gifted 2Z after
// writing an intro zPage, or buy 2Z) — not a generic "Could not publish" — and
// the draft survives. Said up front, before they write, as well as after the
// server's 402.
//
// NEGATIVE CONTROLS (each run by reverting the change and re-running):
//   - delete the `{:else if cannotCoverAPost}` branch in ConverseComposer
//     -> "a 0-balance creator is told the price..." fails on the missing note;
//   - make `cannotCoverMinimumPost` return `true` for an unparseable balance
//     -> "an unknown balance is not treated as zero" fails;
//   - delete the `{#if introHref}` gift paragraph in InsufficientFunds
//     -> the post-402 assertions fail on the missing gift explanation;
//   - `introPath` always returning `/edit`
//     -> "a creator who already wrote a zPage..." fails on the href.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

async function installSession(
  page: Page,
  tuzis: string | undefined,
  zpages?: number,
) {
  const creator = {
    id: 1460,
    username: "penny-test-user",
    full_name: "Penny Test User",
    ...(tuzis === undefined ? {} : { tuzis }),
    ...(zpages === undefined ? {} : { zpages }),
  };
  const posts: unknown[] = [];

  await page.addInitScript((c) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator: c, loading: false }),
    );
  }, creator);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(creator),
      });
      return;
    }
    if (pathname === "/api/comments/" && request.method() === "POST") {
      posts.push(JSON.parse(request.postData() || "{}"));
      // The server's contract: 402 with a machine-readable shortfall.
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Not enough tuzis",
          code: "insufficient_funds",
          action: "comment",
          cost: "1",
          balance: tuzis ?? "0",
          shortfall: "1",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  return { posts };
}

test("a 0-balance creator is told the price and both ways in, before and after posting, and keeps the draft", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { posts } = await installSession(page, "0");
  await page.goto("/converse");

  const body = page.locator("#converse-content");
  await expect(body).toBeVisible({ timeout: 20_000 });

  // Before a word is written: the price, why, the balance, and both doors.
  const notice = page.getByTestId("posting-cost-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("A post costs 1 2Z, about a penny.");
  await expect(notice).toContainText("That is why there is no spam here.");
  await expect(notice).toContainText("You have 0 2Z.");
  await expect(notice).toContainText(
    "members can gift 2Z to writers they want to read more from",
  );
  await expect(page.getByTestId("posting-cost-intro")).toHaveAttribute(
    "href",
    "/edit",
  );
  await expect(page.getByTestId("posting-cost-buy")).toHaveAttribute(
    "href",
    "/buy-2z",
  );
  // Following a door must not throw away the draft: this composer has no
  // draft storage, so both open a new tab.
  await expect(page.getByTestId("posting-cost-intro")).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByTestId("posting-cost-buy")).toHaveAttribute(
    "target",
    "_blank",
  );

  // Not a wall: the composer is still there and still usable.
  await expect(body).toBeEditable();
  await body.fill("hello, I am new here");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);

  // After the 402: the exact shortfall, the gift path, both links — and no
  // generic failure.
  const refused = page.getByTestId("insufficient-funds");
  await expect(refused).toBeVisible();
  await expect(refused).toContainText(
    "This costs 1 2Z. You have 0 2Z, so you need 1 more.",
  );
  await expect(page.getByTestId("insufficient-funds-gift")).toContainText(
    "members can gift 2Z to writers they want to read more from",
  );
  await expect(page.getByTestId("insufficient-funds-intro")).toHaveAttribute(
    "href",
    "/edit",
  );
  await expect(page.getByTestId("insufficient-funds-buy")).toHaveAttribute(
    "href",
    "/buy-2z",
  );
  await expect(page.getByTestId("insufficient-funds-buy")).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByText("Could not publish your post")).toHaveCount(0);
  // One explanation at a time: the refusal replaces the up-front note.
  await expect(notice).toHaveCount(0);

  // The draft survives.
  await expect(body).toHaveValue("hello, I am new here");
});

test("a funded creator sees no posting-cost note", async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installSession(page, "5");
  await page.goto("/converse");

  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("posting-cost-notice")).toHaveCount(0);
});

test("an unknown balance is not treated as zero", async ({ page }) => {
  // A session payload with no `tuzis` says nothing about the balance. Telling
  // a funded creator they have 0 would be a lie; the 402 still catches it.
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installSession(page, undefined);
  await page.goto("/converse");

  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("posting-cost-notice")).toHaveCount(0);
});

test("a creator who already wrote a zPage is sent to it, not into a refused second one", async ({
  page,
}) => {
  // `/edit` creates a page, and the server refuses a second page below 1 2Z.
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installSession(page, "0", 1);
  await page.goto("/converse");

  const notice = page.getByTestId("posting-cost-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("Your zPage is your introduction.");
  await expect(notice).not.toContainText("Write a zPage");
  const intro = page.getByTestId("posting-cost-intro");
  await expect(intro).toHaveText("Your zPages");
  await expect(intro).toHaveAttribute(
    "href",
    "/penny-test-user/dashboard/pages",
  );

  await page.locator("#converse-content").fill("still here");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByTestId("insufficient-funds-gift")).toContainText(
    "Your zPage is your introduction.",
  );
  await expect(page.getByTestId("insufficient-funds-intro")).toHaveAttribute(
    "href",
    "/penny-test-user/dashboard/pages",
  );
});
