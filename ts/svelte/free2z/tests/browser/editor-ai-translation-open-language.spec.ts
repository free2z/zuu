import { expect, test, type Page } from "@playwright/test";

/**
 * Buying an AI translation for the language that is ALREADY OPEN.
 *
 * This is the flow creators actually use — open the empty Chinese draft and have
 * it written — and it was the one flow that did not work. The delivered
 * translation was saved server-side and the editor kept showing a blank
 * document behind four contradictory notices.
 *
 * Two facts about production that `editor-ai-translation-delivery.spec.ts`
 * does not reproduce, and that this file exists to pin:
 *
 * 1. **`updated_at` never moves.** `LocalizedZPageSerializerMixin` overlays
 *    title/description/content for the requested language but `updated_at`
 *    comes straight off the zPage row, and `translation/tasks.py` writes the
 *    variant rows WITHOUT saving the parent. So every response for this
 *    article — before and after delivery — carries the same `updated_at`.
 *    Every fixture here uses one constant for it, on purpose. The delivery
 *    spec gives the delivered variant a later stamp, which is why it never saw
 *    this bug.
 * 2. **A real article has tags.** Hydrating them was enough to mark the editor
 *    dirty with no keystroke, which is what pushed delivery down the
 *    conflict-resolution path instead of the silent-load path.
 *
 * Negative control (run before this landed, against the unfixed editor):
 *  - "a translation bought for the open language loads with no prompt" fails
 *    on its first assertion: the title stays empty, and the blank-draft,
 *    review-paused and content-required notices are all on screen at once.
 *  - "loading a translation leaves nothing for the creator to save" fails with
 *    the editor reporting "Unsaved changes" and a PUT going out on mount.
 *  - "switching away from a freshly loaded translation asks nothing" fails on
 *    the "You have unsaved changes" dialog.
 */

const CREATOR = {
  id: 1905,
  username: "open-language-owner",
  full_name: "Open Language Owner",
};

const ARTICLE_ID = "ai-open-language-fixture";

/**
 * One stamp for every response about this article, forever. See the note
 * above: delivering a translation does not touch `zPage.updated_at`, so a
 * fixture that moves it is testing a server that does not exist.
 */
const UPDATED_AT = "2026-09-01T00:00:00Z";

const SOURCE_TITLE = "How a shielded memo becomes a credit on your balance";
const SOURCE_DESCRIPTION =
  "The original English subtitle, long enough to prove it did not survive.";
const SOURCE_CONTENT = [
  "# The source article",
  "",
  "A paragraph in the original language that must not be what the creator",
  "sees after buying a translation for the language already on screen.",
].join("\n");

const TARGET_TITLE = "屏蔽备注如何成为您余额中的积分";
const TARGET_DESCRIPTION = "翻译后的副标题来自人工智能草稿，而不是原文。";
const TARGET_CONTENT = [
  "# 翻译后的文章",
  "",
  "这段翻译后的正文与原文明显不同，足以发现从未发生过的水合。",
].join("\n");

type SentWrite = {
  pathname: string;
  method: string;
  body: Record<string, unknown> | null;
};

function articleResponse({
  language,
  title,
  description,
  content,
  availableLanguages,
  fallbackUsed = false,
}: {
  language: string;
  title: string;
  description: string;
  content: string;
  availableLanguages: string[];
  fallbackUsed?: boolean;
}) {
  return {
    id: 1905,
    free2zaddr: ARTICLE_ID,
    vanity: ARTICLE_ID,
    title,
    description,
    canonical_url: "https://example.test/the-original",
    content,
    // A real article has tags. Hydrating them used to mark the editor dirty.
    tags: ["zcash", "privacy"],
    category: "TECHNOLOGY",
    is_published: true,
    variant_is_published: language === "en",
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "u-source-address",
    creator: CREATOR,
    source_language: "en",
    requested_language: language,
    actual_language: fallbackUsed ? "en" : language,
    fallback_used: fallbackUsed,
    available_languages: availableLanguages,
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
  availableLanguages: ["en"],
});

/** What `?lang=zh-Hans` answers while no Chinese variant exists: the source. */
const SOURCE_AS_CHINESE_FALLBACK = articleResponse({
  language: "zh-Hans",
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  content: SOURCE_CONTENT,
  availableLanguages: ["en"],
  fallbackUsed: true,
});

