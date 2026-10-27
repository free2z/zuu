import { expect, test, type Page } from "@playwright/test";

/**
 * The language picker as a real control in a real browser (part of
 *  ws5).
 *
 * The unit tests in `tests/language-picker.test.mjs` cover the ordering, the
 * grouping and the matching. What they cannot cover is the half that only
 * exists once the component is mounted: that the input really is a combobox,
 * that arrow keys really move `aria-activedescendant` through a filtered list,
 * that Enter really picks the row the creator is looking at, and that Escape
 * really hands focus back to the button that opened it. A picker whose logic is
 * perfect and whose keyboard does nothing is still unusable at 50 rows.
 *
 * Negative controls, each run against this spec, with `svelte-check` confirming
 * the tree still compiled (a broken build makes an absence assertion pass for
 * the wrong reason). Recorded output is in the PR for:
 *  - deleting the `ArrowDown`/`ArrowUp` case from `onSearchKeydown`: only "the
 *    list is walkable from the keyboard" goes red — `aria-activedescendant`
 *    never moves. 5 passed.
 *  - deleting the `Enter` case: only "Enter opens the row the cursor is on"
 *    goes red; the URL never leaves the source language. 5 passed.
 *  - deleting `restoreFocus()` from `close()`: only "Escape closes the picker
 *    and gives focus back" goes red. 5 passed.
 *  - replacing the autonym's `<bdi dir lang>` with a plain `<span>`: only "an
 *    RTL autonym is isolated" goes red. 5 passed.
 *  - deleting `role="combobox"` from the input takes every test down, because
 *    `openPicker` finds the search box by that role. That is the intended
 *    coupling, not a stray failure.
 *  - the whole component as it stood before the codex review on  (index
 *    tracking, no composition guard): "an IME confirming a candidate does not
 *    pick a language" and "the cursor stays on the same language when the list
 *    grows underneath it" go red, the latter reporting the cursor on
 *    **Italian** where Japanese is selected. 7 passed.
 *  - not placing the cursor on the selection at all: the two cursor tests go
 *    red. 7 passed.
 *
 * "Escape closes the picker and gives focus back" is here because it FAILED
 * first: `returnFocusTo` was captured in an `$effect`, which runs after the
 * `use:` action has already moved focus into the search box, so the picker
 * politely handed focus back to a node it had just detached. No unit test could
 * have seen it.
 */

const CREATOR = {
  id: 1932,
  username: "language-picker-owner",
  full_name: "Language Picker Owner",
};

const ARTICLE_ID = "language-picker-fixture";
const UPDATED_AT = "2026-09-01T00:00:00Z";
const SOURCE_TITLE = "An article with exactly one language so far";

function articleResponse(language: string, availableLanguages: string[]) {
  return {
    id: 1932,
    free2zaddr: ARTICLE_ID,
    vanity: ARTICLE_ID,
    title: SOURCE_TITLE,
    description: "The subtitle, which the picker never touches.",
    canonical_url: "https://example.test/language-picker",
    content: "# The source article\n\nA paragraph in the original language.",
    tags: ["zcash"],
    category: "TECHNOLOGY",
    is_published: true,
    variant_is_published: language === "en",
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "u-source-address",
    creator: CREATOR,
    source_language: "en",
    requested_language: language,
    actual_language: language === "en" ? "en" : "en",
    fallback_used: language !== "en",
    available_languages: availableLanguages,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: UPDATED_AT,
    published_at: "2026-08-20T00:00:00Z",
  };
}

const sourceRow = {
  language: "en",
  origin: "source",
  is_published: true,
  is_stale: false,
  title: SOURCE_TITLE,
  description: "The subtitle, which the picker never touches.",
  updated_at: UPDATED_AT,
};

