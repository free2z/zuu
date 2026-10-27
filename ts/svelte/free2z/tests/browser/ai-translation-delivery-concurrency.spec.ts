import { expect, test } from "@playwright/test";
import {
  CREATOR,
  ARTICLE_ID,
  TARGET_TITLE,
  TRANSLATE_WITH_AI,
  SOURCE,
  TARGET_DRAFT,
  TARGET_DELIVERED,
  sourceVariant,
  translationVariant,
  deliveredJob,
  stubApi,
  openAi,
  warmEditorOnce,
} from "./ai-translation-delivery-fixture";

/**
 * AI translation delivery in the editor.
 *
 * This exercises the purchase through the real editor UI. The API returns a
 * queued job, then delivers it through the status endpoint so the regression
 * covers the same hand-off the production poller uses.
 *
 * Negative control: against the unfixed editor, the delivered response only
 * refreshed the Translations panel. The source title remained in the editor,
 * so the target-title assertion below fails. The initial source assertion
 * proves the test did not start with the target already hydrated.
 *
 * Cross-article, cross-tab and recovery cases, split from
 * `editor-ai-translation-delivery.spec.ts` for shard balance; same fixture.
 */

warmEditorOnce();

test("late purchase receipt for article A never replaces article B progress", async ({
  page,
}) => {
  await stubApi(page);
  const otherId = "other-translation-article";
  const otherPage = {
    ...SOURCE,
    free2zaddr: otherId,
    vanity: otherId,
    id: 2345,
    title: "Article B",
  };
  await page.route(
    (url) => url.pathname === `/api/zpage/${otherId}/`,
    (route) => route.fulfill({ json: otherPage }),
  );
  await page.route(
    (url) => url.pathname === `/api/zpage/${otherId}/variants/`,
    (route) => route.fulfill({ json: [sourceVariant] }),
  );
  await page.route(
    (url) => url.pathname === `/api/zpage/${otherId}/variants/es/translate/`,
    (route) =>
      route.fulfill({
        json: {
          ...deliveredJob(),
          job_id: "job-B",
          zpage_id: 2345,
          status: "queued",
        },
      }),
  );
  let release: (() => void) | undefined;
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
    async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: { ...deliveredJob(), status: "queued" } });
    },
  );
  await openAi(page);
  await page.evaluate(
    ({ key, receipt }) => localStorage.setItem(key, JSON.stringify(receipt)),
    {
      key: `translation-receipt:${CREATOR.username}:${otherId}`,
      receipt: {
        page: otherId,
        language: "es",
        job: {
          ...deliveredJob(),
          job_id: "job-B",
          zpage_id: 2345,
          status: "queued",
        },
        interrupted: false,
        checking: false,
      },
    },
  );
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate((id) => {
    const link = document.createElement("a");
    link.href = `/edit?id=${id}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, otherId);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "Article B",
  );
  release?.();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => Boolean(localStorage.getItem(key)),
        `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`,
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("translation-job-status")).toContainText(
    "Translating into Spanish",
  );
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "Article B",
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || "{}").job?.job_id,
      `translation-receipt:${CREATOR.username}:${otherId}`,
    ),
  ).toBe("job-B");
});

test("published-target refusal releases intent so another language can be quoted", async ({
  page,
}) => {
  const writes = await stubApi(page, { refusal: "variant_published" });
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/`,
    (route) =>
      route.fulfill({
        json: [
          sourceVariant,
          translationVariant(false),
          { ...translationVariant(false), language: "fr" },
        ],
      }),
  );
  let frenchQuotes = 0;
  await page.route(
    (url) => url.pathname.endsWith("/variants/fr/translate/quote/"),
    async (route) => {
      frenchQuotes++;
      await route.fulfill({
        status: 503,
        json: { code: "translation_unavailable", error: "Try later" },
      });
    },
  );
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect
    .poll(() => writes.filter((w) => w.pathname.endsWith("/translate/")).length)
    .toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator('[data-language="fr"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-dialog")).toContainText("French");
  await expect.poll(() => frenchQuotes).toBe(1);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      `translation-receipt:${CREATOR.username}:${ARTICLE_ID}:pending`,
    ),
  ).toMatchObject({ settled: "refused", language: "es" });
});

