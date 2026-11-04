import { expect, test, type Locator, type Page } from "@playwright/test";

// The editor half of. A creator who bought an Arabic translation opened it
// to review and was typing into a left-to-right textarea: the caret started at
// the wrong end of every line, the title and subtitle were left-aligned, and the
// gutter "+" from  — parked in the writing column's LEFT margin — sat past
// the end of every line instead of before its start.
//
// Three things have to be true at once, which is why this is a browser spec and
// not a props test:
//
//   1. the WRITING SURFACE runs the way the article runs,
//   2. the editor CHROME does not (toolbar, slash menu, Translations panel — the
//      creator's product UI is English and stays English),
//   3. the PREVIEW agrees with the reader, because a creator must never approve
//      one layout and publish another.

test.describe.configure({ timeout: 120_000 });

const DESKTOP = { width: 1280, height: 900 };

const CREATOR = {
  id: 1939,
  username: "rtl-editor-owner",
  full_name: "RTL Editor Owner",
};

const ARTICLE_ID = "rtl-editor-fixture";
const UPDATED_AT = "2026-09-01T00:00:00Z";

const SOURCE_TITLE = "Fund Zcash development forever";
const SOURCE_DESCRIPTION = "The English subtitle.";
const SOURCE_CONTENT = "First Zcash last";

// Both OPEN with a Latin run — "Zcash", as a real article about this product
// does. That is what makes these assertions distinguish a direction taken from
// the LANGUAGE TAG from `dir="auto"`: the heuristic reads the first strong
// character, finds `Z`, and lays the whole Arabic document out left-to-right.
// With an Arabic-first fixture the suite stayed green against
// `contentDirectionAttribute` hard-wired to `"auto"`.
const ARABIC_TITLE = "Zcash تمويل تطوير إلى الأبد";
const ARABIC_DESCRIPTION = "عنوان فرعي بالعربية";
// Mixed on purpose: a fenced block that must stay left-to-right inside prose
// that must not.
const ARABIC_CONTENT = [
  "Zcash أول آخر",
  "",
  "```sh",
  "npm run build && echo done",
  "```",
].join("\n");

function articleResponse({
  language,
  title,
  description,
  content,
}: {
  language: string;
  title: string;
  description: string;
  content: string;
}) {
  return {
    id: 1939,
    free2zaddr: ARTICLE_ID,
    vanity: ARTICLE_ID,
    title,
    description,
    canonical_url: "",
    content,
    tags: ["zcash"],
    category: "TECHNOLOGY",
    is_published: true,
    variant_is_published: true,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "u-source-address",
    creator: CREATOR,
    source_language: "en",
    requested_language: language,
    actual_language: language,
    fallback_used: false,
    available_languages: ["en", "ar"],
    created_at: "2026-08-20T00:00:00Z",
    updated_at: UPDATED_AT,
    published_at: "2026-08-20T00:00:00Z",
  };
}

const SOURCE = articleResponse({
  language: "en",
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  content: SOURCE_CONTENT,
});

const ARABIC = articleResponse({
  language: "ar",
  title: ARABIC_TITLE,
  description: ARABIC_DESCRIPTION,
  content: ARABIC_CONTENT,
});

const variantRows = [
  {
    language: "en",
    origin: "source",
    is_published: true,
    is_stale: false,
    title: SOURCE_TITLE,
    description: SOURCE_DESCRIPTION,
    updated_at: UPDATED_AT,
  },
  {
    language: "ar",
    origin: "ai",
    is_published: true,
    is_stale: false,
    title: ARABIC_TITLE,
    description: ARABIC_DESCRIPTION,
    updated_at: UPDATED_AT,
  },
];