async function stubApi(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const { pathname, searchParams } = new URL(route.request().url());

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        await route.fulfill({
          json: articleResponse(searchParams.get("lang") || "en", ["en"]),
        });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/`) {
        await route.fulfill({ json: [sourceRow] });
        return;
      }
      if (pathname.startsWith(`/api/zpage/${ARTICLE_ID}/variants/`)) {
        if (pathname.endsWith("/variants/en/")) {
          await route.fulfill({
            json: articleResponse("en", ["en"]),
            headers: { ETag: '"en-source"' },
          });
          return;
        }
        await route.fulfill({ status: 404, json: { detail: "Not found" } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
}

const addButton = (page: Page) =>
  page.getByRole("button", { name: "Add a translation", exact: true });
const searchBox = (page: Page) => page.getByRole("combobox");
const options = (page: Page) => page.getByRole("option");

/** Open the editor and get the "add a translation" picker on screen. */
async function openPicker(page: Page) {
  await stubApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: /^Translations/ }).click();
  await addButton(page).click();
  await expect(searchBox(page)).toBeFocused();
}

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const warmPage = await context.newPage();
  await stubApi(warmPage);
  await warmPage.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(warmPage.getByPlaceholder("Article title...")).toBeVisible({
    timeout: 60_000,
  });
  await context.close();
});

test("the search box is a combobox wired to the listbox", async ({ page }) => {
  await openPicker(page);
  const box = searchBox(page);
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await expect(box).toHaveAttribute("aria-autocomplete", "list");

  const listboxId = await box.getAttribute("aria-controls");
  expect(listboxId).toBeTruthy();
  await expect(page.locator(`#${listboxId}`)).toHaveAttribute(
    "role",
    "listbox",
  );

  // A list built for four entries is not what is on screen.
  expect(await options(page).count()).toBeGreaterThan(20);
});

test("typing narrows the list, by name and by raw tag", async ({ page }) => {
  await openPicker(page);
  const box = searchBox(page);

  await box.fill("portug");
  await expect(options(page)).toHaveCount(2);
  // Both Portuguese variants, under one heading naming the LANGUAGE.
  await expect(page.getByRole("group", { name: "Portuguese" })).toBeVisible();

  // The tag is a search key, because `pt-PT` is how a European Portuguese
  // creator names their language and "European Portuguese" is not.
  await box.fill("pt-PT");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute(
    "aria-label",
    "European Portuguese",
  );

  // Accents are not a barrier: the autonym is a key too, folded.
  await box.fill("espanol");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("aria-label", "Spanish");
});

test("the list is walkable from the keyboard", async ({ page }) => {
  await openPicker(page);
  const box = searchBox(page);
  await box.fill("chinese");
  await expect(options(page)).toHaveCount(2);

  const first = await box.getAttribute("aria-activedescendant");
  expect(first).toBeTruthy();
  await box.press("ArrowDown");
  const second = await box.getAttribute("aria-activedescendant");
  expect(second).not.toEqual(first);
  // Wrapping: from the last row, down returns to the first.
  await box.press("ArrowDown");
  expect(await box.getAttribute("aria-activedescendant")).toEqual(first);
  // And End reaches the bottom in one key.
  await box.press("End");
  expect(await box.getAttribute("aria-activedescendant")).toEqual(second);
});

