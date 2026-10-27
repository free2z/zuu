import { expect, test, type Page } from "@playwright/test";

// The article editor's Insert content (+) control, reworked in  from a
// standalone outlined square on its own row into a quiet mark in the writing
// column's left margin, parked on the caret's line.
//
// What is pinned here is the part a screenshot cannot: that the control costs
// the body no vertical band, that it never lands on top of the text (which is
// what would let it steal a tap meant for the start of a line), that it stays
// on screen at the narrowest supported width, and that it is still a real
// button for keyboard and screen-reader users now that it is visually quiet.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const TEST_CREATOR = {
  id: 4242,
  username: "insert-control-user",
  full_name: "Insert Control User",
};

async function installApiMocks(page: Page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TEST_CREATOR),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });
}

async function openEditor(page: Page) {
  await installApiMocks(page);
  await page.goto("/edit");

  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible();

  return {
    body,
    trigger: page.getByTestId("editor-insert-trigger"),
    menu: page.locator("#editor-command-menu"),
  };
}

async function box(locator: ReturnType<Page["locator"]>) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

test("the insert control is a labelled button with collapsed popup semantics", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { trigger, menu } = await openEditor(page);

  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Insert content");
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-controls", "editor-command-menu");
  await expect(menu).toHaveCount(0);
});

test("the control costs the body no vertical band under the title", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { body } = await openEditor(page);

  const title = page.getByPlaceholder("Article title...");
  const titleBox = await box(title);
  const bodyBox = await box(body);

  // `.writing-area` is a `gap-5` (20px) flex column, so the floor here is the
  // gap plus the title textarea's own leading — 26px as measured. Anything
  // near 86px means the control has taken a row of its own back: that is what
  //  was filed against (`mb-2` + a 32px button + a second 20px gap).
  const gap = bodyBox.y - (titleBox.y + titleBox.height);
  expect(gap).toBeLessThanOrEqual(32);
  expect(gap).toBeGreaterThanOrEqual(0);
});

for (const viewport of [
  { name: "desktop", size: DESKTOP_VIEWPORT },
  { name: "mobile", size: MOBILE_VIEWPORT },
]) {
  test(`on ${viewport.name} the control sits in the margin, on screen and clear of the text`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    const { body, trigger } = await openEditor(page);

    const triggerBox = await box(trigger);
    const bodyBox = await box(body);

    // Entirely left of the text column: it can never cover a character, so a
    // tap at the start of a line always reaches the textarea.
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(bodyBox.x);
    //...and entirely on screen: the mobile margin is only 24px wide, so a
    // control sized for the desktop margin would hang off the left edge.
    expect(triggerBox.x).toBeGreaterThanOrEqual(0);

    // WCAG 2.2 SC 2.5.8 (AA) minimum target size.
    expect(triggerBox.width).toBeGreaterThanOrEqual(24);
    expect(triggerBox.height).toBeGreaterThanOrEqual(24);

    // The page must not gain a horizontal scrollbar because of the overhang.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
}

test("the mobile touch area extends past the 24px glyph without covering text", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const { body, trigger, menu } = await openEditor(page);

  const triggerBox = await box(trigger);
  const bodyBox = await box(body);

  // A `::before` stretches the target vertically (24x40) because the margin
  // has no room to stretch it horizontally. Tapping above the glyph — inside
  // that extension, outside the visual circle — must still open the menu.
  await page.mouse.click(triggerBox.x + triggerBox.width / 2, triggerBox.y - 6);
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  // The extension stays in the margin: it never reaches the text column.
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(bodyBox.x);
});

test("keyboard users can reach, see and operate the control", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { trigger, menu } = await openEditor(page);

  const title = page.getByPlaceholder("Article title...");
  await title.focus();
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();

  // A quieter control must not be an invisible one under keyboard focus.
  const focusRing = await trigger.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(focusRing).not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toContainText("Insert content");

  // The glyph turns into a close mark while the menu is open. Tailwind v4
  // emits the standalone `rotate` property, not a `transform` matrix, and it
  // is animated — poll rather than sampling mid-transition.
  await expect
    .poll(() =>
      trigger.evaluate(
        (element) => getComputedStyle(element.querySelector("svg")!).rotate,
      ),
    )
    .toBe("45deg");

  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("the control follows the caret and quiets down on a line with text", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { body, trigger } = await openEditor(page);

  const restingBox = await box(trigger);
  await expect(trigger).toHaveAttribute("data-ready", "true");

  await body.click();
  await page.keyboard.type("First paragraph of the article.");
  await expect(trigger).toHaveAttribute("data-ready", "false");

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("data-ready", "true");

  // The control glides to the new line, so poll rather than sampling once.
  await expect
    .poll(async () => (await box(trigger)).y)
    .toBeGreaterThan(restingBox.y);
  // Still in the margin after moving.
  expect((await box(trigger)).x).toBe(restingBox.x);
});

test("clicking the expanded control closes the menu it is pointing at", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { trigger, menu } = await openEditor(page);

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  // The glyph is showing a close mark at this point, so the click has to
  // close rather than reassert the open state.
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("switching to Split re-parks the control on the caret's line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { body, trigger } = await openEditor(page);

  await body.click();
  // Long enough to wrap at full width and wrap differently at half width, so
  // the caret's line moves without any window resize firing.
  await page.keyboard.type(
    "Shielded transactions hide the amount, the sender and the receiver, " +
      "which is the whole point and also the part everyone skips over when " +
      "they compare chains on throughput alone.",
  );
  await page.keyboard.press("Enter");

  // Offset WITHIN the textarea, not viewport y: switching modes moves the
  // whole writing column, which would make a viewport-y assertion pass on a
  // control frozen at its old line.
  const offset = async () => {
    const [triggerBox, bodyBox] = [await box(trigger), await box(body)];
    return triggerBox.y - bodyBox.y;
  };
  // Let the debounced measurement settle first. Reading it too early captures
  // the control still on line one, which a later measurement would beat for
  // any reason at all — the assertion below would then pass without the
  // resize observer that makes it true.
  await expect.poll(offset).toBeGreaterThan(40);
  const wideOffset = await offset();
  const wideWidth = (await box(body)).width;

  await page
    .getByRole("button", { name: "Split", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => (await box(body)).width)
    .toBeLessThan(wideWidth);

  // The paragraph now wraps onto more lines, so the caret — and the mark that
  // is supposed to be beside it — sits further down inside the textarea.
  await expect.poll(offset).toBeGreaterThan(wideOffset);

  //...and it is still in the margin of the narrower column.
  const splitTrigger = await box(trigger);
  const splitBody = await box(body);
  expect(splitTrigger.x + splitTrigger.width).toBeLessThanOrEqual(splitBody.x);
});

test("the slash command still opens the same menu", async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { body, menu } = await openEditor(page);

  await body.click();
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Heading 1");
});