async function stubApi(
  page: Page,
  { holdFirstCreate = false }: { holdFirstCreate?: boolean } = {},
) {
  /** Every create payload the editor sent, for the autosave test below. */
  const creates: Array<Record<string, unknown>> = [];
  const createAddresses: string[] = [];
  /** Every relabel PATCH body, so a test can prove the relabel really happened. */
  const relabels: Array<Record<string, unknown>> = [];
  /** Methods of every save to a session-created draft, for the detection test. */
  const saves: string[] = [];
  let markFirstCreateStarted!: () => void;
  let releaseHeldCreate!: () => void;
  const firstCreateStarted = new Promise<void>((resolve) => {
    markFirstCreateStarted = resolve;
  });
  const heldCreateResponse = new Promise<void>((resolve) => {
    releaseHeldCreate = resolve;
  });

  // A predicate, not a `**/api/**` glob: Vite serves source modules from paths
  // such as /src/lib/api/config.ts, which the glob also matches.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      // The first autosave of a brand-new draft. The real endpoint keeps the
      // `source_language` the editor sent, which for a fresh `/edit` is the
      // creator's UI locale — so the response genuinely says "en" over Arabic
      // text. That is the shape the direction must survive.
      if (pathname === "/api/zpage/" && request.method() === "POST") {
        const payload = JSON.parse(request.postData() || "{}");
        const createIndex = creates.length;
        creates.push(payload);
        const address =
          createIndex === 0
            ? "rtl-new-draft-fixture"
            : "rtl-second-draft-fixture";
        createAddresses.push(address);
        if (holdFirstCreate && createIndex === 0) {
          markFirstCreateStarted();
          await heldCreateResponse;
        }
        await route.fulfill({
          status: 201,
          json: {
            ...articleResponse({
              language: payload.source_language || "en",
              title: payload.title || "",
              description: payload.description || "",
              content: payload.content || "",
            }),
            free2zaddr: address,
            vanity: "",
            is_published: false,
            variant_is_published: false,
            available_languages: [payload.source_language || "en"],
            tags: [],
          },
        });
        return;
      }
      // Saves to a draft this session created. The CREATE response is innocent;
      // detection arrives on a LATER save, which is how it actually happens —
      // `apply_detection` fires from zPage `post_save` and the editor sees its
      // result on the next write's response. The create keeps claiming `en`
      // (the UI locale it was sent), so this response says "the backend has
      // identified Arabic" while `source_language` still says English: exactly
      // the shape that let the detector's own answer license asserting the UI
      // locale's direction (outside review, F5).
      const savedAddress = createAddresses.find(
        (address) => pathname === `/api/zpage/${address}/`,
      );
      if (savedAddress) {
        saves.push(request.method());
        const payload = JSON.parse(request.postData() || "{}");
        if (savedAddress !== "rtl-new-draft-fixture") {
          await route.fulfill({
            json: {
              ...articleResponse({
                language: "en",
                title: payload.title || "",
                description: payload.description || "",
                content: payload.content || "",
              }),
              free2zaddr: savedAddress,
              vanity: "",
              source_language: "en",
              available_languages: ["en"],
              tags: [],
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            ...articleResponse({
              language: "en",
              title: "",
              description: "",
              content: "",
            }),
            free2zaddr: savedAddress,
            vanity: "",
            source_language: "en",
            detected_language: "ar",
            language_source: "detected",
            detection_confidence: 0.99,
            available_languages: ["en"],
            tags: [],
          },
        });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        // The relabel is a PATCH of `source_language` on this same URL, and it
        // has to SUCCEED: the flag it sets is what the "fresh draft" test below
        // depends on, and a failed relabel deliberately does not set it.
        if (request.method() === "PATCH") {
          const body = JSON.parse(request.postData() || "{}");
          relabels.push(body);
          await route.fulfill({
            json: { ...SOURCE, source_language: body.source_language },
          });
          return;
        }
        await route.fulfill({
          json: searchParams.get("lang") === "ar" ? ARABIC : SOURCE,
        });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/`) {
        await route.fulfill({ json: variantRows });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/ar/`) {
        await route.fulfill({ json: ARABIC, headers: { ETag: '"ar-1"' } });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/en/`) {
        await route.fulfill({ json: SOURCE, headers: { ETag: '"en-1"' } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return {
    creates,
    createAddresses,
    firstCreateStarted,
    relabels,
    releaseFirstCreate: releaseHeldCreate,
    saves,
  };
}

const body = (page: Page) => page.locator("textarea.writing-area-textarea");
const title = (page: Page) => page.getByPlaceholder("Article title...");
const subtitle = (page: Page) =>
  page.getByPlaceholder("Article subtitle or description...");

/** The direction the browser RESOLVED, which is what a writer experiences. */
function direction(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).direction);
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: DESKTOP });
  const warmPage = await context.newPage();
  await stubApi(warmPage);
  await warmPage.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(warmPage.getByPlaceholder("Article title...")).toBeVisible({
    timeout: 90_000,
  });
  await context.close();
});

test("the writing surface follows the article, and the chrome does not", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await stubApi(page);
  await page.goto(`/edit?lang=ar&id=${ARTICLE_ID}`);

  await expect(title(page)).toHaveValue(ARABIC_TITLE);

  // 1. The surface the creator types into — body, title, subtitle.
  expect(await direction(body(page))).toBe("rtl");
  expect(await direction(title(page))).toBe("rtl");
  expect(await direction(subtitle(page))).toBe("rtl");
  // `lang` too, so spellcheck and a screen reader are told which language this
  // is; `dir` and `lang` are independent and both are wanted here.
  await expect(body(page)).toHaveAttribute("lang", "ar");

  // 2. The chrome is the creator's product UI, which is English. The insert
  //    control's own label is UI text and must not be reversed.
  const trigger = page.getByTestId("editor-insert-trigger");
  await expect(trigger).toHaveAccessibleName("Insert content");
  expect(await direction(page.locator("header").first())).toBe("ltr");
  expect(await direction(trigger)).toBe("ltr");
  expect(await direction(page.locator("html"))).toBe("ltr");
  // The slash menu is chrome too, and it is rendered OUTSIDE the surface's
  // wrapper on purpose — so it keeps the UI direction rather than inheriting
  // the article's.
  await body(page).click();
  await body(page).press("End");
  await body(page).pressSequentially("\n/");
  const slashMenu = page.locator("#editor-command-menu");
  await expect(slashMenu).toBeVisible();
  expect(await direction(slashMenu)).toBe("ltr");
});

test("the gutter insert control moves to the other margin", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await stubApi(page);

  // The LTR baseline first, so the RTL assertion below is a difference rather
  // than an absolute nobody can check.
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue(SOURCE_TITLE);
  const englishBody = await box(body(page));
  const englishTrigger = await box(page.getByTestId("editor-insert-trigger"));
  // Entirely before the text column starts: it can never overlap a character,
  // which is what would let it steal a tap meant for the start of a line
  //.
  expect(englishTrigger.x + englishTrigger.width).toBeLessThanOrEqual(
    englishBody.x + 1,
  );

  await page.goto(`/edit?lang=ar&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue(ARABIC_TITLE);
  const arabicBody = await box(body(page));
  const arabicTrigger = await box(page.getByTestId("editor-insert-trigger"));
  // In Arabic a line STARTS on the right, so the margin mark belongs there. A
  // "+" nailed to the left margin sits past the end of every line — after the
  // text it is offering to insert before.
  expect(arabicTrigger.x).toBeGreaterThanOrEqual(
    arabicBody.x + arabicBody.width - 1,
  );
  //...and still on screen at this width.
  expect(arabicTrigger.x + arabicTrigger.width).toBeLessThanOrEqual(
    DESKTOP.width,
  );
  // Still a real button, and its menu still opens.
  await page.getByTestId("editor-insert-trigger").click();
  await expect(page.locator("#editor-command-menu")).toBeVisible();
});

test("the preview lays the article out exactly as the reader will", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await stubApi(page);
  await page.goto(`/edit?lang=ar&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue(ARABIC_TITLE);

  // Split mode, so the writing surface and the preview are on screen together —
  // where a disagreement between them is visible in one glance.
  await page.getByLabel("Split", { exact: true }).click();
  const preview = page.locator("article.preview-content");
  await expect(preview).toBeVisible();

  expect(await direction(preview)).toBe("rtl");
  await expect(preview).toHaveAttribute("lang", "ar");
  // Same per-block rule as the reader: the fenced block stays left-to-right
  // inside the right-to-left prose.
  const pre = preview.locator("pre").first();
  await expect(pre).toContainText("npm run build");
  expect(await direction(pre)).toBe("ltr");
  // And the surface next to it agrees, which is the whole point of the pairing.
  expect(await direction(body(page))).toBe("rtl");
});

test("an unlabelled draft resolves from what is actually typed", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await stubApi(page);
  await page.goto("/edit");
  await expect(body(page)).toBeVisible();

  // No language yet, so the honest answer is `auto` rather than a guessed `ltr`
  // and on a textarea the browser re-resolves it live.
  await expect(body(page)).toHaveAttribute("dir", "auto");
  await expect(title(page)).toHaveAttribute("dir", "auto");

  await body(page).click();
  await body(page).fill("مرحبا بالعالم");
  // The gutter control has to follow, which means reading the direction the
  // ELEMENT resolved rather than keeping a second bidi guess of our own.
  await expect
    .poll(async () => {
      const surface = await box(body(page));
      const trigger = await box(page.getByTestId("editor-insert-trigger"));
      return trigger.x >= surface.x + surface.width - 1;
    })
    .toBe(true);

  //...and back again, because `auto` is a live answer and not a one-time seed.
  await body(page).fill("Hello world");
  await expect
    .poll(async () => {
      const surface = await box(body(page));
      const trigger = await box(page.getByTestId("editor-insert-trigger"));
      return trigger.x + trigger.width <= surface.x + 1;
    })
    .toBe(true);
});

test("the first autosave does not flip an Arabic draft to left-to-right", async ({
  page,
}) => {
  // Codex adversarial review, and it is the failure a creator would actually
  // hit: open `/edit` with an English product UI, type Arabic, and 2.5 seconds
  // later the autosave lands. Keying "do we know the language?" on the article
  // EXISTING made that save flip the surface to left-to-right mid-sentence —
  // `selectedLanguage` still held the UI-locale default `en`, and the backend's
  // detection is five minutes away. A save is not evidence about a language.
  await page.setViewportSize(DESKTOP);
  const { creates } = await stubApi(page);
  await page.goto("/edit");
  await expect(body(page)).toBeVisible();

  await title(page).fill("مقالة جديدة");
  await body(page).click();
  await body(page).fill("أول Zcash آخر\n\nنص عربي كافٍ للحفظ التلقائي.");

  // Wait for the create to actually go out, rather than sleeping: that request
  // IS the transition under test.
  await expect
    .poll(() => creates.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  // It really did claim English, which is what makes the assertion below mean
  // something.
  expect(creates[0].source_language).toBe("en");

  // Still right-to-left after the save, and the gutter mark with it.
  expect(await direction(body(page))).toBe("rtl");
  await expect(body(page)).toHaveAttribute("dir", "auto");
  const surface = await box(body(page));
  const trigger = await box(page.getByTestId("editor-insert-trigger"));
  expect(trigger.x).toBeGreaterThanOrEqual(surface.x + surface.width - 1);
});

test("a fresh draft after a relabel is not given the previous article's direction", async ({
  page,
}) => {
  // Codex adversarial review, round 3 — and it is a defect an EARLIER round of
  // this PR introduced. `languageStatedByCreator` is a session flag, `/edit`
  // reuses this component across a client-side navigation, and nothing cleared
  // it: relabel an article, start a new post, and the fresh draft — which has no
  // language label by construction — was treated as having an explicit one and
  // took `dir="ltr"` from the creator's UI locale.
  //
  // Two things this spec had to get right before it could fail on the bug, and
  // the first version got both wrong and passed anyway:
  //
  //   1. It must really RELABEL. Opening `?lang=ar` sets `explicitLanguage`, a
  //      different signal; only `changeArticleLanguage` sets the flag. So this
  //      drives the language chip and the picker, and asserts the PATCH went out.
  //   2. It must really navigate CLIENT-SIDE. `page.goto` is a full reload, which
  //      constructs a fresh component and destroys the stale flag along with it.
  await page.setViewportSize(DESKTOP);
  const { relabels } = await stubApi(page);

  // 1. The saved English source article.
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue(SOURCE_TITLE);
  await expect(body(page)).toHaveAttribute("dir", "ltr");

  // 2. Relabel it through the product's own control — to HEBREW, not Arabic: the
  //    picker deliberately omits a language the article already has a variant in
  //    (relabelling onto an existing translation would collide), and this fixture
  //    lists `ar`. Hebrew is right-to-left and unused here, so it takes the same
  //    path and still moves the direction.
  await page.getByRole("button", { name: "change", exact: true }).click();
  // `combobox` / `option`, the idiom 's own spec uses: the picker became a
  // real combobox with folding search and script-aware grouping, and the
  // button-inside-a-dialog selectors this spec first used stopped resolving the
  // moment that landed.
  const search = page.getByRole("combobox");
  await expect(search).toBeVisible();
  await search.fill("Hebrew");
  await page.getByRole("option", { name: "Hebrew" }).first().click();

  // The relabel really happened — otherwise the flag was never set and the rest
  // of this test would pass for the wrong reason.
  await expect.poll(() => relabels.length).toBeGreaterThan(0);
  expect(relabels[0].source_language).toBe("he");
  //...and the surface followed it, which is the flag doing its job.
  await expect(body(page)).toHaveAttribute("dir", "rtl");

  // 3. Now start a brand-new draft the way the product does: a CLIENT-SIDE
  //    navigation, which reuses this component. "New post" in the account menu
  //    is `goto("/edit")` (`AuthUserDropdown.svelte`); rather than depend on that
  //    menu being reachable from the editor's own chrome, this clicks a
  //    same-origin anchor injected into the app root, which SvelteKit's router
  //    intercepts through the same code path with no test-only export.
  const navigated = page.waitForURL(
    (url) => url.pathname + url.search === "/edit",
  );
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "spec-new-post";
    link.href = "/edit";
    link.textContent = "New post";
    document.querySelector("div[style='display: contents']")?.append(link);
  });
  await page.click("#spec-new-post");
  await navigated;
  // The document was replaced WITHOUT a reload: the injected anchor survives a
  // client-side navigation and would be gone after a full load. That assertion is
  // what stops this spec silently reverting to the vacuous version.
  await expect(page.locator("#spec-new-post")).toHaveCount(1);
  await expect(title(page)).toHaveValue("");

  // 4. Nobody has said what language THIS draft is in, so the surface asks the
  //    text rather than the previous article or the UI locale.
  await expect(body(page)).toHaveAttribute("dir", "auto");
  await expect(title(page)).toHaveAttribute("dir", "auto");
});

test("a relabelled NEVER-SAVED draft does not direct the next draft either", async ({
  page,
}) => {
  // The outside review's blocking finding, and the FOURTH defect in one flag's
  // lifecycle. The sibling of the test above, entered from `/edit` instead of
  // `?id=`, and that difference is the whole point:
  //
  //   * `updateEditorUrl` uses `replaceState`, which is SHALLOW routing — load
  //     functions do not re-run, so `data.requestedLanguage` still holds the UI
  //     locale after a relabel on a never-saved draft;
  //   * the hydration key is therefore `["new", "en", "new"]` both before and
  //     after a client-side `goto("/edit")`, so the `$effect` guarding
  //     `applyHydratedState` returns early;
  //   * so the reset that round 3 added there never ran, and a latched flag
  //     survived into a document that had stated nothing.
  //
  // Measured harm from the review: relabel to French, then type Arabic into the
  // "fresh" draft, and the surface was explicitly `ltr` with the Arabic laid out
  // backwards.
  //
  // There is no flag to reset any more — `languageIsStated` derives only from
  // state replaced wholesale — so this asserts the OUTCOME on the path that
  // exposed the shape.
  await page.setViewportSize(DESKTOP);
  await stubApi(page);

  // 1. A brand-new draft: nothing has stated a language.
  await page.goto("/edit");
  await expect(body(page)).toBeVisible();
  await expect(body(page)).toHaveAttribute("dir", "auto");

  // 2. Relabel it by hand to FRENCH — a left-to-right language, chosen because
  //    it is the direction that would be WRONG for the Arabic typed in step 4.
  await page.getByRole("button", { name: "change", exact: true }).click();
  const search = page.getByRole("combobox");
  await expect(search).toBeVisible();
  await search.fill("French");
  await page.getByRole("option", { name: "French" }).first().click();

  // No PATCH on this branch — a never-saved draft has no server-side label to
  // change — so the relabel is purely local. That is exactly why the hydration
  // key does not move.
  await expect(page.getByTestId("editor-language-chip")).toContainText(
    "French",
  );

  // 3. Client-side navigation to a new draft. Same URL, so this is the shallow
  //    case: the anchor surviving proves there was no reload.
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "spec-new-post-2";
    link.href = "/edit";
    link.textContent = "New post";
    document.querySelector("div[style='display: contents']")?.append(link);
  });
  await page.click("#spec-new-post-2");
  await expect(page.locator("#spec-new-post-2")).toHaveCount(1);

  // 4. Type ARABIC. Nothing has stated this draft's language, so the surface
  //    must read the text — not the French the previous draft was labelled.
  await body(page).click();
  await body(page).fill("مرحبا بالعالم");

  await expect(body(page)).toHaveAttribute("dir", "auto");
  expect(await direction(body(page))).toBe("rtl");
  //...and the gutter mark followed it, which is the reader-visible half.
  await expect
    .poll(async () => {
      const surface = await box(body(page));
      const trigger = await box(page.getByTestId("editor-insert-trigger"));
      return trigger.x >= surface.x + surface.width - 1;
    })
    .toBe(true);
});

test("New post after autosave starts a separate draft", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const { creates, saves } = await stubApi(page);

  await page.goto("/edit");
  await title(page).fill("draft one title");
  await body(page).fill("The first draft has been autosaved.");

  // Wait for the create response and its shallow URL rewrite before choosing
  // New post. This is the state that used to leave the editor holding the
  // created zPage while its route data still described an unsaved draft.
  await expect.poll(() => creates.length, { timeout: 30_000 }).toBe(1);
  await expect(page).toHaveURL(/\/edit\?lang=en&id=rtl-new-draft-fixture$/);

  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();

  // Keep going after the visible regression so the negative control also
  // observes which endpoint the next save uses.
  await expect.soft(title(page)).toHaveValue("");
  await expect.soft(body(page)).toHaveValue("");

  await title(page).fill("draft two title");
  await body(page).fill("This belongs to a new draft.");
  await expect
    .poll(() => creates.length > 1 || saves.length > 0, { timeout: 30_000 })
    .toBe(true);

  // The new document creates another article; it must never update the first
  // one's address after the New post action.
  expect(saves).toEqual([]);
  expect(creates).toHaveLength(2);
  expect(creates.map((payload) => payload.title)).toEqual([
    "draft one title",
    "draft two title",
  ]);
});

test("a late autosave response cannot reclaim the document after New post", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const {
    creates,
    createAddresses,
    firstCreateStarted,
    releaseFirstCreate,
    saves,
  } = await stubApi(page, { holdFirstCreate: true });

  await page.goto("/edit");
  await title(page).fill("draft one title");
  await body(page).fill("The first draft is still saving.");
  await firstCreateStarted;

  // The leave confirmation's cancel choice keeps the in-flight document and
  // its text in place. A second attempt accepts it and starts a new draft.
  let canceledLeave = false;
  page.once("dialog", async (dialog) => {
    canceledLeave = true;
    await dialog.dismiss();
  });
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();
  await expect.poll(() => canceledLeave).toBe(true);
  await expect(title(page)).toHaveValue("draft one title");
  await expect(body(page)).toHaveValue("The first draft is still saving.");
  expect(creates).toHaveLength(1);

  let acceptedLeave = false;
  page.once("dialog", async (dialog) => {
    acceptedLeave = true;
    await dialog.accept();
  });
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();
  await expect.poll(() => acceptedLeave).toBe(true);
  await expect(title(page)).toHaveValue("");
  await expect(body(page)).toHaveValue("");
  await expect(page).toHaveURL(/\/edit\?newPost=/);

  await title(page).fill("draft two title");
  await body(page).fill("The second draft belongs to a new article.");

  // The first create now answers after the new document has dirty text. Its
  // completion must not set currentZPage, rewrite the URL, clear the busy
  // state, or prevent the second document's own create.
  releaseFirstCreate();
  await expect
    .poll(() => createAddresses.length > 1 || saves.length > 0, {
      timeout: 30_000,
    })
    .toBe(true);

  await expect(title(page)).toHaveValue("draft two title");
  await expect(body(page)).toHaveValue(
    "The second draft belongs to a new article.",
  );
  expect(saves).toEqual([]);
  await expect(page).toHaveURL(/\/edit\?lang=en&id=rtl-second-draft-fixture$/);
  expect(creates.map((payload) => payload.title)).toEqual([
    "draft one title",
    "draft two title",
  ]);
  expect(createAddresses).toEqual([
    "rtl-new-draft-fixture",
    "rtl-second-draft-fixture",
  ]);
});

test("a superseded leave-flush does not prompt over, or navigate away from, the next draft", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const { creates, firstCreateStarted, releaseFirstCreate, saves } =
    await stubApi(page, { holdFirstCreate: true });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto("/edit");
  await title(page).fill("draft one title");
  await body(page).fill("Leaving flushes this draft first.");

  // Before the autosave timer: New post cancels the navigation and flushes
  // the draft (held here), then would navigate once it is saved.
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();
  await firstCreateStarted;
  expect(dialogs).toEqual([]);

  // A second New post while that flush is unresolved asks, and the creator
  // accepts: the editor now holds a different, blank document.
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(title(page)).toHaveValue("");

  await title(page).fill("draft two title");
  await body(page).fill("Typed after the second New post.");

  // The first flush now resolves. It belongs to the document the creator
  // already left: it must not ask about "unsaved changes" again, and must not
  // navigate this editor to its own stale New post destination.
  releaseFirstCreate();
  await expect
    .poll(() => creates.length > 1 || saves.length > 0, { timeout: 30_000 })
    .toBe(true);
  expect(dialogs).toHaveLength(1);
  await expect(title(page)).toHaveValue("draft two title");
  await expect(body(page)).toHaveValue("Typed after the second New post.");
  expect(saves).toEqual([]);
  expect(creates.map((payload) => payload.title)).toEqual([
    "draft one title",
    "draft two title",
  ]);
});

test("backend detection does not license asserting the UI locale's direction", async ({
  page,
}) => {
  // Outside review, F5 — the FIFTH defect in this lifecycle and the only one that
  // was not about staleness. `languageIsStated` carried
  // `currentZPage?.detected_language` and `?.language_source === "detected"`, and
  // used them to license asserting `openLanguage` — which is `selectedLanguage`,
  // which NOTHING ever moves from a save response. So "the backend identified a
  // language" became permission to assert the UI LOCALE's direction.
  //
  // Measured harm: a correct RTL surface, and then the detection arriving on a
  // later autosave flips the whole draft to explicit left-to-right, mislabelled
  // `lang="en"` while the row says `ar`. That is codex round 1's defect verbatim
  // "saving is incorrectly treated as proof that the language is known" — and
  // it was live, not latent: `apply_detection` ships and fires from zPage
  // `post_save`.
  //
  // The transition this exercises is the one the autosave guard above CANNOT
  // reach: that spec stops at the create response and returns the same body for
  // every save, so it asserts precisely the step that was safe.
  await page.setViewportSize(DESKTOP);
  const { creates, saves } = await stubApi(page);
  await page.goto("/edit");
  await expect(body(page)).toBeVisible();

  await title(page).fill("مقالة جديدة");
  await body(page).click();
  await body(page).fill("أول Zcash آخر\n\nنص عربي كافٍ للحفظ التلقائي.");

  // The create goes out first, claiming the UI locale, and the surface is right.
  await expect
    .poll(() => creates.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(creates[0].source_language).toBe("en");
  expect(await direction(body(page))).toBe("rtl");

  // Now provoke a SECOND save, whose response carries the detection.
  await body(page).press("End");
  await body(page).pressSequentially(" ونص إضافي.");
  await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // The detector said Arabic. `selectedLanguage` still says English. Neither is
  // permission to assert English's direction over Arabic text.
  await expect(body(page)).toHaveAttribute("dir", "auto");
  expect(await direction(body(page))).toBe("rtl");
  expect(await direction(title(page))).toBe("rtl");
  //...and nothing has mislabelled the surface as English.
  await expect(body(page)).not.toHaveAttribute("lang", "en");
});