test("Enter opens the row the cursor is on", async ({ page }) => {
  await openPicker(page);
  const box = searchBox(page);
  await box.fill("pt-PT");
  await expect(options(page)).toHaveCount(1);
  await box.press("Enter");

  await expect(page).toHaveURL(/lang=pt-PT/, { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("typing a code and pressing Enter opens THAT language", async ({
  page,
}) => {
  // `fr` is a substring of "Afrikaans", which sorts first, so the cursor used
  // to sit on Afrikaans while the creator was plainly asking for French — and
  // this key, in the relabel picker, PATCHes the article. Found by the codex
  // review on.
  await openPicker(page);
  const box = searchBox(page);
  await box.fill("fr");

  // The collision is on screen: Afrikaans really is the first row.
  await expect(options(page).first()).toHaveAttribute(
    "aria-label",
    "Afrikaans",
  );
  const active = await box.getAttribute("aria-activedescendant");
  await expect(page.locator(`#${active}`)).toHaveAttribute(
    "aria-label",
    "French",
  );

  await box.press("Enter");
  await expect(page).toHaveURL(/lang=fr/, { timeout: 30_000 });
});

test("Escape closes the picker and gives focus back", async ({ page }) => {
  await openPicker(page);
  await searchBox(page).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus lands back on the control that opened it, not at the top of the
  // document — which is where a keyboard user would otherwise have to start
  // over from.
  await expect(addButton(page)).toBeFocused();
});

test("choosing a language does not steal focus from what it opened", async ({
  page,
}) => {
  // Choosing with unsaved edits opens the Save/Discard prompt, whose own mount
  // focuses "Save and switch". The picker's focus-return then fired and pulled
  // focus to the "Add a translation" button BEHIND that prompt, so Enter
  // reopened the picker instead of confirming the dialog the creator was
  // looking at. Found by the codex review on.
  await stubApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByPlaceholder("Article title...").fill("An edited title");
  await page.getByRole("button", { name: /^Translations/ }).click();
  await addButton(page).click();
  await expect(searchBox(page)).toBeFocused();

  await searchBox(page).fill("pt-PT");
  await expect(options(page)).toHaveCount(1);
  await searchBox(page).press("Enter");

  // The prompt is up, and it still owns the keyboard.
  const save = page.getByRole("button", { name: "Save and switch" });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await expect(addButton(page)).not.toBeFocused();
  const focusedInDialog = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active?.closest('[role="dialog"]'));
  });
  expect(focusedInDialog).toBe(true);
});

test("an RTL autonym is isolated, and its row is not", async ({ page }) => {
  await openPicker(page);
  await searchBox(page).fill("arabic");
  await expect(options(page)).toHaveCount(1);

  const autonym = options(page).first().locator("bdi");
  await expect(autonym).toHaveAttribute("dir", "rtl");
  await expect(autonym).toHaveAttribute("lang", "ar");
  await expect(autonym).toHaveText("العربية");

  // The row itself stays LTR: only the autonym flips, which is the whole
  // reason it is in a `<bdi>` rather than the row carrying `dir`.
  await expect(options(page).first()).not.toHaveAttribute("dir", "rtl");
});

/**
 * The relabel picker, which is the dangerous one: picking a row here PATCHes
 * the article's source language. `openPicker` opens the "add a translation"
 * picker, which only navigates.
 */
async function openRelabelPicker(page: Page, recent: string[]) {
  await stubApi(page);
  await page.goto("/");
  await page.evaluate((tags) => {
    localStorage.setItem(
      "free2z-recent-content-languages",
      JSON.stringify(tags),
    );
  }, recent);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "change", exact: true }).click();
  await expect(searchBox(page)).toBeFocused();
}

test("the cursor starts on the article's own language, not on a suggestion", async ({
  page,
}) => {
  // The article is Japanese; the browser says English and the creator recently
  // used Arabic and Filipino. So the top of the list is English — and the row
  // the cursor must be on is fifty rows further down. Getting this wrong in
  // the RELABEL picker means Enter rewrites the article's language.
  await stubApiLateVariants(page, 0);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "free2z-recent-content-languages",
      JSON.stringify(["ar", "fil"]),
    );
  });
  await page.goto(`/edit?id=${LATE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "change", exact: true }).click();
  await expect(searchBox(page)).toBeFocused();

  // The suggestions really did load, and they really are at the top —
  // otherwise this test would be asserting against a list that never moved.
  await expect(page.getByRole("option", { name: "Arabic" })).toHaveCount(2);
  const options_ = page.getByRole("option");
  await expect(options_.first()).toHaveAttribute("aria-label", "English");

  const id = await searchBox(page).getAttribute("aria-activedescendant");
  expect(id).toBeTruthy();
  await expect(page.locator(`#${id}`)).toHaveAttribute(
    "aria-label",
    "Japanese",
  );
  await expect(page.locator(`#${id}`)).toHaveAttribute("aria-selected", "true");
});

