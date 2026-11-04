import { expect, test } from "@playwright/test";

// Posting starts at a penny by design; this fixture has spent its welcome grant.
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

import { installSession } from "./posting-cost-session";

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
  await expect(notice).toContainText("This post costs 1 2Z.");
  await expect(notice).toContainText(
    "The small posting cost discourages spam.",
  );
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

  // The explanation must follow the actual selected action cost.
  await page.locator("#converse-weight").fill("3");
  await expect(notice).toContainText("This post costs 3 2Z.");
  await page.locator("#converse-weight").fill("1");
  await expect(notice).toContainText("This post costs 1 2Z.");

  // Not a wall: the composer is still there and still usable.
  await expect(body).toBeEditable();
  await body.fill("hello, I am new here");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);

  // After the 402: the exact shortfall, the gift path, both links — and no
  // generic failure.
  const refused = page.getByTestId("insufficient-funds");
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("You have not been charged.");
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