const TARGET_DELIVERED = articleResponse({
  language: "zh-Hans",
  title: TARGET_TITLE,
  description: TARGET_DESCRIPTION,
  content: TARGET_CONTENT,
  availableLanguages: ["en", "zh-Hans"],
});

const SOURCE_AFTER_DELIVERY = articleResponse({
  language: "en",
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  content: SOURCE_CONTENT,
  availableLanguages: ["en", "zh-Hans"],
});

const sourceRow = {
  language: "en",
  origin: "source",
  is_published: true,
  is_stale: false,
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  updated_at: UPDATED_AT,
};

const chineseRow = {
  language: "zh-Hans",
  origin: "ai",
  is_published: false,
  is_stale: false,
  title: TARGET_TITLE,
  description: TARGET_DESCRIPTION,
  updated_at: UPDATED_AT,
};

function job(status: "queued" | "delivered") {
  return {
    job_id: "translation-job-1905",
    status,
    zpage_id: 1905,
    language: "zh-Hans",
    source_digest: "source-digest-1905",
    target_digest: null,
    price: 8,
    charged: "8.000",
    refunded: "0.000",
    balance: "92.000",
    ai_model: "fixture-translation-model",
    ai_model_id: "fixture-translation-model-v1",
    error: null,
  };
}

async function stubApi(
  page: Page,
  options: { holdPoll?: boolean; mismatchPoll?: boolean } = {},
) {
  const writes: SentWrite[] = [];
  let delivered = false;
  let purchased = false;

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const method = request.method();

      if (method !== "GET") {
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(request.postData() || "null");
        } catch {
          body = null;
        }
        writes.push({ pathname, method, body });
      }

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        if (searchParams.get("lang") === "zh-Hans") {
          await route.fulfill({
            json: delivered ? TARGET_DELIVERED : SOURCE_AS_CHINESE_FALLBACK,
          });
          return;
        }
        await route.fulfill({
          json: delivered ? SOURCE_AFTER_DELIVERY : SOURCE,
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/zh-Hans/`) {
        if (!delivered) {
          await route.fulfill({ status: 404, json: { detail: "Not found" } });
          return;
        }
        await route.fulfill({
          json: TARGET_DELIVERED,
          headers: { ETag: '"zh-Hans-delivered"' },
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/en/`) {
        await route.fulfill({
          json: delivered ? SOURCE_AFTER_DELIVERY : SOURCE,
          headers: { ETag: '"en-source"' },
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/`) {
        await route.fulfill({
          json: delivered ? [sourceRow, chineseRow] : [sourceRow],
        });
        return;
      }

      if (
        pathname ===
        `/api/zpage/${ARTICLE_ID}/variants/zh-Hans/translate/quote/`
      ) {
        await route.fulfill({
          json: {
            price: 8,
            balance: "100.000",
            affordable: true,
            source_language: "en",
            language: "zh-Hans",
            source_digest: "source-digest-1905",
            ai_model: "fixture-translation-model",
            input_tokens: 321,
            estimated_output_tokens: 234,
            chunks: 1,
            existing_variant: null,
          },
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/zh-Hans/translate/`) {
        if (method === "POST") {
          purchased = true;
          await route.fulfill({ json: job("queued") });
          return;
        }
        if (!purchased) {
          await route.fulfill({ status: 404, json: { detail: "No job" } });
          return;
        }
        // `holdPoll` keeps the job `queued` forever, which is the only way to
        // look at the waiting state. A real job takes minutes.
        if (options.holdPoll) {
          await route.fulfill({ json: job("queued") });
          return;
        }
        // The client STOPS WATCHING a job that never reached a terminal state.
        // A receipt for another language is the reachable way to trigger it
        // (`watchTranslationJob` sets `interrupted`, clears `checking` and
        // returns); the 15-minute poll deadline and a stale receipt restored
        // from `localStorage` land in the identical state by the identical
        // mechanism, which is why one test covers the class.
        if (options.mismatchPoll) {
          await route.fulfill({ json: { ...job("queued"), language: "fr" } });
          return;
        }
        delivered = true;
        await route.fulfill({ json: job("delivered") });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/translations/zh-Hans/`) {
        await route.fulfill({
          json: { ...TARGET_DELIVERED, ...(request.postData() ? {} : {}) },
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return writes;
}

const title = (page: Page) => page.getByPlaceholder("Article title...");
const description = (page: Page) =>
  page.getByPlaceholder("Article subtitle or description...");
const content = (page: Page) => page.locator("textarea.writing-area-textarea");

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

test("a freshly loaded article is not reported as having unsaved changes", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue(SOURCE_TITLE);

  // Long enough for the 2.5s autosave debounce to have fired if anything had
  // marked the document dirty.
  await page.waitForTimeout(4_000);

  await expect(page.locator("header")).toContainText("Autosave on");
  await expect(page.locator("header")).not.toContainText("Unsaved changes");
  expect(writes.filter((write) => write.method === "PUT")).toEqual([]);
});

test("a translation bought for the open language loads with no prompt", async ({
  page,
}) => {
  await stubApi(page);
  // Straight into the blank Chinese draft, the way the creator gets there.
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");
  await expect(content(page)).toHaveValue("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  const chinese = page.locator('[data-language="zh-Hans"]');
  await chinese.getByRole("button", { name: "Translate with AI" }).click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("8 2Z");
  await page.getByTestId("translate-ai-confirm").click();

  // The paid translation is what the creator is looking at, with no detour.
  await expect(title(page)).toHaveValue(TARGET_TITLE, { timeout: 30_000 });
  await expect(description(page)).toHaveValue(TARGET_DESCRIPTION);
  await expect(content(page)).toHaveValue(TARGET_CONTENT);

  // Nothing asked the creator to choose between the translation they paid for
  // and the empty document they never wrote.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("translation-review-status")).toHaveCount(0);

  // And no notice still claims the opposite of what is on screen.
  const bodyText = page.locator("body");
  await expect(bodyText).not.toContainText("waiting for you to write it");
  await expect(bodyText).not.toContainText("Translation in progress");
  await expect(bodyText).not.toContainText("Not saved yet");
  await expect(bodyText).not.toContainText("Saving is paused");

  // The row that was just translated does not offer a first purchase.
  await expect(
    chinese.getByRole("button", { name: "Translate again", exact: true }),
  ).toBeVisible();
  await expect(chinese).toContainText("currently editing");
});

test("the wait reads as waiting, not as a blank page to fill in", async ({
  page,
}) => {
  await stubApi(page, { holdPoll: true });
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");
  // The invitation to write it by hand IS there before the purchase.
  await expect(page.locator("body")).toContainText("waiting for you to write");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();

  //...and gone the moment an AI is being paid to write it. Nobody
  // hand-writes the Chinese while paying for the Chinese.
  const waiting = page.getByTestId("translation-waiting-here");
  await expect(waiting).toBeVisible({ timeout: 30_000 });
  await expect(waiting).toContainText("Translating into Simplified Chinese");
  await expect(page.getByPlaceholder("Article title...")).toHaveCount(0);
  await expect(page.locator("textarea.writing-area-textarea")).toHaveCount(0);

  const bodyText = page.locator("body");
  await expect(bodyText).not.toContainText("waiting for you to write");
  await expect(bodyText).not.toContainText("Not saved yet");
  // State, not a lecture about how to cancel a purchase you just made.
  await expect(bodyText).not.toContainText("refund");
  await expect(bodyText).not.toContainText("can cancel it");
});

test("the price screen is a price, a promise and a button", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");
  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();

  const dialog = page.getByTestId("translate-ai-dialog");
  await expect(dialog).toContainText("Translate into Simplified Chinese");
  await expect(page.getByTestId("translate-ai-price")).toContainText("8 2Z");
  // 2Z are platform credits. That framing is a compliance constraint on this
  // screen and survives every shortening of it.
  await expect(dialog).toContainText("Free2Z credits");
  await expect(
    page.getByRole("button", { name: "Translate for 8 2Z", exact: true }),
  ).toBeVisible();

  // The two paragraphs  deleted: the load-or-keep choice that no longer
  // exists, and a caveat about which revision is translated that the purchase
  // path now guarantees instead of explaining.
  await expect(dialog).not.toContainText("keep your edits");
  await expect(dialog).not.toContainText("not used as the source");
});

/**
 * Both of the following come from the codex adversarial review of this PR, and
 * both are cases it correctly pointed out CI never validated.
 */

test("an empty composer with unsaved changes still gets the choice", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  // Dirty, with every prose field empty.
  //
  // An earlier draft of this fix took the silent-load branch on
  // `!hasCreatorText` alone, as belt-and-braces against the dirty flag being
  // wrong again. That authorizes discarding unsaved SHARED article settings —
  // payout address, tags, canonical URL, subscriber-only — which a variant PUT
  // also writes: "no prose" is not "nothing unsaved". `isDirty` decides;
  // `hasCreatorText` only chooses which kind of screen to show while waiting.
  await title(page).fill("A title I then thought better of");
  await title(page).fill("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();

  // Dirty with nothing typed keeps the composer rather than the waiting
  // screen, and delivery asks rather than overrules.
  await expect(page.getByTestId("translation-waiting-here")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Keep my text", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(title(page)).toHaveValue("");
});

test("clearing the last word mid-translation does not take the editor away", async ({
  page,
}) => {
  await stubApi(page, { holdPoll: true });
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  // A creator who HAD started writing this variant keeps their composer.
  await title(page).fill("My own attempt at the Chinese title");
  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translation-job-status")).toBeVisible({
    timeout: 30_000,
  });
  await expect(title(page)).toHaveValue("My own attempt at the Chinese title");

  // Selecting it all and deleting it, to type something else, empties the
  // field for exactly one keystroke. The writing surface must still be there
  // on the next one — a live `!hasCreatorText` condition unmounted the
  // textarea under the caret and took the undo history with it.
  await title(page).fill("");
  await expect(page.getByTestId("translation-waiting-here")).toHaveCount(0);
  await expect(title(page)).toBeVisible();
  await title(page).fill("My second attempt");
  await expect(title(page)).toHaveValue("My second attempt");
});

test("loading a translation leaves nothing for the creator to save", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(title(page)).toHaveValue(TARGET_TITLE, { timeout: 30_000 });

  await page.waitForTimeout(4_000);
  await expect(page.locator("header")).not.toContainText("Unsaved changes");
  expect(
    writes.filter(
      (write) =>
        write.method === "PUT" &&
        write.pathname.includes(`/api/zpage/${ARTICLE_ID}/`),
    ),
  ).toEqual([]);
});

test("switching away from a freshly loaded translation asks nothing", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(title(page)).toHaveValue(TARGET_TITLE, { timeout: 30_000 });

  // The creator made zero edits. Going back to the original must just go.
  await page
    .locator('[data-language="en"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();

  await expect(title(page)).toHaveValue(SOURCE_TITLE, { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * The waiting screen must never outlive the job ( review, F2).
 *
 * It replaces BOTH the composer and the preview, so if it can persist while the
 * client has stopped watching, it is a permanent lockout rather than a notice —
 * and `restoreTranslationProgress` makes a non-terminal receipt durable across
 * reloads, so the lockout would survive closing the tab.
 */
test("the editor comes back when the client stops watching the job", async ({
  page,
}) => {
  await stubApi(page, { mismatchPoll: true });
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();

  // The job never reaches a terminal state, so `translationPending` stays true
  // forever. The writing surface must still come back, because the promise the
  // waiting screen makes ("the draft opens right here") is one the client has
  // stopped keeping.
  await expect(page.getByTestId("translation-waiting-here")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(title(page)).toBeVisible();
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible();

  //...and the creator can actually use it.
  await title(page).fill("I will write this one myself");
  await expect(title(page)).toHaveValue("I will write this one myself");

  // The status region still says where the purchase stands, so handing the
  // editor back is not the same as pretending nothing was bought.
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
});

test("the waiting screen offers a way out while the job is still running", async ({
  page,
}) => {
  await stubApi(page, { holdPoll: true });
  await page.goto(`/edit?lang=zh-Hans&id=${ARTICLE_ID}`);
  await expect(title(page)).toHaveValue("");

  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="zh-Hans"]')
    .getByRole("button", { name: "Translate with AI" })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translation-waiting-here")).toBeVisible({
    timeout: 30_000,
  });

  // No full-screen state in this editor may be a dead end.
  await page.getByTestId("translation-waiting-write-instead").click();
  await expect(page.getByTestId("translation-waiting-here")).toHaveCount(0);
  await expect(title(page)).toBeVisible();
  await title(page).fill("My own Chinese title");
  await expect(title(page)).toHaveValue("My own Chinese title");

  // Dismissing the screen does not un-buy the translation: the job is still
  // reported, and the purchase still stands.
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
});