test("late purchase on the same article follows language navigation and protects target edits", async ({
  page,
}) => {
  const writes = await stubApi(page);
  let release: (() => void) | undefined;
  let delivered = false;
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
    async (route) => {
      if (route.request().method() === "POST") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({ json: { ...deliveredJob(), status: "queued" } });
      } else {
        delivered = true;
        await route.fulfill({ json: deliveredJob() });
      }
    },
  );
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/es/`,
    (route) =>
      route.fulfill({
        json: delivered ? TARGET_DELIVERED : TARGET_DRAFT,
        headers: { ETag: delivered ? '"delivered"' : '"draft"' },
      }),
  );
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate((id) => {
    const link = document.createElement("a");
    link.href = `/edit?lang=es&id=${id}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, ARTICLE_ID);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_DRAFT.title,
  );
  await page
    .getByPlaceholder("Article title...")
    .fill("Unsaved target while purchase is pending");
  release?.();
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep my text" })).toBeVisible({
    timeout: 10000,
  });
  expect(
    writes.filter(
      (w) => w.method === "PUT" && w.pathname.endsWith("/translations/es/"),
    ),
  ).toEqual([]);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "Unsaved target while purchase is pending",
  );
  await page
    .getByRole("button", { name: "Load the translation", exact: true })
    .click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_TITLE,
  );
});

for (const concurrentWriter of [false, true]) {
  test(`keeping target text uses delivered ETag and ${concurrentWriter ? "rejects a later writer" : "saves successfully"}`, async ({
    page,
  }) => {
    const options = { blank: true, concurrentVariant: false };
    const writes = await stubApi(page, options);
    await openAi(page, true);
    await page.getByPlaceholder("Article title...").fill("My chosen title");
    await page
      .locator("textarea.writing-area-textarea")
      .fill("My own translated body");
    await page
      .locator('[data-language="es"]')
      .getByRole("button", { name: TRANSLATE_WITH_AI })
      .click();
    await page.getByTestId("translate-ai-confirm").click();
    await expect(
      page.getByRole("button", { name: "Keep my text" }),
    ).toBeVisible({ timeout: 10000 });
    options.concurrentVariant = concurrentWriter;
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/translations/es/") &&
        r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Keep my text" }).click();
    expect((await response).status()).toBe(concurrentWriter ? 412 : 200);
    expect(
      writes.find((w) => w.pathname.endsWith("/translations/es/"))?.ifMatch,
    ).toBe('"es-delivered"');
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      "My chosen title",
    );
    if (concurrentWriter)
      await expect(
        page.getByRole("button", { name: "Reload", exact: true }),
      ).toBeVisible();
  });
}

test("a translation published before the revision choice stays protected from local autosave", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true, publishedDelivered: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My unpublished edits");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own translated body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("dialog")).toContainText("published elsewhere", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect(page.getByTestId("translation-review-status")).toContainText(
    "Saving is paused",
  );
  await page.waitForTimeout(3000);
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "My unpublished edits",
  );
});

test("Escape pauses revision replacement until explicit Keep consent", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My chosen title");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own translated body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("button", { name: "Keep my text" })).toBeVisible({
    timeout: 10000,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("translation-review-status")).toContainText(
    "Saving is paused",
  );
  await page.waitForTimeout(3000);
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Review saved Spanish draft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(TARGET_TITLE);
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect
    .poll(
      () =>
        writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
    )
    .toBe(1);
  expect(
    writes.find((w) => w.pathname.endsWith("/translations/es/"))?.ifMatch,
  ).toBe('"es-delivered"');
});

test("revision consent cannot overwrite shared payout settings changed elsewhere", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true, sharedChanged: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My chosen title");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own translated body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("dialog")).toContainText(
    "Shared article settings changed elsewhere",
    { timeout: 10000 },
  );
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect(page.getByTestId("translation-review-status")).toContainText(
    "Saving is paused",
  );
  await page.waitForTimeout(3000);
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
});

test("background tab flush preserves dirty target during translation purchase", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let polling = false;
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      polling = true;
      await statusGate;
      await route.fallback();
    },
  );
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My chosen title");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own translated body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => polling).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  try {
    expect(
      writes.filter((w) => w.pathname.endsWith("/translations/es/")),
    ).toEqual([]);
  } finally {
    releaseStatus();
  }
  await expect(
    page.getByRole("button", { name: "Keep my text" }),
  ).toBeVisible();
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "My own translated body",
  );
});

test("lost purchase responses keep dirty target paused after closing until exact replay", async ({
  page,
}) => {
  const options = { blank: true, delivered: false };
  const writes = await stubApi(page, options);
  const keys: string[] = [];
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length <= 2) {
        options.delivered = true;
        return route.fulfill({ status: 503, json: {} });
      }
      return route.fallback();
    },
  );
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My chosen title");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own translated body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => keys.length).toBe(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("translation-unresolved")).toContainText(
    "Saving is paused",
  );
  await page.keyboard.press("ControlOrMeta+s");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(3000);
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Recover translation purchase", exact: true })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("button", { name: "Keep my text" })).toBeVisible({
    timeout: 10000,
  });
  expect(keys).toEqual([keys[0], keys[0], keys[0]]);
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect
    .poll(
      () =>
        writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
    )
    .toBe(1);
  expect(
    writes.find((w) => w.pathname.endsWith("/translations/es/"))?.ifMatch,
  ).toBe('"es-delivered"');
});