test("the announced count is languages, not rows", async ({ page }) => {
  // A suggestion repeats a row that also appears in its language group. Saying
  // "2 languages" when both rows select `ar` announces a choice that does not
  // exist — and a screen-reader user has no other way to tell. Found by the
  // codex review on.
  await stubApiLateVariants(page, 0);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "free2z-recent-content-languages",
      JSON.stringify(["ar"]),
    );
  });
  await page.goto(`/edit?id=${LATE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "change", exact: true }).click();
  await searchBox(page).fill("arabic");

  // Two ROWS, both of them Arabic.
  await expect(options(page)).toHaveCount(2);
  // The page has other polite live regions (toasts, the save indicator), so
  // this is scoped to the picker's own.
  await expect(
    page.getByRole("dialog").locator("p[aria-live='polite']"),
  ).toHaveText("1 languages");
});

test("an IME confirming a candidate does not pick a language", async ({
  page,
}) => {
  // Also from the codex review. Enter during composition CONFIRMS a candidate —
  // it is how a Japanese or Chinese creator types at all. Treating it as
  // "choose the highlighted row" turns typing into a relabel of the article.
  await openRelabelPicker(page, []);
  await searchBox(page).fill("nihongo");

  const composed = await page.evaluate(() => {
    const box = document.querySelector('[role="combobox"]');
    if (!box) return "no combobox";
    for (const key of ["ArrowDown", "Enter", "Escape"]) {
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return "dispatched";
  });
  expect(composed).toBe("dispatched");

  // Still open, still on the same article language, nothing chosen.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(searchBox(page)).toHaveValue("nihongo");

  // And the SAME events without `isComposing` do act — otherwise this test
  // would pass against a picker whose keyboard is simply broken.
  const acted = await page.evaluate(() => {
    const box = document.querySelector('[role="combobox"]');
    if (!box) return "no combobox";
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    return "dispatched";
  });
  expect(acted).toBe("dispatched");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * A second article whose variant list arrives LATE and carries a language the
 * sell list does not: `yue-Hans`, Simplified Cantonese.
 *
 * This is the shape that makes an index into the option list wrong. The picker
 * can be open before `/variants/` answers, and when it does the list gains a
 * row — filed under Cantonese, which sorts above Japanese — so every index
 * below it shifts by one while the creator is looking at it.
 *
 * `yue-Hans` rather than Icelandic on purpose:  decided the sellable
 * Cantonese is `yue-Hant`, while Icelandic is a language the platform may well
 * start selling, and a browser spec must not be the reason it cannot. The
 * "not there yet" assertion below is what makes a wrong choice fail loudly
 * instead of passing for no reason.
 */
const LATE_ID = "language-picker-late-variants";
const LATE_VARIANTS_MS = 4_000;

async function stubApiLateVariants(page: Page, delayMs = LATE_VARIANTS_MS) {
  const article = {
    ...articleResponse("ja", ["ja"]),
    free2zaddr: LATE_ID,
    vanity: LATE_ID,
    source_language: "ja",
    requested_language: "ja",
    actual_language: "ja",
    fallback_used: false,
    variant_is_published: true,
  };
  const jaRow = { ...sourceRow, language: "ja" };
  const extraRow = {
    ...sourceRow,
    language: "yue-Hans",
    origin: "human",
    is_published: false,
  };

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (pathname === `/api/zpage/${LATE_ID}/`) {
        await route.fulfill({ json: article });
        return;
      }
      if (pathname === `/api/zpage/${LATE_ID}/variants/`) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        await route.fulfill({ json: [jaRow, extraRow] });
        return;
      }
      if (pathname === `/api/zpage/${LATE_ID}/variants/ja/`) {
        await route.fulfill({ json: article, headers: { ETag: '"ja"' } });
        return;
      }
      if (pathname.startsWith(`/api/zpage/${LATE_ID}/variants/`)) {
        await route.fulfill({ status: 404, json: { detail: "Not found" } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
}

test("the cursor stays on the same language when the list grows underneath it", async ({
  page,
}) => {
  // The codex review on  found this class: the active row was tracked by
  // INDEX, and the option list is not stable. `relabelLanguages` is derived
  // from `/variants/`, which can answer after the picker is already open and
  // adds a language the sell list does not carry — filed under Cantonese, so
  // sorted above Japanese, so every index below it shifts by one. The
  // highlighted row silently becomes a different language, and this is the
  // RELABEL picker: Enter PATCHes the article's source language to whatever is
  // highlighted.
  await stubApiLateVariants(page);
  await page.goto(`/edit?id=${LATE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "change", exact: true }).click();
  await expect(searchBox(page)).toBeFocused();

  const activeLabel = async () => {
    const id = await searchBox(page).getAttribute("aria-activedescendant");
    expect(id).toBeTruthy();
    return page.locator(`#${id}`).getAttribute("aria-label");
  };

  // The article's own language, which is where the cursor must start.
  expect(await activeLabel()).toBe("Japanese");

  // Now the late variant lands and the list grows above the cursor. The
  // "not there yet" half matters: without it, a `yue-Hans` that had quietly
  // become sellable would already be on screen, the list would never grow, and
  // this test would pass having exercised nothing.
  await expect(
    page.getByRole("option", { name: "Cantonese (Simplified)" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Cantonese (Simplified)" }),
  ).toBeVisible({ timeout: LATE_VARIANTS_MS + 20_000 });

  expect(await activeLabel()).toBe("Japanese");
});

