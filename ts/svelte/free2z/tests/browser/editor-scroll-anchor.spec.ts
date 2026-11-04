import { expect, test, type Page } from "@playwright/test";

/**
 * Typing in a long zPage body must not move the page ( — P0).
 *
 * The editor auto-grows its textarea to fit the body, and `/edit` has no inner
 * scroll container: the DOCUMENT scrolls, and the body textarea IS the
 * document's height. The old auto-grow set `height: auto` before measuring, so
 * every keystroke momentarily collapsed a multi-thousand-pixel element to its
 * 400px floor. The browser clamped `document.scrollingElement.scrollTop` to
 * the collapsed maximum, restoring the height did not bring the offset back,
 * and the browser's native caret reveal then scrolled the minimum distance to
 * expose the caret — parking the caret's line flush against the BOTTOM of the
 * window with the entire document above it. Every keystroke.
 *
 * WHY THIS IS A BROWSER SPEC AND NOT A UNIT TEST. The whole defect is a
 * scroll clamp, which requires real layout: jsdom has no layout, reports
 * `scrollHeight === 0`, and never clamps anything, so a jsdom version of this
 * test passes against the broken code — the exact "test that passes without
 * testing" this repo warns about.
 *
 * WHY THE PRECONDITIONS BELOW ARE ASSERTIONS. "The scroll offset did not
 * change" passes trivially on a page that was never scrollable and on a
 * keystroke that never reached the textarea. So this spec asserts, before it
 * asserts anything about scrolling: that the document really has thousands of
 * pixels of scroll range, that we really are scrolled into the middle of it,
 * that the click really landed inside the text, and that the keystroke really
 * changed the value. Remove the fix and this spec fails on the scroll
 * assertion — that negative control is recorded in the PR for.
 */

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/** Where in the document we park before typing. */
const SCROLL_OFFSET = 2000;

/**
 * Where in the VIEWPORT we click. Near the top on purpose: the broken
 * behaviour re-reveals the caret at the BOTTOM edge, so the further up the
 * caret starts, the larger and less ambiguous the jump it produces.
 */
const CLICK_VIEWPORT_Y = 250;

const TEST_CREATOR = {
  id: 4343,
  username: "scroll-anchor-user",
  full_name: "Scroll Anchor User",
};

/**
 * ~600 paragraphs, well past 10k characters, so the grown textarea is many
 * viewports tall and the collapse to the 400px floor is unmistakable.
 */
const LONG_BODY = Array.from(
  { length: 600 },
  (_, index) =>
    `Paragraph ${index + 1}. The quick brown fox jumps over the lazy dog.`,
).join("\n");

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

function documentScroll(page: Page) {
  return page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;

    return {
      top: scroller.scrollTop,
      max: scroller.scrollHeight - scroller.clientHeight,
    };
  });
}

test("typing in a long body leaves the page scroll exactly where it was", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page);
  await page.goto("/edit");

  const body = page.locator("textarea.writing-area-textarea");
  // Generous: on a cold shard Vite pre-bundles dependencies and compiles
  // `/edit` on this first request, which has been observed to take well over
  // the 5s default. That is a slow dev server, not a broken editor, and it
  // must not read as one.
  await expect(body).toBeVisible({ timeout: 60_000 });

  await body.fill(LONG_BODY);

  // PRECONDITION: the textarea auto-grew to hold the whole body. This is also
  // the acceptance criterion that growth still works at all — a "fix" that
  // simply stopped resizing would fail right here rather than sail through the
  // scroll assertion below.
  await expect
    .poll(() => body.evaluate((element) => element.clientHeight), {
      timeout: 10_000,
    })
    .toBeGreaterThan(5_000);

  //...and grew rather than gaining an inner scrollbar. `overflow-hidden`
  // means a short textarea would hide the body instead of scrolling it.
  const overflow = await body.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);

  // PRECONDITION: the DOCUMENT is the scroller and has real range. Without
  // this, "the scroll did not move" is a statement about a page that could not
  // move in the first place.
  const range = await documentScroll(page);
  expect(range.max).toBeGreaterThan(SCROLL_OFFSET + DESKTOP_VIEWPORT.height);

  await page.evaluate((offset) => {
    (document.scrollingElement ?? document.documentElement).scrollTop = offset;
  }, SCROLL_OFFSET);

  // Put the caret near the TOP of the viewport by clicking there, so the caret
  // is already visible and no legitimate caret reveal is owed. `mouse.click`
  // rather than `locator.click`: the textarea is ~20,000px tall, and clicking
  // its centre would scroll the page on our behalf.
  const bodyBox = await body.boundingBox();
  expect(bodyBox).not.toBeNull();
  await page.mouse.click(bodyBox!.x + 200, CLICK_VIEWPORT_Y);

  // PRECONDITION: the click landed inside the body text, not at offset 0 and
  // not on some other element.
  await expect(body).toBeFocused();
  const caretBefore = await body.evaluate(
    (element) => (element as HTMLTextAreaElement).selectionStart ?? 0,
  );
  expect(caretBefore).toBeGreaterThan(0);

  const before = await documentScroll(page);
  // PRECONDITION: we are genuinely parked mid-document, so there is an offset
  // available to lose.
  expect(before.top).toBeGreaterThan(1_000);

  const valueBefore = await body.inputValue();

  // The defect reproduces on EVERY keystroke, so type several and check after
  // each one: a fix that merely survives the first character is not a fix.
  for (const character of ["a", "b", "c"]) {
    await page.keyboard.type(character);

    // The resize runs in a microtask off the value effect, and the gutter
    // control re-measures on a 100ms debounce. Give both room to move the page
    // before concluding that it did not.
    await page.waitForTimeout(250);

    const after = await documentScroll(page);
    expect(
      after.top,
      `page scrolled by ${after.top - before.top}px after typing "${character}"`,
    ).toBe(before.top);
  }

  // PRECONDITION: the keystrokes actually reached the textarea.
  expect(await body.inputValue()).not.toBe(valueBefore);

  // The gutter "+" is still parked on the caret's line rather than stranded at
  // the top of a 20,000px element. It is absolutely positioned inside the
  // textarea's box, so this is measured in viewport coordinates against where
  // we clicked. Generous tolerance: one line height plus the button's own
  // height.
  const trigger = page.getByTestId("editor-insert-trigger");
  await expect
    .poll(async () => {
      const triggerBox = await trigger.boundingBox();
      return triggerBox
        ? Math.abs(
            triggerBox.y + triggerBox.height / 2 - (CLICK_VIEWPORT_Y + 8),
          )
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(80);
});