test("delayed receipt cannot retire another tab's newer pending request", async ({
  page,
  context,
}) => {
  await stubApi(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      requested = true;
      await gate;
      return route.fulfill({
        json: {
          ...deliveredJob(),
          status: "refunded",
          charged: "7.000",
          refunded: "7.000",
        },
      });
    },
  );
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => requested).toBe(true);
  const other = await context.newPage();
  await stubApi(other);
  await openAi(other);
  const storageKey = `translation-receipt:${CREATOR.username}:${ARTICLE_ID}:pending`;
  const newer = await other.evaluate(async (storageKey) => {
    return navigator.locks.request(storageKey, () => {
      const previous = JSON.parse(localStorage.getItem(storageKey)!);
      const pending = {
        ...previous,
        language: "fr",
        key: "00000000-0000-4000-8000-000000000999",
      };
      localStorage.setItem(storageKey, JSON.stringify(pending));
      return pending;
    });
  }, storageKey);
  await other.evaluate(
    ({ storageKey, receipt }) =>
      localStorage.setItem(
        storageKey.replace(/:pending$/, ""),
        JSON.stringify(receipt),
      ),
    {
      storageKey,
      receipt: {
        page: ARTICLE_ID,
        language: "fr",
        job: {
          ...deliveredJob(),
          job_id: "newer-french",
          language: "fr",
          status: "queued",
        },
        interrupted: false,
        checking: false,
      },
    },
  );
  release();
  // The refund notice now names the language and says where the 2Z went,
  // rather than reporting the verb "refunded".
  await expect(page.getByTestId("translation-job-status")).toContainText(
    "back in your balance",
  );
  expect(
    await other.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem(key.replace(/:pending$/, ""))!).job
          .job_id,
      storageKey,
    ),
  ).toBe("newer-french");
  expect(
    await other.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      storageKey,
    ),
  ).toEqual(newer);
  await expect(page.getByTestId("translation-unresolved")).toBeVisible();
  await page
    .getByRole("button", { name: "Recover translation purchase", exact: true })
    .click();
  await expect(page.getByTestId("translate-ai-dialog")).toContainText("French");
  await other.close();
});

test("an unresolved article purchase does not block creating a new article", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({ status: 503, json: {} });
      return route.fallback();
    },
  );
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
  await expect(page.getByTestId("translate-ai-confirm")).toHaveText(
    "Recover translation purchase",
  );
  await expect(page.getByTestId("translate-ai-purchase-error")).toContainText(
    "could not tell whether that purchase went through",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("translation-unresolved")).toBeVisible();
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/edit?id=new";
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  await expect(page.getByPlaceholder("Article title...")).toHaveValue("");
  await page.getByPlaceholder("Article title...").fill("A separate article");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("A body unrelated to the pending translation.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() =>
      writes.some((w) => w.pathname === "/api/zpage/" && w.method === "POST"),
    )
    .toBe(true);
});

test("explicit Save and switch remains available while a known translation runs", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: { ...deliveredJob(), status: "queued" } });
      return route.fallback();
    },
  );
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
  await page
    .getByPlaceholder("Article title...")
    .fill("My explicitly saved source revision");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save and switch", exact: true })
    .click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_DRAFT.title,
  );
  expect(
    writes.filter(
      (w) =>
        w.pathname === `/api/zpage/${ARTICLE_ID}/` &&
        w.body?.title === "My explicitly saved source revision",
    ),
  ).toHaveLength(1);
});