/**
 * An article written in a language THIS BROWSER CANNOT NAME, whose catalog
 * arrives late.
 *
 * `abe` (Abenaki) has no CLDR name in Node's or Chromium's ICU build, so until
 * `/api/languages/` answers, the picker has no row for it at all — a raw tag
 * must never reach a reader. The cursor therefore cannot be placed at
 * mount, and this is the relabel picker: whatever it rests on is what Enter
 * writes to the article.
 */
const NAMELESS_ID = "language-picker-served-name";
const CATALOG_MS = 4_000;

async function stubApiServedName(page: Page) {
  const article = {
    ...articleResponse("abe", ["abe"]),
    free2zaddr: NAMELESS_ID,
    vanity: NAMELESS_ID,
    source_language: "abe",
    requested_language: "abe",
    actual_language: "abe",
    fallback_used: false,
    variant_is_published: true,
  };
  const abeRow = { ...sourceRow, language: "abe" };

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (pathname === "/api/languages/") {
        await new Promise((resolve) => setTimeout(resolve, CATALOG_MS));
        await route.fulfill({
          json: {
            locale: "en",
            languages: [
              {
                tag: "abe",
                name: "Abenaki",
                autonym: "Wôbanakiôdwawôgan",
                script: "Latn",
                direction: "ltr",
                translatable: true,
              },
              {
                tag: "en",
                name: "English",
                autonym: "English",
                script: "Latn",
                direction: "ltr",
                translatable: true,
              },
            ],
          },
        });
        return;
      }
      if (pathname === `/api/zpage/${NAMELESS_ID}/`) {
        await route.fulfill({ json: article });
        return;
      }
      if (pathname === `/api/zpage/${NAMELESS_ID}/variants/`) {
        await route.fulfill({ json: [abeRow] });
        return;
      }
      if (pathname === `/api/zpage/${NAMELESS_ID}/variants/abe/`) {
        await route.fulfill({ json: article, headers: { ETag: '"abe"' } });
        return;
      }
      if (pathname.startsWith(`/api/zpage/${NAMELESS_ID}/variants/`)) {
        await route.fulfill({ status: 404, json: { detail: "Not found" } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
}

test("a language only the server can name still takes the cursor when it arrives", async ({
  page,
}) => {
  // Found by the codex review on: the cursor was placed once, at mount,
  // and a row that did not exist yet could not take it — so it sat on the
  // first suggestion (English) and Enter replaced the article's language.
  await stubApiServedName(page);
  await page.goto(`/edit?id=${NAMELESS_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "change", exact: true }).click();
  await expect(searchBox(page)).toBeFocused();

  // The precondition: the browser cannot name it, so there is no row yet.
  await expect(page.getByRole("option", { name: "Abenaki" })).toHaveCount(0);

  // And with no row to rest on, there is NO cursor — so Enter does nothing.
  // Resting on "the first row" here put it on English, and this key writes the
  // article's source language.
  await expect(searchBox(page)).not.toHaveAttribute("aria-activedescendant");
  await searchBox(page).press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  // Still the picker, still nothing chosen — the editor did not navigate and
  // the search box still has the keyboard.
  await expect(searchBox(page)).toBeFocused();

  // The catalog answers and the row appears — and the cursor is on it.
  await expect(page.getByRole("option", { name: "Abenaki" })).toBeVisible({
    timeout: CATALOG_MS + 20_000,
  });
  const active = await searchBox(page).getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  await expect(page.locator(`#${active}`)).toHaveAttribute(
    "aria-label",
    "Abenaki",
  );
});