test("another tab settling an unknown purchase protects dirty target until revision consent", async ({
  page,
  context,
}) => {
  const options = { blank: true, delivered: false };
  const writes = await stubApi(page, options);
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: deliveredJob() });
    },
  );
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My local target");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My unsaved target body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
  await expect(page.getByTestId("translate-ai-confirm")).toHaveText(
    "Recover translation purchase",
  );
  await expect(page.getByTestId("translate-ai-purchase-error")).toContainText(
    "could not tell whether that purchase went through",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("translation-unresolved")).toBeVisible();
  const other = await context.newPage();
  await stubApi(other, { delivered: true });
  await other.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => route.fulfill({ json: deliveredJob() }),
  );
  await other.goto(`/edit?id=${ARTICLE_ID}`);
  await other.getByTestId("translation-unresolved").getByRole("button").click();
  options.delivered = true;
  await other.getByTestId("translate-ai-confirm").click();
  await expect(
    page.getByRole("button", { name: /Keep my text|Conservar mi texto/ }),
  ).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "My unsaved target body",
  );
  await page.waitForTimeout(3000);
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
  await page
    .getByRole("button", { name: /Keep my text|Conservar mi texto/ })
    .click();
  await expect
    .poll(
      () =>
        writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
    )
    .toBe(1);
  expect(
    writes.find((w) => w.pathname.endsWith("/translations/es/"))?.ifMatch,
  ).toBe('"es-delivered"');
  await other.close();
});

test("full storage settles by shrinking the exact pending request and saving can recover", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  let originalLength = 0;
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() === "POST") {
        originalLength = await page.evaluate(() => {
          const pendingKey = Object.keys(localStorage).find((key) =>
            key.endsWith(":pending"),
          )!;
          const length = localStorage.getItem(pendingKey)!.length;
          const size = () =>
            Object.keys(localStorage).reduce(
              (total, key) =>
                total + 2 * (key.length + localStorage.getItem(key)!.length),
              0,
            );
          const limit = size();
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            const previous = this.getItem(key);
            const next =
              size() -
              (previous === null ? 0 : 2 * (key.length + previous.length)) +
              2 * (key.length + value.length);
            if (this === localStorage && next > limit)
              throw new DOMException(
                "Byte quota exceeded",
                "QuotaExceededError",
              );
            return set.call(this, key, value);
          };
          return length;
        });
      }
      return route.fallback();
    },
  );
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My target under quota");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("Text that must remain saveable.");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("button", { name: "Keep my text" })).toBeVisible({
    timeout: 10000,
  });
  const proof = await page.evaluate(() =>
    localStorage.getItem(
      Object.keys(localStorage).find((key) => key.endsWith(":pending"))!,
    )!,
  );
  expect(proof.length).toBeLessThan(originalLength);
  expect(JSON.parse(proof)).toMatchObject({
    settled: "success",
    language: "es",
    job_id: deliveredJob().job_id,
  });
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect
    .poll(
      () =>
        writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
    )
    .toBe(1);
  await expect(page.getByTestId("translation-unresolved")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
  await expect(page.getByTestId("translation-unresolved")).toHaveCount(0);
});

test("confirmed translation job history is bounded without removing the current receipt", async ({
  page,
}) => {
  await stubApi(page);
  await openAi(page);
  await page.evaluate((base) => {
    for (let index = 0; index < 12; index++)
      localStorage.setItem(
        `${base}:job:old-${index}`,
        JSON.stringify({
          job: { job_id: `old-${index}`, status: "delivered" },
        }),
      );
  }, `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
  const records = await page.evaluate(
    (base) =>
      Object.keys(localStorage).filter((key) => key.startsWith(`${base}:job:`)),
    `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`,
  );
  expect(records.length).toBeLessThanOrEqual(8);
  expect(records).toContain(
    `translation-receipt:${CREATOR.username}:${ARTICLE_ID}:job:${deliveredJob().job_id}`,
  );
});

test("Keep preserves the draft status when another tab unpublished a previously published target", async ({
  page,
  context,
}) => {
  const options = { initialPublishedTarget: true, delivered: false };
  const writes = await stubApi(page, options);
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  // No save/discard prompt: see the note in `openAi`.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_DRAFT.title,
  );
  const other = await context.newPage();
  await stubApi(other, { delivered: true });
  await other.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => route.fulfill({ json: deliveredJob() }),
  );
  await openAi(other);
  await other
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My previously published text, revised locally");
  options.delivered = true;
  await other.getByTestId("translate-ai-confirm").click();
  const keep = page.getByRole("button", {
    name: /Keep my text|Conservar mi texto/,
  });
  await expect(keep).toBeVisible({ timeout: 10000 });
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "My previously published text, revised locally",
  );
  await keep.click();
  await expect
    .poll(
      () =>
        writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
    )
    .toBe(1);
  const write = writes.find((w) => w.pathname.endsWith("/translations/es/"))!;
  expect(write.body).toMatchObject({
    content: "My previously published text, revised locally",
    is_published: false,
  });
  expect(write.ifMatch).toBe('"es-delivered"');
  await other.close();
});

for (const frenchStatus of ["delivered", "refunded"] as const) {
  test(`Spanish review remains recoverable after another tab's French purchase is ${frenchStatus}`, async ({
    page,
    context,
  }) => {
    const writes = await stubApi(page, { blank: true });
    await openAi(page, true);
    await page.getByPlaceholder("Article title...").fill("My Spanish draft");
    await page
      .locator("textarea.writing-area-textarea")
      .fill("My Spanish text must remain recoverable");
    await page
      .locator('[data-language="es"]')
      .getByRole("button", { name: TRANSLATE_WITH_AI })
      .click();
    await page.getByTestId("translate-ai-confirm").click();
    await expect(
      page.getByRole("button", { name: "Keep my text" }),
    ).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");

    const other = await context.newPage();
    await stubApi(other);
    const french = {
      ...TARGET_DELIVERED,
      actual_language: "fr",
      requested_language: "fr",
      title: "French draft",
    };
    await other.route(
      (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/`,
      async (route) =>
        route.fulfill({
          json: [
            sourceVariant,
            translationVariant(true),
            {
              ...translationVariant(false),
              language: "fr",
              title: "French draft",
            },
          ],
        }),
    );
    await other.route(
      (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/fr/`,
      async (route) =>
        route.fulfill({ json: french, headers: { ETag: '"fr-delivered"' } }),
    );
    await other.route(
      (url) => url.pathname.endsWith("/variants/fr/translate/quote/"),
      async (route) =>
        route.fulfill({
          json: {
            price: 7,
            balance: "93.000",
            affordable: true,
            source_language: "en",
            language: "fr",
            source_digest: "source-digest-1230",
            input_tokens: 321,
            estimated_output_tokens: 234,
            chunks: 1,
            existing_variant: { is_published: false, origin: "human" },
          },
        }),
    );
    await other.route(
      (url) => url.pathname.endsWith("/variants/fr/translate/"),
      async (route) =>
        route.fulfill({
          json: {
            ...deliveredJob(),
            job_id: "french-job-1230",
            language: "fr",
            status: frenchStatus,
          },
        }),
    );
    await other.goto(`/edit?id=${ARTICLE_ID}`);
    await other
      .locator('[data-language="fr"]')
      .getByRole("button", { name: /Translate with AI|Traducir con IA/ })
      .click();
    await other.getByTestId("translate-ai-confirm").click();
    //a French delivery no longer interrupts the Spanish editor with a
    // load-or-keep prompt; it is announced, and the Spanish review stays put.
    await expect(page.getByTestId("translation-job-status")).toContainText(
      /French|francés/,
    );
    const review = page.getByTestId("translation-review-status");
    await expect(review).toContainText(/Spanish|español/);
    expect(
      writes.filter((w) => w.pathname.endsWith("/translations/es/")),
    ).toEqual([]);
    await review.getByRole("button").click();
    await expect(page.getByRole("dialog")).toContainText(TARGET_TITLE);
    await page
      .getByRole("button", { name: /Keep my text|Conservar mi texto/ })
      .click();
    await expect
      .poll(
        () =>
          writes.filter((w) => w.pathname.endsWith("/translations/es/")).length,
      )
      .toBe(1);
    expect(
      writes.find((w) => w.pathname.endsWith("/translations/es/"))?.body
        ?.content,
    ).toBe("My Spanish text must remain recoverable");
    await expect(review).toHaveCount(0);
    await other.close();
  });
}

test("an open recovery consent replays its original key after another tab settles it", async ({
  page,
  context,
}) => {
  const options = { blank: true, delivered: false };
  await stubApi(page, options);
  const requests: Array<{ key: string | undefined; body: unknown }> = [];
  await page.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => {
      if (route.request().method() === "POST") {
        requests.push({
          key: route.request().headers()["idempotency-key"],
          body: route.request().postDataJSON(),
        });
        if (!options.delivered) return route.fulfill({ status: 503, json: {} });
      }
      return route.fulfill({ json: deliveredJob() });
    },
  );
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My local target");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My unsaved target body");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
  expect(requests).toHaveLength(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("translation-unresolved").getByRole("button").click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();

  const other = await context.newPage();
  await stubApi(other, { delivered: true });
  await other.route(
    (url) => url.pathname.endsWith("/variants/es/translate/"),
    async (route) => route.fulfill({ json: deliveredJob() }),
  );
  await other.goto(`/edit?id=${ARTICLE_ID}`);
  await other.getByTestId("translation-unresolved").getByRole("button").click();
  options.delivered = true;
  await other.getByTestId("translate-ai-confirm").click();
  await page
    .getByRole("button", { name: /Keep my text|Conservar mi texto/ })
    .click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(requests[2]).toEqual(requests[0]);
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "My unsaved target body",
  );
  await other.close();
});
